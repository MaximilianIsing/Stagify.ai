// Tier: integration (real Express + real stores, faked Stripe) — routes/api-keys.js.
//
// WHAT THIS COVERS
// The signed-in dashboard's endpoints. Two properties carry the file:
//   - the plaintext key is returned by exactly ONE response in the whole app, and no
//     listing or read path ever includes it again, and
//   - ownership comes from the validated session, never from the request — another
//     account's key id answers 404, identical to one that never existed, so this is
//     not an existence oracle.
// Plus the checkout's shape, because the metadata it sets is what the webhook later
// trusts to decide how many credits a payment buys.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { closeDb } from '../../lib/data/db.js';
import { createApiKeys } from '../../lib/data/api-keys.js';
import { createApiBilling } from '../../lib/data/api-billing.js';
import { createCreditPacks } from '../../lib/data/credit-packs.js';
import createApiKeysRouter from '../../routes/api-keys.js';

const tempDirs = [];
const servers = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-api-keys-route-'));
  tempDirs.push(d);
  return d;
}
afterEach(async () => {
  while (servers.length) await new Promise((r) => servers.pop().close(r));
  while (tempDirs.length) {
    const d = tempDirs.pop();
    try { closeDb(d); } catch { /* already closed */ }
    fs.rmSync(d, { recursive: true, force: true });
  }
});

const USER = { id: 'user_1', email: 'dev@example.com', plan: 'free' };
const OTHER = { id: 'user_2', email: 'other@example.com', plan: 'free' };

async function boot(over = {}) {
  const dir = tempDir();
  const apiKeys = createApiKeys(dir);
  const apiBilling = createApiBilling(dir);
  const creditPacks = createCreditPacks(
    over.noPrices ? {} : { api_20: 'price_20', api_50: 'price_50', api_100: 'price_100', api_500: 'price_500' },
  );
  const created = [];
  const stripe = over.noStripe
    ? null
    : { checkout: { sessions: { create: async (args) => { created.push(args); return { url: 'https://stripe.test/pay' }; } } } };

  const app = express();
  app.use(
    createApiKeysRouter({
      apiKeys,
      apiBilling,
      creditPacks,
      stripe,
      // Session stand-in: the header names who you are.
      getAuthUserFromRequest: (req) => {
        const who = req.get('X-Test-User');
        if (who === USER.id) return USER;
        if (who === OTHER.id) return OTHER;
        return null;
      },
      apiKeyManageLimiter: (req, res, next) => next(),
      creditCheckoutLimiter: (req, res, next) => next(),
    }),
  );

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  return { apiKeys, apiBilling, created, base: `http://127.0.0.1:${server.address().port}` };
}

const as = (who, extra = {}) => ({ 'X-Test-User': who, 'Content-Type': 'application/json', ...extra });

test('every route requires a session', async () => {
  const { base } = await boot();
  for (const [method, url] of [
    ['GET', '/api/api-keys'],
    ['POST', '/api/api-keys'],
    ['DELETE', '/api/api-keys/ak_1'],
    ['PATCH', '/api/api-keys/ak_1'],
    ['GET', '/api/api-credits'],
    ['GET', '/api/api-usage'],
    ['POST', '/api/api-credits/checkout'],
  ]) {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' || method === 'DELETE' ? undefined : '{}' });
    assert.equal(res.status, 401, `${method} ${url}`);
    assert.equal((await res.json()).code, 'AUTH_REQUIRED');
  }
});

test('creating a key returns the plaintext exactly once, and never again', async () => {
  const { base } = await boot();

  const made = await fetch(base + '/api/api-keys', {
    method: 'POST', headers: as(USER.id), body: JSON.stringify({ name: 'CI' }),
  });
  const body = await made.json();

  assert.equal(made.status, 201);
  assert.match(body.key, /^stg_live_/);
  assert.equal(body.record.name, 'CI');
  assert.equal(body.record.key, undefined, 'the record half must not carry it either');

  // Every subsequent read: no key, anywhere.
  const listed = await (await fetch(base + '/api/api-keys', { headers: as(USER.id) })).json();
  assert.equal(listed.keys.length, 1);
  assert.equal(listed.keys[0].key, undefined);
  assert.ok(!JSON.stringify(listed).includes(body.key), 'the plaintext leaked back out of a list');
  assert.match(listed.keys[0].prefix, /^stg_live_/, 'a short prefix is shown so two keys can be told apart');
  assert.ok(listed.keys[0].prefix.length < body.key.length / 2, 'the prefix must not be enough to authenticate');
});

test('a key list is scoped to its owner', async () => {
  const { base } = await boot();
  await fetch(base + '/api/api-keys', { method: 'POST', headers: as(USER.id), body: '{}' });
  await fetch(base + '/api/api-keys', { method: 'POST', headers: as(OTHER.id), body: '{}' });

  const mine = await (await fetch(base + '/api/api-keys', { headers: as(USER.id) })).json();
  const theirs = await (await fetch(base + '/api/api-keys', { headers: as(OTHER.id) })).json();
  assert.equal(mine.keys.length, 1);
  assert.equal(theirs.keys.length, 1);
  assert.notEqual(mine.keys[0].id, theirs.keys[0].id);
});

test("revoking another account's key is 404, identical to one that never existed", async () => {
  const { base, apiKeys } = await boot();
  const made = await (await fetch(base + '/api/api-keys', { method: 'POST', headers: as(USER.id), body: '{}' })).json();

  const stranger = await fetch(base + '/api/api-keys/' + made.record.id, { method: 'DELETE', headers: as(OTHER.id) });
  const missing = await fetch(base + '/api/api-keys/ak_nope', { method: 'DELETE', headers: as(OTHER.id) });

  assert.equal(stranger.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(await stranger.json(), await missing.json(), 'the two must be indistinguishable');
  assert.ok(!apiKeys.findByKey(made.key).revoked_at, 'and the key must still work');
});

test('revoking your own key works, and is visible in the listing', async () => {
  const { base, apiKeys } = await boot();
  const made = await (await fetch(base + '/api/api-keys', { method: 'POST', headers: as(USER.id), body: '{}' })).json();

  const res = await fetch(base + '/api/api-keys/' + made.record.id, { method: 'DELETE', headers: as(USER.id) });
  assert.equal(res.status, 200);
  assert.ok(apiKeys.findByKey(made.key).revoked_at);

  const listed = await (await fetch(base + '/api/api-keys', { headers: as(USER.id) })).json();
  assert.ok(listed.keys[0].revokedAt, 'a revoked key stays listed so it can be recognised in logs');
});

test('renaming is owner-scoped', async () => {
  const { base } = await boot();
  const made = await (await fetch(base + '/api/api-keys', { method: 'POST', headers: as(USER.id), body: '{}' })).json();

  const ok = await fetch(base + '/api/api-keys/' + made.record.id, {
    method: 'PATCH', headers: as(USER.id), body: JSON.stringify({ name: 'staging box' }),
  });
  assert.equal((await ok.json()).record.name, 'staging box');

  const nope = await fetch(base + '/api/api-keys/' + made.record.id, {
    method: 'PATCH', headers: as(OTHER.id), body: JSON.stringify({ name: 'mine now' }),
  });
  assert.equal(nope.status, 404);
});

test('the credits view reports the balance and its ledger', async () => {
  const { base, apiBilling } = await boot();
  apiBilling.creditPurchase({ userId: USER.id, credits: 100, sessionId: 'cs_1' });

  const body = await (await fetch(base + '/api/api-credits', { headers: as(USER.id) })).json();
  assert.equal(body.balance, 100);
  assert.equal(body.lifetimePurchased, 100);
  assert.equal(body.suspended, false);
  assert.equal(body.ledger.length, 1);
  assert.equal(body.ledger[0].reason, 'purchase');
});

test('the pack list is public pricing and carries no Stripe price ids', async () => {
  const { base } = await boot();
  const res = await fetch(base + '/api/api-credits/packs');
  const body = await res.json();

  assert.equal(res.status, 200, 'signed-out visitors see pricing on developers.html');
  assert.equal(body.packs.length, 4);
  assert.equal(body.packs[0].id, 'api_20', 'cheapest first');
  assert.equal(body.packs[0].credits, 20);
  assert.equal(body.packs[0].amountCents, 300);
  assert.ok(!JSON.stringify(body).includes('price_'), 'price ids are ours, not the public\'s');
});

test('checkout creates a one-time session carrying the metadata the webhook trusts', async () => {
  const { base, created } = await boot();
  const res = await fetch(base + '/api/api-credits/checkout', {
    method: 'POST', headers: as(USER.id), body: JSON.stringify({ packId: 'api_500' }),
  });

  assert.equal(res.status, 200);
  assert.equal((await res.json()).url, 'https://stripe.test/pay');

  const args = created[0];
  assert.equal(args.mode, 'payment', 'credits are bought, not rented — a subscription would hit the enterprise meter');
  assert.equal(args.client_reference_id, USER.id);
  assert.equal(args.line_items[0].price, 'price_500');
  assert.equal(args.metadata.stagify_api_pack, 'api_500');
  // Copied onto the PaymentIntent so a dispute — which carries no session — can still
  // be traced back to the pack it bought.
  assert.equal(args.payment_intent_data.metadata.stagify_api_pack, 'api_500');
  assert.equal(args.payment_intent_data.metadata.stagify_user_id, USER.id);
});

test('checkout reuses an existing Stripe customer rather than the email', async () => {
  const { base, created } = await boot();
  USER.stripeCustomerId = 'cus_existing';
  try {
    await fetch(base + '/api/api-credits/checkout', {
      method: 'POST', headers: as(USER.id), body: JSON.stringify({ packId: 'api_100' }),
    });
    assert.equal(created[0].customer, 'cus_existing');
    assert.equal(created[0].customer_email, undefined, 'naming both is a Stripe error');
  } finally {
    delete USER.stripeCustomerId;
  }
});

test('an unknown pack is 400 and no Stripe session is created', async () => {
  const { base, created } = await boot();
  const res = await fetch(base + '/api/api-credits/checkout', {
    method: 'POST', headers: as(USER.id), body: JSON.stringify({ packId: 'api_free_please' }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'UNKNOWN_PACK');
  assert.equal(created.length, 0);
});

test('unconfigured billing degrades to 503 rather than a broken checkout', async () => {
  const noStripe = await boot({ noStripe: true });
  const res = await fetch(noStripe.base + '/api/api-credits/checkout', {
    method: 'POST', headers: as(USER.id), body: JSON.stringify({ packId: 'api_100' }),
  });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'STRIPE_DISABLED');

  // And with Stripe up but no price ids configured, nothing is offered for sale.
  const noPrices = await boot({ noPrices: true });
  const packs = await (await fetch(noPrices.base + '/api/api-credits/packs')).json();
  assert.equal(packs.packs.length, 0, 'a pack with no price id would send the buyer to a broken session');
});

// ── GET /api/api-usage ───────────────────────────────────────────────────────
//
// The dashboard's third read, and the newest. Two things matter here and nowhere else:
// it is scoped to the validated session (traffic is as private as the keys that made
// it), and its `days` parameter reaches a clamp rather than the query planner.

test('usage is scoped to the session, not to anything the caller sends', async () => {
  const { base, apiBilling } = await boot();
  apiBilling.creditPurchase({ userId: USER.id, credits: 10, sessionId: 'cs_usage' });
  const claimed = apiBilling.claimAndDebit({
    keyId: 'ak_mine', userId: USER.id, idempotencyKey: 'i1', fingerprint: 'f1', cost: 1,
  });
  apiBilling.markSucceeded(claimed.requestId);

  const mine = await (await fetch(base + '/api/api-usage', { headers: as(USER.id) })).json();
  assert.equal(mine.totals.delivered, 1);
  assert.deepEqual(mine.keys.map((k) => k.keyId), ['ak_mine']);

  // The other account sees its own empty summary, not a 404 and not somebody else's
  // traffic. There is no id in the request to tamper with — that is the point.
  const theirs = await (await fetch(base + '/api/api-usage', { headers: as(OTHER.id) })).json();
  assert.equal(theirs.totals.delivered, 0);
  assert.deepEqual(theirs.keys, []);
});

test('the days parameter is clamped, and junk falls back to the default', async () => {
  const { base } = await boot();
  const days = async (q) => (await (await fetch(base + '/api/api-usage' + q, { headers: as(USER.id) })).json()).days;

  assert.equal(await days(''), 30);
  assert.equal(await days('?days=7'), 7);
  assert.equal(await days('?days=99999'), 90, 'a caller cannot ask for an unbounded scan');
  assert.equal(await days('?days=notanumber'), 30);
  assert.equal(await days('?days=-1'), 1);
});

test('the summary carries a bucket per day even for an account with no traffic', async () => {
  // The chart renders columns from these; an empty array would collapse it into
  // something that looks like a failed request rather than a quiet month.
  const { base } = await boot();
  const body = await (await fetch(base + '/api/api-usage?days=14', { headers: as(USER.id) })).json();
  assert.equal(body.buckets.length, 14);
  assert.ok(body.buckets.every((b) => b.delivered === 0 && b.refunded === 0));
  assert.equal(body.totals.medianMs, null);
});
