// Billing & enterprise routes: Stripe webhook, customer portal, enterprise
// config + checkout. Extracted from server.js.
//
// Mounted BEFORE the global express.json (see server.js) so the Stripe webhook
// can read the RAW request body for signature verification. The other routes
// carry their own inline express.json.
import express from 'express';
import { createAsyncRouter } from '../lib/http/async-router.js';
import { sendError } from '../lib/http/http-helpers.js';
import { logger } from '../lib/logger.js';

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
  } = deps;

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
      logger.error('[stripe] Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    try {
      const out = await handleStripeEvent(event, authStore, { stripe, enterpriseStore });
      if (!out.handled) {
        logger.info('[stripe] Unhandled event type (ok):', event.type);
      }
      res.json({ received: true });
    } catch (e) {
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

  router.post('/api/enterprise/create-checkout', express.json(), async (req, res) => {
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
      if (!contactEmail || typeof contactEmail !== 'string' || !contactEmail.includes('@')) {
        return sendError(res, 400, 'A valid contact email is required');
      }
      if (!companyName || typeof companyName !== 'string' || !companyName.trim()) {
        return sendError(res, 400, 'Company name is required');
      }

      const existing = enterpriseStore.getDomainEntry(cleanDomain);
      if (existing && (existing.status === 'active' || existing.status === 'trialing')) {
        return sendError(res, 409, 'This domain already has an active enterprise plan');
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
