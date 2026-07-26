// The Insights tab: everything the Overview tab deliberately doesn't carry —
// growth curves, plan/auth composition, what people actually stage, and when
// they do it.
//
// Every card is built the same way: pull one aggregate out of analytics.js, hand
// it to one chart in charts.js, wrap it in chartCard. There is no per-card state
// and no partial update — a refresh rebuilds the whole grid, which is cheap
// (pure DOM, no listeners) and removes any chance of a stale card.
//
// Column indices below are the CSV schemas written by lib/services/logging.js
// (prompt/mask/chat), routes/public.js (contact/bug) and lib/services/email.js.
// They are listed in docs/guides/admin-dashboard.md — if a writer gains a column,
// fix both.

import { qs } from './helpers.js';
import {
  stripHeader, dailyCounts, allTimeCounts, cumulative, topValues,
  hourHistogram, weekdayHistogram, planMix, authMix, booleanMix,
} from './analytics.js';
import {
  areaChart as wideArea, barChart as wideBar,
  rankedBars, donutChart, chartCard, chartEmpty, fmtNum, PALETTE,
} from './charts.js';

// Cards in this grid give a chart ~350 CSS px of content width, so their charts draw into a
// viewBox of about that width. Handing them the full-width default would scale
// the SVG down by half and take the axis labels with it — see the note on VB_W
// in charts.js. These two wrappers are the only way this file builds a chart.
const CARD_VB_W = 380;
const areaChart = (points, opts) => wideArea(points, { width: CARD_VB_W, ...opts });
const barChart = (points, opts) => wideBar(points, { width: CARD_VB_W, ...opts });

/** prompt_logs.csv: timestamp,roomType,furnitureStyle,additionalPrompt,removeFurniture,userRole,referralSource,email,ipAddress */
const PROMPT_COL = { ROOM: 1, STYLE: 2, REMOVE: 4, ROLE: 5, REFERRAL: 6, EMAIL: 7 };
/** contact_logs.csv: timestamp,userRole,referralSource,email,userAgent,ipAddress */
const CONTACT_COL = { ROLE: 1, REFERRAL: 2 };
/** mask_logs.csv: timestamp,prompt,model,geminiModel,imageWidth,imageHeight,userId,… */
const MASK_COL = { MODEL: 3 };

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
        ? donutChart(booleanMix(promptRows, PROMPT_COL.REMOVE, 'Removed first', 'Staged as-is'), {
          centerLabel: 'renders', colors: [PALETTE[6], PALETTE[0]],
        })
        : chartEmpty('No renders logged yet.'),
    }));
  }

  function contentCards(host, promptRows, maskRows, contactRows) {
    host.appendChild(chartCard({
      title: 'Room types',
      sub: 'Which rooms get staged, all time.',
      body: rankedBars(topValues(promptRows, PROMPT_COL.ROOM, { top: 10 }), { unit: 'renders', colorful: true }),
    }));

    host.appendChild(chartCard({
      title: 'Furniture styles',
      sub: 'Which styles get picked, all time.',
      body: rankedBars(topValues(promptRows, PROMPT_COL.STYLE, { top: 10 }), { unit: 'renders', color: PALETTE[1] }),
    }));

    // Referral/role are self-reported at signup and repeated onto every prompt
    // row, so the contact form is the cleaner sample when prompts carry none.
    const referral = topValues(promptRows, PROMPT_COL.REFERRAL, { top: 8 });
    host.appendChild(chartCard({
      title: 'Referral sources',
      sub: referral.length ? 'Self-reported "how did you hear about us", from render logs.' : 'From contact-form submissions.',
      body: rankedBars(referral.length ? referral : topValues(contactRows, CONTACT_COL.REFERRAL, { top: 8 }), { color: PALETTE[3] }),
    }));

    const role = topValues(promptRows, PROMPT_COL.ROLE, { top: 8 });
    host.appendChild(chartCard({
      title: 'User roles',
      sub: 'Self-reported role — agent, photographer, stager, and so on.',
      body: rankedBars(role.length ? role : topValues(contactRows, CONTACT_COL.ROLE, { top: 8 }), { color: PALETTE[5] }),
    }));

    host.appendChild(chartCard({
      title: 'Mask-edit models',
      sub: 'Which model served each masking-studio round-trip.',
      body: rankedBars(topValues(maskRows, MASK_COL.MODEL, { top: 6 }), { unit: 'edits', color: PALETTE[4] }),
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
    growthCards(host, promptStamps, signupStamps);
    compositionCards(host, promptRows, chatStamps, maskStamps, promptStamps);
    contentCards(host, promptRows, maskRows, contactRows);
    rhythmCards(host, promptStamps, chatStamps, maskStamps);
  }

  return { render };
}
