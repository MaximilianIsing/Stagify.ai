/**
 * Stripe → Stagify: subscription lifecycle (called from POST /api/billing/stripe-webhook).
 * Configure STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET and register the URL in Stripe Dashboard.
 */

export function handleStripeEvent(event, authStore, { stripe, enterpriseStore } = {}) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.mode !== 'subscription') {
        return { handled: true, detail: 'not_subscription' };
      }

      const meta = session.metadata || {};
      if (meta.enterprise_domain) {
        return handleEnterpriseCheckoutCompleted(session, { stripe, enterpriseStore });
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

      if (enterpriseStore) {
        const entResult = enterpriseStore.applySubscriptionState(sub);
        if (entResult.ok) {
          console.log('[stripe] Enterprise domain', entResult.domain, '→', entResult.status);
          return { handled: true, result: entResult };
        }
      }

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

async function handleEnterpriseCheckoutCompleted(session, { stripe, enterpriseStore }) {
  const meta = session.metadata || {};
  const domain = meta.enterprise_domain;
  const companyName = meta.enterprise_company || '';
  const contactEmail = meta.enterprise_contact_email || '';
  const contactPhone = meta.enterprise_contact_phone || '';

  const subId =
    typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription?.id;
  const custId =
    typeof session.customer === 'string'
      ? session.customer
      : session.customer?.id;

  let subscriptionItemId = '';
  if (stripe && subId) {
    try {
      const sub = await stripe.subscriptions.retrieve(subId);
      if (sub.items && sub.items.data && sub.items.data.length > 0) {
        subscriptionItemId = sub.items.data[0].id;
      }
    } catch (e) {
      console.error('[stripe] Could not fetch subscription items for enterprise:', e.message);
    }
  }

  if (!enterpriseStore) {
    console.warn('[stripe] Enterprise store not available, cannot activate domain:', domain);
    return { handled: true, result: { ok: false, reason: 'no_enterprise_store' } };
  }

  const result = enterpriseStore.activateDomain({
    domain,
    companyName,
    contactEmail,
    contactPhone,
    stripeCustomerId: custId,
    stripeSubscriptionId: subId,
    stripeSubscriptionItemId: subscriptionItemId,
  });

  if (result.ok) {
    console.log('[stripe] Enterprise domain activated:', domain, '(' + companyName + ')');
  } else {
    console.warn('[stripe] Enterprise activation failed for domain:', domain);
  }
  return { handled: true, result };
}
