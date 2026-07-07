// Tier 2 (C) — billing lifecycle (lib/stripe-webhooks.js).
//
// handleStripeEvent takes an ALREADY-PARSED event (signature verification happens
// at the route layer), so these tests feed it hand-built event objects and a real
// temp-dir authStore. Nothing contacts Stripe — no keys, no webhook secret, no CLI.
// Catches the revenue bugs: "paid but didn't get Pro" and "churned but still Pro".

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuthStore } from '../lib/auth-store.js';
import { handleStripeEvent } from '../lib/stripe-webhooks.js';

const tempDirs = [];
function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-stripe-'));
  tempDirs.push(dir);
  return createAuthStore(dir);
}
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function registerUser(store, email = 'buyer@example.com') {
  const start = store.startRegistration(email, 'CorrectHorse9!');
  const done = store.completeRegistration(email, start.code);
  return done.user; // { id, email, plan, ... }
}

// Minimal Stripe-shaped payloads (only the fields handleStripeEvent reads).
const checkoutCompleted = ({ userId = null, email = null, sub = 'sub_test', cus = 'cus_test' }) => ({
  type: 'checkout.session.completed',
  data: { object: {
    mode: 'subscription',
    metadata: {},
    subscription: sub,
    customer: cus,
    client_reference_id: userId,
    customer_email: email,
  } },
});

const subscriptionEvent = (type, { sub = 'sub_test', cus = 'cus_test', status }) => ({
  type,
  data: { object: { id: sub, customer: cus, status } },
});

test('checkout.session.completed upgrades the referenced user to pro', async () => {
  const store = freshStore();
  const user = registerUser(store);
  assert.equal(user.plan, 'free', 'user starts on the free plan');

  const res = await handleStripeEvent(checkoutCompleted({ userId: user.id }), store);
  assert.equal(res.handled, true);
  assert.equal(res.result.ok, true, res.result.reason || '');
  assert.equal(store.findUserByEmail(user.email).plan, 'pro', 'user should be pro after checkout');
});

test('checkout falls back to matching the customer email when there is no client_reference_id', async () => {
  const store = freshStore();
  const user = registerUser(store, 'email-match@example.com');

  await handleStripeEvent(checkoutCompleted({ email: user.email }), store);
  assert.equal(store.findUserByEmail(user.email).plan, 'pro', 'email fallback should upgrade the user');
});

test('checkout for an unknown user is acknowledged but grants nobody', async () => {
  const store = freshStore();
  const res = await handleStripeEvent(checkoutCompleted({ email: 'ghost@example.com' }), store);
  assert.equal(res.handled, true);
  assert.equal(res.result.ok, false, 'no matching account → not granted');
  assert.equal(res.result.reason, 'no_user');
});

test('subscription.deleted downgrades the user back to free', async () => {
  const store = freshStore();
  const user = registerUser(store);
  await handleStripeEvent(checkoutCompleted({ userId: user.id, sub: 'sub_x', cus: 'cus_x' }), store);
  assert.equal(store.findUserByEmail(user.email).plan, 'pro');

  const res = await handleStripeEvent(
    subscriptionEvent('customer.subscription.deleted', { sub: 'sub_x', cus: 'cus_x', status: 'canceled' }),
    store,
  );
  assert.equal(res.handled, true);
  assert.equal(store.findUserByEmail(user.email).plan, 'free', 'a canceled subscription → free');
});

test('subscription.updated to an active status restores pro (renewal)', async () => {
  const store = freshStore();
  const user = registerUser(store);
  await handleStripeEvent(checkoutCompleted({ userId: user.id, sub: 'sub_a', cus: 'cus_a' }), store);
  await handleStripeEvent(
    subscriptionEvent('customer.subscription.deleted', { sub: 'sub_a', cus: 'cus_a', status: 'canceled' }),
    store,
  );
  assert.equal(store.findUserByEmail(user.email).plan, 'free');

  await handleStripeEvent(
    subscriptionEvent('customer.subscription.updated', { sub: 'sub_a', cus: 'cus_a', status: 'active' }),
    store,
  );
  assert.equal(store.findUserByEmail(user.email).plan, 'pro', 'an active renewal → pro again');
});

test('enterprise checkout routes to the enterprise store, not to a user account', async () => {
  const store = freshStore();
  let activated = null;
  const enterpriseStore = { activateDomain: (args) => { activated = args; return { ok: true }; } };
  const stripe = { subscriptions: { retrieve: async () => ({ items: { data: [{ id: 'si_1' }] } }) } };

  const event = {
    type: 'checkout.session.completed',
    data: { object: {
      mode: 'subscription',
      metadata: { enterprise_domain: 'acme.com', enterprise_company: 'Acme Inc' },
      subscription: 'sub_ent',
      customer: 'cus_ent',
    } },
  };

  const res = await handleStripeEvent(event, store, { stripe, enterpriseStore });
  assert.equal(res.handled, true);
  assert.ok(activated, 'enterpriseStore.activateDomain should have been called');
  assert.equal(activated.domain, 'acme.com');
});

test('an unrecognized event type is acknowledged but not handled', async () => {
  const store = freshStore();
  const res = await handleStripeEvent({ type: 'invoice.payment_succeeded', data: { object: {} } }, store);
  assert.equal(res.handled, false);
});
