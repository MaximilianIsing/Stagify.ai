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

// In-memory stand-in for lib/data/stripe-events.js — same claim/markDone/release
// contract, same semantics (an id is fresh once; 'done' rows dedupe, 'processing'
// rows read as in-flight, release() hands the id back). Route tests assert the
// router's USE of the ledger; the real SQLite one is unit-tested in
// test/data/stripe-events.test.js.
function makeEventLedger() {
  const seen = new Map();
  const claim = makeSpy((event) => {
    const id = event && event.id;
    if (!id) return { fresh: true, reason: 'unidentified' };
    const status = seen.get(id);
    if (status === 'done') return { fresh: false, reason: 'duplicate' };
    if (status === 'processing') return { fresh: false, reason: 'in_flight' };
    seen.set(id, 'processing');
    return { fresh: true, reason: 'new' };
  });
  const markDone = makeSpy((id) => { if (id) seen.set(id, 'done'); });
  const release = makeSpy((id) => { seen.delete(id); });
  return { claim, markDone, release, seen };
}

/**
 * Mount the billing router. `overrides` merges over the faked deps; the common ones:
 *   - `stripe: null`            → the "billing not configured" branch (503),
 *   - `authUser: {...}`         → what getAuthUserFromRequest resolves (default null),
 *   - `constructEvent`          → throw to simulate a bad signature,
 *   - `handleStripeEvent`       → assert dispatch / force a 500,
 *   - `enterpriseDomainEntry`   → the enterpriseStore.getDomainEntry result,
 *   - `stripeEvents`            → the webhook idempotency ledger. Defaults to an
 *     in-memory one (see makeEventLedger); pass `null` for the un-deduped path,
 *   - `checkoutLimiter`         → the enterprise-checkout rate limiter. Defaults to a
 *     pass-through here so a file's many checkout cases don't share (and exhaust) one
 *     real bucket; pass `null` to mount the router's REAL limiter, or your own
 *     middleware to exercise a tight ceiling.
 * Returns { baseUrl, calls, close } where `calls` exposes the spies to assert on.
 */
export async function mountBilling(overrides = {}) {
  const {
    authUser = null,
    constructEvent,
    handleStripeEvent: handleStripeEventOver,
    enterpriseDomainEntry = null,
    stripe: stripeOver,
    stripeEvents: stripeEventsOver,
    checkoutLimiter = (req, res, next) => next(),
    ...rest
  } = overrides;

  const ledger = makeEventLedger();
  const stripeEvents = stripeEventsOver !== undefined ? stripeEventsOver : ledger;

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
    stripeEvents,
    // Destructured out of `overrides` above, so it must be re-passed explicitly —
    // it would not reach the router via `...rest`.
    checkoutLimiter,
  };

  const app = express();
  app.use(createBillingRouter({ ...baseDeps, ...rest, stripe }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls: {
      constructEvent: constructEventSpy,
      portalCreate,
      checkoutCreate,
      handleStripeEvent,
      getAuthUserFromRequest,
      getDomainEntry,
      claim: ledger.claim,
      markDone: ledger.markDone,
      release: ledger.release,
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
