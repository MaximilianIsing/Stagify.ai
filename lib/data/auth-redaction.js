// The two shapes the auth store can be read out in, kept side by side on purpose.
//
//   exportStore()    — EVERYTHING, credentials included. Backup / restore only.
//   exportRedacted() — what a browser may see. Serve this, always.
//
// They used to live inside auth-store.js, where `GET /authstore` picked the wrong
// one: it shipped every password hash, every live session token, and every
// outstanding password-reset token to the admin dashboard, which rendered none of
// them. One leaked endpoint key was therefore full account takeover for every
// user. Splitting them out makes the choice a deliberate one. See
// docs/guides/security.md.

/**
 * The ONLY user fields `GET /authstore` may return — every field the admin UI
 * actually renders, and nothing else.
 *
 * Deliberately an **allowlist**, not a "delete the password fields" denylist:
 * `rowToUser` spreads `extra_json` over its result, so any future field parked
 * there (a trial token, an OAuth refresh token, …) would ride along to the
 * browser automatically under a denylist. A new admin panel that needs another
 * column adds it here on purpose. Credentials are absent by construction.
 */
export const ADMIN_VISIBLE_USER_KEYS = [
  'id', 'email', 'plan', 'createdAt', 'usageDay', 'usageCount', 'googleSub',
  'stripeCustomerId', 'stripeSubscriptionId', 'proPassGrantedAt',
  'proGrantedAt', 'proGrantExpiresAt',
];

/**
 * Project a full user record down to the admin-visible fields.
 * Absent keys stay absent (rather than becoming explicit `undefined`) so the
 * payload matches the shape the dashboard already handled.
 *
 * @param {Record<string, any>} user A full user object, e.g. from `rowToUser`.
 * @returns {Record<string, any>} A credential-free copy.
 */
export function redactUser(user) {
  const safe = {};
  for (const k of ADMIN_VISIBLE_USER_KEYS) {
    if (user[k] !== undefined) safe[k] = user[k];
  }
  return safe;
}

/**
 * Build the store's two read-out functions.
 *
 * `db` is typed structurally (just the `prepare().all()` we use) rather than as
 * `better-sqlite3`'s `Database`, whose `.all()` is `unknown[]` — same
 * loose-injection convention as the other injected clients in this repo.
 *
 * @param {{
 *   db: { prepare: (sql: string) => { all: () => any[] } },
 *   allUserRows: () => any[],
 *   rowToUser: (row: any) => any,
 * }} deps The shared connection, plus the store's user-row reader/mapper.
 */
export function createAuthExport({ db, allUserRows, rowToUser }) {
  // Reconstructs the exact shape the old auth-store.json used, so a rollback
  // re-import is 1:1 with importStore().
  //
  // DANGER: the result contains password hashes + salts, every live session
  // token keyed to its user, every outstanding password-reset token, and
  // pending-registration hashes. The tokens are bearer credentials — no cracking
  // required. Never send this over HTTP; the backup path is the SQLite file
  // itself (Litestream → R2).
  function exportStore() {
    const users = allUserRows().map(rowToUser);
    const sessions = {};
    for (const r of db.prepare('SELECT * FROM sessions').all()) {
      sessions[r.token] = { userId: r.user_id, exp: r.exp };
    }
    const mobileIpUsage = {};
    for (const r of db.prepare('SELECT * FROM mobile_ip_usage').all()) {
      mobileIpUsage[r.ip] = { day: r.day, count: r.count };
    }
    const passwordResetTokens = {};
    for (const r of db.prepare('SELECT * FROM password_reset_tokens').all()) {
      passwordResetTokens[r.token] = { userId: r.user_id, exp: r.exp };
    }
    const pendingRegistrations = {};
    for (const r of db.prepare('SELECT * FROM pending_registrations').all()) {
      pendingRegistrations[r.email] = {
        passwordSalt: r.password_salt,
        passwordHash: r.password_hash,
        codeSalt: r.code_salt,
        codeHash: r.code_hash,
        attempts: r.attempts,
        exp: r.exp,
      };
    }
    return { users, sessions, mobileIpUsage, passwordResetTokens, pendingRegistrations };
  }

  // The browser-facing view: the same accounts, no credentials, and none of the
  // token tables at all. This is what GET /authstore serves.
  function exportRedacted() {
    return { users: allUserRows().map((row) => redactUser(rowToUser(row))) };
  }

  return { exportStore, exportRedacted };
}
