// The Insights tab: everything the Overview tab deliberately doesn't carry —
// growth curves, plan/auth composition, what people actually stage, and when
// they do it.
//
// Every card is built the same way: pull one aggregate out of analytics.js, hand
// it to one chart in charts.js, wrap it in chartCard. There is no per-card state
// and no partial update — a refresh rebuilds the whole grid, which is cheap
// (pure DOM, no listeners) and removes any chance of a stale card.
//
// Column indices come from analytics.js#COL — the single source of truth for the
// CSV schemas, mirrored in docs/guides/admin-dashboard.md.

import { qs, el } from './helpers.js';
import {
  COL, stripHeader, dailyCounts, allTimeCounts, cumulative, topValues, topValuesByPerson,
  distinctPeople, hourHistogram, weekdayHistogram, planMix, authMix, booleanMix,
  successRate, failuresByDay, durationStats, durationHistogram,
} from './analytics.js';
import {
  activityIndexFrom, attributionCoverage, activationFunnel, paidConversion, cohortRetention,
  trialOutcomes, trialEmailsSent,
} from './analytics-users.js';
import {
  areaChart as wideArea, barChart as wideBar,
  rankedBars, donutChart, funnelChart, cohortGrid, chartCard, chartEmpty, fmtNum, PALETTE,
} from './charts.js';

// Cards in this grid give a chart ~350 CSS px of content width, so their charts draw into a
// viewBox of about that width. Handing them the full-width default would scale
// the SVG down by half and take the axis labels with it — see the note on VB_W
// in charts.js. These two wrappers are the only way this file builds a chart.
const CARD_VB_W = 380;
const areaChart = (points, opts) => wideArea(points, { width: CARD_VB_W, ...opts });
const barChart = (points, opts) => wideBar(points, { width: CARD_VB_W, ...opts });

const GRANULARITY_NOUN = { day: 'day', week: 'week', month: 'month' };

/**
 * @param {object} deps
 * @param {{data: any}} deps.ctx Shared dashboard state.
 * @param {(u: any) => string} deps.effectivePlan Plan resolver that folds in enterprise domains.
 */
export function createInsights({ ctx, effectivePlan }) {
  // An all-time series plus the noun for its bucket, so captions can say
  // "per week" without the caller re-deriving the granularity.
  function allTime(stamps) {
    const series = allTimeCounts(stamps);
    return { ...series, noun: GRANULARITY_NOUN[series.granularity] };
  }

  function growthCards(host, promptStamps, signupStamps) {
    const gen = allTime(promptStamps);
    host.appendChild(chartCard({
      title: 'Cumulative generations',
      sub: 'Every render ever logged, accumulated. A straightening curve means growth is flat.',
      body: areaChart(cumulative(gen.points), { height: 230, color: PALETTE[2], unit: 'total', maxLabels: 5 }),
      notes: [fmtNum(promptStamps.length) + ' lifetime renders'],
    }));

    const signups = allTime(signupStamps);
    host.appendChild(chartCard({
      title: 'Total accounts over time',
      sub: 'Cumulative registered accounts. Deleted accounts are not represented — this is a signup curve.',
      body: areaChart(cumulative(signups.points), { height: 230, color: PALETTE[1], unit: 'accounts', maxLabels: 5 }),
      notes: [fmtNum((ctx.data.users || []).length) + ' accounts today'],
    }));

    host.appendChild(chartCard({
      title: 'New signups per ' + signups.noun,
      sub: 'Acquisition rate, bucketed by ' + signups.noun + '.',
      body: barChart(signups.points, { height: 230, color: PALETTE[1], unit: 'signups', maxLabels: 6 }),
      notes: signups.points.length ? ['Since ' + signups.points[0].label] : [],
    }));
  }

  function compositionCards(host, promptRows, chatStamps, maskStamps, promptStamps) {
    const users = ctx.data.users || [];
    host.appendChild(chartCard({
      title: 'Plan mix',
      sub: 'Effective plan — a Stripe subscription wins, then an active enterprise domain.',
      body: donutChart(planMix(users, effectivePlan), { centerLabel: 'accounts', colors: [PALETTE[0], PALETTE[3], PALETTE[7]] }),
    }));

    host.appendChild(chartCard({
      title: 'Sign-in method',
      sub: 'How accounts were created: Google Sign-In vs. email + password.',
      body: donutChart(authMix(users), { centerLabel: 'accounts', colors: [PALETTE[4], PALETTE[2]] }),
    }));

    const featureMix = [
      { label: 'Staging renders', value: promptStamps.length },
      { label: 'Chat messages', value: chatStamps.length },
      { label: 'Mask edits', value: maskStamps.length },
    ].filter((s) => s.value > 0);
    host.appendChild(chartCard({
      title: 'Feature usage mix',
      sub: 'Lifetime volume across the three logged surfaces.',
      body: donutChart(featureMix, { centerLabel: 'actions', colors: [PALETTE[2], PALETTE[5], PALETTE[4]] }),
    }));

    host.appendChild(chartCard({
      title: 'Furniture removal',
      sub: 'Share of renders that asked to empty the room first.',
      body: promptRows.length
        ? donutChart(booleanMix(promptRows, COL.PROMPT.REMOVE, 'Removed first', 'Staged as-is'), {
          centerLabel: 'renders', colors: [PALETTE[6], PALETTE[0]],
        })
        : chartEmpty('No renders logged yet.'),
    }));
  }

  function contentCards(host, promptRows, maskRows, contactRows) {
    host.appendChild(chartCard({
      title: 'Room types',
      sub: 'Which rooms get staged, all time.',
      body: rankedBars(topValues(promptRows, COL.PROMPT.ROOM, { top: 10 }), { unit: 'renders', colorful: true }),
    }));

    host.appendChild(chartCard({
      title: 'Furniture styles',
      sub: 'Which styles get picked, all time.',
      body: rankedBars(topValues(promptRows, COL.PROMPT.STYLE, { top: 10 }), { unit: 'renders', color: PALETTE[1] }),
    }));

    // Onboarding answers, counted as PEOPLE from the contact log — one row per
    // answer. They must NOT be counted off the render log: the client replays the
    // stored answer onto every render, so a few hundred answers became tens of
    // thousands of "people", weighted by whoever staged the most rooms.
    const answered = distinctPeople(contactRows, COL.CONTACT.EMAIL);
    const answeredNote = answered ? fmtNum(answered) + ' people answered' : '';

    host.appendChild(chartCard({
      title: 'Referral sources',
      sub: 'Self-reported "how did you hear about us" — one count per person, from the onboarding answers.',
      body: contactRows.length
        ? rankedBars(topValuesByPerson(contactRows, COL.CONTACT.REFERRAL, COL.CONTACT.EMAIL, { top: 8 }), { unit: 'people', color: PALETTE[3] })
        : chartEmpty('No onboarding answers recorded.'),
      notes: [answeredNote].filter(Boolean),
    }));

    host.appendChild(chartCard({
      title: 'User roles',
      sub: 'Self-reported role — one count per person, from the onboarding answers.',
      body: contactRows.length
        ? rankedBars(topValuesByPerson(contactRows, COL.CONTACT.ROLE, COL.CONTACT.EMAIL, { top: 8 }), { unit: 'people', color: PALETTE[5] })
        : chartEmpty('No onboarding answers recorded.'),
      notes: [answeredNote].filter(Boolean),
    }));

    host.appendChild(chartCard({
      title: 'Mask-edit models',
      sub: 'Which model served each masking-studio round-trip.',
      body: rankedBars(topValues(maskRows, COL.MASK.MODEL, { top: 6 }), { unit: 'edits', color: PALETTE[4] }),
    }));

    const domains = (ctx.data.enterprise || [])
      .map((e) => ({ label: e.domain || '—', value: Number(e.usageCount) || 0 }))
      .filter((d) => d.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
    host.appendChild(chartCard({
      title: 'Enterprise usage by domain',
      sub: 'Billable uses per configured domain ($0.15 each).',
      body: domains.length ? rankedBars(domains, { unit: 'uses', colorful: true }) : chartEmpty('No enterprise usage recorded.'),
    }));
  }

  function rhythmCards(host, promptStamps, chatStamps, maskStamps) {
    host.appendChild(chartCard({
      title: 'Activity by hour',
      sub: 'When renders are requested, in your local timezone.',
      body: barChart(hourHistogram(promptStamps), { height: 210, color: PALETTE[0], unit: 'renders', maxLabels: 6 }),
    }));

    host.appendChild(chartCard({
      title: 'Activity by weekday',
      sub: 'Which days carry the load.',
      body: barChart(weekdayHistogram(promptStamps), { height: 210, color: PALETTE[3], unit: 'renders', maxLabels: 7 }),
    }));

    host.appendChild(chartCard({
      title: 'Chat messages (30 days)',
      sub: 'AI Designer conversation volume.',
      body: areaChart(dailyCounts(chatStamps, 30), { height: 210, color: PALETTE[5], unit: 'messages', maxLabels: 5 }),
    }));

    host.appendChild(chartCard({
      title: 'Mask edits (30 days)',
      sub: 'Masking-studio round-trips.',
      body: areaChart(dailyCounts(maskStamps, 30), { height: 210, color: PALETTE[4], unit: 'edits', maxLabels: 5 }),
    }));
  }

  // ── Reliability ───────────────────────────────────────────────────────────
  //
  // Only renders logged since the outcome columns were added carry a result, so
  // every card here states how many rows it is actually speaking for. Silently
  // charting a partial sample as if it were the whole history is exactly the kind
  // of quiet wrongness these charts exist to remove.

  function reliabilityCards(host, promptRows) {
    const rate = successRate(promptRows);
    const unrecordedNote = rate.unrecorded
      ? fmtNum(rate.unrecorded) + ' older renders have no recorded outcome'
      : '';

    host.appendChild(chartCard({
      title: 'Render outcomes',
      sub: 'Did the staging call actually produce an image?',
      body: rate.recorded
        ? donutChart([{ label: 'Succeeded', value: rate.ok }, { label: 'Failed', value: rate.failed }],
          { centerLabel: 'renders', colors: [PALETTE[2], PALETTE[6]] })
        : chartEmpty('No outcomes recorded yet — they start appearing after the next deploy.'),
      notes: [
        rate.pct === null ? 'Success rate unknown' : rate.pct.toFixed(1) + '% success',
        fmtNum(rate.recorded) + ' recorded',
        unrecordedNote,
      ].filter(Boolean),
    }));

    host.appendChild(chartCard({
      title: 'Failed renders per day',
      sub: 'Absolute failures over the trailing 30 days — a quiet day and a broken day should not look alike.',
      body: barChart(failuresByDay(promptRows, 30), { height: 210, color: PALETTE[6], unit: 'failures', maxLabels: 5 }),
    }));

    const reasons = topValues(promptRows, COL.PROMPT.ERROR, { top: 8 });
    host.appendChild(chartCard({
      title: 'Failure reasons',
      sub: 'Error code recorded on each failed render.',
      body: reasons.length ? rankedBars(reasons, { unit: 'failures', color: PALETTE[6] }) : chartEmpty('No failures recorded.'),
    }));

    const d = durationStats(promptRows);
    host.appendChild(chartCard({
      title: 'Render duration',
      sub: 'Wall-clock time of successful renders, including quality-gate retries.',
      body: d.count
        ? barChart(durationHistogram(promptRows), { height: 210, color: PALETTE[5], unit: 'renders', maxLabels: 6 })
        : chartEmpty('No durations recorded yet.'),
      notes: d.count ? [
        'p50 ' + (d.p50 / 1000).toFixed(1) + 's',
        'p90 ' + (d.p90 / 1000).toFixed(1) + 's',
        'p95 ' + (d.p95 / 1000).toFixed(1) + 's',
        fmtNum(d.count) + ' timed renders',
      ] : [],
    }));

    const models = topValues(promptRows, COL.PROMPT.MODEL, { top: 6 });
    host.appendChild(chartCard({
      title: 'Staging models',
      sub: 'Which Gemini model served each render.',
      body: models.length ? rankedBars(models, { unit: 'renders', color: PALETTE[0] }) : chartEmpty('No models recorded yet.'),
    }));
  }

  // ── Funnel & retention ────────────────────────────────────────────────────
  //
  // Both are joins between accounts and render rows, so both inherit the
  // attribution gap: a render logged without an email cannot be tied to anyone.
  // Each card states the coverage rather than presenting a floor as a count.

  function lifecycleCards(host, promptRows) {
    const index = activityIndexFrom(ctx.data);
    const coverage = attributionCoverage(promptRows);
    const coverageNote = coverage.total
      ? Math.round(coverage.pct) + '% of renders are attributable (' + fmtNum(coverage.total - coverage.attributed) + ' anonymous)'
      : '';

    // Paid is reported beside the funnel, not inside it: a subscriber whose
    // renders logged anonymously is paid but not "activated", so it does not nest
    // and would draw as a step wider than its parent. See analytics-users.js.
    const paid = paidConversion(ctx.data.users || [], effectivePlan);
    host.appendChild(chartCard({
      title: 'Activation funnel',
      sub: 'Accounts that went on to render, and kept going. Each step is a strict subset of the one above.',
      body: funnelChart(activationFunnel(ctx.data.users || [], index)),
      // Full width: the bars scale to the container, so the conversion drop-off
      // is far easier to read, and a tall card in one column would strand the
      // two beside it.
      wide: true,
      notes: [
        fmtNum(paid.paid) + ' of ' + fmtNum(paid.total) + ' accounts pay (' + paid.pct.toFixed(1) + '%) — tracked separately, it does not nest',
        coverageNote,
        'Anonymous renders count for nobody — read these as a floor',
      ].filter(Boolean),
    }));

    host.appendChild(chartCard({
      title: 'Cohort retention',
      sub: 'Share of each signup month still rendering N months later. A blank cell is a month that has not happened yet, not a zero.',
      body: cohortGrid(cohortRetention(ctx.data.users || [], promptRows)),
      notes: [coverageNote].filter(Boolean),
      wide: true,
    }));

    // ── Trials ────────────────────────────────────────────────────────────────
    // `plan` is only 'free' | 'pro' — trialing, active and past_due all collapse
    // into 'pro', and a cancellation rewrites it back to 'free' and nulls the
    // subscription id. So the account table alone cannot say how a trial ended.
    // These two read `trialLifecycle`, whose `startAt` (checkout) and
    // `sent.canceled` (win-back mail, sent only on subscription.deleted) are the
    // only durable trial/churn timestamps stored locally.
    const trials = trialOutcomes(ctx.data.users || []);
    // Only the two steps that genuinely NEST go in the funnel. "Still paying" is
    // reported beside it for the same reason paidConversion is: someone can convert
    // without ever staging, so retained can exceed activated and would draw a step
    // wider than its own parent — the regression funnelMonotonic exists to catch.
    host.appendChild(chartCard({
      title: 'Trials',
      sub: 'How many trials were started, and how many of those people actually used the product.',
      body: funnelChart([
        { label: 'Trials started', value: trials.started, pctOfPrev: null, pctOfTop: 100 },
        {
          label: 'Used the product',
          value: trials.activated,
          pctOfPrev: trials.started ? trials.activationPct : null,
          pctOfTop: trials.activationPct,
        },
      ]),
      notes: [
        fmtNum(trials.retained) + ' still paying past the trial window — tracked separately, it does not nest',
        fmtNum(trials.running) + ' trial(s) still inside the 7-day window',
        fmtNum(trials.cancelled) + ' cancelled (' + trials.cancelPct.toFixed(1) + '% of trials started)',
        'Cancellations come from the win-back email, the only churn timestamp stored locally — a floor, not a count',
      ],
      wide: true,
    }));

    const mails = trialEmailsSent(ctx.data.users || []);
    const endingSent = mails.find((m) => m.label === 'ending');
    const welcomeSent = mails.find((m) => m.label === 'welcome');
    host.appendChild(chartCard({
      title: 'Trial emails sent',
      sub: 'One bar per lifecycle email, counted from the per-user sent flags.',
      body: rankedBars(mails),
      notes: [
        // The check worth surfacing: `ending` is the only one with no sweep
        // fallback — it fires solely from the customer.subscription.trial_will_end
        // webhook, which has to be switched on by hand in the Stripe dashboard.
        welcomeSent && welcomeSent.value > 0 && endingSent && endingSent.value === 0
          ? 'No trial-ending reminders have EVER been sent — enable customer.subscription.trial_will_end on the Stripe webhook endpoint'
          : '',
        'Only "ending" depends on a Stripe dashboard toggle; the rest have a sweep behind them',
      ].filter(Boolean),
    }));
  }

  // Each group gets its own grid rather than all 24 cards sharing one.
  //
  // A single grid sizes every row to its tallest card, so an empty-state card
  // ("No failures recorded") next to a full chart left large dead areas, and one
  // very tall card stranded the whole band beside it. Cards within a group are
  // the same KIND of thing and so roughly the same height, which makes the rows
  // even; the headings also give 24 cards some navigable structure.
  function section(host, title, build) {
    const grid = el('div', { className: 'adm-chart-grid' });
    build(grid);
    if (!grid.children.length) return;
    // Four cards in a three-column grid leaves a lone orphan on its own row.
    // 2x2 is the tidier shape, so a group of exactly four asks for two columns.
    // Full-width cards take a row to themselves and don't count toward this.
    const inFlow = [...grid.children].filter((c) => !c.classList.contains('adm-chart-card--wide')).length;
    if (inFlow === 4) grid.classList.add('adm-chart-grid--2col');
    host.appendChild(el('section', { className: 'adm-section' }, [
      el('h2', { className: 'adm-section-title', textContent: title }),
      grid,
    ]));
  }

  function render() {
    const host = qs('#adm-insights');
    if (!host) return;

    const promptRows = stripHeader(ctx.data.promptRows || []);
    const maskRows = stripHeader(ctx.data.maskRows || []);
    const contactRows = stripHeader(ctx.data.contactRows || []);
    const promptStamps = promptRows.map((r) => r[0]);
    const chatStamps = stripHeader(ctx.data.chatRows || []).map((r) => r[0]);
    const maskStamps = maskRows.map((r) => r[0]);
    const signupStamps = (ctx.data.users || []).map((u) => u.createdAt);

    host.innerHTML = '';
    section(host, 'Reliability', (g) => reliabilityCards(g, promptRows));
    section(host, 'Lifecycle', (g) => lifecycleCards(g, promptRows));
    section(host, 'Growth', (g) => growthCards(g, promptStamps, signupStamps));
    section(host, 'Composition', (g) => compositionCards(g, promptRows, chatStamps, maskStamps, promptStamps));
    section(host, 'What gets staged', (g) => contentCards(g, promptRows, maskRows, contactRows));
    section(host, 'When it happens', (g) => rhythmCards(g, promptStamps, chatStamps, maskStamps));
  }

  return { render };
}
