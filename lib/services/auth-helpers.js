// Auth/enterprise request helpers. The factory injects the auth + enterprise
// stores, the Stripe client, and the enterprise meter-event name so these can
// live outside server.js while sharing its singletons. Extracted verbatim.
import { logger } from '../logger.js';

/**
 * Build the auth/enterprise request helpers bound to the injected auth + enterprise
 * stores and Stripe client, so they live outside server.js while sharing its singletons.
 * @param {{ authStore: any, enterpriseStore: any, stripe: any, enterpriseMeterEventName: string }} deps - The auth + enterprise stores, the Stripe client (or null), and the enterprise meter-event name.
 * @returns {{ enhanceUserWithEnterprise: (user: any) => any, getAuthUserFromRequest: (req: import('express').Request) => any, toPublicAuthUser: (user: any) => any, enterpriseDomainForUser: (user: any) => string | null, reportEnterpriseUsage: (domain: string, quantity?: number) => void, recordStagingActivity: (user: any) => boolean, requireProAccount: (req: import('express').Request, res: import('express').Response) => any }} The auth/enterprise request helpers.
 */
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
      logger.warn('[enterprise] Stripe meter skipped — no Stripe customer for domain:', domain);
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
        logger.info('[enterprise] Usage reported:', quantity, 'generation(s) for', domain);
      })
      .catch((err) => {
        logger.error('[enterprise] Failed to report usage for', domain, ':', err.message);
      });
  }

  /**
   * Record that a paid/trialing account actually USED the product.
   *
   * This is the signal `trial-lifecycle.js` reads to decide whether a trial user has
   * "activated" (`activated = !!lastStagedAt && lastStagedAt >= trialStart`), which in
   * turn picks between the day-1 activation nudge ("you haven't staged anything yet")
   * and the mid-trial value email.
   *
   * It used to be written from ONE place — the basic single-photo studio — even though
   * the Masking Studio and the AI Designer are `requireProAccount`-gated, i.e. the
   * features a trial exists to sell. A trial user who went straight to those was
   * therefore classed as never having started: they got told they hadn't used a product
   * they were using heavily, and never received the value email. Every paid surface must
   * call this, which is why the plan check lives HERE rather than at each call site.
   *
   * Free-plan usage is deliberately not recorded — `recordFreeGeneration` already meters
   * that, and a free account has no trial to activate.
   * @param {any} user - The validated session account (never a client-supplied field).
   * @returns {boolean} True when an activity timestamp was written.
   */
  function recordStagingActivity(user) {
    if (!user || user.plan !== 'pro' || !user.id) return false;
    // Guarded so a mocked authStore in tests need not define it.
    if (typeof authStore.recordStagingActivity !== 'function') return false;
    authStore.recordStagingActivity(user.id);
    return true;
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
    recordStagingActivity,
    requireProAccount,
  };
}
