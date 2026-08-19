// Tier: integration (real Express + real credit store, faked render handler) —
// routes/api-v1.js.
//
// WHAT THIS COVERS
// The public API's HTTP surface: the status codes and machine-readable `code`s a paying
// integration will actually branch on, and — more importantly — that every refusal
// happens on the right side of the money.
//
// The load-bearing case is the FIRST one: a caller with no credits must be refused
// before the render handler is invoked at all, because by the time it runs a paid
// Gemini call has been made and refusing afterwards costs us the money either way.
//
// The render handler is a fake so no model is called and no image is produced; the
// billing store underneath is REAL, because the point of these tests is how the two
// compose. Every `sendError` branch is walked, which is also what holds the branch
// coverage floor.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { closeDb } from '../../lib/data/db.js';
import { createApiBilling } from '../../lib/data/api-billing.js';
import { createApiRenderBilling } from '../../lib/staging/api-render-billing.js';
import createApiV1Router from '../../routes/api-v1.js';

const tempDirs = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-api-v1-'));
  tempDirs.push(d);
  return d;
}
const servers = [];
afterEach(async () => {
  while (servers.length) await new Promise((r) => servers.pop().close(r));
  while (tempDirs.length) {
    const d = tempDirs.pop();
    try { closeDb(d); } catch { /* already closed */ }
    fs.rmSync(d, { recursive: true, force: true });
  }
});

const USER = { id: 'user_1', email: 'dev@example.com', plan: 'free' };

/**
 * Boot a real Express app carrying only this router.
 * @param {{ render?: Function, suspended?: boolean }} [over]
 */
async function boot(over = {}) {
  const billing = createApiBilling(tempDir());
  const calls = [];
  const render = over.render || (async (req, res) => res.status(200).json({ ok: true, image: 'data:image/webp;base64,AA' }));

  const { runBilledRender } = createApiRenderBilling({
    apiBilling: billing,
    handleVirtualStagingMultipart: async (req, res, meta) => {
      calls.push({ meta, body: req.body });
      return render(req, res, meta);
    },
  });

  const app = express();
  app.use(express.json());
  app.use(
    createApiV1Router({
      apiBilling: billing,
      // A stand-in for requireApiKey: the real one has its own spec, and faking it here
      // keeps these tests about the ROUTES rather than about authentication.
      requireApiKey: (req, res, next) => {
        if (req.get('Authorization') !== 'Bearer good') {
          return res.status(401).json({ error: 'no', code: 'API_KEY_INVALID' });
        }
        req.apiKey = { id: 'ak_1', userId: USER.id, prefix: 'stg_live_aaa' };
        req.apiUser = USER;
        return next();
      },
      concurrencyGate: (req, res, next) => next(),
      // Multer stand-in: the real one is exercised by the staging suite. This just puts
      // a file where the handler expects one so the fingerprint has something to hash.
      stagingProcessUpload: (req, res, next) => {
        req.files = { image: [{ buffer: Buffer.from(req.get('X-Test-Photo') || 'photo'), originalname: 'r.jpg' }] };
        next();
      },
      runBilledRender,
      apiRenderLimiter: (req, res, next) => next(),
    }),
  );

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { billing, base, calls };
}

/** POST a render with the happy-path headers. */
const post = (base, opts = {}) =>
  fetch(base + '/api/v1/renders', {
    method: 'POST',
    headers: {
      Authorization: opts.auth ?? 'Bearer good',
      'Content-Type': 'application/json',
      ...(opts.idem ? { 'Idempotency-Key': opts.idem } : {}),
      ...(opts.photo ? { 'X-Test-Photo': opts.photo } : {}),
    },
    body: JSON.stringify(opts.body || { roomType: 'Bedroom' }),
  });

test('zero balance is 402 and the render handler is NEVER invoked', async () => {
  const { base, calls, billing } = await boot({
    render: async () => { throw new Error('a model call would already have been paid for'); },
  });

  const res = await post(base);
  const body = await res.json();

  assert.equal(res.status, 402);
  assert.equal(body.code, 'INSUFFICIENT_CREDITS');
  assert.equal(body.credits_required, 1);
  assert.equal(body.credits_remaining, 0);
  assert.equal(calls.length, 0, 'no paid work may happen before the credit is taken');
  assert.equal(billing.getBalance(USER.id).balance, 0);
});

test('a funded call renders, debits one credit, and advertises the balance', async () => {
  const { base, billing } = await boot();
  billing.grantCredits({ userId: USER.id, credits: 3 });

  const res = await post(base);

  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.equal(res.headers.get('x-stagify-credits-remaining'), '2', 'a client must see the wall coming');
  assert.match(res.headers.get('x-stagify-request-id') || '', /^req_/);
  assert.equal(res.headers.get('x-stagify-replayed'), 'false');
  assert.equal(billing.getBalance(USER.id).balance, 2);
});

test('an unauthenticated call never reaches the billing layer', async () => {
  const { base, calls } = await boot();
  const res = await post(base, { auth: 'Bearer nope' });
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('asking for more than one variation is refused, not silently billed as one', async () => {
  const { base, billing } = await boot();
  billing.grantCredits({ userId: USER.id, credits: 3 });

  const res = await post(base, { body: { roomType: 'Bedroom', variations: 3 } });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(body.code, 'VARIATIONS_UNSUPPORTED');
  assert.equal(billing.getBalance(USER.id).balance, 3, 'a refused shape costs nothing');
});

test('REGRESSION: variationCount is refused too — it is the name the pipeline reads', async () => {
  // The guard used to check only `variations`, the DOCUMENTED spelling, while
  // virtual-staging-handler.js destructures `variationCount`. Two different strings, so
  // this body sailed through, and `if (!isPro) variationCount = 1` could not save it
  // either: the API path sets treatAsPro. Three images, one credit.
  const { base, billing } = await boot();
  billing.grantCredits({ userId: USER.id, credits: 3 });

  const res = await post(base, { body: { roomType: 'Bedroom', variationCount: 3 } });

  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'VARIATIONS_UNSUPPORTED');
  assert.equal(billing.getBalance(USER.id).balance, 3);
});

test('REGRESSION: the pipeline is pinned to one image and one model, whatever is sent', async () => {
  // The belt to the router's braces. Even a body that slips past the 400 above — a
  // future second caller of runBilledRender, a spelling nobody thought of — must reach
  // the handler with the count pinned and the model gone, because the debit is a FLAT
  // cost that does not scale with either.
  const { base, billing, calls } = await boot();
  billing.grantCredits({ userId: USER.id, credits: 3 });

  await post(base, { body: { roomType: 'Bedroom', variationCount: 1, model: 'gpt-5-mini' } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.variationCount, '1', 'one credit buys exactly one image');
  assert.equal(calls[0].body.model, undefined,
    'a caller must not pick the model on a fixed-price credit');
  assert.equal(billing.getBalance(USER.id).balance, 2, 'and it still costs exactly one');
});

test('GET /api/v1/options is readable WITHOUT a key, and publishes the vocabularies', async () => {
  // Deliberately the one unauthenticated route in this router: an integrator needs the
  // accepted values while deciding whether to buy credits, which is before they have a
  // key to send, and developers.html fetches it as an anonymous visitor.
  const { base, calls } = await boot();

  const res = await fetch(base + '/api/v1/options'); // no Authorization header
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.object, 'options');
  assert.ok(body.room_type.values.includes('Living room'));
  assert.ok(!body.room_type.values.includes('Living Room'), 'case matters, and the list says so');
  assert.ok(body.furniture_style.values.includes('standard'));
  assert.equal(body.stamp_scale.min, 0.7);
  assert.equal(body.variations.default, 1);
  assert.equal(calls.length, 0, 'reading the vocabulary must never touch the renderer');
});

test('a render that throws is 500 RENDER_FAILED and the credit comes back', async () => {
  const { base, billing } = await boot({ render: async () => { throw new Error('gemini exploded'); } });
  billing.grantCredits({ userId: USER.id, credits: 3 });

  const res = await post(base);
  const body = await res.json();

  assert.equal(res.status, 500);
  assert.equal(body.code, 'RENDER_FAILED');
  assert.ok(body.ref, 'the operator needs a reference');
  assert.ok(!/gemini exploded/.test(JSON.stringify(body)), 'the raw error must not leak');
  assert.equal(billing.getBalance(USER.id).balance, 3);
});

test('a withheld disclosure stamp gets its own code, and refunds', async () => {
  // Without a distinct code this is indistinguishable from a generation failure and
  // the client retries into the same wall forever.
  const { base, billing } = await boot({
    render: async () => { throw Object.assign(new Error('stamp'), { code: 'DISCLOSURE_STAMP_FAILED' }); },
  });
  billing.grantCredits({ userId: USER.id, credits: 3 });

  const res = await post(base);
  const body = await res.json();

  assert.equal(res.status, 500);
  assert.equal(body.code, 'DISCLOSURE_STAMP_FAILED');
  assert.match(body.error, /labelVirtuallyStaged/, 'name the option to untick');
  assert.equal(billing.getBalance(USER.id).balance, 3);
});

test('a model that returns nothing is 422 and refunds', async () => {
  const { base, billing } = await boot({
    render: async () => { throw Object.assign(new Error('none'), { code: 'NO_IMAGE_GENERATED' }); },
  });
  billing.grantCredits({ userId: USER.id, credits: 3 });

  const res = await post(base);
  const body = await res.json();

  assert.equal(res.status, 422);
  assert.equal(body.code, 'NO_IMAGE_GENERATED');
  assert.match(body.error, /refunded/);
  assert.equal(billing.getBalance(USER.id).balance, 3);
});

test('an in-band error from the handler still refunds', async () => {
  const { base, billing } = await boot({
    render: async (req, res) => res.status(400).json({ error: 'No image file provided' }),
  });
  billing.grantCredits({ userId: USER.id, credits: 3 });

  const res = await post(base);
  assert.equal(res.status, 400);
  assert.equal(billing.getBalance(USER.id).balance, 3, 'the caller must not pay for a 400');
});

test('replaying an idempotency key does not re-render or re-charge', async () => {
  let ran = 0;
  const { base, billing } = await boot({
    render: async (req, res) => { ran += 1; return res.status(200).json({ ok: true }); },
  });
  billing.grantCredits({ userId: USER.id, credits: 5 });

  const first = await post(base, { idem: 'abc' });
  assert.equal(first.status, 200);

  const replay = await post(base, { idem: 'abc' });
  const body = await replay.json();

  assert.equal(replay.status, 200);
  assert.equal(body.replayed, true);
  assert.equal(body.status, 'succeeded');
  assert.equal(replay.headers.get('x-stagify-replayed'), 'true');
  assert.equal(ran, 1);
  assert.equal(billing.getBalance(USER.id).balance, 4);
});

test('reusing an idempotency key for a different photo is 422', async () => {
  const { base, billing } = await boot();
  billing.grantCredits({ userId: USER.id, credits: 5 });

  await post(base, { idem: 'k1', photo: 'living-room' });
  const res = await post(base, { idem: 'k1', photo: 'a-totally-different-room' });
  const body = await res.json();

  assert.equal(res.status, 422);
  assert.equal(body.code, 'IDEMPOTENCY_KEY_REUSED');
});

test('a suspended account is 403 at the render route', async () => {
  const { base, billing } = await boot();
  billing.creditPurchase({ userId: USER.id, credits: 5, sessionId: 'cs_1' });
  billing.clawbackCredits({ userId: USER.id, credits: 99, externalId: 'ch_1' });

  const res = await post(base);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'ACCOUNT_SUSPENDED');
});

test('GET /api/v1/credits reports the balance and its lifetime totals', async () => {
  const { base, billing } = await boot();
  billing.creditPurchase({ userId: USER.id, credits: 10, sessionId: 'cs_2' });
  await post(base);

  const res = await fetch(base + '/api/v1/credits', { headers: { Authorization: 'Bearer good' } });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.object, 'credits');
  assert.equal(body.balance, 9);
  assert.equal(body.lifetime_purchased, 10);
  assert.equal(body.lifetime_spent, 1);
});

test('GET /api/v1/me is the cheap "is my key working" call', async () => {
  const { base } = await boot();
  const res = await fetch(base + '/api/v1/me', { headers: { Authorization: 'Bearer good' } });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.email, USER.email);
  assert.equal(body.key_prefix, 'stg_live_aaa');
  assert.equal(body.credits, 0);
});

test('GET /api/v1/renders/:id is owner-scoped and is not an existence oracle', async () => {
  const { base, billing } = await boot();
  billing.grantCredits({ userId: USER.id, credits: 2 });
  const made = await post(base);
  const id = made.headers.get('x-stagify-request-id');

  const mine = await fetch(base + '/api/v1/renders/' + id, { headers: { Authorization: 'Bearer good' } });
  assert.equal(mine.status, 200);
  assert.equal((await mine.json()).status, 'succeeded');

  // Somebody else's request, and one that never existed, must be indistinguishable.
  const theirs = billing.claimAndDebit({
    keyId: 'ak_2', userId: 'user_2', idempotencyKey: 'x', fingerprint: 'f', cost: 0,
  });
  const stranger = await fetch(base + '/api/v1/renders/' + theirs.requestId, { headers: { Authorization: 'Bearer good' } });
  const missing = await fetch(base + '/api/v1/renders/req_nope', { headers: { Authorization: 'Bearer good' } });

  assert.equal(stranger.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(await stranger.json(), await missing.json());
});

test('two calls without an Idempotency-Key are two separate renders, not a collision', async () => {
  // Deriving a key from the body would hand the second caller the first one's image.
  let ran = 0;
  const { base, billing } = await boot({
    render: async (req, res) => { ran += 1; return res.status(200).json({ ok: true }); },
  });
  billing.grantCredits({ userId: USER.id, credits: 5 });

  await post(base);
  await post(base);

  assert.equal(ran, 2);
  assert.equal(billing.getBalance(USER.id).balance, 3);
});
