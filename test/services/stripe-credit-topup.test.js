// Tier: unit (real credit store on a temp data dir, hand-built Stripe payloads) —
// lib/services/stripe-credit-topup.js.
//
// WHAT THIS COVERS
// The one place money turns into credits. Stripe delivers at-least-once and the amount
// is the only real proof of a purchase, so the cases that matter are:
//   - a redelivery does NOT double-credit,
//   - an amount below the pack price is REFUSED even with perfect metadata, which is
//     what stops a discounted or tampered session minting full credits,
//   - an unpaid session, an unknown pack and an unmappable user all return ok:false —
//     the shape routes/billing.js turns into a RELEASE, so Stripe's "Resend event"
//     still works after an operator fixes the cause,
//   - a store failure THROWS, so billing.js releases and answers 500 and Stripe retries,
//   - the clawback path takes credits back and suspends on a shortfall.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb } from '../../lib/data/db.js';
import { createApiBilling } from '../../lib/data/api-billing.js';
import { createCreditPacks } from '../../lib/data/credit-packs.js';
import { createStripeCreditTopup } from '../../lib/services/stripe-credit-topup.js';

const tempDirs = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-topup-'));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop();
    try { closeDb(d); } catch { /* already closed */ }
    fs.rmSync(d, { recursive: true, force: true });
  }
});

const USER = { id: 'user_1', email: 'dev@example.com' };

function setup(over = {}) {
  const billing = over.billing || createApiBilling(tempDir());
  const creditPacks = createCreditPacks({
    api_20: 'price_20', api_50: 'price_50', api_100: 'price_100', api_500: 'price_500',
  });
  const authStore = {
    findUserById: (id) => (id === USER.id ? USER : null),
    findUserByStripeIds: ({ stripeCustomerId }) => (stripeCustomerId === 'cus_known' ? USER : null),
  };
  const topup = createStripeCreditTopup({ apiBilling: billing, creditPacks, authStore });
  return { billing, topup, creditPacks };
}

/** A paid checkout session for the 100-credit pack. */
const session = (over = {}) => ({
  id: 'cs_1',
  mode: 'payment',
  payment_status: 'paid',
  amount_total: 1300,
  currency: 'usd',
  client_reference_id: USER.id,
  metadata: { stagify_api_pack: 'api_100', stagify_user_id: USER.id },
  ...over,
});

test('a paid session credits the pack exactly once, however often it is delivered', () => {
  const { billing, topup } = setup();

  const first = topup.handleCreditTopup(session());
  assert.equal(first.ok, true);
  assert.equal(first.credited, 100);
  assert.equal(billing.getBalance(USER.id).balance, 100);

  const redelivery = topup.handleCreditTopup(session());
  assert.equal(redelivery.ok, true, 'a duplicate must still mark the event done');
  assert.equal(redelivery.duplicate, true);
  assert.equal(redelivery.credited, 0);
  assert.equal(billing.getBalance(USER.id).balance, 100, 'Stripe redelivery must not double-credit');
});

test('an amount below the pack price is refused, however good the metadata looks', () => {
  // Credits granted must be justified by money actually received — never by a
  // metadata field alone.
  const { billing, topup } = setup();
  const out = topup.handleCreditTopup(session({ amount_total: 1 }));

  assert.equal(out.ok, false);
  assert.equal(out.reason, 'amount_mismatch');
  assert.equal(billing.getBalance(USER.id).balance, 0);
});

test('a mismatched currency is refused too', () => {
  const { topup } = setup();
  const out = topup.handleCreditTopup(session({ currency: 'eur', amount_total: 1300 }));
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'amount_mismatch');
});

test('an overpayment still credits — it is an underpayment that must not', () => {
  const { billing, topup } = setup();
  assert.equal(topup.handleCreditTopup(session({ amount_total: 1400 })).ok, true);
  assert.equal(billing.getBalance(USER.id).balance, 100);
});

test('an unpaid session is released, not credited and not marked done', () => {
  const { billing, topup } = setup();
  const out = topup.handleCreditTopup(session({ payment_status: 'unpaid' }));

  assert.equal(out.ok, false, 'ok:false is what makes billing.js RELEASE the event id');
  assert.equal(out.reason, 'not_paid');
  assert.equal(billing.getBalance(USER.id).balance, 0);
});

test('an unknown pack id is released for an operator, not silently swallowed', () => {
  const { topup } = setup();
  const out = topup.handleCreditTopup(session({ metadata: { stagify_api_pack: 'api_9999' } }));
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'unknown_pack');
});

test('a session that maps to no account is released so the money can be reconciled', () => {
  const { topup } = setup();
  const out = topup.handleCreditTopup(session({ client_reference_id: 'ghost', customer: 'cus_unknown' }));
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no_user');
});

test('the Stripe customer id is a fallback for the user, but an email is NOT', () => {
  const { billing, topup } = setup();

  const byCustomer = topup.handleCreditTopup(
    session({ client_reference_id: null, customer: 'cus_known' }),
  );
  assert.equal(byCustomer.ok, true, 'a known customer id resolves the buyer');
  assert.equal(billing.getBalance(USER.id).balance, 100);

  // An address alone must never direct a top-up: it is unverified, and unlike the
  // subscription path there is no existing relationship for it to merely confirm.
  const byEmail = topup.handleCreditTopup(
    session({ id: 'cs_2', client_reference_id: null, customer: null, customer_email: USER.email }),
  );
  assert.equal(byEmail.ok, false);
  assert.equal(byEmail.reason, 'no_user');
});

test('a store failure THROWS, so billing.js releases and Stripe retries', () => {
  // Returning ok:false here would be wrong: nothing needs fixing, the write just
  // failed, and a retry is exactly what should happen.
  const { topup } = setup({
    billing: {
      creditPurchase: () => { throw new Error('database is locked'); },
      getBalance: () => ({ balance: 0, suspendedAt: null }),
      clawbackCredits: () => ({ ok: true }),
    },
  });
  assert.throws(() => topup.handleCreditTopup(session()), /database is locked/);
});

test('isCreditSession only claims one-time sessions carrying our marker', () => {
  const { topup } = setup();
  assert.equal(topup.isCreditSession(session()), true);
  assert.equal(topup.isCreditSession(session({ mode: 'subscription' })), false, 'a subscription is not ours');
  assert.equal(topup.isCreditSession(session({ metadata: {} })), false);
  assert.equal(topup.isCreditSession(null), false);
});

test('a chargeback takes the credits back and suspends when they were already spent', () => {
  const { billing, topup } = setup();
  topup.handleCreditTopup(session());
  // Spend most of the pack, then dispute the payment.
  for (let i = 0; i < 98; i += 1) {
    const c = billing.claimAndDebit({
      keyId: 'ak_1', userId: USER.id, idempotencyKey: 'k' + i, fingerprint: 'f' + i, cost: 1,
    });
    billing.markSucceeded(c.requestId);
  }

  const out = topup.handleCreditClawback({
    id: 'ch_1',
    metadata: { stagify_api_pack: 'api_100', stagify_user_id: USER.id },
  });

  assert.equal(out.ok, true);
  assert.equal(out.clawed, 2, 'only what was left can be taken');
  assert.equal(billing.getBalance(USER.id).balance, 0);
  assert.ok(billing.getBalance(USER.id).suspendedAt, 'spend-then-chargeback must not be free renders');
});

test('a clawback is idempotent, and a charge that is not ours is a no-op', () => {
  const { billing, topup } = setup();
  topup.handleCreditTopup(session());

  const charge = { id: 'ch_2', metadata: { stagify_api_pack: 'api_100', stagify_user_id: USER.id } };
  topup.handleCreditClawback(charge);
  const again = topup.handleCreditClawback(charge);
  assert.equal(again.duplicate, true);
  assert.equal(billing.getBalance(USER.id).balance, 0);

  const foreign = topup.handleCreditClawback({ id: 'ch_3', metadata: {} });
  assert.equal(foreign.ok, true, 'a subscription refund is handled, not released forever');
  assert.equal(foreign.clawed, 0);
});
