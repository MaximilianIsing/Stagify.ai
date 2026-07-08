// Tier 2 (extends B/C) — enterprise domain store (lib/enterprise-store.js).
//
// The last untested billing module. Pure file-backed logic — a temp dir per test,
// no mocks, no Stripe. Covers domain activation and keeping domain status in sync
// with the Stripe subscription lifecycle.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEnterpriseStore } from '../lib/enterprise-store.js';

const tempDirs = [];
const openStores = [];
function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-enterprise-'));
  tempDirs.push(dir);
  const store = createEnterpriseStore(dir);
  openStores.push(store);
  return store;
}
afterEach(() => {
  // Close SQLite handles before removing the temp dir (Windows file locks).
  while (openStores.length) {
    try { openStores.pop().close(); } catch { /* already closed */ }
  }
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

const activate = (store, over = {}) =>
  store.activateDomain({
    domain: 'acme.com',
    companyName: 'Acme Inc',
    contactEmail: 'ops@acme.com',
    stripeCustomerId: 'cus_ent',
    stripeSubscriptionId: 'sub_ent',
    ...over,
  });

test('activateDomain activates a domain (case-insensitive) with its details', () => {
  const store = freshStore();
  const res = activate(store, { domain: 'ACME.com' });
  assert.equal(res.ok, true);
  assert.equal(res.domain, 'acme.com', 'domain is normalized to lowercase');

  assert.equal(store.isActiveDomain('acme.com'), true);
  assert.equal(store.isActiveDomain('AcMe.CoM'), true, 'lookup is case-insensitive');
  const entry = store.getDomainEntry('acme.com');
  assert.equal(entry.companyName, 'Acme Inc');
  assert.equal(entry.status, 'active');
});

test('activateDomain is idempotent — re-activating updates the same entry', () => {
  const store = freshStore();
  activate(store);
  activate(store, { companyName: 'Acme Renamed' });
  assert.equal(store.getAllDomains().length, 1, 'no duplicate entry is created');
  assert.equal(store.getDomainEntry('acme.com').companyName, 'Acme Renamed');
});

test('applySubscriptionState cancels the domain when the subscription ends', () => {
  const store = freshStore();
  activate(store);
  assert.equal(store.isActiveDomain('acme.com'), true);

  const res = store.applySubscriptionState({ id: 'sub_ent', customer: 'cus_ent', status: 'canceled' });
  assert.equal(res.ok, true);
  assert.equal(res.status, 'cancelled');
  assert.equal(store.isActiveDomain('acme.com'), false, 'a cancelled domain is no longer active');
});

test('applySubscriptionState re-activates on renewal, matching by customer id', () => {
  const store = freshStore();
  activate(store); // sub_ent / cus_ent
  store.applySubscriptionState({ id: 'sub_ent', customer: 'cus_ent', status: 'canceled' });
  assert.equal(store.isActiveDomain('acme.com'), false);

  // A renewal can arrive with a NEW subscription id → must still match by customer id.
  const res = store.applySubscriptionState({ id: 'sub_new', customer: 'cus_ent', status: 'active' });
  assert.equal(res.ok, true);
  assert.equal(store.isActiveDomain('acme.com'), true, 'an active subscription re-activates the domain');
  assert.equal(store.getEntryByStripeSubscriptionId('sub_new')?.domain, 'acme.com', 'the new sub id is recorded');
});

test('applySubscriptionState rejects bad payloads and unknown subscriptions', () => {
  const store = freshStore();
  assert.equal(store.applySubscriptionState(null).reason, 'bad_payload');
  assert.equal(
    store.applySubscriptionState({ id: 'sub_missing', customer: 'cus_missing', status: 'active' }).reason,
    'no_enterprise_domain',
  );
});

test('recordUsage increments a domain counter and no-ops for unknown domains', () => {
  const store = freshStore();
  activate(store);
  store.recordUsage('acme.com', 3);
  store.recordUsage('acme.com');
  assert.equal(store.getDomainEntry('acme.com').usageCount, 4);
  assert.doesNotThrow(() => store.recordUsage('unknown.com'), 'unknown domain is a silent no-op');
});
