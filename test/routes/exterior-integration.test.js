// Tier: route integration (fake AI) — POST /api/enhance-exterior, end to end.
//
// WHY THIS EXISTS, GIVEN TWO SUITES ALREADY COVER THIS ROUTE
// They cover it in halves that never meet. exterior-route.test.js mounts the real router
// but STUBS the handler; exterior-handler.test.js drives the real handler but hands it a
// hand-built `req` and a fake processStaging. Between them sits everything that only
// exists when the two are wired together:
//
//   • REAL MULTER. Every field arrives as a STRING — `removeVehicles` is `'true'`, not
//     `true` — and `req.files.image[0].buffer` is a genuine Buffer. A handler that read
//     these as booleans passes both existing suites and fails in production. This is the
//     same reason chat-upload-route.test.js mounts real multer rather than faking req.
//   • THE GEMINI CALL SHAPE. processStaging is real here, so the prompt the model would
//     actually receive is observable — including that the opt-in options survive the trip
//     from a multipart field to a prompt clause.
//   • THE QUALITY GATE BEING OFF, measured where it matters: the number of times a fake
//     Gemini is actually asked for an image.
//
// Only the AI clients are faked. No network, no model, no cost.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import sharp from 'sharp';
import createStagingRouter from '../../routes/staging.js';
import { baseDeps } from '../helpers/staging-app.js';
import { createStagingGeneration } from '../../lib/staging/staging-generation.js';
import { createExteriorHandler } from '../../lib/staging/exterior-handler.js';
import { generateWithQualityRetry } from '../../lib/staging/staging-pipeline.js';
import { stagingProcessUpload } from '../../lib/http/uploads.js';
import { CLEANUP_CLAUSES } from '../../lib/staging/exterior-prompts.js';

const PRO = { id: 'u_pro', email: 'pro@x.com', plan: 'pro' };

const housePng = () => sharp({
  create: { width: 640, height: 420, channels: 3, background: { r: 150, g: 165, b: 180 } },
}).png().toBuffer();

/**
 * Mount the real router + real handler + real generation pipeline over a fake Gemini.
 * @param {{ validate?: any, generations?: { count: number } }} [opts]
 */
async function mount({ validate = { valid: true, code: null, reason: '' } } = {}) {
  const seen = {
    prompts: /** @type {string[]} */ ([]),
    reviews: 0,
    generations: 0,
    metered: /** @type {any[]} */ ([]),
    activity: /** @type {string[]} */ ([]),
    logRows: /** @type {any[]} */ ([]),
  };

  // A Gemini stand-in that records the prompt it was given and returns a 1×1 PNG.
  const tinyPng = (await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer()).toString('base64');
  const genAI = {
    getGenerativeModel: () => ({
      generateContent: async (parts) => {
        seen.generations += 1;
        seen.prompts.push(parts[0].text);
        return { response: { candidates: [{ content: { parts: [{ inlineData: { data: tinyPng } }] } }] } };
      },
    }),
  };

  const { processStaging } = createStagingGeneration({
    genAI,
    DEBUG_MODE: false,
    runQualityRetry: generateWithQualityRetry,
    reviewImageQuality: async () => { seen.reviews += 1; return { perfect: true, score: 100 }; },
    QUALITY_MAX_ATTEMPTS: 3,
    logPromptToFile: (...args) => seen.logRows.push(args),
  });

  const { handleExteriorMultipart } = createExteriorHandler({
    genAI,
    authStore: { findUserByEmail: () => null },
    toPublicAuthUser: (u) => (u ? { email: u.email, plan: u.plan } : null),
    enterpriseDomainForUser: () => null,
    reportEnterpriseUsage: (domain, qty) => seen.metered.push({ domain, qty }),
    recordStagingActivity: (u) => { seen.activity.push(u.id); return true; },
    validateExteriorImage: async () => validate,
    processStaging,
    renderPersistence: null,
  });

  const app = express();
  app.use(createStagingRouter({
    ...baseDeps(),
    genAI,
    // The REAL multer middleware, exactly as server.js mounts it.
    stagingProcessUpload,
    requireProAccount: () => PRO,
    handleExteriorMultipart,
  }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    seen,
    url: `http://127.0.0.1:${port}/api/enhance-exterior`,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** POST a genuine multipart body, the way the browser does. */
async function post(url, fields = {}) {
  const form = new FormData();
  form.append('image', new File([await housePng()], 'house.png', { type: 'image/png' }));
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  const res = await fetch(url, { method: 'POST', body: form });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('a real multipart request produces one image, through the whole pipeline', async () => {
  const app = await mount();
  try {
    const { status, json } = await post(app.url, {
      timeOfDay: 'goldenHour', sky: 'clearBlue', removeVehicles: 'true', removeClutter: 'false',
    });
    assert.equal(status, 200);
    assert.equal(json.success, true);
    assert.match(json.image, /^data:image\/webp;base64,/, 'delivered as an upscaled WebP');
    assert.equal(json.images, undefined, 'one photo, one image');
  } finally { await app.close(); }
});

test('the quality gate really is off: one generation, zero reviews', async () => {
  // Measured where it actually costs money — how many times the model was asked. The
  // handler-level test can only see the flag being passed; this sees the consequence.
  const app = await mount();
  try {
    await post(app.url, { removeClutter: 'true' });
    assert.equal(app.seen.generations, 1);
    assert.equal(app.seen.reviews, 0, 'no vision pass was paid for');
  } finally { await app.close(); }
});

test('multipart strings become the right prompt clauses', async () => {
  // The trip a value takes: browser FormData → multer string → truthy() → clause table →
  // prompt. Every step is real here, which is the only place the string 'false' meeting a
  // truthiness check would show up.
  const app = await mount();
  try {
    await post(app.url, {
      timeOfDay: 'dusk', sky: 'keep', removeVehicles: 'false', removeClutter: 'on',
    });
    const prompt = app.seen.prompts[0];
    assert.match(prompt, /DUSK \/ twilight/, 'the ticked preset is in');
    assert.ok(!/Replace the sky/.test(prompt), "sky: 'keep' contributes nothing");
    assert.ok(!/Remove every parked car/.test(prompt), "the string 'false' does NOT enable a toggle");
    assert.match(prompt, /wheelie bins/, "the string 'on' does");
    // And the hard rules ride along on every request.
    assert.match(prompt, /PRESERVE THE PROPERTY EXACTLY/);
  } finally { await app.close(); }
});

test('EVERY removal row survives real multer, end to end', async () => {
  // The whole chain with nothing stubbed between the wire and the prompt: browser
  // FormData → multer → the handler's destructure → truthy() → clause table → the string
  // the model would actually be sent. Swept off CLEANUP_CLAUSES so a sixth removal is
  // exercised here on the day it is added — the route test stubs the handler and the
  // handler test stubs processStaging, so this is the only place all of it is real.
  const app = await mount();
  try {
    await post(app.url, Object.fromEntries(Object.keys(CLEANUP_CLAUSES).map((k) => [k, 'true'])));
    const prompt = app.seen.prompts[0];
    for (const [key, clause] of Object.entries(CLEANUP_CLAUSES)) {
      assert.ok(prompt.includes(clause), `${key} was posted as 'true' but its clause never reached the model`);
    }
    // The permission every removal depends on, in the block that outranks them.
    assert.match(prompt, /rebuild only what that thing was hiding/);
  } finally { await app.close(); }
});

test('clearing snow does not quietly become a summer photograph', async () => {
  // Snow is the removal that uncovers the whole plot rather than one patch of driveway, so
  // it is the one that can turn an enhancement into a misrepresentation. Asserted on the
  // real assembled prompt because the constraint has to survive assembly: the preservation
  // block is emitted last precisely so it wins every argument, which is what makes the
  // reconstruction carve-out inside it mean anything.
  const app = await mount();
  try {
    await post(app.url, { removeSnow: 'true' });
    const prompt = app.seen.prompts[0];
    assert.match(prompt, /KEEP THE SEASON/);
    assert.ok(
      prompt.indexOf('never permission to improve it') > prompt.indexOf('KEEP THE SEASON'),
      'the bound on reconstruction has to come after the instruction that triggers it',
    );
    for (const unwanted of ['GOLDEN HOUR', 'Replace the sky', 'correction pass']) {
      assert.ok(!prompt.includes(unwanted), `"${unwanted}" leaked into a snow-only request`);
    }
  } finally { await app.close(); }
});

test('a request asking only for clutter removal changes ONLY that', async () => {
  // The case the whole opt-in redesign exists for, verified against the real prompt rather
  // than against the request body.
  const app = await mount();
  try {
    await post(app.url, { timeOfDay: 'keep', sky: 'keep', removeVehicles: 'false', removeClutter: 'true' });
    const prompt = app.seen.prompts[0];
    assert.match(prompt, /wheelie bins/);
    for (const unwanted of ['GOLDEN HOUR', 'Replace the sky', 'Remove every parked car', 'correction pass']) {
      assert.ok(!prompt.includes(unwanted), `"${unwanted}" leaked into a clutter-only request`);
    }
  } finally { await app.close(); }
});

test('free text alone reaches the model as the whole request', async () => {
  const app = await mount();
  try {
    await post(app.url, { additionalPrompt: 'remove the bin bags by the gate' });
    const prompt = app.seen.prompts[0];
    assert.match(prompt, /remove the bin bags by the gate/);
    assert.ok(!/correction pass/i.test(prompt), 'no generic pass bolted on beside it');
  } finally { await app.close(); }
});

test('an unstageable upload is refused before the model is called at all', async () => {
  const app = await mount({ validate: { valid: false, code: 'ANIMAL', reason: 'This looks like a photo of a pet.' } });
  try {
    const { status, json } = await post(app.url, { removeClutter: 'true' });
    assert.equal(status, 422);
    assert.equal(json.code, 'ANIMAL');
    assert.equal(app.seen.generations, 0, 'nothing was generated');
    assert.equal(app.seen.activity.length, 0, 'and nothing was metered');
  } finally { await app.close(); }
});

test('a request with no file is a 400, even through real multer', async () => {
  const app = await mount();
  try {
    const form = new FormData();
    form.append('removeClutter', 'true');
    const res = await fetch(app.url, { method: 'POST', body: form });
    assert.equal(res.status, 400);
  } finally { await app.close(); }
});

test('the CSV row records the render as an Exterior, with its own prompt', async () => {
  // prompt_logs.csv is how exterior renders stay findable among eight real room types.
  const app = await mount();
  try {
    await post(app.url, { sky: 'dramatic' });
    assert.equal(app.seen.logRows.length, 1, 'exactly one row per render');
    const [promptText, roomType, , , , , , , , outcome] = app.seen.logRows[0];
    assert.equal(roomType, 'Exterior');
    assert.match(promptText, /real-estate photo editor/, 'the prompt the model really saw');
    assert.equal(outcome.status, 'ok');
    assert.equal(outcome.attempts, 1, 'one generation, not three');
  } finally { await app.close(); }
});

test('a paying account is metered exactly once for the whole request', async () => {
  const app = await mount();
  try {
    await post(app.url, { removeVehicles: 'true' });
    assert.deepEqual(app.seen.activity, [PRO.id]);
    assert.deepEqual(app.seen.metered, []);
  } finally { await app.close(); }
});
