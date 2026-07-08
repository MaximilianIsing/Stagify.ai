// SQLite-specific auth-store behavior: on-disk persistence, the one-time legacy
// auth-store.json → SQLite migration (user-data safety), and the exportStore /
// importStore round-trip used for the admin backup and migration. The auth-store's
// functional behavior (register/login/sessions/reset) is covered in auth-store.test.js.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuthStore } from '../lib/auth-store.js';

const tempDirs = [];
const openStores = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-authsqlite-'));
  tempDirs.push(d);
  return d;
}
function storeAt(dir) {
  const s = createAuthStore(dir);
  openStores.push(s);
  return s;
}
afterEach(() => {
  while (openStores.length) { try { openStores.pop().close(); } catch { /* already closed */ } }
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

// Register + verify a user; returns { ok, token, user }.
function verifyUser(store, email, password = 'CorrectHorse9!') {
  const start = store.startRegistration(email, password);
  return store.completeRegistration(email, start.code);
}

// Drop a legacy auth-store.json where createAuthStore will look for it.
function seedLegacyJson(dir, data) {
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'auth-store.json'), JSON.stringify(data));
}

const EMPTY = { sessions: {}, mobileIpUsage: {}, passwordResetTokens: {}, pendingRegistrations: {} };

test('persists users to disk across a close + reopen', () => {
  const dir = tempDir();
  const s1 = storeAt(dir);
  verifyUser(s1, 'persist@example.com');
  s1.close();

  const s2 = storeAt(dir);
  assert.ok(s2.findUserByEmail('persist@example.com'), 'the user survived a restart');
});

test('imports a legacy auth-store.json on first open, preserving unknown fields', () => {
  const dir = tempDir();
  const future = Date.now() + 7 * 24 * 60 * 60 * 1000;
  seedLegacyJson(dir, {
    users: [{
      id: 'u_legacy', email: 'old@example.com', passwordSalt: 'salt', passwordHash: 'hash',
      plan: 'pro', createdAt: '2024-01-01T00:00:00.000Z', stripeCustomerId: 'cus_1',
      referralSource: 'twitter', // unknown key → must survive via extra_json
    }],
    sessions: { tok_legacy: { userId: 'u_legacy', exp: future } },
    mobileIpUsage: {}, passwordResetTokens: {}, pendingRegistrations: {},
  });

  const store = storeAt(dir);
  assert.equal(store.getUserCount(), 1);
  const u = store.findUserByEmail('old@example.com');
  assert.equal(u.plan, 'pro');
  assert.equal(u.stripeCustomerId, 'cus_1');
  assert.equal(u.referralSource, 'twitter', 'unknown legacy field preserved through the migration');
  assert.equal(store.validateSession('tok_legacy')?.id, 'u_legacy', 'the legacy session was imported');
});

test('the legacy import is one-time — a restart never clobbers live SQLite data', () => {
  const dir = tempDir();
  seedLegacyJson(dir, {
    users: [{ id: 'u_legacy', email: 'old@example.com', plan: 'free', createdAt: '2024-01-01T00:00:00.000Z' }],
    ...EMPTY,
  });

  const s1 = storeAt(dir);
  assert.equal(s1.getUserCount(), 1);
  verifyUser(s1, 'new@example.com'); // mutate SQLite after the import
  assert.equal(s1.getUserCount(), 2);
  s1.close();

  // The auth-store.json is still on disk. Reopening must NOT re-import it (a re-import
  // REPLACES all state and would drop the post-migration user).
  const s2 = storeAt(dir);
  assert.equal(s2.getUserCount(), 2, 'the legacy JSON did not re-import over live data');
  assert.ok(s2.findUserByEmail('new@example.com'), 'the post-migration user survived the restart');
});

test('a legacy JSON that appears after the first boot is ignored', () => {
  const dir = tempDir();
  const s1 = storeAt(dir); // fresh DB, no JSON → migration is marked done
  verifyUser(s1, 'live@example.com');
  s1.close();

  // Someone drops a stale JSON next to the DB later.
  seedLegacyJson(dir, {
    users: [{ id: 'u_stale', email: 'stale@example.com', plan: 'pro', createdAt: '2020-01-01T00:00:00.000Z' }],
    ...EMPTY,
  });
  const s2 = storeAt(dir);
  assert.ok(s2.findUserByEmail('live@example.com'), 'live data is intact');
  assert.equal(s2.findUserByEmail('stale@example.com'), null, 'the later-appearing JSON was not imported');
});

test('exportStore / importStore round-trips all state', () => {
  const a = storeAt(tempDir());
  const reg = verifyUser(a, 'rt@example.com');
  const snap = a.exportStore();
  assert.ok(snap.users.some((x) => x.email === 'rt@example.com'));

  const b = storeAt(tempDir());
  b.importStore(snap);
  assert.equal(b.getUserCount(), a.getUserCount());
  assert.equal(b.findUserByEmail('rt@example.com').id, reg.user.id);
  assert.equal(b.validateSession(reg.token)?.email, 'rt@example.com', 'the session round-tripped');
  assert.deepEqual(b.exportStore(), snap, 'the full export is identical after a round-trip');
});

test('importStore replaces all prior state (transactional, not a merge)', () => {
  const s = storeAt(tempDir());
  s.importStore({ ...EMPTY, users: [{ id: 'u_a', email: 'a@x.com', plan: 'free', createdAt: '2024-01-01T00:00:00.000Z' }] });
  assert.ok(s.findUserByEmail('a@x.com'));

  s.importStore({ ...EMPTY, users: [{ id: 'u_b', email: 'b@x.com', plan: 'pro', createdAt: '2024-01-01T00:00:00.000Z' }] });
  assert.equal(s.getUserCount(), 1, 'replace, not merge');
  assert.equal(s.findUserByEmail('a@x.com'), null, 'the prior user was removed');
  assert.equal(s.findUserByEmail('b@x.com').plan, 'pro');
});
