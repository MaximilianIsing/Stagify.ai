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
  // Trial/paid activity. `plan` collapses trialing, active and past_due into 'pro',
  // so without these the dashboard could not tell a trial from a subscription, see
  // how many trials were running, or tell whether a trial user had used the product
  // at all — the exact question the lifecycle emails branch on.
  'lifetimeStaged', 'lastStagedAt',
];

/**
 * The only keys copied out of `trialLifecycle`.
 *
 * A second allowlist rather than putting `trialLifecycle` in the list above,
 * for the reason that list documents: it is a bag inside `extra_json`, so shipping
 * it wholesale would auto-export whatever a future feature parks in it. `sent` is
 * flattened to booleans — the operator needs to know WHICH lifecycle mails went out,
 * not to receive a growing object verbatim.
 */
export const ADMIN_VISIBLE_TRIAL_EMAILS = ['welcome', 'activation', 'value', 'ending', 'canceled'];

/**
 * Project the trial-lifecycle bag down to a fixed, flat shape.
 * @param {any} tl - The raw `trialLifecycle` value, if any.
 * @returns {{ startAt: string|null, sent: Record<string, string|null> } | undefined}
 */
function redactTrialLifecycle(tl) {
  if (!tl || typeof tl !== 'object') return undefined;
  const sentIn = tl.sent && typeof tl.sent === 'object' ? tl.sent : {};
  /** @type {Record<string, string|null>} */
  const sent = {};
  for (const key of ADMIN_VISIBLE_TRIAL_EMAILS) {
    sent[key] = typeof sentIn[key] === 'string' ? sentIn[key] : null;
  }
  return { startAt: typeof tl.startAt === 'string' ? tl.startAt : null, sent };
}

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
  const trial = redactTrialLifecycle(user.trialLifecycle);
  if (trial) safe.trialLifecycle = trial;
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
  // DANGER: the result contains password hashes + salts, pending-registration
  // hashes, and a row per live session / outstanding reset token keyed to its
  // user. The token keys are SHA-256 digests, not the bearer values (see
  // hashToken in auth-store.js), so this payload no longer hands over accounts on
  // its own — but it is still every credential the system has, and the digests
  // still map sessions to users. Never send it over HTTP; the backup path is the
  // SQLite file itself (Litestream → R2).
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
