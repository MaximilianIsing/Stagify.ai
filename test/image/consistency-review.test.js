// reviewDesignConsistency (lib/image/image-review.js) — the design-continuity judge
// for multi-photo listing staging.
//
// It differs from its two siblings in three ways that all need pinning:
//   * it has a PER-SLOT verdict, because the retry it feeds must name what drifted;
//   * it sends only CRITICAL pieces, so a wandering plant can't burn a regeneration;
//   * when the summary line and the per-slot lines disagree, the SLOT lines win.
// Like every reviewer here it fails OPEN — but "no verdict" is not "consistent", and
// the null-vs-100 distinction that keeps those apart is asserted in
// test/staging/design-bible-conditioning.test.js where the score is persisted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createImageReview } from '../../lib/image/image-review.js';
import { CONSISTENCY_REVIEW_PROMPT } from '../../lib/staging/prompts-continuity.js';

const dataUrl = async (r, g, b) =>
  'data:image/png;base64,' +
  (await sharp({ create: { width: 240, height: 180, channels: 3, background: { r, g, b } } }).png().toBuffer()).toString('base64');

const HERO = () => dataUrl(200, 190, 170);
const CAND = () => dataUrl(180, 175, 160);

/** Fake grader. Records the parts it was handed so the prompt payload can be asserted. */
function fakeGrader(content, sink) {
  return {
    getGenerativeModel(cfg) {
      if (sink) sink.configs.push(cfg);
      return {
        generateContent: async (parts) => {
          if (sink) sink.parts.push(parts);
          if (content instanceof Error) throw content;
          return { response: { text: () => content } };
        },
      };
    },
  };
}

function bible(pieces, extra = {}) {
  return {
    version: 1,
    roomKey: 'living-room-1',
    roomType: 'Living room',
    furnitureStyle: 'midcentury',
    palette: {},
    lighting: {},
    negatives: [],
    pieces,
    ...extra,
  };
}

const SOFA = { slot: 'sofa', identity: '3-seat bouclé sofa, walnut legs', placement: 'long wall', critical: true };
const RUG = { slot: 'rug', identity: 'cream flatweave, terracotta grid', placement: 'under table', critical: true };
const PLANT = { slot: 'plant', identity: 'fiddle leaf fig', placement: 'corner', critical: false };

// ── Fail-open contracts ─────────────────────────────────────────────────────

test('no client → approves, but flags the verdict as UNCHECKED', async () => {
  const { reviewDesignConsistency } = createImageReview({ genAI: null });
  const r = await reviewDesignConsistency(await HERO(), await CAND(), bible([SOFA]));
  assert.deepEqual(r, { perfect: true, score: 100, reason: 'reviewer disabled', slots: [], checked: false });
});

test('EVERY fail-open exit is marked checked:false, and every real verdict checked:true', async () => {
  // This flag is the whole difference between "we compared the frames and they match" and
  // "nobody looked". The sentinel score is 100 either way, so without it the caller
  // persisted a confident 100 for a frame no reviewer ever saw — which the UI then showed
  // as "Consistency 100.00". Asserted exhaustively because a new early-return that forgets
  // the flag would silently reintroduce exactly that.
  const openExits = [
    ['no client', createImageReview({ genAI: null }), bible([SOFA])],
    ['no critical pieces', createImageReview({ genAI: fakeGrader('PERFECT: true') }), bible([PLANT])],
    ['thrown model error', createImageReview({ genAI: fakeGrader(new Error('503')) }), bible([SOFA])],
  ];
  for (const [label, api, b] of openExits) {
    const r = await api.reviewDesignConsistency(await HERO(), await CAND(), b);
    assert.equal(r.perfect, true, `${label}: still accepts the image`);
    assert.equal(r.checked, false, `${label}: must NOT be reported as checked`);
  }

  const real = createImageReview({ genAI: fakeGrader('SLOT: sofa = match\nPERFECT: true') });
  const pass = await real.reviewDesignConsistency(await HERO(), await CAND(), bible([SOFA]));
  assert.equal(pass.checked, true, 'a genuine passing verdict is checked');

  const fail = createImageReview({ genAI: fakeGrader('SLOT: sofa = mismatch\nPERFECT: false\nSCORE: 30') });
  const nope = await fail.reviewDesignConsistency(await HERO(), await CAND(), bible([SOFA]));
  assert.equal(nope.checked, true, 'a genuine failing verdict is also checked');
});

test('a thrown model error approves the image rather than stranding the job', async () => {
  const { reviewDesignConsistency } = createImageReview({ genAI: fakeGrader(new Error('503 upstream')) });
  const r = await reviewDesignConsistency(await HERO(), await CAND(), bible([SOFA]));
  assert.equal(r.perfect, true);
  assert.equal(r.score, 100);
  assert.equal(r.reason, 'reviewer error');
  assert.deepEqual(r.slots, []);
});

test('a bible with no critical pieces is passed through with no verdict', async () => {
  // Nothing to check is not the same as nothing wrong — but there is no verdict to give
  // either, so it must not fabricate one, and it must not spend a model call.
  const sink = { parts: [], configs: [] };
  const { reviewDesignConsistency } = createImageReview({ genAI: fakeGrader('PERFECT: true', sink) });
  const r = await reviewDesignConsistency(await HERO(), await CAND(), bible([PLANT]));
  assert.equal(r.perfect, true);
  assert.equal(r.reason, 'no critical pieces');
  assert.equal(sink.parts.length, 0, 'no paid call for a bible with nothing to enforce');
});

test('a null or piece-less bible is passed through without a model call', async () => {
  const sink = { parts: [], configs: [] };
  const { reviewDesignConsistency } = createImageReview({ genAI: fakeGrader('PERFECT: true', sink) });
  for (const b of [null, undefined, bible([]), /** @type {any} */ ({ pieces: 'sofa' })]) {
    const r = await reviewDesignConsistency(await HERO(), await CAND(), b);
    assert.equal(r.perfect, true, 'malformed bible input must not throw');
  }
  assert.equal(sink.parts.length, 0);
});

// ── The payload it sends ────────────────────────────────────────────────────

test('sends both frames, the consistency prompt, and ONLY the critical pieces', async () => {
  const sink = { parts: [], configs: [] };
  const { reviewDesignConsistency } = createImageReview({ genAI: fakeGrader('PERFECT: true', sink) });
  await reviewDesignConsistency(await HERO(), await CAND(), bible([SOFA, RUG, PLANT]));

  assert.equal(sink.parts.length, 1);
  const parts = sink.parts[0];
  const text = parts[0].text;
  assert.ok(text.startsWith(CONSISTENCY_REVIEW_PROMPT), 'uses the shared prompt constant');
  assert.match(text, /sofa: 3-seat bouclé sofa/);
  assert.match(text, /rug: cream flatweave/);
  assert.ok(!/fiddle leaf fig/.test(text),
    'a non-critical piece is never sent — its drift is not worth a paid regeneration');
  assert.match(text, /WHY:/, 'the WHY line is requested so the retry can target the named slot');

  // Hero first, candidate second — the prompt refers to them as image 1 and image 2, so
  // the order is load-bearing rather than incidental.
  assert.equal(parts.length, 3);
  assert.ok(parts[1].inlineData, 'image 1 is the hero frame');
  assert.ok(parts[2].inlineData, 'image 2 is the candidate frame');
  assert.notEqual(parts[1].inlineData.data, parts[2].inlineData.data, 'two distinct frames were sent');
});

test('runs the grader deterministically with thinking disabled', async () => {
  // Same reasoning as every other glance-judgment in this file: with thinking ON the
  // output-token budget can be spent reasoning and starve the visible verdict.
  const sink = { parts: [], configs: [] };
  const { reviewDesignConsistency } = createImageReview({ genAI: fakeGrader('PERFECT: true', sink) });
  await reviewDesignConsistency(await HERO(), await CAND(), bible([SOFA]));
  const cfg = sink.configs[0].generationConfig;
  assert.equal(cfg.temperature, 0);
  assert.equal(cfg.thinkingConfig.thinkingBudget, 0);
  assert.ok(cfg.maxOutputTokens >= 120, 'a one-piece bible still has room for PERFECT+SCORE+WHY');
});

test('the token budget grows with the number of pieces to report on', async () => {
  const sink = { parts: [], configs: [] };
  const { reviewDesignConsistency } = createImageReview({ genAI: fakeGrader('PERFECT: true', sink) });
  await reviewDesignConsistency(await HERO(), await CAND(), bible([SOFA]));
  const many = Array.from({ length: 10 }, (_, i) => ({ ...SOFA, slot: `piece-${i}` }));
  await reviewDesignConsistency(await HERO(), await CAND(), bible(many));
  assert.ok(
    sink.configs[1].generationConfig.maxOutputTokens > sink.configs[0].generationConfig.maxOutputTokens,
    'a 10-piece bible must not truncate mid-verdict',
  );
});

// ── Verdict parsing ─────────────────────────────────────────────────────────

test('a clean verdict: perfect, score 100, per-slot matches parsed', async () => {
  const reply = 'SLOT: sofa = match\nSLOT: rug = match\nPERFECT: true';
  const { reviewDesignConsistency } = createImageReview({ genAI: fakeGrader(reply) });
  const r = await reviewDesignConsistency(await HERO(), await CAND(), bible([SOFA, RUG]));
  assert.equal(r.perfect, true);
  assert.equal(r.score, 100);
  assert.deepEqual(r.slots, [{ slot: 'sofa', match: true }, { slot: 'rug', match: true }]);
});

test('a mismatch: not perfect, the score parsed, and the drifting slot named', async () => {
  const reply = 'SLOT: sofa = mismatch\nSLOT: rug = match\nPERFECT: false\nSCORE: 40\nWHY: the sofa is tufted with chrome legs';
  const { reviewDesignConsistency } = createImageReview({ genAI: fakeGrader(reply) });
  const r = await reviewDesignConsistency(await HERO(), await CAND(), bible([SOFA, RUG]));
  assert.equal(r.perfect, false);
  assert.equal(r.score, 40);
  assert.deepEqual(r.slots.filter((s) => !s.match).map((s) => s.slot), ['sofa']);
  assert.match(r.reason, /WHY: the sofa is tufted/);
});

test('omitted slot lines are fine — an out-of-frame piece is simply not judged', async () => {
  // The single biggest false-positive risk: a support frame SHOULD omit pieces the
  // camera cannot see, so a missing SLOT line must never read as a mismatch.
  const reply = 'SLOT: sofa = match\nPERFECT: true';
  const { reviewDesignConsistency } = createImageReview({ genAI: fakeGrader(reply) });
  const r = await reviewDesignConsistency(await HERO(), await CAND(), bible([SOFA, RUG]));
  assert.equal(r.perfect, true, 'the un-reported rug is out of frame, not wrong');
  assert.equal(r.slots.length, 1);
});

test('the SLOT lines outrank a contradicting PERFECT: true summary', async () => {
  // "PERFECT: true" is one token the model can fumble; "SLOT: sofa = mismatch" is a
  // specific claim it had to construct. Trusting the summary here would ship the wrong
  // sofa, which is exactly the failure this reviewer exists to catch.
  const reply = 'SLOT: sofa = mismatch\nSLOT: rug = match\nPERFECT: true';
  const { reviewDesignConsistency } = createImageReview({ genAI: fakeGrader(reply) });
  const r = await reviewDesignConsistency(await HERO(), await CAND(), bible([SOFA, RUG]));
  assert.equal(r.perfect, false, 'a named mismatch wins over an optimistic summary');
  // No SCORE line was given (the model thought it was passing), so rather than ranking
  // this attempt at 0 and discarding a mostly-good frame, the score is derived from the
  // slot tally: 1 of 2 matched.
  assert.equal(r.score, 50);
});

test('a not-perfect verdict with no SCORE line ranks at 0 for the retry loop', async () => {
  const { reviewDesignConsistency } = createImageReview({ genAI: fakeGrader('SLOT: sofa = mismatch\nPERFECT: false') });
  const r = await reviewDesignConsistency(await HERO(), await CAND(), bible([SOFA]));
  assert.equal(r.perfect, false);
  assert.equal(r.score, 0);
});

test('the score is clamped to 0-100', async () => {
  const { reviewDesignConsistency } = createImageReview({ genAI: fakeGrader('PERFECT: false\nSCORE: 940') });
  const hi = await reviewDesignConsistency(await HERO(), await CAND(), bible([SOFA]));
  assert.equal(hi.score, 100);
});

test('an unreadable reply approves rather than blocking (fail open)', async () => {
  const { reviewDesignConsistency } = createImageReview({ genAI: fakeGrader('I am unable to compare these images.') });
  const r = await reviewDesignConsistency(await HERO(), await CAND(), bible([SOFA]));
  // No PERFECT: true, no slot lines → not perfect, score 0. The retry loop then keeps the
  // best-scored attempt, so a garbled grader costs attempts but never loses the render.
  assert.equal(r.perfect, false);
  assert.equal(r.score, 0);
  assert.deepEqual(r.slots, []);
});

test('slot names are case-insensitive on the wire and normalized on the way out', async () => {
  const reply = 'Slot: Coffee-Table = MISMATCH\nSLOT: SOFA = Match\nPERFECT: false\nSCORE: 60';
  const { reviewDesignConsistency } = createImageReview({ genAI: fakeGrader(reply) });
  const r = await reviewDesignConsistency(await HERO(), await CAND(), bible([SOFA, { ...RUG, slot: 'coffee-table' }]));
  assert.deepEqual(r.slots, [{ slot: 'coffee-table', match: false }, { slot: 'sofa', match: true }]);
});

test('a prose-heavy reply still yields its slot lines', async () => {
  const reply = [
    'Looking at both images carefully:',
    'SLOT: sofa = match',
    'The rug is not visible in image 2 so I cannot judge it.',
    'PERFECT: true',
  ].join('\n');
  const { reviewDesignConsistency } = createImageReview({ genAI: fakeGrader(reply) });
  const r = await reviewDesignConsistency(await HERO(), await CAND(), bible([SOFA, RUG]));
  assert.equal(r.perfect, true);
  assert.deepEqual(r.slots, [{ slot: 'sofa', match: true }]);
});

test('the other three reviewers are unchanged by this addition', async () => {
  // Regression guard for the shared-file edit.
  const api = createImageReview({ genAI: null });
  assert.equal(typeof api.reviewImageQuality, 'function');
  assert.equal(typeof api.reviewMaskEdit, 'function');
  assert.equal(typeof api.validateStageableImage, 'function');
  assert.equal(typeof api.reviewDesignConsistency, 'function');
  assert.deepEqual(await api.validateStageableImage(Buffer.from('x')), { valid: true, code: null, reason: '' });
});
