// The rate limit on POST /api/enterprise/create-checkout.
//
// WHY ITS OWN FILE: the endpoint is unauthenticated by design (a company buys the
// enterprise plan before anyone on it has an account) and every accepted request
// mints a real Stripe Checkout Session, so the only thing standing between an
// anonymous caller and unlimited session creation is `checkoutLimiter`. That
// limiter is a module-level singleton constructed ONCE, at import time, from
// `RL_CHECKOUT` — so a small deterministic ceiling only exists if the env var is
// set BEFORE lib/http/rate-limiters.js is first imported. Hence the override +
// dynamic import below, and hence a separate file: test/routes/billing-route.test.js
// mounts a pass-through limiter so its many checkout cases don't share one bucket,
// which is exactly the wiring this file must NOT use.
//
// The important assertion is that the limiter is armed WITHOUT being injected —
// routes/billing.js falls back to the shared limiter, so forgetting it in the
// server.js dep bag cannot silently leave the endpoint unlimited. Passing
// `checkoutLimiter: null` asks the helper for that production wiring.
//
// No network, no Stripe: the Stripe client, the enterprise store, and the session
// resolver are all in-process fakes (see test/helpers/billing-app.js).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Set the ceiling before anything can import the limiter module. 2 keeps the burst
// short; the production default is 10/hour.
const RL_CHECKOUT_SNAPSHOT = process.env.RL_CHECKOUT;
process.env.RL_CHECKOUT = '2';

// Dynamic import taken AFTER the override, so the router's fallback limiter is the
// limit=2 one. A static import at the top of the file would run first and freeze
// the default in.
const { mountBilling } = await import('../helpers/billing-app.js');

after(() => {
  if (RL_CHECKOUT_SNAPSHOT === undefined) delete process.env.RL_CHECKOUT;
  else process.env.RL_CHECKOUT = RL_CHECKOUT_SNAPSHOT;
});

function postJson(baseUrl, path, body) {
  return fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID = { domain: 'acme.com', companyName: 'Acme', contactEmail: 'a@acme.com' };

test('create-checkout is rate limited by default — the router falls back to the shared limiter', async () => {
  // `checkoutLimiter: null` → no injected middleware, so the route mounts exactly
  // what production mounts.
  const app = await mountBilling({ checkoutLimiter: null });
  try {
    // The first RL_CHECKOUT (=2) requests go through and do create sessions.
    for (let i = 0; i < 2; i += 1) {
      const ok = await postJson(app.baseUrl, '/api/enterprise/create-checkout', VALID);
      assert.equal(ok.status, 200, `request ${i + 1} is under the ceiling`);
    }
    assert.equal(app.calls.checkoutCreate.calls, 2);

    // The next one is refused before the handler runs — no third Stripe session.
    const over = await postJson(app.baseUrl, '/api/enterprise/create-checkout', VALID);
    assert.equal(over.status, 429, 'the request past the RL_CHECKOUT ceiling is rejected');
    assert.deepEqual(await over.json(), {
      error: 'Too many checkout attempts. Please wait a while and try again.',
    });
    assert.equal(app.calls.checkoutCreate.calls, 2, 'no Stripe session created for the refused request');
  } finally {
    await app.close();
  }
});

test('the ceiling covers refused requests too, so probing domains cannot outrun it', async () => {
  // The limiter counts every request, not just the ones that reach Stripe. This is
  // what bounds the duplicate-domain branch as an enumeration oracle: an anonymous
  // caller gets RL_CHECKOUT probes per window, whatever answers they produce.
  //
  // The bucket is keyed by IP and shared with the test above (same loopback client,
  // same singleton limiter), so this run starts already over the ceiling — which is
  // precisely the property being asserted.
  const app = await mountBilling({
    checkoutLimiter: null,
    enterpriseDomainEntry: { status: 'active' },
  });
  try {
    const res = await postJson(app.baseUrl, '/api/enterprise/create-checkout', VALID);
    assert.equal(res.status, 429, 'a fresh app does not get a fresh budget — the limiter is process-wide');
    assert.equal(app.calls.getDomainEntry.calls, 0, 'the domain is never looked up once the ceiling is spent');
  } finally {
    await app.close();
  }
});

test('the 409 for an already-provisioned domain does not name the customer relationship', async () => {
  // Public endpoint: the refusal must not confirm to an anonymous caller that this
  // specific company is a Stagify enterprise customer.
  const app = await mountBilling({ enterpriseDomainEntry: { status: 'trialing' } });
  try {
    const res = await postJson(app.baseUrl, '/api/enterprise/create-checkout', VALID);
    assert.equal(res.status, 409);
    const { error } = await res.json();
    assert.doesNotMatch(
      String(error),
      /already has|active enterprise plan|existing (customer|subscription)/i,
      'the message must not disclose that the domain is an existing customer',
    );
    assert.match(String(error), /contact support/i, 'but it still tells a legitimate buyer what to do');
    assert.equal(app.calls.checkoutCreate.calls, 0, 'and no Stripe session is created');
  } finally {
    await app.close();
  }
});
