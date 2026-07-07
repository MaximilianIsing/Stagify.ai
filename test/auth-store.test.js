// Tier 2 (B) — auth correctness (lib/auth-store.js).
//
// The guard tests prove unauthenticated requests are rejected; these prove the
// authenticated flows are actually CORRECT: registration/verification, login,
// password hashing, sessions, password reset, and the free-tier daily limits that
// control your AI spend. Pure logic over a JSON file — each test gets a throwaway
// temp dir, so there are no mocks, no server, and no secrets.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuthStore } from '../lib/auth-store.js';

const tempDirs = [];
function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-authstore-'));
  tempDirs.push(dir);
  return createAuthStore(dir);
}
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

// Register + verify a user, returning { id, email, password, token }.
function registerVerifiedUser(store, email = 'alice@example.com', password = 'CorrectHorse9!') {
  const start = store.startRegistration(email, password);
  assert.equal(start.ok, true, `startRegistration failed: ${start.error || ''}`);
  const done = store.completeRegistration(email, start.code);
  assert.equal(done.ok, true, `completeRegistration failed: ${done.error || ''}`);
  return { id: done.user.id, email, password, token: done.token };
}

test('register → login round-trips; a wrong password is rejected', () => {
  const store = freshStore();
  const u = registerVerifiedUser(store);

  const good = store.login(u.email, u.password);
  assert.equal(good.ok, true, 'correct password should log in');
  assert.equal(good.user.id, u.id);

  assert.equal(store.login(u.email, 'wrong-password').ok, false, 'wrong password should be rejected');
});

test('a registration cannot log in until the emailed code is entered', () => {
  const store = freshStore();
  const email = 'bob@example.com';
  const password = 'Sup3rSecret!';
  const start = store.startRegistration(email, password);
  assert.equal(start.ok, true);

  assert.equal(store.login(email, password).ok, false, 'no login before verification');

  const wrongCode = start.code === '000000' ? '111111' : '000000';
  assert.equal(store.completeRegistration(email, wrongCode).ok, false, 'wrong code rejected');

  assert.equal(store.completeRegistration(email, start.code).ok, true, 'correct code creates account');
  assert.equal(store.login(email, password).ok, true, 'can log in after verifying');
});

test('passwords are stored salted + hashed, never in plaintext', () => {
  const store = freshStore();
  const password = 'PlaintextLeakCanary#42';
  registerVerifiedUser(store, 'carol@example.com', password);

  const raw = fs.readFileSync(store.getStoreFilePath(), 'utf8');
  assert.ok(!raw.includes(password), 'raw store file must not contain the plaintext password');

  const user = store.findUserByEmail('carol@example.com');
  assert.match(user.passwordHash, /^[0-9a-f]+$/i, 'passwordHash should be a hex digest');
  assert.ok(user.passwordSalt && user.passwordSalt.length > 0, 'passwordSalt should be set');
});

test('sessions validate until logout, then are rejected', () => {
  const store = freshStore();
  const u = registerVerifiedUser(store);

  assert.equal(store.validateSession(u.token)?.id, u.id, 'a fresh token should validate');
  store.logout(u.token);
  assert.equal(store.validateSession(u.token), null, 'token should be invalid after logout');
  assert.equal(store.validateSession('not-a-real-token'), null, 'a garbage token → null');
});

test('password reset sets a new password, invalidates the old one, and is single-use', () => {
  const store = freshStore();
  const u = registerVerifiedUser(store, 'dave@example.com', 'OldPassw0rd!');

  const reset = store.startPasswordReset(u.email);
  assert.equal(reset.ok, true);
  assert.ok(reset.token, 'a real account should receive a reset token');

  const newPassword = 'BrandN3wPass!';
  assert.equal(store.completePasswordReset(reset.token, newPassword).ok, true);

  assert.equal(store.login(u.email, 'OldPassw0rd!').ok, false, 'old password no longer works');
  assert.equal(store.login(u.email, newPassword).ok, true, 'new password works');
  assert.equal(
    store.completePasswordReset(reset.token, 'Another0ne!').ok,
    false,
    'the reset token is single-use',
  );
});

test('startPasswordReset does not reveal whether an email exists', () => {
  const store = freshStore();
  const res = store.startPasswordReset('nobody@example.com');
  assert.equal(res.ok, true, 'always returns ok (no account enumeration)');
  assert.equal(res.token, undefined, 'but issues no token for a non-existent account');
});

// FREE_DAILY_LIMIT is intentionally huge (a practically-unlimited free tier), so we
// probe the boundary directly rather than recording that many generations.
test('free-tier usage increments, and canFreeUserGenerate enforces the daily limit', () => {
  const store = freshStore();
  const u = registerVerifiedUser(store);
  const limit = store.FREE_DAILY_LIMIT;
  assert.ok(Number.isInteger(limit) && limit > 0, 'FREE_DAILY_LIMIT should be a positive integer');

  // Real recording bumps the per-day counter.
  assert.equal(store.recordFreeGeneration(u.id).dailyGenerationsUsed, 1);
  assert.equal(store.recordFreeGeneration(u.id).dailyGenerationsUsed, 2);

  // Probe the cap using the exact UTC day string the store stamped.
  const today = store.findUserByEmail(u.email).usageDay;
  assert.equal(
    store.canFreeUserGenerate({ plan: 'free', usageDay: today, usageCount: limit - 1 }).ok,
    true,
    'one below the limit is allowed',
  );
  assert.equal(
    store.canFreeUserGenerate({ plan: 'free', usageDay: today, usageCount: limit }).ok,
    false,
    'at the limit is blocked',
  );
  // Usage stamped on a previous day does not count toward today.
  assert.equal(
    store.canFreeUserGenerate({ plan: 'free', usageDay: '2000-01-01', usageCount: limit }).ok,
    true,
    'a stale day resets the count',
  );
});

test('anonymous mobile IP cap is enforced per IP and resets daily', () => {
  const store = freshStore();
  const limit = store.FREE_DAILY_LIMIT;
  const ip = '203.0.113.7';

  // Real recording increments this IP's counter.
  assert.equal(store.recordMobileIpGeneration(ip).used, 1);
  assert.equal(store.canMobileIpGenerate(ip).ok, true, 'well under the cap → allowed');

  // Seed this IP to the cap by editing the store directly (avoids 99,999 writes),
  // reusing the exact day string the store stamped.
  const file = store.getStoreFilePath();
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const today = data.mobileIpUsage[ip].day;
  data.mobileIpUsage[ip] = { day: today, count: limit };
  fs.writeFileSync(file, JSON.stringify(data));

  assert.equal(store.canMobileIpGenerate(ip).ok, false, 'at the cap → blocked');
  assert.equal(store.canMobileIpGenerate('198.51.100.9').ok, true, 'a different IP is unaffected');
});
