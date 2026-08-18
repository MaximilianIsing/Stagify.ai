// Growth rules for the Signals tab: where volume is heading, whether a change is
// real, and how long people take to get value out of the product.
//
// THE QUESTION THESE ANSWER THAT A CHART CANNOT
//
// The Insights tab already draws cumulative generations, accounts over time, and
// signups per bucket. Those show the shape; none of them separate the two things
// an operator actually needs to tell apart:
//
//   "we grew 22% this month"        — could be four good days inside a flat month
//   "the rate changed 11 days ago"  — a step, with a date, worth investigating
//
// So `volumeTrend` reports the direction with its fit quality attached, and
// `trendChangePoint` looks specifically for a level shift and stays quiet unless
// the evidence clears the noise. A trend line alone reports the same slope for a
// smooth climb and for a step, and those two want different next steps.
//
// PROJECTIONS ARE LABELLED AS PROJECTIONS. `monthProjection` states the pace it
// used, because a month-end figure extrapolated from a quiet fortnight and one
// extrapolated from a busy week are very different claims wearing the same number.

import { COL, dayKeyLocal, monthKeyLocal } from './analytics.js';
import { linearTrend, changePoint, projectToPeriodEnd, mean, foldChange } from './stats.js';
import { activationLagDays } from './analytics-users.js';
import { finding, suppressed, fmtCount, fmtPct } from './findings.js';

const AREA = 'Growth';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Days of history a trend claim needs on each side of any comparison. */
const MIN_DAYS = 14;
/** Renders below which volume is too sparse for any of this to mean anything. */
const MIN_RENDERS = 30;

/** @param {string[]} row @param {number} idx */
function cell(row, idx) {
  return String((row && row[idx]) || '').trim();
}

/**
 * Daily counts over the trailing window, zero-filled, oldest first.
 *
 * Zero-fill is not cosmetic here. A missing day would make the trend fit skip
 * over a dead week entirely, so a product that stopped being used for seven days
 * would show the same slope as one that was used steadily — the gap has to be
 * present as zeros for the maths to see it.
 *
 * Keys are LOCAL days (analytics.js#dayKeyLocal), never UTC: the dashboard is read
 * by a person in one timezone and "today" has to mean their today.
 *
 * @param {string[]} stamps ISO timestamps.
 * @returns {number[]}
 */
function dailySeries(stamps, days, now) {
  /** @type {Record<string, number>} */
  const buckets = {};
  for (let i = days - 1; i >= 0; i--) buckets[dayKeyLocal(new Date(now - i * DAY_MS))] = 0;
  for (const s of stamps) {
    const key = dayKeyLocal(s);
    if (key in buckets) buckets[key] += 1;
  }
  return Object.keys(buckets).sort().map((k) => buckets[k]);
}

/** Render timestamps, header already stripped by the caller. */
function renderStamps(input) {
  return (input.promptRows || []).map((r) => cell(r, COL.PROMPT.TS)).filter(Boolean);
}

/**
 * B1 · Direction of travel, trailing 7 against trailing 28.
 *
 * Two means rather than a regression, because the claim is deliberately coarse —
 * "this week against this month" is a sentence an operator can check by eye,
 * where a slope in renders-per-day-per-day is not. The regression comes back in
 * `trendChangePoint`, where the question genuinely needs it.
 */
const volumeTrend = {
  id: 'growth.volume-trend',
  area: AREA,
  run(input) {
    const stamps = renderStamps(input);
    if (stamps.length < MIN_RENDERS) {
      return suppressed(`Volume trends need ${MIN_RENDERS} renders; there are ${stamps.length}.`);
    }

    const series = dailySeries(stamps, 28, input.now);
    const recent = series.slice(-7);
    const prior = series.slice(0, -7);
    const recentMean = mean(recent);
    const priorMean = mean(prior);
    if (recentMean === null || priorMean === null) return null;

    const change = foldChange(recentMean, priorMean);
    const fit = linearTrend(series);
    const evidence = [
      { label: 'Renders per day, last 7', value: recentMean.toFixed(1) },
      { label: 'Renders per day, the 21 before', value: priorMean.toFixed(1) },
      { label: 'Renders in the window', value: fmtCount(series.reduce((a, b) => a + b, 0)) },
      fit ? { label: 'Trend', value: `${fit.slope >= 0 ? '+' : ''}${fit.slope.toFixed(2)}/day` } : null,
    ].filter(Boolean);

    // A zero prior mean means the product only started being used this week.
    // "Infinitely more than nothing" is not a growth rate, so say the plain thing.
    if (change === null) {
      return finding({
        id: 'growth.volume-trend',
        severity: 'opportunity',
        area: AREA,
        title: `All ${fmtCount(stamps.length)} renders happened in the last week`,
        detail: 'There is no earlier activity to compare against, so this is a starting line rather than a trend.',
        evidence,
        action: 'Check back once there are two full weeks of history — the trend rules start reporting on their own.',
        sample: stamps.length,
        confidence: 'low',
      });
    }

    if (change >= 1.25) {
      return finding({
        id: 'growth.volume-trend',
        severity: 'healthy',
        area: AREA,
        title: `Render volume is up ${fmtPct((change - 1) * 100)} this week`,
        detail: 'The last 7 days are averaging materially more renders per day than the 21 before them. '
          + 'Read this beside the reliability findings — volume growing while a segment fails '
          + 'disproportionately means the failure is reaching more people, not fewer.',
        evidence,
        action: 'Nothing to do — but check the reliability section is clean before pushing for more.',
        sample: stamps.length,
      });
    }
    if (change <= 0.75) {
      return finding({
        id: 'growth.volume-trend',
        severity: 'warning',
        area: AREA,
        title: `Render volume is down ${fmtPct((1 - change) * 100)} this week`,
        detail: 'The last 7 days are averaging materially fewer renders per day than the 21 before them. '
          + 'A drop in usage with no drop in accounts usually means an existing cohort stopped, not that '
          + 'acquisition failed.',
        evidence,
        action: 'Check the reliability findings first — a quiet week that follows a failure spike is usually '
          + 'the same event. If reliability is clean, look at which accounts went quiet in the Revenue section.',
        sample: stamps.length,
      });
    }
    return null;
  },
};

/**
 * B2 · Month-to-date, projected to month end.
 *
 * Projected at the trailing-7 daily rate rather than the month-to-date average,
 * because the average is the wrong pace whenever the month has not been uniform —
 * a fortnight of quiet followed by a busy week projects far too low from its own
 * mean. The card states which pace it used, so the number can be argued with.
 */
const monthProjection = {
  id: 'growth.month-projection',
  area: AREA,
  run(input) {
    const stamps = renderStamps(input);
    if (stamps.length < MIN_RENDERS) return null; // volumeTrend already reported the thin case.

    const now = new Date(input.now);
    const thisMonth = monthKeyLocal(now);
    const elapsedDays = now.getDate();
    const totalDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

    // Two elapsed days is not a month to extrapolate from; the projection would
    // swing wildly on a single busy afternoon.
    if (elapsedDays < 5) return null;

    const inMonth = stamps.filter((s) => monthKeyLocal(s) === thisMonth).length;
    const lastMonthKey = monthKeyLocal(new Date(now.getFullYear(), now.getMonth() - 1, 15));
    const lastMonth = stamps.filter((s) => monthKeyLocal(s) === lastMonthKey).length;

    const recentRate = mean(dailySeries(stamps, 7, input.now));
    const projection = projectToPeriodEnd({
      soFar: inMonth, elapsedUnits: elapsedDays, totalUnits: totalDays, recentRate,
    });
    if (!projection) return null;

    const vsLast = lastMonth > 0 ? foldChange(projection.projected, lastMonth) : null;
    const evidence = [
      { label: 'This month so far', value: fmtCount(inMonth) },
      { label: 'Projected month end', value: fmtCount(Math.round(projection.projected)) },
      { label: 'Pace used', value: `${projection.rate.toFixed(1)}/day (last 7 days)` },
      lastMonth > 0 ? { label: 'Last month', value: fmtCount(lastMonth) } : null,
    ].filter(Boolean);

    const direction = vsLast === null ? null : vsLast >= 1 ? 'ahead of' : 'behind';
    return finding({
      id: 'growth.month-projection',
      severity: vsLast !== null && vsLast < 0.8 ? 'warning' : 'opportunity',
      area: AREA,
      title: vsLast === null
        ? `On pace for ${fmtCount(Math.round(projection.projected))} renders this month`
        : `On pace for ${fmtCount(Math.round(projection.projected))} renders — `
          + `${fmtPct(Math.abs(vsLast - 1) * 100)} ${direction} last month`,
      detail: `${fmtCount(inMonth)} renders in the first ${elapsedDays} days of ${totalDays}. Projected at the `
        + 'last 7 days’ rate rather than the month-to-date average, because a month that has not been '
        + 'uniform projects badly from its own mean.',
      evidence,
      action: vsLast !== null && vsLast < 0.8
        ? 'The month is tracking below the last one. Check whether it is fewer accounts or the same accounts '
          + 'doing less — the Revenue section separates those.'
        : 'Nothing to do — this is a forecast, not a problem.',
      sample: inMonth,
      confidence: elapsedDays >= 14 ? 'medium' : 'low',
    });
  },
};

/**
 * B3 · Did something actually change, and when?
 *
 * The rule that earns its place by staying quiet. `changePoint` scores every
 * candidate split with Welch's t; anything below the threshold here is wobble and
 * produces nothing at all. When it does fire it names a DATE, which is what makes
 * it actionable — a level shift with a date can be matched against a deploy, a
 * campaign, or an outage.
 */
const trendChangePoint = {
  id: 'growth.change-point',
  area: AREA,
  run(input) {
    const stamps = renderStamps(input);
    if (stamps.length < MIN_RENDERS * 2) return null;

    const days = 60;
    const series = dailySeries(stamps, days, input.now);
    const step = changePoint(series, MIN_DAYS / 2);
    // 3.5 is chosen to be clearly past the noise a weekday rhythm produces; the
    // primitive deliberately does not threshold, so the number lives here beside
    // the consequence.
    if (!step || step.score < 3.5) return null;

    const daysAgo = series.length - step.index;
    const when = new Date(input.now - daysAgo * DAY_MS);
    const rose = step.delta > 0;
    const magnitude = foldChange(step.after, step.before);

    return finding({
      id: 'growth.change-point',
      severity: rose ? 'healthy' : 'warning',
      area: AREA,
      title: `Render volume ${rose ? 'stepped up' : 'stepped down'} about ${daysAgo} days ago`,
      detail: `Daily volume averaged ${step.before.toFixed(1)} before ${dayKeyLocal(when)} and `
        + `${step.after.toFixed(1)} after it. This is a level shift rather than a gradual trend, which is why `
        + 'it is worth a date: a step usually has a single cause you can name.',
      evidence: [
        { label: 'Before', value: `${step.before.toFixed(1)} renders/day` },
        { label: 'After', value: `${step.after.toFixed(1)} renders/day` },
        { label: 'Changed around', value: dayKeyLocal(when) },
        magnitude ? { label: 'Change', value: `${rose ? '+' : ''}${fmtPct((magnitude - 1) * 100)}` } : null,
      ].filter(Boolean),
      action: `Check what shipped or launched around ${dayKeyLocal(when)} — a deploy, a campaign link, or an `
        + 'outage. The Referrals tab dates campaign traffic, and the Server status tab dates incidents.',
      sample: stamps.length,
      confidence: 'medium',
    });
  },
};

/**
 * B4 · How long a new account takes to produce its first render.
 *
 * Measured only over accounts that DID activate. Folding in the ones that never
 * did as some large number would conflate a slow onboarding with a dead signup —
 * two different problems with two different fixes — and would move the median
 * every time an unrelated batch of tyre-kickers arrived. The never-activated
 * share is `neverActivated` below.
 */
const activationLag = {
  id: 'growth.activation-lag',
  area: AREA,
  run(input) {
    const lag = activationLagDays(input.users || [], input.index || { firstRenderByEmail: {} });
    const MIN = 10;
    if (lag.sample < MIN) {
      return suppressed(`Time-to-first-render needs ${MIN} activated accounts with a signup date; there are ${lag.sample}.`);
    }
    const med = /** @type {number} */ (lag.median);

    const evidence = [
      { label: 'Median time to first render', value: med < 1 ? 'same day' : `${med.toFixed(1)} days` },
      { label: 'Measured over', value: `${fmtCount(lag.sample)} activated accounts` },
    ];

    if (med <= 1) {
      return finding({
        id: 'growth.activation-lag',
        severity: 'healthy',
        area: AREA,
        title: 'New accounts stage something on their first day',
        detail: 'The median account produces its first render within a day of signing up, so nothing in the '
          + 'signup path is standing between people and the product.',
        evidence,
        action: 'Nothing to do.',
        sample: lag.sample,
      });
    }
    if (med >= 3) {
      return finding({
        id: 'growth.activation-lag',
        severity: 'opportunity',
        area: AREA,
        title: `New accounts take ${med.toFixed(1)} days to stage anything`,
        detail: 'A gap between signing up and the first render is the cheapest thing on this page to shorten: '
          + 'these people already wanted the product enough to make an account. Note this can only be measured '
          + 'over renders that logged an email, so it is a sample rather than a census.',
        evidence,
        action: 'Look at what the first session actually asks for. The trial welcome email '
          + '(lib/services/lifecycle-emails.js) is the one lever already built for this.',
        sample: lag.sample,
        confidence: 'medium',
      });
    }
    return null;
  },
};

/**
 * B5 · Accounts that have never rendered anything.
 *
 * Uses the METRICS pack when it is available, and says which source it used.
 * That distinction is the whole point of the rule: `staged_renders.user_id` comes
 * from the validated session, so counting there is a COUNT. The CSV's email comes
 * from the request body and is `unknown` whenever the client didn't send one, so
 * counting there is a FLOOR — it will always overstate how many accounts look
 * dead. Reporting which one produced the number is what keeps the card honest.
 */
const neverActivated = {
  id: 'growth.never-activated',
  area: AREA,
  run(input) {
    const users = input.users || [];
    const MIN = 15;
    if (users.length < MIN) {
      return suppressed(`The activation rate needs ${MIN} accounts; there are ${users.length}.`);
    }

    const metrics = input.metrics;
    const groundTruth = Boolean(metrics && metrics.renders && Number.isFinite(metrics.renders.distinctUsers));
    const activated = groundTruth
      ? metrics.renders.distinctUsers
      : users.filter((u) => (input.index && input.index.rendersByEmail[String(u.email || '').toLowerCase()]) > 0).length;

    const never = Math.max(0, users.length - activated);
    const pct = (never / users.length) * 100;

    const evidence = [
      { label: 'Accounts', value: fmtCount(users.length) },
      { label: 'Have rendered', value: fmtCount(activated) },
      { label: 'Never rendered', value: `${fmtCount(never)} (${fmtPct(pct)})` },
      {
        label: 'Source',
        value: groundTruth
          ? 'staged_renders.user_id — a count'
          : 'the render log’s email — a floor, so this overstates',
      },
    ];

    if (pct >= 40) {
      return finding({
        id: 'growth.never-activated',
        severity: groundTruth ? 'warning' : 'opportunity',
        area: AREA,
        title: `${fmtPct(pct)} of accounts have never staged anything`,
        detail: groundTruth
          ? 'Counted against the gallery, whose user id comes from the validated session, so this is a real '
            + 'count rather than the floor the render log can give. That many dormant accounts is a bigger '
            + 'pool than most acquisition work would add.'
          : 'Counted from the render log’s email column, which is empty whenever the client did not send '
            + 'one — so the true figure is LOWER than this. Load the metrics endpoint for the real count.',
        evidence,
        action: 'These accounts already signed up. Work out what stopped them at the first render before '
          + 'spending on more signups — the time-to-first-render finding is the other half of this picture.',
        sample: users.length,
        confidence: groundTruth ? 'high' : 'low',
      });
    }
    if (pct <= 15 && groundTruth) {
      return finding({
        id: 'growth.never-activated',
        severity: 'healthy',
        area: AREA,
        title: `${fmtPct(100 - pct)} of accounts have staged something`,
        detail: 'Almost everyone who signs up uses the product at least once, counted against the gallery '
          + 'rather than the render log, so this is a count and not a floor.',
        evidence,
        action: 'Nothing to do.',
        sample: users.length,
      });
    }
    return null;
  },
};

export const GROWTH_RULES = [
  volumeTrend,
  monthProjection,
  trendChangePoint,
  activationLag,
  neverActivated,
];
