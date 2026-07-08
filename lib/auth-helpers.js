// Auth/enterprise request helpers. The factory injects the auth + enterprise
// stores, the Stripe client, and the enterprise meter-event name so these can
// live outside server.js while sharing its singletons. Extracted verbatim.
export function createAuthHelpers({ authStore, enterpriseStore, stripe, enterpriseMeterEventName }) {
  function enhanceUserWithEnterprise(user) {
    if (!user) return null;
    if (user.plan === 'pro') return user;
    const domain = user.email ? user.email.split('@')[1]?.toLowerCase() : null;
    if (domain && enterpriseStore.isActiveDomain(domain)) {
      return Object.assign({}, user, { plan: 'pro', enterpriseDomain: domain });
    }
    return user;
  }

  function getAuthUserFromRequest(req) {
    let token = null;
    const h = req.headers.authorization;
    if (h && typeof h === 'string' && h.startsWith('Bearer ')) {
      token = h.slice(7).trim();
    }
    if (!token && req.body && typeof req.body === 'object' && req.body.authToken) {
      token = String(req.body.authToken).trim();
    }
    // Note: we intentionally do NOT read the session token from req.query — a token
    // in a URL leaks via access logs, browser history, and Referer headers. Use the
    // Authorization: Bearer header (or a POST body) instead.
    const user = authStore.validateSession(token);
    return enhanceUserWithEnterprise(user);
  }

  /** Public user payload for API responses — always reflects enterprise domain access. */
  function toPublicAuthUser(user) {
    if (!user) return null;
    return authStore.publicUser(enhanceUserWithEnterprise(user));
  }

  function enterpriseDomainForUser(user) {
    if (!user) return null;

    // Individual Stagify+ subscribers (own Stripe customer) are not billed to the enterprise domain
    const stored = user.email ? authStore.findUserByEmail(user.email) : null;
    const account = stored || user;
    if (account.plan === 'pro' && account.stripeCustomerId) {
      return null;
    }

    const domain =
      user.enterpriseDomain ||
      (user.email ? user.email.split('@')[1]?.toLowerCase() : null);
    return domain && enterpriseStore.isActiveDomain(domain) ? domain : null;
  }

  function reportEnterpriseUsage(domain, quantity = 1) {
    // Always track locally so admin dashboard counts stay accurate (even without Stripe)
    enterpriseStore.recordUsage(domain, quantity);
    if (!stripe) return;
    const entry = enterpriseStore.getDomainEntry(domain);
    if (!entry || !entry.stripeCustomerId) {
      console.warn('[enterprise] Stripe meter skipped — no Stripe customer for domain:', domain);
      return;
    }
    stripe.billing.meterEvents
      .create({
        event_name: enterpriseMeterEventName,
        payload: {
          stripe_customer_id: entry.stripeCustomerId,
          value: String(quantity),
        },
      })
      .then(() => {
        console.log('[enterprise] Usage reported:', quantity, 'generation(s) for', domain);
      })
      .catch((err) => {
        console.error('[enterprise] Failed to report usage for', domain, ':', err.message);
      });
  }

  function requireProAccount(req, res) {
    const user = getAuthUserFromRequest(req);
    if (!user) {
      res.status(401).json({ error: 'Sign in required', code: 'AUTH_REQUIRED' });
      return null;
    }
    if (user.plan !== 'pro') {
      res.status(403).json({ error: 'Stagify+ subscription required', code: 'PRO_REQUIRED' });
      return null;
    }
    return user;
  }

  return {
    enhanceUserWithEnterprise,
    getAuthUserFromRequest,
    toPublicAuthUser,
    enterpriseDomainForUser,
    reportEnterpriseUsage,
    requireProAccount,
  };
}
