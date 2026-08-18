// Read-only aggregates over the shared SQLite database, for the admin dashboard's
// Signals tab.
//
// WHY THIS EXISTS AT ALL, given the dashboard has deliberately had no backend.
// The console downloads the raw CSV/JSON exports and aggregates in the browser
// (docs/guides/admin-dashboard.md), and that is the right shape for the log
// files. But the numbers the Signals rules need most are the ones the CSVs
// structurally cannot give:
//
//   - **Attribution.** A `prompt_logs.csv` row's email comes from the request
//     BODY and is `unknown` whenever the client didn't send one, which is why
//     every funnel and cohort on the Insights tab is documented as "a floor, not
//     a count". `staged_renders.user_id` is written from the VALIDATED session,
//     so it is the count. Shipping it lets findings-quality.js#attributionGap
//     finally measure the gap instead of restating the caveat.
//   - **Bytes, shares and queue health** live only in SQL. There is no export
//     that carries `render_blobs.bytes`, `gallery_shares.view_count`, the stuck
//     `stripe_events` rows, or the `blob_tombstones` backlog.
//
// TWO RULES THIS MODULE FOLLOWS
//
// 1. **Every statement is prepared once, at factory time, and none of them run
//    per row.** The whole snapshot is a fixed number of GROUP BY / COUNT
//    queries no matter how much data exists. test/analytics/admin-metrics.test.js
//    counts `db.prepare` calls and asserts the count does not move with the row
//    count — this is a dashboard endpoint that will be pointed at the production
//    database, so an accidental N+1 here is an outage, not a slow page.
//
// 2. **No calendar-day bucketing.** Every window below is a DURATION ("in the
//    last 30 days"), never a day key. Day keys on this dashboard are LOCAL to
//    whoever is reading it (analytics.js#dayKeyLocal), and the server has no idea
//    what timezone that is — bucketing here would shift every row by a day for
//    anyone east of the server. Series that need day keys are built in the
//    browser from the CSV exports, which already work that way.

import fs from 'fs';
import path from 'path';
import { STRIPE_EVENT_RECLAIM_MS } from '../data/stripe-events.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many rows the per-account lists carry. Enough to act on, small enough to ship. */
const TOP_N = 10;

/**
 * The CSV logs whose size is worth reporting, with the ceiling each one stops at.
 *
 * `null` means the writer has no ceiling: the file grows until the disk does. It
 * is reported anyway — an unbounded log sharing a volume with SQLite's WAL is
 * exactly the thing you want to see coming, and reporting a size with no limit
 * beside it is more honest than omitting the row.
 */
const LOG_FILES = [
  { name: 'prompt_logs.csv', ceilingEnv: 'CSV_LOG_MAX_BYTES', ceilingDefault: null },
  { name: 'rejection_logs.csv', ceilingEnv: 'CSV_LOG_MAX_BYTES', ceilingDefault: null },
  { name: 'chat_logs.csv', ceilingEnv: 'CSV_LOG_MAX_BYTES', ceilingDefault: null },
  { name: 'mask_logs.csv', ceilingEnv: 'CSV_LOG_MAX_BYTES', ceilingDefault: null },
  { name: 'contact_logs.csv', ceilingEnv: 'BUG_REPORT_LOG_MAX_BYTES', ceilingDefault: 32 * 1024 * 1024 },
  { name: 'bug_reports.csv', ceilingEnv: 'BUG_REPORT_LOG_MAX_BYTES', ceilingDefault: 32 * 1024 * 1024 },
  { name: 'email_open_logs.csv', ceilingEnv: 'EMAIL_OPEN_LOG_MAX_BYTES', ceilingDefault: 4 * 1024 * 1024 },
];

/**
 * Build the metrics reader.
 *
 * `db` is typed structurally rather than as better-sqlite3's `Database` — the
 * same loose-injection convention the other stores use (see
 * lib/data/auth-redaction.js#createAuthExport).
 *
 * @param {{
 *   db: { prepare: (sql: string) => { get: (...a: any[]) => any, all: (...a: any[]) => any[] } },
 *   getDataLogDir: () => string,
 * }} deps
 */
export function createAdminMetrics({ db, getDataLogDir }) {
  // ── Renders ───────────────────────────────────────────────────────────────
  //
  // `evicted_at IS NULL` is NOT applied to the outcome counts. An evicted render
  // still happened and still succeeded or failed; excluding it would make the
  // success rate silently improve as free accounts hit their gallery cap.
  const qRenderTotals = db.prepare(`
    SELECT
      COUNT(*)                                                    AS total,
      SUM(CASE WHEN status = 'ok'      THEN 1 ELSE 0 END)          AS ok,
      SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END)          AS failed,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)          AS pending,
      SUM(CASE WHEN evicted_at IS NOT NULL THEN 1 ELSE 0 END)      AS evicted,
      COUNT(DISTINCT user_id)                                      AS distinctUsers,
      MIN(created_at)                                              AS firstAt,
      MAX(created_at)                                              AS lastAt
    FROM staged_renders
  `);

  // json_valid guards the extract: a row whose extra_json is malformed would
  // otherwise abort the whole query rather than falling into the unknown bucket.
  // Legacy rows have extra_json NULL, which json_valid rejects, so they land in
  // 'unknown' too — correct, since the column post-dates them.
  const qRendersBySource = db.prepare(`
    SELECT
      COALESCE(CASE WHEN json_valid(extra_json)
                    THEN json_extract(extra_json, '$.source') END, 'unknown') AS source,
      COUNT(*)                                            AS total,
      SUM(CASE WHEN status = 'ok'     THEN 1 ELSE 0 END)   AS ok,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)   AS failed
    FROM staged_renders
    GROUP BY source
    ORDER BY total DESC
  `);

  const qRendersInWindow = db.prepare(`
    SELECT
      COUNT(*)                                            AS total,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)   AS failed,
      COUNT(DISTINCT user_id)                             AS distinctUsers
    FROM staged_renders
    WHERE created_at >= ?
  `);

  // The per-account render distribution, as a compact histogram of counts rather
  // than a row per user: "how concentrated is usage" needs the shape, not the
  // names, and shipping one row per account would grow this payload without
  // bound.
  const qRendersPerUser = db.prepare(`
    SELECT user_id AS userId, COUNT(*) AS renders
    FROM staged_renders
    WHERE status = 'ok'
    GROUP BY user_id
    ORDER BY renders DESC
  `);

  // ── Storage ───────────────────────────────────────────────────────────────
  const qBlobTotals = db.prepare(`
    SELECT COUNT(*) AS blobs, COALESCE(SUM(bytes), 0) AS bytes FROM render_blobs
  `);
  const qBlobsByUser = db.prepare(`
    SELECT user_id AS userId, COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS blobs
    FROM render_blobs
    GROUP BY user_id
    ORDER BY bytes DESC
    LIMIT ?
  `);
  const qRefTotals = db.prepare(`
    SELECT COUNT(*) AS refs, COALESCE(SUM(bytes), 0) AS bytes FROM ref_objects
  `);

  // ── Shares ────────────────────────────────────────────────────────────────
  //
  // `viewed` counts SHARES that have ever been opened; `views` counts openings.
  // Both are needed: 40 views across 2 of 30 links is a different product
  // situation from 40 views across 25 of them, and a single total cannot tell
  // them apart.
  const qShares = db.prepare(`
    SELECT
      COUNT(*)                                                  AS minted,
      SUM(CASE WHEN view_count > 0 THEN 1 ELSE 0 END)            AS viewed,
      COALESCE(SUM(view_count), 0)                               AS views,
      SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END)    AS revoked,
      MAX(last_viewed_at)                                        AS lastViewedAt
    FROM gallery_shares
  `);

  // ── Accounts ──────────────────────────────────────────────────────────────
  const qAccountTotals = db.prepare('SELECT COUNT(*) AS total FROM users');
  const qLiveSessions = db.prepare('SELECT COUNT(DISTINCT user_id) AS users FROM sessions WHERE exp > ?');
  const qPendingRegs = db.prepare('SELECT COUNT(*) AS total FROM pending_registrations WHERE exp > ?');

  // ── Operational health ────────────────────────────────────────────────────
  //
  // A `processing` row older than the reclaim window means a webhook handler was
  // killed mid-flight. The ledger recovers (the next delivery re-claims it), but
  // a growing count is a crashing handler and nothing else reports it.
  const qStuckEvents = db.prepare(`
    SELECT COUNT(*) AS stuck FROM stripe_events
    WHERE status = 'processing' AND claimed_at < ?
  `);
  const qTombstones = db.prepare(`
    SELECT
      COUNT(*)                                            AS backlog,
      SUM(CASE WHEN attempts >= 3 THEN 1 ELSE 0 END)       AS failing,
      MAX(last_attempt_at)                                AS lastAttemptAt
    FROM blob_tombstones
  `);
  const qTombstoneError = db.prepare(`
    SELECT last_error AS lastError FROM blob_tombstones
    WHERE last_error IS NOT NULL AND last_error <> ''
    ORDER BY last_attempt_at DESC LIMIT 1
  `);

  /** Nearest-rank percentile over an ascending array. @param {number[]} sorted @param {number} p */
  function percentile(sorted, p) {
    if (!sorted.length) return null;
    const rank = Math.ceil((p / 100) * sorted.length);
    return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
  }

  /**
   * Byte size of each CSV log, with its ceiling.
   *
   * A missing file reports `bytes: 0, exists: false` rather than being omitted —
   * "no rejections have ever been logged" and "the rejection log is small" are
   * different facts, and an absent row would read as the second.
   */
  function logSizes() {
    let dir;
    try {
      dir = getDataLogDir();
    } catch {
      return [];
    }
    return LOG_FILES.map((spec) => {
      let bytes = 0;
      let exists = false;
      try {
        bytes = fs.statSync(path.join(dir, spec.name)).size;
        exists = true;
      } catch {
        // ENOENT is the normal state for a log nothing has written yet.
      }
      const override = Number(process.env[spec.ceilingEnv]);
      const ceiling = Number.isFinite(override) && override > 0 ? override : spec.ceilingDefault;
      return { name: spec.name, bytes, exists, ceiling };
    });
  }

  /**
   * One read of everything above.
   *
   * @param {{now?: number}} [opts] `now` is injectable so the suite is not clock-dependent.
   * @returns {object} The metrics pack served by GET /api/admin/metrics.
   */
  function snapshot(opts = {}) {
    const now = typeof opts.now === 'number' ? opts.now : Date.now();

    const totals = qRenderTotals.get() || {};
    const perUser = qRendersPerUser.all();
    const counts = perUser.map((r) => Number(r.renders) || 0).sort((a, b) => a - b);
    const shares = qShares.get() || {};
    const blobs = qBlobTotals.get() || {};
    const refs = qRefTotals.get() || {};
    const tombstones = qTombstones.get() || {};

    const win30 = qRendersInWindow.get(now - 30 * DAY_MS) || {};
    const win7 = qRendersInWindow.get(now - 7 * DAY_MS) || {};

    return {
      generatedAt: now,
      renders: {
        total: Number(totals.total) || 0,
        ok: Number(totals.ok) || 0,
        failed: Number(totals.failed) || 0,
        pending: Number(totals.pending) || 0,
        evicted: Number(totals.evicted) || 0,
        // The number the CSV cannot produce: renders tied to a real account.
        distinctUsers: Number(totals.distinctUsers) || 0,
        firstAt: totals.firstAt ?? null,
        lastAt: totals.lastAt ?? null,
        bySource: qRendersBySource.all().map((r) => ({
          source: String(r.source || 'unknown'),
          total: Number(r.total) || 0,
          ok: Number(r.ok) || 0,
          failed: Number(r.failed) || 0,
        })),
        last30d: { total: Number(win30.total) || 0, failed: Number(win30.failed) || 0, users: Number(win30.distinctUsers) || 0 },
        last7d: { total: Number(win7.total) || 0, failed: Number(win7.failed) || 0, users: Number(win7.distinctUsers) || 0 },
        perUser: {
          accounts: counts.length,
          p50: percentile(counts, 50),
          p90: percentile(counts, 90),
          max: counts.length ? counts[counts.length - 1] : null,
          top: perUser.slice(0, TOP_N).map((r) => ({ userId: String(r.userId || ''), renders: Number(r.renders) || 0 })),
        },
      },
      accounts: {
        total: Number((qAccountTotals.get() || {}).total) || 0,
        withLiveSession: Number((qLiveSessions.get(now) || {}).users) || 0,
        // Signups that started, got a code, and never verified. Still inside
        // their 15-minute window, so this is a live abandonment count.
        pendingVerification: Number((qPendingRegs.get(now) || {}).total) || 0,
      },
      storage: {
        blobs: Number(blobs.blobs) || 0,
        bytes: Number(blobs.bytes) || 0,
        refCount: Number(refs.refs) || 0,
        refBytes: Number(refs.bytes) || 0,
        topAccounts: qBlobsByUser.all(TOP_N).map((r) => ({
          userId: String(r.userId || ''),
          bytes: Number(r.bytes) || 0,
          blobs: Number(r.blobs) || 0,
        })),
      },
      shares: {
        minted: Number(shares.minted) || 0,
        viewed: Number(shares.viewed) || 0,
        views: Number(shares.views) || 0,
        revoked: Number(shares.revoked) || 0,
        lastViewedAt: shares.lastViewedAt ?? null,
      },
      health: {
        stuckStripeEvents: Number((qStuckEvents.get(now - STRIPE_EVENT_RECLAIM_MS) || {}).stuck) || 0,
        stripeReclaimMs: STRIPE_EVENT_RECLAIM_MS,
        tombstoneBacklog: Number(tombstones.backlog) || 0,
        tombstonesFailing: Number(tombstones.failing) || 0,
        lastTombstoneError: (qTombstoneError.get() || {}).lastError ?? null,
      },
      logs: logSizes(),
    };
  }

  return { snapshot };
}
