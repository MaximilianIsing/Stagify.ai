// The analyst's tools, executed here in the browser against the data the console
// already holds.
//
// WHY THE EXECUTION IS ON THIS SIDE. `lib/services/admin-analyst-tools.js` holds
// the schemas and explains the split at length; the short version is that
// `analytics.js`, `analytics-users.js` and `analytics-rejections.js` are already
// the tested single source of truth for every number on this dashboard, and a
// second server-side implementation of the same arithmetic would eventually
// disagree with the chart directly above the answer.
//
// THREE RULES EVERY EXECUTOR KEEPS
//
// 1. **No identity, ever.** Rows are counts and rates. Where a specific account is
//    the answer it appears as an `acct_*` handle from analyst-identity.js, and the
//    real address is substituted only when the answer is painted. No email, IP,
//    prompt text or chat message goes into a tool result. A sweep over every
//    executor asserts this in test/frontend/admin/admin-analyst.test.js.
// 2. **Caveats travel with the numbers.** Every result carries a `caveats` array,
//    and the system prompt tells the model to repeat any that bear on its answer.
//    This is the mechanism by which the three places "absent must not read as
//    zero" (docs/guides/admin-dashboard.md) survive being handed to a model that
//    has never read that document — attribution through the render log is a floor,
//    an unrecorded outcome is not a success, and a cohort month that has not
//    elapsed is not 0%.
// 3. **Null is not zero.** An unmeasurable rate is `null` in the payload, exactly
//    as `successRate().pct` is, and the prompt tells the model what that means.
//
// Every executor is synchronous and pure over the bag it is given, so the whole
// file is testable with no DOM and no network.

import {
  COL, stripHeader, withOutcome, successRate, durationStats, dailyCounts,
  startOfDaysAgo, categoryKey, allTimeCounts,
} from './analytics.js';
import {
  activationFunnel, cohortRetention, paidConversion, activationLagDays, attributionCoverage,
  atRiskPayingAccounts, payingAccounts, expiringCompGrants, daysSinceActive, activityIndexFrom,
} from './analytics-users.js';
import { rejectionMix, topReasons, rejectionsByDay } from './analytics-rejections.js';
import { wilsonInterval, foldChange, linearTrend, median } from './stats.js';
import { MIN_AFFECTED } from './findings.js';
import { errorMessage } from '../shared/error-message.js';

/** Default window when the model does not name one. Matches the Overview default. */
const DEFAULT_DAYS = 30;
/** Default row cap. Enough to reason over, small enough to keep a turn cheap. */
const DEFAULT_LIMIT = 10;

/** The prompt_logs column behind each segment field the schema offers. @type {Record<string, number>} */
const SEGMENT_COL = {
  roomType: COL.PROMPT.ROOM,
  furnitureStyle: COL.PROMPT.STYLE,
  model: COL.PROMPT.MODEL,
  errorCode: COL.PROMPT.ERROR,
  removeFurniture: COL.PROMPT.REMOVE,
};

/** Arguments as the model sent them: untrusted JSON, so every read is clamped or coerced. @typedef {Record<string, unknown> | null | undefined} ToolArgs */

/** Caveats reused across tools, written once so they cannot drift apart. */
const CAVEAT = {
  attribution: 'Render rows carry an email from the REQUEST BODY, which is "unknown" whenever the client did not '
    + 'send one. Anything counted per-account off the render log is a floor, not a count.',
  unrecorded: (/** @type {number} */ n) => `${n} render(s) in this window predate outcome logging and have no status. They are excluded `
    + 'rather than counted as successes — do not treat them as either.',
  smallSegment: `Segments with fewer than ${MIN_AFFECTED} failures are shown for completeness but their rates are `
    + 'noise; the 95% interval on each one says how much.',
  cohortBlank: 'Cohort months that have not elapsed yet are null, not 0% — a young cohort has not failed to retain.',
};

/** Clamp a model-supplied day count into the range the schema promises. @param {ToolArgs} args */
function windowDays(args) {
  const n = Number(args && args.days);
  return Number.isFinite(n) ? Math.min(365, Math.max(1, Math.round(n))) : DEFAULT_DAYS;
}

/** Clamp a model-supplied row cap. @param {ToolArgs} args */
function rowLimit(args, max = 25) {
  const n = Number(args && args.limit);
  return Number.isFinite(n) ? Math.min(max, Math.max(1, Math.round(n))) : DEFAULT_LIMIT;
}

/** @param {string[]} row @param {number} idx */
function cell(row, idx) {
  return String((row && row[idx]) || '').trim();
}

/** Rows whose timestamp falls inside the window. @param {string[][]} rows @param {number} idx @param {number} days */
function withinDays(rows, idx, days) {
  const cutoff = startOfDaysAgo(days).getTime();
  return (rows || []).filter((r) => {
    const t = Date.parse(cell(r, idx));
    return Number.isFinite(t) && t >= cutoff;
  });
}

/** A rate to one decimal, or null when the denominator is empty. @param {number} n @param {number} d */
function pct(n, d) {
  return d > 0 ? Number(((n / d) * 100).toFixed(2)) : null;
}

/**
 * Build the executors.
 *
 * @param {object} deps
 * @param {import('./types.js').AdminCtx} deps.ctx Shared dashboard state — read through, never captured.
 * @param {ReturnType<import('./analyst-identity.js').createIdentityMap>} deps.identity
 * @param {() => {findings: import('./findings.js').Finding[], failed: string[]}} deps.currentFindings The memoized rules-engine run.
 * @param {import('./types.js').EffectivePlan} deps.effectivePlan Plan resolver that folds in enterprise domains.
 */
export function createAnalystTools({ ctx, identity, currentFindings, effectivePlan }) {
  /** Header-stripped tables, once per call rather than once per branch. */
  function tables() {
    const d = ctx.data || /** @type {Partial<import('./types.js').AdminData>} */ ({});
    return {
      prompt: stripHeader(d.promptRows || []),
      chat: stripHeader(d.chatRows || []),
      mask: stripHeader(d.maskRows || []),
      rejection: stripHeader(d.rejectionRows || []),
      contact: stripHeader(d.contactRows || []),
      users: d.users || [],
      metrics: d.metrics || null,
    };
  }
  /** @typedef {ReturnType<typeof tables>} Tables */

  /** The timestamp stream behind each countable metric the schema offers. @param {string} metric @param {Tables} t @returns {string[]} */
  function timestampsFor(metric, t) {
    if (metric === 'renders') return t.prompt.map((r) => cell(r, COL.PROMPT.TS));
    if (metric === 'failures') {
      return withOutcome(t.prompt)
        .filter((r) => cell(r, COL.PROMPT.STATUS).toLowerCase() === 'failed')
        .map((r) => cell(r, COL.PROMPT.TS));
    }
    if (metric === 'signups') return /** @type {string[]} */ (t.users.map((u) => u && u.createdAt).filter(Boolean));
    if (metric === 'chats') return t.chat.map((r) => cell(r, COL.CHAT.TS));
    if (metric === 'maskEdits') return t.mask.map((r) => cell(r, COL.MASK.TS));
    if (metric === 'rejections') return t.rejection.map((r) => cell(r, COL.REJECTION.TS));
    return [];
  }

  // ── The executors ─────────────────────────────────────────────────────────

  /** @param {ToolArgs} args */
  function segmentBreakdown(args) {
    const t = tables();
    const field = String((args && args.field) || 'roomType');
    const index = SEGMENT_COL[field];
    if (index === undefined) return { error: `Unknown field "${field}".` };

    const days = windowDays(args);
    const scoped = withinDays(t.prompt, COL.PROMPT.TS, days);
    const recorded = withOutcome(scoped);
    if (!recorded.length) {
      return { rows: [], unit: 'renders', caveats: ['No render in this window recorded an outcome, so no rate is computable.'] };
    }

    const totalFailed = recorded.filter((r) => cell(r, COL.PROMPT.STATUS).toLowerCase() === 'failed').length;

    /** @type {Record<string, {label: string, total: number, failed: number}>} */
    const groups = {};
    for (const r of recorded) {
      const raw = cell(r, index);
      const key = categoryKey(raw);
      if (!key || key === 'unknown') continue;
      const g = groups[key] || (groups[key] = { label: raw, total: 0, failed: 0 });
      g.total += 1;
      if (cell(r, COL.PROMPT.STATUS).toLowerCase() === 'failed') g.failed += 1;
    }

    const rows = Object.values(groups)
      .sort((a, b) => b.total - a.total)
      .slice(0, rowLimit(args))
      .map((g) => {
        const ci = wilsonInterval(g.failed, g.total);
        // The baseline each segment is measured against EXCLUDES that segment, for
        // the same reason the rules engine does it: a segment inside its own
        // baseline shrinks exactly the gap that matters most.
        const restTotal = recorded.length - g.total;
        const restRate = restTotal > 0 ? (totalFailed - g.failed) / restTotal : null;
        return {
          segment: g.label,
          renders: g.total,
          failed: g.failed,
          failureRatePct: pct(g.failed, g.total),
          restOfProductRatePct: restRate === null ? null : Number((restRate * 100).toFixed(2)),
          ci95Pct: ci ? [Number((ci.lower * 100).toFixed(2)), Number((ci.upper * 100).toFixed(2))] : null,
          atLeastXWorse: ci && restRate ? foldChange(ci.lower, restRate) : null,
        };
      });

    return {
      rows,
      unit: 'renders',
      window: `${days} days`,
      totals: { renders: recorded.length, failed: totalFailed, failureRatePct: pct(totalFailed, recorded.length) },
      caveats: [CAVEAT.smallSegment, CAVEAT.unrecorded(scoped.length - recorded.length)],
    };
  }

  /** @param {ToolArgs} args */
  function timeSeries(args) {
    const t = tables();
    const metric = String((args && args.metric) || 'renders');
    const days = windowDays(args);
    const stamps = timestampsFor(metric, t);
    // Past ~90 days a daily series is more points than anyone can read; the
    // console's own auto-bucketer picks the granularity the charts would use, so a
    // long window comes back weekly or monthly rather than as 365 rows.
    const bucketed = days > 90 ? allTimeCounts(stamps) : null;
    const points = bucketed ? bucketed.points : dailyCounts(stamps, days);
    const values = points.map((p) => p.value);
    return {
      rows: points.map((p) => ({ bucket: p.key, count: p.value })),
      unit: metric,
      window: `${days} days`,
      granularity: bucketed ? bucketed.granularity : 'day',
      totals: { total: values.reduce((a, b) => a + b, 0), busiest: Math.max(0, ...values), typicalDay: median(values) },
      caveats: ['Buckets are zero-filled and keyed to the reader\'s LOCAL timezone, so they align with the console\'s charts.'],
    };
  }

  /** @param {ToolArgs} args */
  function compareWindows(args) {
    const t = tables();
    const metric = String((args && args.metric) || 'renders');
    const days = windowDays(args);
    const stamps = timestampsFor(metric, t).map((s) => Date.parse(s)).filter(Number.isFinite);

    const now = Date.now();
    const span = days * 24 * 60 * 60 * 1000;
    const recent = stamps.filter((t2) => t2 >= now - span).length;
    const prior = stamps.filter((t2) => t2 >= now - 2 * span && t2 < now - span).length;

    const points = dailyCounts(
      timestampsFor(metric, t).filter((s) => Date.parse(s) >= now - span),
      Math.min(days, 90),
    );
    const trend = linearTrend(points.map((p) => p.value));

    return {
      rows: [
        { window: `last ${days}d`, count: recent },
        { window: `previous ${days}d`, count: prior },
      ],
      unit: metric,
      totals: {
        foldChange: foldChange(recent, prior),
        changePct: prior > 0 ? Number((((recent - prior) / prior) * 100).toFixed(1)) : null,
        trendSlopePerDay: trend ? Number(trend.slope.toFixed(3)) : null,
        trendR2: trend ? Number(trend.r2.toFixed(3)) : null,
      },
      caveats: [
        prior === 0
          ? 'The previous window is empty, so no fold change is computable — that is null, not an infinite increase.'
          : 'Both windows are the same length, so the counts are directly comparable.',
      ],
    };
  }

  /** @param {ToolArgs} args */
  function renderOutcomes(args) {
    const t = tables();
    const days = windowDays(args);
    const scoped = withinDays(t.prompt, COL.PROMPT.TS, days);
    const rate = successRate(scoped);
    const durations = durationStats(scoped);
    const attempts = withOutcome(scoped)
      .map((r) => Number(cell(r, COL.PROMPT.ATTEMPTS)))
      .filter((v) => Number.isFinite(v) && v > 0);

    return {
      rows: [
        { outcome: 'ok', count: rate.ok },
        { outcome: 'failed', count: rate.failed },
      ],
      unit: 'renders',
      window: `${days} days`,
      totals: {
        recorded: rate.recorded,
        unrecorded: rate.unrecorded,
        successRatePct: rate.pct === null ? null : Number(rate.pct.toFixed(2)),
        p50Ms: durations.p50,
        p90Ms: durations.p90,
        p95Ms: durations.p95,
        meanAttempts: attempts.length ? Number((attempts.reduce((a, b) => a + b, 0) / attempts.length).toFixed(3)) : null,
      },
      caveats: [
        CAVEAT.unrecorded(rate.unrecorded),
        'Duration percentiles cover SUCCESSFUL renders only — a render that failed fast would otherwise flatter them.',
        rate.pct === null ? 'No outcome was recorded in this window, so the success rate is null rather than 100%.' : '',
      ].filter(Boolean),
    };
  }

  /** @param {ToolArgs} args */
  function rejectionBreakdown(args) {
    const t = tables();
    const days = windowDays(args);
    const scoped = withinDays(t.rejection, COL.REJECTION.TS, days);
    const kind = args && args.kind ? String(args.kind) : null;

    const rows = kind
      ? topReasons(scoped, kind, { top: rowLimit(args) }).map((s) => ({ reason: s.label, count: s.value }))
      : rejectionMix(scoped).map((s) => ({ kind: s.label, count: s.value }));

    const perDay = rejectionsByDay(scoped, Math.min(days, 90));
    return {
      rows,
      unit: 'refusals',
      window: `${days} days`,
      totals: { refusals: scoped.length, busiestDay: Math.max(0, ...perDay.map((p) => p.value)) },
      caveats: [
        'These requests were refused BEFORE a render ran, so they are deliberately not rows in the render log and '
        + 'are invisible to every other tool here. They do not affect the success rate.',
      ],
    };
  }

  function funnelAndRetention() {
    const t = tables();
    const index = activityIndex();
    const funnel = activationFunnel(t.users, index);
    const cohorts = cohortRetention(t.users, t.prompt, Date.now());
    const coverage = attributionCoverage(t.prompt);
    const lag = activationLagDays(t.users, index);

    return {
      rows: funnel.map((s) => ({ step: s.label, accounts: s.value })),
      unit: 'accounts',
      totals: {
        paidConversionPct: t.users.length ? Number(paidConversion(t.users, effectivePlan).pct.toFixed(2)) : null,
        medianActivationLagDays: lag.median === null ? null : Number(lag.median.toFixed(2)),
        activatedAccounts: lag.activated,
        attributedRenderSharePct: coverage.total ? Number(coverage.pct.toFixed(1)) : null,
      },
      cohorts: (cohorts && cohorts.cohorts ? cohorts.cohorts : []).map((c) => ({
        cohort: c.label,
        size: c.size,
        // Only elapsed months carry a cell, so a young cohort is SHORT rather than
        // padded with zeroes. That distinction is the caveat below, made structural.
        retentionPct: c.cells.map((cell2) => ({ monthsAfter: cell2.offset, pct: Number(cell2.pct.toFixed(1)) })),
      })),
      caveats: [CAVEAT.attribution, CAVEAT.cohortBlank],
    };
  }

  /** @param {ToolArgs} args */
  function accountLookup(args) {
    const t = tables();
    const index = activityIndex();
    const now = Date.now();
    const filter = String((args && args.filter) || 'paying');
    const limit = rowLimit(args);
    const days = windowDays(args);

    /** Every row goes through here, so an email cannot reach a payload by accident. */
    /** @param {import('./types.js').AdminUser} u @param {Record<string, unknown>} extra */
    const row = (u, extra) => ({
      account: identity.handleFor(u),
      plan: effectivePlan(u),
      daysSinceActive: daysSinceActive(u, index, now),
      ...extra,
    });

    if (filter === 'paying') {
      return {
        rows: payingAccounts(t.users).slice(0, limit).map((u) => row(u, { paying: true })),
        unit: 'accounts',
        caveats: ['"Paying" means a live Stripe subscription id. A comp grant never writes one.'],
      };
    }
    if (filter === 'at_risk') {
      const result = atRiskPayingAccounts(t.users, index, { now, quietDays: 14 });
      return {
        rows: result.atRisk.slice(0, limit).map((a) => ({
          account: identity.handleFor(a),
          neverUsed: Boolean(a.neverUsed),
          daysQuiet: a.daysQuiet,
        })),
        unit: 'accounts',
        totals: { paying: result.paying, atRisk: result.atRisk.length },
        caveats: ['Measured from the server-side activity stamp, not the render log, so a quiet account here is '
          + 'genuinely quiet rather than merely unattributed. This is the one account view with no attribution gap.'],
      };
    }
    if (filter === 'comp_granted') {
      return {
        rows: expiringCompGrants(t.users, { now, withinDays: days }).slice(0, limit).map((g) => ({
          account: identity.handleFor(g),
          daysLeft: g.daysLeft,
        })),
        unit: 'accounts',
        caveats: ['A comp grant expires on READ — the account quietly becomes free on its next request and nobody is told.'],
      };
    }
    if (filter === 'never_activated') {
      const never = t.users.filter((u) => daysSinceActive(u, index, now) === null);
      return {
        rows: never.slice(0, limit).map((u) => row(u, { everActive: false })),
        unit: 'accounts',
        totals: { accounts: t.users.length, neverActivated: never.length, pct: pct(never.length, t.users.length) },
        caveats: [CAVEAT.attribution],
      };
    }
    if (filter === 'recent_signups') {
      const cutoff = startOfDaysAgo(days).getTime();
      const recent = t.users
        .filter((u) => Date.parse(/** @type {string} */ (u && u.createdAt)) >= cutoff)
        .sort((a, b) => Date.parse(/** @type {string} */ (b.createdAt)) - Date.parse(/** @type {string} */ (a.createdAt)));
      return {
        rows: recent.slice(0, limit).map((u) => row(u, { signedUpDaysAgo: Math.floor((now - Date.parse(/** @type {string} */ (u.createdAt))) / 86400000) })),
        unit: 'accounts',
        totals: { signups: recent.length, window: `${days} days` },
        caveats: [],
      };
    }
    if (filter === 'top_users') {
      const counts = (index && index.rendersByEmail) || {};
      const ranked = t.users
        .map((u) => ({ u, renders: counts[categoryKey(u && u.email)] || 0 }))
        .filter((x) => x.renders > 0)
        .sort((a, b) => b.renders - a.renders);
      return {
        rows: ranked.slice(0, limit).map((x) => row(x.u, { renders: x.renders })),
        unit: 'accounts',
        caveats: [CAVEAT.attribution, 'Use metrics_snapshot for render counts attributed through the validated session instead.'],
      };
    }
    return { error: `Unknown filter "${filter}".` };
  }

  function metricsSnapshot() {
    const t = tables();
    if (!t.metrics) {
      return { rows: [], caveats: ['The metrics pack is unavailable on this deployment, so nothing here is attributed '
        + 'through the validated session. Every per-account number from other tools is a floor.'] };
    }
    const m = t.metrics;
    // Top-account lists are stripped of user ids and re-keyed to handles: the raw
    // ids are stable across deployments and are not ours to hand out.
    /** @param {Array<{userId: string, renders?: number, bytes?: number, blobs?: number}> | undefined} list */
    const top = (list) => (list || []).map((r) => ({
      account: identity.handleFor({ id: r.userId }),
      ...(r.renders !== undefined ? { renders: r.renders } : {}),
      ...(r.bytes !== undefined ? { bytes: r.bytes, blobs: r.blobs } : {}),
    }));
    return {
      rows: [],
      renders: { ...m.renders, perUser: { ...m.renders.perUser, top: top(m.renders.perUser.top) } },
      accounts: m.accounts,
      storage: { ...m.storage, topAccounts: top(m.storage.topAccounts) },
      shares: m.shares,
      health: m.health,
      caveats: ['These counts come from `staged_renders.user_id`, written from the VALIDATED session — unlike the '
        + 'render log, they are counts rather than floors. Windows here are durations, never calendar days.'],
    };
  }

  function listFindings() {
    const result = currentFindings();
    return {
      rows: (result.findings || []).map((f) => ({
        id: f.id,
        severity: f.severity,
        area: f.area,
        title: f.title,
        confidence: f.confidence,
        sample: f.sample,
        // Evidence flattened to label/value strings; `accounts` is dropped entirely,
        // exactly as the brief endpoint drops it.
        evidence: (f.evidence || []).map((e) => `${e.label}: ${e.value}`),
      })),
      unit: 'findings',
      caveats: (result.failed || []).length
        ? [`${result.failed.length} check(s) errored and were skipped: ${result.failed.join(', ')}`]
        : [],
    };
  }

  /**
   * The per-account activity index, rebuilt per call.
   *
   * `ctx.data` is swapped wholesale on reload and on sign-out, so anything cached
   * across calls here would answer a question about the previous operator's data.
   * It is cheap relative to a model round-trip.
   */
  function activityIndex() {
    const d = ctx.data || {};
    return activityIndexFrom({
      promptRows: d.promptRows || [],
      chatRows: d.chatRows || [],
      maskRows: d.maskRows || [],
    });
  }

  /** @type {Record<string, (args: any) => any>} */
  const EXECUTORS = {
    segment_breakdown: segmentBreakdown,
    time_series: timeSeries,
    compare_windows: compareWindows,
    render_outcomes: renderOutcomes,
    rejection_breakdown: rejectionBreakdown,
    funnel_and_retention: funnelAndRetention,
    account_lookup: accountLookup,
    metrics_snapshot: metricsSnapshot,
    list_findings: listFindings,
  };

  /**
   * Run one tool call.
   *
   * Never throws: a tool that blows up returns an error string the model can read
   * and work around, because the alternative is a dead conversation the operator
   * has to restart. Same posture as the per-rule try/catch in the findings runner.
   *
   * @param {{name: string, arguments: string}} call
   * @returns {string} JSON, ready to be the content of a `tool` message.
   */
  function run(call) {
    const fn = EXECUTORS[call && call.name];
    if (!fn) return JSON.stringify({ error: `No such tool: ${call && call.name}` });
    // Malformed arguments fall back to defaults rather than erroring: every
    // parameter is optional or clamped, so an empty bag still answers a useful
    // question, and "I could not parse your arguments" wastes a whole round-trip.
    let args;
    try {
      args = JSON.parse(String((call && call.arguments) || '{}')) || {};
    } catch {
      args = {};
    }
    try {
      return JSON.stringify(fn(args));
    } catch (error) {
      return JSON.stringify({ error: `The ${call.name} tool failed: ${errorMessage(error, 'unknown error')}` });
    }
  }

  return { run, names: Object.keys(EXECUTORS), EXECUTORS };
}

/** Tool names this module can execute — the drift test compares this to the server's. */
export const ANALYST_EXECUTOR_NAMES = [
  'segment_breakdown',
  'time_series',
  'compare_windows',
  'render_outcomes',
  'rejection_breakdown',
  'funnel_and_retention',
  'account_lookup',
  'metrics_snapshot',
  'list_findings',
];
