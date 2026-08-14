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
import { mountStaging } from '../helpers/staging-app.js';

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

// The route is signed-in only — it spends a paid Gemini vision call — so the
// behavioural tests below mount with a session. The gate itself is tested last.
const SIGNED_IN = { getAuthUserFromRequest: () => ({ id: 'u_test', plan: 'free' }) };

test('validate-image: 400 on a missing or malformed image', async () => {
  app = await mountStaging({ ...SIGNED_IN });
  assert.equal((await postJson(app.baseUrl, '/api/validate-image', {})).status, 400);
  assert.equal((await postJson(app.baseUrl, '/api/validate-image', { image: 'no-comma' })).status, 400);
});

test('validate-image: relays an approving verdict as valid, with no code or copy', async () => {
  // The route has no "is a reviewer configured?" short-circuit of its own — a disabled
  // reviewer is validateStageableImage's business, and it reports that as valid.
  app = await mountStaging({ ...SIGNED_IN, validateStageableImage: async () => ({ valid: true, code: null, reason: '' }) });
  const body = await (await postJson(app.baseUrl, '/api/validate-image', { image: IMAGE })).json();
  assert.deepEqual(body, { valid: true, code: null, reason: '' });
});

test('validate-image: runs the reviewer even with no OpenAI client (the grader is Gemini)', async () => {
  // Regression guard: the route used to skip validation whenever `openai` was null,
  // which silently disabled a Gemini-powered check on an unrelated key.
  let called = false;
  app = await mountStaging({
    ...SIGNED_IN,
    openai: null,
    validateStageableImage: async () => { called = true; return { valid: false, code: 'FOOD', reason: 'Not a room.' }; },
  });
  const body = await (await postJson(app.baseUrl, '/api/validate-image', { image: IMAGE })).json();
  assert.equal(called, true, 'the reviewer must run regardless of the OpenAI client');
  assert.equal(body.valid, false);
});

test('validate-image: relays both the category code and the copy from the reviewer', async () => {
  app = await mountStaging({
    ...SIGNED_IN,
    validateStageableImage: async () => ({ valid: false, code: 'FOOD', reason: 'This is not a room.' }),
  });
  const body = await (await postJson(app.baseUrl, '/api/validate-image', { image: IMAGE })).json();
  assert.equal(body.valid, false);
  assert.equal(body.code, 'FOOD', 'the code is what the browser localizes against');
  assert.equal(body.reason, 'This is not a room.');
});

test('validate-image: a refused upload is RECORDED as a rejection', async () => {
  // This is the likeliest first-session abandonment there is — someone uploads the
  // wrong kind of photo, is told no, and leaves — and it used to produce no data at
  // all, in any log, making the drop-off unmeasurable.
  const rejections = [];
  app = await mountStaging({
    getAuthUserFromRequest: () => ({ id: 'u_test', email: 'u@x.com', plan: 'free' }),
    validateStageableImage: async () => ({ valid: false, code: 'ANIMAL', reason: 'This looks like a pet.' }),
    logRejectionToFile: (kind, code, detail, who) => rejections.push({ kind, code, detail, email: who.email, userId: who.userId }),
  });
  const res = await postJson(app.baseUrl, '/api/validate-image', { image: IMAGE });

  assert.equal(res.status, 200, 'the verdict is still a normal 200 body');
  assert.deepEqual(rejections, [{
    kind: 'unstageable', code: 'ANIMAL', detail: 'This looks like a pet.',
    email: 'u@x.com', userId: 'u_test',
  }]);
});

test('validate-image: EXTERIOR relays and records like any other category', async () => {
  // The category that sends the user somewhere rather than away. Two things have to
  // survive the route: the CODE, because the browser keys the Exterior Studio button off
  // it and a stripped code degrades to a plain sentence with no hand-off; and the log
  // row, because the rejection funnel is the only way to learn whether the boundary was
  // drawn in the right place once real photos meet it.
  const rejections = [];
  app = await mountStaging({
    getAuthUserFromRequest: () => ({ id: 'u_test', email: 'u@x.com', plan: 'free' }),
    validateStageableImage: async () => ({
      valid: false, code: 'EXTERIOR', reason: 'This looks like a photo of a building from the outside.',
    }),
    logRejectionToFile: (kind, code, detail, who) => rejections.push({ kind, code, detail, email: who.email, userId: who.userId }),
  });
  const res = await postJson(app.baseUrl, '/api/validate-image', { image: IMAGE });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.valid, false);
  assert.equal(body.code, 'EXTERIOR', 'without the code there is no button, only a sentence');
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0].code, 'EXTERIOR');
});

test('validate-image: an ACCEPTED upload records nothing', async () => {
  const rejections = [];
  app = await mountStaging({
    ...SIGNED_IN,
    validateStageableImage: async () => ({ valid: true, code: null, reason: '' }),
    logRejectionToFile: (...a) => rejections.push(a),
  });
  await postJson(app.baseUrl, '/api/validate-image', { image: IMAGE });
  assert.deepEqual(rejections, []);
});

test('validate-image: a logging failure never turns a clean rejection into a 500', async () => {
  app = await mountStaging({
    ...SIGNED_IN,
    validateStageableImage: async () => ({ valid: false, code: 'FOOD', reason: 'Not a room.' }),
    logRejectionToFile: () => { throw new Error('disk full'); },
  });
  const res = await postJson(app.baseUrl, '/api/validate-image', { image: IMAGE });
  // The route's catch-all fails OPEN, so the user is never blocked by our bookkeeping.
  assert.equal(res.status, 200);
  assert.equal((await res.json()).valid, true);
});

test('validate-image: fails open when the reviewer throws', async () => {
  app = await mountStaging({
    ...SIGNED_IN,
    validateStageableImage: async () => { throw new Error('the grader exploded'); },
  });
  const res = await postJson(app.baseUrl, '/api/validate-image', { image: IMAGE });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { valid: true, code: null, reason: '' });
});

test('validate-image: an anonymous caller is rejected WITHOUT spending a vision call', async () => {
  // genLimiter caps requests per IP, which bounds cost per address but not across
  // rotating ones; only the session check stops an anonymous caller from spending
  // the paid Gemini call at all. Asserting the reviewer never ran is the point —
  // a 401 returned *after* the call would fix nothing.
  let called = false;
  app = await mountStaging({
    getAuthUserFromRequest: () => null,
    validateStageableImage: async () => { called = true; return { valid: true, code: null, reason: '' }; },
  });
  const res = await postJson(app.baseUrl, '/api/validate-image', { image: IMAGE });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'AUTH_REQUIRED', 'same code the studios already handle');
  assert.equal(called, false, 'the reviewer must not run for an unauthenticated caller');
});

test('validate-image: the session check runs before body validation', async () => {
  // Otherwise a malformed body would still be parsed and answered for anonymous
  // callers, and the gate would be ordering-dependent rather than unconditional.
  app = await mountStaging({ getAuthUserFromRequest: () => null });
  const res = await postJson(app.baseUrl, '/api/validate-image', {});
  assert.equal(res.status, 401, 'anonymous gets 401, not the 400 for a missing image');
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

test('process-image: DISCLOSURE_STAMP_FAILED is a distinct 500, not a generic failure', async () => {
  // The stamp fails CLOSED, so this response means "your render succeeded and we withheld
  // it", not "generation broke". It needs its own code for two reasons: the browser shows a
  // different message, and a client that cannot tell the difference retries into the same
  // wall forever. The generic 500 above carries no `code` at all, which is what makes this
  // distinguishable.
  app = await mountStaging({
    getAuthUserFromRequest: () => ({ id: 'u1', plan: 'free' }),
    handleVirtualStagingMultipart: async () => {
      const e = new Error('badge master unreadable');
      e.code = 'DISCLOSURE_STAMP_FAILED';
      throw e;
    },
  });
  const res = await postJson(app.baseUrl, '/api/process-image', {});
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.code, 'DISCLOSURE_STAMP_FAILED', 'the frontend branches on this code');
  assert.match(body.error, /virtually staged/i, 'the message names the option that caused it');
  assert.ok(body.ref, 'still reported — an unstampable environment must reach Sentry');
  // The underlying reason must not leak to the client; only the ref identifies it.
  assert.doesNotMatch(body.error, /badge master unreadable/, 'internal detail stays server-side');
});
