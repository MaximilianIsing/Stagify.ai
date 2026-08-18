// Tier: frontend island logic (no DOM) — public/scripts/admin/stats.js.
//
// WHY THIS EXISTS. These primitives decide whether the Signals tab says anything
// at all. Every one of their failure modes is silent and produces a
// confident-looking wrong answer rather than a crash:
//
//   - a lexicographic sort turns [10, 9, 100] into [10, 100, 9] and every
//     median/percentile downstream is wrong by a lot,
//   - a MAD of zero (which is the NORMAL case for a mostly-zero daily failure
//     series) makes every non-zero day an infinite z-score, i.e. a permanent
//     fake "critical",
//   - the normal approximation to a binomial interval reports 3-of-8 as a solid
//     37.5% and cheerfully returns bounds below zero.
//
// So the assertions below are against textbook values and against the specific
// degenerate inputs the real data is made of, not against whatever the
// implementation happens to return.
//
// The other half of the file is the null contract: `null` means "not computable
// from this sample" and must never be a dressed-up zero. A rule that treats a
// null as 0 would report a 0% failure rate for a segment nobody has used, so
// these are asserted with `strictEqual(..., null)` throughout.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Z_95, mean, median, medianAbsoluteDeviation, robustZ, wilsonInterval,
  linearTrend, changePoint, projectToPeriodEnd, ratio, foldChange,
} from '../../../public/scripts/admin/stats.js';

/** Assert two floats agree to `tol`, reporting both when they don't. */
function close(actual, expected, tol = 1e-6, msg = '') {
  assert.ok(
    typeof actual === 'number' && Math.abs(actual - expected) <= tol,
    `${msg || 'value'}: expected ~${expected}, got ${actual}`,
  );
}

// ── mean / median ───────────────────────────────────────────────────────────

test('mean: averages finite values, ignores junk, null on an empty sample', () => {
  close(/** @type {number} */ (mean([1, 2, 3, 4])), 2.5);
  // Junk is dropped rather than poisoning the result with NaN.
  close(/** @type {number} */ (mean([1, 2, NaN, /** @type {any} */ ('x'), null, 3])), 2);
  assert.strictEqual(mean([]), null);
  assert.strictEqual(mean(/** @type {any} */ (null)), null);
  assert.strictEqual(mean([NaN, Infinity]), null);
});

test('median: sorts NUMERICALLY, not lexicographically', () => {
  // The regression this pins: [10, 9, 100].sort() is [10, 100, 9], whose middle
  // value is 100. Every duration percentile in the dashboard has this shape.
  assert.equal(median([10, 9, 100]), 10);
  assert.equal(median([100, 9, 10]), 10);
  assert.equal(median([2, 1, 3]), 2);
});

test('median: averages the two middle values on an even sample', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.strictEqual(median([]), null);
});

// ── MAD / robust z ──────────────────────────────────────────────────────────

test('medianAbsoluteDeviation: computes the textbook value', () => {
  // [1,2,3,4,100] → median 3 → |deviations| [2,1,0,1,97] → median 1.
  const spread = medianAbsoluteDeviation([1, 2, 3, 4, 100]);
  assert.ok(spread);
  assert.equal(spread.median, 3);
  assert.equal(spread.mad, 1);
  close(spread.scale, 1.4826, 1e-9);
  assert.strictEqual(medianAbsoluteDeviation([]), null);
});

test('robustZ: an outlier stays an outlier — which a standard deviation would hide', () => {
  // This is the entire argument for using a MAD baseline. The sample's own
  // standard deviation is ~43, so a classical z for 100 is only ~2.25 and would
  // sit UNDER a |z| >= 3 alert threshold: the spike inflates the very baseline
  // it is measured against. The median does not move, so the robust z is huge.
  const sample = [1, 2, 3, 4, 100];
  const classicalMean = 22;
  const classicalSd = Math.sqrt(sample.reduce((a, v) => a + (v - classicalMean) ** 2, 0) / (sample.length - 1));
  assert.ok((100 - classicalMean) / classicalSd < 3, 'precondition: a classical z would NOT fire');

  const z = robustZ(100, sample);
  assert.ok(z !== null && z > 50, `expected a large robust z, got ${z}`);
});

test('robustZ: a mostly-zero series still scores its spike (the MAD-is-zero fallback)', () => {
  // A daily-failure series is mostly zeros, so more than half the values are
  // identical and the MAD is exactly 0. Without the mean-absolute-deviation
  // fallback this is a division by zero and every quiet day makes the next
  // failure an infinite z — a permanent fake critical.
  const z = robustZ(50, [0, 0, 0, 0, 0, 0, 50]);
  assert.ok(z !== null, 'a zero MAD must not defeat the scoring');
  assert.ok(Number.isFinite(z), `expected a finite z, got ${z}`);
  close(/** @type {number} */ (z), 7, 1e-9); // 50 / (50/7)
});

test('robustZ: no spread at all is null, never Infinity and never 0', () => {
  // Every value identical: there is no scale to measure against, so any answer
  // would be invented. Callers must render this as "not enough variation yet".
  assert.strictEqual(robustZ(9, [5, 5, 5, 5]), null);
  assert.strictEqual(robustZ(5, [5, 5, 5, 5]), null);
  assert.strictEqual(robustZ(1, []), null);
  assert.strictEqual(robustZ(NaN, [1, 2, 3]), null);
});

test('robustZ: sign carries the direction of the excursion', () => {
  const up = robustZ(20, [10, 10, 11, 9, 10, 10, 11]);
  const down = robustZ(0, [10, 10, 11, 9, 10, 10, 11]);
  assert.ok(up !== null && up > 0, 'above the median must be positive');
  assert.ok(down !== null && down < 0, 'below the median must be negative');
});

// ── Wilson interval ─────────────────────────────────────────────────────────

test('wilsonInterval: matches the published values for 3 of 8', () => {
  const ci = wilsonInterval(3, 8);
  assert.ok(ci);
  close(ci.point, 0.375, 1e-12);
  close(ci.lower, 0.1367, 1e-3, 'lower');
  close(ci.upper, 0.6942, 1e-3, 'upper');
});

test('wilsonInterval: more data means a tighter interval', () => {
  const small = wilsonInterval(1, 8);
  const large = wilsonInterval(40, 1000);
  assert.ok(small && large);
  close(large.lower, 0.0295, 1e-3, 'large lower');
  close(large.upper, 0.0541, 1e-3, 'large upper');
  assert.ok((large.upper - large.lower) < (small.upper - small.lower) / 10, 'more data must mean a tighter interval');
});

test('wilsonInterval: a mild excursion on a tiny sample does not clear the global rate', () => {
  // 1-of-8 is an observed 12.5% against a 4% global rate — 3x — and the interval
  // still spans 2%-47%, so it CONTAINS 4% and the segment rule must stay silent.
  const ci = wilsonInterval(1, 8);
  assert.ok(ci);
  assert.ok(ci.lower < 0.04 && ci.upper > 0.04, `expected the interval to contain 4%, got ${ci.lower}-${ci.upper}`);
});

test('wilsonInterval: does NOT by itself suppress a small sample — hence minSample', () => {
  // The correction that shapes the segment rule. It is tempting to treat "the
  // interval excludes the global rate" as a complete small-sample guard and drop
  // the explicit n floor as redundant. It is not redundant: 3-of-8 is an observed
  // 37.5% against a 4% baseline, and its interval — wide as it is — still starts
  // at ~13.7%, well clear of 4%. On its own the interval would happily report a
  // CRITICAL segment failure built on eight renders.
  //
  // So findings-reliability.js#segmentFailureOutlier gates on BOTH: n >= its
  // minSample AND an interval that excludes the global rate. Deleting either one
  // reopens a different false positive.
  const ci = wilsonInterval(3, 8);
  assert.ok(ci);
  assert.ok(ci.lower > 0.04, `precondition for the minSample floor: ${ci.lower} should exclude 4%`);
});

test('wilsonInterval: bounds stay inside [0,1] at the extremes', () => {
  // The normal approximation returns a NEGATIVE lower bound here. Wilson does not.
  const none = wilsonInterval(0, 30);
  const all = wilsonInterval(30, 30);
  assert.ok(none && all);
  assert.ok(none.lower >= 0, `lower bound went negative: ${none && none.lower}`);
  assert.ok(none.upper > 0 && none.upper < 1, 'zero observed failures still leaves an upper bound above 0');
  assert.ok(all.upper <= 1, `upper bound exceeded 1: ${all && all.upper}`);
  assert.ok(all.lower < 1, 'an all-failure sample still leaves a lower bound below 1');
});

test('wilsonInterval: refuses impossible inputs rather than returning a shape', () => {
  assert.strictEqual(wilsonInterval(1, 0), null, 'no sample');
  assert.strictEqual(wilsonInterval(5, 3), null, 'more successes than trials');
  assert.strictEqual(wilsonInterval(-1, 10), null, 'negative successes');
  assert.strictEqual(wilsonInterval(1, /** @type {any} */ ('x')), null);
});

test('wilsonInterval: a wider z widens the interval', () => {
  const at95 = wilsonInterval(20, 200, Z_95);
  const at99 = wilsonInterval(20, 200, 2.5758);
  assert.ok(at95 && at99);
  assert.ok(at99.lower < at95.lower && at99.upper > at95.upper);
});

// ── linearTrend ─────────────────────────────────────────────────────────────

test('linearTrend: recovers an exact line', () => {
  const fit = linearTrend([0, 1, 2, 3, 4]);
  assert.ok(fit);
  close(fit.slope, 1);
  close(fit.intercept, 0);
  close(fit.r2, 1);
  assert.equal(fit.n, 5);
});

test('linearTrend: a flat series is slope 0 and a PERFECT fit, not a failed one', () => {
  // ssTot is 0 here, so the naive 1 - ssRes/ssTot is 0/0. Reporting r2 = 0 would
  // read as "no relationship" when the line describes the data exactly, and a
  // rule gating on r2 would then refuse to call a flat trend flat.
  const fit = linearTrend([5, 5, 5, 5]);
  assert.ok(fit);
  close(fit.slope, 0);
  close(fit.r2, 1);
});

test('linearTrend: scatter gets a low r2 so a rule can decline to call it a trend', () => {
  const noisy = linearTrend([5, 1, 6, 0, 7, 1, 5, 0]);
  assert.ok(noisy);
  assert.ok(noisy.r2 < 0.3, `expected a poor fit, got r2=${noisy.r2}`);
});

test('linearTrend: needs two points', () => {
  assert.strictEqual(linearTrend([7]), null);
  assert.strictEqual(linearTrend([]), null);
  assert.strictEqual(linearTrend(/** @type {any} */ (null)), null);
});

test('linearTrend: slope is per bucket, so a caller can state it as "per day"', () => {
  const fit = linearTrend([10, 13, 16, 19]);
  assert.ok(fit);
  close(fit.slope, 3);
});

// ── changePoint ─────────────────────────────────────────────────────────────

test('changePoint: finds a step, and reports both levels', () => {
  const step = changePoint([1, 1, 2, 1, 1, 10, 11, 10, 12, 10], 3);
  assert.ok(step);
  assert.equal(step.index, 5, 'the split must be the first index of the NEW level');
  close(step.before, 1.2, 1e-9);
  close(step.after, 10.6, 1e-9);
  close(step.delta, 9.4, 1e-9);
  assert.ok(step.score > 10, `a clean step should score high, got ${step.score}`);
});

test('changePoint: noise without a step scores far lower than a real step', () => {
  // Asserted as a comparison rather than against an absolute number: the useful
  // property is that the rule's threshold can separate the two, not that noise
  // happens to score below some constant.
  const noise = changePoint([5, 6, 5, 6, 5, 6, 5, 6, 5, 6], 3);
  const step = changePoint([1, 1, 2, 1, 1, 10, 11, 10, 12, 10], 3);
  assert.ok(step);
  if (noise) assert.ok(noise.score < step.score / 5, `noise scored ${noise.score} vs step ${step.score}`);
});

test('changePoint: refuses a series too short to have two real segments', () => {
  assert.strictEqual(changePoint([1, 2, 3, 4, 5], 3), null, 'needs minSegment on BOTH sides');
  assert.strictEqual(changePoint([], 3), null);
  // A one-point segment could always be fitted to an endpoint, so the floor is 2
  // even when the caller asks for less.
  assert.strictEqual(changePoint([1, 9], 1), null);
});

test('changePoint: two flat constants are skipped rather than scored as infinite', () => {
  // Both sides have zero variance, so the standard error is 0. A step between
  // two constants is real, but it cannot be RANKED against other candidates
  // without a scale, and returning Infinity would make it beat every genuine
  // finding forever.
  const flat = changePoint([2, 2, 2, 2, 8, 8, 8, 8], 3);
  if (flat) assert.ok(Number.isFinite(flat.score), `score must stay finite, got ${flat.score}`);
});

// ── projectToPeriodEnd ──────────────────────────────────────────────────────

test('projectToPeriodEnd: extrapolates at the average pace by default', () => {
  const p = projectToPeriodEnd({ soFar: 100, elapsedUnits: 10, totalUnits: 30 });
  assert.ok(p);
  close(p.rate, 10);
  close(p.projected, 300);
  assert.equal(p.remainingUnits, 20);
});

test('projectToPeriodEnd: a supplied recent rate overrides the period average', () => {
  // The reason the parameter exists: a month that was quiet for ten days and has
  // doubled for the last four must not be projected at the fourteen-day mean.
  const p = projectToPeriodEnd({ soFar: 100, elapsedUnits: 10, totalUnits: 30, recentRate: 20 });
  assert.ok(p);
  close(p.projected, 500);
  close(p.rate, 20);
});

test('projectToPeriodEnd: a zero recent rate is honoured, not treated as absent', () => {
  // `0` is falsy, so a `||` fallback would silently swap in the period average
  // and project growth for something that has completely stopped.
  const p = projectToPeriodEnd({ soFar: 100, elapsedUnits: 10, totalUnits: 30, recentRate: 0 });
  assert.ok(p);
  close(p.projected, 100, 1e-9, 'a stalled series must project flat');
});

test('projectToPeriodEnd: null for a period that has not started or is over', () => {
  assert.strictEqual(projectToPeriodEnd({ soFar: 5, elapsedUnits: 0, totalUnits: 30 }), null);
  assert.strictEqual(projectToPeriodEnd({ soFar: 5, elapsedUnits: 31, totalUnits: 30 }), null);
  assert.strictEqual(projectToPeriodEnd({ soFar: -1, elapsedUnits: 5, totalUnits: 30 }), null);
});

// ── ratio / foldChange ──────────────────────────────────────────────────────

test('ratio: a missing denominator is null, never 0 and never Infinity', () => {
  // "no renders yet" and "a 0% failure rate" are different facts. Collapsing the
  // first into the second is how a dashboard reports a clean bill of health for
  // a segment nobody has used.
  close(/** @type {number} */ (ratio(1, 4)), 0.25);
  assert.strictEqual(ratio(1, 0), null);
  assert.strictEqual(ratio(0, 0), null);
  assert.strictEqual(ratio(1, /** @type {any} */ (undefined)), null);
});

test('foldChange: null against a zero baseline', () => {
  // Everything is infinitely more than nothing, and "Infinityx worse than average" is
  // not a sentence an operator can act on.
  close(/** @type {number} */ (foldChange(18.1, 4.4)), 4.113636, 1e-6);
  assert.strictEqual(foldChange(5, 0), null);
  assert.strictEqual(foldChange(5, -1), null);
  assert.strictEqual(foldChange(NaN, 4), null);
});
