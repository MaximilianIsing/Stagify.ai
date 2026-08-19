// Tier: unit (real SQLite, temp data dir) — lib/data/api-keys.js.
//
// WHAT THIS COVERS
// The bearer credential behind the public API. The load-bearing property is that the
// plaintext exists exactly once, in the response that creates it:
//   - the raw key's BYTES do not appear anywhere in the .db file (the test that would
//     have caught storing it raw), and no read path returns it a second time,
//   - a presented key resolves by digest, and the display prefix alone does not,
//   - revocation bites immediately, and is scoped to the owner — another account's
//     key id answers exactly as a key that never existed, so this is not an oracle,
//   - the per-account ceiling holds, and revoked keys do not count against it.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, dbPathFor } from '../../lib/data/db.js';
import { createApiKeys, MAX_KEYS_PER_USER } from '../../lib/data/api-keys.js';
import { TOKEN_HASH_PREFIX } from '../../lib/data/session-tokens.js';

const tempDirs = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-api-keys-'));
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

const USER = 'user_1';

test('a minted key is returned once and never again', () => {
  const keys = createApiKeys(tempDir());
  const made = keys.mintKey({ userId: USER, name: 'CI' });

  assert.equal(made.ok, true);
  assert.match(made.key, /^stg_live_/, 'the live marker makes a leaked key greppable');
  assert.ok(made.key.length > 40);

  // Nothing else in the API hands it back.
  const listed = keys.listForUser(USER);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].key, undefined);
  assert.equal(listed[0].keyHash, undefined);
  assert.equal(keys.getForUser({ id: made.record.id, userId: USER }).key, undefined);
});

test('the raw key does not appear in the database file', () => {
  const dir = tempDir();
  const keys = createApiKeys(dir);
  const made = keys.mintKey({ userId: USER });
  // Force the WAL out to the main file so the scan sees committed pages.
  closeDb(dir);

  const dbFile = dbPathFor(dir);
  const bytes = fs.readFileSync(dbFile).toString('latin1');
  assert.ok(
    !bytes.includes(made.key),
    'the plaintext key is on disk — a stolen volume is a set of live credentials',
  );
  // The secret half specifically, in case a prefix-only match masked it.
  assert.ok(!bytes.includes(made.key.slice('stg_live_'.length)));
  assert.ok(bytes.includes(TOKEN_HASH_PREFIX), 'the digest form should be what is stored');
});

test('a presented key resolves by digest, and the display prefix alone does not', () => {
  const keys = createApiKeys(tempDir());
  const made = keys.mintKey({ userId: USER });

  const found = keys.findByKey(made.key);
  assert.ok(found);
  assert.equal(found.user_id, USER);

  assert.equal(keys.findByKey(made.record.prefix), null, 'the shown prefix must not authenticate');
  assert.equal(keys.findByKey(made.key + 'x'), null);
  assert.equal(keys.findByKey(''), null);
  assert.equal(keys.findByKey(null), null);
  assert.equal(keys.findByKey(undefined), null);
});

test('revocation is immediate and visible on the row', () => {
  const keys = createApiKeys(tempDir());
  const made = keys.mintKey({ userId: USER });

  assert.equal(keys.revoke({ id: made.record.id, userId: USER }).ok, true);
  const found = keys.findByKey(made.key);
  assert.ok(found, 'the row survives so the caller can be told it was revoked, not that it is unknown');
  assert.ok(found.revoked_at, 'revoked_at must be set for the auth middleware to refuse it');

  const twice = keys.revoke({ id: made.record.id, userId: USER });
  assert.equal(twice.ok, false);
  assert.equal(twice.reason, 'already_revoked');
});

test("another account's key id answers exactly as a key that never existed", () => {
  const keys = createApiKeys(tempDir());
  const mine = keys.mintKey({ userId: USER });

  const stranger = keys.revoke({ id: mine.record.id, userId: 'user_2' });
  const nonexistent = keys.revoke({ id: 'ak_deadbeef', userId: 'user_2' });
  assert.deepEqual(stranger, nonexistent, 'the two must be indistinguishable, or this is an oracle');

  assert.equal(keys.getForUser({ id: mine.record.id, userId: 'user_2' }), null);
  assert.equal(keys.rename({ id: mine.record.id, userId: 'user_2', name: 'x' }).ok, false);
  assert.ok(!keys.findByKey(mine.key).revoked_at, 'a stranger must not be able to revoke it');
});

test('keys are listed per account and never leak across them', () => {
  const keys = createApiKeys(tempDir());
  keys.mintKey({ userId: USER, name: 'a' });
  keys.mintKey({ userId: USER, name: 'b' });
  keys.mintKey({ userId: 'user_2', name: 'theirs' });

  assert.equal(keys.listForUser(USER).length, 2);
  assert.equal(keys.listForUser('user_2').length, 1);
  assert.equal(keys.listForUser('user_3').length, 0);
});

test('last-used is stamped, so a dashboard can show a key going quiet', () => {
  let t = 1_700_000_000_000;
  const keys = createApiKeys(tempDir(), { now: () => t });
  const made = keys.mintKey({ userId: USER });
  assert.equal(made.record.lastUsedAt, null);

  t += 5000;
  keys.touchLastUsed(made.record.id);
  assert.equal(keys.getForUser({ id: made.record.id, userId: USER }).lastUsedAt, t);
});

test('names are trimmed and bounded, and a blank name still gets a label', () => {
  const keys = createApiKeys(tempDir());
  assert.equal(keys.mintKey({ userId: USER, name: '   ' }).record.name, 'API key');
  assert.equal(keys.mintKey({ userId: USER, name: '  CI  ' }).record.name, 'CI');
  assert.equal(keys.mintKey({ userId: USER, name: 'x'.repeat(200) }).record.name.length, 60);
});

test('the per-account ceiling holds, and revoking frees a slot', () => {
  const keys = createApiKeys(tempDir());
  const made = [];
  for (let i = 0; i < MAX_KEYS_PER_USER; i += 1) made.push(keys.mintKey({ userId: USER }));

  const over = keys.mintKey({ userId: USER });
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'too_many_keys');

  keys.revoke({ id: made[0].record.id, userId: USER });
  assert.equal(keys.mintKey({ userId: USER }).ok, true, 'a revoked key must not hold a slot');
});

test('two keys are never the same, and the store survives a reopen', () => {
  const dir = tempDir();
  const keys = createApiKeys(dir);
  const seen = new Set();
  // Spread across accounts so MAX_KEYS_PER_USER does not cut the run short — the
  // property under test here is that two mints never collide, not the ceiling.
  for (let i = 0; i < 50; i += 1) seen.add(keys.mintKey({ userId: 'user_' + i }).key);
  assert.equal(seen.size, 50);

  const one = [...seen][7];
  closeDb(dir);
  const reopened = createApiKeys(dir);
  assert.ok(reopened.findByKey(one), 'keys must outlive a restart');
});
