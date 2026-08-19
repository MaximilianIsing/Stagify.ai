/**
 * Stripe → Stagify: subscription lifecycle (called from POST /api/billing/stripe-webhook).
 * Configure STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET and register the URL in Stripe Dashboard.
 */

import { logger } from '../logger.js';

export async function handleStripeEvent(
  event,
  authStore,
  { stripe, enterpriseStore, lifecycle, creditTopup } = /** @type {{ stripe?: any, enterpriseStore?: any, lifecycle?: any, creditTopup?: any }} */ ({}),
) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      // API credit packs are one-time `payment` sessions, so they arrive on the branch
      // that used to be a blanket "not a subscription, ignore". The `result` is handed
      // back verbatim: routes/billing.js reads `result.ok === false` and RELEASES the
      // event id, which is what keeps Stripe's "Resend event" working after an
      // operator fixes a mapping. See lib/services/stripe-credit-topup.js.
      if (creditTopup && creditTopup.isCreditSession(session)) {
        return { handled: true, result: creditTopup.handleCreditTopup(session) };
      }
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
      if (result.reason === 'email_match_would_reassign') {
        // Money came in and nobody got a plan, so this needs a human — but it is
        // also the signature of someone checking out with another person's address,
        // so it is deliberately louder than a plain unmapped checkout. The Stripe
        // ids are safe to log and are what the operator reconciles from; the typed
        // email is not ours to record here.
        logger.error(
          '[stripe] checkout.session.completed: refused to reassign an existing entitlement from an unverified email — reconcile manually',
          { subscription: subId || null, customer: custId || null },
        );
      } else if (!result.ok) {
        logger.warn('[stripe] checkout.session.completed: could not map to user', {
          reason: result.reason,
          email: email ? '***' : null,
          ref,
        });
      } else {
        logger.info('[stripe] Stagify+ activated for', result.email, `(matched by ${result.matchedBy})`);
        // Kick off the trial-email sequence (welcome). Best-effort: never let a
        // mail failure fail the webhook (Stripe would retry the whole event).
        if (lifecycle && typeof lifecycle.onTrialCheckout === 'function') {
          await runLifecycle(() => lifecycle.onTrialCheckout({ userId: result.userId, email: result.email }));
        }
      }
      return { handled: true, result };
    }
    case 'customer.subscription.trial_will_end': {
      // Stripe fires this ~3 days before a trial converts. It does NOT change the
      // plan (still trialing) — it only triggers the trial-ending reminder email.
      const sub = event.data.object;
      if (lifecycle && typeof lifecycle.onTrialWillEnd === 'function') {
        await runLifecycle(() => lifecycle.onTrialWillEnd({ subscription: sub }));
      }
      return { handled: true };
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object;

      if (enterpriseStore) {
        const entResult = enterpriseStore.applySubscriptionState(sub);
        if (entResult.ok) {
          logger.info('[stripe] Enterprise domain', entResult.domain, '→', entResult.status);
          return { handled: true, result: entResult };
        }
        // A stale terminal event for a REPLACED enterprise subscription was matched
        // and deliberately ignored — that is a handled outcome, not a miss. Returning
        // here rather than falling through matters: the per-user path below would look
        // the enterprise CUSTOMER id up against the users table and warn 'no_user',
        // which reads as an unmapped subscription and hides what actually happened.
        if (entResult.reason === 'stale_subscription') {
          logger.warn(
            '[stripe]', event.type,
            'ignored a terminal status for a subscription this domain no longer holds',
            sub && sub.id,
          );
          return { handled: true, result: entResult };
        }
      }

      const result = authStore.applyStripeSubscriptionState(sub);
      if (!result.ok) {
        logger.warn('[stripe]', event.type, result.reason, sub && sub.id);
      }
      // Win-back email only when access actually ends (deleted), not on every
      // mid-life update. Only for real user subscriptions (enterprise returned above).
      if (
        event.type === 'customer.subscription.deleted' &&
        result.ok &&
        lifecycle &&
        typeof lifecycle.onSubscriptionCanceled === 'function'
      ) {
        await runLifecycle(() => lifecycle.onSubscriptionCanceled({ subscription: sub }));
      }
      return { handled: true, result };
    }
    // Money going back out. Without these, spend-then-chargeback is a free render:
    // the credits were already consumed and the payment is reversed.
    case 'charge.refunded':
    case 'charge.dispute.created': {
      if (!creditTopup) return { handled: false };
      return { handled: true, result: creditTopup.handleCreditClawback(event.data.object) };
    }
    default:
      return { handled: false };
  }
}

/**
 * Run a best-effort lifecycle side-effect (email send). Swallows and logs any
 * error so a mail outage can never turn a Stripe webhook into a non-2xx response
 * (which would make Stripe retry the event indefinitely).
 * @param {() => Promise<any>} fn - The lifecycle call to attempt.
 * @returns {Promise<void>}
 */
async function runLifecycle(fn) {
  try {
    await fn();
  } catch (err) {
    logger.error('[stripe] trial-lifecycle side-effect failed:', err && err.message ? err.message : err);
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
      logger.error('[stripe] Could not fetch subscription items for enterprise:', e.message);
    }
  }

  if (!enterpriseStore) {
    logger.warn('[stripe] Enterprise store not available, cannot activate domain:', domain);
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
    logger.info('[stripe] Enterprise domain activated:', domain, '(' + companyName + ')');
  } else {
    logger.warn('[stripe] Enterprise activation failed for domain:', domain);
  }
  return { handled: true, result };
}
