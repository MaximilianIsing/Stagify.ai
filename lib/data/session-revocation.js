// "Sign this account out everywhere" — the operator-facing half of the session
// revocation `completePasswordReset` already performs.
//
// WHY IT IS A SEPARATE ACT FROM A PASSWORD RESET. A session token is a bearer
// credential: it outlives everything except its own expiry, so rotating the
// password hash alone leaves a thief signed in for up to SESSION_DAYS. The reset
// flow therefore drops every session in the same transaction as the new hash
// (auth-store.js#completePasswordReset). But the reverse case has no home: a
// shared laptop, a phone left in a taxi, a support call where the owner wants
// the other devices gone. Forcing a password reset for that locks the real owner
// out of an account they are still using, to solve a problem they do not have.
//
// WHY IT IS ITS OWN MODULE. Same reason pro-grants.js is: auth-store.js sits at
// an 800-line lint cap with two lines of headroom, and the repo's answer to that
// is a sibling that takes the store's primitives by injection rather than a
// raised ceiling.
//
// This deliberately does NOT touch password_reset_tokens. A live reset link is
// the account owner's way back in, and an operator signing out a stranger's
// devices must not also invalidate the mail the owner is holding.

/**
 * Build the revocation helper.
 *
 * Dependencies are passed in rather than imported so this module never opens the
 * database itself — the same loose-injection convention `createProGrants` uses.
 *
 * @param {{
 *   findUserById: (id: string) => any,
 *   dropSessionsForUser: (userId: string) => { changes?: number } | void,
 * }} deps
 * @returns {{ revokeUserSessions: (userId: string) => ({ok: true, userId: string, email: string, revoked: number} | {ok: false, error: string, code: string}) }}
 */
export function createSessionRevocation({ findUserById, dropSessionsForUser }) {
  /**
   * Drop every live session for one account, leaving the password alone.
   *
   * Reports how many sessions were actually dropped. That number is the only
   * feedback the operator gets that anything happened: a bare `ok` on an account
   * with no live session reads exactly like a successful revocation, and "did
   * that work?" is the whole question being asked.
   *
   * @param {string} userId - The account to sign out everywhere.
   * @returns {{ok: true, userId: string, email: string, revoked: number} | {ok: false, error: string, code: string}}
   */
  function revokeUserSessions(userId) {
    const id = String(userId || '').trim();
    if (!id) return { ok: false, error: 'A userId is required', code: 'NO_IDENTIFIER' };
    const user = findUserById(id);
    if (!user) return { ok: false, error: 'No such user', code: 'NOT_FOUND' };
    const info = dropSessionsForUser(user.id);
    return {
      ok: true,
      userId: user.id,
      email: user.email,
      revoked: Number(info && info.changes) || 0,
    };
  }

  return { revokeUserSessions };
}
