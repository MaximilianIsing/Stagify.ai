// Wiring tests for lib/staging/staging-generation.js. The retry loop and the Gemini
// client are faked (no real model calls), so these assert the pipeline PLUMBING that
// unit tests of the pure helpers can't: that both generators run their finished image
// through the delivery upscale (upscaleForDelivery) — i.e. the served result is the
// enlarged WebP, not the model's raw ~1 MP PNG.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createStagingGeneration } from '../../lib/staging/staging-generation.js';

const png = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 40, g: 90, b: 160 } } }).png().toBuffer();
const jpg = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 40, g: 90, b: 160 } } }).jpeg().toBuffer();
const meta = (buf) => sharp(buf).metadata();
const decode = (dataUrl) => Buffer.from(dataUrl.split(',')[1], 'base64');

// A fake Gemini client whose generateContent() always returns the given PNG bytes as an
// inlineData part — the shape processStaging / processImageGeneration read.
function fakeGenAI(pngBuffer) {
  return {
    getGenerativeModel: () => ({
      generateContent: async () => ({
        response: { candidates: [{ content: { parts: [{ inlineData: { data: pngBuffer.toString('base64') } }] } }] },
      }),
    }),
  };
}

// A stand-in for the quality-retry loop: run the generator once and return its output
// (we're testing the post-generation delivery step, not the review/retry logic).
const passthroughRetry = async (generateOnce, opts) => {
  const url = await generateOnce(1, null);
  if (opts && typeof opts.onImageProduced === 'function') opts.onImageProduced(1);
  return url;
};

function makeGeneration(modelPng, overrides = {}) {
  const rows = [];
  const api = createStagingGeneration({
    genAI: fakeGenAI(modelPng),
    DEBUG_MODE: false,
    runQualityRetry: passthroughRetry,
    reviewImageQuality: async () => ({ isPerfect: true }),
    QUALITY_MAX_ATTEMPTS: 1,
    logPromptToFile: (...args) => { rows.push(args); },
    ...overrides,
  });
  return { ...api, rows };
}

// The args logPromptToFile is called with, as names.
function loggedRow(rows) {
  assert.equal(rows.length, 1, 'exactly one CSV row per render');
  const [promptText, roomType, , , , , , email, , outcome] = rows[0];
  return { promptText, roomType, email, outcome };
}

test('processStaging: delivers the model output upscaled ×2 as WebP', async () => {
  const modelPng = await png(800, 600);            // stand-in for Gemini's ~1 MP output
  const { processStaging } = makeGeneration(modelPng);
  const roomInput = await jpg(800, 600);           // same AR → the aspect-ratio lock is a no-op
  const out = await processStaging(
    roomInput,
    { roomType: 'Living room', furnitureStyle: 'standard', additionalPrompt: '', removeFurniture: false },
    { body: {} },
    null,
    'gemini-2.5-flash-image',
  );
  assert.match(out, /^data:image\/webp;base64,/, 'staged result is delivered as WebP, not the raw PNG');
  const m = await meta(decode(out));
  assert.equal(m.format, 'webp');
  assert.equal(m.width, 1600, 'width doubled for delivery');
  assert.equal(m.height, 1200, 'height doubled for delivery');
});

test('processImageGeneration: delivers the model output upscaled ×2 as WebP', async () => {
  const modelPng = await png(800, 600);
  const { processImageGeneration } = makeGeneration(modelPng);
  const out = await processImageGeneration('a cozy reading nook', { body: {} }, 'gemini-2.5-flash-image');
  assert.match(out, /^data:image\/webp;base64,/, 'generated image is delivered as WebP, not the raw PNG');
  const m = await meta(decode(out));
  assert.equal(m.format, 'webp');
  assert.equal(m.width, 1600);
  assert.equal(m.height, 1200);
});

test('processStaging: pins imageConfig.aspectRatio to the input\'s nearest supported ratio', async () => {
  // The wiring guarantee behind the anti-drift fix: a non-standard-AR room (1.607) must be
  // pinned to the nearest ratio the model supports (3:2), so iterative re-staging lands in a
  // stable bucket instead of accumulating a stretch. Guards against the pin being dropped.
  const modelPng = await png(1248, 832); // stand-in for the model's honored 3:2 bucket
  let capturedOptions = null;
  const genAI = {
    getGenerativeModel: (opts) => {
      capturedOptions = opts;
      return {
        generateContent: async () => ({
          response: { candidates: [{ content: { parts: [{ inlineData: { data: modelPng.toString('base64') } }] } }] },
        }),
      };
    },
  };
  const { processStaging } = createStagingGeneration({
    genAI, DEBUG_MODE: false, runQualityRetry: passthroughRetry,
    reviewImageQuality: async () => ({ isPerfect: true }), QUALITY_MAX_ATTEMPTS: 1, logPromptToFile: () => {},
  });
  const roomInput = await jpg(900, 560); // AR 1.607 → nearest supported ratio is 3:2
  await processStaging(
    roomInput,
    { roomType: 'Bedroom', furnitureStyle: 'standard', additionalPrompt: '', removeFurniture: false },
    { body: {} }, null, 'gemini-2.5-flash-image',
  );
  assert.equal(
    capturedOptions?.generationConfig?.imageConfig?.aspectRatio, '3:2',
    'staging pins the nearest supported aspect ratio on the model',
  );
});


// ── Outcome logging ─────────────────────────────────────────────────────────
//
// The prompt row used to be written BEFORE the model call, so it recorded an
// attempt and carried no result — the admin dashboard could show volume but not
// whether staging actually worked. These lock in the move: exactly one row per
// render, written from whichever path the request leaves by, carrying the outcome.

test('processStaging: logs exactly one row, after success, with the outcome attached', async () => {
  const modelPng = await png(800, 600);
  const gen = makeGeneration(modelPng);
  await gen.processStaging(
    await jpg(800, 600),
    { roomType: 'Living room', furnitureStyle: 'standard', additionalPrompt: '', removeFurniture: false },
    { body: { authenticatedEmail: 'u@x.com' } },
    null,
    'gemini-3-pro-image',
  );

  const { promptText, roomType, email, outcome } = loggedRow(gen.rows);
  assert.equal(roomType, 'Living room');
  assert.equal(email, 'u@x.com');
  assert.ok(promptText.length > 0, 'the prompt the model saw is still captured');
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.model, 'gemini-3-pro-image', 'the RESOLVED model, not the default');
  assert.equal(outcome.errorCode, '');
  assert.equal(outcome.attempts, 1, 'the metered attempt count rides along');
  assert.ok(Number.isFinite(outcome.durationMs) && outcome.durationMs >= 0);
});

test('processStaging: a failed render still logs one row, marked failed with its code', async () => {
  const modelPng = await png(800, 600);
  const boom = Object.assign(new Error('no image'), { code: 'NO_IMAGE_GENERATED' });
  const gen = makeGeneration(modelPng, { runQualityRetry: async () => { throw boom; } });

  const roomInput = await jpg(800, 600);
  await assert.rejects(() => gen.processStaging(
    roomInput,
    { roomType: 'Kitchen', furnitureStyle: 'standard', additionalPrompt: '', removeFurniture: false },
    { body: {} },
    null,
    'gemini-2.5-flash-image',
  ), /no image/, 'the error still propagates to the caller');

  const { roomType, outcome } = loggedRow(gen.rows);
  assert.equal(roomType, 'Kitchen', 'a failure is still attributed to its room type');
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.errorCode, 'NO_IMAGE_GENERATED');
  assert.equal(outcome.attempts, 0, 'no image was produced');
});

test('processStaging: a failure BEFORE the prompt exists is still counted, with an empty prompt', async () => {
  // No Gemini client → throws at the top, long before the prompt is assembled.
  // That class of failure used to log nothing at all, making it invisible to the
  // error rate; it must now produce a row.
  const gen = makeGeneration(await png(8, 8), { genAI: null });
  const roomInput = await jpg(80, 60);
  await assert.rejects(() => gen.processStaging(
    roomInput,
    { roomType: 'Bedroom', furnitureStyle: 'standard', additionalPrompt: '', removeFurniture: false },
    { body: {} },
  ));

  const { promptText, roomType, outcome } = loggedRow(gen.rows);
  assert.equal(promptText, '');
  assert.equal(roomType, 'Bedroom');
  assert.equal(outcome.status, 'failed');
});
