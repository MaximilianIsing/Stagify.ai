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
import { createAuthStore } from '../lib/data/auth-store.js';

const tempDirs = [];
const openStores = [];
function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-authstore-'));
  tempDirs.push(dir);
  const store = createAuthStore(dir);
  openStores.push(store);
  return store;
}
afterEach(() => {
  // Close SQLite handles before removing the temp dir so Windows can unlink the
  // .db / -wal / -shm files (an open handle would otherwise lock them).
  while (openStores.length) {
    try { openStores.pop().close(); } catch { /* already closed */ }
  }
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

test('startRegistration does not reveal that an email is already taken', () => {
  const store = freshStore();
  registerVerifiedUser(store, 'taken@example.com', 'CorrectHorse9!');

  // A second sign-up for the same email must NOT surface an "already exists"
  // error (that would make sign-up an account-enumeration oracle). Instead it
  // reports ok + alreadyExists so the route sends a notice, never a code.
  const again = store.startRegistration('taken@example.com', 'Different0ne!');
  assert.equal(again.ok, true, 'no enumerable error for a taken email');
  assert.equal(again.alreadyExists, true, 'flags the dup for the route (notice, not code)');
  assert.equal(again.code, undefined, 'never issues a verification code for an existing account');
  assert.equal(again.toEmail, 'taken@example.com');

  // The existing account is untouched: its original password still logs in and
  // the duplicate attempt created no pending it could verify into.
  assert.equal(store.login('taken@example.com', 'CorrectHorse9!').ok, true, 'original login still works');
  assert.equal(store.login('taken@example.com', 'Different0ne!').ok, false, 'the dup attempt set no password');
  assert.equal(
    store.completeRegistration('taken@example.com', '000000').ok,
    false,
    'no pending registration exists to verify into',
  );
});

test('login gives one generic error for missing, wrong-password, and Google-only accounts', () => {
  const store = freshStore();
  registerVerifiedUser(store, 'pw@example.com', 'CorrectHorse9!');
  store.loginWithGoogle({ email: 'goog@example.com', googleSub: 'sub-xyz' });

  const missing = store.login('nobody@example.com', 'whatever!');
  const wrongPw = store.login('pw@example.com', 'wrong-password!');
  const googleOnly = store.login('goog@example.com', 'whatever!');

  for (const r of [missing, wrongPw, googleOnly]) {
    assert.equal(r.ok, false);
  }
  // Identical wording across all three so login can't distinguish "no such user"
  // from "wrong password" from "this is a Google account".
  assert.equal(missing.error, wrongPw.error, 'missing vs wrong-password errors match');
  assert.equal(missing.error, googleOnly.error, 'a Google-only account is indistinguishable too');
  assert.equal(missing.error, 'Invalid email or password');
});

// The free-tier daily cap IS enforced server-side, before any paid AI call:
// freeGenerationStatus reports the remaining allowance and recordFreeGeneration
// drives it. (recordMobileIpGeneration is retained only for backup/rollback shape;
// the anonymous mobile path no longer calls it — staging now requires sign-in.)
test('recordFreeGeneration increments the per-day usage counter', () => {
  const store = freshStore();
  const u = registerVerifiedUser(store);
  assert.equal(store.recordFreeGeneration(u.id).dailyGenerationsUsed, 1);
  assert.equal(store.recordFreeGeneration(u.id).dailyGenerationsUsed, 2);
});

test('freeGenerationStatus enforces the free daily cap', () => {
  const store = freshStore();
  const u = registerVerifiedUser(store);

  const before = store.freeGenerationStatus(u.id);
  assert.equal(before.allowed, true, 'a fresh free user may generate');
  assert.equal(before.used, 0);
  assert.ok(before.limit > 0, 'the free tier has a finite daily cap');

  // Burn through the entire daily allowance.
  for (let i = 0; i < before.limit; i++) store.recordFreeGeneration(u.id);

  const after = store.freeGenerationStatus(u.id);
  assert.equal(after.used, before.limit, 'usage reached the cap');
  assert.equal(after.allowed, false, 'at the cap, the next generation is blocked');

  // An unknown user is treated as uncapped (no free row to charge against).
  assert.deepEqual(store.freeGenerationStatus('no-such-user'), { allowed: true, used: 0, limit: null });
});

test('recordMobileIpGeneration increments a separate counter per IP', () => {
  const store = freshStore();
  assert.equal(store.recordMobileIpGeneration('203.0.113.7').used, 1);
  assert.equal(store.recordMobileIpGeneration('203.0.113.7').used, 2);
  assert.equal(store.recordMobileIpGeneration('198.51.100.9').used, 1, 'a different IP counts separately');
});
