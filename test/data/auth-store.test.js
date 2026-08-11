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
import crypto from 'node:crypto';
import { createAuthStore } from '../../lib/data/auth-store.js';

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
  // The hash carries the cost it was made at (lib/data/password-hash.js), so the
  // scrypt parameters can be raised later without a forced reset for everyone.
  assert.match(user.passwordHash, /^scrypt\$N=\d+,r=\d+,p=\d+,keylen=\d+\$[0-9a-f]+$/,
    'passwordHash should be a parameter-tagged scrypt digest');
  assert.ok(user.passwordSalt && user.passwordSalt.length > 0, 'passwordSalt should be set');
});

// Seed one account whose password hash is in the pre-2026-07 form: a bare
// crypto.scryptSync(password, salt, 64) hex digest, with no algorithm/cost
// envelope. This is what every existing production row looks like, so it is the
// state the upgrade path has to handle — written through importStore, the only
// public door into a hand-built row.
function seedLegacyPasswordRow(store, email, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  store.importStore({
    users: [{
      id: 'u_legacy_pw',
      email,
      passwordSalt: salt,
      passwordHash: crypto.scryptSync(password, salt, 64).toString('hex'),
      plan: 'free',
      createdAt: '2025-01-01T00:00:00.000Z',
    }],
    sessions: {}, mobileIpUsage: {}, passwordResetTokens: {}, pendingRegistrations: {},
  });
  const seeded = store.findUserByEmail(email);
  assert.ok(!seeded.passwordHash.includes('$'), 'precondition: the row is in the legacy untagged form');
  return seeded;
}

test('a legacy bare-hex password row still logs in, and is upgraded in place', () => {
  // Existing accounts must not be signed out or forced through a reset by the
  // format change; signing in is the one moment the plaintext is available to
  // re-hash at the current cost.
  const store = freshStore();
  const password = 'LegacyRowPassw0rd!';
  const before = seedLegacyPasswordRow(store, 'legacy@example.com', password);

  const good = store.login('legacy@example.com', password);
  assert.equal(good.ok, true, 'a legacy row must still authenticate');
  assert.equal(good.user.id, 'u_legacy_pw');

  const after = store.findUserByEmail('legacy@example.com');
  assert.match(after.passwordHash, /^scrypt\$N=/, 'the row is rehashed into the tagged form on sign-in');
  assert.notEqual(after.passwordSalt, before.passwordSalt, 'the rehash also rotates the salt');
  assert.equal(store.login('legacy@example.com', password).ok, true, 'and the upgraded row still verifies');
  assert.equal(store.login('legacy@example.com', 'wrong-password').ok, false);
});

test('a failed login never rewrites the stored hash', () => {
  // The upgrade runs only after verification succeeds. Were it to run first, a wrong
  // password would overwrite the row with a hash of whatever the attacker typed.
  const store = freshStore();
  const password = 'NoRewriteOnFailure!1';
  seedLegacyPasswordRow(store, 'stable@example.com', password);
  const legacyHash = store.findUserByEmail('stable@example.com').passwordHash;

  assert.equal(store.login('stable@example.com', 'not-the-password').ok, false);
  assert.equal(store.findUserByEmail('stable@example.com').passwordHash, legacyHash,
    'the row is untouched by a failed attempt');
  assert.equal(store.login('stable@example.com', password).ok, true, 'the real password still works');
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
  const done = store.completePasswordReset(reset.token, newPassword);
  assert.equal(done.ok, true);
  assert.equal(done.toEmail, u.email, 'returns the recipient for the password-changed notice');

  assert.equal(store.login(u.email, 'OldPassw0rd!').ok, false, 'old password no longer works');
  assert.equal(store.login(u.email, newPassword).ok, true, 'new password works');
  assert.equal(
    store.completePasswordReset(reset.token, 'Another0ne!').ok,
    false,
    'the reset token is single-use',
  );
});

test('password reset revokes every existing session for that user', () => {
  const store = freshStore();
  const u = registerVerifiedUser(store, 'erin@example.com', 'OldPassw0rd!');
  // A second session for the same account — the "other device" (or the thief).
  const second = store.login(u.email, 'OldPassw0rd!');
  assert.equal(second.ok, true);
  // A bystander, to prove the revocation is scoped to one user_id.
  const other = registerVerifiedUser(store, 'frank@example.com', 'CorrectHorse9!');

  assert.equal(store.validateSession(u.token)?.id, u.id, 'session 1 valid before reset');
  assert.equal(store.validateSession(second.token)?.id, u.id, 'session 2 valid before reset');

  const reset = store.startPasswordReset(u.email);
  assert.equal(store.completePasswordReset(reset.token, 'BrandN3wPass!').ok, true);

  assert.equal(store.validateSession(u.token), null, 'session 1 revoked by the reset');
  assert.equal(store.validateSession(second.token), null, 'session 2 revoked by the reset');
  assert.equal(
    store.validateSession(other.token)?.id,
    other.id,
    "another user's session must survive",
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

// The byte-identical response above is only half the defence, exactly as with
// login: the fresh path pays a ~100ms scrypt writing the pending row, so a
// duplicate branch that returned before hashing would let a stopwatch answer
// "does this email have an account?" — the very question the response body
// refuses to answer. Counted, not timed: a wall-clock assertion is flaky on
// shared CI, while the call count is precisely the property at stake.
test('startRegistration pays the same scrypt cost whether or not the email is taken', () => {
  const store = freshStore();
  registerVerifiedUser(store, 'taken@example.com', 'CorrectHorse9!');

  const realScryptSync = crypto.scryptSync;
  let calls = 0;
  crypto.scryptSync = (...args) => {
    calls += 1;
    return realScryptSync(...args);
  };
  const hashesDuring = (fn) => {
    calls = 0;
    const out = fn();
    return { calls, out };
  };
  try {
    const fresh = hashesDuring(() => store.startRegistration('brand-new@example.com', 'CorrectHorse9!'));
    assert.equal(fresh.out.alreadyExists, undefined, 'sanity: this email is genuinely free');
    assert.equal(fresh.calls, 1, 'a fresh sign-up hashes the password once');

    const dup = hashesDuring(() => store.startRegistration('taken@example.com', 'Different0ne!'));
    assert.equal(dup.out.alreadyExists, true, 'sanity: this email is genuinely taken');
    assert.equal(
      dup.calls,
      fresh.calls,
      'the already-taken branch must burn a hash too, instead of returning early',
    );

    // An invalid input is rejected before either branch, so it is not part of the
    // pair being equalised — it cannot be reached with a well-formed probe.
    assert.equal(
      hashesDuring(() => store.startRegistration('taken@example.com', 'short')).calls,
      0,
      'sanity: the spy counts real work, not every call',
    );
  } finally {
    crypto.scryptSync = realScryptSync;
  }
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

// The identical wording above is only half the defence. If the miss paths returned
// before hashing, a stopwatch would still separate "no such user" (instant) from
// "wrong password" (a scrypt), which is the enumeration hole the wording closes.
// Counted rather than timed on purpose: a wall-clock assertion is flaky on shared
// CI, while the call count is exactly the property we care about.
test('login pays the same scrypt cost whether or not the account exists', () => {
  const store = freshStore();
  registerVerifiedUser(store, 'pw@example.com', 'CorrectHorse9!');
  store.loginWithGoogle({ email: 'goog@example.com', googleSub: 'sub-xyz' });

  const realScryptSync = crypto.scryptSync;
  let calls = 0;
  crypto.scryptSync = (...args) => {
    calls += 1;
    return realScryptSync(...args);
  };
  const hashesDuring = (fn) => {
    calls = 0;
    fn();
    return calls;
  };
  try {
    const baseline = hashesDuring(() => store.login('pw@example.com', 'wrong-password!'));
    assert.equal(baseline, 1, 'a wrong password against a real account hashes once');
    assert.equal(
      hashesDuring(() => store.login('nobody@example.com', 'whatever!')),
      baseline,
      'an unknown email hashes too, instead of returning early',
    );
    assert.equal(
      hashesDuring(() => store.login('goog@example.com', 'whatever!')),
      baseline,
      'a Google-only account hashes too',
    );
    // A wholly missing password must not become its own oracle either: it has to
    // land on the same generic rejection for a real account and an unknown one.
    assert.equal(
      hashesDuring(() => store.login('nobody@example.com')),
      baseline,
      'an omitted password still hashes on the miss path',
    );
    assert.equal(store.login('pw@example.com').error, store.login('nobody@example.com').error);
  } finally {
    crypto.scryptSync = realScryptSync;
  }
});

test('publicUser reports the enterprise flag only for a domain-granted seat', () => {
  // The browser cannot otherwise tell an enterprise seat from an individual
  // subscriber — enhanceUserWithEnterprise() upgrades the seat to plan 'pro' and the
  // two payloads are identical from there. The flag it stamps on (`enterpriseDomain`)
  // is what publicUser translates into the boolean the profile menu badges on.
  const store = freshStore();
  const u = registerVerifiedUser(store);
  const stored = store.findUserByEmail(u.email);

  assert.equal(store.publicUser(stored).enterprise, false, 'a plain account is not a seat');
  assert.equal(
    store.publicUser({ ...stored, plan: 'pro', stripeCustomerId: 'cus_123' }).enterprise,
    false,
    'an individual Stagify+ subscriber is not a seat either',
  );
  assert.equal(
    store.publicUser({ ...stored, plan: 'pro', enterpriseDomain: 'acme.com' }).enterprise,
    true,
  );
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
