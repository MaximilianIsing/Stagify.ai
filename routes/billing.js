// Billing & enterprise routes: Stripe webhook, customer portal, enterprise
// config + checkout. Extracted from server.js.
//
// Mounted BEFORE the global express.json (see server.js) so the Stripe webhook
// can read the RAW request body for signature verification. The other routes
// carry their own inline express.json.
import express from 'express';

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

  const router = express.Router();

  // Stripe webhooks must use the raw body for signature verification.
  router.post('/api/billing/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!stripe || !stripeWebhookSecret) {
      console.warn(
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
      console.error('[stripe] Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    try {
      const out = await handleStripeEvent(event, authStore, { stripe, enterpriseStore });
      if (!out.handled) {
        console.log('[stripe] Unhandled event type (ok):', event.type);
      }
      res.json({ received: true });
    } catch (e) {
      console.error('[stripe] Webhook handler error:', e);
      res.status(500).json({ error: 'Webhook handler failed' });
    }
  });

  router.post('/api/billing/customer-portal', express.json(), async (req, res) => {
    try {
      if (!stripe) {
        return res.status(503).json({ error: 'Billing not configured', code: 'STRIPE_DISABLED' });
      }
      const user = getAuthUserFromRequest(req);
      if (!user) {
        return res.status(401).json({ error: 'Sign in required', code: 'AUTH_REQUIRED' });
      }
      if (!user.stripeCustomerId) {
        return res.status(400).json({
          error:
            'No billing profile on this account. If you subscribed with another email, sign in with that address or contact support.',
          code: 'NO_STRIPE_CUSTOMER',
        });
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
      console.error('[stripe] customer portal error:', e.message);
      return res.status(500).json({ error: 'Could not open billing portal' });
    }
  });

  router.get('/api/enterprise/config', (req, res) => {
    res.json({ publishableKey: stripePublishableKey || '' });
  });

  router.post('/api/enterprise/create-checkout', express.json(), async (req, res) => {
    try {
      if (!stripe) {
        return res.status(503).json({ error: 'Billing not configured', code: 'STRIPE_DISABLED' });
      }
      if (!enterprisePriceId) {
        return res.status(503).json({ error: 'Enterprise pricing not configured' });
      }
      const { domain, companyName, contactEmail, contactPhone } = req.body || {};
      if (!domain || typeof domain !== 'string' || !domain.includes('.')) {
        return res.status(400).json({ error: 'A valid domain is required (e.g. company.com)' });
      }
      const cleanDomain = domain.trim().toLowerCase().replace(/^@/, '');
      if (!contactEmail || typeof contactEmail !== 'string' || !contactEmail.includes('@')) {
        return res.status(400).json({ error: 'A valid contact email is required' });
      }
      if (!companyName || typeof companyName !== 'string' || !companyName.trim()) {
        return res.status(400).json({ error: 'Company name is required' });
      }

      const existing = enterpriseStore.getDomainEntry(cleanDomain);
      if (existing && (existing.status === 'active' || existing.status === 'trialing')) {
        return res.status(409).json({ error: 'This domain already has an active enterprise plan' });
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
      console.error('[enterprise] checkout session error:', e.message);
      return res.status(500).json({ error: 'Could not create checkout session' });
    }
  });

  return router;
}
