// The Signals tab's rules engine: the registry, the shared Finding shape, and the
// runner. Pure — no DOM, no fetch, no app state. signals.js renders what this
// returns; it decides nothing.
//
// WHAT A FINDING IS, AND WHY THE SHAPE IS FIXED
//
// The Insights tab already draws 24 charts. A finding is not a 25th chart: it is
// a claim with the evidence attached and a next step, produced only when a rule
// decided the claim was worth making. The fields exist to make that claim
// checkable rather than merely readable —
//
//   title      the claim, carrying its own number
//   detail     what it means, in sentences, templated from the same numbers
//   evidence   the numbers themselves, so the claim can be audited on the page
//   action     what to actually do; a finding without one is an observation and
//              does not belong here
//   sample     what it rests on; `confidence` is derived from it
//
// THE RULE THAT SHAPES EVERY RULE FILE
//
// Silence must be honest. A rule with too little data returns `suppressed(...)`,
// NOT null and never a finding with a shrug in it — the runner collects those
// into one visible "not enough data yet" card. Without that, an empty Signals tab
// is indistinguishable from a clean bill of health, and the empty tab is what a
// brand-new deployment and a broken loader both look like.
//
// This is the same invariant the aggregators keep for an unrecorded outcome
// (analytics.js#successRate returns a null percentage, never 100) and for a
// cohort month that has not elapsed (rendered blank, never 0%). See
// docs/guides/admin-dashboard.md, "Three places absent must not read as zero".

import { RELIABILITY_RULES } from './findings-reliability.js';
import { PERFORMANCE_RULES } from './findings-performance.js';
import { GROWTH_RULES } from './findings-growth.js';
import { ACCOUNT_RULES } from './findings-accounts.js';
import { QUALITY_RULES } from './findings-quality.js';

/**
 * @typedef {{label: string, value: string}} Evidence
 * @typedef {{
 *   id: string,
 *   severity: 'critical'|'warning'|'opportunity'|'healthy'|'quality',
 *   area: string,
 *   title: string,
 *   detail: string,
 *   evidence: Evidence[],
 *   action: string,
 *   confidence: 'high'|'medium'|'low',
 *   sample: number,
 *   accounts?: Array<{email: string, id: string, note: string}>,
 *   series?: {points: Array<{key: string, label: string, value: number}>, unit: string},
 *   rank?: number
 * }} Finding
 */

/**
 * Ordering. `healthy` sits below the three actionable tiers but ABOVE `quality`:
 * what is working is worth reading, and what cannot be measured is context for
 * everything above it rather than a headline.
 */
export const SEVERITY_RANK = { critical: 0, warning: 1, opportunity: 2, healthy: 3, quality: 4 };

/** The section headings the tab renders, in order. */
export const SEVERITY_SECTIONS = [
  { key: 'critical', label: 'Needs attention now' },
  { key: 'warning', label: 'Worth a look' },
  { key: 'opportunity', label: 'Opportunities' },
  { key: 'healthy', label: 'Working well' },
  { key: 'quality', label: 'What you cannot trust yet' },
];

/** Severities that mean "someone should do something" — what the rail chip counts. */
export const ACTIONABLE = ['critical', 'warning', 'opportunity'];

// ── Formatting ──────────────────────────────────────────────────────────────
//
// Deliberately local rather than imported from charts.js or helpers.js. Both of
// those build DOM, and the whole value of this module is that it can be unit
// tested with no document at all — including a stub one. Four small formatters
// is a cheaper price than a DOM dependency in the file that decides what the
// dashboard says.

/** @param {number} n @returns {string} */
export function fmtCount(n) {
  return Number(n || 0).toLocaleString('en-US');
}

/** A percentage to one decimal, or an em dash when it is not computable. @param {number|null} v */
export function fmtPct(v) {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${Number(v).toFixed(1)}%`;
}

/** A multiplier to one decimal. @param {number|null} v */
export function fmtX(v) {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${Number(v).toFixed(1)}×`;
}

/** Milliseconds as seconds, one decimal. @param {number|null} ms */
export function fmtSeconds(ms) {
  return ms === null || ms === undefined || !Number.isFinite(ms) ? '—' : `${(Number(ms) / 1000).toFixed(1)}s`;
}

/** Bytes in the largest unit that keeps it readable. @param {number} bytes */
export function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

// ── Construction ────────────────────────────────────────────────────────────

/**
 * Confidence from sample size alone.
 *
 * Coarse on purpose. A rule that has already cleared its own statistical gate
 * (an interval that excludes the baseline, a robust z past its threshold) has
 * established that the effect is real; what this communicates is how much weight
 * the NUMBER deserves, which is a different question and is mostly about n.
 * A rule that knows better may override it.
 *
 * @param {number} sample
 * @returns {'high'|'medium'|'low'}
 */
export function confidenceFor(sample) {
  const n = Number(sample) || 0;
  if (n >= 200) return 'high';
  if (n >= 50) return 'medium';
  return 'low';
}

/**
 * Normalize a rule's output into a Finding.
 *
 * Everything is defaulted except the four fields a finding cannot exist without —
 * a missing `action` is caught here rather than rendering an observation that
 * looks like advice.
 *
 * @param {Partial<Finding> & {id: string, severity: Finding['severity'], area: string, title: string, action: string}} spec
 * @returns {Finding}
 */
export function finding(spec) {
  const sample = Number(spec.sample) || 0;
  return {
    id: spec.id,
    severity: spec.severity,
    area: spec.area,
    title: spec.title,
    detail: spec.detail || '',
    evidence: (spec.evidence || []).filter(Boolean).map((e) => ({ label: String(e.label), value: String(e.value) })),
    action: spec.action,
    confidence: spec.confidence || confidenceFor(sample),
    sample,
    ...(spec.accounts ? { accounts: spec.accounts } : {}),
    ...(spec.series ? { series: spec.series } : {}),
  };
}

/**
 * "I looked, and there is not enough here to say anything."
 *
 * A distinct return value from `null`, which means "this rule does not apply at
 * all" (no enterprise domains configured, so nothing to say about enterprise
 * usage). Only the former is reported back to the operator, because only the
 * former will become a real finding once the data arrives.
 *
 * @param {string} reason Written for a person: what is missing, and how much.
 * @returns {{suppressed: string}}
 */
export function suppressed(reason) {
  return { suppressed: reason };
}

/**
 * True for the shape `suppressed()` returns.
 *
 * Declared as a type PREDICATE rather than a plain boolean so the runner's
 * `result` narrows to a Finding on the other branch — without it, checkJs sees
 * `Finding | {suppressed}` throughout the loop and every field access is an error.
 * @param {any} v
 * @returns {v is {suppressed: string}}
 */
function isSuppressed(v) {
  return Boolean(v) && typeof v === 'object' && typeof v.suppressed === 'string';
}

// ── The registry ────────────────────────────────────────────────────────────

/** Every rule, in the order their files are read. Sorting happens after they run. */
export const ALL_RULES = [
  ...RELIABILITY_RULES,
  ...PERFORMANCE_RULES,
  ...GROWTH_RULES,
  ...ACCOUNT_RULES,
  ...QUALITY_RULES,
];

/**
 * Sort for display: severity first, then sample size, then id.
 *
 * The id tiebreak is what makes the order STABLE. Two findings of equal severity
 * and equal sample would otherwise sit in whatever order the registry happened to
 * produce, and a list that reshuffles between two refreshes of unchanged data
 * reads as though something moved.
 *
 * @param {Finding[]} findings
 * @returns {Finding[]}
 */
export function sortFindings(findings) {
  return [...(findings || [])].sort((a, b) => {
    const bySeverity = (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99);
    if (bySeverity) return bySeverity;
    if (b.sample !== a.sample) return b.sample - a.sample;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Run every rule over one input bag.
 *
 * **A rule that throws is contained.** Its id lands in `failed` and the other
 * rules still produce their findings — one bad aggregation must not blank the
 * tab, which is the same posture renderers.js takes around each chart island.
 *
 * @param {{
 *   promptRows?: string[][], users?: any[], enterprise?: any[], metrics?: any,
 *   index?: any, effectivePlan?: (u: any) => string, now?: number,
 * }} input Header-stripped tables and the account list; `metrics` may be null
 *   when GET /api/admin/metrics is unavailable, and rules must cope.
 * @returns {{findings: Finding[], suppressed: string[], failed: string[], counts: Record<string, number>}}
 */
export function runFindings(input) {
  const bag = { now: Date.now(), promptRows: [], users: [], enterprise: [], metrics: null, ...(input || {}) };
  /** @type {Finding[]} */
  const out = [];
  /** @type {string[]} */
  const held = [];
  /** @type {string[]} */
  const failed = [];

  for (const rule of ALL_RULES) {
    let result;
    try {
      result = rule.run(bag);
    } catch {
      failed.push(rule.id);
      continue;
    }
    if (!result) continue;
    if (isSuppressed(result)) { held.push(result.suppressed); continue; }
    for (const f of Array.isArray(result) ? result : [result]) {
      if (f && f.title && f.action) out.push(f);
    }
  }

  // The suppression roll-up is itself a finding, so it sits in the list rather
  // than in some separate footnote the eye skips. Without it, "nothing to report"
  // and "not enough data to report anything" render identically.
  if (held.length) {
    out.push(finding({
      id: 'quality.suppressed-for-sample',
      severity: 'quality',
      area: 'Measurement',
      title: `${held.length} check${held.length === 1 ? '' : 's'} could not run yet`,
      detail: 'These rules found too little data to make a claim. They are listed so an empty '
        + 'Signals tab reads as "not measured yet" rather than as "all clear" — they will '
        + 'start reporting on their own once enough has accumulated.',
      evidence: held.map((reason, i) => ({ label: `Check ${i + 1}`, value: reason })),
      action: 'Nothing to do — this clears itself as usage accumulates.',
      confidence: 'high',
      sample: held.length,
    }));
  }

  const sorted = sortFindings(out);
  /** @type {Record<string, number>} */
  const counts = {};
  for (const key of Object.keys(SEVERITY_RANK)) counts[key] = 0;
  for (const f of sorted) counts[f.severity] = (counts[f.severity] || 0) + 1;
  counts.actionable = ACTIONABLE.reduce((a, k) => a + (counts[k] || 0), 0);

  return { findings: sorted, suppressed: held, failed, counts };
}
