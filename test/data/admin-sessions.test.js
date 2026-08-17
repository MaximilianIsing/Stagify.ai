// Tier: data store (real SQLite on a temp dir) — lib/data/admin-sessions.js.
//
// This store exists so the operator stops retyping `endpoint_key` on every load, and
// the only reason that is acceptable is that what gets persisted is WEAKER than the
// key: scoped, expiring, revocable, and dead the moment the key is rotated. Each of
// those is a property of this file, so each is pinned here.
//
// Real SQLite, not a fake: the hashing, the sliding renewal and the fingerprint check
// are all things a stub would simply agree with.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAdminSessions, keyFingerprint, SESSION_TTL_MS, RENEW_AFTER_MS } from '../../lib/data/admin-sessions.js';
import { getDb } from '../../lib/data/db.js';

const KEY = 'the-endpoint-key';

/** A store on its own temp data dir, with an injectable clock. */
function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-adm-sessions-'));
  let now = 1_800_000_000_000;
  const store = createAdminSessions(dir, { now: () => now });
  return {
    store,
    dir,
    at: (t) => { now = t; },
    advance: (ms) => { now += ms; },
    now: () => now,
    rows: () => getDb(dir).prepare('SELECT * FROM admin_sessions').all(),
  };
}

test('a minted token validates, and carries an expiry a month out', () => {
  const { store, now } = makeStore();
  const { token, expiresAt } = store.create(KEY);

  assert.match(token, /^[0-9a-f]{64}$/, 'a 256-bit CSPRNG token, hex encoded');
  assert.equal(expiresAt, now() + SESSION_TTL_MS);
  assert.ok(store.validate(token, KEY), 'the token it just issued must resolve');
});

test('SECURITY: the raw token never reaches the table — only its digest', () => {
  const { store, rows } = makeStore();
  const { token } = store.create(KEY);

  const [row] = rows();
  assert.notEqual(row.token, token, 'the raw bearer token was written to disk');
  assert.ok(row.token.startsWith('sha256$'), 'stored form must be the shared hashed-token shape');
  assert.ok(!JSON.stringify(row).includes(token), 'no column may hold the raw token');
});

test('SECURITY: the key fingerprint stored beside a session is not the key', () => {
  const { store, rows } = makeStore();
  store.create(KEY);

  const [row] = rows();
  assert.equal(row.key_fp, keyFingerprint(KEY));
  assert.ok(!row.key_fp.includes(KEY));
  assert.equal(row.key_fp.length, 16, 'truncated on purpose — it is a change detector, not a credential');
});

test('an unknown token resolves to nothing', () => {
  const { store } = makeStore();
  store.create(KEY);
  assert.equal(store.validate('f'.repeat(64), KEY), null);
  assert.equal(store.validate('', KEY), null);
});

test('an expired token resolves to nothing, even one second past', () => {
  const { store, advance } = makeStore();
  const { token } = store.create(KEY);

  advance(SESSION_TTL_MS - 1000);
  assert.ok(store.validate(token, KEY), 'still inside the window');

  // Re-mint: the check above just slid the expiry, which is the point of the next test.
  const fresh = store.create(KEY);
  advance(SESSION_TTL_MS + 1);
  assert.equal(store.validate(fresh.token, KEY), null);
});

test('use slides the expiry, so a console you actually use never asks again', () => {
  const { store, advance, now } = makeStore();
  const { token } = store.create(KEY);

  advance(RENEW_AFTER_MS + 1000);
  const seen = store.validate(token, KEY);
  assert.ok(seen);
  assert.equal(seen.expiresAt, now() + SESSION_TTL_MS, 'a full TTL from the moment it was used');
});

test('but not on every request — a renewal is a write, and the dashboard is chatty', () => {
  const { store, advance, rows } = makeStore();
  const { token, expiresAt } = store.create(KEY);

  // The ten-odd requests one dashboard refresh fires, all inside the renewal window.
  advance(60 * 1000);
  for (let i = 0; i < 10; i++) assert.ok(store.validate(token, KEY));

  assert.equal(rows()[0].exp, expiresAt, 'the row must not be rewritten on each read');
});

test('ROTATION REVOKES EVERYTHING: a session outlives neither a new key nor a typo', () => {
  const { store } = makeStore();
  const { token } = store.create(KEY);

  assert.equal(store.validate(token, 'a-rotated-key'), null,
    'rotating endpoint_key must invalidate outstanding sessions — otherwise rotating a '
    + 'leaked secret leaves every signed-in browser working');
  assert.ok(store.validate(token, KEY), 'and the original key still resolves it');
});

test('revoke kills one device; revokeAll kills the fleet', () => {
  const { store } = makeStore();
  const a = store.create(KEY);
  const b = store.create(KEY);

  assert.equal(store.revoke(a.token), 1);
  assert.equal(store.validate(a.token, KEY), null, 'revoked');
  assert.ok(store.validate(b.token, KEY), 'the other device is untouched');

  assert.equal(store.revoke('f'.repeat(64)), 0, 'revoking an unknown token is a no-op, not an error');
  assert.equal(store.revoke(''), 0);

  assert.equal(store.revokeAll(), 1);
  assert.equal(store.validate(b.token, KEY), null);
});

test('expired rows are swept, so the table does not grow without bound', () => {
  const { store, advance, rows } = makeStore();
  store.create(KEY);
  store.create(KEY);
  assert.equal(rows().length, 2);

  advance(SESSION_TTL_MS + 1);
  // The sweep runs on the rare operation rather than a timer.
  const fresh = store.create(KEY);
  assert.equal(rows().length, 1, 'the two dead rows are gone');
  assert.ok(store.validate(fresh.token, KEY));
});

test('two sessions from one key coexist — signing in on a laptop must not sign out a phone', () => {
  const { store } = makeStore();
  const a = store.create(KEY);
  const b = store.create(KEY);

  assert.notEqual(a.token, b.token);
  assert.ok(store.validate(a.token, KEY));
  assert.ok(store.validate(b.token, KEY));
  assert.equal(store.count(), 2);
});

test('sessions survive a reopen of the same data dir — that is the whole feature', () => {
  const { store, dir } = makeStore();
  const { token } = store.create(KEY);

  // A second store over the same directory models the next boot: same shared
  // connection, same rows. A token that died on restart would be no better than
  // the in-memory key it replaced.
  const reopened = createAdminSessions(dir);
  assert.ok(reopened.validate(token, KEY), 'the session must outlive the process');
});
