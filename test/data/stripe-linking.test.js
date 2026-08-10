// Tier: unit (real temp-dir store) — lib/data/stripe-linking.js.
//
// WHAT THIS COVERS
// Which account a Stripe subscription is allowed to attach to. Two identifiers can
// arrive from a checkout and they are not equally trustworthy: `client_reference_id`
// is a 96-bit account id nothing exposes, while `customer_email` is whatever the buyer
// typed at Stripe — unverified, and everyone's address is public. So an email match may
// START a billing relationship and must never REPLACE one.
//
// The tests come in pairs on purpose, because this guard can fail in two directions and
// only one of them is loud. Too permissive: a stranger's checkout reassigns a paying
// customer's subscription (the takeover). Too strict: a reference-less purchase stops
// activating and a real buyer pays for nothing — silent, and worse for the business.
// Every refusal case below therefore has an allow case beside it.
//
// Reference-less checkouts are rarer than they were — the "Start free trial" button no
// longer reaches Stripe while signed out — but the Payment Link is a public URL, and a
// buyer can always type a different address into Stripe's own form, so the fallback is
// still load-bearing.
//
// The end-to-end version of the attack (checkout → cancel → downgrade) lives in
// test/services/stripe-webhooks.test.js, over real event payloads.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuthStore } from '../../lib/data/auth-store.js';

const tempDirs = [];
const openStores = [];
function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-linking-'));
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

function registerUser(store, email) {
  const start = store.startRegistration(email, 'CorrectHorse9!');
  return store.completeRegistration(email, start.code).user;
}

// Seed a record directly (importStore REPLACES all state) so a grant can be given an
// already-past expiry without waiting a month — the same trick test/data/pro-grant.test.js
// uses. `plan:'pro'` + a past date is exactly what a lapsed grant leaves on disk: nothing
// rewrites the row, applyGrantExpiry only downgrades `plan` on the way out.
function seedUser(store, email, extra) {
  store.importStore({
    sessions: {},
    mobileIpUsage: {},
    passwordResetTokens: {},
    pendingRegistrations: {},
    users: [{ id: 'u_seed', email, plan: 'free', createdAt: '2026-01-01T00:00:00.000Z', ...extra }],
  });
  return store.findUserByEmail(email);
}

// ── matching ─────────────────────────────────────────────────────────────────

test('a reference match wins over the email, and reports how it matched', () => {
  const store = freshStore();
  const owner = registerUser(store, 'owner@example.com');
  const other = registerUser(store, 'other@example.com');

  // Both identifiers present and pointing at different accounts: the unguessable
  // one decides, so a tampered `prefilled_email` cannot redirect the grant.
  const res = store.activateProFromStripeCheckout({
    userId: owner.id,
    email: other.email,
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_1',
  });

  assert.equal(res.ok, true);
  assert.equal(res.matchedBy, 'reference');
  assert.equal(res.userId, owner.id);
  assert.equal(store.findUserByEmail(other.email).plan, 'free', 'the other account is untouched');
});

test('the email match is case- and whitespace-insensitive', () => {
  const store = freshStore();
  const user = registerUser(store, 'mixed@example.com');

  const res = store.activateProFromStripeCheckout({
    email: '  MiXeD@Example.COM ',
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_1',
  });

  assert.equal(res.ok, true);
  assert.equal(res.userId, user.id);
});

test('neither identifier matching is a plain no_user, not a refusal', () => {
  const store = freshStore();
  const res = store.activateProFromStripeCheckout({ userId: 'u_nope', email: 'ghost@example.com' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no_user', 'distinct from email_match_would_reassign — different operator action');
});

// ── the email path may start a relationship, never replace one ────────────────

test('email: activates a free account that holds nothing', () => {
  const store = freshStore();
  const buyer = registerUser(store, 'fresh@example.com');

  const res = store.activateProFromStripeCheckout({
    email: buyer.email,
    stripeCustomerId: 'cus_new',
    stripeSubscriptionId: 'sub_new',
  });

  assert.equal(res.ok, true);
  assert.equal(res.matchedBy, 'email');
  const after = store.findUserByEmail(buyer.email);
  assert.equal(after.plan, 'pro');
  assert.equal(after.stripeSubscriptionId, 'sub_new');
});

test('email: refuses when the account already holds a different subscription', () => {
  const store = freshStore();
  const victim = registerUser(store, 'paying@example.com');
  store.activateProFromStripeCheckout({
    userId: victim.id,
    stripeCustomerId: 'cus_victim',
    stripeSubscriptionId: 'sub_victim',
  });

  const res = store.activateProFromStripeCheckout({
    email: victim.email,
    stripeCustomerId: 'cus_attacker',
    stripeSubscriptionId: 'sub_attacker',
  });

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'email_match_would_reassign');
  const after = store.findUserByEmail(victim.email);
  assert.equal(after.stripeSubscriptionId, 'sub_victim', 'nothing was written');
  assert.equal(after.stripeCustomerId, 'cus_victim');
});

test('email: refuses when the account holds an admin comp grant', () => {
  // A grant is an entitlement too — letting a checkout absorb it means its buyer can
  // end someone else's comped month by cancelling.
  const store = freshStore();
  const granted = registerUser(store, 'comped@example.com');
  assert.equal(store.grantProMonth({ email: granted.email }).ok, true);

  const res = store.activateProFromStripeCheckout({
    email: granted.email,
    stripeCustomerId: 'cus_attacker',
    stripeSubscriptionId: 'sub_attacker',
  });

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'email_match_would_reassign');
  assert.ok(store.findUserByEmail(granted.email).proGrantExpiresAt, 'the grant survives');
});

test('email: a LAPSED comp grant does not block a genuine purchase', () => {
  // The compounding half of the same false-positive. A grant that runs out is never
  // rewritten — applyGrantExpiry flips `plan` to 'free' on read and only revokeProGrant
  // ever nulls proGrantExpiresAt — so the date sits on the record forever. Reading it as
  // a boolean meant "was ever comped" permanently disqualified an account from the email
  // path: the buyer pays and gets nothing, months after a promo they no longer hold.
  const store = freshStore();
  const lapsed = seedUser(store, 'lapsed@example.com', {
    plan: 'pro',
    proGrantedAt: '2026-05-01T00:00:00.000Z',
    proGrantExpiresAt: '2026-06-01T00:00:00.000Z', // in the past
  });
  assert.equal(lapsed.plan, 'free', 'precondition: the grant has already lapsed');
  assert.ok(lapsed.proGrantExpiresAt, 'precondition: but the field is still populated');

  const res = store.activateProFromStripeCheckout({
    email: lapsed.email,
    stripeCustomerId: 'cus_paid',
    stripeSubscriptionId: 'sub_paid',
  });

  assert.equal(res.ok, true, 'an expired comp is not an entitlement to protect');
  assert.equal(res.matchedBy, 'email');
  const after = store.findUserByEmail('lapsed@example.com');
  assert.equal(after.plan, 'pro');
  assert.equal(after.stripeSubscriptionId, 'sub_paid');
});

test('email: a genuine re-purchase after a cancellation still goes through', () => {
  // The false-positive this guard must not create. `subscription.deleted` clears the
  // subscription id but leaves the old customer id behind, so "has a stale customer
  // id" cannot be the test — only a LIVE subscription blocks.
  const store = freshStore();
  const returning = registerUser(store, 'returning@example.com');
  store.activateProFromStripeCheckout({
    userId: returning.id,
    stripeCustomerId: 'cus_old',
    stripeSubscriptionId: 'sub_old',
  });
  store.applyStripeSubscriptionState({ id: 'sub_old', customer: 'cus_old', status: 'canceled' });
  assert.equal(store.findUserByEmail(returning.email).plan, 'free');

  const res = store.activateProFromStripeCheckout({
    email: returning.email,
    stripeCustomerId: 'cus_new',
    stripeSubscriptionId: 'sub_new',
  });

  assert.equal(res.ok, true, 'a returning signed-out customer must not be locked out');
  assert.equal(store.findUserByEmail(returning.email).plan, 'pro');
});

test('email: redelivery of the same checkout is not mistaken for a takeover', () => {
  // Stripe delivers at-least-once. The second copy carries the SAME subscription id,
  // so it must stay a no-op re-apply rather than tripping the guard.
  const store = freshStore();
  const buyer = registerUser(store, 'again@example.com');
  const args = { email: buyer.email, stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' };

  assert.equal(store.activateProFromStripeCheckout(args).ok, true);
  const second = store.activateProFromStripeCheckout(args);

  assert.equal(second.ok, true, 'same subscription → same relationship, not a reassignment');
  assert.equal(store.findUserByEmail(buyer.email).stripeSubscriptionId, 'sub_1');
});

test('a reference match may relink freely — it is not the spoofable identifier', () => {
  const store = freshStore();
  const user = registerUser(store, 'signed-in@example.com');
  store.activateProFromStripeCheckout({
    userId: user.id,
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_1',
  });

  const res = store.activateProFromStripeCheckout({
    userId: user.id,
    stripeCustomerId: 'cus_2',
    stripeSubscriptionId: 'sub_2',
  });

  assert.equal(res.ok, true);
  assert.equal(store.findUserByEmail(user.email).stripeSubscriptionId, 'sub_2');
});

// ── applyStripeSubscriptionState (moved with the checkout mapping) ────────────

test('subscription state is applied by subscription id, falling back to customer id', () => {
  const store = freshStore();
  const user = registerUser(store, 'lifecycle@example.com');
  store.activateProFromStripeCheckout({
    userId: user.id,
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_1',
  });

  // Unknown subscription id, known customer → still finds the account.
  const res = store.applyStripeSubscriptionState({ id: 'sub_other', customer: 'cus_1', status: 'active' });
  assert.equal(res.ok, true);
  assert.equal(store.findUserByEmail(user.email).plan, 'pro');
});

test('a subscription nobody holds is a no_user, and a junk payload is bad_payload', () => {
  const store = freshStore();
  assert.equal(store.applyStripeSubscriptionState({ id: 'sub_x', customer: 'cus_x', status: 'active' }).reason, 'no_user');
  assert.equal(store.applyStripeSubscriptionState(null).reason, 'bad_payload');
});
