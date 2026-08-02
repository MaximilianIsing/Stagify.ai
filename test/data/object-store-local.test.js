// lib/data/object-store-local.js — the filesystem backend.
//
// This backend is what CI and `npm test` actually run against, so the contract pinned
// here is the contract the R2 adapter has to match: `get` REJECTS on absence (never
// resolves null), `remove` returns false for a missing object (never throws — the
// tombstone reaper retries forever and would never drain otherwise), `head` returns
// null. test/data/object-store-r2.test.js asserts the same three behaviours against a
// fake R2, which is what keeps the two adapters substitutable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createLocalObjectStore,
  resolveWithinRoot,
  signLocalObject,
  verifyLocalObject,
  LOCAL_OBJECT_ROUTE,
} from '../../lib/data/object-store-local.js';
import { keyForRender } from '../../lib/data/object-keys.js';

const RID = '0123456789abcdef0123456789abcdef';
const KEY = keyForRender({ renderId: RID, role: 'after' });

function tempStore(secret = 'test-secret') {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-objects-'));
  return { baseDir, store: createLocalObjectStore({ baseDir, secret }) };
}

test('put then get round-trips the bytes', async () => {
  const { store } = tempStore();
  const bytes = Buffer.from('staged room pixels');
  const res = await store.put(KEY, bytes, 'image/webp');
  assert.deepEqual(res, { key: KEY, bytes: bytes.length });
  assert.deepEqual(await store.get(KEY), bytes);
});

test('put creates the directory tree it needs', async () => {
  const { baseDir, store } = tempStore();
  await store.put(KEY, Buffer.from('x'));
  assert.ok(fs.existsSync(path.join(baseDir, 'data', 'objects', 'renders', RID, 'after.webp')));
});

test('get rejects when the object is gone, rather than resolving null', async () => {
  // A row can outlive its object. The caller decides what that means, so the store must
  // not quietly turn "missing" into a falsy value that a manifest would render as a
  // broken image.
  const { store } = tempStore();
  await assert.rejects(() => store.get(KEY), (e) => /** @type {any} */ (e).code === 'ENOENT');
});

test('remove is idempotent — a missing object is false, not a throw', async () => {
  // This is what the tombstone reaper depends on: it retries until it wins, so a throw
  // on an already-deleted key would mean a queue entry that never drains.
  const { store } = tempStore();
  assert.equal(await store.remove(KEY), false);
  await store.put(KEY, Buffer.from('x'));
  assert.equal(await store.remove(KEY), true);
  assert.equal(await store.remove(KEY), false);
});

test('head reports size and mtime, or null when absent', async () => {
  const { store } = tempStore();
  assert.equal(await store.head(KEY), null);
  await store.put(KEY, Buffer.from('twelve bytes'));
  const st = await store.head(KEY);
  assert.equal(st?.bytes, 12);
  assert.ok(typeof st?.mtimeMs === 'number' && st.mtimeMs > 0);
});

test('every method refuses a key that fails gate 1', async () => {
  const { store } = tempStore();
  const evil = '../../auth-store.db';
  await assert.rejects(() => store.put(evil, Buffer.from('x')), /EUNSAFEKEY|unsafe/);
  await assert.rejects(() => store.get(evil), /EUNSAFEKEY|unsafe/);
  await assert.rejects(() => store.remove(evil), /EUNSAFEKEY|unsafe/);
  await assert.rejects(() => store.head(evil), /EUNSAFEKEY|unsafe/);
  assert.throws(() => store.presignGet(evil), /EUNSAFEKEY|unsafe/);
});

test('put rejects a non-buffer instead of writing garbage', async () => {
  const { store } = tempStore();
  await assert.rejects(() => store.put(KEY, /** @type {any} */ ('a string')), TypeError);
  await assert.rejects(() => store.put(KEY, /** @type {any} */ (null)), TypeError);
});

// Gate 2 is independent of the regex on purpose — it is the gate that still holds if
// the pattern is ever loosened, and the only one that sees what the OS does with a path.
test('gate 2 refuses anything that escapes the root', () => {
  const root = path.join(os.tmpdir(), 'stagify-root');
  assert.throws(() => resolveWithinRoot(root, '../outside'), /EUNSAFEKEY|outside/);
  assert.throws(() => resolveWithinRoot(root, path.resolve(os.tmpdir(), 'elsewhere')), /EUNSAFEKEY|outside/);
  // Equality with the root is a failure too: the argument has to name something INSIDE.
  assert.throws(() => resolveWithinRoot(root, ''), /EUNSAFEKEY|outside/);
  assert.throws(() => resolveWithinRoot(root, '.'), /EUNSAFEKEY|outside/);
  assert.equal(resolveWithinRoot(root, 'a/b.webp'), path.resolve(root, 'a', 'b.webp'));
});

test('presignGet is synchronous and returns a same-origin URL', () => {
  const { store } = tempStore();
  const url = store.presignGet(KEY, { ttlMs: 60_000, now: 1_000_000 });
  // Synchronous is load-bearing: an async signature invites a cache, and a cached
  // presigned URL is a revocation bug.
  assert.equal(typeof url, 'string');
  assert.ok(url.startsWith(`${LOCAL_OBJECT_ROUTE}/${KEY}?`));
  const q = new URLSearchParams(url.split('?')[1]);
  assert.equal(q.get('exp'), '1060000');
  assert.match(/** @type {string} */ (q.get('sig')), /^[a-f0-9]{64}$/);
});

test('presignGet carries a download filename when asked', () => {
  const { store } = tempStore();
  const q = new URLSearchParams(store.presignGet(KEY, { filename: 'room.webp' }).split('?')[1]);
  assert.equal(q.get('filename'), 'room.webp');
});

test('a presigned URL verifies, and stops verifying when it expires', () => {
  const secret = 'test-secret';
  const exp = 5_000;
  const sig = signLocalObject(secret, KEY, exp);
  assert.equal(verifyLocalObject(secret, KEY, exp, sig, 4_999), true);
  assert.equal(verifyLocalObject(secret, KEY, exp, sig, exp), false, 'expiry is exclusive');
  assert.equal(verifyLocalObject(secret, KEY, exp, sig, 5_001), false);
});

test('a presigned URL cannot be edited', () => {
  const secret = 'test-secret';
  const exp = 5_000;
  const sig = signLocalObject(secret, KEY, exp);
  const other = keyForRender({ renderId: RID, role: 'before' });
  // Extending your own access...
  assert.equal(verifyLocalObject(secret, KEY, exp + 60_000, sig, 4_999), false);
  // ...or pointing the same signature at the owner-only source photo.
  assert.equal(verifyLocalObject(secret, other, exp, sig, 4_999), false);
  // ...or signing it yourself with the wrong secret.
  assert.equal(verifyLocalObject('wrong-secret', KEY, exp, sig, 4_999), false);
});

test('verification survives a malformed signature without throwing', () => {
  // timingSafeEqual throws on a length mismatch, so the length guard has to come first
  // — otherwise a one-character `sig` is a 500 instead of a 403.
  const secret = 'test-secret';
  for (const bad of ['', 'x', 'z'.repeat(64), null, undefined, 42, {}]) {
    assert.equal(verifyLocalObject(secret, KEY, 5_000, /** @type {any} */ (bad), 1), false);
  }
  for (const bad of ['not-a-number', '', null, undefined, NaN, Infinity]) {
    assert.equal(verifyLocalObject(secret, KEY, /** @type {any} */ (bad), signLocalObject(secret, KEY, 5_000), 1), false);
  }
});

test('two stores with no injected secret cannot verify each other', () => {
  // The default secret is per-process random, so a restart invalidates outstanding
  // URLs. That is correct — the client re-mints on error — and it means nothing durable
  // has to hold a dev secret.
  const a = createLocalObjectStore({ baseDir: fs.mkdtempSync(path.join(os.tmpdir(), 'a-')) });
  const b = createLocalObjectStore({ baseDir: fs.mkdtempSync(path.join(os.tmpdir(), 'b-')) });
  assert.notEqual(a.secret, b.secret);
});
