// Referral / campaign links — the short URLs like /columbia that lead to the home
// page while counting how many people arrived through them.
//
// Links are DATA, created and retired from the admin dashboard: two SQLite tables,
// `referral_links` (the campaigns) and `referral_hits` (one row per arrival). They
// used to be a hardcoded array here, which meant a deploy per campaign.
//
// Retiring a link DEACTIVATES it: the URL stops working immediately but the row and
// its clicks stay, because a campaign's results outlive the campaign. `deleteLink`
// is the separate, explicit wipe.
//
// Two things this module deliberately does NOT store:
//   * No IP address and no user-agent string. A campaign link is opened by
//     strangers who never agreed to anything, and a click count needs neither. The
//     UA is inspected in memory to set `is_bot` and then dropped.
//   * No referrer query string. `document.referrer` routinely carries the sending
//     site's own tracking parameters (and occasionally a session id); only
//     host + path is kept, which is also what makes the grouping useful.
//
// Bot traffic is recorded but FLAGGED rather than dropped, because a link pasted
// into Slack/iMessage/WhatsApp is fetched by that platform's preview crawler
// before any human clicks it. Counting those as visits would inflate a campaign by
// a wide margin; discarding them silently would leave the operator wondering where
// the hits went. Everything the dashboard shows as a "click" is `is_bot = 0`.

import fs from 'fs';
import path from 'path';
import { getDb } from './db.js';
import { LOCALES } from '../i18n/locales.js';
import { logger } from '../logger.js';

/**
 * @typedef {object} ReferralLink
 * @property {string} slug            URL segment, e.g. 'columbia' → /columbia
 * @property {string} label           Human name shown on the dashboard.
 * @property {string} note            Where the link is handed out; caption only.
 * @property {boolean} active         False once retired: the URL stops resolving.
 * @property {string} path            '/' + slug, so callers never rebuild it.
 * @property {number} createdAt       Epoch ms.
 * @property {number | null} deactivatedAt  Epoch ms, or null while live.
 */

/**
 * @typedef {{ ok: true, link: ReferralLink } | { ok: false, code: string, error: string }} LinkResult
 * The shape every mutating call returns. The literal `ok` types are what let a
 * caller narrow after an `if (!result.ok) return …` guard — without them TS widens
 * to `boolean` and `result.link` reads as possibly-undefined at every call site.
 */

/**
 * A slug is one lowercase URL segment, 2–31 characters, starting and ending
 * alphanumeric. Checked at creation time — unlike the old hardcoded array, these
 * now come from a form. The no-trailing-hyphen rule is not pedantry: `/columbia-`
 * is a legal URL, so it would be accepted and then quietly mistyped forever.
 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,29}[a-z0-9]$/;

export const MAX_LABEL_LENGTH = 60;
export const MAX_NOTE_LENGTH = 120;

/**
 * The one link that existed before campaigns became data. Seeded once, so the
 * deployed /columbia URL and every click it has already recorded survive the
 * migration. Guarded by a `meta` row, mirroring the other stores' JSON imports.
 */
const SEED_LINKS = [{ slug: 'columbia', label: 'Columbia University', note: 'Campus outreach' }];
const SEED_META_KEY = 'referral_links_seeded';

const DAY_MS = 24 * 60 * 60 * 1000;
// Epoch 0 is itself a UTC midnight, so flooring by whole days lands exactly on one.
const utcDayStart = (ts) => Math.floor(ts / DAY_MS) * DAY_MS;
const isoDay = (ts) => new Date(ts).toISOString().slice(0, 10);

// Retention + hard cap. A campaign link is low-volume, but referral_hits is written
// by unauthenticated requests onto the same volume auth-store.db lives on, so it
// gets a ceiling like every other anonymous write path in the app.
const RETENTION_MS = 400 * DAY_MS;
const MAX_ROWS_PER_SLUG = 100_000;
const PRUNE_EVERY_HITS = 500;

// Substrings (matched case-insensitively) that mark a request as automated. The
// `bot/`, `bot;`, `bot)`, `bot ` and `bot-` forms are deliberate instead of a bare
// 'bot': phone makers put model names like CUBOT_NOTE_20 in real Chrome user
// agents, and a bare substring would file those handsets as crawlers.
const BOT_UA_MARKERS = Object.freeze([
  'bot/', 'bot;', 'bot)', 'bot ', 'bot-', 'crawler', 'spider', 'slurp', 'scraper',
  // Link unfurlers — the ones that actually fire when a campaign URL is pasted.
  'facebookexternalhit', 'facebookcatalog', 'meta-externalagent', 'whatsapp',
  'slack-imgproxy', 'discord', 'telegram', 'linkedinbot', 'pinterest', 'redditbot',
  'embedly', 'quora link preview', 'skypeuripreview', 'vkshare', 'preview',
  // Search / AI crawlers.
  'applebot', 'yandex', 'baiduspider', 'duckduckbot', 'petalbot', 'bytespider',
  'gptbot', 'claudebot', 'perplexity', 'ccbot', 'google-inspectiontool',
  'googleimageproxy', 'ia_archiver', 'feedfetcher', 'ahrefs', 'semrush', 'mj12',
  // Scripted clients and headless browsers.
  'curl/', 'wget/', 'python-', 'python/', 'go-http-client', 'java/', 'okhttp',
  'libwww-perl', 'apache-httpclient', 'axios/', 'node-fetch', 'postman',
  'headlesschrome', 'phantomjs', 'puppeteer', 'playwright', 'lighthouse',
  // Mail-security rewriters and uptime probes.
  'proofpoint', 'barracuda', 'mimecast', 'cloudflare', 'monitor', 'uptime',
  'pingdom', 'statuscake', 'site24x7', 'newrelicpinger', 'datadog', 'validator',
]);

/**
 * First path segment of every non-referral route the app answers. The resolver is
 * mounted LAST, so a link that collided with one of these could never take a real
 * page off the site — it would simply never fire, which is a confusing enough
 * failure to be worth refusing at creation time.
 *
 * Hand-maintained, and therefore drift-tested: test/routes/referral-route.test.js
 * scans routes/*.js and fails if a route root is missing from this list.
 */
export const RESERVED_ROUTE_ROOTS = Object.freeze([
  'admin', 'api', 'authstore', 'bimi-logo.svg', 'blog', 'bugreports', 'chatlogs',
  'contactlogs', 'email', 'email-open-logs', 'enterprise-domains', 'getpro',
  'health', 'i', 'logo-full.png', 'masklogs', 'memories', 'privacy', 'promptlogs',
  'resetmemories', 'robots.txt', 'sitemap.xml', 'status',
]);

/**
 * Every slug a new link may not use: the route roots above, the localized URL
 * prefixes (/es, /fr, …), and anything express.static serves from the root of
 * public/ — with a trailing `.html` stripped, so `/pro` is refused as well as
 * `/pro.html`.
 *
 * @param {string} baseDir - Repo root (the folder containing public/).
 * @returns {Set<string>}
 */
export function computeReservedSlugs(baseDir) {
  const reserved = new Set(RESERVED_ROUTE_ROOTS);
  for (const locale of LOCALES) reserved.add(locale.prefix);
  try {
    for (const entry of fs.readdirSync(path.join(baseDir, 'public'))) {
      const name = entry.toLowerCase();
      reserved.add(name);
      reserved.add(name.replace(/\.html$/, ''));
    }
  } catch (err) {
    // A missing public/ means a misconfigured baseDir, not an empty reserved set —
    // say so rather than silently letting every page name through.
    logger.warn('[referrals] could not read public/ for the reserved-slug list:', err && err.message ? err.message : err);
  }
  return reserved;
}

/**
 * Whether a user-agent looks automated rather than human.
 *
 * A MISSING user-agent counts as a bot: every real browser sends one, so an absent
 * header means a script (or a deliberately stripped request), never a visitor.
 *
 * @param {string | undefined | null} ua - Raw User-Agent header.
 * @returns {boolean}
 */
export function isBotUserAgent(ua) {
  const s = String(ua || '').toLowerCase().trim();
  if (!s) return true;
  return BOT_UA_MARKERS.some((marker) => s.includes(marker));
}

/**
 * Reduce a Referer header to `host/path`, lowercased, with the query string and
 * fragment dropped (see the privacy note at the top of this file). Anything that
 * isn't an absolute http(s) URL yields '' — the column then stores NULL.
 *
 * @param {string | undefined | null} raw - Raw Referer header.
 * @returns {string} `example.com/some/page`, or '' when there is nothing usable.
 */
export function normalizeReferer(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let url;
  try {
    url = new URL(s);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  const pathPart = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return (url.host + pathPart).toLowerCase().slice(0, 200);
}

/**
 * Bucket timestamps into one entry per UTC day across a fixed window, including
 * the days with no hits — a chart with holes in it misreads as missing data.
 *
 * @param {number[]} timestamps - Epoch ms, unsorted.
 * @param {number} sinceDayStart - UTC midnight of the first day in the window.
 * @param {number} days - Number of daily buckets to emit.
 * @returns {Array<{ date: string, value: number }>} Oldest first.
 */
export function buildDailySeries(timestamps, sinceDayStart, days) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const ts of timestamps) {
    const key = isoDay(utcDayStart(ts));
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const date = isoDay(sinceDayStart + i * DAY_MS);
    out.push({ date, value: counts.get(date) || 0 });
  }
  return out;
}

/**
 * Open the referral-link store against the shared application database.
 *
 * @param {string} baseDir - Repo/base dir; resolved to the data dir by db.js and to
 *   public/ for the reserved-slug list.
 * @param {{ seed?: boolean }} [opts] - `seed: false` skips the one-time
 *   /columbia migration (tests that want an empty store).
 */
export function createReferralLinks(baseDir, { seed = true } = {}) {
  const db = getDb(baseDir);

  db.exec(`
    CREATE TABLE IF NOT EXISTS referral_links (
      slug           TEXT    PRIMARY KEY,
      label          TEXT    NOT NULL,
      note           TEXT    NOT NULL DEFAULT '',
      active         INTEGER NOT NULL DEFAULT 1,
      created_at     INTEGER NOT NULL,
      deactivated_at INTEGER
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS referral_hits (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      slug    TEXT    NOT NULL,
      ts      INTEGER NOT NULL,
      referer TEXT,
      is_bot  INTEGER NOT NULL DEFAULT 0
    )
  `);
  // Every read is "this slug, this time window"; every prune is "this slug, oldest
  // first". One composite index serves both.
  db.exec('CREATE INDEX IF NOT EXISTS idx_referral_hits_slug_ts ON referral_hits (slug, ts)');

  const insertLinkStmt = db.prepare(
    'INSERT INTO referral_links (slug, label, note, active, created_at) VALUES (?, ?, ?, 1, ?)',
  );
  const getLinkStmt = db.prepare('SELECT * FROM referral_links WHERE slug = ?');
  const listLinksStmt = db.prepare('SELECT * FROM referral_links ORDER BY active DESC, created_at DESC');
  const setActiveStmt = db.prepare('UPDATE referral_links SET active = ?, deactivated_at = ? WHERE slug = ?');
  const deleteLinkStmt = db.prepare('DELETE FROM referral_links WHERE slug = ?');
  const deleteHitsStmt = db.prepare('DELETE FROM referral_hits WHERE slug = ?');

  const insertHitStmt = db.prepare(
    'INSERT INTO referral_hits (slug, ts, referer, is_bot) VALUES (?, ?, ?, ?)',
  );
  const totalsStmt = db.prepare(`
    SELECT COUNT(*)                              AS hits,
           COALESCE(SUM(is_bot), 0)              AS bots,
           MAX(CASE WHEN is_bot = 0 THEN ts END) AS lastClickAt,
           MIN(CASE WHEN is_bot = 0 THEN ts END) AS firstClickAt
      FROM referral_hits
     WHERE slug = ?
  `);
  const windowStmt = db.prepare(
    'SELECT ts, is_bot AS isBot FROM referral_hits WHERE slug = ? AND ts >= ?',
  );
  const referrersStmt = db.prepare(`
    SELECT referer AS source, COUNT(*) AS value
      FROM referral_hits
     WHERE slug = ? AND is_bot = 0 AND referer IS NOT NULL AND referer <> ''
     GROUP BY referer
     ORDER BY value DESC, source ASC
     LIMIT ?
  `);
  const countAllStmt = db.prepare('SELECT COUNT(*) AS n FROM referral_hits');
  const pruneOldStmt = db.prepare('DELETE FROM referral_hits WHERE ts < ?');
  const pruneCapStmt = db.prepare(`
    DELETE FROM referral_hits
     WHERE slug = ?
       AND id NOT IN (SELECT id FROM referral_hits WHERE slug = ? ORDER BY id DESC LIMIT ?)
  `);
  const getMetaStmt = db.prepare('SELECT value FROM meta WHERE key = ?');
  const setMetaStmt = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');

  // One-time migration of the formerly-hardcoded link. Guarded by `meta` so a link
  // the operator later deletes does not reappear on the next boot.
  if (seed && getMetaStmt.get(SEED_META_KEY) === undefined) {
    const now = Date.now();
    for (const link of SEED_LINKS) {
      if (!getLinkStmt.get(link.slug)) {
        insertLinkStmt.run(link.slug, link.label, link.note, now);
        logger.info('[referrals] seeded the pre-existing campaign link /' + link.slug);
      }
    }
    setMetaStmt.run(SEED_META_KEY, '1');
  }

  let reservedCache = null;
  const reserved = () => (reservedCache ||= computeReservedSlugs(baseDir));

  /** @returns {ReferralLink | null} */
  const rowToLink = (row) => (row ? {
    slug: row.slug,
    label: row.label,
    note: row.note || '',
    active: row.active === 1,
    path: `/${row.slug}`,
    createdAt: row.created_at,
    deactivatedAt: row.deactivated_at || null,
  } : null);

  /** Every link, active first, newest first within each group. */
  function listLinks() {
    return listLinksStmt.all().map(rowToLink);
  }

  /**
   * One link by slug (case-insensitive), or null.
   * @param {string} slug
   * @returns {ReferralLink | null}
   */
  function getLink(slug) {
    return rowToLink(getLinkStmt.get(String(slug || '').toLowerCase()));
  }

  /**
   * The link a request should be redirected through, or null. Only ACTIVE links
   * resolve — a deactivated URL is a 404, exactly as if it had never existed.
   * @param {string} slug
   * @returns {ReferralLink | null}
   */
  function getActiveLink(slug) {
    const link = getLink(slug);
    return link && link.active ? link : null;
  }

  /**
   * Create a campaign link. Every rejection carries a `code` so the dashboard can
   * explain what is wrong rather than showing a generic failure.
   * @param {{ slug?: string, label?: string, note?: string, now?: number }} arg
   * @returns {LinkResult}
   */
  function createLink({ slug, label, note, now = Date.now() }) {
    const key = String(slug || '').trim().toLowerCase();
    const name = String(label || '').trim().slice(0, MAX_LABEL_LENGTH);
    const hint = String(note || '').trim().slice(0, MAX_NOTE_LENGTH);

    if (!key) return { ok: false, code: 'SLUG_REQUIRED', error: 'Enter a URL for the link.' };
    if (!SLUG_PATTERN.test(key)) {
      return {
        ok: false,
        code: 'SLUG_INVALID',
        error: 'Use 2–31 characters: lowercase letters, numbers and hyphens, starting and ending with a letter or number.',
      };
    }
    if (!name) return { ok: false, code: 'LABEL_REQUIRED', error: 'Give the link a name so you can tell it apart later.' };
    if (reserved().has(key)) {
      // Not destructive — the resolver is mounted last, so this link simply would
      // never fire. Refused because a link that silently never counts is worse.
      return { ok: false, code: 'SLUG_RESERVED', error: `/${key} is already part of the site, so a link there would never be counted.` };
    }
    if (getLinkStmt.get(key)) return { ok: false, code: 'SLUG_TAKEN', error: `/${key} already exists.` };

    insertLinkStmt.run(key, name, hint, now);
    return { ok: true, link: /** @type {ReferralLink} */ (getLink(key)) };
  }

  /**
   * Stop a link resolving, keeping it and its clicks in the dashboard.
   * @param {string} slug
   * @param {number} [now]
   * @returns {LinkResult}
   */
  function deactivateLink(slug, now = Date.now()) {
    const link = getLink(slug);
    if (!link) return { ok: false, code: 'NOT_FOUND', error: 'That link no longer exists.' };
    if (!link.active) return { ok: true, link };
    setActiveStmt.run(0, now, link.slug);
    return { ok: true, link: /** @type {ReferralLink} */ (getLink(link.slug)) };
  }

  /**
   * Put a retired link back into service.
   * @param {string} slug
   * @returns {LinkResult}
   */
  function activateLink(slug) {
    const link = getLink(slug);
    if (!link) return { ok: false, code: 'NOT_FOUND', error: 'That link no longer exists.' };
    if (link.active) return { ok: true, link };
    setActiveStmt.run(1, null, link.slug);
    return { ok: true, link: /** @type {ReferralLink} */ (getLink(link.slug)) };
  }

  /**
   * Erase a link and every click it recorded. The separate, explicit step after
   * deactivation — this is the one that loses data.
   */
  const deleteLinkTxn = db.transaction((slug) => {
    const hits = deleteHitsStmt.run(slug).changes;
    deleteLinkStmt.run(slug);
    return hits;
  });
  /**
   * @param {string} slug
   * @returns {{ ok: true, slug: string, label: string, hitsDeleted: number }
   *          | { ok: false, code: string, error: string }}
   */
  function deleteLink(slug) {
    const link = getLink(slug);
    if (!link) return { ok: false, code: 'NOT_FOUND', error: 'That link no longer exists.' };
    const hits = deleteLinkTxn(link.slug);
    return { ok: true, slug: link.slug, label: link.label, hitsDeleted: hits };
  }

  let sincePrune = 0;

  /**
   * Drop hits past the retention horizon, then trim any slug still over its cap.
   * @param {number} [now]
   * @returns {number} Rows deleted.
   */
  function prune(now = Date.now()) {
    let removed = pruneOldStmt.run(now - RETENTION_MS).changes;
    for (const link of listLinksStmt.all()) {
      removed += pruneCapStmt.run(link.slug, link.slug, MAX_ROWS_PER_SLUG).changes;
    }
    return removed;
  }

  /**
   * Record one arrival. Refuses anything but a live link, so a deactivated URL
   * cannot keep accruing clicks through a stale cache or a direct call.
   */
  function recordHit({ slug, referer, userAgent, now = Date.now() }) {
    const link = getActiveLink(slug);
    if (!link) return { ok: false, reason: 'unknown-slug' };
    const isBot = isBotUserAgent(userAgent);
    try {
      insertHitStmt.run(link.slug, now, normalizeReferer(referer) || null, isBot ? 1 : 0);
    } catch (err) {
      // A failed click count must never cost the visitor their page — the caller
      // redirects regardless, so this is logged and swallowed.
      logger.error('[referrals] could not record a hit for', link.slug, '-', err && err.message ? err.message : err);
      return { ok: false, reason: 'write-failed' };
    }
    sincePrune += 1;
    if (sincePrune >= PRUNE_EVERY_HITS) {
      sincePrune = 0;
      try {
        prune(now);
      } catch (err) {
        logger.error('[referrals] prune failed:', err && err.message ? err.message : err);
      }
    }
    return { ok: true, isBot };
  }

  /** Lifetime + windowed click stats for one link, with its chart series. */
  function statsFor(link, { now = Date.now(), days = 30, topReferrers = 6 } = {}) {
    const windowStart = utcDayStart(now) - (days - 1) * DAY_MS;
    const totals = totalsStmt.get(link.slug) || { hits: 0, bots: 0, lastClickAt: null, firstClickAt: null };
    const rows = windowStmt.all(link.slug, windowStart);
    const humanStamps = rows.filter((r) => !r.isBot).map((r) => r.ts);
    const series = buildDailySeries(humanStamps, windowStart, days);
    return {
      ...link,
      clicks: totals.hits - totals.bots,
      botHits: totals.bots,
      windowClicks: humanStamps.length,
      windowDays: days,
      last7: series.slice(-7).reduce((sum, p) => sum + p.value, 0),
      firstClickAt: totals.firstClickAt || null,
      lastClickAt: totals.lastClickAt || null,
      series,
      referrers: referrersStmt.all(link.slug, topReferrers),
    };
  }

  /** Per-link rollup for the dashboard — active links first. */
  function summary(opts = {}) {
    return listLinks().map((link) => statsFor(link, opts));
  }

  return {
    listLinks,
    getLink,
    getActiveLink,
    createLink,
    deactivateLink,
    activateLink,
    deleteLink,
    recordHit,
    summary,
    statsFor,
    prune,
    reservedSlugs: () => new Set(reserved()),
    countAll: () => countAllStmt.get().n,
  };
}
