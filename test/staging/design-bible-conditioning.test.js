// Design-bible conditioning: the THIRD mode of the extra-image channel, and the
// worst-of quality gate that makes it enforceable rather than merely requested.
//
// Two layers are covered here:
//   1. designBiblePromptSuffix (pure)         — the model-facing wording and its ordering.
//   2. processStaging's mode selection + reviewFn composition (faked Gemini + retry loop)
//      — that a bible-carrying request gets the bible suffix and NOT the style/furniture
//      one, that the hero reference is withheld from the quality reviewer, and that the
//      continuity verdict can veto a high-quality image.
//
// Layer 2 is the one that actually protects the product promise. The prompt text being
// right is worth little if the branch that selects it can be flipped without a failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  styleReferencePromptSuffix,
  furnitureReferencePromptSuffix,
} from '../../lib/staging/prompts.js';
import { designBiblePromptSuffix } from '../../lib/staging/prompts-continuity.js';
import { createStagingGeneration } from '../../lib/staging/staging-generation.js';

const png = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 40, g: 90, b: 160 } } }).png().toBuffer();
const jpg = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 180, b: 150 } } }).jpeg().toBuffer();

/** A minimal but realistic bible fixture. */
function bibleFixture(overrides = {}) {
  return {
    version: 1,
    roomKey: 'living-room-1',
    roomType: 'Living room',
    furnitureStyle: 'midcentury',
    palette: { primary: 'oatmeal bouclé', wood: 'walnut', metal: '' },
    lighting: { direction: 'window camera-left', temperature: 'warm daylight ~4800K' },
    pieces: [
      { slot: 'sofa', identity: '3-seat low-profile sofa, oatmeal bouclé, four tapered walnut legs', placement: 'against the long wall', critical: true },
      { slot: 'rug', identity: 'flatweave wool rug, cream with terracotta grid, no fringe', placement: 'under the coffee table', critical: true },
      { slot: 'plant', identity: 'fiddle leaf fig in a matte terracotta pot', placement: 'window corner', critical: false },
    ],
    negatives: ['no tufted upholstery', 'no chrome'],
    ...overrides,
  };
}

// ── Layer 1: the pure suffix ────────────────────────────────────────────────

test('designBiblePromptSuffix: no bible, or a piece-less bible, yields nothing', () => {
  assert.equal(designBiblePromptSuffix(null, 1), '');
  assert.equal(designBiblePromptSuffix(undefined, 1), '');
  assert.equal(designBiblePromptSuffix(bibleFixture({ pieces: [] }), 1), '');
  // A malformed `pieces` must not throw — this input comes from a model via a
  // normalizer, and a crash here would take down a whole listing job.
  assert.equal(designBiblePromptSuffix(/** @type {any} */ ({ pieces: 'sofa' }), 1), '');
});

test('designBiblePromptSuffix: separates must-match pieces from tolerable ones', () => {
  const s = designBiblePromptSuffix(bibleFixture(), 1);
  const mustIdx = s.indexOf('MUST match exactly');
  const tolerableIdx = s.indexOf('minor variation tolerable');
  assert.ok(mustIdx > -1 && tolerableIdx > -1, 'both partitions are present');
  assert.ok(mustIdx < tolerableIdx, 'critical pieces come first');
  // The critical pieces must land in the must-match half and the non-critical one after.
  assert.ok(s.indexOf('sofa:') < tolerableIdx, 'sofa is a must-match');
  assert.ok(s.indexOf('rug:') < tolerableIdx, 'rug is a must-match');
  assert.ok(s.indexOf('plant:') > tolerableIdx, 'plant is only tolerable');
});

test('designBiblePromptSuffix: re-partitions rather than trusting piece order', () => {
  // The normalizer emits critical-first, but nothing in the type enforces it. A
  // shuffled bible must produce the same partitioning, or an upstream reordering
  // would silently downgrade the sofa to "minor variation tolerable".
  const shuffled = bibleFixture();
  shuffled.pieces = [shuffled.pieces[2], shuffled.pieces[0], shuffled.pieces[1]];
  const s = designBiblePromptSuffix(shuffled, 1);
  const tolerableIdx = s.indexOf('minor variation tolerable');
  assert.ok(s.indexOf('sofa:') < tolerableIdx);
  assert.ok(s.indexOf('plant:') > tolerableIdx);
});

test('designBiblePromptSuffix: states identity-fixed / angle-free, and allows partial views', () => {
  const s = designBiblePromptSuffix(bibleFixture(), 1);
  // The angle carve-out: without it the model reproduces the hero's viewpoint and the
  // support frame becomes a copy of the hero frame.
  assert.match(s, /IDENTITY IS FIXED; CAMERA ANGLE IS NOT/);
  assert.match(s, /rotate, turn, and re-angle/);
  // The out-of-frame carve-out: without it the model crams every listed piece in.
  assert.match(s, /PARTIAL VIEWS ARE CORRECT/);
  assert.match(s, /MUST be left out/);
});

test('designBiblePromptSuffix: emits palette, lighting and negatives, skipping empty values', () => {
  const s = designBiblePromptSuffix(bibleFixture(), 1);
  assert.match(s, /LOCKED PALETTE AND MATERIALS/);
  assert.match(s, /primary: oatmeal bouclé/);
  assert.ok(!/metal:/.test(s), 'an empty palette value is dropped, not printed blank');
  assert.match(s, /LIGHTING CONTINUITY/);
  assert.match(s, /FORBIDDEN/);
  assert.match(s, /no chrome/);

  // Each block is independently optional.
  const bare = designBiblePromptSuffix(bibleFixture({ palette: {}, lighting: {}, negatives: [] }), 1);
  assert.ok(!/LOCKED PALETTE/.test(bare));
  assert.ok(!/LIGHTING CONTINUITY/.test(bare));
  assert.ok(!/FORBIDDEN/.test(bare));
  assert.match(bare, /MUST match exactly/, 'the piece list still survives');
});

test('designBiblePromptSuffix: only frames the reference image when one is attached', () => {
  const withRef = designBiblePromptSuffix(bibleFixture(), 1);
  const noRef = designBiblePromptSuffix(bibleFixture(), 0);
  assert.match(withRef, /image immediately after the room photo/);
  assert.ok(!/image immediately after the room photo/.test(noRef),
    'text-only conditioning must not describe an image that was not sent');
  assert.match(noRef, /MUST match exactly/, 'but the bible itself is still useful without it');
});

test('designBiblePromptSuffix says the opposite of the style suffix (they are not interchangeable)', () => {
  // This is the whole reason a third mode exists. The style suffix forbids copying the
  // reference's objects; a support frame must copy exactly those objects.
  const style = styleReferencePromptSuffix(1);
  const bible = designBiblePromptSuffix(bibleFixture(), 1);
  assert.match(style, /Do NOT copy its exact objects/);
  assert.ok(!/Do NOT copy its exact objects/.test(bible));
  assert.match(bible, /SAME physical object|Reproduce those objects/);
});

// ── Layer 2: mode selection and the reviewer composition ────────────────────

/** Fake Gemini returning fixed PNG bytes in the shape processStaging reads. */
function fakeGenAI(pngBuffer) {
  return {
    getGenerativeModel: () => ({
      generateContent: async () => ({
        response: { candidates: [{ content: { parts: [{ inlineData: { data: pngBuffer.toString('base64') } }] } }] },
      }),
    }),
  };
}

/**
 * A retry loop stand-in that records every prompt it was handed and every verdict the
 * injected reviewFn returned, then behaves like the real one: first "perfect" wins,
 * otherwise the best score.
 */
function recordingRetry(record) {
  return async (generateOnce, opts) => {
    let best = null;
    for (let attempt = 1; attempt <= (opts.maxAttempts || 1); attempt += 1) {
      const url = await generateOnce(attempt, best ? best.review : null);
      if (opts.onImageProduced) opts.onImageProduced(attempt);
      const review = await opts.reviewFn(url);
      record.verdicts.push(review);
      if (review.perfect) return url;
      if (!best || review.score > best.review.score) best = { url, review };
    }
    return best ? best.url : null;
  };
}

async function makeGen({ record, reviewImageQuality, reviewDesignConsistency, maxAttempts = 1 }) {
  const modelPng = await png(640, 480);
  return createStagingGeneration({
    genAI: fakeGenAI(modelPng),
    DEBUG_MODE: false,
    runQualityRetry: recordingRetry(record),
    reviewImageQuality,
    reviewDesignConsistency,
    QUALITY_MAX_ATTEMPTS: maxAttempts,
    logPromptToFile: () => {},
  });
}

const perfectQuality = async () => ({ perfect: true, score: 100, reason: 'ok' });

test('processStaging: a bible request gets the bible suffix and NOT the furniture/style one', async () => {
  const record = { verdicts: [], prompts: [] };
  const seenPrompts = [];
  const { processStaging } = await makeGen({
    record,
    reviewImageQuality: perfectQuality,
    reviewDesignConsistency: async () => ({ perfect: true, score: 100, reason: 'ok', slots: [] }),
  });
  // Capture the prompt by way of the CSV logger's promptText argument instead of
  // reaching into internals: rebuild the factory with a recording logger.
  const modelPng = await png(640, 480);
  const api = createStagingGeneration({
    genAI: fakeGenAI(modelPng),
    DEBUG_MODE: false,
    runQualityRetry: recordingRetry(record),
    reviewImageQuality: perfectQuality,
    reviewDesignConsistency: async () => ({ perfect: true, score: 100, reason: 'ok', slots: [] }),
    QUALITY_MAX_ATTEMPTS: 1,
    logPromptToFile: (promptText) => { seenPrompts.push(promptText); },
  });
  assert.equal(typeof processStaging, 'function');

  const room = await jpg(1200, 800);
  const hero = await jpg(1200, 800);
  await api.processStaging(
    room,
    { roomType: 'Living room', furnitureStyle: 'midcentury', designBible: bibleFixture(), frameRole: 'support' },
    null,
    [hero],
    'gemini-2.5-flash-image',
  );

  assert.equal(seenPrompts.length, 1);
  const prompt = seenPrompts[0];
  assert.match(prompt, /THIS ROOM IS ALREADY STAGED/, 'the bible suffix is present');
  // The critical assertion: the furniture suffix would tell the model the hero photo is
  // "reference furniture the user wants incorporated", and the style suffix would tell
  // it to change the furniture. Neither may be attached on this path.
  assert.ok(!/reference furniture/.test(prompt), 'no furniture-reference wording');
  assert.ok(!/STYLE REFERENCE/.test(prompt), 'no style-reference wording');
});

test('processStaging: without a bible the existing furniture/style modes are unchanged', async () => {
  const record = { verdicts: [] };
  const seen = [];
  const modelPng = await png(640, 480);
  const api = createStagingGeneration({
    genAI: fakeGenAI(modelPng),
    DEBUG_MODE: false,
    runQualityRetry: recordingRetry(record),
    reviewImageQuality: perfectQuality,
    QUALITY_MAX_ATTEMPTS: 1,
    logPromptToFile: (promptText) => { seen.push(promptText); },
  });
  const room = await jpg(1200, 800);
  const ref = await jpg(1200, 800);

  await api.processStaging(room, { roomType: 'Bedroom' }, null, [ref], 'gemini-2.5-flash-image');
  assert.match(seen[0], /reference furniture/, 'furniture mode still selected by default');
  assert.ok(!/THIS ROOM IS ALREADY STAGED/.test(seen[0]));

  await api.processStaging(room, { roomType: 'Bedroom', styleReference: true }, null, [ref], 'gemini-2.5-flash-image');
  assert.match(seen[1], /STYLE REFERENCE/, 'style mode still selectable');
  assert.ok(!/THIS ROOM IS ALREADY STAGED/.test(seen[1]));
});

test('processStaging: the hero reference is withheld from the QUALITY reviewer on the bible path', async () => {
  // The quality reviewer's furniture guide reads "the remaining images are the furniture
  // pieces the user uploaded to be included — check it was incorporated". On the bible
  // path that extra image is a whole ROOM, so passing it under that wording asks the
  // reviewer to confirm a room-sized "furniture piece" was placed inside the room — which
  // it can never confirm, so every support frame would fail QA and burn its full retry
  // budget. The continuity reviewer, which knows what that image actually is, gets it instead.
  const record = { verdicts: [] };
  const modelPng = await png(640, 480);
  /** @type {Array<string[]>} */
  const qualityFurnitureArgs = [];
  /** @type {number[]} */
  const continuityCalls = [];
  const api = createStagingGeneration({
    genAI: fakeGenAI(modelPng),
    DEBUG_MODE: false,
    runQualityRetry: recordingRetry(record),
    reviewImageQuality: async (_url, opts) => {
      qualityFurnitureArgs.push((opts && opts.furnitureDataUrls) || []);
      return { perfect: true, score: 100, reason: 'ok' };
    },
    reviewDesignConsistency: async (heroUrl) => {
      continuityCalls.push(heroUrl ? 1 : 0);
      return { perfect: true, score: 100, reason: 'ok', slots: [] };
    },
    QUALITY_MAX_ATTEMPTS: 1,
    logPromptToFile: () => {},
  });

  const room = await jpg(1200, 800);
  const hero = await jpg(1200, 800);

  await api.processStaging(room, { roomType: 'Living room', designBible: bibleFixture() }, null, [hero], 'gemini-2.5-flash-image');
  assert.deepEqual(qualityFurnitureArgs[0], [],
    'the bible path must send the quality reviewer NO furniture references');
  assert.deepEqual(continuityCalls, [1],
    'and the continuity reviewer must receive the hero frame it needs to compare against');

  // The contrast case: on the ordinary furniture path the reviewer still gets them, so
  // this guard cannot be satisfied by simply never passing references to anyone.
  await api.processStaging(room, { roomType: 'Living room' }, null, [hero], 'gemini-2.5-flash-image');
  assert.equal(qualityFurnitureArgs[1].length, 1,
    'the furniture path still hands the reviewer the uploaded piece to check');
});

test('processStaging: the continuity verdict vetoes a perfect-quality image (worst-of, not average)', async () => {
  // The failure this guards: a beautiful render containing the wrong sofa. Quality says
  // 100/perfect; continuity says 30/mismatch. Averaging (65) or trusting quality alone
  // would accept it on the first attempt and never retry.
  const record = { verdicts: [] };
  const modelPng = await png(640, 480);
  let qualityCalls = 0;
  let continuityCalls = 0;
  const api = createStagingGeneration({
    genAI: fakeGenAI(modelPng),
    DEBUG_MODE: false,
    runQualityRetry: recordingRetry(record),
    reviewImageQuality: async () => { qualityCalls += 1; return { perfect: true, score: 100, reason: 'PERFECT: true' }; },
    reviewDesignConsistency: async () => {
      continuityCalls += 1;
      return { perfect: false, score: 30, reason: 'PERFECT: false\nSCORE: 30\nWHY: the sofa is tufted with chrome legs', slots: [{ slot: 'sofa', match: false }] };
    },
    QUALITY_MAX_ATTEMPTS: 3,
    logPromptToFile: () => {},
  });

  /** @type {import('../../lib/types/staging.js').StagingOutcome} */
  const outcome = {};
  await api.processStaging(
    await jpg(1200, 800),
    { roomType: 'Living room', designBible: bibleFixture() },
    null,
    [await jpg(1200, 800)],
    'gemini-2.5-flash-image',
    outcome,
  );

  assert.equal(qualityCalls, 3, 'both reviewers ran on every attempt');
  assert.equal(continuityCalls, 3);
  // Every verdict the retry loop saw must be the LOSING one, so the loop keeps retrying
  // and the "WHY: the sofa is tufted" line is what reaches qualityRetryFeedbackSuffix.
  assert.equal(record.verdicts.length, 3);
  for (const v of record.verdicts) {
    assert.equal(v.perfect, false, 'the composed verdict is never perfect while continuity fails');
    assert.equal(v.score, 30, 'the worst score wins, not the average');
    assert.match(v.reason, /the sofa is tufted/, 'the losing verdict carries the actionable WHY line');
  }
  assert.equal(outcome.consistencyScore, 30);
  assert.deepEqual(outcome.mismatchedSlots, ['sofa']);
});

test('processStaging: a NAMED mismatch is never perfect, even when it ties on score', async () => {
  // The hole this closes: the composed verdict took the loser BY SCORE and inherited that
  // verdict's `perfect`. The continuity prompt invites "SCORE: 100" for one mild
  // substitution, so {perfect:false, score:100, slots:[sofa mismatch]} tied with a perfect
  // quality verdict, `100 < 100` was false, quality won, and the retry loop stopped on
  // attempt 1 and shipped the wrong sofa. `perfect` must be ANDed, not inherited.
  const record = { verdicts: [] };
  const modelPng = await png(640, 480);
  let attempts = 0;
  const api = createStagingGeneration({
    genAI: fakeGenAI(modelPng),
    DEBUG_MODE: false,
    runQualityRetry: recordingRetry(record),
    reviewImageQuality: async () => { attempts += 1; return { perfect: true, score: 100, reason: 'PERFECT: true' }; },
    reviewDesignConsistency: async () => ({
      perfect: false, score: 100, checked: true,
      reason: 'SLOT: sofa = mismatch\nPERFECT: false\nWHY: the sofa is tufted',
      slots: [{ slot: 'sofa', match: false }],
    }),
    QUALITY_MAX_ATTEMPTS: 3,
    logPromptToFile: () => {},
  });
  /** @type {import('../../lib/types/staging.js').StagingOutcome} */
  const outcome = {};
  await api.processStaging(await jpg(1200, 800), { roomType: 'Living room', designBible: bibleFixture() },
    null, [await jpg(1200, 800)], 'gemini-2.5-flash-image', outcome);

  assert.equal(attempts, 3, 'a tie on score must NOT end the retry loop while a slot is named');
  for (const v of record.verdicts) {
    assert.equal(v.perfect, false, 'whichever reviewer refuses, the attempt is not perfect');
  }
  assert.deepEqual(outcome.mismatchedSlots, ['sofa']);
});

test('processStaging: an UNCHECKED continuity verdict persists as null, not its sentinel 100', async () => {
  // The reviewer fails open with {perfect:true, score:100, checked:false} — correct for the
  // retry loop, wrong to persist. Storing that 100 put "Consistency 100.00" in the grid for
  // a frame nothing had compared, which is exactly what this field's docblock forbids.
  const record = { verdicts: [] };
  const modelPng = await png(640, 480);
  const api = createStagingGeneration({
    genAI: fakeGenAI(modelPng),
    DEBUG_MODE: false,
    runQualityRetry: recordingRetry(record),
    reviewImageQuality: perfectQuality,
    reviewDesignConsistency: async () => ({ perfect: true, score: 100, reason: 'reviewer error', slots: [], checked: false }),
    QUALITY_MAX_ATTEMPTS: 1,
    logPromptToFile: () => {},
  });
  /** @type {import('../../lib/types/staging.js').StagingOutcome} */
  const outcome = {};
  await api.processStaging(await jpg(1200, 800), { roomType: 'Living room', designBible: bibleFixture() },
    null, [await jpg(1200, 800)], 'gemini-2.5-flash-image', outcome);
  assert.equal(outcome.consistencyScore, null, 'unchecked must not be recorded as a score');
  assert.deepEqual(outcome.mismatchedSlots, []);
  // And the render still succeeded — failing open must not cost the user the image.
  assert.equal(record.verdicts.length, 1);
});

test('processStaging: the persisted scores describe the DELIVERED image, not the last attempt', async () => {
  // The retry loop returns the best-SCORING attempt, which is usually not the last one. A
  // single last-write-wins capture therefore audited a discarded render: the frame shipped
  // was attempt 1, while the row recorded attempt 3's much worse verdict.
  const record = { verdicts: [] };
  const modelPng = await png(640, 480);
  const scores = [90, 20, 10];
  let i = 0;
  const api = createStagingGeneration({
    genAI: fakeGenAI(modelPng),
    DEBUG_MODE: false,
    runQualityRetry: recordingRetry(record),
    reviewImageQuality: perfectQuality,
    reviewDesignConsistency: async () => {
      const score = scores[Math.min(i, scores.length - 1)];
      i += 1;
      return {
        perfect: false, score, checked: true, reason: `SCORE: ${score}`,
        slots: score < 50 ? [{ slot: 'sofa', match: false }] : [{ slot: 'sofa', match: true }],
      };
    },
    QUALITY_MAX_ATTEMPTS: 3,
    logPromptToFile: () => {},
  });
  /** @type {import('../../lib/types/staging.js').StagingOutcome} */
  const outcome = {};
  await api.processStaging(await jpg(1200, 800), { roomType: 'Living room', designBible: bibleFixture() },
    null, [await jpg(1200, 800)], 'gemini-2.5-flash-image', outcome);
  assert.equal(outcome.consistencyScore, 90, 'the best attempt was delivered, so 90 is the honest score');
  assert.deepEqual(outcome.mismatchedSlots, [], 'and its slots, not the worst attempt’s');
});

test('processStaging: quality still vetoes when continuity is clean', async () => {
  const record = { verdicts: [] };
  const modelPng = await png(640, 480);
  const api = createStagingGeneration({
    genAI: fakeGenAI(modelPng),
    DEBUG_MODE: false,
    runQualityRetry: recordingRetry(record),
    reviewImageQuality: async () => ({ perfect: false, score: 20, reason: 'WHY: melted table legs' }),
    reviewDesignConsistency: async () => ({ perfect: true, score: 100, reason: 'ok', slots: [{ slot: 'sofa', match: true }] }),
    QUALITY_MAX_ATTEMPTS: 1,
    logPromptToFile: () => {},
  });
  /** @type {import('../../lib/types/staging.js').StagingOutcome} */
  const outcome = {};
  await api.processStaging(
    await jpg(1200, 800),
    { roomType: 'Living room', designBible: bibleFixture() },
    null,
    [await jpg(1200, 800)],
    'gemini-2.5-flash-image',
    outcome,
  );
  assert.equal(record.verdicts[0].score, 20, 'the quality verdict is the worse one here');
  assert.match(record.verdicts[0].reason, /melted table legs/);
  assert.equal(outcome.qualityScore, 20);
  assert.equal(outcome.consistencyScore, 100, 'continuity did run and did pass');
  assert.deepEqual(outcome.mismatchedSlots, []);
});

test('processStaging: an unchecked frame records consistencyScore null, never a default 100', async () => {
  // "Unchecked" and "checked and clean" must stay distinguishable: the UI promises the
  // user that continuity was enforced, and a defaulted 100 would let it make that
  // promise about a frame nothing ever looked at.
  const record = { verdicts: [] };
  const modelPng = await png(640, 480);
  const api = createStagingGeneration({
    genAI: fakeGenAI(modelPng),
    DEBUG_MODE: false,
    runQualityRetry: recordingRetry(record),
    reviewImageQuality: perfectQuality,
    // No reviewDesignConsistency injected at all — the documented fallback.
    QUALITY_MAX_ATTEMPTS: 1,
    logPromptToFile: () => {},
  });
  /** @type {import('../../lib/types/staging.js').StagingOutcome} */
  const outcome = {};
  await api.processStaging(
    await jpg(1200, 800),
    { roomType: 'Living room', designBible: bibleFixture() },
    null,
    [await jpg(1200, 800)],
    'gemini-2.5-flash-image',
    outcome,
  );
  assert.equal(outcome.consistencyScore, null);
  assert.equal(outcome.qualityScore, 100);
  // The bible text is still applied — losing the reviewer must not also lose the
  // conditioning; it only means we cannot claim the result was verified.
  assert.equal(record.verdicts.length, 1);
});

test('processStaging: with a bible but no reference image, conditioning is text-only and continuity is skipped', async () => {
  const record = { verdicts: [] };
  const modelPng = await png(640, 480);
  const seen = [];
  let continuityCalls = 0;
  const api = createStagingGeneration({
    genAI: fakeGenAI(modelPng),
    DEBUG_MODE: false,
    runQualityRetry: recordingRetry(record),
    reviewImageQuality: perfectQuality,
    reviewDesignConsistency: async () => { continuityCalls += 1; return { perfect: true, score: 100, reason: '', slots: [] }; },
    QUALITY_MAX_ATTEMPTS: 1,
    logPromptToFile: (p) => { seen.push(p); },
  });
  /** @type {import('../../lib/types/staging.js').StagingOutcome} */
  const outcome = {};
  await api.processStaging(
    await jpg(1200, 800),
    { roomType: 'Living room', designBible: bibleFixture() },
    null,
    null, // no hero reference could be loaded
    'gemini-2.5-flash-image',
    outcome,
  );
  assert.match(seen[0], /MUST match exactly/, 'text conditioning still applied');
  assert.ok(!/image immediately after the room photo/.test(seen[0]));
  assert.equal(continuityCalls, 0, 'there is no reference frame to compare against');
  assert.equal(outcome.consistencyScore, null, 'so the frame is reported as unchecked');
});

test('processStaging: the outcome out-param carries the render audit trail', async () => {
  const record = { verdicts: [] };
  const modelPng = await png(640, 480);
  const api = createStagingGeneration({
    genAI: fakeGenAI(modelPng),
    DEBUG_MODE: false,
    runQualityRetry: recordingRetry(record),
    reviewImageQuality: perfectQuality,
    QUALITY_MAX_ATTEMPTS: 1,
    logPromptToFile: () => {},
  });
  /** @type {import('../../lib/types/staging.js').StagingOutcome} */
  const outcome = {};
  await api.processStaging(await jpg(1200, 800), { roomType: 'Kitchen' }, null, null, 'gemini-2.5-flash-image', outcome);
  assert.equal(outcome.model, 'gemini-2.5-flash-image');
  assert.equal(outcome.attempts, 1, 'attempts are counted without a req to meter on');
  assert.ok(typeof outcome.promptText === 'string' && outcome.promptText.length > 0);
  assert.ok(typeof outcome.durationMs === 'number');
});

test('processStaging: omitting the outcome out-param is safe (every existing caller)', async () => {
  const record = { verdicts: [] };
  const modelPng = await png(640, 480);
  const api = createStagingGeneration({
    genAI: fakeGenAI(modelPng),
    DEBUG_MODE: false,
    runQualityRetry: recordingRetry(record),
    reviewImageQuality: perfectQuality,
    QUALITY_MAX_ATTEMPTS: 1,
    logPromptToFile: () => {},
  });
  const out = await api.processStaging(await jpg(800, 600), { roomType: 'Office' }, null);
  assert.match(out, /^data:image\/webp;base64,/, 'still returns the delivered WebP data URL');
});

test('processStaging: a failed render records the error code on the outcome', async () => {
  const record = { verdicts: [] };
  const api = createStagingGeneration({
    genAI: null, // forces the "AI service not properly configured" throw
    DEBUG_MODE: false,
    runQualityRetry: recordingRetry(record),
    reviewImageQuality: perfectQuality,
    QUALITY_MAX_ATTEMPTS: 1,
    logPromptToFile: () => {},
  });
  /** @type {import('../../lib/types/staging.js').StagingOutcome} */
  const outcome = {};
  await assert.rejects(() => api.processStaging(Buffer.from('x'), { roomType: 'Bedroom' }, null, null, 'm', outcome));
  assert.ok(outcome.errorCode, 'the caller can persist why the render failed');
  assert.equal(typeof outcome.durationMs, 'number');
});

test('furnitureReferencePromptSuffix and styleReferencePromptSuffix are untouched', () => {
  // Regression guard for the integration edit: adding a third mode must not have
  // changed the two that shipped.
  assert.match(furnitureReferencePromptSuffix(1), /The second image provided after the room photo is reference furniture/);
  assert.match(furnitureReferencePromptSuffix(2), /The second and third images/);
  assert.equal(furnitureReferencePromptSuffix(0), '');
  assert.match(styleReferencePromptSuffix(1), /The second image is a STYLE REFERENCE/);
  assert.equal(styleReferencePromptSuffix(0), '');
});

// ── Multi-angle: the guarantee the whole feature is sold on ──────────────────
//
// One room, several camera positions, one look. Each of these is individually easy to get
// right and the combination is what actually ships, so they are asserted together:
//
//   * every support frame is conditioned on the SAME bible (a per-frame bible would mean
//     each angle re-derives its own furniture and the room drifts frame to frame);
//   * every support frame receives the hero RENDER, not the hero's source photo (the source
//     is the empty room — conditioning on it teaches the model nothing about the staging);
//   * every support frame keeps ITS OWN aspect ratio. This is the one that would be
//     invisible in a unit test and glaring in a listing: a portrait detail shot silently
//     adopting the hero's 3:2 would arrive letterboxed or cropped.

test('many angles of one room share one bible and one hero, each keeping its own framing', async () => {
  const bible = bibleFixture();
  const record = { verdicts: [] };
  const modelPng = await png(640, 480);

  /** @type {Array<{ text: string, parts: number, aspectRatio: string|undefined }>} */
  const calls = [];
  /** @type {string[]} */
  const heroSeenByReviewer = [];

  // A Gemini fake that records the aspect-ratio pin it was constructed with, per call.
  const recordingGenAI = {
    getGenerativeModel: (cfg) => ({
      generateContent: async (parts) => {
        calls.push({
          text: parts[0].text,
          parts: parts.length,
          aspectRatio: cfg?.generationConfig?.imageConfig?.aspectRatio,
        });
        return { response: { candidates: [{ content: { parts: [{ inlineData: { data: modelPng.toString('base64') } }] } }] } };
      },
    }),
  };

  const api = createStagingGeneration({
    genAI: recordingGenAI,
    DEBUG_MODE: false,
    runQualityRetry: recordingRetry(record),
    reviewImageQuality: perfectQuality,
    reviewDesignConsistency: async (heroUrl) => {
      heroSeenByReviewer.push(heroUrl ? 'hero' : 'none');
      return { perfect: true, score: 100, reason: 'ok', slots: [{ slot: 'sofa', match: true }], checked: true };
    },
    QUALITY_MAX_ATTEMPTS: 1,
    logPromptToFile: () => {},
  });

  // The hero render is 3:2 landscape. The support frames are deliberately different shapes:
  // a wide establishing shot, a portrait detail, and a near-square.
  const heroRender = await jpg(1500, 1000);
  const supports = [
    { label: 'wide',     buf: await jpg(1600, 900) },   // 16:9
    { label: 'portrait', buf: await jpg(900, 1600) },   // 9:16
    { label: 'square',   buf: await jpg(1200, 1200) },  // 1:1
  ];

  for (const support of supports) {
    await api.processStaging(
      support.buf,
      { roomType: 'Living room', furnitureStyle: 'midcentury', designBible: bible, frameRole: 'support' },
      null,
      [heroRender],
      'gemini-2.5-flash-image',
    );
  }

  assert.equal(calls.length, 3, 'one generation per angle');

  // 1. The SAME locked pieces reach every angle.
  for (const [i, call] of calls.entries()) {
    assert.match(call.text, /THIS ROOM IS ALREADY STAGED/, `${supports[i].label}: bible conditioning applied`);
    assert.match(call.text, /sofa: 3-seat low-profile sofa/, `${supports[i].label}: the sofa's identity is carried`);
    assert.match(call.text, /rug: flatweave wool rug/, `${supports[i].label}: and the rug's`);
  }
  const bodies = calls.map((c) => c.text.slice(c.text.indexOf('THIS ROOM IS ALREADY STAGED')));
  assert.equal(new Set(bodies).size, 1, 'every angle receives a byte-identical bible block');

  // 2. Every angle gets the hero image itself, in the reference slot.
  for (const [i, call] of calls.entries()) {
    assert.equal(call.parts, 3, `${supports[i].label}: room photo + hero reference`);
  }
  assert.deepEqual(heroSeenByReviewer, ['hero', 'hero', 'hero'],
    'and the continuity reviewer compares each angle against that same hero');

  // 3. Each angle keeps ITS OWN shape — the pin follows the SUPPORT frame, never the hero.
  const pins = calls.map((c) => c.aspectRatio);
  assert.equal(new Set(pins).size, 3, `three different shapes must pin three different ratios, got ${JSON.stringify(pins)}`);
  assert.ok(pins.every(Boolean), 'every angle is pinned to something');
  // The portrait frame must not have been handed a landscape ratio.
  const portraitPin = pins[1];
  const [pw, ph] = String(portraitPin).split(':').map(Number);
  assert.ok(pw < ph, `the portrait angle must stay portrait, got ${portraitPin}`);
});

test('a room with no bible yet does NOT get another room’s look', async () => {
  // The bible is stamped server-side from the caller's room context and never read from the
  // model, so two rooms cannot cross-contaminate. This pins the caller half: passing no
  // bible must produce no bible conditioning at all, rather than reusing whatever was last
  // seen — the failure that would make every room in a listing look like the first one.
  const record = { verdicts: [] };
  const modelPng = await png(640, 480);
  const seen = [];
  const api = createStagingGeneration({
    genAI: fakeGenAI(modelPng),
    DEBUG_MODE: false,
    runQualityRetry: recordingRetry(record),
    reviewImageQuality: perfectQuality,
    reviewDesignConsistency: async () => ({ perfect: true, score: 100, reason: '', slots: [], checked: true }),
    QUALITY_MAX_ATTEMPTS: 1,
    logPromptToFile: (promptText) => { seen.push(promptText); },
  });

  await api.processStaging(await jpg(1200, 800), { roomType: 'Living room', designBible: bibleFixture() },
    null, [await jpg(1200, 800)], 'gemini-2.5-flash-image');
  await api.processStaging(await jpg(1200, 800), { roomType: 'Kitchen' },
    null, null, 'gemini-2.5-flash-image');

  assert.match(seen[0], /THIS ROOM IS ALREADY STAGED/, 'the first room was conditioned');
  assert.ok(!/THIS ROOM IS ALREADY STAGED/.test(seen[1]),
    'the second room, with no bible, carries none of the first room’s look');
  assert.ok(!/oatmeal bouclé/.test(seen[1]), 'and none of its materials');
});
