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
import { createAuthStore } from '../../lib/data/auth-store.js';
import { createEnterpriseStore } from '../../lib/data/enterprise-store.js';
import { handleStripeEvent } from '../../lib/services/stripe-webhooks.js';
import { logger } from '../../lib/logger.js';

const tempDirs = [];
const openStores = [];
function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-stripe-'));
  tempDirs.push(dir);
  const store = createAuthStore(dir);
  openStores.push(store);
  return store;
}
afterEach(() => {
  // Close SQLite handles before removing the temp dir (Windows won't unlink an
  // open .db/-wal/-shm file).
  while (openStores.length) {
    try { openStores.pop().close(); } catch { /* already closed */ }
  }
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

// ── the email fallback cannot take over an account ────────────────────────────
// `customer_email` is whatever the buyer typed at Stripe — unverified, and everyone's
// address is public. These express the whole attack as real events rather than as a
// call to the mapping function, because the damage lands two events later.

test('a checkout in a paying customer\'s name cannot steal their subscription link', async () => {
  const store = freshStore();
  const victim = registerUser(store, 'paying@example.com');
  await handleStripeEvent(
    checkoutCompleted({ userId: victim.id, sub: 'sub_victim', cus: 'cus_victim' }),
    store,
  );
  assert.equal(store.findUserByEmail(victim.email).plan, 'pro');

  // Attacker checks out with the victim's address and no client_reference_id.
  const res = await handleStripeEvent(
    checkoutCompleted({ email: victim.email, sub: 'sub_attacker', cus: 'cus_attacker' }),
    store,
  );

  assert.equal(res.handled, true, 'still acked — Stripe must not retry forever');
  assert.equal(res.result.ok, false);
  assert.equal(res.result.reason, 'email_match_would_reassign');
  const after = store.findUserByEmail(victim.email);
  assert.equal(after.stripeSubscriptionId, 'sub_victim', 'their own subscription still theirs');
  assert.equal(after.stripeCustomerId, 'cus_victim', 'billing portal still opens their own customer');
  assert.equal(after.plan, 'pro');
});

test('and therefore cannot downgrade them by cancelling the attacker\'s own trial', async () => {
  // The payoff of the takeover: once the victim's row points at sub_attacker, the
  // attacker cancels their trial and `customer.subscription.deleted` downgrades a
  // customer who is still being billed. This is the assertion that matters.
  const store = freshStore();
  const victim = registerUser(store, 'paying@example.com');
  await handleStripeEvent(
    checkoutCompleted({ userId: victim.id, sub: 'sub_victim', cus: 'cus_victim' }),
    store,
  );
  await handleStripeEvent(
    checkoutCompleted({ email: victim.email, sub: 'sub_attacker', cus: 'cus_attacker' }),
    store,
  );

  await handleStripeEvent(
    subscriptionEvent('customer.subscription.deleted', {
      sub: 'sub_attacker',
      cus: 'cus_attacker',
      status: 'canceled',
    }),
    store,
  );

  assert.equal(store.findUserByEmail(victim.email).plan, 'pro', 'the victim keeps the plan they pay for');
});

test('an email checkout cannot swallow an admin comp grant either', async () => {
  const store = freshStore();
  const granted = registerUser(store, 'comped@example.com');
  assert.equal(store.grantProMonth({ email: granted.email }).ok, true);
  assert.equal(store.findUserByEmail(granted.email).plan, 'pro');

  const res = await handleStripeEvent(
    checkoutCompleted({ email: granted.email, sub: 'sub_attacker', cus: 'cus_attacker' }),
    store,
  );

  assert.equal(res.result.reason, 'email_match_would_reassign');
  const after = store.findUserByEmail(granted.email);
  assert.ok(after.proGrantExpiresAt, 'the grant is untouched, so cancelling cannot end it early');
  assert.notEqual(after.stripeSubscriptionId, 'sub_attacker');
});

test('a refusal is logged loudly, with the Stripe ids and without the typed email', async () => {
  // A refusal means money came in and nobody got a plan, so it needs a human. If this
  // ever quietly falls back to the generic "could not map to user" warn, the operator
  // loses the only signal that a paid checkout is stranded.
  const store = freshStore();
  const victim = registerUser(store, 'paying@example.com');
  await handleStripeEvent(
    checkoutCompleted({ userId: victim.id, sub: 'sub_victim', cus: 'cus_victim' }),
    store,
  );

  const origError = logger.error;
  const errors = [];
  logger.error = (...args) => { errors.push(args); };
  try {
    await handleStripeEvent(
      checkoutCompleted({ email: victim.email, sub: 'sub_attacker', cus: 'cus_attacker' }),
      store,
    );
  } finally {
    logger.error = origError;
  }

  assert.equal(errors.length, 1, 'error level, not warn — this is not a routine unmapped checkout');
  const [message, context] = errors[0];
  assert.match(message, /reconcile manually/i, 'says what the operator has to do');
  assert.deepEqual(context, { subscription: 'sub_attacker', customer: 'cus_attacker' },
    'the ids to reconcile from');
  assert.doesNotMatch(JSON.stringify(errors[0]), /paying@example\.com/, 'the typed address is not ours to record');
});

test('a client_reference_id match still relinks — it is the unguessable identifier', async () => {
  // The reference is a 96-bit account id nothing exposes, so it is not a targeting
  // vector the way an address is. A signed-in user re-subscribing must still work.
  const store = freshStore();
  const user = registerUser(store, 'resubscriber@example.com');
  await handleStripeEvent(checkoutCompleted({ userId: user.id, sub: 'sub_1', cus: 'cus_1' }), store);

  const res = await handleStripeEvent(
    checkoutCompleted({ userId: user.id, sub: 'sub_2', cus: 'cus_2' }),
    store,
  );

  assert.equal(res.result.ok, true);
  assert.equal(res.result.matchedBy, 'reference');
  assert.equal(store.findUserByEmail(user.email).stripeSubscriptionId, 'sub_2');
});

test('a signed-out buyer with no prior entitlement is still activated by email', async () => {
  // The reason the fallback exists: "Start free trial" stays clickable when signed
  // out, so this is an ordinary purchase, not an edge case. Breaking it would leave
  // real buyers paying with no plan.
  const store = freshStore();
  const buyer = registerUser(store, 'signed-out@example.com');

  const res = await handleStripeEvent(
    checkoutCompleted({ email: buyer.email, sub: 'sub_new', cus: 'cus_new' }),
    store,
  );

  assert.equal(res.result.ok, true);
  assert.equal(res.result.matchedBy, 'email');
  assert.equal(store.findUserByEmail(buyer.email).plan, 'pro');
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

test('an enterprise checkout for a public email provider activates nothing', async () => {
  // The checkout route refuses gmail.com up front, so an event carrying it never
  // came from our own form — a replayed session, a dashboard-created subscription,
  // hand-edited metadata. Uses the REAL enterprise store so activateDomain's own
  // guard is what's under test, not a fake that always says ok.
  const store = freshStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-stripe-ent-'));
  tempDirs.push(dir);
  const enterpriseStore = createEnterpriseStore(dir);
  openStores.push(enterpriseStore);
  const stripe = { subscriptions: { retrieve: async () => ({ items: { data: [{ id: 'si_1' }] } }) } };

  const event = {
    type: 'checkout.session.completed',
    data: { object: {
      mode: 'subscription',
      metadata: { enterprise_domain: 'gmail.com', enterprise_company: 'Totally Legit LLC' },
      subscription: 'sub_ent',
      customer: 'cus_ent',
    } },
  };

  const res = await handleStripeEvent(event, store, { stripe, enterpriseStore });
  assert.equal(res.handled, true, 'the event is still acked so Stripe stops retrying');
  assert.equal(res.result.ok, false);
  assert.equal(res.result.reason, 'public_email_domain');
  assert.equal(enterpriseStore.getDomainEntry('gmail.com'), null, 'no domain row is written');
  assert.equal(enterpriseStore.isActiveDomain('gmail.com'), false);
});

test('an unrecognized event type is acknowledged but not handled', async () => {
  const store = freshStore();
  const res = await handleStripeEvent({ type: 'invoice.payment_succeeded', data: { object: {} } }, store);
  assert.equal(res.handled, false);
});
