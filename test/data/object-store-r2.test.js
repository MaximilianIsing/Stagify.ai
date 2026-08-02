// lib/data/object-store-r2.js — the Cloudflare R2 backend.
//
// Driven entirely through an injected `fetchImpl`, so there is no network, no account
// and no cost. That injection is only real because the adapter signs with
// `aws.sign()` and then calls OUR fetch: aws4fetch's own `AwsClient.fetch` closes over
// the global fetch and silently ignores a `fetch` passed in its init, which would have
// made every test here either hit the network or pass while exercising nothing.
//
// The contract asserted here is deliberately the SAME contract as
// test/data/object-store-local.test.js — `get` rejects on absence, `remove` is
// idempotent and returns false, `head` returns null. Two adapters are only
// substitutable if both are pinned to one contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createR2ObjectStore, r2ConfigFromEnv } from '../../lib/data/object-store-r2.js';
import { keyForRender } from '../../lib/data/object-keys.js';

const RID = '0123456789abcdef0123456789abcdef';
const KEY = keyForRender({ renderId: RID, role: 'after' });
const CFG = {
  endpoint: 'https://acct123.r2.cloudflarestorage.com',
  bucket: 'stagify-renders',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

/**
 * A fake R2 that records what it was asked and answers what the test says.
 * @param {(req: Request) => Response | Promise<Response>} handler
 */
function fakeR2(handler) {
  /** @type {Request[]} */
  const seen = [];
  const store = createR2ObjectStore({
    ...CFG,
    fetchImpl: async (req) => {
      seen.push(/** @type {Request} */ (req));
      return handler(/** @type {Request} */ (req));
    },
  });
  return { store, seen };
}

test('put signs a PUT and sends the bytes', async () => {
  const { store, seen } = fakeR2(() => new Response('', { status: 200 }));
  const bytes = Buffer.from('staged room pixels');
  assert.deepEqual(await store.put(KEY, bytes, 'image/webp'), { key: KEY, bytes: bytes.length });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'PUT');
  assert.equal(new URL(seen[0].url).pathname, `/${CFG.bucket}/${KEY}`);
  assert.equal(seen[0].headers.get('content-type'), 'image/webp');
  // The signature must actually be on the request — this is what proves we went through
  // aws.sign() rather than firing an unsigned fetch that R2 would reject in production.
  assert.match(String(seen[0].headers.get('authorization')), /^AWS4-HMAC-SHA256 Credential=/);
  assert.ok(seen[0].headers.get('x-amz-content-sha256'), 'the payload hash must be signed');
});

test('put throws with the HTTP status when R2 refuses', async () => {
  const { store } = fakeR2(() => new Response('AccessDenied', { status: 403 }));
  await assert.rejects(
    () => store.put(KEY, Buffer.from('x')),
    (e) => /** @type {any} */ (e).status === 403 && /** @type {any} */ (e).code === 'ER2',
  );
});

test('get returns the bytes', async () => {
  const { store, seen } = fakeR2(() => new Response(Buffer.from('pixels'), { status: 200 }));
  assert.deepEqual(await store.get(KEY), Buffer.from('pixels'));
  assert.equal(seen[0].method, 'GET');
});

test('get rejects with ENOENT on a 404, matching the local adapter', async () => {
  const { store } = fakeR2(() => new Response('', { status: 404 }));
  await assert.rejects(() => store.get(KEY), (e) => /** @type {any} */ (e).code === 'ENOENT');
});

test('remove is idempotent and distinguishes gone from broken', async () => {
  // 204 is what S3 semantics actually answer for a delete, including of something that
  // was never there. 404 is belt-and-braces for a backend that reports it differently.
  // `new Response('', {status: 204})` throws — 204 is a null-body status.
  const ok = fakeR2(() => new Response(null, { status: 204 }));
  assert.equal(await ok.store.remove(KEY), true);
  assert.equal(ok.seen[0].method, 'DELETE');

  const gone = fakeR2(() => new Response('', { status: 404 }));
  assert.equal(await gone.store.remove(KEY), false);

  // A 500 must THROW, not return false. The tombstone reaper reads false as "done" and
  // drops the queue entry; swallowing an outage here would silently abandon bytes that
  // a GDPR erasure has already promised to delete.
  const broken = fakeR2(() => new Response('boom', { status: 500 }));
  await assert.rejects(() => broken.store.remove(KEY), (e) => /** @type {any} */ (e).status === 500);
});

test('head parses size and last-modified, and returns null when absent', async () => {
  const present = fakeR2(() => new Response('', {
    status: 200,
    headers: { 'content-length': '4096', 'last-modified': 'Sun, 02 Aug 2026 18:30:00 GMT' },
  }));
  assert.deepEqual(await present.store.head(KEY), {
    bytes: 4096,
    mtimeMs: Date.UTC(2026, 7, 2, 18, 30, 0),
  });
  assert.equal(present.seen[0].method, 'HEAD');

  const absent = fakeR2(() => new Response('', { status: 404 }));
  assert.equal(await absent.store.head(KEY), null);
});

test('head survives a response with no usable headers', async () => {
  const { store } = fakeR2(() => new Response('', { status: 200 }));
  assert.deepEqual(await store.head(KEY), { bytes: 0, mtimeMs: 0 });
});

test('every method refuses a key that fails gate 1, before any fetch', async () => {
  const { store, seen } = fakeR2(() => new Response('', { status: 200 }));
  const evil = '../../auth-store.db';
  await assert.rejects(() => store.put(evil, Buffer.from('x')), /EUNSAFEKEY|unsafe/);
  await assert.rejects(() => store.get(evil), /EUNSAFEKEY|unsafe/);
  await assert.rejects(() => store.remove(evil), /EUNSAFEKEY|unsafe/);
  await assert.rejects(() => store.head(evil), /EUNSAFEKEY|unsafe/);
  assert.throws(() => store.presignGet(evil), /EUNSAFEKEY|unsafe/);
  assert.equal(seen.length, 0, 'an unsafe key must never reach the network');
});

test('presignGet is synchronous and points straight at R2', () => {
  const { store, seen } = fakeR2(() => new Response('', { status: 200 }));
  const url = store.presignGet(KEY, { ttlMs: 15 * 60 * 1000 });
  // Not a promise, and no fetch: this is the whole egress argument. If bytes came back
  // through this process, R2 would be buying nothing.
  assert.equal(typeof url, 'string');
  assert.equal(seen.length, 0);
  const u = new URL(url);
  assert.equal(u.origin, CFG.endpoint);
  assert.equal(u.pathname, `/${CFG.bucket}/${KEY}`);
  assert.equal(u.searchParams.get('X-Amz-Expires'), '900');
  assert.match(String(u.searchParams.get('X-Amz-Signature')), /^[a-f0-9]{64}$/);
});

test('presignGet strips quotes out of a download filename', () => {
  // The filename lands inside a quoted Content-Disposition value, so an unescaped quote
  // would let a caller inject extra directives into the header R2 replays.
  const { store } = fakeR2(() => new Response('', { status: 200 }));
  const url = store.presignGet(KEY, { filename: 'we"ird\\name.webp' });
  const cd = new URL(url).searchParams.get('response-content-disposition');
  assert.equal(cd, 'attachment; filename="weirdname.webp"');
});

test('r2ConfigFromEnv needs all four settings', () => {
  const full = {
    R2_ACCOUNT_ENDPOINT: CFG.endpoint,
    R2_RENDERS_BUCKET: CFG.bucket,
    R2_ACCESS_KEY_ID: CFG.accessKeyId,
    R2_SECRET_ACCESS_KEY: CFG.secretAccessKey,
  };
  assert.deepEqual(r2ConfigFromEnv(full), CFG);
  assert.equal(r2ConfigFromEnv({}), null);
  // A PARTIAL configuration is null, not a half-open store that would fail on its first
  // write — and it warns, because silence here looks like "the gallery just doesn't work".
  for (const missing of Object.keys(full)) {
    const partial = { ...full };
    delete partial[missing];
    assert.equal(r2ConfigFromEnv(partial), null, `${missing} missing should disable R2`);
  }
});

test('r2ConfigFromEnv never falls back to the Litestream credentials', () => {
  // Reusing LITESTREAM_ACCESS_KEY_ID would point render bytes at the bucket holding the
  // replica of auth-store.db, where a misdirected write corrupts disaster recovery.
  assert.equal(r2ConfigFromEnv({
    LITESTREAM_ACCESS_KEY_ID: 'x',
    LITESTREAM_SECRET_ACCESS_KEY: 'y',
  }), null);
});
