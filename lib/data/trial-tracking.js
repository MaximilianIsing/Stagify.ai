// Trial-lifecycle tracking — the state behind the trial-email sequence (welcome,
// activation nudge, value, ending, win-back). Extracted from auth-store.js the
// same way pro-grants.js is: it operates over the store's own record helpers, and
// all of its state rides in the users table's extra_json blob (trialLifecycle +
// lastStagedAt / lifetimeStaged), so there is no schema migration.
//
// Built by createTrialTracking() inside createAuthStore and spread into the
// store's public API.

/**
 * Build the trial-tracking actions over the auth-store's record helpers.
 * @param {{
 *   findUserById: (id: string) => any,
 *   saveUser: (user: any) => void,
 *   rowToUser: (row: any) => any,
 *   allUserRows: () => any[],
 *   userRowByStripeSub: (subscriptionId: string) => any,
 *   userRowByStripeCust: (customerId: string) => any,
 * }} deps - The store's lookup/persist helpers, the row→user mapper, and the raw
 *   row accessors the sweep + webhook lookups need.
 */
export function createTrialTracking({
  findUserById,
  saveUser,
  rowToUser,
  allUserRows,
  userRowByStripeSub,
  userRowByStripeCust,
}) {
  /**
   * Start tracking a user's trial. Idempotent: if tracking already exists (a
   * returning subscriber, or a duplicate webhook), the original startAt and any
   * sent-email flags are preserved.
   * @param {string} userId - The user to track.
   * @param {string} [startAtISO] - Trial start timestamp (defaults to now).
   * @returns {any | null} The (possibly updated) user, or null if not found.
   */
  function beginTrial(userId, startAtISO) {
    const user = findUserById(userId);
    if (!user) return null;
    const existing = user.trialLifecycle;
    if (existing && typeof existing === 'object' && existing.startAt) return user;
    user.trialLifecycle = { startAt: startAtISO || new Date().toISOString(), sent: {} };
    saveUser(user);
    return user;
  }

  /**
   * Record that a lifecycle email was sent, so it is never sent again.
   * @param {string} userId - The user emailed.
   * @param {string} key - Which email (welcome|activation|value|ending|canceled).
   * @returns {any | null} The updated user, or null if not found.
   */
  function markTrialEmailSent(userId, key) {
    const user = findUserById(userId);
    if (!user) return null;
    const tl =
      user.trialLifecycle && typeof user.trialLifecycle === 'object'
        ? user.trialLifecycle
        : { startAt: new Date().toISOString(), sent: {} };
    tl.sent = tl.sent && typeof tl.sent === 'object' ? tl.sent : {};
    tl.sent[key] = new Date().toISOString();
    user.trialLifecycle = tl;
    saveUser(user);
    return user;
  }

  /**
   * Bump a user's lifetime staging count + last-staged timestamp. Called once per
   * successful authenticated staging; it is the signal the activation nudge uses to
   * tell "signed up but never staged" from "actively using it".
   * @param {string} userId - The user who just staged.
   * @returns {any | null} The updated user, or null if not found.
   */
  function recordStagingActivity(userId) {
    const user = findUserById(userId);
    if (!user) return null;
    user.lifetimeStaged = (Number.isFinite(user.lifetimeStaged) ? user.lifetimeStaged : 0) + 1;
    user.lastStagedAt = new Date().toISOString();
    saveUser(user);
    return user;
  }

  /**
   * Every trial-tracked pro user, reduced to just the fields the sweep needs (no
   * password hashes). Small result set by design — only users mid-trial-lifecycle.
   * @returns {Array<{ id: string, email: string, plan: string, stripeSubscriptionId: string | null, trialLifecycle: any, lastStagedAt: string | null, lifetimeStaged: number }>}
   */
  function listTrialCandidates() {
    return allUserRows()
      .map(rowToUser)
      .filter((u) => u && u.plan === 'pro' && u.trialLifecycle && u.trialLifecycle.startAt)
      .map((u) => ({
        id: u.id,
        email: u.email,
        plan: u.plan,
        stripeSubscriptionId: u.stripeSubscriptionId || null,
        trialLifecycle: u.trialLifecycle,
        lastStagedAt: u.lastStagedAt || null,
        lifetimeStaged: Number.isFinite(u.lifetimeStaged) ? u.lifetimeStaged : 0,
      }));
  }

  /**
   * Look up a user by Stripe subscription id (preferred) or customer id.
   * @param {{ subscriptionId?: string | null, customerId?: string | null }} ids - Stripe identifiers.
   * @returns {any | null} The matching user, or null.
   */
  function findUserByStripeIds({ subscriptionId, customerId } = {}) {
    let user = subscriptionId ? rowToUser(userRowByStripeSub(subscriptionId)) : null;
    if (!user && customerId) user = rowToUser(userRowByStripeCust(customerId));
    return user;
  }

  return { beginTrial, markTrialEmailSent, recordStagingActivity, listTrialCandidates, findUserByStripeIds };
}
