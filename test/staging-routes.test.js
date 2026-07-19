// Tier: core pipeline (fake AI) — /api/validate-image and /api/process-image contracts.
//
// Exercises the route logic around the AI: the documented fail-open behavior of the
// validator, and process-image's auth gate + error mapping + how it dispatches to the
// staging pipeline. The AI/pipeline functions are faked, so this is deterministic and
// free. (The pipeline internals — retry/quality loop, daily-limit enforcement — live
// inside handleVirtualStagingMultipart in server.js and are covered separately once
// that's extracted; here we verify the route contract around it.)

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mountStaging } from './helpers/staging-app.js';

const IMAGE = 'data:image/jpeg;base64,' + Buffer.from('img').toString('base64');
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36';

let app;
afterEach(async () => { if (app) { await app.close(); app = null; } });

const postJson = (base, path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

// ── /api/validate-image ──────────────────────────────────────────────────────

test('validate-image: 400 on a missing or malformed image', async () => {
  app = await mountStaging({});
  assert.equal((await postJson(app.baseUrl, '/api/validate-image', {})).status, 400);
  assert.equal((await postJson(app.baseUrl, '/api/validate-image', { image: 'no-comma' })).status, 400);
});

test('validate-image: relays an approving verdict as valid, with no code or copy', async () => {
  // The route has no "is a reviewer configured?" short-circuit of its own — a disabled
  // reviewer is validateStageableImage's business, and it reports that as valid.
  app = await mountStaging({ validateStageableImage: async () => ({ valid: true, code: null, reason: '' }) });
  const body = await (await postJson(app.baseUrl, '/api/validate-image', { image: IMAGE })).json();
  assert.deepEqual(body, { valid: true, code: null, reason: '' });
});

test('validate-image: runs the reviewer even with no OpenAI client (the grader is Gemini)', async () => {
  // Regression guard: the route used to skip validation whenever `openai` was null,
  // which silently disabled a Gemini-powered check on an unrelated key.
  let called = false;
  app = await mountStaging({
    openai: null,
    validateStageableImage: async () => { called = true; return { valid: false, code: 'FOOD', reason: 'Not a room.' }; },
  });
  const body = await (await postJson(app.baseUrl, '/api/validate-image', { image: IMAGE })).json();
  assert.equal(called, true, 'the reviewer must run regardless of the OpenAI client');
  assert.equal(body.valid, false);
});

test('validate-image: relays both the category code and the copy from the reviewer', async () => {
  app = await mountStaging({
    validateStageableImage: async () => ({ valid: false, code: 'FOOD', reason: 'This is not a room.' }),
  });
  const body = await (await postJson(app.baseUrl, '/api/validate-image', { image: IMAGE })).json();
  assert.equal(body.valid, false);
  assert.equal(body.code, 'FOOD', 'the code is what the browser localizes against');
  assert.equal(body.reason, 'This is not a room.');
});

test('validate-image: fails open when the reviewer throws', async () => {
  app = await mountStaging({
    validateStageableImage: async () => { throw new Error('the grader exploded'); },
  });
  const res = await postJson(app.baseUrl, '/api/validate-image', { image: IMAGE });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { valid: true, code: null, reason: '' });
});

// ── /api/process-image ───────────────────────────────────────────────────────

test('process-image: no session is rejected (401), even from a mobile UA', async () => {
  app = await mountStaging({ getAuthUserFromRequest: () => null });

  const desktop = await postJson(app.baseUrl, '/api/process-image', {}, { 'user-agent': DESKTOP_UA });
  assert.equal(desktop.status, 401);
  assert.equal((await desktop.json()).code, 'AUTH_REQUIRED');

  // The old anonymous "mobile" bypass is gone: a mobile UA no longer grants
  // accountless staging, closing the IP-rotation cost-abuse vector.
  const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Mobile/15E148';
  const mobile = await postJson(app.baseUrl, '/api/process-image', {}, { 'user-agent': MOBILE_UA });
  assert.equal(mobile.status, 401, 'mobile UA must still require sign-in');
  assert.equal((await mobile.json()).code, 'AUTH_REQUIRED');
});

test('process-image: dispatches to the pipeline with the right flags for a signed-in user', async () => {
  let meta = null;
  app = await mountStaging({
    getAuthUserFromRequest: () => ({ id: 'u1', plan: 'free' }),
    handleVirtualStagingMultipart: async (req, res, m) => { meta = m; res.json({ success: true, image: 'x' }); },
  });
  const res = await postJson(app.baseUrl, '/api/process-image', {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).success, true);
  assert.equal(meta.recordUsage, true, 'public staging records usage');
  assert.equal(meta.treatAsPro, false, 'public staging is not treated as pro');
  assert.equal(meta.user.id, 'u1');
});

test('process-image: NO_IMAGE_GENERATED maps to 422, other errors to 500', async () => {
  app = await mountStaging({
    getAuthUserFromRequest: () => ({ id: 'u1', plan: 'free' }),
    handleVirtualStagingMultipart: async () => { const e = new Error('nope'); e.code = 'NO_IMAGE_GENERATED'; throw e; },
  });
  assert.equal((await postJson(app.baseUrl, '/api/process-image', {})).status, 422);
  await app.close();

  app = await mountStaging({
    getAuthUserFromRequest: () => ({ id: 'u1', plan: 'free' }),
    handleVirtualStagingMultipart: async () => { throw new Error('some other failure'); },
  });
  assert.equal((await postJson(app.baseUrl, '/api/process-image', {})).status, 500);
});
