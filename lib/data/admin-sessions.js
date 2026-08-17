// Admin console sessions — so the operator types `endpoint_key` once instead of on
// every page load.
//
// WHY A TOKEN AND NOT "REMEMBER THE KEY". `endpoint_key` is the master secret: the
// same value also unlocks `/api/stage-by-endpoint-key` and `POST /api/getpro` (which
// grants Pro), and revoking it means editing an env var and redeploying. Persisting
// it in a browser would put all of that in localStorage indefinitely. So the key buys
// a session token instead, and the token is strictly weaker than the key:
//
//   * it opens the dashboard's routes only — `protectLogs`, never
//     `stagingEndpointKeyGuard` or the inline check in `POST /api/getpro`,
//   * it expires (30 days, sliding), and
//   * it is revocable one device at a time (`revoke`) or all at once (`revokeAll`),
//     with no deploy.
//
// KEY ROTATION REVOKES EVERYTHING. Each row records a fingerprint of the key that
// minted it, and validation requires it to match the key in force now. Rotating
// `endpoint_key` therefore invalidates every outstanding session on the next
// request — which is what an operator rotating a leaked secret expects, and what
// they would NOT get if sessions were independent of it.
//
// Tokens are hashed at rest with the same scheme as `sessions` /
// `password_reset_tokens` — see lib/data/session-tokens.js for why plain SHA-256 is
// right for a CSPRNG bearer token. A stolen database file yields no usable session.

import crypto from 'crypto';
import { getDb } from './db.js';
import { hashToken } from './session-tokens.js';

/** How long a freshly minted (or renewed) session lasts. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// The expiry slides, but not on every request: a renewal is a write, and the
// dashboard fires ~10 requests per refresh. Extending only once the session has
// aged past this keeps it to roughly one write a day while still meaning that a
// console you actually use never asks for the key again.
export const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * A short, non-reversing fingerprint of the access key.
 *
 * Truncated deliberately: it is stored next to the sessions and only ever compared
 * with itself, so 16 hex chars is ample to detect a rotation while leaving nothing
 * useful for an attacker who reads the table. It is NOT a credential and is never
 * accepted as one.
 *
 * @param {string} key
 * @returns {string}
 */
export function keyFingerprint(key) {
  return crypto.createHash('sha256').update(String(key ?? '')).digest('hex').slice(0, 16);
}

/**
 * Build the admin-session store over the shared connection.
 *
 * Every function takes and returns RAW tokens; hashing happens inside, so no caller
 * can write an unhashed row.
 *
 * @param {string} baseDir - App base dir, resolved to the data dir by db.js.
 * @param {{ now?: () => number }} [opts] - `now` is a test seam for expiry.
 */
export function createAdminSessions(baseDir, { now = Date.now } = {}) {
  const db = getDb(baseDir);

  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token   TEXT    PRIMARY KEY,
      key_fp  TEXT    NOT NULL,
      created INTEGER NOT NULL,
      exp     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_admin_sessions_exp ON admin_sessions(exp);
  `);

  const q = {
    ins: db.prepare('INSERT OR REPLACE INTO admin_sessions (token, key_fp, created, exp) VALUES (?, ?, ?, ?)'),
    get: db.prepare('SELECT * FROM admin_sessions WHERE token = ?'),
    touch: db.prepare('UPDATE admin_sessions SET exp = ? WHERE token = ?'),
    del: db.prepare('DELETE FROM admin_sessions WHERE token = ?'),
    delAll: db.prepare('DELETE FROM admin_sessions'),
    delExpired: db.prepare('DELETE FROM admin_sessions WHERE exp < ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM admin_sessions'),
  };

  /** Drop every session past its expiry. @returns {number} rows removed */
  function prune() {
    return q.delExpired.run(now()).changes;
  }

  // Expired rows are dead weight, not a security hole (validate checks exp), so
  // they are swept on the rare operation rather than on a timer or on every read.
  prune();

  return {
    /**
     * Mint a session for the holder of `key`. The raw token is returned once and
     * never stored — only its digest reaches the table.
     *
     * @param {string} key The access key just verified by the caller. This function
     *   does NOT verify it; the route's key-only guard does, and passing an
     *   unverified value here would mint a session for it.
     * @returns {{ token: string, expiresAt: number }}
     */
    create(key) {
      prune();
      const token = crypto.randomBytes(32).toString('hex');
      const t = now();
      const expiresAt = t + SESSION_TTL_MS;
      q.ins.run(hashToken(token), keyFingerprint(key), t, expiresAt);
      return { token, expiresAt };
    },

    /**
     * Resolve a token, sliding its expiry when it has aged past `RENEW_AFTER_MS`.
     *
     * Returns null for anything not currently valid — unknown, expired, or minted
     * by a key that has since been rotated — so a caller can treat null as "not
     * authenticated" without distinguishing the cases (and without telling an
     * attacker which one it was).
     *
     * @param {string} token
     * @param {string} key The access key in force now.
     * @returns {{ expiresAt: number } | null}
     */
    validate(token, key) {
      if (!token) return null;
      const row = q.get.get(hashToken(token));
      if (!row) return null;
      const t = now();
      if (row.exp <= t) return null;
      // A rotated key must not leave live sessions behind — see the module header.
      if (row.key_fp !== keyFingerprint(key)) return null;

      let { exp } = row;
      if (exp - t < SESSION_TTL_MS - RENEW_AFTER_MS) {
        exp = t + SESSION_TTL_MS;
        q.touch.run(exp, row.token);
      }
      return { expiresAt: exp };
    },

    /** Sign one device out. Unknown tokens are a no-op. @param {string} token */
    revoke(token) {
      if (!token) return 0;
      return q.del.run(hashToken(token)).changes;
    },

    /** Sign every device out. @returns {number} rows removed */
    revokeAll() {
      return q.delAll.run().changes;
    },

    prune,

    /** Live + expired row count. Diagnostics only. @returns {number} */
    count() {
      return q.count.get().n;
    },
  };
}
