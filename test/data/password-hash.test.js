// The password hash format and its upgrade path (lib/data/password-hash.js).
//
// WHAT THIS IS PROTECTING: the stored digest used to be bare hex, which records
// the output but not the cost it was produced at. That is fine until the day you
// want to raise scrypt's N — at which point old and new rows are indistinguishable,
// nothing can tell which accounts are still on the weak cost, and the only
// migration left is a forced password reset for every user. The parameters now ride
// in the value, so a store can hold a mix while accounts migrate on sign-in.
//
// So the tests that matter are the MIXED-STATE ones: a legacy row still verifies, a
// row written at a different cost still verifies under ITS cost (not the current
// one), and `needsRehash` marks exactly those — never a row that is already current,
// and never a failed attempt.
//
// COST NOTE: scrypt is deliberately slow (~100ms at N=16384), and a few dozen calls
// here is the price of covering it. The parameter-change cases use a deliberately
// TINY N (1024): the point is that a non-default cost round-trips, and paying full
// price to assert that would only make the suite slower, not stronger.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import {
  hashPassword,
  verifyPassword,
  parsePasswordHash,
  burnPasswordHash,
  PASSWORD_PARAMS,
  LEGACY_PARAMS,
  PASSWORD_HASH_ALGORITHM,
} from '../../lib/data/password-hash.js';

const SALT = 'a1b2c3d4e5f60718';
const CHEAP = { N: 1024, r: 8, p: 1, keylen: 64 };

// How every hash in the store was written before this module existed.
function legacyHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

test('a stored hash carries its algorithm and cost parameters', () => {
  const stored = hashPassword('correct horse battery staple', SALT);
  const [algorithm, params, digest] = stored.split('$');

  assert.equal(algorithm, PASSWORD_HASH_ALGORITHM);
  assert.equal(params, `N=${PASSWORD_PARAMS.N},r=${PASSWORD_PARAMS.r},p=${PASSWORD_PARAMS.p},keylen=${PASSWORD_PARAMS.keylen}`);
  assert.match(digest, /^[0-9a-f]+$/, 'the digest itself is still plain hex');
  assert.equal(digest.length, PASSWORD_PARAMS.keylen * 2);

  // The whole point: the row says how it was made.
  const parsed = parsePasswordHash(stored);
  assert.deepEqual(parsed.params, { ...PASSWORD_PARAMS });
  assert.equal(parsed.legacy, false);
});

test('the same password and salt hash identically; a different salt does not', () => {
  assert.equal(hashPassword('pw', SALT), hashPassword('pw', SALT));
  assert.notEqual(hashPassword('pw', SALT), hashPassword('pw', 'ffffffffffffffff'));
  assert.notEqual(hashPassword('pw', SALT), hashPassword('pw ', SALT));
});

test('verifyPassword accepts the right password and rejects everything else', () => {
  const stored = hashPassword('s3cret-pass', SALT);
  assert.deepEqual(verifyPassword('s3cret-pass', SALT, stored), { ok: true, needsRehash: false });
  assert.equal(verifyPassword('S3cret-pass', SALT, stored).ok, false, 'case matters');
  assert.equal(verifyPassword('', SALT, stored).ok, false);
  assert.equal(verifyPassword('s3cret-pass', 'other-salt', stored).ok, false, 'wrong salt cannot verify');
});

test('a legacy bare-hex row still verifies, and is flagged for rehashing', () => {
  // Nobody is signed out by the format change — this is the row every existing
  // account has today.
  const stored = legacyHash('old-password', SALT);
  assert.ok(!stored.includes('$'), 'precondition: the legacy form is untagged');

  const result = verifyPassword('old-password', SALT, stored);
  assert.equal(result.ok, true, 'a pre-existing account can still sign in');
  assert.equal(result.needsRehash, true, 'and is marked for upgrade');

  assert.equal(verifyPassword('wrong', SALT, stored).ok, false);
  assert.equal(verifyPassword('wrong', SALT, stored).needsRehash, false,
    'a failed attempt must never invite a rehash — the caller would be writing an unverified password');
});

test('parsePasswordHash reads a legacy row as the parameters it was actually made with', () => {
  const parsed = parsePasswordHash(legacyHash('x', SALT));
  assert.equal(parsed.legacy, true);
  assert.deepEqual(parsed.params, { ...LEGACY_PARAMS });
});

test('a row written at a different cost verifies under ITS cost, not the current one', () => {
  // This is the mixed-state the format exists for: raise N, and rows still on the
  // old N keep working until their owner next signs in.
  const stored = hashPassword('pw', SALT, CHEAP);
  assert.ok(stored.startsWith(`${PASSWORD_HASH_ALGORITHM}$N=1024,`));

  const result = verifyPassword('pw', SALT, stored);
  assert.equal(result.ok, true, 'verification uses the parameters on the row');
  assert.equal(result.needsRehash, true, 'and notices they are not the current ones');

  // Verifying it against the CURRENT parameters would produce a different digest —
  // i.e. reading the cost off the row is load-bearing, not decorative.
  const atCurrentCost = hashPassword('pw', SALT);
  assert.notEqual(atCurrentCost.split('$')[2], stored.split('$')[2]);
});

test('every keylen the envelope declares is honoured', () => {
  const short = hashPassword('pw', SALT, { ...CHEAP, keylen: 32 });
  assert.ok(short.includes('keylen=32'));
  assert.equal(short.split('$')[2].length, 64);
  assert.equal(verifyPassword('pw', SALT, short).ok, true);
});

test('malformed, empty, and unknown-algorithm values never verify', () => {
  for (const bad of [
    '',
    null,
    undefined,
    'not-hex-at-all',
    'scrypt$N=16384$deadbeef', // two segments' worth of params, missing fields
    'scrypt$N=16384,r=8,p=1,keylen=64$nothex',
    'argon2$m=65536,t=3,p=4$deadbeef', // a real format, but not one we can check
    'scrypt$N=0,r=8,p=1,keylen=64$deadbeef',
    `scrypt$N=16384,r=8,p=1,keylen=64$${'ab'.repeat(8)}`, // keylen lies about the digest
  ]) {
    assert.equal(parsePasswordHash(/** @type {any} */ (bad)), null, `must not parse: ${String(bad)}`);
    assert.deepEqual(
      verifyPassword('anything', SALT, /** @type {any} */ (bad)),
      { ok: false, needsRehash: false },
      `must not verify: ${String(bad)}`,
    );
  }
});

test('an odd-length or non-hex legacy string is refused rather than guessed at', () => {
  assert.equal(parsePasswordHash('abc'), null, 'odd length is not a digest');
  assert.equal(parsePasswordHash('zz'), null, 'not hex');
});

test('burnPasswordHash does the work and returns nothing', () => {
  // Login's miss paths call this so a nonexistent account costs the same wall-clock
  // as a real check. If it were ever optimized away, the generic error message would
  // become an enumeration oracle by the clock.
  const started = process.hrtime.bigint();
  const out = burnPasswordHash('whatever', SALT);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(out, undefined);
  const reference = (() => {
    const t = process.hrtime.bigint();
    hashPassword('whatever', SALT);
    return Number(process.hrtime.bigint() - t) / 1e6;
  })();
  // Same order of magnitude as a real hash — a no-op would be orders faster. Loose
  // on purpose: this is a "did the work happen at all" check, not a benchmark.
  assert.ok(elapsedMs > reference / 10, `burn took ${elapsedMs}ms vs a real hash's ${reference}ms`);
});

test('raising the cost is a one-line change that new writes pick up', () => {
  // Documents the actual upgrade procedure: bump PASSWORD_PARAMS, and every new
  // write uses it while old rows keep verifying and get rehashed on sign-in. The
  // frozen export is what makes "one line" true — nothing else hard-codes N.
  assert.ok(Object.isFrozen(PASSWORD_PARAMS), 'the parameters are a single frozen source');
  assert.equal(typeof PASSWORD_PARAMS.N, 'number');
  assert.ok(PASSWORD_PARAMS.N >= 16384, 'never quietly drop below the Node default cost');
  assert.equal(PASSWORD_PARAMS.N & (PASSWORD_PARAMS.N - 1), 0, 'scrypt requires N to be a power of two');
});
