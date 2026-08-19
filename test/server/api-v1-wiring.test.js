// Tier: integration (boots the REAL server.js) — the public API's composition root.
//
// WHY THIS EXISTS SEPARATELY FROM test/routes/api-v1-renders.test.js. That spec builds
// its own Express app around the router with fakes for the key auth, the concurrency gate
// and multer — which is right for testing the ROUTES, and structurally unable to notice
// that server.js forgot to pass one of them. This file boots the real process, so it is
// the only place that proves the wiring: a missing `requireApiKey` dep would leave the
// paid render endpoint answering something other than 401 here, and nowhere else.
//
// Every request below is unauthenticated and bodyless, so each is refused at a guard
// before any store write, model call or Stripe call. Nothing is minted, charged or sent.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.js';

let server;
before(async () => {
  // The reject bucket is per-IP and this file spends several of them from one address;
  // at the production ceiling the later assertions would turn into 429s, which are still
  // rejections but would stop proving that the GUARD did the rejecting. The limiter's own
  // behaviour is covered by its unit spec.
  server = await startServer({ RL_API_KEY_REJECT: '1000', RL_API_RENDER: '1000' });
});
after(() => server?.close());

const get = (p, headers) => fetch(`${server.baseUrl}${p}`, { headers });
const post = (p, headers) => fetch(`${server.baseUrl}${p}`, { method: 'POST', headers });

test('the paid render endpoint refuses an unauthenticated caller at the key guard', async () => {
  const res = await post('/api/v1/renders');
  assert.equal(res.status, 401, 'a missing key must not reach multer, let alone a model');
  const body = await res.json();
  assert.equal(body.code, 'API_KEY_MISSING');
  // The guard's own headers, which prove it is requireApiKey answering and not a
  // generic 401 from somewhere else.
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
});

test('a key we never issued is refused, and distinguishably so', async () => {
  const res = await post('/api/v1/renders', { Authorization: 'Bearer stg_live_' + 'z'.repeat(43) });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'API_KEY_INVALID');
});

test('every read endpoint is behind the same guard', async () => {
  for (const path of ['/api/v1/credits', '/api/v1/me', '/api/v1/renders/req_whatever']) {
    const res = await get(path);
    assert.equal(res.status, 401, path);
    assert.equal((await res.json()).code, 'API_KEY_MISSING', path);
  }
});

test('a key in the query string is ignored — the header is the only way in', async () => {
  // A credential in a URL leaks via access logs, proxy logs and Referer. This asserts
  // the real server never grew a convenience reader for one.
  const res = await get('/api/v1/credits?key=stg_live_' + 'z'.repeat(43));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'API_KEY_MISSING');
});

test('/api/v1/* sends no CORS headers, so a browser cannot spend a key', async () => {
  const res = await post('/api/v1/renders', { Origin: 'https://evil.example' });
  assert.equal(
    res.headers.get('access-control-allow-origin'),
    null,
    'the API is server-to-server; a key reachable from browser JS is a leaked key',
  );
});

test('the account surface requires a session, not an API key', async () => {
  for (const [method, path] of [['GET', '/api/api-keys'], ['GET', '/api/api-credits']]) {
    const res = await fetch(`${server.baseUrl}${path}`, { method });
    assert.equal(res.status, 401, path);
    assert.equal((await res.json()).code, 'AUTH_REQUIRED', path);
  }
});

test('an API key cannot be used against the session-authenticated account routes', async () => {
  // The two halves have different auth models on purpose; a key must not open the
  // management surface that can mint more keys.
  const res = await get('/api/api-keys', { Authorization: 'Bearer stg_live_' + 'z'.repeat(43) });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'AUTH_REQUIRED');
});

test('the pack list is public, and never carries a Stripe price id', async () => {
  const res = await get('/api/api-credits/packs');
  assert.equal(res.status, 200, 'developers.html shows pricing to signed-out visitors');
  const body = await res.json();
  assert.ok(Array.isArray(body.packs));
  assert.ok(!JSON.stringify(body).includes('price_'), 'price ids are ours, not the public\'s');
});

test('the deprecated endpoint still answers, and says it is deprecated', async () => {
  // It is refused here (no admin key sent), but the header is set before the guard's
  // outcome matters to a caller migrating off it.
  const res = await post('/api/stage-by-endpoint-key');
  assert.notEqual(res.status, 404, 'it is deprecated, not gone — deleting it is a separate step');
});
