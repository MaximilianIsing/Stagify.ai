// Blog article opens — one row per arrival on a /blog/<slug> page, for the admin
// dashboard's Blog tab.
//
// WHY THIS IS COUNTED SERVER-SIDE rather than by a beacon in the page. The
// articles are plain static HTML served by hand-written routes in
// routes/public.js; they run no analytics of their own, and a script-based
// counter would miss exactly the readers most worth counting (reader modes,
// content blockers, clients that never run the script). The route is the one
// place every open passes through.
//
// The privacy rules are the ones lib/data/referral-links.js documents, and for the
// same reason — an article is opened by strangers who agreed to nothing:
//   * No IP address and no stored user-agent. The UA is inspected in memory to set
//     `is_bot` and then dropped.
//   * The referrer is reduced to host + path; the query string (which routinely
//     carries the sending site's own tracking parameters) is discarded.
// Bot traffic is RECORDED but FLAGGED rather than dropped: a blog URL posted to a
// feed or pasted into Slack is fetched by crawlers and link unfurlers well before
// a human opens it, so counting those as reads would inflate a post badly, while
// discarding them silently would leave the operator wondering where the hits went.
// Everything the dashboard calls a "read" is `is_bot = 0`.
//
// This module deliberately does NOT own the list of articles — that comes from
// lib/content/blog-posts.js, which scans public/blog/. Views for a slug whose file
// is gone are still stored and still reported (as a retired post), so deleting an
// article does not silently erase the evidence that people were reading it.

import { getDb } from './db.js';
import { isBotUserAgent, normalizeReferer, buildDailySeries } from './referral-links.js';
import { logger } from '../logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Epoch 0 is itself a UTC midnight, so flooring by whole days lands exactly on one.
const utcDayStart = (ts) => Math.floor(ts / DAY_MS) * DAY_MS;

/** Slugs are file names under public/blog/; this is the shape those can take. */
export const BLOG_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;

// Retention + hard cap, mirroring referral_hits: this table is written by
// unauthenticated requests onto the same volume auth-store.db lives on, so it gets
// a ceiling like every other anonymous write path in the app.
const RETENTION_MS = 400 * DAY_MS;
const MAX_ROWS_PER_SLUG = 200_000;
const PRUNE_EVERY_VIEWS = 500;

/** How many referring sites each post's detail card carries. */
const TOP_REFERRERS = 8;

/**
 * @typedef {object} BlogPostViews
 * @property {string} slug
 * @property {string} title
 * @property {string} path
 * @property {string | null} publishedAt
 * @property {boolean} retired       True when views exist but the article file is gone.
 * @property {number} views          Lifetime human reads.
 * @property {number} botHits        Lifetime automated hits, excluded from `views`.
 * @property {number} windowViews    Human reads inside the requested window.
 * @property {number} windowDays
 * @property {number} last7
 * @property {number | null} firstViewAt
 * @property {number | null} lastViewAt
 * @property {Array<{ date: string, value: number }>} series
 * @property {Array<{ source: string, value: number }>} referrers
 */

/**
 * Open the blog-view store against the shared application database.
 *
 * @param {string} baseDir - Repo/base dir; resolved to the data dir by db.js.
 */
export function createBlogViews(baseDir) {
  const db = getDb(baseDir);

  db.exec(`
    CREATE TABLE IF NOT EXISTS blog_views (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      slug    TEXT    NOT NULL,
      ts      INTEGER NOT NULL,
      referer TEXT,
      is_bot  INTEGER NOT NULL DEFAULT 0
    )
  `);
  // Every read is "this slug, this time window"; every prune is "this slug, oldest
  // first". One composite index serves both.
  db.exec('CREATE INDEX IF NOT EXISTS idx_blog_views_slug_ts ON blog_views (slug, ts)');

  // Every statement is prepared once, here, and none of them run per post — the
  // rule lib/analytics/admin-metrics.js states, for the same reason: this feeds a
  // dashboard endpoint pointed at the production database, so a snapshot must cost
  // the same whether the blog has 14 articles or 400.
  const insertViewStmt = db.prepare('INSERT INTO blog_views (slug, ts, referer, is_bot) VALUES (?, ?, ?, ?)');

  const totalsStmt = db.prepare(`
    SELECT slug,
           COUNT(*)                              AS hits,
           COALESCE(SUM(is_bot), 0)              AS bots,
           MIN(CASE WHEN is_bot = 0 THEN ts END) AS firstViewAt,
           MAX(CASE WHEN is_bot = 0 THEN ts END) AS lastViewAt
      FROM blog_views
     GROUP BY slug
  `);
  // One scan of the window for every post at once: each post's daily series and the
  // sitewide series are both bucketed from these rows in JS, so an extra article
  // does not mean an extra query.
  const windowStmt = db.prepare('SELECT slug, ts FROM blog_views WHERE ts >= ? AND is_bot = 0');
  const referrersStmt = db.prepare(`
    SELECT slug, referer AS source, COUNT(*) AS value
      FROM blog_views
     WHERE is_bot = 0 AND referer IS NOT NULL AND referer <> ''
     GROUP BY slug, referer
     ORDER BY value DESC, source ASC
  `);
  const countAllStmt = db.prepare('SELECT COUNT(*) AS n FROM blog_views');
  const listSlugsStmt = db.prepare('SELECT DISTINCT slug FROM blog_views');
  const pruneOldStmt = db.prepare('DELETE FROM blog_views WHERE ts < ?');
  const pruneCapStmt = db.prepare(`
    DELETE FROM blog_views
     WHERE slug = ?
       AND id NOT IN (SELECT id FROM blog_views WHERE slug = ? ORDER BY id DESC LIMIT ?)
  `);

  let sincePrune = 0;

  /**
   * Drop views past the retention horizon, then trim any slug still over its cap.
   *
   * @param {number} [now]
   * @returns {number} Rows deleted.
   */
  function prune(now = Date.now()) {
    let removed = pruneOldStmt.run(now - RETENTION_MS).changes;
    for (const row of listSlugsStmt.all()) {
      removed += pruneCapStmt.run(row.slug, row.slug, MAX_ROWS_PER_SLUG).changes;
    }
    return removed;
  }

  /**
   * Record one article open.
   *
   * Never throws: the caller is a page route, and a failed counter must not cost
   * the reader their article.
   *
   * @param {{ slug: string, referer?: string | null, userAgent?: string | null, now?: number }} arg
   * @returns {{ ok: boolean, isBot?: boolean, reason?: string }}
   */
  function recordView({ slug, referer, userAgent, now = Date.now() }) {
    const key = String(slug || '').trim().toLowerCase();
    if (!BLOG_SLUG_PATTERN.test(key)) return { ok: false, reason: 'bad-slug' };
    const isBot = isBotUserAgent(userAgent);
    try {
      insertViewStmt.run(key, now, normalizeReferer(referer) || null, isBot ? 1 : 0);
    } catch (err) {
      logger.error('[blog-views] could not record a view for', key, '-', err && err.message ? err.message : err);
      return { ok: false, reason: 'write-failed' };
    }
    sincePrune += 1;
    if (sincePrune >= PRUNE_EVERY_VIEWS) {
      sincePrune = 0;
      try {
        prune(now);
      } catch (err) {
        logger.error('[blog-views] prune failed:', err && err.message ? err.message : err);
      }
    }
    return { ok: true, isBot };
  }

  /**
   * Everything the Blog tab shows, in one read.
   *
   * @param {{
   *   posts?: Array<{ slug: string, title?: string, path?: string, publishedAt?: string | null }>,
   *   now?: number,
   *   days?: number,
   * }} [opts] `posts` is the article catalog (lib/content/blog-posts.js). `now` is
   *   injectable so the suite is not clock-dependent.
   * @returns {{ generatedAt: number, days: number, totals: object, posts: BlogPostViews[] }}
   */
  function summary({ posts = [], now = Date.now(), days = 30 } = {}) {
    const windowStart = utcDayStart(now) - (days - 1) * DAY_MS;

    /** @type {Map<string, any>} */
    const totals = new Map();
    for (const row of totalsStmt.all()) totals.set(row.slug, row);

    /** @type {Map<string, number[]>} */
    const stamps = new Map();
    for (const row of windowStmt.all(windowStart)) {
      const list = stamps.get(row.slug);
      if (list) list.push(row.ts);
      else stamps.set(row.slug, [row.ts]);
    }

    /** @type {Map<string, Array<{source: string, value: number}>>} */
    const referrers = new Map();
    for (const row of referrersStmt.all()) {
      const list = referrers.get(row.slug) || [];
      // Rows already arrive ordered by count, so the per-slug cap is just a length
      // check as they stream past.
      if (list.length < TOP_REFERRERS) list.push({ source: row.source, value: Number(row.value) || 0 });
      referrers.set(row.slug, list);
    }

    // A slug with views but no catalog entry is an article that has been deleted or
    // renamed. Reported as retired rather than dropped: its readership happened.
    const known = new Set(posts.map((p) => p.slug));
    const orphans = [...totals.keys()]
      .filter((slug) => !known.has(slug))
      .map((slug) => ({ slug, title: slug, path: '/blog/' + slug, publishedAt: null, retired: true }));

    /** @type {Array<{ slug: string, title: string, path: string, publishedAt: string | null, retired: boolean }>} */
    const catalog = [
      ...posts.map((p) => ({
        slug: p.slug,
        title: p.title || p.slug,
        path: p.path || '/blog/' + p.slug,
        publishedAt: p.publishedAt ?? null,
        retired: false,
      })),
      ...orphans,
    ];

    const rows = catalog.map((post) => {
      const t = totals.get(post.slug) || { hits: 0, bots: 0, firstViewAt: null, lastViewAt: null };
      const windowStamps = stamps.get(post.slug) || [];
      const series = buildDailySeries(windowStamps, windowStart, days);
      return {
        ...post,
        views: (Number(t.hits) || 0) - (Number(t.bots) || 0),
        botHits: Number(t.bots) || 0,
        windowViews: windowStamps.length,
        windowDays: days,
        last7: series.slice(-7).reduce((sum, p) => sum + p.value, 0),
        firstViewAt: t.firstViewAt || null,
        lastViewAt: t.lastViewAt || null,
        series,
        referrers: referrers.get(post.slug) || [],
      };
    });

    // Ranked by the window the operator is actually looking at, with lifetime reads
    // as the tiebreak. Sorting by lifetime alone would pin the oldest article to the
    // top forever, which answers "what has been read" rather than "what is working".
    rows.sort((a, b) => (b.windowViews - a.windowViews) || (b.views - a.views) || (a.slug < b.slug ? -1 : 1));

    const allStamps = [];
    for (const list of stamps.values()) allStamps.push(...list);

    return {
      generatedAt: now,
      days,
      totals: {
        posts: rows.length,
        views: rows.reduce((sum, r) => sum + r.views, 0),
        botHits: rows.reduce((sum, r) => sum + r.botHits, 0),
        windowViews: allStamps.length,
        // Articles nobody has ever opened — the list that is actually actionable.
        unread: rows.filter((r) => !r.views).length,
        series: buildDailySeries(allStamps, windowStart, days),
      },
      posts: rows,
    };
  }

  return { recordView, summary, prune, countAll: () => countAllStmt.get().n };
}
