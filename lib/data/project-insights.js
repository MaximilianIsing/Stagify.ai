// Operational visibility for the Listing Studio — what an operator needs when a broker
// writes in saying "my listing is stuck".
//
// WHY THIS EXISTS
// Every other part of this feature answers a question the OPERATOR of one account can ask
// about their own listing. Nothing could answer the questions a person supporting them has
// to ask: which listings are stuck right now, is the queue moving at all, and who is using
// the disk. Until this module the honest answer to "why is my listing stuck?" was to open
// SQLite by hand on the production volume.
//
// EVERY QUERY HERE IS READ-ONLY AND CROSS-ACCOUNT, which is exactly why it is behind the
// admin key and never reachable from a session: it deliberately ignores the ownership
// scoping that every other query in this feature is built around.
//
// IT REPORTS IDS AND COUNTS, NOT CONTENT. No titles, no addresses, no storage keys, no
// prompts — the operator needs to know THAT a listing is stuck and which one, not to read
// somebody's property details out of a support tool. The account is identified by id, and
// the caller can look up an email through the existing redacted export if they genuinely
// need to make contact.
import fs from 'fs';
import path from 'path';
import { getDb } from './db.js';
import { resolveDataDir } from './data-dir.js';
import { STORAGE_KINDS } from './project-storage.js';

/**
 * How long a listing may sit in `staging` with no render activity before it is called stuck.
 *
 * 30 minutes. A single render is seconds to a couple of minutes, and the worker's lease
 * (`DEFAULT_LEASE_MS`) reclaims an abandoned claim well inside that — so half an hour of
 * nothing is not slowness, it is a listing that will never finish on its own.
 */
export const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;

/**
 * @typedef {Object} StuckListing
 * @property {string} projectId
 * @property {string} userId Account id only — no email, no title, no address.
 * @property {string} status The listing's own status column.
 * @property {'blocked'|'stalled'} reason Why it is listed — see `stuckListings`.
 * @property {number} updatedAt Epoch ms of the listing's last write.
 * @property {number} idleMs How long it has been silent.
 * @property {number} queued
 * @property {number} running
 * @property {number} blocked Queued rows no amount of waiting will release (no design bible).
 * @property {number} failed
 * @property {number} ok
 */

/**
 * @typedef {Object} ListingHealth
 * @property {{ queued: number, running: number, blocked: number, failed: number, ok: number }} queue Totals across every account.
 * @property {StuckListing[]} stuck Listings in `staging` that have gone quiet, worst first.
 * @property {{ userId: string, projects: number, bytes: number }[]} storage Largest accounts by disk, if measured.
 * @property {number} staleAfterMs The threshold `stuck` was computed with.
 */

/**
 * Build the read-only insights queries.
 * @param {{ baseDir: string, now?: () => number }} deps - Data dir root and an injectable clock.
 */
export function createProjectInsights({ baseDir, now = Date.now }) {
  /**
   * Queue totals across every account.
   *
   * `blocked` uses the SAME shape as `progressFor` — a queued SUPPORT row whose room has no
   * design bible, which the claim's barrier will never release. Restating it here rather
   * than importing keeps this module read-only against the schema, but the two must agree:
   * if the barrier in `claimNextRender` ever changes, this is the second place to change.
   * @returns {ListingHealth['queue']} The totals.
   */
  function queueTotals() {
    const db = getDb(baseDir);
    const row = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'queued'  THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'ok'      THEN 1 ELSE 0 END) AS ok
      FROM renders
    `).get();
    const blocked = db.prepare(`
      SELECT COUNT(*) AS n
      FROM renders r
      JOIN project_photos p ON p.id = r.photo_id
      WHERE r.status = 'queued' AND p.frame_role <> 'hero' AND r.bible_id IS NULL
    `).get();
    const n = (/** @type {any} */ v) => (v && typeof v === 'object' ? Number(Object.values(v)[0]) || 0 : 0);
    const totals = /** @type {any} */ (row) || {};
    return {
      queued: Number(totals.queued) || 0,
      running: Number(totals.running) || 0,
      failed: Number(totals.failed) || 0,
      ok: Number(totals.ok) || 0,
      blocked: n(blocked),
    };
  }

  /**
   * Listings that will not finish on their own. TWO reasons, and they need different fixes:
   *
   *   'blocked' — the listing holds queued rows the claim barrier can never release (a
   *     support frame whose room never got a design bible). **Reported whatever the status
   *     column says**, and that is the whole point: the worker moves a listing to 'ready' as
   *     soon as nothing is CLAIMABLE, which a permanently-barred row satisfies. So the
   *     broker sees "ready" while a frame silently never renders, and a status-scoped query
   *     misses precisely the case an operator most needs to find. This was found by running
   *     the endpoint against a real server, not by the fixtures — the fixtures never ran the
   *     worker, so the listing stayed in 'staging' and the gap was invisible.
   *     The fix for one of these is to regenerate that room.
   *
   *   'stalled' — still 'staging', with no write for `staleAfterMs`. The signal is
   *     `projects.updated_at` because EVERY write that changes a listing touches it (the
   *     store's `touch`), including each render completing — so a listing whose renders are
   *     still landing is never stale. This one needs investigating, not regenerating.
   *
   * @param {{ staleAfterMs?: number, limit?: number }} [opts] - Threshold and result cap.
   * @returns {StuckListing[]} Blocked first, then longest-idle.
   */
  function stuckListings(opts = {}) {
    const staleAfterMs = typeof opts.staleAfterMs === 'number' && opts.staleAfterMs >= 0
      ? opts.staleAfterMs
      : DEFAULT_STALE_AFTER_MS;
    const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
    const cutoff = now() - staleAfterMs;

    const rows = getDb(baseDir).prepare(`
      SELECT
        pr.id AS project_id,
        pr.user_id,
        pr.status,
        pr.updated_at,
        SUM(CASE WHEN r.status = 'queued'  THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN r.status = 'running' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN r.status = 'failed'  THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN r.status = 'ok'      THEN 1 ELSE 0 END) AS ok,
        SUM(CASE WHEN r.status = 'queued' AND ph.frame_role <> 'hero' AND r.bible_id IS NULL THEN 1 ELSE 0 END) AS blocked
      FROM projects pr
      LEFT JOIN renders r ON r.project_id = pr.id
      LEFT JOIN project_photos ph ON ph.id = r.photo_id
      GROUP BY pr.id
      HAVING blocked > 0 OR (pr.status = 'staging' AND pr.updated_at <= ?)
      ORDER BY blocked > 0 DESC, pr.updated_at ASC
      LIMIT ?
    `).all(cutoff, limit);

    return rows.map((raw) => {
      const row = /** @type {any} */ (raw);
      const blocked = Number(row.blocked) || 0;
      return {
        projectId: String(row.project_id),
        userId: String(row.user_id),
        status: String(row.status),
        // 'blocked' wins when both apply: it is the actionable one, and it is true whatever
        // the status column claims.
        reason: /** @type {'blocked'|'stalled'} */ (blocked > 0 ? 'blocked' : 'stalled'),
        updatedAt: Number(row.updated_at) || 0,
        idleMs: Math.max(0, now() - (Number(row.updated_at) || 0)),
        queued: Number(row.queued) || 0,
        running: Number(row.running) || 0,
        blocked,
        failed: Number(row.failed) || 0,
        ok: Number(row.ok) || 0,
      };
    });
  }

  /**
   * Disk used per account, largest first.
   *
   * MEASURED FROM THE FILESYSTEM, not from the database, because the database has no byte
   * column and adding one would need every write path to maintain it — a number that can
   * drift is worse than no number in a tool an operator uses to decide whether to intervene.
   * The walk is bounded by the same fixed layout the sweep uses (`projects/<id>/{src,out}`)
   * and never recurses.
   *
   * This is O(files on the volume), so it is deliberately OPT-IN: the admin route asks for
   * it explicitly rather than paying for it on every health check.
   * @param {{ limit?: number }} [opts] - How many accounts to report.
   * @returns {{ userId: string, projects: number, bytes: number }[]} Largest first.
   */
  function storageByAccount(opts = {}) {
    const limit = Math.max(1, Math.min(200, Number(opts.limit) || 20));
    const owners = new Map();
    for (const raw of getDb(baseDir).prepare('SELECT id, user_id FROM projects').all()) {
      const row = /** @type {any} */ (raw);
      owners.set(String(row.id), String(row.user_id));
    }

    /** @type {Map<string, { userId: string, projects: number, bytes: number }>} */
    const byUser = new Map();
    const root = path.join(resolveDataDir(baseDir), 'projects');
    /** @type {import('fs').Dirent[]} */
    let projectDirs;
    try {
      projectDirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      // No projects root yet — nothing has been uploaded on this instance.
      return [];
    }

    for (const entry of projectDirs) {
      if (!entry.isDirectory()) continue;
      // A directory with no row is an orphan the SWEEP owns, not this report — attributing
      // its bytes to nobody is more honest than inventing an account for them.
      const userId = owners.get(entry.name);
      if (!userId) continue;
      let bytes = 0;
      for (const kind of STORAGE_KINDS) {
        /** @type {import('fs').Dirent[]} */
        let files;
        try {
          files = fs.readdirSync(path.join(root, entry.name, kind), { withFileTypes: true });
        } catch { continue; }
        for (const file of files) {
          if (!file.isFile()) continue;
          try {
            bytes += fs.statSync(path.join(root, entry.name, kind, file.name)).size;
          } catch { /* vanished mid-walk; it simply does not count */ }
        }
      }
      const acc = byUser.get(userId) || { userId, projects: 0, bytes: 0 };
      acc.projects += 1;
      acc.bytes += bytes;
      byUser.set(userId, acc);
    }

    return [...byUser.values()].sort((a, b) => b.bytes - a.bytes).slice(0, limit);
  }

  /**
   * One call for the support question: is anything stuck, and is the queue moving?
   * @param {{ staleAfterMs?: number, limit?: number, withStorage?: boolean }} [opts] - Knobs;
   *   `withStorage` opts into the filesystem walk.
   * @returns {ListingHealth} The report.
   */
  function health(opts = {}) {
    const staleAfterMs = typeof opts.staleAfterMs === 'number' && opts.staleAfterMs >= 0
      ? opts.staleAfterMs
      : DEFAULT_STALE_AFTER_MS;
    return {
      queue: queueTotals(),
      stuck: stuckListings({ staleAfterMs, limit: opts.limit }),
      storage: opts.withStorage ? storageByAccount({ limit: opts.limit }) : [],
      staleAfterMs,
    };
  }

  return { health, queueTotals, stuckListings, storageByAccount };
}
