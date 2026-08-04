// Tier: core pipeline — the Exterior Studio multipart handler
// (lib/staging/exterior-handler.js).
//
// Every dependency is injected, so the handler runs with a fake processStaging and a fake
// auth store — no model calls, no Express, no multer.
//
// The three things here that fail silently and cost real money:
//   • METERING. This route is Pro-only, so it has no free-tier branch to catch a mistake:
//     if the meter is skipped, an enterprise domain stages exteriors for free and nothing
//     anywhere says so. That is the exact hole the listing worker had.
//   • THE UPLOAD GATE running BEFORE generation. Reversed, a rejected upload has already
//     paid for a Gemini render.
//   • THE PROMPT SEAM. If promptOverride ever stopped being honoured, processStaging would
//     silently fall back to generatePrompt('Exterior', …) — which has no promptMatrix
//     entry, so it would stage FURNITURE onto a driveway from the generic fallback prompt
//     and still return a plausible-looking image.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExteriorHandler } from '../../lib/staging/exterior-handler.js';
import {
  EXTERIOR_REVIEW_PROMPT, EXTERIOR_PRESERVATION_RULES, CLEANUP_CLAUSES, CLEANUP_LABELS,
} from '../../lib/staging/exterior-prompts.js';

/** Minimal Express-ish response recorder. */
function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

/** A multipart request carrying one image and the given body fields. */
function fakeReq(body = {}, originalname = '123-main-front.jpg') {
  return { body, files: { image: [{ buffer: Buffer.from('exterior-bytes'), originalname }] } };
}

const PRO = { id: 'u_pro', email: 'pro@x.com', plan: 'pro' };

function makeHandler(overrides = {}) {
  const seen = { staging: [], metered: [], activity: [], validated: [], gallery: [] };
  const deps = {
    genAI: { getGenerativeModel: () => ({}) },
    DEBUG_MODE: false,
    authStore: { findUserByEmail: () => null },
    toPublicAuthUser: (u) => (u ? { email: u.email, plan: u.plan } : null),
    enterpriseDomainForUser: () => null,
    reportEnterpriseUsage: (domain, qty) => seen.metered.push({ domain, qty }),
    recordStagingActivity: (u) => { seen.activity.push(u.id); return true; },
    validateExteriorImage: async (buf) => { seen.validated.push(buf); return { valid: true, code: null, reason: '' }; },
    processStaging: async (buf, params, req, refs, model) => {
      seen.staging.push({ buf, params, model });
      if (req) req._stagingGenerations = (req._stagingGenerations || 0) + 1;
      return 'data:image/webp;base64,ENHANCED';
    },
    renderPersistence: null,
    ...overrides,
  };
  const { handleExteriorMultipart } = createExteriorHandler(deps);
  return { handleExteriorMultipart, seen, deps };
}

/** A render-persistence double that records what it was handed. */
function fakePersistence(seen, { enabled = true } = {}) {
  return {
    enabled: () => enabled,
    recordPending: (arg) => {
      seen.gallery.push(arg);
      return { entries: [{ id: 'r1', native: arg.natives[0].buffer }], evicted: [] };
    },
    uploadInBackground: async () => ({ ok: 1, failed: 0 }),
  };
}

// ---- Request shaping -------------------------------------------------------

test('a request with no image is rejected before anything else', async () => {
  const { handleExteriorMultipart, seen } = makeHandler();
  const res = fakeRes();
  await handleExteriorMultipart({ body: {}, files: {} }, res, PRO);
  assert.equal(res.statusCode, 400);
  assert.equal(seen.validated.length, 0, 'no paid vision call for a request with no file');
  assert.equal(seen.staging.length, 0);
});

test('an unconfigured AI client is a 500, not a crash', async () => {
  const { handleExteriorMultipart } = makeHandler({ genAI: null });
  const res = fakeRes();
  await handleExteriorMultipart(fakeReq(), res, PRO);
  assert.equal(res.statusCode, 500);
});

test('multipart checkbox values are read as booleans', async () => {
  // Multer hands every field over as a string; a checkbox posts 'on'. Reading these with
  // a bare truthiness check would make the string 'false' enable the toggle.
  const { handleExteriorMultipart, seen } = makeHandler();
  await handleExteriorMultipart(
    fakeReq({ removeVehicles: 'on', removeClutter: 'false' }),
    fakeRes(),
    PRO,
  );
  const prompt = seen.staging[0].params.promptOverride;
  assert.match(prompt, /Remove every parked car/, "'on' enables the toggle");
  assert.ok(!/wheelie bins/.test(prompt), "the string 'false' does NOT enable the toggle");
});

test('EVERY removal flag survives the trip through multipart, not just the first two', async () => {
  // The handler destructures these one by one, which is the one place a new removal can be
  // dropped after it has already passed every other guard: the clause exists, the checkbox
  // exists, all eleven packs have the label, the browser posts the field — and the handler
  // never reads it, so the tickbox does nothing and the only symptom is a photo that still
  // has snow on it. Swept off the clause table so a sixth flag is covered on arrival.
  const { handleExteriorMultipart, seen } = makeHandler();
  const body = Object.fromEntries(Object.keys(CLEANUP_CLAUSES).map((key) => [key, 'true']));
  await handleExteriorMultipart(fakeReq(body), fakeRes(), PRO);

  const { promptOverride, additionalPrompt } = seen.staging[0].params;
  for (const [key, clause] of Object.entries(CLEANUP_CLAUSES)) {
    assert.ok(promptOverride.includes(clause), `${key} was posted but never reached the prompt`);
    // And the QA summary, which is also the CSV row — the surface that silently disagreed
    // with the prompt before CLEANUP_LABELS became a table.
    assert.ok(
      additionalPrompt.includes(CLEANUP_LABELS[key].phrase),
      `${key} reached the prompt but is missing from the logged summary`,
    );
  }
});

test('a removal flag left OUT of the body entirely is off, not undefined-truthy', async () => {
  // Multer omits a field the browser did not send. `truthy(undefined)` has to be false, and
  // an older client that predates a new checkbox is exactly how that gets exercised.
  const { handleExteriorMultipart, seen } = makeHandler();
  await handleExteriorMultipart(fakeReq({ removeVehicles: 'true' }), fakeRes(), PRO);
  const prompt = seen.staging[0].params.promptOverride;
  for (const key of Object.keys(CLEANUP_CLAUSES)) {
    if (key === 'removeVehicles') continue;
    assert.ok(!prompt.includes(CLEANUP_CLAUSES[key]), `${key} was absent from the body but emitted anyway`);
  }
});

test('free text is clamped to 500 characters', async () => {
  const { handleExteriorMultipart, seen } = makeHandler();
  await handleExteriorMultipart(fakeReq({ additionalPrompt: 'x'.repeat(900) }), fakeRes(), PRO);
  const prompt = seen.staging[0].params.promptOverride;
  assert.ok(prompt.includes('x'.repeat(500)), 'the first 500 characters survive');
  assert.ok(!prompt.includes('x'.repeat(501)), 'and the 501st does not');
});

// ---- The upload gate -------------------------------------------------------

test('the upload gate runs BEFORE any generation, and its rejection is a 422 with the code', async () => {
  const { handleExteriorMultipart, seen } = makeHandler({
    validateExteriorImage: async () => ({ valid: false, code: 'ANIMAL', reason: 'This looks like a photo of a pet.' }),
  });
  const res = fakeRes();
  await handleExteriorMultipart(fakeReq(), res, PRO);
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.code, 'ANIMAL', 'the stable code the browser localizes');
  assert.match(res.body.error, /pet/);
  assert.equal(seen.staging.length, 0, 'a rejected upload must never reach the generator');
  assert.equal(seen.metered.length + seen.activity.length, 0, 'and must never be metered');
});

test('a rejection with no code still carries the generic one', async () => {
  const { handleExteriorMultipart } = makeHandler({
    validateExteriorImage: async () => ({ valid: false, code: null, reason: 'nope' }),
  });
  const res = fakeRes();
  await handleExteriorMultipart(fakeReq(), res, PRO);
  assert.equal(res.body.code, 'UNSTAGEABLE');
});

// ---- The prompt seam -------------------------------------------------------

test('the handler supplies the WHOLE prompt and the exterior QA rubric', async () => {
  // Without promptOverride, processStaging falls back to generatePrompt(roomType, …) —
  // and 'Exterior' has no promptMatrix entry, so it would stage furniture from the
  // generic fallback. Without reviewBasePrompt the interior rubric grades the facade.
  const { handleExteriorMultipart, seen } = makeHandler();
  await handleExteriorMultipart(fakeReq({ timeOfDay: 'goldenHour' }), fakeRes(), PRO);
  const { params } = seen.staging[0];
  assert.ok(params.promptOverride, 'promptOverride must be set');
  assert.ok(params.promptOverride.includes(EXTERIOR_PRESERVATION_RULES), 'and carry the hard rules');
  assert.equal(params.reviewBasePrompt, EXTERIOR_REVIEW_PROMPT);
  assert.equal(params.removeFurniture, false, 'nothing on this path removes furniture');
});

test('the quality gate is OFF — one generation, no review, no reshoot', async () => {
  // Interior staging invents a room, so scoring three attempts buys something real. This
  // path edits a photograph the user handed over: a second roll returns a different sky,
  // not a better one, while tripling the bill and the wait on a request they are watching.
  const { handleExteriorMultipart, seen } = makeHandler();
  await handleExteriorMultipart(fakeReq(), fakeRes(), PRO);
  assert.equal(seen.staging[0].params.skipQualityReview, true);
});

test('the source photo, not an intermediate, is what gets enhanced', async () => {
  const { handleExteriorMultipart, seen } = makeHandler();
  const req = fakeReq();
  await handleExteriorMultipart(req, fakeRes(), PRO);
  assert.equal(seen.staging[0].buf, req.files.image[0].buffer);
  assert.equal(seen.validated[0], req.files.image[0].buffer, 'and the same buffer was gated');
});

test('the CSV row and the QA instruction get a readable summary, not the raw prompt', async () => {
  const { handleExteriorMultipart, seen } = makeHandler();
  await handleExteriorMultipart(fakeReq({ sky: 'clearBlue', removeVehicles: 'true' }), fakeRes(), PRO);
  const { params } = seen.staging[0];
  assert.equal(params.roomType, 'Exterior', 'the label that makes these rows findable');
  assert.match(params.additionalPrompt, /clear blue sky/);
  assert.match(params.additionalPrompt, /vehicles removed/);
  assert.ok(params.additionalPrompt.length < 200, 'a summary, not the whole prompt');
});

test('req.body.model never reaches the provider unclamped', async () => {
  // resolveChatModel is the security clamp — a raw body value must not be able to select
  // a model, least of all an expensive one. Asserted as "it is one of the two models this
  // app ships", not as "it is not the attacker's string", because the latter passes if
  // the clamp is deleted and the body value merely happens to be unrecognised.
  const { handleExteriorMultipart, seen } = makeHandler();
  await handleExteriorMultipart(fakeReq({ model: 'gemini-3-pro-image-ultra-expensive' }), fakeRes(), PRO);
  assert.ok(
    ['gemini-2.5-flash-image', 'gemini-3.1-flash-image'].includes(seen.staging[0].model),
    `an unrecognised body model must clamp to a shipped image model, got ${seen.staging[0].model}`,
  );
});

test('a request naming no model gets the PLUS image model, not the fast default', async () => {
  // resolveChatModel falls back to FAST_MODEL when a request names nothing. That is right
  // for /api/process-image, which free accounts share and whose client picks explicitly —
  // but this route is Pro-only and has no model picker, so inheriting that default would
  // silently render every paying customer's photo on the cheap model, with nothing
  // erroring and no way to tell from the output which one ran.
  const { handleExteriorMultipart, seen } = makeHandler();
  await handleExteriorMultipart(fakeReq(), fakeRes(), PRO);
  assert.equal(seen.staging[0].model, 'gemini-3.1-flash-image');
});

test('a request that explicitly asks for the fast model still gets it', async () => {
  // The default is an opinion, not a lock — leaving room for a "faster / cheaper" toggle
  // without another round trip through the clamp.
  const { handleExteriorMultipart, seen } = makeHandler();
  await handleExteriorMultipart(fakeReq({ model: 'gpt-4o-mini' }), fakeRes(), PRO);
  assert.equal(seen.staging[0].model, 'gemini-2.5-flash-image');
});

// ---- Metering --------------------------------------------------------------

test('a paid render records staging activity exactly once', async () => {
  const { handleExteriorMultipart, seen } = makeHandler();
  await handleExteriorMultipart(fakeReq(), fakeRes(), PRO);
  assert.deepEqual(seen.activity, [PRO.id]);
  assert.equal(seen.metered.length, 0, 'no enterprise domain, so no meter event');
});

test('an enterprise domain is metered per generation ATTEMPT, not per render', async () => {
  // A quality-gate retry is a real generation that really cost money. Billing 1 for a
  // 3-attempt render is the same revenue hole the listing worker had, one tier down.
  const { handleExteriorMultipart, seen } = makeHandler({
    enterpriseDomainForUser: () => 'acme.com',
    processStaging: async (_b, _p, req) => { req._stagingGenerations = 3; return 'img'; },
  });
  await handleExteriorMultipart(fakeReq(), fakeRes(), PRO);
  assert.deepEqual(seen.metered, [{ domain: 'acme.com', qty: 3 }]);
  assert.deepEqual(seen.activity, [], 'a domain-billed account does not also signal trial activity');
});

test('metering falls back to 1 rather than 0 when the attempt counter is missing', async () => {
  const { handleExteriorMultipart, seen } = makeHandler({
    enterpriseDomainForUser: () => 'acme.com',
    processStaging: async () => 'img',
  });
  await handleExteriorMultipart(fakeReq(), fakeRes(), PRO);
  assert.deepEqual(seen.metered, [{ domain: 'acme.com', qty: 1 }], 'under-report, never bill nothing');
});

test('a failed render is not metered — the throw propagates to the router', async () => {
  const { handleExteriorMultipart, seen } = makeHandler({
    processStaging: async () => { throw Object.assign(new Error('no image'), { code: 'NO_IMAGE_GENERATED' }); },
  });
  await assert.rejects(() => handleExteriorMultipart(fakeReq(), fakeRes(), PRO), /no image/);
  assert.equal(seen.metered.length + seen.activity.length, 0);
});

// ---- The gallery -----------------------------------------------------------

test('with the gallery off, nothing is decoded and no onNative hook is wired', async () => {
  const { handleExteriorMultipart, seen } = makeHandler();
  const res = fakeRes();
  await handleExteriorMultipart(fakeReq(), res, PRO);
  assert.equal(seen.staging[0].params.onNative, null, 'no hook when there is nowhere to put the bytes');
  assert.equal(res.body.gallery, undefined);
  assert.equal(res.body.success, true, 'and the render is completely unaffected');
});

test('with the gallery on, the NATIVE bytes are recorded and labelled Exterior', async () => {
  const seen = { gallery: [] };
  const persistence = fakePersistence(seen);
  const h = makeHandler({
    renderPersistence: persistence,
    processStaging: async (_b, params) => {
      params.onNative(Buffer.from('native-bytes'), { format: 'png' });
      return 'data:image/webp;base64,DELIVERED';
    },
  });
  const res = fakeRes();
  await h.handleExteriorMultipart(fakeReq({ sky: 'dramatic' }), res, PRO);
  assert.equal(seen.gallery.length, 1);
  assert.equal(seen.gallery[0].params.roomType, 'Exterior');
  assert.equal(seen.gallery[0].isPro, true, 'this route is Pro-only by construction');
  assert.equal(seen.gallery[0].natives[0].buffer.toString(), 'native-bytes');
  assert.deepEqual(res.body.gallery.ids, ['r1']);
  assert.equal(res.body.image, 'data:image/webp;base64,DELIVERED', 'the client still gets the delivery image');
});

test('the row carries what the gallery needs to NAME it', async () => {
  // Before this, every exterior render in the gallery derived the same single word —
  // "Exterior" — because the row has a fixed room label and no furniture style at all.
  const seen = { gallery: [] };
  const h = makeHandler({
    renderPersistence: fakePersistence(seen),
    processStaging: async (_b, params) => { params.onNative(Buffer.from('n'), {}); return 'img'; },
  });
  await h.handleExteriorMultipart(
    fakeReq({ timeOfDay: 'goldenHour', sky: 'clearBlue' }, '412-rosewood-front.jpg'),
    fakeRes(),
    PRO,
  );
  assert.deepEqual(seen.gallery[0].extra, {
    source: 'exterior',
    qualifier: 'Golden hour, clear sky',
    sourceName: '412-rosewood-front.jpg',
  }, 'the handler passes raw values; render-persistence is the one door that sanitizes them');
});

test('a do-nothing exterior request still names itself, just without a qualifier', async () => {
  const seen = { gallery: [] };
  const h = makeHandler({
    renderPersistence: fakePersistence(seen),
    processStaging: async (_b, params) => { params.onNative(Buffer.from('n'), {}); return 'img'; },
  });
  await h.handleExteriorMultipart(fakeReq(), fakeRes(), PRO);
  assert.equal(seen.gallery[0].extra.source, 'exterior');
  assert.equal(seen.gallery[0].extra.qualifier, '', 'which leaves the name "Exterior", as it always was');
});

test('a gallery failure can never fail the paid render', async () => {
  // The client already has its image; losing a history entry is not worth a 500.
  const h = makeHandler({
    renderPersistence: {
      enabled: () => true,
      recordPending: () => { throw new Error('sqlite is on fire'); },
      uploadInBackground: async () => ({ ok: 0, failed: 1 }),
    },
    processStaging: async (_b, params) => { params.onNative(Buffer.from('n'), {}); return 'img'; },
  });
  const res = fakeRes();
  await h.handleExteriorMultipart(fakeReq(), res, PRO);
  assert.equal(res.body.success, true);
  assert.equal(res.body.gallery, undefined);
});

// ---- Response shape --------------------------------------------------------

test('the response carries the refreshed user so the client can update its plan state', async () => {
  const refreshed = { id: 'u_pro', email: 'pro@x.com', plan: 'pro' };
  const { handleExteriorMultipart } = makeHandler({
    authStore: { findUserByEmail: () => refreshed },
  });
  const res = fakeRes();
  await handleExteriorMultipart(fakeReq(), res, PRO);
  assert.deepEqual(res.body.user, { email: 'pro@x.com', plan: 'pro' });
  assert.equal(res.body.success, true);
  assert.equal(res.body.images, undefined, 'one photo, one image — never the array shape');
});
