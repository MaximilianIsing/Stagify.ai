// Tier: route contract (faked Stripe) — routes/billing.js.
//
// WHAT THIS COVERS
// The billing router is the money surface: a Stripe webhook plus the customer-portal
// and enterprise-checkout endpoints. This suite mounts the real router (see
// test/helpers/billing-app.js) with a faked Stripe SDK and event handler and asserts
// the handler control flow that guards revenue and trust:
//   - the webhook rejects an unconfigured server (503), a missing signature (400),
//     and a signature that fails constructEvent (400) BEFORE any event is handled,
//   - a verified webhook dispatches to handleStripeEvent and acks { received:true },
//     and a throwing handler maps to 500 (Stripe will retry),
//   - customer-portal gates on config (503), auth (401), and a missing Stripe
//     customer (400 NO_STRIPE_CUSTOMER) before opening a portal session,
//   - enterprise-checkout validates domain/email/company and refuses a domain that
//     already has an active plan (409), else creates a checkout session with the
//     cleaned domain in metadata.
// Nothing contacts Stripe; constructEvent and every SDK call are in-process fakes.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mountBilling } from './helpers/billing-app.js';

const postJson = (base, url, body) =>
  fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const postWebhook = (base, body, headers = {}) =>
  fetch(base + '/api/billing/stripe-webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

let app;
afterEach(async () => {
  if (app) { await app.close(); app = null; }
});

// ---- Stripe webhook -------------------------------------------------------

test('webhook → 503 when Stripe is not configured', async () => {
  app = await mountBilling({ stripe: null });
  const res = await postWebhook(app.baseUrl, { type: 'x' }, { 'stripe-signature': 'sig' });
  assert.equal(res.status, 503);
  assert.equal(app.calls.handleStripeEvent.calls, 0, 'no event handled when unconfigured');
});

test('webhook → 400 when the stripe-signature header is missing', async () => {
  app = await mountBilling();
  const res = await postWebhook(app.baseUrl, { type: 'x' }); // no signature header
  assert.equal(res.status, 400);
  assert.equal(app.calls.constructEvent.calls, 0, 'signature never verified without the header');
});

test('webhook → 400 when signature verification throws, without dispatching', async () => {
  app = await mountBilling({
    constructEvent: () => { throw new Error('no signatures found matching the expected signature'); },
  });
  const res = await postWebhook(app.baseUrl, { type: 'x' }, { 'stripe-signature': 'bad' });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Webhook Error/);
  assert.equal(app.calls.handleStripeEvent.calls, 0, 'a forged event is never handled');
});

test('a verified webhook dispatches to handleStripeEvent and acks received', async () => {
  app = await mountBilling(); // default constructEvent returns a parsed event
  const res = await postWebhook(app.baseUrl, { type: 'checkout.session.completed' }, { 'stripe-signature': 'good' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { received: true });
  assert.equal(app.calls.constructEvent.calls, 1);
  assert.equal(app.calls.constructEvent.lastArgs[1], 'good', 'the request signature is passed through');
  assert.equal(app.calls.constructEvent.lastArgs[2], 'whsec_test', 'the configured secret is used');
  assert.equal(app.calls.handleStripeEvent.calls, 1, 'the verified event is handled');
});

test('a throwing event handler maps to 500 so Stripe retries', async () => {
  app = await mountBilling({ handleStripeEvent: async () => { throw new Error('db down'); } });
  const res = await postWebhook(app.baseUrl, { type: 'x' }, { 'stripe-signature': 'good' });
  assert.equal(res.status, 500);
});

// ---- Customer portal ------------------------------------------------------

test('customer-portal → 503 when Stripe is not configured', async () => {
  app = await mountBilling({ stripe: null });
  const res = await postJson(app.baseUrl, '/api/billing/customer-portal', {});
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'STRIPE_DISABLED');
});

test('customer-portal → 401 when not signed in', async () => {
  app = await mountBilling({ authUser: null });
  const res = await postJson(app.baseUrl, '/api/billing/customer-portal', {});
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'AUTH_REQUIRED');
});

test('customer-portal → 400 NO_STRIPE_CUSTOMER when the account has no Stripe profile', async () => {
  app = await mountBilling({ authUser: { id: 'u1', email: 'u@x.com' } }); // no stripeCustomerId
  const res = await postJson(app.baseUrl, '/api/billing/customer-portal', {});
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'NO_STRIPE_CUSTOMER');
  assert.equal(app.calls.portalCreate.calls, 0, 'no portal session opened without a customer');
});

test('customer-portal opens a portal session for a customer and returns its url', async () => {
  app = await mountBilling({ authUser: { id: 'u1', email: 'u@x.com', stripeCustomerId: 'cus_123' } });
  const res = await postJson(app.baseUrl, '/api/billing/customer-portal', {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).url, 'https://billing.stripe.test/portal/session');
  assert.equal(app.calls.portalCreate.calls, 1);
  assert.equal(app.calls.portalCreate.lastArgs[0].customer, 'cus_123', 'the account customer is used');
  assert.match(app.calls.portalCreate.lastArgs[0].return_url, /stagify-plus\.html$/);
});

// ---- Enterprise config + checkout -----------------------------------------

test('enterprise/config returns the publishable key', async () => {
  app = await mountBilling();
  const res = await fetch(app.baseUrl + '/api/enterprise/config');
  assert.deepEqual(await res.json(), { publishableKey: 'pk_test_123' });
});

test('create-checkout → 503 when Stripe is not configured', async () => {
  app = await mountBilling({ stripe: null });
  const res = await postJson(app.baseUrl, '/api/enterprise/create-checkout', {
    domain: 'acme.com', companyName: 'Acme', contactEmail: 'a@acme.com',
  });
  assert.equal(res.status, 503);
});

test('create-checkout rejects an invalid domain, email, or missing company (400)', async () => {
  app = await mountBilling();
  const bad = [
    { domain: 'nodot', companyName: 'Acme', contactEmail: 'a@acme.com' },
    { domain: 'acme.com', companyName: 'Acme', contactEmail: 'not-an-email' },
    { domain: 'acme.com', companyName: '', contactEmail: 'a@acme.com' },
  ];
  for (const body of bad) {
    const res = await postJson(app.baseUrl, '/api/enterprise/create-checkout', body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
  assert.equal(app.calls.checkoutCreate.calls, 0, 'no checkout created for invalid input');
});

test('create-checkout → 409 when the domain already has an active plan', async () => {
  app = await mountBilling({ enterpriseDomainEntry: { status: 'active' } });
  const res = await postJson(app.baseUrl, '/api/enterprise/create-checkout', {
    domain: 'acme.com', companyName: 'Acme', contactEmail: 'a@acme.com',
  });
  assert.equal(res.status, 409);
  assert.equal(app.calls.checkoutCreate.calls, 0);
});

test('create-checkout creates a session with the cleaned domain in metadata', async () => {
  app = await mountBilling();
  const res = await postJson(app.baseUrl, '/api/enterprise/create-checkout', {
    domain: '  @ACME.com ', companyName: 'Acme Inc', contactEmail: 'a@acme.com',
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).url, 'https://checkout.stripe.test/c/session');
  assert.equal(app.calls.checkoutCreate.calls, 1);
  const arg = app.calls.checkoutCreate.lastArgs[0];
  assert.equal(arg.metadata.enterprise_domain, 'acme.com', 'domain is trimmed, lowercased, @-stripped');
  assert.equal(arg.mode, 'subscription');
});
