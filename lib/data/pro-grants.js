// Admin comp grants: one calendar month of Stagify+ handed out from the admin
// dashboard, with NO Stripe subscription behind it — no card, no invoice, no
// webhook. A grant is just two fields on the user record (proGrantedAt /
// proGrantExpiresAt) alongside plan: 'pro'.
//
// Expiry is enforced on every READ, not by a sweep job: applyGrantExpiry() is
// called from the auth-store's rowToUser, so the moment the expiry passes, the
// account reads as free everywhere at once (sessions, API guards, admin export)
// and the row self-heals to plan:'free' the next time it is saved.
//
// Both fields ride in the users table's extra_json blob — they are deliberately
// NOT in KNOWN_USER_KEYS — so this needs no schema migration on the live DB.

/**
 * One calendar month after `from`, clamped to the last day of the target month
 * so Jan 31 lands on Feb 28 rather than overflowing into March the way a bare
 * setUTCMonth(+1) would.
 *
 * @param {Date} from
 * @returns {Date}
 */
export function oneMonthFrom(from) {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + 1);
  if (d.getUTCDate() < day) d.setUTCDate(0); // rolled into the next month → step back
  return d;
}

/**
 * True while a comp grant is still running.
 *
 * @param {any} user
 * @param {number} [now] Epoch ms; injectable so tests don't have to wait a month.
 */
export function isGrantActive(user, now = Date.now()) {
  if (!user || !user.proGrantExpiresAt) return false;
  const exp = Date.parse(user.proGrantExpiresAt);
  return Number.isFinite(exp) && exp > now;
}

/**
 * Downgrade a lapsed comp grant, in place. A real Stripe subscription always
 * wins and is never expired here — only grant-backed pro access can lapse.
 *
 * @param {any} user
 * @param {number} [now] Epoch ms.
 * @returns {any} The same object, for use as a tail call.
 */
export function applyGrantExpiry(user, now = Date.now()) {
  if (
    user &&
    user.plan === 'pro' &&
    user.proGrantExpiresAt &&
    !user.stripeSubscriptionId &&
    !isGrantActive(user, now)
  ) {
    user.plan = 'free';
  }
  return user;
}

/**
 * Build the grant/revoke actions over the auth-store's own record helpers.
 *
 * @param {{
 *   findUserById: (id: string) => any,
 *   findUserByEmail: (email: string) => any,
 *   saveUser: (user: any) => void,
 * }} deps - The auth-store's record lookup + persist helpers.
 */
export function createProGrants({ findUserById, findUserByEmail, saveUser }) {
  /**
   * Give a currently-free account one month of Stagify+. Refuses anyone who
   * already has pro (comp or paid) so a grant can never shorten or overwrite
   * access that already exists.
   *
   * @param {{ userId?: string, email?: string }} target
   */
  function grantProMonth({ userId, email } = {}) {
    let user = null;
    if (userId && typeof userId === 'string') user = findUserById(userId);
    if (!user && email) user = findUserByEmail(email);
    if (!user) return { ok: false, error: 'No account found for that user.' };
    if (user.stripeSubscriptionId) {
      return { ok: false, error: 'This account has a Stripe subscription — manage it in Stripe instead.' };
    }
    if (user.plan === 'pro') {
      return { ok: false, error: 'This account already has Stagify+.' };
    }
    const now = new Date();
    user.plan = 'pro';
    user.proGrantedAt = now.toISOString();
    user.proGrantExpiresAt = oneMonthFrom(now).toISOString();
    saveUser(user);
    return { ok: true, userId: user.id, email: user.email, expiresAt: user.proGrantExpiresAt };
  }

  /**
   * End a running grant early. Only ever touches grant-backed access — a paying
   * subscriber has to be cancelled in Stripe.
   *
   * @param {string} userId
   */
  function revokeProGrant(userId) {
    const user = userId ? findUserById(userId) : null;
    if (!user) return { ok: false, error: 'No account found for that user.' };
    if (user.stripeSubscriptionId) {
      return { ok: false, error: 'This account is on a Stripe subscription — cancel it in Stripe.' };
    }
    if (!isGrantActive(user)) {
      return { ok: false, error: 'This account has no active grant to revoke.' };
    }
    user.plan = 'free';
    user.proGrantExpiresAt = null;
    user.proGrantRevokedAt = new Date().toISOString();
    saveUser(user);
    return { ok: true, userId: user.id, email: user.email };
  }

  return { grantProMonth, revokeProGrant };
}
