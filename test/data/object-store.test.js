// lib/data/object-store.js — which backend the gallery uses.
//
// The branch that matters is the third one. Falling back to the local disk on Render
// would "work", and would write ~220 KB per staged entry onto the same 1 GB volume that
// holds auth-store.db and its WAL — which is the exact failure the whole feature was
// designed to avoid. A misconfigured bucket must degrade to "no gallery", never to
// "quietly fill the disk that auth and Stripe depend on". That is a safety property, so
// it gets a test rather than a comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createObjectStore, createDisabledObjectStore } from '../../lib/data/object-store.js';
import { keyForRender } from '../../lib/data/object-keys.js';

const KEY = keyForRender({ renderId: '0123456789abcdef0123456789abcdef', role: 'after' });
const R2_ENV = {
  R2_ACCOUNT_ENDPOINT: 'https://acct123.r2.cloudflarestorage.com',
  R2_RENDERS_BUCKET: 'stagify-renders',
  R2_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  R2_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

function tempBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-store-sel-'));
}

test('picks R2 when it is fully configured', () => {
  const store = createObjectStore({ baseDir: tempBase(), env: R2_ENV });
  assert.equal(store.backend, 'r2');
  assert.equal(store.configured, true);
});

test('picks R2 even on Render — the environment does not override a real config', () => {
  const store = createObjectStore({ baseDir: tempBase(), env: { ...R2_ENV, RENDER: 'true' } });
  assert.equal(store.backend, 'r2');
});

test('falls back to the local disk off Render', () => {
  const store = createObjectStore({ baseDir: tempBase(), env: {} });
  assert.equal(store.backend, 'local');
  assert.equal(store.configured, true);
});

test('DISABLES the gallery on Render rather than filling the app volume', () => {
  // The safety branch. If this ever regresses to 'local', production starts writing
  // render bytes next to auth-store.db and the first symptom is a failed login.
  const store = createObjectStore({ baseDir: tempBase(), env: { RENDER: 'true' } });
  assert.equal(store.backend, 'disabled');
  assert.equal(store.configured, false);
});

test('a partial R2 config on Render disables rather than half-opens', () => {
  const store = createObjectStore({
    baseDir: tempBase(),
    env: { RENDER: 'true', R2_ACCOUNT_ENDPOINT: R2_ENV.R2_ACCOUNT_ENDPOINT },
  });
  assert.equal(store.backend, 'disabled');
});

test('the disabled store is a safe no-op in every direction', async () => {
  // A caller that forgets to check `configured` must degrade to "the entry never appears
  // in the gallery", not throw inside a paid render's response path.
  const store = createDisabledObjectStore();
  assert.equal(store.configured, false);
  assert.deepEqual(await store.put(KEY, Buffer.from('abc')), { key: KEY, bytes: 3 });
  assert.equal(await store.remove(KEY), false);
  assert.equal(await store.head(KEY), null);
  assert.equal(store.presignGet(KEY), '', 'an empty URL is what the manifest treats as "no bytes"');
  // `get` is the one that rejects, because a caller asking for bytes that cannot exist
  // is a bug worth surfacing rather than an empty buffer that renders as a broken image.
  await assert.rejects(() => store.get(KEY), (e) => /** @type {any} */ (e).code === 'ENOENT');
});

test('createObjectStore never throws on a hostile environment', () => {
  // Boot must not be able to fail here: scripts/start.sh already boots without
  // Litestream when its credentials are absent, and a storage misconfiguration must not
  // be more fatal than a backup misconfiguration.
  for (const env of [{}, { RENDER: 'true' }, { R2_RENDERS_BUCKET: '' }, { R2_ACCOUNT_ENDPOINT: 'not-a-url' }]) {
    assert.doesNotThrow(() => createObjectStore({ baseDir: tempBase(), env }));
  }
});

test('all three backends expose the same surface', () => {
  // Substitutability is the whole design: routers and manifest builders are written once
  // against this shape, so a missing method would only show up in production on Render.
  const surface = ['configured', 'backend', 'put', 'get', 'remove', 'head', 'presignGet'];
  const stores = [
    createObjectStore({ baseDir: tempBase(), env: R2_ENV }),
    createObjectStore({ baseDir: tempBase(), env: {} }),
    createDisabledObjectStore(),
  ];
  for (const store of stores) {
    for (const member of surface) {
      assert.ok(member in store, `${store.backend} is missing ${member}`);
    }
    assert.equal(typeof store.presignGet, 'function');
    // presignGet must be synchronous on EVERY backend — the manifest builders rely on
    // it, and one async implementation would silently produce "[object Promise]" URLs.
    assert.notEqual(store.presignGet.constructor.name, 'AsyncFunction');
  }
});
