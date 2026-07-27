// The two token-keyed tables — `sessions` and `password_reset_tokens` — and the
// hashing that keeps them from being a set of ready-to-use credentials at rest.
//
// Both hold BEARER tokens: whoever has the string is the user, no password step.
// Stored raw, anything that can read the database file (a stolen /data volume, a
// Litestream/R2 restore, the frozen auth-store.json fallback, a full backup
// download) is account takeover for every logged-in user — the scrypt-hashed
// passwords next to them would be irrelevant. So the raw value never reaches
// disk: it lives in memory and in the cookie/email that carries it to the user,
// while the table holds a digest and every lookup hashes what it is given.
//
// This module owns those tables end to end (statements, hashing, pruning, the
// one-time migration) so no other file can write a token row without hashing it.

import crypto from 'crypto';

// Plain SHA-256, no salt and no stretching. That is correct here and is NOT the
// mistake it would be for a password: the input is already 32 bytes of CSPRNG
// output, so there is no guessable keyspace for a work factor to slow down, and
// the digest has to stay a deterministic lookup key — session validation runs on
// every authenticated request.
export const TOKEN_HASH_PREFIX = 'sha256$';

/** @param {string} token A raw bearer token. @returns {string} Its stored form. */
export function hashToken(token) {
  return TOKEN_HASH_PREFIX + crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Hash a value only if it isn't already hashed.
 *
 * A raw token and its digest are both 64 hex chars, so the prefix is the only way
 * to answer "is this already stored form?". That keeps the boot migration and the
 * backup/legacy import idempotent instead of silently double-hashing, which would
 * invalidate every session in the store.
 *
 * @param {unknown} value A raw token or an already-prefixed digest.
 * @returns {string} The stored form.
 */
export function toStoredToken(value) {
  const s = String(value ?? '');
  return s.startsWith(TOKEN_HASH_PREFIX) ? s : hashToken(s);
}

/**
 * Build the token-table accessors over the shared connection.
 *
 * Every exported function takes/returns RAW tokens; hashing happens inside. The
 * `import*` pair is the one exception — it accepts either form (see
 * `toStoredToken`) because it is fed by backup restores and the legacy JSON.
 *
 * @param {{ prepare: (sql: string) => any, transaction: (fn: any) => any }} db
 *   The shared better-sqlite3 connection (typed structurally, matching the
 *   loose-injection convention used elsewhere in lib/data).
 */
export function createTokenTables(db) {
  const q = {
    getSession: db.prepare('SELECT * FROM sessions WHERE token = ?'),
    insSession: db.prepare('INSERT OR REPLACE INTO sessions (token, user_id, exp) VALUES (?, ?, ?)'),
    delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    delSessionsForUser: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    delExpiredSessions: db.prepare('DELETE FROM sessions WHERE exp < ?'),
    delAllSessions: db.prepare('DELETE FROM sessions'),

    getReset: db.prepare('SELECT * FROM password_reset_tokens WHERE token = ?'),
    insReset: db.prepare('INSERT OR REPLACE INTO password_reset_tokens (token, user_id, exp) VALUES (?, ?, ?)'),
    delReset: db.prepare('DELETE FROM password_reset_tokens WHERE token = ?'),
    delExpiredResets: db.prepare('DELETE FROM password_reset_tokens WHERE exp < ?'),
    delResetsForUser: db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?'),
    delAllResets: db.prepare('DELETE FROM password_reset_tokens'),
  };

  // One-time hashing of rows written before this module existed. Rewrites them in
  // place, so users stay signed in: the cookie a browser already holds hashes to
  // the migrated row. Self-guarding via the prefix rather than a meta flag — rows
  // that are already digests are skipped, so it is safe on every open and safe to
  // re-run after a rollback and roll-forward.
  const migrateStoredTokens = db.transaction(() => {
    let migrated = 0;
    for (const table of ['sessions', 'password_reset_tokens']) {
      const stale = db.prepare(`SELECT token FROM ${table} WHERE token NOT LIKE ?`).all(`${TOKEN_HASH_PREFIX}%`);
      const upd = db.prepare(`UPDATE OR REPLACE ${table} SET token = ? WHERE token = ?`);
      for (const row of stale) {
        upd.run(hashToken(row.token), row.token);
        migrated += 1;
      }
    }
    return migrated;
  });

  return {
    migrateStoredTokens,

    putSession: (token, userId, exp) => q.insSession.run(hashToken(token), userId, exp),
    getSessionRow: (token) => q.getSession.get(hashToken(token)),
    dropSession: (token) => q.delSession.run(hashToken(token)),
    // Keyed by user_id, not a token, so there is nothing to hash: this is the
    // "sign me out everywhere" primitive a password reset needs.
    dropSessionsForUser: (userId) => q.delSessionsForUser.run(userId),
    pruneSessions: () => q.delExpiredSessions.run(Date.now()),
    clearSessions: () => q.delAllSessions.run(),
    importSession: (token, userId, exp) => q.insSession.run(toStoredToken(token), userId, exp),

    putReset: (token, userId, exp) => q.insReset.run(hashToken(token), userId, exp),
    getResetRow: (token) => q.getReset.get(hashToken(token)),
    dropReset: (token) => q.delReset.run(hashToken(token)),
    dropResetsForUser: (userId) => q.delResetsForUser.run(userId),
    pruneResets: () => q.delExpiredResets.run(Date.now()),
    clearResets: () => q.delAllResets.run(),
    importReset: (token, userId, exp) => q.insReset.run(toStoredToken(token), userId, exp),
  };
}
