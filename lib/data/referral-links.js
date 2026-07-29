// Referral / campaign links — the short URLs like /columbia that lead to the home
// page while counting how many people arrived through them.
//
// Adding a campaign is ONE entry in REFERRAL_LINKS below. routes/referrals.js
// registers a route per entry (explicitly, never a `/:slug` wildcard — that would
// swallow every unmatched path in the app), records one row here, and 302s to `/`.
// The dashboard reads it back through GET /api/admin/referrals.
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

import { getDb } from './db.js';
import { logger } from '../logger.js';

/**
 * @typedef {object} ReferralLink
 * @property {string} slug   URL segment, e.g. 'columbia' → https://stagify.ai/columbia
 * @property {string} label  Human name shown on the dashboard.
 * @property {string} note   Where the link is handed out; dashboard sub-caption only.
 */

/**
 * A slug must be a single lowercase path segment. Enforced by a drift test rather
 * than at runtime — a bad slug is a typo in this file, not user input.
 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}$/;

/** The live campaign links. Add a row here to mint a new tracked URL. */
export const REFERRAL_LINKS = /** @type {ReadonlyArray<ReferralLink>} */ (Object.freeze([
  Object.freeze({
    slug: 'columbia',
    label: 'Columbia University',
    note: 'Campus outreach',
  }),
]));

const DAY_MS = 24 * 60 * 60 * 1000;
// Epoch 0 is itself a UTC midnight, so flooring by whole days lands exactly on one.
const utcDayStart = (ts) => Math.floor(ts / DAY_MS) * DAY_MS;
const isoDay = (ts) => new Date(ts).toISOString().slice(0, 10);

// Retention + hard cap. A campaign link is low-volume, but this table is written by
// unauthenticated requests onto the same volume auth-store.db lives on, so it gets a
// ceiling like every other anonymous write path in the app.
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
 * Open the referral-hit store against the shared application database.
 *
 * @param {string} baseDir - Repo/base dir; resolved to the data dir by db.js.
 * @param {{ links?: ReadonlyArray<ReferralLink> }} [opts] - `links` is a test seam.
 * @returns {{
 *   links: ReadonlyArray<ReferralLink>,
 *   recordHit: (arg: { slug: string, referer?: string | null, userAgent?: string | null, now?: number }) => { ok: boolean, isBot?: boolean, reason?: string },
 *   summary: (opts?: { now?: number, days?: number, topReferrers?: number }) => object[],
 *   prune: (now?: number) => number,
 *   countAll: () => number,
 * }}
 */
export function createReferralLinks(baseDir, { links = REFERRAL_LINKS } = {}) {
  const db = getDb(baseDir);

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

  const bySlug = new Map(links.map((l) => [l.slug, l]));

  const insertStmt = db.prepare(
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

  let sincePrune = 0;

  /**
   * Drop rows past the retention horizon, then trim any slug still over its cap.
   * @param {number} [now]
   * @returns {number} Rows deleted.
   */
  function prune(now = Date.now()) {
    let removed = pruneOldStmt.run(now - RETENTION_MS).changes;
    for (const slug of bySlug.keys()) {
      removed += pruneCapStmt.run(slug, slug, MAX_ROWS_PER_SLUG).changes;
    }
    return removed;
  }

  /**
   * Record one arrival. Unknown slugs are refused — the route table is built from
   * the same registry, so an unknown slug here means a caller invented one.
   */
  function recordHit({ slug, referer, userAgent, now = Date.now() }) {
    const key = String(slug || '');
    if (!bySlug.has(key)) return { ok: false, reason: 'unknown-slug' };
    const isBot = isBotUserAgent(userAgent);
    try {
      insertStmt.run(key, now, normalizeReferer(referer) || null, isBot ? 1 : 0);
    } catch (err) {
      // A failed click count must never cost the visitor their page — the caller
      // redirects regardless, so this is logged and swallowed.
      logger.error('[referrals] could not record a hit for', key, '-', err && err.message ? err.message : err);
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

  /**
   * Per-link rollup for the dashboard: lifetime and windowed click totals, the
   * daily series behind the chart, and where the clicks came from.
   */
  function summary({ now = Date.now(), days = 30, topReferrers = 6 } = {}) {
    const windowStart = utcDayStart(now) - (days - 1) * DAY_MS;
    return links.map((link) => {
      const totals = totalsStmt.get(link.slug) || { hits: 0, bots: 0, lastClickAt: null, firstClickAt: null };
      const rows = windowStmt.all(link.slug, windowStart);
      const humanStamps = rows.filter((r) => !r.isBot).map((r) => r.ts);
      const series = buildDailySeries(humanStamps, windowStart, days);
      const last7 = series.slice(-7).reduce((sum, p) => sum + p.value, 0);
      return {
        slug: link.slug,
        label: link.label,
        note: link.note,
        path: `/${link.slug}`,
        clicks: totals.hits - totals.bots,
        botHits: totals.bots,
        windowClicks: humanStamps.length,
        windowDays: days,
        last7,
        firstClickAt: totals.firstClickAt || null,
        lastClickAt: totals.lastClickAt || null,
        series,
        referrers: referrersStmt.all(link.slug, topReferrers),
      };
    });
  }

  return {
    links,
    recordHit,
    summary,
    prune,
    countAll: () => countAllStmt.get().n,
  };
}
