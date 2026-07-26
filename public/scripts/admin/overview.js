// The Overview tab: the headline stat cards, the two generation-activity charts
// (trailing 30 days and all time), and the top-users / recent-signups tables.
//
// Split out of renderers.js so the tab that carries most of the dashboard's
// visual weight owns its own file, and so the numbers behind the cards come from
// the tested aggregators in analytics.js rather than inline reducers.
//
// The two charts answer different questions on purpose: the 30-day one is about
// "is it busy right now", so it stays fixed-window and zero-filled (a dead week
// must LOOK dead). The all-time one is about the shape of the whole history, so
// it re-buckets itself to day/week/month as the history grows — see
// analytics.js#pickGranularity.

import { qs, el, fmtDate, badge, iconDiv } from './helpers.js';
import {
  stripHeader, dailyCounts, allTimeCounts, windowDelta,
  peakPoint, averageValue, startOfDaysAgo,
} from './analytics.js';
import { areaChart, barChart, chartCard, sparkline, fmtNum, PALETTE } from './charts.js';

const GRANULARITY_NOUN = { day: 'day', week: 'week', month: 'month' };

/**
 * @param {object} deps
 * @param {{data: any}} deps.ctx Shared dashboard state (swapped wholesale on sign-out).
 * @param {(u: any) => string} deps.effectivePlan Plan resolver that folds in enterprise domains.
 */
export function createOverview({ ctx, effectivePlan }) {
  /** Timestamp column of a log table, header row dropped. */
  function stamps(rows) {
    return stripHeader(rows || []).map((r) => r[0]);
  }

  // ── Stat cards ────────────────────────────────────────────────────────────

  // A signed percentage chip. Null (no prior window to compare against) renders
  // nothing at all rather than a misleading "+100%".
  function deltaChip(deltaPct, windowLabel) {
    if (deltaPct === null || deltaPct === undefined) return null;
    const up = deltaPct >= 0;
    const chip = el('span', {
      className: 'adm-stat-delta ' + (up ? 'adm-stat-delta--up' : 'adm-stat-delta--down'),
      title: 'vs. the previous ' + windowLabel,
      textContent: (up ? '▲ ' : '▼ ') + Math.abs(Math.round(deltaPct)) + '%',
    });
    return chip;
  }

  function statCard(spec) {
    const tone = spec.tone || 'blue';
    const card = el('div', { className: 'adm-stat adm-stat--' + tone });
    card.appendChild(el('div', { className: 'adm-stat-head' }, [
      iconDiv(spec.icon, 'adm-stat-icon--' + tone),
      el('span', { className: 'adm-stat-lbl', textContent: spec.label }),
      spec.delta || null,
    ]));
    card.appendChild(el('span', { className: 'adm-stat-val', textContent: spec.value }));
    if (spec.hint) card.appendChild(el('span', { className: 'adm-stat-hint', textContent: spec.hint }));
    if (spec.spark) card.appendChild(el('div', { className: 'adm-stat-spark' }, [spec.spark]));
    return card;
  }

  function renderStats(promptStamps, chatStamps, maskStamps) {
    const users = ctx.data.users || [];
    const signupStamps = users.map((u) => u.createdAt);
    const gen30 = windowDelta(promptStamps, 30);
    const gen7 = windowDelta(promptStamps, 7);
    const signup30 = windowDelta(signupStamps, 30);
    const chat30 = windowDelta(chatStamps, 30);

    const pro = users.filter((u) => effectivePlan(u) === 'pro').length;
    const ent = users.filter((u) => effectivePlan(u) === 'enterprise').length;
    const activeEnt = (ctx.data.enterprise || []).filter((e) => e.status === 'active' || e.status === 'trialing').length;
    const paidShare = users.length ? Math.round(((pro + ent) / users.length) * 100) : 0;

    const cards = [
      {
        label: 'Total users', value: fmtNum(users.length), tone: 'blue', icon: 'users',
        hint: pro + ' pro · ' + ent + ' enterprise · ' + paidShare + '% paid',
      },
      {
        label: 'Signups (30d)', value: fmtNum(signup30.current), tone: 'purple', icon: 'signup',
        delta: deltaChip(signup30.deltaPct, '30 days'),
        spark: sparkline(dailyCounts(signupStamps, 30), { color: PALETTE[1] }),
      },
      {
        label: 'Total generations', value: fmtNum(promptStamps.length), tone: 'green', icon: 'gen',
        hint: 'since the first logged render',
      },
      {
        label: 'Generations (30d)', value: fmtNum(gen30.current), tone: 'green', icon: 'chart',
        delta: deltaChip(gen30.deltaPct, '30 days'),
        spark: sparkline(dailyCounts(promptStamps, 30), { color: PALETTE[2] }),
      },
      {
        label: 'Generations (7d)', value: fmtNum(gen7.current), tone: 'green', icon: 'chart',
        delta: deltaChip(gen7.deltaPct, '7 days'),
        spark: sparkline(dailyCounts(promptStamps, 14), { color: PALETTE[2] }),
      },
      {
        label: 'Chat messages (30d)', value: fmtNum(chat30.current), tone: 'cyan', icon: 'chat',
        delta: deltaChip(chat30.deltaPct, '30 days'),
        spark: sparkline(dailyCounts(chatStamps, 30), { color: PALETTE[5] }),
      },
      {
        label: 'Mask edits (all time)', value: fmtNum(maskStamps.length), tone: 'pink', icon: 'mask',
        hint: 'masking studio round-trips',
      },
      {
        label: 'Enterprise domains', value: fmtNum(activeEnt), tone: 'amber', icon: 'ent',
        hint: (ctx.data.enterprise || []).length + ' configured',
      },
    ];

    const wrap = qs('#adm-stats');
    wrap.innerHTML = '';
    cards.forEach((c) => wrap.appendChild(statCard(c)));
  }

  // ── Charts ────────────────────────────────────────────────────────────────

  function renderCharts(promptStamps) {
    const host = qs('#adm-charts');
    if (!host) return;
    host.innerHTML = '';

    const recent = dailyCounts(promptStamps, 30);
    const peak30 = peakPoint(recent);
    host.appendChild(chartCard({
      title: 'Daily generation activity',
      sub: 'Renders per day over the trailing 30 days.',
      body: areaChart(recent, { height: 250, unit: 'generations', maxLabels: 10 }),
      notes: [
        'Avg ' + averageValue(recent) + ' / day',
        peak30 ? 'Peak ' + fmtNum(peak30.value) + ' on ' + peak30.label : 'No renders in this window',
        fmtNum(recent.reduce((s, p) => s + p.value, 0)) + ' in 30 days',
      ],
    }));

    const all = allTimeCounts(promptStamps);
    const noun = GRANULARITY_NOUN[all.granularity];
    const peakAll = peakPoint(all.points);
    const first = all.points.length ? all.points[0].label : null;
    host.appendChild(chartCard({
      title: 'Generation activity — all time',
      sub: all.points.length
        ? 'Every render ever logged, bucketed by ' + noun + '. The bucket widens automatically as history grows.'
        : 'Every render ever logged.',
      body: all.granularity === 'day'
        ? areaChart(all.points, { height: 250, color: PALETTE[2], unit: 'generations', maxLabels: 10 })
        : barChart(all.points, { height: 250, color: PALETTE[2], unit: 'generations', maxLabels: 12 }),
      notes: [
        fmtNum(promptStamps.length) + ' total',
        first ? 'Since ' + first : 'No data yet',
        peakAll ? 'Best ' + noun + ': ' + fmtNum(peakAll.value) + ' (' + peakAll.label + ')' : '',
        'Avg ' + averageValue(all.points) + ' / ' + noun,
      ].filter(Boolean),
    }));
  }

  // ── Tables ────────────────────────────────────────────────────────────────

  function renderTopUsers(promptRows) {
    const since = startOfDaysAgo(29).getTime();
    /** @type {Record<string, {c30: number, total: number}>} */
    const byEmail = {};
    promptRows.forEach((r) => {
      const email = String(r[7] || '').trim().toLowerCase();
      if (!email || email === 'unknown') return;
      if (!byEmail[email]) byEmail[email] = { c30: 0, total: 0 };
      byEmail[email].total++;
      const t = new Date(r[0]).getTime();
      if (!isNaN(t) && t >= since) byEmail[email].c30++;
    });
    const top = Object.keys(byEmail)
      .map((email) => ({ email, c30: byEmail[email].c30, total: byEmail[email].total }))
      .filter((u) => u.c30 > 0)
      .sort((a, b) => b.c30 - a.c30)
      .slice(0, 10);

    const wrap = qs('#adm-top-users');
    wrap.innerHTML = '';
    if (!top.length) {
      wrap.appendChild(el('p', { className: 'adm-empty', textContent: 'No generation data in the last 30 days.' }));
      return;
    }
    const max = top[0].c30 || 1;
    const tbl = el('table', { className: 'adm-table' });
    tbl.appendChild(el('thead', null, [el('tr', null, [
      el('th', { textContent: 'Email' }), el('th', { textContent: '30d' }),
      el('th', { textContent: 'Share' }), el('th', { textContent: 'All' }),
    ])]));
    const body = el('tbody');
    top.forEach((u) => {
      const track = el('span', { className: 'adm-mini-track' });
      track.appendChild(el('span', { className: 'adm-mini-fill', style: 'width:' + Math.max(3, (u.c30 / max) * 100) + '%' }));
      body.appendChild(el('tr', null, [
        el('td', { textContent: u.email }),
        el('td', { className: 'adm-num', textContent: fmtNum(u.c30) }),
        el('td', null, [track]),
        el('td', { className: 'adm-num', textContent: fmtNum(u.total) }),
      ]));
    });
    tbl.appendChild(body);
    wrap.appendChild(tbl);
  }

  function renderRecentSignups() {
    const since = startOfDaysAgo(29).getTime();
    const recent = (ctx.data.users || [])
      .filter((u) => { const t = new Date(u.createdAt).getTime(); return !isNaN(t) && t >= since; })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const wrap = qs('#adm-recent-signups');
    wrap.innerHTML = '';
    if (!recent.length) {
      wrap.appendChild(el('p', { className: 'adm-empty', textContent: 'No signups in the last 30 days.' }));
      return;
    }
    const tbl = el('table', { className: 'adm-table' });
    tbl.appendChild(el('thead', null, [el('tr', null, [
      el('th', { textContent: 'Email' }), el('th', { textContent: 'Plan' }), el('th', { textContent: 'Date' }),
    ])]));
    const body = el('tbody');
    recent.slice(0, 15).forEach((u) => {
      body.appendChild(el('tr', null, [
        el('td', { textContent: u.email }),
        el('td', null, [badge(effectivePlan(u))]),
        el('td', { textContent: fmtDate(u.createdAt) }),
      ]));
    });
    tbl.appendChild(body);
    wrap.appendChild(tbl);
  }

  function render() {
    const promptRows = stripHeader(ctx.data.promptRows || []);
    const promptStamps = promptRows.map((r) => r[0]);
    renderStats(promptStamps, stamps(ctx.data.chatRows), stamps(ctx.data.maskRows));
    renderCharts(promptStamps);
    renderTopUsers(promptRows);
    renderRecentSignups();
  }

  return { render };
}
