// Tier: core pipeline — the quality-retry loop (lib/staging-pipeline.js).
//
// This is the heart of staging/mask generation: generate an image, score it, retry
// if it isn't good enough, and pick the best. Driven here with scripted generators
// and reviewers, so the retry/selection logic is verified with zero model calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWithQualityRetry, normalizeFurnitureBuffers } from '../../lib/staging/staging-pipeline.js';

// A generator that returns queued values per call. A value may be an Error (thrown)
// or null (a "no image produced" attempt). Records the attempt numbers it saw.
function scriptedGen(values) {
  const calls = [];
  const fn = async (attempt) => {
    calls.push(attempt);
    const v = values[calls.length - 1];
    if (v instanceof Error) throw v;
    return v;
  };
  fn.calls = calls;
  return fn;
}

// A reviewer that returns queued verdicts (last one repeats).
function scriptedReview(verdicts) {
  let i = 0;
  return async () => verdicts[Math.min(i++, verdicts.length - 1)];
}

test('returns the first perfect image and stops retrying', async () => {
  const gen = scriptedGen(['a', 'b', 'c']);
  const url = await generateWithQualityRetry(gen, {
    reviewFn: scriptedReview([{ perfect: false, score: 0.5 }, { perfect: true, score: 0.9 }]),
    maxAttempts: 3,
  });
  assert.equal(url, 'b');
  assert.equal(gen.calls.length, 2, 'stops as soon as a perfect image is produced');
});

test('returns the best-scored image when none are perfect', async () => {
  const gen = scriptedGen(['a', 'b', 'c']);
  const url = await generateWithQualityRetry(gen, {
    reviewFn: scriptedReview([
      { perfect: false, score: 0.3 },
      { perfect: false, score: 0.8 },
      { perfect: false, score: 0.5 },
    ]),
    maxAttempts: 3,
  });
  assert.equal(url, 'b', 'the highest score (0.8) wins');
  assert.equal(gen.calls.length, 3, 'uses every allowed attempt');
});

test('fires onImageProduced once per image actually produced', async () => {
  const produced = [];
  await generateWithQualityRetry(scriptedGen(['a', 'b']), {
    reviewFn: scriptedReview([{ perfect: false, score: 0.1 }, { perfect: true, score: 1 }]),
    maxAttempts: 3,
    onImageProduced: (attempt) => produced.push(attempt),
  });
  assert.deepEqual(produced, [1, 2]);
});

test('retries past a generation error and still succeeds', async () => {
  const url = await generateWithQualityRetry(scriptedGen([new Error('gen failed'), 'b']), {
    reviewFn: scriptedReview([{ perfect: true, score: 1 }]),
    maxAttempts: 3,
  });
  assert.equal(url, 'b');
});

test('skips a null result without reviewing it', async () => {
  let reviews = 0;
  const url = await generateWithQualityRetry(scriptedGen([null, 'b']), {
    reviewFn: async () => { reviews += 1; return { perfect: true, score: 1 }; },
    maxAttempts: 3,
  });
  assert.equal(url, 'b');
  assert.equal(reviews, 1, 'the null attempt is not scored');
});

// ── Degraded (unreviewed) verdicts ───────────────────────────────────────────
// The reviewer fails OPEN so an outage in the QA model never becomes a user-facing
// outage. That is correct, but it used to be INDISTINGUISHABLE from a genuine pass:
// a broken reviewer returned {perfect:true, score:100} and the render log recorded a
// flawless run. `degraded` makes the difference observable.

test('a degraded verdict accepts the image but reports it through onReviewDegraded', async () => {
  const seen = [];
  const gen = scriptedGen(['a', 'b', 'c']);
  const url = await generateWithQualityRetry(gen, {
    reviewFn: scriptedReview([{ perfect: true, score: 100, reason: 'reviewer error', degraded: true }]),
    maxAttempts: 3,
    onReviewDegraded: (attempt, review) => seen.push({ attempt, reason: review.reason }),
  });
  assert.equal(url, 'a', 'the image is still delivered — failing closed would be worse');
  assert.deepEqual(seen, [{ attempt: 1, reason: 'reviewer error' }]);
});

test('a degraded verdict does NOT burn extra attempts against a broken reviewer', async () => {
  const gen = scriptedGen(['a', 'b', 'c']);
  await generateWithQualityRetry(gen, {
    reviewFn: scriptedReview([{ perfect: true, score: 100, degraded: true }]),
    maxAttempts: 3,
  });
  assert.equal(gen.calls.length, 1, 're-rolling cannot improve a review that never happened');
});

test('a genuine perfect verdict never fires onReviewDegraded', async () => {
  let fired = 0;
  await generateWithQualityRetry(scriptedGen(['a']), {
    reviewFn: scriptedReview([{ perfect: true, score: 100 }]),
    maxAttempts: 3,
    onReviewDegraded: () => { fired += 1; },
  });
  assert.equal(fired, 0);
});

test('onReviewDegraded is optional — a degraded verdict without one still returns', async () => {
  const url = await generateWithQualityRetry(scriptedGen(['a']), {
    reviewFn: scriptedReview([{ perfect: true, score: 100, degraded: true }]),
    maxAttempts: 2,
  });
  assert.equal(url, 'a');
});

test('rethrows the last generation error when nothing is ever produced', async () => {
  await assert.rejects(
    generateWithQualityRetry(scriptedGen([new Error('first'), new Error('second')]), {
      reviewFn: async () => ({ perfect: false, score: 0 }),
      maxAttempts: 2,
    }),
    /second/,
  );
});

test('validates its required options', async () => {
  await assert.rejects(
    generateWithQualityRetry(async () => 'a', { maxAttempts: 2 }),
    /reviewFn is required/,
  );
  await assert.rejects(
    generateWithQualityRetry(async () => 'a', { reviewFn: async () => ({ perfect: true, score: 1 }), maxAttempts: 0 }),
    /maxAttempts/,
  );
});

// --- normalizeFurnitureBuffers: coerce the furniture-image input into ≤5 Buffers ---

test('normalizeFurnitureBuffers returns [] for null/undefined/empty input', () => {
  assert.deepEqual(normalizeFurnitureBuffers(null), []);
  assert.deepEqual(normalizeFurnitureBuffers(undefined), []);
  assert.deepEqual(normalizeFurnitureBuffers([]), []);
});

test('normalizeFurnitureBuffers wraps a single Buffer into a one-element array', () => {
  const b = Buffer.from('one');
  assert.deepEqual(normalizeFurnitureBuffers(b), [b]);
});

test('normalizeFurnitureBuffers keeps only real Buffers from a mixed array', () => {
  const b1 = Buffer.from('a');
  const b2 = Buffer.from('b');
  assert.deepEqual(normalizeFurnitureBuffers([b1, null, 'not-a-buffer', b2, undefined]), [b1, b2]);
});

test('normalizeFurnitureBuffers caps the list at 5 buffers', () => {
  const buffers = Array.from({ length: 8 }, (_, i) => Buffer.from(String(i)));
  const out = normalizeFurnitureBuffers(buffers);
  assert.equal(out.length, 5, 'never more than 5 references');
  assert.deepEqual(out, buffers.slice(0, 5), 'keeps the first 5 in order');
});
