// Tier: core pipeline (fake AI) — POST /api/mask-edit contract (Masking Studio).
//
// This exercises the REAL /api/mask-edit handler in routes/staging.js — its auth
// gate, config guard, presence/length validation, sharp-based image decoding, the
// single model-call seam (generateWithQualityRetry), enterprise metering, and the
// success/error response shaping. It does NOT touch a network or a real model.
//
// WHY NO REAL API CALL HAPPENS: the handler's only path to Gemini is through the
// injected `generateWithQualityRetry(generateOnce, label, onImageProduced, reviewFn,
// maxAttempts)` dependency. Every happy-path test overrides it with a fake async that
// returns a canned data URL WITHOUT ever invoking `generateOnce` — so
// `genAI.getGenerativeModel(...)` is never reached and no model client is called. The
// baseDeps default for generateWithQualityRetry deliberately THROWS ("not stubbed"),
// which is why any test that expects success must override it. genAI is only ever the
// empty object `{}` (truthy, to pass the config guard) and is never actually used once
// the model seam is faked.
//
// The handler decodes `image` and `mask` through sharp UNCONDITIONALLY
// (sharp(buffer).metadata() at routes/staging.js), so the image/mask fixtures must be
// REAL, sharp-decodable PNGs — we build them with sharp below. A bogus base64 image
// therefore does NOT 400 (it passes the presence check) but throws inside sharp and is
// mapped to 500 by the catch-all — test #8 asserts that ACTUAL behavior.
//
// Everything runs against a real Express router mounted by the shared DI helper
// (test/helpers/staging-app.js → mountStaging), listening on an ephemeral loopback
// port; we drive it with global fetch.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mountStaging } from '../helpers/staging-app.js';

// Build a real, sharp-decodable PNG data URL — the handler runs sharp(buffer).metadata()
// on the image and mask, so these must be genuine PNG bytes, not arbitrary base64.
async function pngDataUrl(width = 8, height = 8, background = { r: 128, g: 128, b: 128 }) {
  const buf = await sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toBuffer();
  return 'data:image/png;base64,' + buf.toString('base64');
}

// Fixtures (top-level await is supported in ESM test files run by node --test).
const IMAGE = await pngDataUrl(8, 8, { r: 100, g: 120, b: 140 });
const MASK = await pngDataUrl(8, 8, { r: 255, g: 255, b: 255 });
const REFERENCE = await pngDataUrl(4, 4, { r: 200, g: 100, b: 50 });

// A truthy pro user, so requireProAccount does not short-circuit with 401.
const proUser = () => ({ id: 'u1', email: 'pro@example.com', plan: 'pro' });

// A generateWithQualityRetry fake that short-circuits ALL model work: it never calls
// the passed `generateOnce`, so genAI is never touched. It records the label it was
// invoked with and (optionally) pumps onImageProduced to exercise enterprise metering.
function fakeRetry(captured, { produce = 0, returns = 'data:image/png;base64,AAAA' } = {}) {
  return async (generateOnce, label, onImageProduced /*, reviewFn, maxAttempts */) => {
    captured.label = label;
    for (let i = 0; i < produce; i += 1) onImageProduced();
    return returns;
  };
}

const postJson = (base, path, body) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

let app;
afterEach(async () => { if (app) { await app.close(); app = null; } });

// ── auth + config guards ──────────────────────────────────────────────────────

test('mask-edit: rejects an unauthenticated request with 401 AUTH_REQUIRED before any image work', async () => {
  // Default baseDeps.requireProAccount responds 401 and returns null, so the handler
  // returns immediately — no image/mask needed in the body.
  app = await mountStaging({});
  const res = await postJson(app.baseUrl, '/api/mask-edit', {});
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'AUTH_REQUIRED');
});

test('mask-edit: returns 500 "AI service not properly configured" when genAI is missing', async () => {
  // Past the auth gate (pro user), but genAI stays null → config guard fires.
  app = await mountStaging({ requireProAccount: proUser, genAI: null });
  const res = await postJson(app.baseUrl, '/api/mask-edit', { image: IMAGE, mask: MASK, prompt: 'add a sofa' });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'AI service not properly configured');
});

// ── input validation ──────────────────────────────────────────────────────────

test('mask-edit: returns 400 when image, mask, or prompt are missing', async () => {
  app = await mountStaging({ requireProAccount: proUser, genAI: {} });
  const res = await postJson(app.baseUrl, '/api/mask-edit', {});
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Image, mask, and prompt are required');
});

// A malformed payload is the CLIENT's fault and must read as one. Only truthiness
// was checked here, so `image: 'x'` reached `Buffer.from(undefined, 'base64')` and
// threw ERR_INVALID_ARG_TYPE — served as a 500 with an error ref, a full stack in
// the log and a Sentry report. Every bad request looked like a production incident.
// Note the deliberate split with the sharp test further down: a wrong SHAPE is a
// 400 here; correct shape with undecodable BYTES stays a 500.
test('mask-edit: a non-data-URL image or mask is a 400, not a 500', async () => {
  const cases = [
    { image: 'x', mask: MASK, what: 'a bare string image' },
    { image: IMAGE, mask: 'y', what: 'a bare string mask' },
    { image: 'https://example.com/a.png', mask: MASK, what: 'a plain URL' },
    { image: 'data:text/html;base64,PGI+', mask: MASK, what: 'a non-image data URL' },
    { image: 'data:image/png;base64,', mask: MASK, what: 'a data URL with an empty payload' },
    { image: 42, mask: MASK, what: 'a non-string image' },
  ];
  for (const { image, mask, what } of cases) {
    app = await mountStaging({ requireProAccount: proUser, genAI: {} });
    const res = await postJson(app.baseUrl, '/api/mask-edit', { image, mask, prompt: 'add a lamp' });
    assert.equal(res.status, 400, `${what} must be a 400`);
    const body = await res.json();
    assert.ok(!body.ref, `${what} must not be reported as a server error with an error ref`);
    await app.close();
    app = null;
  }
});

test('mask-edit: a whitespace-only prompt is trimmed to empty and rejected with 400 (same as missing)', async () => {
  // The handler trims BEFORE the presence check (routes/staging.js ~266-268): prompt.trim()
  // collapses '   ' to '' and `!trimmedPrompt` fires, so a whitespace-only prompt takes the
  // exact same 400 branch as an absent one — it never reaches the length check or sharp.
  app = await mountStaging({ requireProAccount: proUser, genAI: {} });
  const res = await postJson(app.baseUrl, '/api/mask-edit', {
    image: IMAGE,
    mask: MASK,
    prompt: '   ',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Image, mask, and prompt are required');
});

test('mask-edit: returns 400 when the prompt exceeds the 1000-character limit', async () => {
  app = await mountStaging({ requireProAccount: proUser, genAI: {} });
  const res = await postJson(app.baseUrl, '/api/mask-edit', {
    image: IMAGE,
    mask: MASK,
    prompt: 'x'.repeat(1001), // one over MAX_MASK_PROMPT_LENGTH; the guard rejects length > 1000
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Prompt is too long/);
});

test('mask-edit: accepts a prompt of exactly MAX_MASK_PROMPT_LENGTH (1000) characters → 200 (boundary passes)', async () => {
  // The length guard is strictly `> MAX_MASK_PROMPT_LENGTH` (routes/staging.js ~270), so a
  // 1000-char prompt is at the boundary and passes; over-limit begins at 1001 (asserted above).
  const captured = {};
  app = await mountStaging({
    requireProAccount: proUser,
    genAI: {},
    generateWithQualityRetry: fakeRetry(captured, { produce: 1 }),
  });
  const res = await postJson(app.baseUrl, '/api/mask-edit', {
    image: IMAGE,
    mask: MASK,
    prompt: 'x'.repeat(1000), // 'x' has no whitespace, so trim() leaves length exactly 1000
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.editedImage, 'data:image/png;base64,AAAA');
  assert.equal(captured.label, 'mask-edit');
});

// ── happy path ──────────────────────────────────────────────────────────────

test('mask-edit: returns the edited image on success, calling the model seam with label "mask-edit"', async () => {
  const captured = {};
  app = await mountStaging({
    requireProAccount: proUser,
    genAI: {}, // truthy to pass the config guard; never actually used (model seam is faked)
    generateWithQualityRetry: fakeRetry(captured, { produce: 1 }),
  });
  const res = await postJson(app.baseUrl, '/api/mask-edit', {
    image: IMAGE,
    mask: MASK,
    prompt: 'add a green plant in the corner',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.editedImage, 'data:image/png;base64,AAAA');
  assert.equal(body.referenceUsed, false);
  // The handler must label this seam invocation "mask-edit".
  assert.equal(captured.label, 'mask-edit');
});

test('mask-edit: every area gets the SAME quality budget, however many were painted', async () => {
  // Regression guard. The handler used to trim maxAttempts from QUALITY_MAX_ATTEMPTS
  // to 2 whenever the client reported a fan-out of 3+ areas, as a cost guard. The
  // effect was that the Masking Studio — a paid-only feature — silently produced
  // lower-quality results the more areas a user painted, with nothing in the UI
  // saying so. Quality must not depend on how hard the feature is used.
  const budgets = [];
  const captureBudget = async (_generateOnce, label, onImageProduced, _reviewFn, maxAttempts) => {
    budgets.push(maxAttempts);
    if (onImageProduced) onImageProduced();
    return 'data:image/png;base64,AAAA';
  };
  // `batch` is no longer part of the contract; send it anyway to prove a stale client
  // (or a replayed request) cannot reintroduce the downgrade.
  for (const batch of [1, 3, 6, undefined]) {
    app = await mountStaging({
      requireProAccount: proUser,
      genAI: {},
      generateWithQualityRetry: captureBudget,
    });
    const res = await postJson(app.baseUrl, '/api/mask-edit', {
      image: IMAGE, mask: MASK, prompt: 'add a rug', ...(batch === undefined ? {} : { batch }),
    });
    assert.equal(res.status, 200);
    await app.close(); app = null;
  }
  assert.equal(budgets.length, 4);
  assert.equal(new Set(budgets).size, 1, `all batch sizes must share one budget, got ${budgets.join(',')}`);
  assert.ok(budgets[0] > 2, 'the shared budget is the full QUALITY_MAX_ATTEMPTS, not the trimmed 2');
});

test('mask-edit: a successful edit records trial activation for the pro account', async () => {
  // The Masking Studio is Stagify+ only, so every edit here is trial/paid usage. It
  // used to write NO activity timestamp, so the lifecycle sweep saw a heavy Masking
  // Studio user as "signed up but never staged" and sent them the activation nudge.
  const recorded = [];
  app = await mountStaging({
    requireProAccount: proUser,
    genAI: {},
    generateWithQualityRetry: fakeRetry({}, { produce: 1 }),
    recordStagingActivity: (u) => { recorded.push(u.id); return true; },
  });
  const res = await postJson(app.baseUrl, '/api/mask-edit', {
    image: IMAGE, mask: MASK, prompt: 'add a plant',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(recorded, ['u1']);
});

test('mask-edit: an enterprise-billed edit meters the domain instead of the trial signal', async () => {
  // Enterprise seats are billed per generation and are not trialing, so the activity
  // signal is deliberately not written for them.
  const recorded = [];
  const metered = [];
  app = await mountStaging({
    requireProAccount: proUser,
    genAI: {},
    generateWithQualityRetry: fakeRetry({}, { produce: 2 }),
    enterpriseDomainForUser: () => 'acme.com',
    reportEnterpriseUsage: (d, n) => metered.push({ d, n }),
    recordStagingActivity: (u) => { recorded.push(u.id); return true; },
  });
  const res = await postJson(app.baseUrl, '/api/mask-edit', {
    image: IMAGE, mask: MASK, prompt: 'add a plant',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(metered, [{ d: 'acme.com', n: 2 }]);
  assert.deepEqual(recorded, []);
});

test('mask-edit: reports referenceUsed:true when a valid reference image is supplied', async () => {
  const captured = {};
  app = await mountStaging({
    requireProAccount: proUser,
    genAI: {},
    generateWithQualityRetry: fakeRetry(captured, { produce: 1 }),
  });
  const res = await postJson(app.baseUrl, '/api/mask-edit', {
    image: IMAGE,
    mask: MASK,
    prompt: 'match this couch',
    referenceImage: REFERENCE,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.referenceUsed, true);
});

test('mask-edit: a present-but-undecodable referenceImage is caught and the edit still 200s with referenceUsed:false', async () => {
  // '@@@' contains a comma, so the reference branch is entered (routes/staging.js ~348), but
  // Buffer.from('@@@','base64') decodes to an empty buffer → the `empty reference buffer` throw
  // at ~353 is swallowed by that branch's own try/catch (~382), which nulls referenceInline and
  // continues. The main edit therefore still succeeds and reports referenceUsed:false.
  const captured = {};
  app = await mountStaging({
    requireProAccount: proUser,
    genAI: {},
    generateWithQualityRetry: fakeRetry(captured, { produce: 1 }),
  });
  const res = await postJson(app.baseUrl, '/api/mask-edit', {
    image: IMAGE,
    mask: MASK,
    prompt: 'match this couch',
    referenceImage: 'data:image/png;base64,@@@', // present + has a comma, but not real image bytes
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.referenceUsed, false);
  assert.equal(captured.label, 'mask-edit', 'the main model seam still runs after the reference is dropped');
});

// ── error mapping ─────────────────────────────────────────────────────────────

test('mask-edit: maps a thrown model-seam error to 500 with a reference, not the message', async () => {
  // The thrown text stands in for what really lands here — sharp's decode errors,
  // the Gemini SDK's quota prose, an fs path. The caller gets a reference to quote
  // at support; only the log gets the message.
  app = await mountStaging({
    requireProAccount: proUser,
    genAI: {},
    generateWithQualityRetry: async () => { throw new Error('boom: /srv/app/secret/path'); },
  });
  const res = await postJson(app.baseUrl, '/api/mask-edit', {
    image: IMAGE,
    mask: MASK,
    prompt: 'add a rug',
  });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, 'Failed to process masked edit');
  assert.match(body.ref, /^[0-9a-f]{8}$/, 'a reference the operator can grep for');
  assert.equal(body.details, undefined, 'no diagnostic channel is populated at all');
  assert.doesNotMatch(JSON.stringify(body), /boom|secret/, 'the exception text never leaves the server');
});

test('mask-edit: an undecodable image passes the presence check but fails inside sharp → 500 (not 400)', async () => {
  const captured = {};
  app = await mountStaging({
    requireProAccount: proUser,
    genAI: {},
    // Fake is present but should never be reached — sharp throws on the bogus image first.
    generateWithQualityRetry: fakeRetry(captured),
  });
  const res = await postJson(app.baseUrl, '/api/mask-edit', {
    image: 'data:image/png;base64,@@@', // truthy string, but not real PNG bytes
    mask: MASK,
    prompt: 'add a lamp',
  });
  assert.equal(res.status, 500);
  assert.equal(captured.label, undefined, 'model seam is never reached when decoding fails');
});

// ── enterprise metering ───────────────────────────────────────────────────────

test('mask-edit: reports enterprise usage when the user maps to an enterprise domain', async () => {
  const captured = {};
  const usageCalls = [];
  app = await mountStaging({
    requireProAccount: proUser,
    genAI: {},
    enterpriseDomainForUser: () => 'acme.com',
    reportEnterpriseUsage: (domain, count) => usageCalls.push({ domain, count }),
    // Fake calls onImageProduced once → maskGenerations becomes 1.
    generateWithQualityRetry: fakeRetry(captured, { produce: 1 }),
  });
  const res = await postJson(app.baseUrl, '/api/mask-edit', {
    image: IMAGE,
    mask: MASK,
    prompt: 'add a bookshelf',
  });
  assert.equal(res.status, 200);
  assert.equal(usageCalls.length, 1, 'reportEnterpriseUsage should be called exactly once');
  assert.equal(usageCalls[0].domain, 'acme.com');
  assert.equal(usageCalls[0].count, 1);
});

test('mask-edit: enterprise usage falls back to count 1 when the seam produces zero images (maskGenerations || 1)', async () => {
  // If generateWithQualityRetry never pumps onImageProduced, the handler's maskGenerations
  // counter stays 0, but it reports `maskGenerations || 1` (routes/staging.js ~479) — so an
  // enterprise click is still metered as exactly 1, never 0.
  const captured = {};
  const usageCalls = [];
  app = await mountStaging({
    requireProAccount: proUser,
    genAI: {},
    enterpriseDomainForUser: () => 'acme.com',
    reportEnterpriseUsage: (domain, count) => usageCalls.push({ domain, count }),
    generateWithQualityRetry: fakeRetry(captured, { produce: 0 }), // onImageProduced never fires
  });
  const res = await postJson(app.baseUrl, '/api/mask-edit', {
    image: IMAGE,
    mask: MASK,
    prompt: 'add a bookshelf',
  });
  assert.equal(res.status, 200);
  assert.equal(usageCalls.length, 1, 'enterprise domain still gets metered even with zero produced images');
  assert.equal(usageCalls[0].domain, 'acme.com');
  assert.equal(usageCalls[0].count, 1, 'the maskGenerations || 1 fallback reports 1, not 0');
});

test('mask-edit: a non-enterprise user (null domain) is never reported to reportEnterpriseUsage', async () => {
  // The default enterpriseDomainForUser returns null, so the `if (entDomain)` guard
  // (routes/staging.js ~478) is falsy and metering is skipped entirely — the spy stays untouched
  // even though the edit itself succeeds and produces an image.
  const captured = {};
  const usageCalls = [];
  app = await mountStaging({
    requireProAccount: proUser,
    genAI: {},
    // enterpriseDomainForUser left at its baseDeps default () => null
    reportEnterpriseUsage: (domain, count) => usageCalls.push({ domain, count }),
    generateWithQualityRetry: fakeRetry(captured, { produce: 1 }),
  });
  const res = await postJson(app.baseUrl, '/api/mask-edit', {
    image: IMAGE,
    mask: MASK,
    prompt: 'add a bookshelf',
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).success, true);
  assert.equal(usageCalls.length, 0, 'reportEnterpriseUsage must not be called for non-enterprise users');
});
