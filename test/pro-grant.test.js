// Admin comp grants — "give this free account one month of Stagify+", with no
// Stripe subscription behind it (lib/data/pro-grants.js + the two admin routes).
//
// WHAT THIS COVERS
//   - the pure month arithmetic, including the Jan-31 clamp,
//   - granting: a free account becomes pro with an expiry ~1 month out, and the
//     grant survives a close/reopen (it rides in extra_json — no schema migration),
//   - EXPIRY IS ENFORCED ON READ: a lapsed grant reads as plan:'free' everywhere,
//     which is the whole safety story since there is no sweep job,
//   - the refusals: already-pro accounts and Stripe subscribers are never touched,
//   - revoking early, and a real Stripe checkout clearing the grant so a paying
//     subscriber can't be downgraded when the old grant date passes,
//   - the route contract: key-gated, validates input, surfaces store refusals as 400.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuthStore } from '../lib/data/auth-store.js';
import { oneMonthFrom, isGrantActive } from '../lib/data/pro-grants.js';
import { mountAdmin, ADMIN_KEY } from './helpers/admin-app.js';

const tempDirs = [];
const openStores = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-progrant-'));
  tempDirs.push(d);
  return d;
}
function storeAt(dir) {
  const s = createAuthStore(dir);
  openStores.push(s);
  return s;
}
let app;
afterEach(async () => {
  while (openStores.length) { try { openStores.pop().close(); } catch { /* already closed */ } }
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  if (app) { await app.close(); app = null; }
});

const EMPTY = { sessions: {}, mobileIpUsage: {}, passwordResetTokens: {}, pendingRegistrations: {} };
const auth = { 'X-Stagify-Endpoint-Key': ADMIN_KEY };

function verifyUser(store, email, password = 'CorrectHorse9!') {
  const start = store.startRegistration(email, password);
  return store.completeRegistration(email, start.code);
}

// Seed a user record directly so a grant can be given an arbitrary (e.g. already
// lapsed) expiry without waiting a month.
function seedUser(store, extra) {
  store.importStore({
    ...EMPTY,
    users: [{ id: 'u_seed', email: 'seed@example.com', plan: 'free', createdAt: '2026-01-01T00:00:00.000Z', ...extra }],
  });
  return store.findUserByEmail('seed@example.com');
}

// ---- Month arithmetic ------------------------------------------------------

test('oneMonthFrom advances a calendar month and clamps a short target month', () => {
  assert.equal(oneMonthFrom(new Date('2026-07-22T10:30:00Z')).toISOString(), '2026-08-22T10:30:00.000Z');
  // Jan 31 + 1 month would overflow to Mar 3; it must land on the last of Feb.
  assert.equal(oneMonthFrom(new Date('2026-01-31T00:00:00Z')).toISOString(), '2026-02-28T00:00:00.000Z');
  assert.equal(oneMonthFrom(new Date('2028-01-31T00:00:00Z')).toISOString(), '2028-02-29T00:00:00.000Z', 'leap year');
  assert.equal(oneMonthFrom(new Date('2026-08-31T00:00:00Z')).toISOString(), '2026-09-30T00:00:00.000Z');
  assert.equal(oneMonthFrom(new Date('2026-12-15T00:00:00Z')).toISOString(), '2027-01-15T00:00:00.000Z', 'year rolls over');
});

test('isGrantActive is false for a missing, malformed, or past expiry', () => {
  assert.equal(isGrantActive(null), false);
  assert.equal(isGrantActive({}), false);
  assert.equal(isGrantActive({ proGrantExpiresAt: 'not-a-date' }), false);
  assert.equal(isGrantActive({ proGrantExpiresAt: '2020-01-01T00:00:00.000Z' }), false);
  assert.equal(isGrantActive({ proGrantExpiresAt: '2099-01-01T00:00:00.000Z' }), true);
});

// ---- Granting --------------------------------------------------------------

test('grants a free account one month of pro with no Stripe subscription', () => {
  const store = storeAt(tempDir());
  const reg = verifyUser(store, 'gift@example.com');

  const res = store.grantProMonth({ userId: reg.user.id });
  assert.equal(res.ok, true);
  assert.equal(res.email, 'gift@example.com');

  const user = store.findUserByEmail('gift@example.com');
  assert.equal(user.plan, 'pro');
  assert.equal(user.stripeSubscriptionId, undefined, 'no Stripe subscription was invented');
  assert.equal(user.stripeCustomerId, undefined, 'no Stripe customer was invented');
  assert.ok(isGrantActive(user), 'the grant is running');

  const days = (Date.parse(user.proGrantExpiresAt) - Date.now()) / 86400000;
  assert.ok(days > 27 && days < 32, `expiry is about a month out (got ${days.toFixed(1)} days)`);
});

test('a grant can be given by email and survives a close + reopen', () => {
  const dir = tempDir();
  const s1 = storeAt(dir);
  verifyUser(s1, 'byemail@example.com');
  assert.equal(s1.grantProMonth({ email: 'byemail@example.com' }).ok, true);
  s1.close();

  // Proves the grant fields round-trip through extra_json without a migration.
  const s2 = storeAt(dir);
  const user = s2.findUserByEmail('byemail@example.com');
  assert.equal(user.plan, 'pro');
  assert.ok(isGrantActive(user));
});

test('granting an unknown account fails without throwing', () => {
  const store = storeAt(tempDir());
  assert.equal(store.grantProMonth({ email: 'nobody@example.com' }).ok, false);
  assert.equal(store.grantProMonth({}).ok, false);
});

// ---- Expiry is enforced on read -------------------------------------------

test('a lapsed grant reads as free everywhere, with no sweep job', () => {
  const store = storeAt(tempDir());
  const user = seedUser(store, {
    plan: 'pro',
    proGrantedAt: '2026-05-01T00:00:00.000Z',
    proGrantExpiresAt: '2026-06-01T00:00:00.000Z', // in the past
  });
  assert.equal(user.plan, 'free', 'findUserByEmail downgrades the lapsed grant');
  assert.equal(store.exportStore().users[0].plan, 'free', 'the admin snapshot agrees');
  assert.equal(store.freeGenerationStatus('u_seed').limit, 50, 'free daily cap applies again');
});

test('an unexpired grant still reads as pro', () => {
  const store = storeAt(tempDir());
  const user = seedUser(store, { plan: 'pro', proGrantExpiresAt: '2099-01-01T00:00:00.000Z' });
  assert.equal(user.plan, 'pro');
  assert.equal(store.freeGenerationStatus('u_seed').limit, null, 'uncapped while the grant runs');
});

test('a lapsed grant never downgrades a real Stripe subscriber', () => {
  const store = storeAt(tempDir());
  const user = seedUser(store, {
    plan: 'pro',
    proGrantExpiresAt: '2026-06-01T00:00:00.000Z',
    stripeSubscriptionId: 'sub_live',
  });
  assert.equal(user.plan, 'pro', 'the subscription wins over the stale grant date');
});

// ---- Refusals --------------------------------------------------------------

test('refuses an account that already has Stagify+', () => {
  const store = storeAt(tempDir());
  const reg = verifyUser(store, 'already@example.com');
  assert.equal(store.grantProMonth({ userId: reg.user.id }).ok, true);

  const second = store.grantProMonth({ userId: reg.user.id });
  assert.equal(second.ok, false, 'a second grant cannot overwrite the running one');
  assert.match(second.error, /already has Stagify\+/);
});

test('refuses a Stripe subscriber and leaves the record untouched', () => {
  const store = storeAt(tempDir());
  seedUser(store, { plan: 'free', stripeSubscriptionId: 'sub_live' });

  const res = store.grantProMonth({ userId: 'u_seed' });
  assert.equal(res.ok, false);
  assert.match(res.error, /Stripe/);
  assert.equal(store.findUserByEmail('seed@example.com').proGrantExpiresAt, undefined, 'nothing was written');
});

// ---- Revoking + Stripe takeover -------------------------------------------

test('revoking a grant drops the account back to free immediately', () => {
  const store = storeAt(tempDir());
  const reg = verifyUser(store, 'revoke@example.com');
  store.grantProMonth({ userId: reg.user.id });

  assert.equal(store.revokeProGrant(reg.user.id).ok, true);
  const user = store.findUserByEmail('revoke@example.com');
  assert.equal(user.plan, 'free');
  assert.equal(isGrantActive(user), false);
  assert.ok(user.proGrantRevokedAt, 'the revocation is recorded');

  const again = store.revokeProGrant(reg.user.id);
  assert.equal(again.ok, false, 'nothing left to revoke');
});

test('revoking refuses an unknown user and a Stripe subscriber', () => {
  const store = storeAt(tempDir());
  assert.equal(store.revokeProGrant('u_missing').ok, false);
  seedUser(store, { plan: 'pro', proGrantExpiresAt: '2099-01-01T00:00:00.000Z', stripeSubscriptionId: 'sub_live' });
  assert.match(store.revokeProGrant('u_seed').error, /Stripe/);
});

test('subscribing during a grant clears the expiry so the account is never downgraded', () => {
  const store = storeAt(tempDir());
  const reg = verifyUser(store, 'converts@example.com');
  store.grantProMonth({ userId: reg.user.id });

  store.activateProFromStripeCheckout({
    userId: reg.user.id, stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1',
  });

  const user = store.findUserByEmail('converts@example.com');
  assert.equal(user.plan, 'pro');
  assert.equal(isGrantActive(user), false, 'the grant is gone; the subscription carries the account now');
});

// ---- Route contract --------------------------------------------------------

test('grant + revoke endpoints are behind the admin access key', async () => {
  app = await mountAdmin();
  for (const p of ['/api/admin/grant-plus', '/api/admin/revoke-plus']) {
    const res = await fetch(app.baseUrl + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'u_1' }),
    });
    assert.equal(res.status, 403, `${p} rejects a request with no key`);
  }
  assert.equal(app.calls.grantProMonth.calls, 0, 'the store was never reached');
  assert.equal(app.calls.revokeProGrant.calls, 0);
});

test('grant endpoint requires a target and passes it to the store', async () => {
  app = await mountAdmin();
  const missing = await fetch(app.baseUrl + '/api/admin/grant-plus', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(missing.status, 400);
  assert.equal(app.calls.grantProMonth.calls, 0);

  const ok = await fetch(app.baseUrl + '/api/admin/grant-plus', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'u_1' }),
  });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.ok, true);
  assert.equal(body.expiresAt, '2026-08-22T00:00:00.000Z', 'the expiry is returned for the UI');
  assert.deepEqual(app.calls.grantProMonth.lastArgs[0], { userId: 'u_1', email: undefined });
});

test('a store refusal surfaces as a 400 with its reason', async () => {
  app = await mountAdmin({ grantResult: { ok: false, error: 'This account already has Stagify+.' } });
  const res = await fetch(app.baseUrl + '/api/admin/grant-plus', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'someone@example.com' }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /already has Stagify\+/);
});

test('revoke endpoint requires a userId and returns the revoked account', async () => {
  app = await mountAdmin();
  const missing = await fetch(app.baseUrl + '/api/admin/revoke-plus', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(missing.status, 400);

  const ok = await fetch(app.baseUrl + '/api/admin/revoke-plus', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'u_1' }),
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).email, 'granted@example.com');
});
