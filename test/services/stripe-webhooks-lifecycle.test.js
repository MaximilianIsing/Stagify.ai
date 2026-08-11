// Webhook → trial-lifecycle wiring (lib/services/stripe-webhooks.js). Verifies the
// event-driven emails fire through the injected `lifecycle` bag, that the new
// customer.subscription.trial_will_end event is handled, and — critically — that a
// lifecycle side-effect that throws is swallowed so the webhook still succeeds
// (otherwise Stripe would retry the event forever).

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuthStore } from '../../lib/data/auth-store.js';
import { handleStripeEvent } from '../../lib/services/stripe-webhooks.js';

const tempDirs = [];
const openStores = [];
function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-wh-life-'));
  tempDirs.push(dir);
  const store = createAuthStore(dir);
  openStores.push(store);
  return store;
}
afterEach(() => {
  while (openStores.length) {
    try { openStores.pop().close(); } catch { /* already closed */ }
  }
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function registerUser(store, email = 'buyer@example.com') {
  const start = store.startRegistration(email, 'CorrectHorse9!');
  return store.completeRegistration(email, start.code).user;
}

function spyLifecycle() {
  const calls = { checkout: [], willEnd: [], canceled: [] };
  return {
    calls,
    onTrialCheckout: async (a) => { calls.checkout.push(a); },
    onTrialWillEnd: async (a) => { calls.willEnd.push(a); },
    onSubscriptionCanceled: async (a) => { calls.canceled.push(a); },
  };
}

test('checkout.session.completed invokes onTrialCheckout with the mapped user', async () => {
  const store = freshStore();
  const user = registerUser(store);
  const lifecycle = spyLifecycle();

  const event = {
    type: 'checkout.session.completed',
    data: { object: { mode: 'subscription', metadata: {}, subscription: 'sub_1', customer: 'cus_1', client_reference_id: user.id } },
  };
  await handleStripeEvent(event, store, { lifecycle });

  assert.equal(lifecycle.calls.checkout.length, 1);
  assert.equal(lifecycle.calls.checkout[0].userId, user.id);
});

test('customer.subscription.trial_will_end is handled and calls onTrialWillEnd', async () => {
  const store = freshStore();
  const lifecycle = spyLifecycle();
  const sub = { id: 'sub_1', customer: 'cus_1', status: 'trialing', trial_end: 1893456000 };

  const res = await handleStripeEvent(
    { type: 'customer.subscription.trial_will_end', data: { object: sub } },
    store,
    { lifecycle },
  );

  assert.equal(res.handled, true);
  assert.equal(lifecycle.calls.willEnd.length, 1);
  assert.equal(lifecycle.calls.willEnd[0].subscription.id, 'sub_1');
});

test('subscription.deleted calls onSubscriptionCanceled; subscription.updated does NOT', async () => {
  const store = freshStore();
  const user = registerUser(store);
  const lifecycle = spyLifecycle();
  await handleStripeEvent(
    { type: 'checkout.session.completed', data: { object: { mode: 'subscription', metadata: {}, subscription: 'sub_x', customer: 'cus_x', client_reference_id: user.id } } },
    store, { lifecycle },
  );

  await handleStripeEvent(
    { type: 'customer.subscription.updated', data: { object: { id: 'sub_x', customer: 'cus_x', status: 'active' } } },
    store, { lifecycle },
  );
  assert.equal(lifecycle.calls.canceled.length, 0, 'an update must not trigger a win-back');

  await handleStripeEvent(
    { type: 'customer.subscription.deleted', data: { object: { id: 'sub_x', customer: 'cus_x', status: 'canceled' } } },
    store, { lifecycle },
  );
  assert.equal(lifecycle.calls.canceled.length, 1, 'a deletion triggers the win-back');
});

test('a stale subscription.deleted sends no win-back to a customer who is still paying', async () => {
  // The win-back is gated on result.ok, so the store-level stale guard suppresses this
  // email for free — but that coupling is the whole point of the test: someone who
  // cancelled and resubscribed would otherwise be told "sorry to see you go" while
  // their new subscription is being charged.
  const store = freshStore();
  const user = registerUser(store);
  const lifecycle = spyLifecycle();
  const checkout = (subscription) => handleStripeEvent(
    { type: 'checkout.session.completed', data: { object: { mode: 'subscription', metadata: {}, subscription, customer: 'cus_r', client_reference_id: user.id } } },
    store, { lifecycle },
  );

  await checkout('sub_a');
  await handleStripeEvent(
    { type: 'customer.subscription.deleted', data: { object: { id: 'sub_a', customer: 'cus_r', status: 'canceled' } } },
    store, { lifecycle },
  );
  assert.equal(lifecycle.calls.canceled.length, 1, 'the genuine cancellation does mail them');
  await checkout('sub_b');

  const res = await handleStripeEvent(
    { type: 'customer.subscription.deleted', data: { object: { id: 'sub_a', customer: 'cus_r', status: 'canceled' } } },
    store, { lifecycle },
  );

  assert.equal(res.result.reason, 'stale_subscription');
  assert.equal(lifecycle.calls.canceled.length, 1, 'the stale replay must not mail them again');
  assert.equal(store.findUserByEmail(user.email).plan, 'pro');
});

test('a throwing lifecycle side-effect does not fail the webhook', async () => {
  const store = freshStore();
  const user = registerUser(store);
  const boom = { onTrialCheckout: async () => { throw new Error('mail down'); } };

  const event = {
    type: 'checkout.session.completed',
    data: { object: { mode: 'subscription', metadata: {}, subscription: 'sub_1', customer: 'cus_1', client_reference_id: user.id } },
  };
  const res = await handleStripeEvent(event, store, { lifecycle: boom });

  assert.equal(res.handled, true, 'webhook still reports handled despite the mail failure');
  assert.equal(store.findUserByEmail(user.email).plan, 'pro', 'the upgrade still committed');
});

test('omitting the lifecycle bag keeps the original behaviour (no crash)', async () => {
  const store = freshStore();
  const user = registerUser(store);
  const res = await handleStripeEvent(
    { type: 'checkout.session.completed', data: { object: { mode: 'subscription', metadata: {}, subscription: 'sub_1', customer: 'cus_1', client_reference_id: user.id } } },
    store,
  );
  assert.equal(res.result.ok, true);
  assert.equal(store.findUserByEmail(user.email).plan, 'pro');
});
