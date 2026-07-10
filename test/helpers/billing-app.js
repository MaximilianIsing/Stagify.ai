// Mounts the real billing router (routes/billing.js) on a bare Express app with
// fully faked dependencies, then listens on an ephemeral port. This mirrors
// test/helpers/staging-app.js: it exercises the ACTUAL handlers — the Stripe
// webhook's raw-body signature check + event dispatch, the customer-portal and
// enterprise-checkout auth/validation guards, and the response shaping — with the
// Stripe SDK, the event handler, and the session-user resolver all swapped for
// in-process fakes. No network, no Stripe keys, no webhook secret.

import express from 'express';
import createBillingRouter from '../../routes/billing.js';

// Call-recording spy: `fn.calls` counts invocations, `fn.lastArgs` holds the most
// recent argument list, `impl` supplies the return value.
function makeSpy(impl) {
  const fn = (...args) => {
    fn.calls += 1;
    fn.lastArgs = args;
    return impl ? impl(...args) : undefined;
  };
  fn.calls = 0;
  fn.lastArgs = null;
  return fn;
}

/**
 * Mount the billing router. `overrides` merges over the faked deps; the common ones:
 *   - `stripe: null`            → the "billing not configured" branch (503),
 *   - `authUser: {...}`         → what getAuthUserFromRequest resolves (default null),
 *   - `constructEvent`          → throw to simulate a bad signature,
 *   - `handleStripeEvent`       → assert dispatch / force a 500,
 *   - `enterpriseDomainEntry`   → the enterpriseStore.getDomainEntry result.
 * Returns { baseUrl, calls, close } where `calls` exposes the spies to assert on.
 */
export async function mountBilling(overrides = {}) {
  const {
    authUser = null,
    constructEvent,
    handleStripeEvent: handleStripeEventOver,
    enterpriseDomainEntry = null,
    stripe: stripeOver,
    ...rest
  } = overrides;

  const constructEventSpy = makeSpy(
    constructEvent || (() => ({ type: 'checkout.session.completed', data: { object: {} } })),
  );
  const portalCreate = makeSpy(async () => ({ url: 'https://billing.stripe.test/portal/session' }));
  const checkoutCreate = makeSpy(async () => ({ url: 'https://checkout.stripe.test/c/session' }));

  const stripe =
    stripeOver !== undefined
      ? stripeOver
      : {
          webhooks: { constructEvent: constructEventSpy },
          billingPortal: { sessions: { create: portalCreate } },
          checkout: { sessions: { create: checkoutCreate } },
        };

  const handleStripeEvent = makeSpy(handleStripeEventOver || (async () => ({ handled: true })));
  const getAuthUserFromRequest = makeSpy(() => authUser);
  const getDomainEntry = makeSpy(() => enterpriseDomainEntry);

  const baseDeps = {
    stripe,
    stripeWebhookSecret: 'whsec_test',
    stripePublishableKey: 'pk_test_123',
    enterprisePriceId: 'price_enterprise',
    authStore: { /* only passed through to handleStripeEvent, which is faked */ },
    enterpriseStore: { getDomainEntry },
    handleStripeEvent,
    getAuthUserFromRequest,
  };

  const app = express();
  app.use(createBillingRouter({ ...baseDeps, ...rest, stripe }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls: { constructEvent: constructEventSpy, portalCreate, checkoutCreate, handleStripeEvent, getAuthUserFromRequest, getDomainEntry },
    close: () => new Promise((r) => server.close(r)),
  };
}
