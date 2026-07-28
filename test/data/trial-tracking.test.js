// Tier 2 — the trial-tracking store slice (lib/data/trial-tracking.js).
//
// The trial EMAIL sequence is covered in services/trial-lifecycle.test.js; this
// covers the store side it reads through, and specifically listTrialCandidates,
// which the hourly sweep calls. That query is narrowed to `plan = 'pro'` in SQL so
// it doesn't JSON.parse extra_json for every account in the table, and the tests
// below pin the things that narrowing must not change.
//
// Everything here drives the store through its PUBLIC api (Stripe activation, comp
// grants, export/import) rather than writing rows directly, so the specs don't
// depend on internals that are free to move.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuthStore } from '../../lib/data/auth-store.js';
import { createTrialTracking } from '../../lib/data/trial-tracking.js';

const tempDirs = [];
const openStores = [];
function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-trialtrack-'));
  tempDirs.push(dir);
  const store = createAuthStore(dir);
  openStores.push(store);
  return store;
}
afterEach(() => {
  while (openStores.length) { try { openStores.pop().close(); } catch { /* already closed */ } }
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function registerVerified(store, email) {
  const start = store.startRegistration(email, 'CorrectHorse9!');
  const done = store.completeRegistration(email, start.code);
  assert.equal(done.ok, true, `registration failed: ${done.error || ''}`);
  return done.user;
}

/** A subscription-backed pro account. `startTrial: false` leaves it out of the sequence. */
function subscriber(store, email, sub, { startTrial = true } = {}) {
  const user = registerVerified(store, email);
  const activated = store.activateProFromStripeCheckout({
    userId: user.id,
    stripeCustomerId: `cus_${sub}`,
    stripeSubscriptionId: sub,
  });
  assert.equal(activated.ok, true, `activation failed: ${activated.reason || ''}`);
  if (startTrial) store.beginTrial(user.id, new Date().toISOString());
  return user;
}

const candidateIds = (store) => store.listTrialCandidates().map((u) => u.id).sort();

test('listTrialCandidates returns only pro accounts that are actually mid-trial', () => {
  const store = freshStore();
  const tracked = subscriber(store, 'tracked@example.com', 'sub_tracked');
  registerVerified(store, 'free-nobody@example.com');
  // Pro, but never entered the sequence — no trialLifecycle.startAt, so not swept.
  const noTrial = subscriber(store, 'pro-no-trial@example.com', 'sub_plain', { startTrial: false });

  assert.deepEqual(candidateIds(store), [tracked.id]);
  assert.ok(!candidateIds(store).includes(noTrial.id), 'pro without a trial start is not a candidate');
});

test('a cancelled subscriber keeps its trial history but stops being a candidate', () => {
  // The sweep must not keep emailing someone whose trial ended. The trialLifecycle
  // blob stays on the row as history, so `plan` is what decides — which is exactly
  // the column the SQL now filters on.
  const store = freshStore();
  subscriber(store, 'churned@example.com', 'sub_churn');
  assert.equal(candidateIds(store).length, 1, 'precondition: swept while pro');

  const applied = store.applyStripeSubscriptionState({
    id: 'sub_churn',
    customer: 'cus_sub_churn',
    status: 'canceled',
  });
  assert.equal(applied.plan, 'free', 'precondition: the cancel downgraded the account');

  assert.deepEqual(candidateIds(store), [], 'no longer swept once downgraded');
  const row = store.exportStore().users.find((u) => u.email === 'churned@example.com');
  assert.ok(row.trialLifecycle && row.trialLifecycle.startAt, 'but the trial history survives');
});

test('an EXPIRED comp grant is excluded even though its stored row still says pro', () => {
  // The one case where the SQL prefilter and the final answer disagree, and the
  // reason the JS `plan === 'pro'` test has to stay. Expiry is applied on READ by
  // rowToUser, so the stored `plan` column is still 'pro' and `WHERE plan = 'pro'`
  // selects this row — the JS filter is what drops it. Delete that filter and a
  // lapsed account starts receiving trial email again.
  const store = freshStore();
  const user = registerVerified(store, 'lapsed@example.com');
  assert.equal(store.grantProMonth({ userId: user.id }).ok, true);
  store.beginTrial(user.id, new Date().toISOString());
  assert.deepEqual(candidateIds(store), [user.id], 'precondition: swept while the grant runs');

  // Back-date the grant past its expiry through the documented restore path.
  const snap = store.exportStore();
  const target = snap.users.find((u) => u.email === 'lapsed@example.com');
  target.proGrantExpiresAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  target.plan = 'pro'; // the stored column stays 'pro'; only the READ downgrades
  store.importStore(snap);

  assert.equal(store.findUserByEmail('lapsed@example.com').plan, 'free', 'reads as free once lapsed');
  assert.deepEqual(candidateIds(store), [], 'and is not swept, despite the stored plan column');
});

test('listTrialCandidates reads the pro-only accessor, never the whole users table', () => {
  // Interface guard: the cost this avoids is invisible in behaviour, so pin the
  // dependency instead. Handing the store back a full-table accessor fails here.
  let asked = 0;
  const tracking = createTrialTracking({
    findUserById: () => null,
    saveUser: () => {},
    rowToUser: (row) => row,
    proUserRows: () => { asked += 1; return []; },
    userRowByStripeSub: () => null,
    userRowByStripeCust: () => null,
  });

  assert.deepEqual(tracking.listTrialCandidates(), []);
  assert.equal(asked, 1, 'the pro-only accessor is the one it reads');
});
