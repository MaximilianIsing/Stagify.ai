// Gemini-vision QA reviewers (lib/image/image-review.js): reviewImageQuality,
// reviewMaskEdit, validateStageableImage. Every one of them fails OPEN — a null client,
// a thrown API error, or a score-less reply must never block a user's image — and the
// numeric SCORE is clamped to 0-100. We pin those contracts with a fake Gemini client
// (scripted content, no real call, no cost) and real sharp buffers/data-urls for the
// downscale step.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createImageReview } from '../../lib/image/image-review.js';
import { DEFAULT_UNSTAGEABLE_REASON, UNSTAGEABLE_CODES, GENERIC_UNSTAGEABLE_CODE } from '../../lib/staging/unstageable.js';

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
test('reviewImageQuality: disabled reviewer (no client) passes the image with score 100, marked degraded', async () => {
  const { reviewImageQuality } = createImageReview({ genAI: null });
  assert.deepEqual(await reviewImageQuality(TINY_PNG), { perfect: true, score: 100, reason: 'reviewer disabled', degraded: true });
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

test('reviewImageQuality: a thrown API error fails open (accept the image) and marks it degraded', async () => {
  const r = await createImageReview({ genAI: fakeGrader(new Error('boom')) }).reviewImageQuality(TINY_PNG);
  assert.deepEqual(r, { perfect: true, score: 100, reason: 'reviewer error', degraded: true });
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
    { perfect: true, score: 100, reason: 'reviewer disabled', degraded: true },
  );

  const good = await createImageReview({ genAI: fakeGrader('PERFECT: true') }).reviewMaskEdit(TINY_PNG, TINY_PNG);
  assert.equal(good.perfect, true);
  assert.ok(!good.degraded, 'a reviewed pass must not carry degraded');

  const scored = await createImageReview({ genAI: fakeGrader('PERFECT: false\nSCORE: 73') })
    .reviewMaskEdit(TINY_PNG, TINY_PNG, { instruction: 'remove the clutter' });
  assert.equal(scored.perfect, false);
  assert.equal(scored.score, 73);

  const failed = await createImageReview({ genAI: fakeGrader(new Error('nope')) }).reviewMaskEdit(TINY_PNG, TINY_PNG);
  assert.deepEqual(failed, { perfect: true, score: 100, reason: 'reviewer error', degraded: true });
});

// --- validateStageableImage (takes a Buffer, not a data URL) ----------------
// The grader answers with a digit from the fixed UNSTAGEABLE_CODES taxonomy (0 = valid)
// and we own the copy, so these pin the digit→code/message mapping and the fail-OPEN
// behaviour on every unusable reply.
const VALID = { valid: true, code: null, reason: '' };

test('validateStageableImage: no client → valid', async () => {
  const { validateStageableImage } = createImageReview({ genAI: null });
  assert.deepEqual(await validateStageableImage(await roomBuffer()), VALID);
});

test('validateStageableImage: "CODE: 0" → valid, with no code and no reason', async () => {
  const { validateStageableImage } = createImageReview({ genAI: fakeGrader('CODE: 0') });
  assert.deepEqual(await validateStageableImage(await roomBuffer()), VALID);
});

test('validateStageableImage: every rejection digit maps to its own code and message', async () => {
  for (const [digit, entry] of Object.entries(UNSTAGEABLE_CODES)) {
    const { validateStageableImage } = createImageReview({ genAI: fakeGrader(`CODE: ${digit}`) });
    const r = await validateStageableImage(await roomBuffer());
    assert.equal(r.valid, false, `digit ${digit} should reject`);
    assert.equal(r.code, entry.code);
    assert.equal(r.reason, entry.message);
  }
});

test('validateStageableImage: the six rejection codes and messages are all distinct', () => {
  const entries = Object.values(UNSTAGEABLE_CODES);
  assert.equal(entries.length, 6);
  assert.equal(new Set(entries.map((e) => e.code)).size, 6, 'duplicate code would collapse two categories');
  assert.equal(new Set(entries.map((e) => e.message)).size, 6, 'duplicate copy defeats the point of the taxonomy');
  assert.ok(!entries.some((e) => e.code === GENERIC_UNSTAGEABLE_CODE), 'generic code must not collide with a category');
});

test('validateStageableImage: an in-range but unmapped digit still rejects, with the generic copy', async () => {
  // Defensive: the grader said "not valid", so honour the verdict rather than
  // discarding it just because the digit is outside the taxonomy we published.
  const { validateStageableImage } = createImageReview({ genAI: fakeGrader('CODE: 9') });
  const r = await validateStageableImage(await roomBuffer());
  assert.equal(r.valid, false);
  assert.equal(r.code, GENERIC_UNSTAGEABLE_CODE);
  assert.equal(r.reason, DEFAULT_UNSTAGEABLE_REASON);
});

test('validateStageableImage: an unreadable reply fails OPEN rather than blocking the upload', async () => {
  for (const reply of ['', 'VALID: false', 'I think this is a picture of a dog.']) {
    const { validateStageableImage } = createImageReview({ genAI: fakeGrader(reply) });
    assert.deepEqual(await validateStageableImage(await roomBuffer()), VALID, `reply ${JSON.stringify(reply)}`);
  }
});

test('validateStageableImage: a thrown error fails open (allow the upload)', async () => {
  const { validateStageableImage } = createImageReview({ genAI: fakeGrader(new Error('vision down')) });
  assert.deepEqual(await validateStageableImage(await roomBuffer()), VALID);
});

// --- validateExteriorImage --------------------------------------------------
//
// The Exterior Studio's own gate. Same taxonomy, same fail-open rules, one hard
// difference: it can never reject with VEHICLE, because a car on the driveway is the
// single most common thing this tool is asked to remove.

test('validateExteriorImage: asks the grader the EXTERIOR question, not the interior one', async () => {
  // The two prompts share a digit table, so pointing this gate at the wrong prompt would
  // still parse, still return a plausible verdict, and still reject facades.
  const seen = [];
  const genAI = {
    getGenerativeModel: () => ({
      generateContent: async (parts) => { seen.push(parts[0].text); return { response: { text: () => 'CODE: 0' } }; },
    }),
  };
  const { validateExteriorImage, validateStageableImage } = createImageReview({ genAI });
  await validateExteriorImage(await roomBuffer());
  await validateStageableImage(await roomBuffer());
  assert.match(seen[0], /EXTERIOR photographs/, 'the exterior gate uses the exterior prompt');
  assert.notEqual(seen[0], seen[1], 'and it is not the interior one');
});

test('validateExteriorImage: a VEHICLE verdict is IGNORED, not honoured', async () => {
  // The prompt does not offer digit 5, but a grader answering from the interior taxonomy
  // it has seen a thousand times would reject a kerbside photo of a house. That would
  // look like a random flake rather than a bug, so the reviewer drops it outright.
  const { validateExteriorImage } = createImageReview({ genAI: fakeGrader('CODE: 5') });
  assert.deepEqual(await validateExteriorImage(await roomBuffer()), VALID);

  // ...and the interior gate must keep honouring it — this is a per-gate rule, not a
  // change to what digit 5 means.
  const { validateStageableImage } = createImageReview({ genAI: fakeGrader('CODE: 5') });
  const interior = await validateStageableImage(await roomBuffer());
  assert.equal(interior.valid, false);
  assert.equal(interior.code, 'VEHICLE');
});

test('validateExteriorImage: still rejects the categories it shares, with the same codes', async () => {
  // No new codes means no new errors.unstageable.* keys in eleven language packs — the
  // browser localizes these exactly as it already does.
  for (const [digit, expected] of [['1', 'PERSON_PORTRAIT'], ['2', 'ANIMAL'], ['3', 'FOOD'], ['4', 'DOCUMENT'], ['6', 'UNRELATED_OBJECT']]) {
    const { validateExteriorImage } = createImageReview({ genAI: fakeGrader(`CODE: ${digit}`) });
    const r = await validateExteriorImage(await roomBuffer());
    assert.equal(r.valid, false, `digit ${digit} must still reject`);
    assert.equal(r.code, expected);
    assert.equal(r.reason, UNSTAGEABLE_CODES[digit].message, 'and reuse the shared English copy');
  }
});

test('validateExteriorImage: fails OPEN on a null client, an unreadable reply, and a throw', async () => {
  assert.deepEqual(await createImageReview({ genAI: null }).validateExteriorImage(await roomBuffer()), VALID);
  assert.deepEqual(await createImageReview({ genAI: fakeGrader('no idea') }).validateExteriorImage(await roomBuffer()), VALID);
  assert.deepEqual(await createImageReview({ genAI: fakeGrader(new Error('down')) }).validateExteriorImage(await roomBuffer()), VALID);
});

// --- the reviewImageQuality rubric seam -------------------------------------

test('reviewImageQuality: basePrompt replaces the interior rubric but keeps the reply contract', async () => {
  // The retry loop parses PERFECT/SCORE and folds WHY into the next attempt, so the
  // suffixes must survive whatever rubric is swapped in.
  let sent = '';
  const genAI = {
    getGenerativeModel: () => ({
      generateContent: async (parts) => { sent = parts[0].text; return { response: { text: () => 'PERFECT: true' } }; },
    }),
  };
  const { reviewImageQuality } = createImageReview({ genAI });
  await reviewImageQuality(TINY_PNG, { basePrompt: 'RUBRIC-XYZ', instruction: 'make it sunny' });
  assert.ok(sent.startsWith('RUBRIC-XYZ'), 'the caller\'s rubric leads');
  assert.ok(!sent.includes('interior real-estate'), 'and the default is gone, not merely appended to');
  assert.match(sent, /make it sunny/, 'the instruction clause still lands');
  assert.match(sent, /WHY:/, 'and the WHY suffix the retry loop needs');
});

test('reviewImageQuality: an absent or empty basePrompt keeps the interior default', async () => {
  // Every pre-existing caller passes nothing. This is the no-op half of the seam.
  for (const opts of [{}, { basePrompt: null }, { basePrompt: '' }]) {
    let sent = '';
    const genAI = {
      getGenerativeModel: () => ({
        generateContent: async (parts) => { sent = parts[0].text; return { response: { text: () => 'PERFECT: true' } }; },
      }),
    };
    await createImageReview({ genAI }).reviewImageQuality(TINY_PNG, opts);
    assert.match(sent, /interior real-estate/, `default rubric expected for ${JSON.stringify(opts)}`);
  }
});
