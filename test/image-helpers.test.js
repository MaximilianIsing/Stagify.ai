// Tier: pure unit (fake AI) — the erase / annotation / review factories in isolation.
//
// These test the parse/return contracts of lib/image-review.js, lib/image-annotation.js,
// and lib/erase.js DIRECTLY: no Express, no router, no HTTP, no ports. Each factory is a
// plain function that takes an injected model client, so we hand it a scripted FAKE openai
// (and, for erase, a null genAI it never touches on these paths) and assert exactly what the
// real regexes/return shapes produce.
//
// WHY NO REAL API CALL EVER HAPPENS: each factory reaches its model through one injected
// seam — the QA reviewers (createImageReview) call `genAI.getGenerativeModel().generateContent`;
// the annotator/verifier call `openai.chat.completions.create`. Our fakes replace those with
// an async that returns a scripted reply (or throws, to drive the documented fail-OPEN error
// paths). Nothing here can hit OpenAI or Gemini — there is no real client in scope. That makes
// the suite deterministic, offline, and free.
//
// FIXTURE NOTE: the buffer-input methods (validateStageableImage, roomIsAlreadyEmpty,
// verifyRoomEmptied) decode through the REAL lib/image-primitives.downscaleImage, which THROWS
// on undecodable bytes. A junk buffer would trip each method's own fail-open catch and never
// consult the fake openai, making the assertion vacuous. So we feed them a real (tiny) sharp-
// encoded PNG. The data-URL methods route through downscaleImageForGPT, which fails open, but
// we use a real data URL there too for uniformity.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { createImageReview } from '../lib/image/image-review.js';
import { createImageAnnotation } from '../lib/image/image-annotation.js';
import { createErase } from '../lib/image/erase.js';

// ── Fixtures: a real, decodable 8×8 PNG as both a Buffer and a data URL. ───────
const REAL_BUF = await sharp({
  create: { width: 8, height: 8, channels: 3, background: { r: 120, g: 140, b: 160 } },
}).png().toBuffer();
const REAL_DATA_URL = 'data:image/png;base64,' + REAL_BUF.toString('base64');

// ── Scripted fake OpenAI. ─────────────────────────────────────────────────────
// `reply` is a string → it becomes the model's message content for a single create() call.
// `reply` is an Error → create() throws it, exercising the fail-open error branches.
function fakeOpenAI(reply) {
  return {
    chat: {
      completions: {
        create: async () => {
          if (reply instanceof Error) throw reply;
          return { choices: [{ message: { content: reply } }] };
        },
      },
    },
  };
}

// ── Scripted fake Gemini client (for the QA reviewers, which moved to Gemini). ─
// `reply` is a string → it becomes the model's `response.text()` for one call.
// `reply` is an Error → generateContent() throws it, exercising the fail-open branches.
function fakeGrader(reply) {
  return {
    getGenerativeModel() {
      return {
        generateContent: async () => {
          if (reply instanceof Error) throw reply;
          return { response: { text: () => reply } };
        },
      };
    },
  };
}

// ── A. reviewImageQuality parse matrix ────────────────────────────────────────

test('reviewImageQuality: a PERFECT:true verdict returns perfect with score 100', async () => {
  const { reviewImageQuality } = createImageReview({ genAI: fakeGrader('PERFECT: true') });
  const out = await reviewImageQuality(REAL_DATA_URL);
  assert.equal(out.perfect, true);
  assert.equal(out.score, 100);
});

test('reviewImageQuality: a non-perfect "SCORE: 87" verdict returns perfect=false and score 87', async () => {
  const { reviewImageQuality } = createImageReview({ genAI: fakeGrader('SCORE: 87') });
  const out = await reviewImageQuality(REAL_DATA_URL);
  assert.equal(out.perfect, false);
  assert.equal(out.score, 87);
});

test('reviewImageQuality: an out-of-range "SCORE: 250" is clamped to 100', async () => {
  const { reviewImageQuality } = createImageReview({ genAI: fakeGrader('SCORE: 250') });
  const out = await reviewImageQuality(REAL_DATA_URL);
  assert.equal(out.perfect, false);
  assert.equal(out.score, 100);
});

test('reviewImageQuality: a not-perfect verdict with no SCORE token scores 0', async () => {
  const { reviewImageQuality } = createImageReview({ genAI: fakeGrader('Not great, visible artifacts.') });
  const out = await reviewImageQuality(REAL_DATA_URL);
  assert.equal(out.perfect, false);
  assert.equal(out.score, 0);
});

test('reviewImageQuality: a null openai client is treated as a disabled reviewer (perfect, score 100)', async () => {
  const { reviewImageQuality } = createImageReview({ genAI: null });
  const out = await reviewImageQuality(REAL_DATA_URL);
  assert.deepEqual(out, { perfect: true, score: 100, reason: 'reviewer disabled' });
});

test('reviewImageQuality: a thrown create() fails OPEN (perfect, score 100, reason "reviewer error")', async () => {
  const { reviewImageQuality } = createImageReview({ genAI: fakeGrader(new Error('OpenAI exploded')) });
  const out = await reviewImageQuality(REAL_DATA_URL);
  assert.deepEqual(out, { perfect: true, score: 100, reason: 'reviewer error' });
});

// ── B. reviewMaskEdit shares the same parse contract ──────────────────────────

test('reviewMaskEdit: a PERFECT:true verdict returns perfect with score 100', async () => {
  const { reviewMaskEdit } = createImageReview({ genAI: fakeGrader('PERFECT: true') });
  const out = await reviewMaskEdit(REAL_DATA_URL, REAL_DATA_URL);
  assert.equal(out.perfect, true);
  assert.equal(out.score, 100);
});

test('reviewMaskEdit: a non-perfect "SCORE: 42" verdict returns perfect=false and score 42', async () => {
  const { reviewMaskEdit } = createImageReview({ genAI: fakeGrader('SCORE: 42') });
  const out = await reviewMaskEdit(REAL_DATA_URL, REAL_DATA_URL);
  assert.equal(out.perfect, false);
  assert.equal(out.score, 42);
});

test('reviewMaskEdit: an out-of-range "SCORE: 250" is clamped to 100', async () => {
  const { reviewMaskEdit } = createImageReview({ genAI: fakeGrader('SCORE: 250') });
  const out = await reviewMaskEdit(REAL_DATA_URL, REAL_DATA_URL);
  assert.equal(out.perfect, false);
  assert.equal(out.score, 100);
});

test('reviewMaskEdit: a null openai client is treated as a disabled reviewer (perfect, score 100)', async () => {
  const { reviewMaskEdit } = createImageReview({ genAI: null });
  const out = await reviewMaskEdit(REAL_DATA_URL, REAL_DATA_URL);
  assert.deepEqual(out, { perfect: true, score: 100, reason: 'reviewer disabled' });
});

test('reviewMaskEdit: a thrown create() fails OPEN (perfect, score 100, reason "reviewer error")', async () => {
  const { reviewMaskEdit } = createImageReview({ genAI: fakeGrader(new Error('OpenAI exploded')) });
  const out = await reviewMaskEdit(REAL_DATA_URL, REAL_DATA_URL);
  assert.deepEqual(out, { perfect: true, score: 100, reason: 'reviewer error' });
});

// ── C. validateStageableImage ─────────────────────────────────────────────────

test('validateStageableImage: a "VALID: true" verdict returns valid with empty reason', async () => {
  const { validateStageableImage } = createImageReview({ genAI: fakeGrader('VALID: true') });
  const out = await validateStageableImage(REAL_BUF);
  assert.deepEqual(out, { valid: true, reason: '' });
});

test('validateStageableImage: a rejection parses REASON text (quotes stripped) and marks invalid', async () => {
  const { validateStageableImage } = createImageReview({
    genAI: fakeGrader('VALID: false\nREASON: "Not a room."'),
  });
  const out = await validateStageableImage(REAL_BUF);
  assert.equal(out.valid, false);
  assert.equal(out.reason, 'Not a room.');
});

test('validateStageableImage: a null openai client fails OPEN as valid', async () => {
  const { validateStageableImage } = createImageReview({ genAI: null });
  const out = await validateStageableImage(REAL_BUF);
  assert.deepEqual(out, { valid: true, reason: '' });
});

test('validateStageableImage: a thrown create() fails OPEN as valid', async () => {
  const { validateStageableImage } = createImageReview({ genAI: fakeGrader(new Error('OpenAI exploded')) });
  const out = await validateStageableImage(REAL_BUF);
  assert.deepEqual(out, { valid: true, reason: '' });
});

// ── D. annotateImage CAD classification ───────────────────────────────────────

test('annotateImage: a "CAD: True" line is stripped and re-appended in standardized form', async () => {
  const { annotateImage } = createImageAnnotation({ openai: fakeOpenAI('A cozy living room.\nCAD: True') });
  const out = await annotateImage(REAL_DATA_URL);
  assert.equal(out, 'A cozy living room. CAD: True');
  assert.ok(out.endsWith(' CAD: True'));
  assert.ok(!out.includes('\n'), 'the raw multi-line CAD line is collapsed away');
});

test('annotateImage: with no CAD line and isCAD=false, " CAD: False" is appended from the default', async () => {
  const { annotateImage } = createImageAnnotation({ openai: fakeOpenAI('A modern kitchen.') });
  const out = await annotateImage(REAL_DATA_URL, false);
  assert.equal(out, 'A modern kitchen. CAD: False');
  assert.ok(out.endsWith(' CAD: False'));
});

test('annotateImage: with isCAD=true and no CAD line in the reply, " CAD: True" is appended from the default', async () => {
  const { annotateImage } = createImageAnnotation({ openai: fakeOpenAI('A top-down architectural blueprint.') });
  const out = await annotateImage(REAL_DATA_URL, true);
  assert.equal(out, 'A top-down architectural blueprint. CAD: True');
  assert.ok(out.endsWith(' CAD: True'));
});

test('annotateImage: a null openai client returns null (no annotation)', async () => {
  const { annotateImage } = createImageAnnotation({ openai: null });
  const out = await annotateImage(REAL_DATA_URL);
  assert.equal(out, null);
});

test('annotateImage: a thrown create() fails OPEN to null', async () => {
  const { annotateImage } = createImageAnnotation({ openai: fakeOpenAI(new Error('OpenAI exploded')) });
  const out = await annotateImage(REAL_DATA_URL);
  assert.equal(out, null);
});

// ── E. erase.buildKeepExceptionText (PURE, no model) ──────────────────────────

test('buildKeepExceptionText: an empty string yields an empty exception', () => {
  const { buildKeepExceptionText } = createErase({ genAI: null, openai: null });
  assert.equal(buildKeepExceptionText(''), '');
});

test('buildKeepExceptionText: whitespace-only input yields an empty exception', () => {
  const { buildKeepExceptionText } = createErase({ genAI: null, openai: null });
  assert.equal(buildKeepExceptionText('   '), '');
});

test('buildKeepExceptionText: a real instruction is embedded under a NARROW EXCEPTION clause', () => {
  const { buildKeepExceptionText } = createErase({ genAI: null, openai: null });
  const out = buildKeepExceptionText('keep the rug');
  assert.ok(out.includes('keep the rug'), 'includes the trimmed instruction');
  assert.ok(out.includes('NARROW EXCEPTION'), 'includes the NARROW EXCEPTION phrase');
});

// ── F. erase.verifyRoomEmptied ────────────────────────────────────────────────

test('verifyRoomEmptied: "CLEAN: true" reports the room as empty with no leftovers', async () => {
  const { verifyRoomEmptied } = createErase({ genAI: null, openai: fakeOpenAI('CLEAN: true') });
  const out = await verifyRoomEmptied(REAL_BUF);
  assert.deepEqual(out, { empty: true, remaining: '' });
});

test('verifyRoomEmptied: "CLEAN: false | sofa, rug" reports not-empty with the parsed leftovers', async () => {
  const { verifyRoomEmptied } = createErase({ genAI: null, openai: fakeOpenAI('CLEAN: false | sofa, rug') });
  const out = await verifyRoomEmptied(REAL_BUF);
  assert.deepEqual(out, { empty: false, remaining: 'sofa, rug' });
});

test('verifyRoomEmptied: a null openai client fails OPEN as empty', async () => {
  const { verifyRoomEmptied } = createErase({ genAI: null, openai: null });
  const out = await verifyRoomEmptied(REAL_BUF);
  assert.deepEqual(out, { empty: true, remaining: '' });
});

test('verifyRoomEmptied: a thrown create() fails OPEN as empty', async () => {
  const { verifyRoomEmptied } = createErase({ genAI: null, openai: fakeOpenAI(new Error('OpenAI exploded')) });
  const out = await verifyRoomEmptied(REAL_BUF);
  assert.deepEqual(out, { empty: true, remaining: '' });
});

// ── G. erase.roomIsAlreadyEmpty ───────────────────────────────────────────────

test('roomIsAlreadyEmpty: "EMPTY: true" reports the room is already empty', async () => {
  const { roomIsAlreadyEmpty } = createErase({ genAI: null, openai: fakeOpenAI('EMPTY: true') });
  assert.equal(await roomIsAlreadyEmpty(REAL_BUF), true);
});

test('roomIsAlreadyEmpty: a non-null "EMPTY: false" reply reports not-empty (false) via the parse path', async () => {
  const { roomIsAlreadyEmpty } = createErase({ genAI: null, openai: fakeOpenAI('EMPTY: false') });
  assert.equal(await roomIsAlreadyEmpty(REAL_BUF), false);
});

test('roomIsAlreadyEmpty: a null openai client reports not-empty (false)', async () => {
  const { roomIsAlreadyEmpty } = createErase({ genAI: null, openai: null });
  assert.equal(await roomIsAlreadyEmpty(REAL_BUF), false);
});

test('roomIsAlreadyEmpty: a thrown create() fails OPEN to not-empty (false)', async () => {
  const { roomIsAlreadyEmpty } = createErase({ genAI: null, openai: fakeOpenAI(new Error('OpenAI exploded')) });
  assert.equal(await roomIsAlreadyEmpty(REAL_BUF), false);
});
