// Statistical primitives for the Signals tab. Pure arithmetic over number
// arrays — no DOM, no CSV knowledge, no domain knowledge at all. The rule files
// (findings-*.js) supply the meaning; this file only supplies the maths, which
// is why it can be unit-tested against textbook values in
// test/frontend/admin/admin-stats.test.js.
//
// Every export here exists to answer one question the dashboard's charts cannot:
// **is this difference real, or is it noise?** A chart can show that kitchens
// fail more often than bedrooms; only an interval can say whether 3 failures out
// of 8 is evidence of anything. So the bias throughout is toward returning
// `null` rather than a confident-looking number:
//
//   - `null` means "this cannot be computed from what you gave me".
//   - It is NEVER a stand-in for zero, and callers must not coerce it to one.
//
// That is the same rule the aggregators follow for an unrecorded outcome (see
// analytics.js#successRate, which returns a null percentage rather than 100),
// and it exists for the same reason: a fabricated number in an operator console
// gets acted on.

/** The scale factor that makes the MAD a consistent estimator of sigma for normal data. */
const MAD_TO_SIGMA = 1.4826;

/** Two-sided 95% normal quantile — the default confidence level for `wilsonInterval`. */
export const Z_95 = 1.959964;

/**
 * Finite numbers only, in ascending order. Everything below sorts through this
 * rather than calling `.sort()` directly: the default sort is LEXICOGRAPHIC, so
 * `[10, 9, 100].sort()` yields `[10, 100, 9]` and every percentile downstream is
 * silently wrong.
 * @param {number[]} values
 * @returns {number[]}
 */
function cleanSorted(values) {
  return (values || [])
    .filter((v) => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b);
}

/**
 * Arithmetic mean over the finite values, or null for an empty sample.
 * @param {number[]} values
 * @returns {number|null}
 */
export function mean(values) {
  const clean = (values || []).filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!clean.length) return null;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

/**
 * Median over the finite values, or null for an empty sample. Even-length
 * samples average the two middle values.
 * @param {number[]} values
 * @returns {number|null}
 */
export function median(values) {
  const sorted = cleanSorted(values);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * A robust spread estimate: the median of the absolute deviations from the
 * median, rescaled so it is comparable to a standard deviation.
 *
 * Used instead of a standard deviation because the series this runs over — daily
 * failure counts, daily render volume — are exactly the series where one bad day
 * is the thing we are trying to DETECT. A standard deviation includes that day
 * in the baseline it is measured against, so a single large spike inflates the
 * threshold enough to hide itself. The median does not move.
 *
 * @param {number[]} values
 * @returns {{median: number, mad: number, scale: number}|null} `scale` is the
 *   sigma-comparable spread; null for an empty sample.
 */
export function medianAbsoluteDeviation(values) {
  const clean = cleanSorted(values);
  if (!clean.length) return null;
  const med = /** @type {number} */ (median(clean));
  const mad = /** @type {number} */ (median(clean.map((v) => Math.abs(v - med))));
  return { median: med, mad, scale: mad * MAD_TO_SIGMA };
}

/**
 * How many robust standard deviations `value` sits from the sample's median.
 *
 * **The MAD-is-zero case is the whole reason this is a function and not two
 * lines at the call site.** A daily-failure series is usually mostly zeros, so
 * more than half its values are identical and the MAD is 0 — which would make
 * every non-zero day an infinite z-score. Infinity is not a useful answer and
 * `0/0` is worse, so:
 *
 *   1. MAD > 0            → the normal robust z.
 *   2. MAD === 0 but the values are not all identical → fall back to the MEAN
 *      absolute deviation from the median, which stays positive for
 *      `[0,0,0,0,0,50]` and correctly reports 50 as a large excursion.
 *   3. Every value identical → `null`. With no spread at all there is no scale
 *      to measure against, and any answer would be invented.
 *
 * @param {number} value
 * @param {number[]} values The baseline sample.
 * @returns {number|null}
 */
export function robustZ(value, values) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const spread = medianAbsoluteDeviation(values);
  if (!spread) return null;

  let scale = spread.scale;
  if (scale <= 0) {
    const clean = cleanSorted(values);
    const meanAbsDev = mean(clean.map((v) => Math.abs(v - spread.median)));
    scale = meanAbsDev || 0;
  }
  if (scale <= 0) return null;
  return (value - spread.median) / scale;
}

/**
 * Wilson score interval for a binomial proportion.
 *
 * This is the test that stops "3 of 8 kitchen renders failed" from being
 * reported as a 37.5% failure rate beside a 4% global rate. The normal
 * approximation everyone reaches for first is badly wrong at small n and at
 * proportions near 0 or 1 — both of which describe a failure rate exactly — and
 * it happily produces bounds below 0. Wilson does not.
 *
 * A segment is only worth reporting when its interval EXCLUDES the global rate;
 * that comparison is the caller's job, but it is why `lower`/`upper` are the
 * point of this function rather than `point`.
 *
 * @param {number} successes Count of the outcome being measured (e.g. failures).
 * @param {number} total Sample size.
 * @param {number} [z] Normal quantile; defaults to 95% two-sided.
 * @returns {{point: number, lower: number, upper: number, n: number}|null} Fractions
 *   in [0,1]; null when `total` is not a positive integer or `successes` is out of range.
 */
export function wilsonInterval(successes, total, z = Z_95) {
  const n = Number(total);
  const s = Number(successes);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (!Number.isFinite(s) || s < 0 || s > n) return null;

  const p = s / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));

  return {
    point: p,
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
    n,
  };
}

/**
 * Least-squares fit of `y` against its own index, plus the coefficient of
 * determination.
 *
 * `slope` is in units per bucket — per day for a daily series — so a caller can
 * state "gaining 3 renders a day" without knowing this ran a regression. `r2` is
 * what keeps that sentence honest: a steep slope through scattered points is not
 * a trend, and a rule that reports one without checking `r2` will announce a
 * direction change every time a weekend lands differently.
 *
 * @param {number[]} values Ordered oldest-first.
 * @returns {{slope: number, intercept: number, r2: number, n: number}|null} Null
 *   below two points, or when every x is identical.
 */
export function linearTrend(values) {
  const ys = (values || []).filter((v) => typeof v === 'number' && Number.isFinite(v));
  const n = ys.length;
  if (n < 2) return null;

  const meanX = (n - 1) / 2;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - meanX) * (ys[i] - meanY);
    sxx += (i - meanX) * (i - meanX);
  }
  if (sxx === 0) return null;

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const predicted = intercept + slope * i;
    ssTot += (ys[i] - meanY) * (ys[i] - meanY);
    ssRes += (ys[i] - predicted) * (ys[i] - predicted);
  }
  // A perfectly flat series has no variance to explain. Calling that r2 = 0
  // would read as "no fit" when the fit is exact; it is 1 by convention.
  const r2 = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);

  return { slope, intercept, r2, n };
}

/** Sample variance (n-1). Null below two values. @param {number[]} values */
function sampleVariance(values) {
  const n = values.length;
  if (n < 2) return null;
  const m = values.reduce((a, b) => a + b, 0) / n;
  return values.reduce((acc, v) => acc + (v - m) * (v - m), 0) / (n - 1);
}

/**
 * Find the single most likely level shift in a series, and say how strong the
 * evidence for it is.
 *
 * The question this answers is the one a trend line cannot: **"did something
 * change, or has it always been like this?"** A slope reports the average of a
 * whole window, so a step from 8/day to 19/day eleven days ago and a smooth
 * climb over thirty days produce similar slopes and very different next steps.
 *
 * Every valid split is scored with Welch's t (unequal variances, because volume
 * before and after a change routinely has different spread). The caller decides
 * what score is worth reporting — `score` is deliberately not thresholded here,
 * so the threshold lives beside the rule that owns the consequence.
 *
 * @param {number[]} values Ordered oldest-first.
 * @param {number} [minSegment] Minimum points on each side; guards against a
 *   "change" fitted to one endpoint.
 * @returns {{index: number, before: number, after: number, delta: number, score: number}|null}
 *   `index` is the first index of the AFTER segment. Null when the series is too
 *   short, or when no split has enough spread on either side to score.
 */
export function changePoint(values, minSegment = 3) {
  const ys = (values || []).filter((v) => typeof v === 'number' && Number.isFinite(v));
  const floor = Math.max(2, minSegment);
  if (ys.length < floor * 2) return null;

  let best = null;
  for (let i = floor; i <= ys.length - floor; i++) {
    const left = ys.slice(0, i);
    const right = ys.slice(i);
    const meanL = left.reduce((a, b) => a + b, 0) / left.length;
    const meanR = right.reduce((a, b) => a + b, 0) / right.length;
    const varL = sampleVariance(left);
    const varR = sampleVariance(right);
    if (varL === null || varR === null) continue;

    const stdErr = Math.sqrt(varL / left.length + varR / right.length);
    // Both sides perfectly flat: a step between two constants is a real change,
    // but there is no scale to score it against, so it cannot be ranked against
    // the other candidates. Skip rather than invent a score.
    if (!(stdErr > 0)) continue;

    const score = Math.abs(meanR - meanL) / stdErr;
    if (!best || score > best.score) {
      best = { index: i, before: meanL, after: meanR, delta: meanR - meanL, score };
    }
  }
  return best;
}

/**
 * Project a period's running total out to the end of that period.
 *
 * Defaults to the naive "keep going at the average pace so far", but accepts a
 * `recentRate` because that average is usually the wrong pace to project with:
 * a month whose first ten days were quiet and whose last four have doubled
 * should not be projected at the fourteen-day mean. Pass the trailing-7 daily
 * rate and the projection follows what is happening now.
 *
 * @param {{soFar: number, elapsedUnits: number, totalUnits: number, recentRate?: number|null}} arg
 * @returns {{projected: number, rate: number, remainingUnits: number}|null} Null
 *   when the period has not started, or is already over.
 */
export function projectToPeriodEnd({ soFar, elapsedUnits, totalUnits, recentRate = null }) {
  const elapsed = Number(elapsedUnits);
  const total = Number(totalUnits);
  const base = Number(soFar);
  if (!Number.isFinite(elapsed) || elapsed <= 0) return null;
  if (!Number.isFinite(total) || total < elapsed) return null;
  if (!Number.isFinite(base) || base < 0) return null;

  const rate = typeof recentRate === 'number' && Number.isFinite(recentRate) && recentRate >= 0
    ? recentRate
    : base / elapsed;
  const remainingUnits = total - elapsed;
  return { projected: base + rate * remainingUnits, rate, remainingUnits };
}

/**
 * Division that refuses to lie. Returns null rather than 0, Infinity or NaN when
 * the denominator is absent — "no renders yet" and "a 0% failure rate" are
 * different facts and must not render as the same number.
 * @param {number} numerator
 * @param {number} denominator
 * @returns {number|null}
 */
export function ratio(numerator, denominator) {
  const d = Number(denominator);
  const n = Number(numerator);
  if (!Number.isFinite(d) || d === 0) return null;
  if (!Number.isFinite(n)) return null;
  return n / d;
}

/**
 * How many times larger `value` is than `baseline` — the "4.1x" in a finding
 * title. Null when the baseline is zero, because everything is infinitely more
 * than nothing and that sentence helps nobody.
 * @param {number} value
 * @param {number} baseline
 * @returns {number|null}
 */
export function foldChange(value, baseline) {
  const b = Number(baseline);
  if (!Number.isFinite(b) || b <= 0) return null;
  if (!Number.isFinite(Number(value))) return null;
  return Number(value) / b;
}
