// Stripe → account linking: the two writes that decide which Stagify account a
// Stripe subscription belongs to, and what plan that account therefore has.
// Extracted from auth-store.js the same way pro-grants.js and trial-tracking.js
// were — it operates over the store's own record helpers and owns no state.
//
// Built by createStripeLinking() inside createAuthStore and spread into the store's
// public API, so callers still reach these through the store.

/**
 * Build the Stripe-linking actions over the auth-store's record helpers.
 * @param {{
 *   findUserById: (id: string) => any,
 *   findUserByEmail: (email: string) => any,
 *   saveUser: (user: any) => void,
 *   rowToUser: (row: any) => any,
 *   userRowByStripeSub: (subscriptionId: string) => any,
 *   userRowByStripeCust: (customerId: string) => any,
 * }} deps - The store's lookup/persist helpers, the row→user mapper, and the raw
 *   row accessors the subscription-state lookup needs.
 */
export function createStripeLinking({
  findUserById,
  findUserByEmail,
  saveUser,
  rowToUser,
  userRowByStripeSub,
  userRowByStripeCust,
}) {
  /**
   * Map a completed Stagify+ checkout onto an account and switch it to `pro`.
   *
   * Two identifiers can arrive, and they are NOT equally trustworthy. Both are
   * query parameters on a public Payment Link (`public/scripts/stagify-plus.js`
   * appends them), so a buyer can edit either — the difference is what it takes to
   * aim one at somebody else:
   *
   * - `client_reference_id` is a `u_` + 24 hex account id (96 bits). To target a
   *   specific victim you must already know their id, which nothing exposes.
   * - `customer_email` is whatever the buyer typed at Stripe. Stripe does not
   *   verify that they own it, and everyone's email is public knowledge.
   *
   * The email fallback still has to exist: the "Start free trial" button stays
   * clickable when signed out, so a checkout with no reference is an ordinary
   * purchase, and dropping the fallback would leave those buyers paying with no
   * plan. What it must not do is *reassign* an entitlement. Without the guard
   * below, checking out with a stranger's address rewrote their `stripeCustomerId`
   * / `stripeSubscriptionId`: their billing portal then opened the buyer's Stripe
   * customer, and cancelling the buyer's own trial fired
   * `customer.subscription.deleted` for a subscription id now recorded against the
   * victim — downgrading a paying customer who is still being billed, for the price
   * of a cancelled trial.
   *
   * So an email match may *start* a billing relationship and never replace one. A
   * refusal is a paid checkout that did not activate, so the caller logs it for
   * manual reconciliation rather than dropping it silently.
   *
   * @param {{ userId?: string | null, email?: string | null, stripeCustomerId?: string | null, stripeSubscriptionId?: string | null }} arg
   *   `userId` from `client_reference_id`, `email` from the Stripe session.
   * @returns {{ ok: true, userId: string, email: string, matchedBy: 'reference' | 'email' }
   *   | { ok: false, reason: 'no_user' | 'email_match_would_reassign' }} The mapping outcome.
   */
  function activateProFromStripeCheckout({ userId, email, stripeCustomerId, stripeSubscriptionId }) {
    const byReference = userId && typeof userId === 'string' ? findUserById(userId) : null;
    const byEmail = byReference || !email ? null : findUserByEmail(String(email).trim().toLowerCase());
    const user = byReference || byEmail;
    if (!user) {
      return { ok: false, reason: 'no_user' };
    }
    const matchedBy = byReference ? 'reference' : 'email';
    if (matchedBy === 'email') {
      // Anything already granting this account Stagify+ is something the new
      // subscription would take ownership of — and therefore something its buyer
      // could later revoke. A returning customer whose subscription was properly
      // cancelled has neither field set, so a genuine re-purchase still goes
      // through; only a live entitlement blocks.
      const incomingSub = stripeSubscriptionId ? String(stripeSubscriptionId) : null;
      const holdsSubscription = Boolean(user.stripeSubscriptionId) && user.stripeSubscriptionId !== incomingSub;
      const holdsGrant = Boolean(user.proGrantExpiresAt);
      if (holdsSubscription || holdsGrant) {
        return { ok: false, reason: 'email_match_would_reassign' };
      }
    }
    user.plan = 'pro';
    user.proGrantExpiresAt = null; // a real subscription supersedes any admin comp grant
    if (stripeCustomerId) user.stripeCustomerId = String(stripeCustomerId);
    if (stripeSubscriptionId) user.stripeSubscriptionId = String(stripeSubscriptionId);
    saveUser(user);
    return { ok: true, userId: user.id, email: user.email, matchedBy };
  }

  /**
   * Apply a Stripe subscription's current status to whichever account holds it.
   * Looked up by subscription id, falling back to customer id — both recorded by
   * the checkout above, so this never has to trust a payload field.
   * @param {any} subscription - The Stripe subscription object from the event.
   * @returns {{ ok: true, userId: string, plan: string } | { ok: false, reason: 'bad_payload' | 'no_user' }} The outcome.
   */
  function applyStripeSubscriptionState(subscription) {
    if (!subscription || typeof subscription !== 'object') {
      return { ok: false, reason: 'bad_payload' };
    }
    const subId = subscription.id;
    const customerRaw = subscription.customer;
    const customerId =
      typeof customerRaw === 'string' ? customerRaw : customerRaw && customerRaw.id ? customerRaw.id : null;
    const status = subscription.status;
    let user = subId ? rowToUser(userRowByStripeSub(subId)) : null;
    if (!user && customerId) {
      user = rowToUser(userRowByStripeCust(customerId));
    }
    if (!user) {
      return { ok: false, reason: 'no_user' };
    }
    const proStatuses = ['active', 'trialing', 'past_due'];
    if (proStatuses.includes(status)) {
      user.plan = 'pro';
      user.stripeSubscriptionId = subId;
      if (customerId) user.stripeCustomerId = customerId;
    } else {
      user.plan = 'free';
      if (user.stripeSubscriptionId === subId) {
        user.stripeSubscriptionId = null;
      }
    }
    saveUser(user);
    return { ok: true, userId: user.id, plan: user.plan };
  }

  return { activateProFromStripeCheckout, applyStripeSubscriptionState };
}
