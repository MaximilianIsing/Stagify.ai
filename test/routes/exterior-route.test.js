// Tier: route contract — POST /api/enhance-exterior (routes/staging.js).
//
// Mounts the REAL staging router with faked deps, so this covers the wiring the handler's
// own unit tests cannot see: that the Pro gate is actually attached, that the handler is
// actually reached, and that a throw becomes the right status rather than a destroyed
// socket.
//
// The gate is the point. The Exterior Studio page reveals its controls from JavaScript,
// which is an affordance, not a boundary — a signed-out visitor is meant to see the
// marketing view, and a signed-in free user is meant to see an upgrade dialog, but
// neither of those stops anyone from posting to this endpoint directly. If
// requireProAccount is ever dropped from this route, every free account gets the paid
// feature and the only symptom is the bill.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountStaging } from '../helpers/staging-app.js';

const PRO = { id: 'u_pro', email: 'pro@x.com', plan: 'pro' };

/** POST a JSON body to the route (stagingProcessUpload is a pass-through in the harness). */
async function post(baseUrl, body = {}) {
  const res = await fetch(`${baseUrl}/api/enhance-exterior`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('an anonymous caller gets 401 AUTH_REQUIRED and never reaches the handler', async () => {
  let reached = false;
  const app = await mountStaging({
    handleExteriorMultipart: async (req, res) => { reached = true; return res.json({ success: true }); },
  });
  try {
    const { status, json } = await post(app.baseUrl);
    assert.equal(status, 401);
    assert.equal(json.code, 'AUTH_REQUIRED');
    assert.equal(reached, false, 'the gate must run BEFORE the handler');
  } finally { await app.close(); }
});

test('a signed-in FREE account gets 403 PRO_REQUIRED and never reaches the handler', async () => {
  // The upgrade dialog on the page is UI. This is the boundary.
  let reached = false;
  const app = await mountStaging({
    requireProAccount: (req, res) => {
      res.status(403).json({ error: 'Stagify+ subscription required', code: 'PRO_REQUIRED' });
      return null;
    },
    handleExteriorMultipart: async (req, res) => { reached = true; return res.json({ success: true }); },
  });
  try {
    const { status, json } = await post(app.baseUrl);
    assert.equal(status, 403);
    assert.equal(json.code, 'PRO_REQUIRED');
    assert.equal(reached, false);
  } finally { await app.close(); }
});

test('a Stagify+ account reaches the handler, and the handler is handed the gated user', async () => {
  // Not req.body's idea of who is calling — the object requireProAccount validated.
  let handedUser = null;
  const app = await mountStaging({
    requireProAccount: () => PRO,
    handleExteriorMultipart: async (req, res, user) => {
      handedUser = user;
      return res.json({ success: true, image: 'data:image/webp;base64,OK' });
    },
  });
  try {
    const { status, json } = await post(app.baseUrl, { timeOfDay: 'goldenHour', userEmail: 'attacker@evil.com' });
    assert.equal(status, 200);
    assert.equal(json.image, 'data:image/webp;base64,OK');
    assert.deepEqual(handedUser, PRO);
  } finally { await app.close(); }
});

test('a model that returned no image is a 422 with its own code, not a 500', async () => {
  // An expected outcome with a user-facing message, not an internal failure — so it gets
  // no error reference to quote at support.
  const app = await mountStaging({
    requireProAccount: () => PRO,
    handleExteriorMultipart: async () => {
      throw Object.assign(new Error('no image'), { code: 'NO_IMAGE_GENERATED' });
    },
  });
  try {
    const { status, json } = await post(app.baseUrl);
    assert.equal(status, 422);
    assert.equal(json.code, 'NO_IMAGE_GENERATED');
    assert.match(json.error, /exterior/i, 'the copy names the right subject');
    assert.equal(json.ref, undefined);
  } finally { await app.close(); }
});

test('a withheld disclosure stamp is named, not reported as a failed render', async () => {
  // The stamp fails CLOSED, so this error means the photo WAS enhanced and then held back
  // rather than shipped unlabelled. Falling through to the generic 500 below would tell the
  // user their enhancement failed — and the only thing they can do with that is retry, into
  // exactly the same wall, paying for a render each time. The copy has to name the option.
  const app = await mountStaging({
    requireProAccount: () => PRO,
    handleExteriorMultipart: async () => {
      throw Object.assign(new Error('badge master missing'), { code: 'DISCLOSURE_STAMP_FAILED' });
    },
  });
  try {
    const { status, json } = await post(app.baseUrl);
    assert.equal(status, 500);
    assert.equal(json.code, 'DISCLOSURE_STAMP_FAILED', 'distinct from a generic failure');
    assert.match(json.error, /untick/i, 'the one action that gets them their photo');
    assert.match(json.error, /label/i);
    assert.ok(json.ref, 'still reported — this is an environment fault worth a Sentry entry');
    assert.ok(!JSON.stringify(json).includes('badge master missing'), 'never the raw exception');
  } finally { await app.close(); }
});

test('any other throw is a 500 carrying a reference, never the error message', async () => {
  const app = await mountStaging({
    requireProAccount: () => PRO,
    handleExteriorMultipart: async () => { throw new Error('R2 secret sk_live_abc123 rejected'); },
  });
  try {
    const { status, json } = await post(app.baseUrl);
    assert.equal(status, 500);
    assert.ok(json.ref, 'a reference the user can quote');
    assert.ok(!JSON.stringify(json).includes('sk_live'), 'and nothing from the exception itself');
  } finally { await app.close(); }
});

test('a throw AFTER the handler responded does not destroy the in-flight response', async () => {
  // The regression /api/process-image's headersSent guard exists for: the handler answers
  // the request itself, so a later throw reaches a sendError that throws
  // ERR_HTTP_HEADERS_SENT, rejects the async handler, and ends at Express's default
  // handler — which destroys the socket. The client sees a truncated body instead of the
  // successful JSON it was already receiving.
  const app = await mountStaging({
    requireProAccount: () => PRO,
    handleExteriorMultipart: async (req, res) => {
      res.json({ success: true, image: 'data:image/webp;base64,SENT' });
      throw new Error('something exploded after the response');
    },
  });
  try {
    const { status, json } = await post(app.baseUrl);
    assert.equal(status, 200);
    assert.equal(json.image, 'data:image/webp;base64,SENT', 'the response arrived intact');
  } finally { await app.close(); }
});

test('the route is mounted behind the shared generation rate limiter', async () => {
  // genLimiter is the per-IP cost ceiling on every paid generation path. Mounting this
  // route without it would leave one uncapped door into Gemini.
  let limiterRan = false;
  const app = await mountStaging({
    genLimiter: (req, res, next) => { if (req.path === '/api/enhance-exterior') limiterRan = true; next(); },
    requireProAccount: () => PRO,
  });
  try {
    await post(app.baseUrl);
    assert.equal(limiterRan, true);
  } finally { await app.close(); }
});

test('the upload middleware runs before the handler', async () => {
  // stagingProcessUpload is what fills req.files; without it the handler always 400s with
  // "No image file provided" and the failure looks like a client bug.
  const order = [];
  const app = await mountStaging({
    stagingProcessUpload: (req, res, next) => { order.push('upload'); next(); },
    requireProAccount: () => { order.push('gate'); return PRO; },
    handleExteriorMultipart: async (req, res) => { order.push('handler'); return res.json({ success: true }); },
  });
  try {
    await post(app.baseUrl);
    assert.deepEqual(order, ['upload', 'gate', 'handler']);
  } finally { await app.close(); }
});
