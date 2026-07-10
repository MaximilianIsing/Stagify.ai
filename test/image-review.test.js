// Gemini-vision QA reviewers (lib/image/image-review.js): reviewImageQuality,
// reviewMaskEdit, validateStageableImage. Every one of them fails OPEN — a null client,
// a thrown API error, or a score-less reply must never block a user's image — and the
// numeric SCORE is clamped to 0-100. We pin those contracts with a fake Gemini client
// (scripted content, no real call, no cost) and real sharp buffers/data-urls for the
// downscale step.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createImageReview } from '../lib/image/image-review.js';
import { DEFAULT_UNSTAGEABLE_REASON } from '../lib/staging/prompts.js';

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const roomBuffer = () =>
  sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 200, g: 190, b: 170 } } }).png().toBuffer();

// Fake Gemini client: getGenerativeModel().generateContent() returns a scripted
// `response.text()` (or throws, to drive the fail-OPEN error paths). Matches how
// lib/image/image-review.js calls the @google/generative-ai SDK.
function fakeGrader(content) {
  return {
    getGenerativeModel() {
      return {
        generateContent: async () => {
          if (content instanceof Error) throw content;
          return { response: { text: () => content } };
        },
      };
    },
  };
}

// --- reviewImageQuality -----------------------------------------------------
test('reviewImageQuality: disabled reviewer (no client) passes the image with score 100', async () => {
  const { reviewImageQuality } = createImageReview({ genAI: null });
  assert.deepEqual(await reviewImageQuality(TINY_PNG), { perfect: true, score: 100, reason: 'reviewer disabled' });
});

test('reviewImageQuality: "PERFECT: true" → perfect with score 100', async () => {
  const { reviewImageQuality } = createImageReview({ genAI: fakeGrader('PERFECT: true') });
  const r = await reviewImageQuality(TINY_PNG);
  assert.equal(r.perfect, true);
  assert.equal(r.score, 100);
});

test('reviewImageQuality: not perfect keeps the parsed SCORE and clamps out-of-range values', async () => {
  const mid = await createImageReview({ genAI: fakeGrader('PERFECT: false\nSCORE: 42') }).reviewImageQuality(TINY_PNG);
  assert.equal(mid.perfect, false);
  assert.equal(mid.score, 42);

  const over = await createImageReview({ genAI: fakeGrader('SCORE: 150 — too generous') }).reviewImageQuality(TINY_PNG);
  assert.equal(over.perfect, false);
  assert.equal(over.score, 100, 'a score above 100 is clamped');
});

test('reviewImageQuality: a not-perfect verdict with no SCORE ranks as 0', async () => {
  const r = await createImageReview({ genAI: fakeGrader('The lighting looks off but no number') }).reviewImageQuality(TINY_PNG);
  assert.equal(r.perfect, false);
  assert.equal(r.score, 0);
});

test('reviewImageQuality: a thrown API error fails open (accept the image)', async () => {
  const r = await createImageReview({ genAI: fakeGrader(new Error('boom')) }).reviewImageQuality(TINY_PNG);
  assert.deepEqual(r, { perfect: true, score: 100, reason: 'reviewer error' });
});

test('reviewImageQuality: extra furniture reference URLs that fail to downscale are skipped, not fatal', async () => {
  // 'not-a-data-url' passes through downscale unchanged; a broken data-url is caught per-ref.
  const r = await createImageReview({ genAI: fakeGrader('PERFECT: true') })
    .reviewImageQuality(TINY_PNG, { furnitureDataUrls: ['data:image/png;base64,@@@bad', 'not-a-data-url'] });
  assert.equal(r.perfect, true, 'a bad furniture reference does not sink the review');
});

// --- reviewMaskEdit ---------------------------------------------------------
test('reviewMaskEdit: disabled reviewer passes; parses score; fails open on error', async () => {
  assert.deepEqual(
    await createImageReview({ genAI: null }).reviewMaskEdit(TINY_PNG, TINY_PNG),
    { perfect: true, score: 100, reason: 'reviewer disabled' },
  );

  const good = await createImageReview({ genAI: fakeGrader('PERFECT: true') }).reviewMaskEdit(TINY_PNG, TINY_PNG);
  assert.equal(good.perfect, true);

  const scored = await createImageReview({ genAI: fakeGrader('PERFECT: false\nSCORE: 73') })
    .reviewMaskEdit(TINY_PNG, TINY_PNG, { instruction: 'remove the clutter' });
  assert.equal(scored.perfect, false);
  assert.equal(scored.score, 73);

  const failed = await createImageReview({ genAI: fakeGrader(new Error('nope')) }).reviewMaskEdit(TINY_PNG, TINY_PNG);
  assert.deepEqual(failed, { perfect: true, score: 100, reason: 'reviewer error' });
});

// --- validateStageableImage (takes a Buffer, not a data URL) ----------------
test('validateStageableImage: no client → valid', async () => {
  const { validateStageableImage } = createImageReview({ genAI: null });
  assert.deepEqual(await validateStageableImage(await roomBuffer()), { valid: true, reason: '' });
});

test('validateStageableImage: "VALID: true" → valid with empty reason', async () => {
  const { validateStageableImage } = createImageReview({ genAI: fakeGrader('VALID: true') });
  assert.deepEqual(await validateStageableImage(await roomBuffer()), { valid: true, reason: '' });
});

test('validateStageableImage: "VALID: false | REASON: ..." surfaces the reason (quotes stripped)', async () => {
  const { validateStageableImage } = createImageReview({ genAI: fakeGrader('VALID: false\nREASON: "This is a person, not a room"') });
  const r = await validateStageableImage(await roomBuffer());
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'This is a person, not a room');
});

test('validateStageableImage: rejected with no REASON falls back to the default message', async () => {
  const { validateStageableImage } = createImageReview({ genAI: fakeGrader('VALID: false') });
  const r = await validateStageableImage(await roomBuffer());
  assert.equal(r.valid, false);
  assert.equal(r.reason, DEFAULT_UNSTAGEABLE_REASON);
});

test('validateStageableImage: a thrown error fails open (allow the upload)', async () => {
  const { validateStageableImage } = createImageReview({ genAI: fakeGrader(new Error('vision down')) });
  assert.deepEqual(await validateStageableImage(await roomBuffer()), { valid: true, reason: '' });
});
