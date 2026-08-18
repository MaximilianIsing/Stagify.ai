// Performance and cost rules for the Signals tab: how long renders take, how much
// compute they spend getting there, and when the failures cluster.
//
// SPLIT FROM findings-reliability.js, and the boundary is a real one rather than a
// line count. That file answers "is staging working" — a render either succeeded or
// it did not, and every rule there is a proportion with an interval around it. This
// one answers "at what cost", where the quantities are continuous (milliseconds,
// generations per render), the comparisons are between time windows rather than
// between segments, and nothing here is a pass/fail.
//
// The two share their gates, though, and for the same reasons documented at the top
// of findings-reliability.js: a minimum sample on BOTH sides of any window
// comparison, successful renders only for anything timed (a render that failed after
// 400ms would otherwise flatter latency exactly when things are going worst — the
// same filter analytics.js#durationStats applies), and `suppressed(...)` rather than
// silence when the sample is too thin.

import { COL, withOutcome, categoryKey, topValues } from './analytics.js';
import { foldChange, median, mean } from './stats.js';
import { finding, suppressed, fmtCount, fmtPct, fmtX, fmtSeconds } from './findings.js';

const AREA = 'Performance';

/** Below this many recorded outcomes, nothing here says anything at all. */
const MIN_GLOBAL = 40;
/** Per-segment floor. Above the point where one bad afternoon dominates a category. */
const MIN_SEGMENT = 30;

/** Lower-cased, trimmed cell. @param {string[]} row @param {number} idx */
function cell(row, idx) {
  return String((row && row[idx]) || '').trim();
}

/** Recorded-outcome rows only, once per rule rather than once per branch. */
function recorded(input) {
  return withOutcome(input.promptRows || []);
}

/** @param {string[]} row */
function isFailure(row) {
  return cell(row, COL.PROMPT.STATUS).toLowerCase() === 'failed';
}

/** Rows inside the trailing `days` window. @param {string[][]} rows */
function since(rows, days, now) {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  return rows.filter((r) => {
    const t = Date.parse(cell(r, COL.PROMPT.TS));
    return Number.isFinite(t) && t >= cutoff;
  });
}

/**
 * A4 · Latency now against latency before.
 *
 * Successful renders only. A render that failed after 400ms would otherwise
 * flatter the numbers exactly when things are going worst — the same reason
 * analytics.js#durationStats filters the same way.
 */
const latencyShift = {
  id: 'reliability.latency-shift',
  area: AREA,
  run(input) {
    const ok = recorded(input).filter((r) => !isFailure(r));
    const durations = (rows) => rows
      .map((r) => Number(cell(r, COL.PROMPT.DURATION)))
      .filter((v) => Number.isFinite(v) && v > 0);

    const recentRows = since(ok, 7, input.now);
    const priorRows = ok.filter((r) => {
      const t = Date.parse(cell(r, COL.PROMPT.TS));
      const weekAgo = input.now - 7 * 24 * 60 * 60 * 1000;
      return Number.isFinite(t) && t < weekAgo && t >= input.now - 37 * 24 * 60 * 60 * 1000;
    });

    const recentD = durations(recentRows);
    const priorD = durations(priorRows);
    const MIN = 30;
    if (recentD.length < MIN || priorD.length < MIN) {
      return suppressed(`Latency comparison needs ${MIN} timed renders in each of the last 7 days and the 30 `
        + `before; there are ${recentD.length} and ${priorD.length}.`);
    }

    const p95 = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
    };
    const now95 = p95(recentD);
    const was95 = p95(priorD);
    const change = foldChange(now95, was95);
    if (change === null) return null;

    const evidence = [
      { label: 'p95 this week', value: fmtSeconds(now95) },
      { label: 'p95 the 30 days before', value: fmtSeconds(was95) },
      { label: 'Median this week', value: fmtSeconds(median(recentD)) },
      { label: 'Sample', value: `${fmtCount(recentD.length)} renders` },
    ];

    if (change >= 1.3) {
      return finding({
        id: 'reliability.latency-shift',
        severity: 'warning',
        area: AREA,
        title: `The slowest renders got ${fmtPct((change - 1) * 100)} slower this week`,
        detail: 'p95 is the experience of the unluckiest one render in twenty, and it has moved materially '
          + 'against the preceding month. Measured over successful renders only, so a fast failure cannot '
          + 'flatter it.',
        evidence,
        action: 'Check whether the image model changed (the model column below) and whether quality-gate '
          + 'retries are up — the retry-overhead finding, if present, explains most latency moves.',
        sample: recentD.length,
      });
    }
    if (change <= 0.75) {
      return finding({
        id: 'reliability.latency-shift',
        severity: 'healthy',
        area: AREA,
        title: `The slowest renders got ${fmtPct((1 - change) * 100)} faster this week`,
        detail: 'p95 has improved against the preceding month, over successful renders only.',
        evidence,
        action: 'Nothing to do.',
        sample: recentD.length,
      });
    }
    return null;
  },
};

/**
 * A5 · Quality-gate retries, globally and by room.
 *
 * `attempts` counts images produced for THAT render, retries included, so a mean
 * above 1 is the compute the quality gate is spending to get an acceptable
 * result. It is the closest thing to a per-segment cost signal available without
 * billing data, which is why it is worth a card even when nothing is failing.
 */
const retryOverhead = {
  id: 'reliability.retry-overhead',
  area: AREA,
  run(input) {
    const rows = recorded(input).filter((r) => !isFailure(r));
    const attemptsOf = (r) => {
      const v = Number(cell(r, COL.PROMPT.ATTEMPTS));
      return Number.isFinite(v) && v > 0 ? v : null;
    };
    const all = rows.map(attemptsOf).filter((v) => v !== null);
    if (all.length < MIN_GLOBAL) {
      return suppressed(`Retry-cost analysis needs ${MIN_GLOBAL} renders recording an attempt count; there are ${all.length}.`);
    }

    const globalMean = /** @type {number} */ (mean(all));

    /** @type {Record<string, {label: string, values: number[]}>} */
    const byRoom = {};
    for (const r of rows) {
      const a = attemptsOf(r);
      const raw = cell(r, COL.PROMPT.ROOM);
      if (a === null || !raw) continue;
      const key = categoryKey(raw);
      const g = byRoom[key] || (byRoom[key] = { label: raw, values: [] });
      g.values.push(a);
    }
    const worst = Object.values(byRoom)
      .filter((g) => g.values.length >= MIN_SEGMENT)
      .map((g) => ({ label: g.label, n: g.values.length, avg: /** @type {number} */ (mean(g.values)) }))
      .sort((a, b) => b.avg - a.avg)[0];

    const overspend = worst ? foldChange(worst.avg, globalMean) : null;
    if (worst && overspend !== null && overspend >= 1.5) {
      return finding({
        id: 'reliability.retry-overhead',
        severity: 'opportunity',
        area: AREA,
        title: `${worst.label} costs ${fmtX(overspend)} the usual number of generations per render`,
        detail: `Each ${worst.label} render averages ${worst.avg.toFixed(2)} generations against `
          + `${globalMean.toFixed(2)} overall. Every extra attempt is a paid model call that produced an image `
          + 'the quality gate rejected, so this is real spend with a name on it rather than a latency detail.',
        evidence: [
          { label: 'Attempts per render', value: worst.avg.toFixed(2) },
          { label: 'Overall average', value: globalMean.toFixed(2) },
          { label: 'Sample', value: `${fmtCount(worst.n)} renders` },
        ],
        action: 'Look at what the quality reviewer rejects for this room in lib/image/image-review.js — a room '
          + 'that needs repeated attempts is usually failing one specific check that the prompt could satisfy first time.',
        sample: worst.n,
      });
    }

    if (globalMean <= 1.15) {
      return finding({
        id: 'reliability.retry-overhead',
        severity: 'healthy',
        area: AREA,
        title: `Most renders pass the quality gate first time (${globalMean.toFixed(2)} attempts on average)`,
        detail: 'The quality gate is rarely having to ask for another image, so retry spend is close to its floor.',
        evidence: [
          { label: 'Attempts per render', value: globalMean.toFixed(2) },
          { label: 'Sample', value: `${fmtCount(all.length)} renders` },
        ],
        action: 'Nothing to do.',
        sample: all.length,
      });
    }
    return null;
  },
};


/**
 * A7 · Failures concentrated in one part of the day.
 *
 * The gap this fills is specific. `lib/data/uptime-monitor.js` infers downtime
 * from MISSED HEARTBEATS, so it only ever learns that the process died — an
 * outage the process survived (a dead upstream model, an expired key, a bad
 * deploy) is invisible to it and the status page reports 100% throughout. A band
 * of hours holding far more failures than its share of renders is the fingerprint
 * of exactly that outage.
 *
 * Compared against each hour's share of VOLUME, not against a flat expectation:
 * a product used mostly in the afternoon would otherwise always look like it
 * breaks in the afternoon.
 */
const failureHourConcentration = {
  id: 'reliability.failure-hour',
  area: AREA,
  run(input) {
    const rows = recorded(input);
    const failures = rows.filter(isFailure);
    const MIN_FAILURES = 20;
    if (failures.length < MIN_FAILURES) return null;

    const hourOf = (r) => {
      const d = new Date(cell(r, COL.PROMPT.TS));
      return Number.isNaN(d.getTime()) ? null : d.getHours();
    };
    const volume = new Array(24).fill(0);
    const failed = new Array(24).fill(0);
    for (const r of rows) {
      const h = hourOf(r);
      if (h === null) continue;
      volume[h] += 1;
      if (isFailure(r)) failed[h] += 1;
    }

    let worstHour = -1;
    let worstExcess = 0;
    for (let h = 0; h < 24; h++) {
      if (volume[h] < 10) continue;
      const expected = (volume[h] / rows.length) * failures.length;
      if (expected <= 0) continue;
      const excess = failed[h] / expected;
      if (excess > worstExcess) { worstExcess = excess; worstHour = h; }
    }

    if (worstHour < 0 || worstExcess < 2.5 || failed[worstHour] < 8) return null;

    const label = `${String(worstHour).padStart(2, '0')}:00–${String((worstHour + 1) % 24).padStart(2, '0')}:00`;
    return finding({
      id: 'reliability.failure-hour',
      severity: 'warning',
      area: AREA,
      title: `Failures cluster around ${label} — ${fmtX(worstExcess)} that hour's share`,
      detail: 'Compared against how much traffic that hour actually carries, not against a flat expectation, '
        + 'so a busy hour is not flagged just for being busy. This is the shape of a recurring window rather '
        + 'than a one-off, and the uptime monitor cannot see it: it infers downtime from missed heartbeats, '
        + 'so an outage the process survives never reaches the status page.',
      evidence: [
        { label: 'Failures in that hour', value: fmtCount(failed[worstHour]) },
        { label: 'Expected from its volume', value: ((volume[worstHour] / rows.length) * failures.length).toFixed(1) },
        { label: 'Renders in that hour', value: fmtCount(volume[worstHour]) },
      ],
      action: 'Check what runs on a schedule near that hour — a deploy, a sweep, an upstream quota reset — and '
        + 'post an incident on the Server status tab if it turns out to be a real outage window.',
      sample: failures.length,
      confidence: 'medium',
    });
  },
};

/**
 * A8 · Which models are actually serving renders.
 *
 * Not a threshold rule: it exists because a model roster that has silently
 * changed is the first thing to check when any of the rules above fires, and
 * because a deprecated image model degrades for a while before it disappears.
 */
const modelMix = {
  id: 'reliability.model-mix',
  area: AREA,
  run(input) {
    const rows = recorded(input);
    if (rows.length < MIN_GLOBAL) return null;
    const models = topValues(rows, COL.PROMPT.MODEL, { top: 5 });
    if (models.length < 2) return null;

    const total = models.reduce((a, m) => a + m.value, 0);
    const lead = models[0];
    if (lead.value / total > 0.95) return null; // One model serving everything is the normal state.

    return finding({
      id: 'reliability.model-mix',
      severity: 'quality',
      area: AREA,
      title: `${models.length} different models served renders in this log`,
      detail: 'Renders are split across more than one image model, so any rate measured across all of them is '
        + 'an average of different things. Worth knowing before reading the failure and latency findings above.',
      evidence: models.map((m) => ({ label: m.label, value: `${fmtPct((m.value / total) * 100)} of renders` })),
      action: 'Confirm this is intentional — lib/config/model-config.js#getGeminiImageModel decides which model a '
        + 'render gets, and a long tail here usually means old client versions still in the field.',
      sample: total,
      confidence: 'high',
    });
  },
};


export const PERFORMANCE_RULES = [
  latencyShift,
  retryOverhead,
  failureHourConcentration,
  modelMix,
];
