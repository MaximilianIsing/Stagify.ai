// Seller sign-off — what comes BACK through a client share link.
//
// WHY THIS EXISTS
// The share page made the staging visible to the seller. It did not make their answer
// visible to the broker, so the actual workflow still happened in a text message the
// listing knows nothing about: "the bedroom looks great, can the living room be warmer?"
// — and then the broker has to translate that into which room, which frame, and re-run it
// from memory. This table is that answer, attached to the room it is about.
//
// THIS IS THE ONLY TABLE AN ANONYMOUS REQUEST CAN WRITE TO besides `referral_hits`, and it
// is far more dangerous than that one: it accepts free text, and it lives on the volume the
// SQLite database and every customer's photographs sit on. So the ceilings here are not
// tidiness, they are the feature's safety envelope, and they are enforced in the STORE
// rather than in the route — a second route, or a route someone refactors, must not be able
// to write an unbounded row:
//   * `MAX_NOTE` clamps the free text;
//   * `MAX_PER_SHARE` refuses once a link has collected enough, so one leaked URL cannot
//     grow the database without bound;
//   * the verdict is an allowlist, not a caller-supplied string;
//   * nothing about the viewer is stored beyond an OPTIONAL display name they typed. No IP,
//     no user-agent, no cookie — the same posture as `referral_hits`, and for a stronger
//     reason: these people never agreed to anything. They were sent a link.
//
// WHAT "LATEST WINS" MEANS. A seller changes their mind, and the broker needs the current
// answer per room without losing the history of how it got there. So rows are append-only
// and `latestByRoom` reduces them; nothing is ever updated in place. The note that said
// "make it warmer" is still there after the room is approved, which is exactly what the
// broker wants when they wonder why they re-rendered it.
//
// NO FOREIGN KEYS (the standing rule — lib/data/db.js, pinned by test/data/db.test.js), so
// this table is listed EXPLICITLY in the cascades: `deleteProject` and
// `deleteProjectsForUser` in lib/data/projects.js, and USER_ID_TABLES in
// lib/data/user-deletion.js. `user_id` is denormalized onto the row for the same reason it
// is on `project_shares`: it is what lets the erasure drift guard SEE this table at all.
import crypto from 'crypto';
import { getDb } from './db.js';
import { logger } from '../logger.js';

/** @typedef {import('../types/projects.js').ShareFeedback} ShareFeedback */

/** The two answers a viewer can give. An allowlist, never a caller-supplied string. */
export const FEEDBACK_VERDICTS = Object.freeze(['approved', 'changes']);

/**
 * Free-text ceiling. Generous enough for a real "the sofa is too big for that wall, and
 * could the art be less blue" and far short of anything worth storing.
 */
export const MAX_NOTE = 500;

/** Optional display name. Nobody is required to give one — see the header. */
export const MAX_VIEWER_LABEL = 60;

/**
 * Rows one share link may ever collect.
 *
 * A share URL is a bearer credential the broker may have posted anywhere, so the honest
 * threat is not a malicious seller — it is a link that ends up somewhere public and gets
 * hit by whatever finds it. 200 is far past a real listing (a 12-room house, revisited a
 * few times) and small enough that a leaked link is a bounded write.
 */
export const MAX_PER_SHARE = 200;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS share_feedback (
    id TEXT PRIMARY KEY,
    share_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    room_key TEXT,
    verdict TEXT NOT NULL CHECK (verdict IN ('approved','changes')),
    note TEXT NOT NULL DEFAULT '',
    viewer_label TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  -- The broker's read: this listing's responses, newest first.
  CREATE INDEX IF NOT EXISTS idx_feedback_project ON share_feedback (project_id, created_at DESC);
  -- The per-share ceiling check, on every anonymous write.
  CREATE INDEX IF NOT EXISTS idx_feedback_share ON share_feedback (share_id);
  -- Account erasure sweeps by user, without a join back to projects.
  CREATE INDEX IF NOT EXISTS idx_feedback_user ON share_feedback (user_id);
`;

/**
 * Trim and hard-clamp a caller-supplied string, collapsing whitespace runs.
 *
 * The collapse matters here and not elsewhere: this text is rendered into a broker's
 * workspace, and 400 newlines is a denial-of-attention attack on a UI that has no reason
 * to preserve them.
 * @param {unknown} value - Raw field.
 * @param {number} max - Maximum characters kept.
 * @returns {string} The clamped string; '' when the field was not a string.
 */
export function clampNote(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Open the share-feedback store against the shared application database.
 * @param {string} baseDir - Repo/base dir, resolved to the data dir by db.js.
 */
export function createShareFeedback(baseDir) {
  const db = getDb(baseDir);
  db.exec(SCHEMA);

  const q = {
    insert: db.prepare(`INSERT INTO share_feedback
      (id, share_id, project_id, user_id, room_key, verdict, note, viewer_label, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`),
    countForShare: db.prepare('SELECT COUNT(*) AS n FROM share_feedback WHERE share_id = ?'),
    listForProject: db.prepare('SELECT * FROM share_feedback WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?'),
    listForShare: db.prepare('SELECT * FROM share_feedback WHERE share_id = ? ORDER BY created_at ASC, rowid ASC'),
    delForProject: db.prepare('DELETE FROM share_feedback WHERE project_id = ?'),
    delForUser: db.prepare('DELETE FROM share_feedback WHERE user_id = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM share_feedback'),
  };

  const withTxn = db.transaction((/** @type {() => any} */ fn) => fn());

  /**
   * Row → API shape.
   * @param {any} row - Raw better-sqlite3 row.
   * @returns {ShareFeedback | null} The mapped response.
   */
  const rowTo = (row) => (row ? {
    id: row.id,
    shareId: row.share_id,
    projectId: row.project_id,
    userId: row.user_id,
    roomKey: row.room_key ?? null,
    verdict: row.verdict,
    note: row.note || '',
    viewerLabel: row.viewer_label || '',
    createdAt: row.created_at,
  } : null);

  /** @param {any} row @returns {number} */
  const countOf = (row) => (row && typeof row.n === 'number' ? row.n : 0);

  /**
   * Record one response from a share viewer.
   *
   * The ceiling check and the insert are ONE transaction: two requests arriving together
   * would otherwise both read 199 and both write, and a limit that can be raced is not a
   * limit. The refusal is a result rather than a throw, because the caller's job is to turn
   * it into a calm "thanks, we have your notes" rather than a 500 — a seller hitting a cap
   * they cannot see must not be shown a crash.
   *
   * @param {{ shareId?: string, projectId?: string, userId?: string, roomKey?: string|null,
   *   verdict?: string, note?: unknown, viewerLabel?: unknown, now?: number }} [arg]
   * @returns {{ ok: true, feedback: ShareFeedback } | { ok: false, code: 'BAD_VERDICT'|'FULL'|'MISSING_SHARE' }}
   */
  function addFeedback(arg = {}) {
    const shareId = String(arg.shareId || '');
    const projectId = String(arg.projectId || '');
    const userId = String(arg.userId || '');
    if (!shareId || !projectId) return { ok: false, code: 'MISSING_SHARE' };
    const verdict = String(arg.verdict || '');
    if (!FEEDBACK_VERDICTS.includes(verdict)) return { ok: false, code: 'BAD_VERDICT' };

    const now = typeof arg.now === 'number' ? arg.now : Date.now();
    const roomKey = arg.roomKey == null || arg.roomKey === '' ? null : String(arg.roomKey).slice(0, 64);
    const note = clampNote(arg.note, MAX_NOTE);
    const viewerLabel = clampNote(arg.viewerLabel, MAX_VIEWER_LABEL);

    return withTxn(() => {
      if (countOf(q.countForShare.get(shareId)) >= MAX_PER_SHARE) return { ok: false, code: 'FULL' };
      const row = q.insert.get(
        crypto.randomBytes(16).toString('hex'), shareId, projectId, userId,
        roomKey, verdict, note, viewerLabel, now,
      );
      return { ok: true, feedback: /** @type {ShareFeedback} */ (rowTo(row)) };
    });
  }

  /**
   * One listing's responses, newest first — what the studio panel renders.
   * @param {string} projectId - Listing id.
   * @param {number} [limit] - Rows to return.
   * @returns {ShareFeedback[]} The responses.
   */
  const listForProject = (projectId, limit = MAX_PER_SHARE) =>
    q.listForProject.all(String(projectId), Math.max(1, Math.min(MAX_PER_SHARE, Number(limit) || MAX_PER_SHARE)))
      .map(rowTo)
      .filter(/** @returns {f is ShareFeedback} */ (f) => f !== null);

  /**
   * The CURRENT answer per room, reduced from the append-only history.
   *
   * Read in ascending time and overwritten, so the last row for a room wins — a seller who
   * asked for a change and then approved it reads as approved, while the note explaining
   * why the room was re-rendered is still in `listForProject`. The whole-listing response
   * (`roomKey === null`) is keyed under '' so it cannot collide with a real room key.
   * @param {string} shareId - Which link's responses to reduce.
   * @returns {Map<string, ShareFeedback>} roomKey ('' for the whole listing) → newest response.
   */
  function latestByRoom(shareId) {
    /** @type {Map<string, ShareFeedback>} */
    const latest = new Map();
    for (const row of q.listForShare.all(String(shareId))) {
      const item = rowTo(row);
      if (item) latest.set(item.roomKey || '', item);
    }
    return latest;
  }

  /**
   * How full one link's allowance is — so a client can stop offering the form before the
   * refusal, rather than after it.
   * @param {string} shareId - Link id.
   * @returns {{ used: number, limit: number, full: boolean }} The allowance.
   */
  function allowanceFor(shareId) {
    const used = countOf(q.countForShare.get(String(shareId)));
    return { used, limit: MAX_PER_SHARE, full: used >= MAX_PER_SHARE };
  }

  /**
   * Drop every response for one listing — called from `deleteProject`'s cascade in
   * lib/data/projects.js, inside that transaction.
   * @param {string} projectId - Listing id.
   * @returns {number} Rows removed.
   */
  const deleteForProject = (projectId) => q.delForProject.run(String(projectId)).changes;

  /**
   * Drop every response across one account's listings — the erasure sweep's belt-and-braces
   * pass. These rows hold text a THIRD PARTY typed about the subject's property, which is
   * still the subject's data and still goes.
   * @param {string} userId - Account id.
   * @returns {number} Rows removed.
   */
  const deleteForUser = (userId) => q.delForUser.run(String(userId)).changes;

  /** @returns {number} Total rows, for the admin counters and the tests. */
  const count = () => countOf(q.count.get());

  // One line at boot so an operator can see the anonymous-write surface exists at all.
  logger.debug('[share-feedback] store ready');

  return { addFeedback, listForProject, latestByRoom, allowanceFor, deleteForProject, deleteForUser, count };
}
