/**
 * Stripe → Stagify: subscription lifecycle (called from POST /api/billing/stripe-webhook).
 * Configure STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET and register the URL in Stripe Dashboard.
 */

export function handleStripeEvent(event, authStore) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.mode !== 'subscription') {
        return { handled: true, detail: 'not_subscription' };
      }
      const subId =
        typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription && session.subscription.id;
      const custId =
        typeof session.customer === 'string'
          ? session.customer
          : session.customer && session.customer.id;
      const ref = session.client_reference_id || null;
      const email =
        session.customer_email ||
        (session.customer_details && session.customer_details.email) ||
        null;
      const result = authStore.activateProFromStripeCheckout({
        userId: ref,
        email,
        stripeCustomerId: custId,
        stripeSubscriptionId: subId,
      });
      if (!result.ok) {
        console.warn('[stripe] checkout.session.completed: could not map to user', {
          reason: result.reason,
          email: email ? '***' : null,
          ref,
        });
      } else {
        console.log('[stripe] Stagify+ activated for', result.email);
      }
      return { handled: true, result };
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const result = authStore.applyStripeSubscriptionState(sub);
      if (!result.ok) {
        console.warn('[stripe]', event.type, result.reason, sub && sub.id);
      }
      return { handled: true, result };
    }
    default:
      return { handled: false };
  }
}
