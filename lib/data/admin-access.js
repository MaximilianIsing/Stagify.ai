// Admin console access log — who opened /admin, from where, and what was refused.
//
// WHY THIS EXISTS. The console is gated by ONE shared secret (`endpoint_key`,
// traded at sign-in for a scoped token — see lib/data/admin-sessions.js). That
// design has a blind spot: `admin_sessions` stores a hashed token, a key
// fingerprint and two timestamps, so it can tell you a session exists but never
// who created it, from which machine, or that anyone was turned away. The only
// trace of a sign-in was a `logger.info` line on stdout, which Render discards on
// the next deploy. So the two questions an operator with business partners
// actually has — "is a stranger trying the door?" and "when is my partner
// working?" — had no answer at all. This table is that answer.
//
// THIS IS THE OPPOSITE POLICY TO THE REST OF THE APP, ON PURPOSE. Every other
// counter here is deliberately anonymous: lib/data/blog-views.js and
// lib/data/referral-links.js both refuse to store an IP or a user-agent, because
// they count strangers who agreed to nothing. This one stores both, and keeps them
// indefinitely. The distinction is consent and scope — the subjects are the
// handful of people holding the master key to the operator console, the whole
// point of the record is to notice the one subject who ISN'T one of them, and an
// audit trail that expires is no audit trail on the day you need it. It is the
// only place in the app where an IP is retained at rest; docs/guides/security.md
// says so out loud so the exception stays a decision rather than a discovery.
//
// THREE OUTCOMES, recorded at three different places:
//   * 'signin' — POST /api/admin/session (routes/admin/index.js). The only moment the
//     master key is actually typed.
//   * 'open'   — GET /api/admin/ping, the probe the console fires once per page
//     load before it reveals the dashboard (public/scripts/admin.js). A fresh
//     sign-in does NOT ping, so 'open' and 'signin' partition cleanly and nothing
//     is double counted.
//   * 'denied' — every refusal, funnelled through rejectWith() in
//     lib/http/http-guards.js. That is the single place a wrong key or a dead
//     token is turned away, so one instrumentation point covers all of them.
//
// BURSTS ARE COLLAPSED, NOT DROPPED. /admin sits on the public internet, so
// 'denied' arrives in floods — a scanner walking URLs, or one operator's Refresh
// click firing ten requests on a token that expired while the tab sat open. Ten
// rows would be ten lies about ten separate events. Instead, a matching row
// younger than BURST_MS gets its `hits` bumped and its `last_ts` moved, so the
// burst reads as one event that happened twelve times. That is both more honest
// and what keeps the table bounded without a retention horizon.

import { getDb } from './db.js';
import { isBotUserAgent } from './referral-links.js';
import { logger } from '../logger.js';

/** Repeats from the same client inside this window fold into one row. */
const BURST_MS = 60 * 1000;

// No time horizon — the requirement is that this is kept forever. The cap is a
// safety valve and nothing else: it exists so a sustained scan cannot fill the
// Render volume that auth-store.db lives on. At the console's real volume (a
// handful of people, a few opens a day) it will never fire.
const MAX_ROWS = 250_000;
const PRUNE_EVERY = 500;

/** Raw UA is kept for forensics, but a header is attacker-controlled: cap it. */
const UA_MAX = 512;

/** A geo lookup that FAILED is retried no more than once a day. Successes never. */
const GEO_RETRY_MS = 24 * 60 * 60 * 1000;

/** How many unresolved IPs one dashboard read will look up. */
const GEO_BATCH = 5;

/** Keyless, HTTPS, no account. `ipapi.co/<ip>/json/` is the drop-in fallback. */
const GEO_ENDPOINT = 'https://ipwho.is/';

const GEO_TIMEOUT_MS = 2500;

/** The three things a row can be. Anything else is refused by record(). */
const OUTCOMES = new Set(['open', 'signin', 'denied']);

/**
 * Addresses that must never be sent to a third-party geo service: they identify
 * nothing (every dev box is 127.0.0.1) and asking about them leaks the question
 * without buying an answer.
 *
 * @param {string} ip
 * @returns {boolean}
 */
export function isPrivateAddress(ip) {
  const s = String(ip || '').trim().toLowerCase();
  if (!s || s === 'unknown' || s === '::1' || s === '::') return true;
  if (s.startsWith('127.') || s.startsWith('10.') || s.startsWith('192.168.')) return true;
  if (s.startsWith('169.254.') || s.startsWith('fe80:') || s.startsWith('fc') || s.startsWith('fd')) return true;
  const m = s.match(/^172\.(\d{1,3})\./);
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

/**
 * Reduce a user-agent to something an operator can recognise at a glance.
 *
 * This is for GROUPING AND DISPLAY, not forensics — "is that my partner's laptop
 * or someone I don't know?" The raw string is stored alongside for anyone who
 * needs to look closer.
 *
 * Order is load-bearing, because the UA string is a pile of historical lies:
 * Edge and Opera both claim to be Chrome, and Chrome claims to be Safari. Each
 * check must therefore come before the browser it impersonates.
 *
 * @param {string | null | undefined} ua
 * @returns {{ browser: string, os: string }} Empty strings when nothing matches.
 */
export function parseUserAgent(ua) {
  const s = String(ua || '');
  if (!s.trim()) return { browser: '', os: '' };

  const ver = (re) => {
    const m = s.match(re);
    return m && m[1] ? ' ' + m[1].split('.')[0] : '';
  };

  let browser = '';
  if (/Edg[A-Z]?\//.test(s)) browser = 'Edge' + ver(/Edg[A-Z]?\/(\d+[\d.]*)/);
  else if (/OPR\/|Opera/.test(s)) browser = 'Opera' + ver(/OPR\/(\d+[\d.]*)/);
  else if (/SamsungBrowser\//.test(s)) browser = 'Samsung Internet' + ver(/SamsungBrowser\/(\d+[\d.]*)/);
  else if (/Firefox\/|FxiOS\//.test(s)) browser = 'Firefox' + ver(/(?:Firefox|FxiOS)\/(\d+[\d.]*)/);
  else if (/Chrome\/|CriOS\//.test(s)) browser = 'Chrome' + ver(/(?:Chrome|CriOS)\/(\d+[\d.]*)/);
  else if (/Safari\//.test(s)) browser = 'Safari' + ver(/Version\/(\d+[\d.]*)/);
  else if (/curl\//i.test(s)) browser = 'curl';
  else if (/python-requests|wget|Go-http-client|axios|node-fetch/i.test(s)) browser = 'Script';

  let os = '';
  // Windows 11 is indistinguishable from 10 in a UA string by design, so the
  // label stops at the truth rather than guessing a number.
  if (/Windows NT/.test(s)) os = 'Windows';
  else if (/Android/.test(s)) os = 'Android';
  else if (/iPhone|iPad|iPod/.test(s)) os = /iPad/.test(s) ? 'iPadOS' : 'iOS';
  else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS';
  else if (/CrOS/.test(s)) os = 'ChromeOS';
  else if (/Linux/.test(s)) os = 'Linux';

  return { browser, os };
}

/**
 * Open the admin access log against the shared application database.
 *
 * @param {string} baseDir - Repo/base dir; resolved to the data dir by db.js.
 * @param {{
 *   enabled?: boolean,
 *   geo?: boolean,
 *   fetchImpl?: typeof fetch | null,
 *   now?: () => number,
 * }} [opts] - `enabled: false` makes record() a no-op (the suite spawns the real
 *   server and fires credential-less probes at it; without this, every `npm test`
 *   would write denied rows into the developer's actual database). `geo` and
 *   `fetchImpl` are the network seam — the suite must never reach ipwho.is.
 */
export function createAdminAccess(baseDir, opts = {}) {
  const db = getDb(baseDir);
  const clock = opts.now || Date.now;

  const enabled = opts.enabled ?? (process.env.ADMIN_ACCESS_LOG !== 'off' && process.env.NODE_ENV !== 'test');
  const doFetch = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
  const geoEnabled = opts.geo ?? (process.env.ADMIN_ACCESS_GEO !== 'off' && process.env.NODE_ENV !== 'test');

  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_access_events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      INTEGER NOT NULL,
      last_ts INTEGER NOT NULL,
      hits    INTEGER NOT NULL DEFAULT 1,
      ip      TEXT    NOT NULL,
      outcome TEXT    NOT NULL,
      reason  TEXT,
      path    TEXT,
      ua      TEXT,
      browser TEXT,
      os      TEXT,
      is_bot  INTEGER NOT NULL DEFAULT 0
    )
  `);
  // Both indexes are on last_ts, not ts: every read is newest-first, and the burst
  // collapse below moves last_ts while leaving ts pinned to the start of the burst.
  db.exec('CREATE INDEX IF NOT EXISTS idx_admin_access_last_ts ON admin_access_events (last_ts)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_admin_access_ip ON admin_access_events (ip, last_ts)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_ip_geo (
      ip           TEXT PRIMARY KEY,
      city         TEXT,
      region       TEXT,
      country      TEXT,
      country_code TEXT,
      ok           INTEGER NOT NULL DEFAULT 1,
      resolved_at  INTEGER NOT NULL
    )
  `);

  // Prepared once, here. None of these run per row — this feeds a dashboard
  // endpoint pointed at the production database, so a snapshot must cost the same
  // whether the log holds 40 rows or 40,000. (The same rule
  // lib/analytics/admin-metrics.js states, guarded the same way in the spec.)
  const bumpStmt = db.prepare(`
    UPDATE admin_access_events
       SET hits = hits + 1, last_ts = ?
     WHERE id = (
       SELECT id FROM admin_access_events
        WHERE ip = ? AND outcome = ? AND IFNULL(reason, '') = IFNULL(?, '')
          AND IFNULL(ua, '') = IFNULL(?, '') AND last_ts >= ?
        ORDER BY id DESC LIMIT 1
     )
  `);
  const insertStmt = db.prepare(`
    INSERT INTO admin_access_events (ts, last_ts, hits, ip, outcome, reason, path, ua, browser, os, is_bot)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const recentStmt = db.prepare(`
    SELECT e.*, g.city, g.region, g.country, g.country_code AS countryCode, g.ok AS geoOk
      FROM admin_access_events e
      LEFT JOIN admin_ip_geo g ON g.ip = e.ip
     ORDER BY e.last_ts DESC, e.id DESC
     LIMIT ?
  `);
  const perIpStmt = db.prepare(`
    SELECT e.ip,
           SUM(e.hits)                                          AS events,
           SUM(CASE WHEN e.outcome = 'open'   THEN e.hits ELSE 0 END) AS opens,
           SUM(CASE WHEN e.outcome = 'signin' THEN e.hits ELSE 0 END) AS signins,
           SUM(CASE WHEN e.outcome = 'denied' THEN e.hits ELSE 0 END) AS denied,
           MAX(e.is_bot)                                        AS isBot,
           MIN(e.ts)                                            AS firstSeen,
           MAX(e.last_ts)                                       AS lastSeen,
           g.city, g.region, g.country, g.country_code AS countryCode, g.ok AS geoOk
      FROM admin_access_events e
      LEFT JOIN admin_ip_geo g ON g.ip = e.ip
     GROUP BY e.ip
     ORDER BY lastSeen DESC
  `);
  // Devices are a second grouped read rather than a JS pass over `recentStmt`,
  // because the device list must cover the whole history and the feed is capped.
  const devicesStmt = db.prepare(`
    SELECT ip, browser, os, SUM(hits) AS hits, MAX(last_ts) AS lastSeen
      FROM admin_access_events
     GROUP BY ip, browser, os
     ORDER BY lastSeen DESC
  `);
  const totalsStmt = db.prepare(`
    SELECT COALESCE(SUM(hits), 0)                                        AS totalEvents,
           COALESCE(SUM(CASE WHEN outcome = 'open'   THEN hits END), 0)  AS opens,
           COALESCE(SUM(CASE WHEN outcome = 'signin' THEN hits END), 0)  AS signins,
           COALESCE(SUM(CASE WHEN outcome = 'denied' THEN hits END), 0)  AS denied,
           COUNT(DISTINCT ip)                                            AS distinctIps
      FROM admin_access_events
  `);
  const countAllStmt = db.prepare('SELECT COUNT(*) AS n FROM admin_access_events');
  const pruneCapStmt = db.prepare(`
    DELETE FROM admin_access_events
     WHERE id NOT IN (SELECT id FROM admin_access_events ORDER BY id DESC LIMIT ?)
  `);
  const geoUpsertStmt = db.prepare(`
    INSERT INTO admin_ip_geo (ip, city, region, country, country_code, ok, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ip) DO UPDATE SET
      city = excluded.city, region = excluded.region, country = excluded.country,
      country_code = excluded.country_code, ok = excluded.ok, resolved_at = excluded.resolved_at
  `);
  // Unresolved = never looked up, or looked up, failed, and past the retry delay.
  const geoPendingStmt = db.prepare(`
    SELECT DISTINCT e.ip
      FROM admin_access_events e
      LEFT JOIN admin_ip_geo g ON g.ip = e.ip
     WHERE g.ip IS NULL OR (g.ok = 0 AND g.resolved_at < ?)
     ORDER BY e.ip
     LIMIT ?
  `);

  let sincePrune = 0;

  /**
   * Trim the table back to its hard cap, newest kept. There is deliberately no
   * time-based delete here — see the header.
   *
   * @returns {number} Rows deleted.
   */
  function prune() {
    return pruneCapStmt.run(MAX_ROWS).changes;
  }

  /**
   * Shape a joined geo row for the API. Returns null rather than an empty object
   * when nothing is known: absent is not the same as "located nowhere", and the
   * panel renders the two differently.
   *
   * @param {any} row
   * @returns {{ city: string, region: string, country: string, countryCode: string } | null}
   */
  function geoOf(row) {
    if (!row || !row.geoOk || !(row.city || row.country)) return null;
    return {
      city: row.city || '',
      region: row.region || '',
      country: row.country || '',
      countryCode: row.countryCode || '',
    };
  }

  /**
   * Record one access event. NEVER THROWS — this sits on the sign-in path and in
   * the rejection funnel, and a failed audit write must not cost an operator their
   * session or turn a 403 into a 500.
   *
   * @param {{
   *   ip: string,
   *   outcome: 'open' | 'signin' | 'denied',
   *   reason?: string | null,
   *   path?: string | null,
   *   userAgent?: string | null,
   *   now?: number,
   * }} ev
   * @returns {{ ok: boolean, collapsed?: boolean, reason?: string }}
   */
  function record(ev) {
    if (!enabled) return { ok: false, reason: 'disabled' };
    const outcome = String(ev && ev.outcome);
    if (!OUTCOMES.has(outcome)) return { ok: false, reason: 'bad-outcome' };

    const now = ev.now ?? clock();
    const ip = String(ev.ip || 'unknown').slice(0, 128);
    const ua = ev.userAgent ? String(ev.userAgent).slice(0, UA_MAX) : null;
    const reason = ev.reason ? String(ev.reason).slice(0, 64) : null;
    const path = ev.path ? String(ev.path).slice(0, 256) : null;

    try {
      // Collapse first. Deliberately NOT keyed on path: a dead token makes the
      // console fire ten requests at ten different URLs, and keying on path would
      // let exactly that burst through as ten rows. The first path of the burst is
      // kept and is representative.
      if (bumpStmt.run(now, ip, outcome, reason, ua, now - BURST_MS).changes > 0) {
        return { ok: true, collapsed: true };
      }
      // Bots are recorded and FLAGGED, never dropped: a scanner hammering
      // /promptlogs is the single most interesting denied row on the page.
      const { browser, os } = parseUserAgent(ua);
      insertStmt.run(now, now, ip, outcome, reason, path, ua, browser || null, os || null, isBotUserAgent(ua) ? 1 : 0);
    } catch (err) {
      logger.error('[admin-access] could not record', outcome, 'from', ip, '-', err && err.message ? err.message : err);
      return { ok: false, reason: 'write-failed' };
    }

    sincePrune += 1;
    if (sincePrune >= PRUNE_EVERY) {
      sincePrune = 0;
      try {
        prune();
      } catch (err) {
        logger.error('[admin-access] prune failed:', err && err.message ? err.message : err);
      }
    }
    return { ok: true, collapsed: false };
  }

  /**
   * Everything the Access tab shows, in one read.
   *
   * @param {{ limit?: number }} [o] - `limit` caps the event feed only; the
   *   per-visitor rollup and the totals always cover the whole history, because
   *   "first seen" is a question about all of it.
   */
  function summary({ limit = 200 } = {}) {
    const totals = totalsStmt.get() || { totalEvents: 0, opens: 0, signins: 0, denied: 0, distinctIps: 0 };

    /** @type {Map<string, Array<{browser: string, os: string, hits: number, lastSeen: number}>>} */
    const devices = new Map();
    for (const d of devicesStmt.all()) {
      const list = devices.get(d.ip) || [];
      if (!devices.has(d.ip)) devices.set(d.ip, list);
      list.push({
        browser: d.browser || '',
        os: d.os || '',
        hits: d.hits,
        lastSeen: d.lastSeen,
      });
    }

    const visitors = perIpStmt.all().map((v) => ({
      ip: v.ip,
      geo: geoOf(v),
      events: v.events,
      opens: v.opens,
      signins: v.signins,
      denied: v.denied,
      isBot: !!v.isBot,
      firstSeen: v.firstSeen,
      lastSeen: v.lastSeen,
      devices: devices.get(v.ip) || [],
    }));

    const rows = recentStmt.all(limit).map((r) => ({
      id: r.id,
      ts: r.ts,
      lastTs: r.last_ts,
      hits: r.hits,
      ip: r.ip,
      outcome: r.outcome,
      reason: r.reason || '',
      path: r.path || '',
      ua: r.ua || '',
      browser: r.browser || '',
      os: r.os || '',
      isBot: !!r.is_bot,
      geo: geoOf(r),
    }));

    return {
      generatedAt: clock(),
      limit,
      rows,
      summary: {
        totalEvents: totals.totalEvents,
        opens: totals.opens,
        signins: totals.signins,
        denied: totals.denied,
        distinctIps: totals.distinctIps,
        deniedIps: visitors.filter((v) => v.denied > 0).length,
        visitors,
      },
    };
  }

  /**
   * Look up the location of IPs we have not resolved yet.
   *
   * Called from the READ path (after the response has been sent), never the write
   * path. That ordering is the whole design: an attacker's refused request never
   * pays for a network round-trip, a sign-in is never slowed by one, and nothing
   * reaches the network at all unless an operator is actually looking at the tab.
   * The cost is that a brand-new IP shows no city until the next refresh, which is
   * the right trade for a page nobody watches in real time.
   *
   * Never throws and never rejects.
   *
   * @param {{ max?: number, now?: number }} [o]
   * @returns {Promise<number>} How many IPs were resolved.
   */
  async function resolvePendingGeo({ max = GEO_BATCH, now } = {}) {
    if (!geoEnabled || !doFetch) return 0;
    const t = now ?? clock();
    let done = 0;
    try {
      for (const row of geoPendingStmt.all(t - GEO_RETRY_MS, max)) {
        const ip = row.ip;
        if (isPrivateAddress(ip)) {
          // Written as a failure so it is never queued again.
          geoUpsertStmt.run(ip, null, null, null, null, 0, t);
          continue;
        }
        try {
          const res = await doFetch(GEO_ENDPOINT + encodeURIComponent(ip), {
            signal: AbortSignal.timeout(GEO_TIMEOUT_MS),
            headers: { accept: 'application/json' },
          });
          const j = /** @type {{ success?: boolean, city?: string, region?: string, country?: string, country_code?: string } | null} */ (
            res && res.ok ? await res.json() : null
          );
          if (j && j.success !== false && (j.city || j.country)) {
            geoUpsertStmt.run(ip, j.city || null, j.region || null, j.country || null, j.country_code || null, 1, t);
            done += 1;
          } else {
            geoUpsertStmt.run(ip, null, null, null, null, 0, t);
          }
        } catch (err) {
          // debug, not warn: a box with no outbound network must not spam the log
          // once per dashboard refresh, forever.
          logger.debug('[admin-access] geo lookup failed for', ip, '-', err && err.message ? err.message : err);
          try {
            geoUpsertStmt.run(ip, null, null, null, null, 0, t);
          } catch { /* the retry delay is a nicety; losing it is not worth throwing */ }
        }
      }
    } catch (err) {
      logger.debug('[admin-access] geo pass failed:', err && err.message ? err.message : err);
    }
    return done;
  }

  return {
    record,
    summary,
    resolvePendingGeo,
    prune,
    /** Row count including collapsed bursts as one. Diagnostics only. */
    countAll: () => countAllStmt.get().n,
    /** Whether record() will actually write. Read by the route for `configured`. */
    enabled,
  };
}

export default createAdminAccess;
