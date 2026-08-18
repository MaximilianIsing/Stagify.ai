// Measurement-quality rules: which numbers on this dashboard cannot be trusted,
// and exactly why.
//
// WHY THIS SECTION EXISTS AT ALL
//
// Every other rule file answers a question about the product. This one answers a
// question about the instruments, and it is here because the dashboard has
// already been wrong in ways that looked completely fine:
//
//   - Two Insights cards ("User roles", "Referral sources") read columns that
//     NOTHING WRITES. They render an empty state, which is indistinguishable
//     from "no answers yet" — so a chart that can never contain data looks like
//     a chart that is merely waiting for some.
//   - Roughly two thirds of render rows log `email=unknown`, so the activation
//     funnel and cohort grid are documented as "a floor, not a count". A floor
//     read as a count says a healthy product has terrible retention.
//   - The outcome columns were appended part-way through the log's life, so
//     every render before that date has no verdict at all.
//
// None of those are bugs in an aggregator. They are gaps between what the
// dashboard appears to measure and what it can measure, and the only defence is
// to state them on the same page as the numbers they undermine.
//
// SEVERITY IS ALWAYS 'quality' HERE, never critical. These are not incidents;
// they are the caveats that decide how much weight everything above deserves.
// Ranking them as alarms would train the operator to scroll past the section
// that explains the rest of the page.

import { COL } from './analytics.js';
import { attributionCoverage } from './analytics-users.js';
import { ratio } from './stats.js';
import { finding, fmtCount, fmtPct, fmtBytes } from './findings.js';

const AREA = 'Measurement';

/** @param {string[]} row @param {number} idx */
function cell(row, idx) {
  return String((row && row[idx]) || '').trim();
}

/** True for the sentinels the writers use when they have no identity. */
function isRealId(v) {
  const s = String(v || '').trim().toLowerCase();
  return Boolean(s) && s !== 'unknown';
}

/**
 * D1 · Columns that are recorded but never written.
 *
 * Checked against the DATA rather than hard-coded, so this rule retires itself
 * the moment a capture is wired up. Hard-coding "these two charts are dead" would
 * leave a card asserting a fact that had quietly stopped being true — which is
 * the exact failure mode the whole section exists to prevent.
 *
 * The two mechanisms are different and the card says so:
 *   - prompt_logs cols 5/6 are written on every row, always as 'unknown'/''.
 *     public/scripts/app/staging-pipeline.js reads them from localStorage keys
 *     that nothing in public/ ever writes.
 *   - contact_logs has no writer at all: nothing in public/ posts to
 *     /api/log-contact, so the file may not even exist.
 */
const inertColumns = {
  id: 'quality.inert-columns',
  area: AREA,
  run(input) {
    const promptRows = input.promptRows || [];
    const contactRows = input.contactRows || [];
    const MIN = 20;
    if (promptRows.length < MIN) return null;

    const dead = [];

    const roleFilled = promptRows.filter((r) => isRealId(cell(r, COL.PROMPT.ROLE))).length;
    const referralFilled = promptRows.filter((r) => isRealId(cell(r, COL.PROMPT.REFERRAL))).length;
    if (roleFilled === 0) dead.push({ label: 'prompt_logs · userRole (col 6)', value: 'always "unknown"' });
    if (referralFilled === 0) dead.push({ label: 'prompt_logs · referralSource (col 7)', value: 'always empty' });
    if (!contactRows.length) {
      dead.push({ label: 'contact_logs.csv', value: 'no rows — nothing posts to /api/log-contact' });
    }

    if (!dead.length) return null;

    const affected = [];
    if (!contactRows.length) affected.push('“User roles”', '“Referral sources”');
    return finding({
      id: 'quality.inert-columns',
      area: AREA,
      severity: 'quality',
      title: `${dead.length} onboarding field${dead.length === 1 ? ' is' : 's are'} recorded but never filled in`,
      detail: 'These columns exist in the log format and are written on every row, but nothing in the '
        + 'front-end ever supplies a value — so they have never carried data. The charts built on them are '
        + 'not waiting for more usage; they are decorative until a capture is added. That distinction is '
        + 'invisible on the chart itself, which just shows an empty state.'
        + (affected.length ? ` Affects the ${affected.join(' and ')} cards on the Insights tab.` : ''),
      evidence: dead,
      action: 'Either wire up the onboarding capture that fills these, or drop the cards that read them. '
        + 'A chart that can never contain data is worse than no chart, because it reads as a measurement.',
      sample: promptRows.length,
      confidence: 'high',
    });
  },
};

/**
 * D2 · How much of the render log can be tied to an account — measured, not caveated.
 *
 * This is the rule that most justifies the metrics endpoint existing. The CSV's
 * `email` comes from the request BODY and is `unknown` whenever the client did
 * not send one. `staged_renders.user_id` comes from the VALIDATED session and
 * cannot be. So with both in hand the gap stops being a warning label and becomes
 * a number: the log attributes N, the database attributes M, and every funnel on
 * the Insights tab is missing the difference.
 *
 * Without the metrics pack the rule still fires, but says only what the Insights
 * tab already says — and marks its own confidence low to make that clear.
 */
const attributionGap = {
  id: 'quality.attribution-gap',
  area: AREA,
  run(input) {
    const promptRows = input.promptRows || [];
    if (promptRows.length < 20) return null;

    const coverage = attributionCoverage(promptRows);
    if (coverage.pct >= 95) return null; // Nothing meaningful is being lost.

    const metrics = input.metrics;
    const dbTotal = metrics && metrics.renders ? Number(metrics.renders.total) : null;
    const dbUsers = metrics && metrics.renders ? Number(metrics.renders.distinctUsers) : null;
    const haveGroundTruth = Number.isFinite(dbTotal) && Number.isFinite(dbUsers) && dbTotal > 0;

    const evidence = [
      { label: 'Renders in the log', value: fmtCount(coverage.total) },
      { label: 'Tied to an account', value: `${fmtCount(coverage.attributed)} (${fmtPct(coverage.pct)})` },
      { label: 'Anonymous', value: fmtCount(coverage.total - coverage.attributed) },
    ];
    if (haveGroundTruth) {
      evidence.push({ label: 'Renders in the gallery (session-keyed)', value: fmtCount(/** @type {number} */(dbTotal)) });
      evidence.push({ label: 'Accounts that have rendered', value: fmtCount(/** @type {number} */(dbUsers)) });
    }

    return finding({
      id: 'quality.attribution-gap',
      area: AREA,
      severity: 'quality',
      title: `${fmtPct(100 - coverage.pct)} of renders cannot be tied to an account`,
      detail: haveGroundTruth
        ? 'The render log takes its email from the request body, so it is empty whenever the client did not '
          + 'send one. The gallery takes its user id from the validated session and cannot be. Every '
          + 'per-account number derived from the log — the activation funnel, cohort retention, top users — '
          + 'is therefore missing this share of real usage, and reads as worse than reality. The gallery '
          + 'figures beside it are the ones to trust when the two disagree.'
        : 'The render log takes its email from the request body, so it is empty whenever the client did not '
          + 'send one. Every per-account number derived from it — the funnel, cohorts, top users — is a '
          + 'FLOOR rather than a count. Load the metrics endpoint to see the session-keyed figures beside it.',
      evidence,
      action: 'Key the logged email off the validated session rather than the request body when writing '
        + 'prompt_logs.csv. Until then, read the funnel and cohort cards as lower bounds.',
      sample: coverage.total,
      confidence: haveGroundTruth ? 'high' : 'low',
    });
  },
};

/**
 * D3 · Renders with no recorded outcome.
 *
 * The outcome columns were appended on 2026-07-26; every render before that has
 * empty cells. `withOutcome` excludes them everywhere, which is correct — but it
 * means the success rate is measured over a subset, and if that subset is small
 * the rate is a claim about recent history wearing an all-time label.
 */
const outcomeCoverage = {
  id: 'quality.outcome-coverage',
  area: AREA,
  run(input) {
    const rows = input.promptRows || [];
    if (rows.length < 20) return null;

    const recorded = rows.filter((r) => {
      const s = cell(r, COL.PROMPT.STATUS).toLowerCase();
      return s === 'ok' || s === 'failed';
    }).length;
    const share = ratio(recorded, rows.length);
    if (share === null || share >= 0.9) return null;

    return finding({
      id: 'quality.outcome-coverage',
      area: AREA,
      severity: 'quality',
      title: `Only ${fmtPct(share * 100)} of renders recorded whether they worked`,
      detail: 'The outcome columns were added to the log part-way through its life, so older rows carry no '
        + 'verdict. Those rows are excluded from the success rate rather than counted either way — treating '
        + 'them as failures would paint a fake error spike across the whole history, and treating them as '
        + 'successes would hide a live outage behind old data. The consequence is that every reliability '
        + 'number is measured over the recent subset only.',
      evidence: [
        { label: 'Rows with an outcome', value: `${fmtCount(recorded)} of ${fmtCount(rows.length)}` },
        { label: 'No verdict recorded', value: fmtCount(rows.length - recorded) },
      ],
      action: 'Nothing to fix — this shrinks on its own as new renders accumulate. It matters only when '
        + 'reading a reliability number as though it covered all time.',
      sample: rows.length,
      confidence: 'high',
    });
  },
};

/**
 * D4 · Stripe webhook handlers that died mid-flight.
 *
 * A `processing` row older than the reclaim window means a handler was killed
 * before it released its claim. The ledger self-heals — the next delivery
 * re-claims it — so this is not an outage. A GROWING count is a crashing handler,
 * and nothing else in the product reports one: a webhook that fails silently
 * leaves a subscription state that never got applied.
 */
const webhookHealth = {
  id: 'quality.webhook-health',
  area: AREA,
  run(input) {
    const health = input.metrics && input.metrics.health;
    if (!health) return null;
    const stuck = Number(health.stuckStripeEvents) || 0;
    if (stuck === 0) return null;

    const minutes = Math.round((Number(health.stripeReclaimMs) || 0) / 60000);
    return finding({
      id: 'quality.webhook-health',
      area: AREA,
      severity: 'quality',
      title: `${fmtCount(stuck)} Stripe webhook${stuck === 1 ? '' : 's'} stopped part-way through`,
      detail: `These events were claimed and never completed, and have been sitting longer than the `
        + `${minutes}-minute reclaim window. The ledger recovers on Stripe's next delivery attempt, so this `
        + 'is not an outage — but a handler that dies mid-flight may have applied half a subscription change, '
        + 'and nothing else on this dashboard would show that.',
      evidence: [
        { label: 'Abandoned claims', value: fmtCount(stuck) },
        { label: 'Reclaim window', value: `${minutes} minutes` },
      ],
      action: 'Search the server logs for a throw inside the Stripe webhook handler. If the count keeps '
        + 'growing between refreshes, it is a live crash rather than the residue of a restart.',
      sample: stuck,
      confidence: 'medium',
    });
  },
};

/**
 * D5 · Object-store deletions that are not going through.
 *
 * The reaper drains tombstones best-effort. A row with several failed attempts is
 * a blob nobody can delete — which is a bill that keeps arriving for data that
 * was supposed to be gone, and after an account erasure it is also data that was
 * supposed to be gone for a legal reason.
 */
const reaperBacklog = {
  id: 'quality.reaper-backlog',
  area: AREA,
  run(input) {
    const health = input.metrics && input.metrics.health;
    if (!health) return null;
    const failing = Number(health.tombstonesFailing) || 0;
    const backlog = Number(health.tombstoneBacklog) || 0;
    if (failing === 0) return null;

    return finding({
      id: 'quality.reaper-backlog',
      area: AREA,
      severity: 'quality',
      title: `${fmtCount(failing)} stored file${failing === 1 ? '' : 's'} cannot be deleted`,
      detail: 'These object-store keys have been retried several times and still fail. The bytes stay billable, '
        + 'and where a deletion came from an account erasure they are also data that was meant to be gone. '
        + 'The reaper will keep retrying indefinitely, so this does not clear itself.',
      evidence: [
        { label: 'Repeatedly failing', value: fmtCount(failing) },
        { label: 'Total pending deletion', value: fmtCount(backlog) },
        health.lastTombstoneError
          ? { label: 'Most recent error', value: String(health.lastTombstoneError).slice(0, 120) }
          : null,
      ].filter(Boolean),
      action: 'The error above usually names the cause — credentials, a bucket policy, or a key that no '
        + 'longer exists. A key already gone from the bucket can be dropped from the queue safely.',
      sample: backlog,
      confidence: 'high',
    });
  },
};

/**
 * D6 · CSV logs approaching the size at which they stop recording.
 *
 * The failure mode is silent by design in two different ways, which is why it
 * needs a card rather than an alert: a log with a ceiling STOPS GROWING rather
 * than rotating (truncating would rewrite history, and prompt_logs.csv seeds a
 * public counter), and `email_open_logs.csv` stops tracking at its own limits
 * without any error anywhere. In both cases the dashboard keeps drawing charts
 * that are quietly frozen.
 *
 * A log with no ceiling is reported too, at a size worth noticing, because an
 * unbounded file sharing a volume with SQLite's WAL takes auth and billing down
 * with it when the disk fills.
 */
const logCeilings = {
  id: 'quality.log-ceilings',
  area: AREA,
  run(input) {
    // Array.isArray, not `|| []`. The pack arrives over the wire, and a truthy
    // non-array (a string, an object) satisfies `||` and then throws on .filter —
    // which in this engine means the rule is dropped and its absence is invisible.
    const logs = input.metrics && input.metrics.logs;
    if (!Array.isArray(logs) || !logs.length) return null;

    const WARN_SHARE = 0.8;
    const UNBOUNDED_WARN = 256 * 1024 * 1024;

    const nearCeiling = logs.filter((l) => l.ceiling && l.bytes >= l.ceiling * WARN_SHARE);
    const bigUnbounded = logs.filter((l) => !l.ceiling && l.bytes >= UNBOUNDED_WARN);
    if (!nearCeiling.length && !bigUnbounded.length) return null;

    const rows = [...nearCeiling, ...bigUnbounded];
    return finding({
      id: 'quality.log-ceilings',
      area: AREA,
      severity: 'quality',
      title: nearCeiling.length
        ? `${fmtCount(nearCeiling.length)} log file${nearCeiling.length === 1 ? ' is' : 's are'} near the size where it stops recording`
        : `${fmtCount(bigUnbounded.length)} log file${bigUnbounded.length === 1 ? ' is' : 's are'} growing without a limit`,
      detail: 'A log at its ceiling stops accepting rows — it does not rotate and it does not truncate, '
        + 'because rewriting it would rewrite history. Nothing errors when that happens; the charts built on '
        + 'the file simply stop moving, which looks exactly like a quiet week. A log with no ceiling at all '
        + 'shares its volume with the SQLite WAL, so a full disk takes auth and billing with it.',
      evidence: rows.map((l) => ({
        label: l.name,
        value: l.ceiling
          ? `${fmtBytes(l.bytes)} of ${fmtBytes(l.ceiling)} (${fmtPct((l.bytes / l.ceiling) * 100)})`
          : `${fmtBytes(l.bytes)}, no ceiling`,
      })),
      action: 'Archive the file off the volume before it stops recording, or raise its ceiling by env var. '
        + 'Do not truncate prompt_logs.csv — it seeds the public "Rooms Staged" counter at boot.',
      sample: rows.length,
      confidence: 'high',
    });
  },
};

/**
 * D7 · The metrics endpoint itself is unavailable.
 *
 * Reported because its absence silently degrades several rules above from a count
 * to a floor, and from "high confidence" to "low". Without this card the tab
 * would simply look thinner than usual, with no indication that half its ground
 * truth was missing.
 */
const metricsUnavailable = {
  id: 'quality.metrics-unavailable',
  area: AREA,
  run(input) {
    if (input.metrics) return null;
    return finding({
      id: 'quality.metrics-unavailable',
      area: AREA,
      severity: 'quality',
      title: 'Session-keyed metrics are unavailable, so some findings are lower bounds',
      detail: 'GET /api/admin/metrics did not return data, so the rules that would normally read the gallery '
        + 'tables fell back to the render log. Anything counted per account is therefore a floor rather than '
        + 'a count, and the share, storage and webhook findings cannot run at all.',
      evidence: [
        { label: 'Affected', value: 'never-activated, attribution gap' },
        { label: 'Unavailable', value: 'share engagement, storage cost, webhook and reaper health' },
      ],
      action: 'Check the server log for an admin.metrics error reference. Everything else on this tab is '
        + 'computed in the browser and is unaffected.',
      sample: 0,
      confidence: 'high',
    });
  },
};

export const QUALITY_RULES = [
  inertColumns,
  attributionGap,
  outcomeCoverage,
  webhookHealth,
  reaperBacklog,
  logCeilings,
  metricsUnavailable,
];
