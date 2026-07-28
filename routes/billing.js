// Billing & enterprise routes: Stripe webhook, customer portal, enterprise
// config + checkout. Extracted from server.js.
//
// Mounted BEFORE the global express.json (see server.js) so the Stripe webhook
// can read the RAW request body for signature verification. The other routes
// carry their own inline express.json.
import express from 'express';
import { createAsyncRouter } from '../lib/http/async-router.js';
import { sendError } from '../lib/http/http-helpers.js';
import { reportError } from '../lib/http/error-ref.js';
import { checkoutLimiter as defaultCheckoutLimiter } from '../lib/http/rate-limiters.js';
import { logger } from '../lib/logger.js';
import {
  isPublicEmailDomain,
  PUBLIC_EMAIL_DOMAIN_CODE,
  PUBLIC_EMAIL_DOMAIN_MESSAGE,
} from '../lib/data/public-email-domains.js';

/**
 * Build the billing & enterprise router (Stripe webhook, customer portal,
 * enterprise config + checkout). `deps` is the injection bag from server.js.
 *
 * @param {{
 *   stripe: any,
 *   stripeWebhookSecret: string,
 *   stripePublishableKey: string,
 *   enterprisePriceId: string,
 *   authStore: any,
 *   enterpriseStore: any,
 *   handleStripeEvent: typeof import('../lib/services/stripe-webhooks.js').handleStripeEvent,
 *   getAuthUserFromRequest: (req: import('express').Request) => any,
 *   trialLifecycle?: ReturnType<typeof import('../lib/services/trial-lifecycle.js').createTrialLifecycle>,
 *   stripeEvents?: ReturnType<typeof import('../lib/data/stripe-events.js').createStripeEventLog>,
 *   checkoutLimiter?: import('express').RequestHandler,
 * }} deps - Injected Stripe client + config strings, the auth/enterprise stores,
 *   the webhook event handler, the session-user resolver, the trial-email
 *   lifecycle (fires welcome/ending/win-back off Stripe events), and the
 *   webhook-idempotency ledger (`stripeEvents`; omitted = no dedup, every
 *   delivery handled).
 *   `checkoutLimiter` is a test seam only: omitted (or null) it falls back to the
 *   shared `checkoutLimiter`, so the enterprise checkout is never mounted unlimited.
 */
export default function createBillingRouter(deps) {
  const {
    stripe,
    stripeWebhookSecret,
    stripePublishableKey,
    enterprisePriceId,
    authStore,
    enterpriseStore,
    handleStripeEvent,
    getAuthUserFromRequest,
    trialLifecycle,
    stripeEvents,
    checkoutLimiter,
  } = deps;

  // `??` so an explicit null (a test asking for the production wiring) still gets
  // the real limiter; only a deliberately injected middleware replaces it.
  const enterpriseCheckoutLimiter = checkoutLimiter ?? defaultCheckoutLimiter;

  const router = createAsyncRouter();

  // Stripe webhooks must use the raw body for signature verification.
  router.post('/api/billing/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!stripe || !stripeWebhookSecret) {
      logger.warn(
        '[stripe] Webhook ignored: add stripe_secret_key.txt + stripe_webhook_secret.txt (searched: STRIPE_SECRETS_DIR, server dir, cwd, /etc/secrets) or set STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET',
      );
      return res.status(503).send('Stripe billing not configured');
    }
    const sig = req.headers['stripe-signature'];
    if (!sig) {
      return res.status(400).send('Missing stripe-signature');
    }
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
    } catch (err) {
      // Stripe's own sample code echoes err.message back, but this endpoint is
      // public: the message distinguishes "no matching signature" from "timestamp
      // outside the tolerance zone", which tells a forger which half to fix.
      const ref = reportError('stripe.webhook-signature', err);
      return res.status(400).send(`Webhook Error (ref ${ref})`);
    }
    // Idempotency gate. Stripe delivers at-least-once (it retries anything that
    // did not answer 2xx, and can duplicate on its own), so an event is claimed
    // here before it is handled: a redelivery of something already handled is
    // acked and dropped. The claim is released on failure so Stripe's retry of a
    // genuinely-failed event still runs. See lib/data/stripe-events.js.
    const claim = stripeEvents ? stripeEvents.claim(event) : { fresh: true, reason: 'untracked' };
    if (!claim.fresh) {
      logger.info('[stripe] Duplicate webhook ignored:', event.id, event.type, `(${claim.reason})`);
      return res.json({ received: true, duplicate: true });
    }
    try {
      const out = await handleStripeEvent(event, authStore, { stripe, enterpriseStore, lifecycle: trialLifecycle });
      if (!out.handled) {
        logger.info('[stripe] Unhandled event type (ok):', event.type);
      }
      if (stripeEvents) stripeEvents.markDone(event.id);
      res.json({ received: true });
    } catch (e) {
      // Hand the event back before answering 500, or the retry Stripe is about to
      // send would be deduped against this failed attempt and never processed.
      if (stripeEvents) stripeEvents.release(event.id);
      logger.error('[stripe] Webhook handler error:', e);
      sendError(res, 500, 'Webhook handler failed');
    }
  });

  router.post('/api/billing/customer-portal', express.json(), async (req, res) => {
    try {
      if (!stripe) {
        return sendError(res, 503, 'Billing not configured', { code: 'STRIPE_DISABLED' });
      }
      const user = getAuthUserFromRequest(req);
      if (!user) {
        return sendError(res, 401, 'Sign in required', { code: 'AUTH_REQUIRED' });
      }
      if (!user.stripeCustomerId) {
        return sendError(
          res,
          400,
          'No billing profile on this account. If you subscribed with another email, sign in with that address or contact support.',
          { code: 'NO_STRIPE_CUSTOMER' },
        );
      }
      const baseUrlRaw =
        process.env.PUBLIC_APP_URL || process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
      const baseUrl = String(baseUrlRaw).replace(/\/$/, '');
      const returnUrl = `${baseUrl}/stagify-plus.html`;
      const session = await stripe.billingPortal.sessions.create({
        customer: user.stripeCustomerId,
        return_url: returnUrl,
      });
      return res.json({ url: session.url });
    } catch (e) {
      logger.error('[stripe] customer portal error:', e.message);
      return sendError(res, 500, 'Could not open billing portal');
    }
  });

  router.get('/api/enterprise/config', (req, res) => {
    res.json({ publishableKey: stripePublishableKey || '' });
  });

  // Deliberately unauthenticated: a company buys the enterprise plan before anyone
  // on it has an account, so there is no session to require. The limiter runs BEFORE
  // express.json so an over-ceiling caller never gets a body parsed either.
  router.post('/api/enterprise/create-checkout', enterpriseCheckoutLimiter, express.json(), async (req, res) => {
    try {
      if (!stripe) {
        return sendError(res, 503, 'Billing not configured', { code: 'STRIPE_DISABLED' });
      }
      if (!enterprisePriceId) {
        return sendError(res, 503, 'Enterprise pricing not configured');
      }
      const { domain, companyName, contactEmail, contactPhone } = req.body || {};
      if (!domain || typeof domain !== 'string' || !domain.includes('.')) {
        return sendError(res, 400, 'A valid domain is required (e.g. company.com)');
      }
      const cleanDomain = domain.trim().toLowerCase().replace(/^@/, '');
      // An enterprise domain is a blanket grant to every address under it, so a
      // public mailbox provider is never a legitimate purchase. Rejected before
      // Stripe is involved; the browser localizes the `code`.
      if (isPublicEmailDomain(cleanDomain)) {
        return sendError(res, 400, PUBLIC_EMAIL_DOMAIN_MESSAGE, { code: PUBLIC_EMAIL_DOMAIN_CODE });
      }
      if (!contactEmail || typeof contactEmail !== 'string' || !contactEmail.includes('@')) {
        return sendError(res, 400, 'A valid contact email is required');
      }
      if (!companyName || typeof companyName !== 'string' || !companyName.trim()) {
        return sendError(res, 400, 'Company name is required');
      }

      const existing = enterpriseStore.getDomainEntry(cleanDomain);
      if (existing && (existing.status === 'active' || existing.status === 'trialing')) {
        // Worded so it does not confirm to an anonymous caller that this specific
        // company is a customer — the route is public, so the old "already has an
        // active enterprise plan" text made it a lookup service for our customer
        // list. The branch is still distinguishable from a success; what actually
        // bounds the probing is checkoutLimiter above.
        return sendError(
          res,
          409,
          'This domain is not available for self-serve checkout. Please contact support@stagify.ai to get set up.',
        );
      }

      const baseUrlRaw =
        process.env.PUBLIC_APP_URL || process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
      const baseUrl = String(baseUrlRaw).replace(/\/$/, '');

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        customer_email: contactEmail.trim(),
        line_items: [
          {
            price: enterprisePriceId,
          },
        ],
        subscription_data: {
          metadata: {
            enterprise_domain: cleanDomain,
            enterprise_company: companyName.trim(),
            enterprise_contact_email: contactEmail.trim(),
            enterprise_contact_phone: (contactPhone || '').trim(),
          },
        },
        metadata: {
          enterprise_domain: cleanDomain,
          enterprise_company: companyName.trim(),
          enterprise_contact_email: contactEmail.trim(),
          enterprise_contact_phone: (contactPhone || '').trim(),
        },
        success_url: `${baseUrl}/enterprise.html?success=1&domain=${encodeURIComponent(cleanDomain)}`,
        cancel_url: `${baseUrl}/enterprise.html?cancelled=1`,
      });

      return res.json({ url: session.url });
    } catch (e) {
      logger.error('[enterprise] checkout session error:', e.message);
      return sendError(res, 500, 'Could not create checkout session');
    }
  });

  return router;
}
