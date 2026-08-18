// Reliability rules for the Signals tab: is staging actually working, and for whom.
//
// Every rule here is a PROPORTION with an interval around it — a render either
// succeeded or it did not. How long it took and what it cost live next door in
// findings-performance.js, where the quantities are continuous and the
// comparisons are between time windows rather than between segments.
//
// Every rule here reads `prompt_logs.csv`, whose outcome columns
// (status/durationMs/model/attempts/errorCode) were APPENDED on 2026-07-26 —
// every render before that has empty cells. `withOutcome` excludes them, and so
// must anything added here: counting them as failures paints an error spike
// across the whole history, and counting them as successes hides a live outage
// behind old data.
//
// THE TWO GATES EVERY THRESHOLD RULE PASSES THROUGH
//
// 1. **A minimum sample.** Not negotiable and not redundant with the interval
//    below — 3 failures out of 8 is an observed 37.5% whose Wilson interval
//    still starts at ~13.7%, so it EXCLUDES a 4% baseline and would fire as a
//    critical built on eight renders. See the assertion that pins this in
//    test/frontend/admin/admin-stats.test.js.
// 2. **A statistical gate.** An interval that excludes the baseline, or a robust
//    z past its threshold. Which one depends on whether the quantity is a
//    proportion or a series.
//
// A rule that clears neither returns `suppressed(...)`, so the operator sees
// "not enough data yet" instead of a silence that looks like good news.

import { COL, withOutcome, dayKeyLocal, categoryKey } from './analytics.js';
import { wilsonInterval, robustZ, foldChange, median } from './stats.js';
import { finding, suppressed, fmtCount, fmtPct, fmtX } from './findings.js';

const AREA = 'Reliability';

/** Below this many recorded outcomes, nothing here says anything at all. */
const MIN_GLOBAL = 40;
/** Per-segment floor. Above the point where one bad afternoon dominates a category. */
const MIN_SEGMENT = 30;
/** |robust z| past which a daily excursion is called out. */
const Z_ALERT = 3;

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

/**
 * Daily failure counts over the trailing window, as an ordered array.
 * Zero-filled: a quiet day must be a 0 in the baseline, not a gap — otherwise the
 * median is taken over busy days only and every ordinary day looks like a spike.
 */
function dailyFailures(rows, days, now) {
  /** @type {Record<string, number>} */
  const buckets = {};
  for (let i = days - 1; i >= 0; i--) {
    buckets[dayKeyLocal(new Date(now - i * 24 * 60 * 60 * 1000))] = 0;
  }
  for (const r of rows) {
    if (!isFailure(r)) continue;
    const key = dayKeyLocal(cell(r, COL.PROMPT.TS));
    if (key in buckets) buckets[key] += 1;
  }
  return Object.keys(buckets).sort().map((k) => ({ key: k, value: buckets[k] }));
}

/**
 * A1 · Today's failure count against a robust trailing baseline.
 *
 * Uses the MEDIAN and MAD of the last 30 days rather than the mean and standard
 * deviation, because a spike is precisely what this is trying to detect and a
 * mean-based baseline includes the spike in the bar it has to clear. The MAD-is-
 * zero case (a mostly-quiet series, which is the normal one) is handled inside
 * `robustZ` — see the fallback documented there.
 */
const failureSpike = {
  id: 'reliability.failure-spike',
  area: AREA,
  run(input) {
    const rows = recorded(input);
    if (rows.length < MIN_GLOBAL) {
      return suppressed(`Failure-rate monitoring needs ${MIN_GLOBAL} recorded outcomes; there are ${rows.length}.`);
    }

    const series = dailyFailures(rows, 30, input.now);
    const today = series[series.length - 1];
    const baseline = series.slice(0, -1).map((p) => p.value);
    const z = robustZ(today.value, baseline);

    const evidence = [
      { label: 'Failures today', value: fmtCount(today.value) },
      { label: 'Typical day', value: fmtCount(median(baseline) ?? 0) },
      { label: 'Recorded outcomes', value: fmtCount(rows.length) },
    ];
    const series30 = { points: series.map((p) => ({ key: p.key, label: p.key, value: p.value })), unit: 'failures' };

    if (z !== null && z >= Z_ALERT && today.value > 0) {
      return finding({
        id: 'reliability.failure-spike',
        severity: 'critical',
        area: AREA,
        // `today.value` really can be 1: against a baseline of mostly zeros the
        // mean-absolute-deviation fallback in robustZ gives a small scale, so a
        // single failure clears the threshold. "1 renders failed" is the sentence
        // that would result.
        title: `${fmtCount(today.value)} render${today.value === 1 ? '' : 's'} failed today `
          + `— well above the usual ${fmtCount(median(baseline) ?? 0)}`,
        detail: 'Today sits far outside the spread of the last 30 days, measured against the median rather '
          + 'than the mean so a previous bad day cannot raise the bar it has to clear. This is the shape of '
          + 'a live problem rather than ordinary variation.',
        evidence: [...evidence, { label: 'Deviation', value: `${z.toFixed(1)}× the typical spread` }],
        action: 'Open the failure reasons below and check the newest errorCode values, then the Server status tab '
          + 'for an incident worth posting — the uptime monitor only sees the process die, not a bad upstream model.',
        sample: rows.length,
        series: series30,
      });
    }

    // The positive branch. A dashboard that only ever speaks up when something is
    // wrong gives no way to tell "healthy" from "not measured", which is the exact
    // confusion this tab exists to remove.
    const failures = rows.filter(isFailure).length;
    const rate = (failures / rows.length) * 100;
    if (rate < 5) {
      return finding({
        id: 'reliability.failure-spike',
        severity: 'healthy',
        area: AREA,
        title: `Staging is succeeding ${fmtPct(100 - rate)} of the time`,
        detail: 'No day in the last 30 stands out against the trailing baseline, and the overall failure '
          + 'rate is low. This is measured only over renders that recorded an outcome.',
        evidence,
        action: 'Nothing to do.',
        sample: rows.length,
        series: series30,
      });
    }
    return null;
  },
};

/**
 * Build the segment-outlier rule for one column.
 *
 * The same test applied to rooms, styles and models, because the question is
 * identical each time: is this category's failure rate distinguishable from the
 * product's, or is it just small?
 *
 * @param {{id: string, index: number, noun: string, hint: string}} spec
 */
function segmentRule(spec) {
  return {
    id: spec.id,
    area: AREA,
    run(input) {
      const rows = recorded(input);
      if (rows.length < MIN_GLOBAL) return null; // A1 already reports the thin-data case.

      const globalRate = rows.filter(isFailure).length / rows.length;

      // Grouped through categoryKey because these columns are FREE TEXT written by
      // several client versions — grouping on the raw string charts "Living room"
      // and "Living Room" as two different rooms.
      /** @type {Record<string, {total: number, failed: number, label: string, labels: Record<string, number>}>} */
      const groups = {};
      for (const r of rows) {
        const raw = cell(r, spec.index);
        if (!raw) continue;
        const key = categoryKey(raw);
        if (!key) continue;
        const g = groups[key] || (groups[key] = { total: 0, failed: 0, label: raw, labels: {} });
        g.total += 1;
        if (isFailure(r)) g.failed += 1;
        g.labels[raw] = (g.labels[raw] || 0) + 1;
        // Display the most common ORIGINAL spelling, never a machine-lowercased one.
        if (g.labels[raw] > (g.labels[g.label] || 0)) g.label = raw;
      }

      const eligible = Object.values(groups).filter((g) => g.total >= MIN_SEGMENT);
      if (!eligible.length) {
        return suppressed(`No ${spec.noun} has ${MIN_SEGMENT} recorded renders yet, so none can be compared.`);
      }

      // Worst first, and only the worst is reported: three cards saying the same
      // thing about three rooms is a list, not a finding.
      const worst = eligible
        .map((g) => ({ ...g, ci: wilsonInterval(g.failed, g.total) }))
        .filter((g) => g.ci && g.ci.lower > globalRate)
        .sort((a, b) => /** @type {any} */ (b.ci).point - /** @type {any} */ (a.ci).point)[0];

      if (!worst) return null;
      const ci = /** @type {any} */ (worst.ci);
      const times = foldChange(ci.point, globalRate);

      return finding({
        id: spec.id,
        severity: ci.point > globalRate * 3 ? 'critical' : 'warning',
        area: AREA,
        title: times
          ? `${worst.label} fails ${fmtX(times)} more often than average`
          : `${worst.label} fails ${fmtPct(ci.point * 100)} of the time`,
        detail: `${fmtCount(worst.failed)} of ${fmtCount(worst.total)} ${worst.label} renders failed `
          + `(${fmtPct(ci.point * 100)}) against ${fmtPct(globalRate * 100)} across everything. The 95% `
          + `interval for this segment is ${fmtPct(ci.lower * 100)}–${fmtPct(ci.upper * 100)}, which excludes `
          + 'the overall rate — so the gap is real rather than a small-sample artefact.',
        evidence: [
          { label: 'Segment rate', value: fmtPct(ci.point * 100) },
          { label: 'Overall rate', value: fmtPct(globalRate * 100) },
          { label: 'Sample', value: `${fmtCount(worst.total)} renders` },
          { label: '95% interval', value: `${fmtPct(ci.lower * 100)}–${fmtPct(ci.upper * 100)}` },
        ],
        action: spec.hint,
        sample: worst.total,
      });
    },
  };
}

const roomFailure = segmentRule({
  id: 'reliability.room-failure',
  index: COL.PROMPT.ROOM,
  noun: 'room type',
  hint: 'Check this room type in lib/staging/room-constraints.js (ROOM_TYPE_CONSTRAINTS) and read the last '
    + 'few errorCode values for it — a room that fails disproportionately usually has a constraint the '
    + 'prompt cannot satisfy.',
});

const styleFailure = segmentRule({
  id: 'reliability.style-failure',
  index: COL.PROMPT.STYLE,
  noun: 'furniture style',
  hint: 'Compare this style\'s prompt fragment in lib/staging/prompts.js against one that succeeds — a style '
    + 'failing disproportionately is usually asking for something the quality gate then rejects.',
});

const modelFailure = segmentRule({
  id: 'reliability.model-failure',
  index: COL.PROMPT.MODEL,
  noun: 'model',
  hint: 'If one model is failing disproportionately, check whether it is still the right target in '
    + 'lib/config/model-config.js#getGeminiImageModel — a deprecated image model degrades before it disappears.',
});

/**
 * A3 · An error code that has only just started appearing.
 *
 * The single cheapest early warning available here. A code that has never been
 * seen before does not need a threshold to be interesting — it means a failure
 * mode that did not exist last week exists now.
 */
const newErrorCode = {
  id: 'reliability.new-error-code',
  area: AREA,
  run(input) {
    const rows = recorded(input).filter(isFailure);
    if (rows.length < 5) return null;

    const recent = new Set();
    const historic = new Set();
    const counts = {};
    const cutoff = input.now - 7 * 24 * 60 * 60 * 1000;
    for (const r of rows) {
      const code = cell(r, COL.PROMPT.ERROR);
      if (!code) continue;
      const t = Date.parse(cell(r, COL.PROMPT.TS));
      if (Number.isFinite(t) && t >= cutoff) {
        recent.add(code);
        counts[code] = (counts[code] || 0) + 1;
      } else {
        historic.add(code);
      }
    }

    // Nothing to compare against: with no history every code is "new", which is
    // a statement about the log's age rather than about the product.
    if (!historic.size) return null;

    const fresh = [...recent].filter((c) => !historic.has(c)).sort((a, b) => counts[b] - counts[a]);
    if (!fresh.length) return null;

    const total = fresh.reduce((a, c) => a + counts[c], 0);
    return finding({
      id: 'reliability.new-error-code',
      severity: 'warning',
      area: AREA,
      title: fresh.length === 1
        ? `A new failure code appeared this week: ${fresh[0]}`
        : `${fresh.length} new failure codes appeared this week`,
      detail: 'These codes have never been logged before the last 7 days. A failure mode that did not exist '
        + 'previously is worth reading even at a low count — it usually means an upstream change rather than '
        + 'a user doing something unusual.',
      evidence: fresh.slice(0, 5).map((c) => ({ label: c, value: `${fmtCount(counts[c])} since` })),
      action: 'Search the server logs for these codes to find what produces them; if one is an upstream model '
        + 'error, post an incident on the Server status tab so the public page reflects it.',
      sample: total,
      confidence: 'medium',
    });
  },
};

/**
 * A6 · Architecture drift — the first reader of `prompt_logs.csv` column 14.
 *
 * The column was appended to the writer and never added to `COL`, so it has been
 * recorded and unread since it shipped. It flags a render whose output drifted
 * from the source photo's architecture, which is the defect a virtual-staging
 * customer notices first and the one least visible in a success rate: these
 * renders all logged `status: ok`.
 *
 * `''` means the question was never asked, NOT that the render was clean. Those
 * rows are excluded, exactly as unrecorded outcomes are.
 */
const architectureDrift = {
  id: 'reliability.architecture-drift',
  area: AREA,
  run(input) {
    const rows = (input.promptRows || []).filter((r) => {
      const v = cell(r, COL.PROMPT.DRIFT).toLowerCase();
      return v === 'yes' || v === 'no';
    });
    if (rows.length < MIN_SEGMENT) {
      return suppressed(`Architecture-drift monitoring needs ${MIN_SEGMENT} renders with a drift verdict; there are ${rows.length}.`);
    }

    const drifted = rows.filter((r) => cell(r, COL.PROMPT.DRIFT).toLowerCase() === 'yes').length;
    const ci = wilsonInterval(drifted, rows.length);
    if (!ci) return null;

    const evidence = [
      { label: 'Drifted', value: `${fmtCount(drifted)} of ${fmtCount(rows.length)}` },
      { label: 'Rate', value: fmtPct(ci.point * 100) },
      { label: '95% interval', value: `${fmtPct(ci.lower * 100)}–${fmtPct(ci.upper * 100)}` },
    ];

    if (ci.lower > 0.1) {
      return finding({
        id: 'reliability.architecture-drift',
        severity: 'critical',
        area: AREA,
        title: `${fmtPct(ci.point * 100)} of renders changed the room's architecture`,
        detail: 'These renders all counted as successes — the model produced an image and the quality gate '
          + 'passed it — but the output no longer matches the room in the photo. For virtual staging that is '
          + 'the defect a customer notices first, and it is invisible in the success rate.',
        evidence,
        action: 'Review the preservation rules in lib/staging/preservation-rules.js against the drifted renders; '
          + 'their seeds are logged (prompt_logs column 16), so a specific failure can be re-run rather than guessed at.',
        sample: rows.length,
      });
    }
    if (ci.upper < 0.05) {
      return finding({
        id: 'reliability.architecture-drift',
        severity: 'healthy',
        area: AREA,
        title: `Architecture is preserved in ${fmtPct((1 - ci.point) * 100)} of renders`,
        detail: 'The preservation rules are holding: renders are keeping the room they were given.',
        evidence,
        action: 'Nothing to do.',
        sample: rows.length,
      });
    }
    return null;
  },
};

export const RELIABILITY_RULES = [
  failureSpike,
  roomFailure,
  styleFailure,
  modelFailure,
  newErrorCode,
  architectureDrift,
];
