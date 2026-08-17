// The Overview tab: a range selector, the headline stat cards, the two
// generation-activity charts, and the top-users / recent-signups tables.
//
// Split out of renderers.js so the tab that carries most of the dashboard's
// visual weight owns its own file, and so the numbers behind the cards come from
// the tested aggregators in analytics.js rather than inline reducers.
//
// The two charts answer different questions on purpose. The first follows the
// selected range and is zero-filled, because it is about "is it busy right now"
// and a dead week must LOOK dead. The second ignores the range entirely and
// re-buckets itself to day/week/month as history grows (analytics.js#pickGranularity),
// because it is about the shape of the whole history. Selecting "All time"
// therefore hides the first one rather than drawing the same chart twice.

import { qs, el, fmtDate, badge, iconDiv } from './helpers.js';
import {
  stripHeader, dailyCounts, allTimeCounts, windowDelta,
  peakPoint, averageValue, startOfDaysAgo, successRate,
} from './analytics.js';
import { areaChart, barChart, chartCard, sparkline, fmtNum, PALETTE } from './charts.js';

const GRANULARITY_NOUN = { day: 'day', week: 'week', month: 'month' };

/**
 * Windows the Overview can be scoped to. `days: null` is "all time", which has no
 * previous window to compare against — those cards drop their delta chip rather
 * than invent one.
 */
const RANGES = [
  { key: '7', label: '7 days', short: '7d', days: 7 },
  { key: '30', label: '30 days', short: '30d', days: 30 },
  { key: '90', label: '90 days', short: '90d', days: 90 },
  { key: 'all', label: 'All time', short: 'all time', days: null },
];
const DEFAULT_RANGE = '30';

/**
 * @param {object} deps
 * @param {{data: any, overviewRange?: string}} deps.ctx Shared dashboard state (swapped wholesale on sign-out).
 * @param {(u: any) => string} deps.effectivePlan Plan resolver that folds in enterprise domains.
 */
export function createOverview({ ctx, effectivePlan }) {
  function currentRange() {
    return RANGES.find((r) => r.key === (ctx.overviewRange || DEFAULT_RANGE)) || RANGES[1];
  }

  /** Rows whose timestamp falls inside the range; the whole table for "all time". */
  function rowsInRange(rows, range) {
    if (!range.days) return rows;
    const since = startOfDaysAgo(range.days - 1).getTime();
    return (rows || []).filter((r) => {
      const t = new Date(r[0]).getTime();
      return !isNaN(t) && t >= since;
    });
  }

  /** Count for the range, plus the change vs. the preceding window of equal length. */
  function rangeDelta(stamps, range) {
    if (!range.days) return { current: stamps.length, deltaPct: null };
    return windowDelta(stamps, range.days);
  }

  // ── Range selector ────────────────────────────────────────────────────────

  function renderRangeBar() {
    const host = qs('#adm-range');
    if (!host) return;
    const active = currentRange();
    host.innerHTML = '';
    host.appendChild(el('span', { className: 'adm-range-label', textContent: 'Showing' }));
    // The buttons share one track so the group reads as a single segmented
    // control rather than four loose pills (styles/admin.css, .adm-range-track).
    const track = el('div', { className: 'adm-range-track', role: 'group', 'aria-label': 'Date range' });
    RANGES.forEach((r) => {
      const btn = el('button', {
        type: 'button',
        className: 'adm-range-btn' + (r.key === active.key ? ' active' : ''),
        'aria-pressed': r.key === active.key ? 'true' : 'false',
        textContent: r.label,
      });
      btn.addEventListener('click', () => {
        if (ctx.overviewRange === r.key) return;
        ctx.overviewRange = r.key;
        render();
      });
      track.appendChild(btn);
    });
    host.appendChild(track);
  }

  // ── Stat cards ────────────────────────────────────────────────────────────

  // A signed percentage chip. Null (no prior window to compare against) renders
  // nothing at all rather than a misleading "+100%".
  function deltaChip(deltaPct, windowLabel) {
    if (deltaPct === null || deltaPct === undefined) return null;
    const up = deltaPct >= 0;
    return el('span', {
      className: 'adm-stat-delta ' + (up ? 'adm-stat-delta--up' : 'adm-stat-delta--down'),
      title: 'vs. the previous ' + windowLabel,
      textContent: (up ? '▲ ' : '▼ ') + Math.abs(Math.round(deltaPct)) + '%',
    });
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

  function renderStats(promptRows, chatRows, maskRows) {
    const range = currentRange();
    // A stat-card label is one uppercase line ~26 characters wide and the range
    // selector sits directly above it, so the scope rides along as a short tag
    // ('Signups · 30d') rather than a parenthetical that pushed half the labels
    // into an ellipsis. It stays per-card because only some cards are scoped.
    const suffix = ' · ' + range.short;
    const sparkDays = range.days || 90;
    const users = ctx.data.users || [];

    const signupStamps = users.map((u) => u.createdAt);
    const promptStamps = promptRows.map((r) => r[0]);
    const chatStamps = chatRows.map((r) => r[0]);
    const maskStamps = maskRows.map((r) => r[0]);

    const gen = rangeDelta(promptStamps, range);
    const signup = rangeDelta(signupStamps, range);
    const chat = rangeDelta(chatStamps, range);
    const mask = rangeDelta(maskStamps, range);
    const rate = successRate(rowsInRange(promptRows, range));

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
        label: 'Signups' + suffix, value: fmtNum(signup.current), tone: 'purple', icon: 'signup',
        delta: deltaChip(signup.deltaPct, range.label),
        spark: sparkline(dailyCounts(signupStamps, sparkDays), { color: PALETTE[1] }),
      },
      {
        label: 'Generations' + suffix, value: fmtNum(gen.current), tone: 'green', icon: 'gen',
        delta: deltaChip(gen.deltaPct, range.label),
        spark: sparkline(dailyCounts(promptStamps, sparkDays), { color: PALETTE[2] }),
      },
      {
        // Unknown until the outcome columns have data — never shown as 100%.
        label: 'Success rate' + suffix,
        value: rate.pct === null ? '—' : rate.pct.toFixed(1) + '%',
        tone: rate.pct !== null && rate.pct < 90 ? 'pink' : 'green', icon: 'chart',
        hint: rate.recorded
          ? fmtNum(rate.failed) + ' failed of ' + fmtNum(rate.recorded) + ' recorded'
          : 'no outcomes recorded yet',
      },
      {
        label: 'Chat messages' + suffix, value: fmtNum(chat.current), tone: 'cyan', icon: 'chat',
        delta: deltaChip(chat.deltaPct, range.label),
        spark: sparkline(dailyCounts(chatStamps, sparkDays), { color: PALETTE[5] }),
      },
      {
        label: 'Mask edits' + suffix, value: fmtNum(mask.current), tone: 'pink', icon: 'mask',
        delta: deltaChip(mask.deltaPct, range.label),
        spark: sparkline(dailyCounts(maskStamps, sparkDays), { color: PALETTE[4] }),
      },
      {
        label: 'Total generations', value: fmtNum(promptStamps.length), tone: 'green', icon: 'gen',
        hint: 'all time, since the first logged render',
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
    const range = currentRange();
    host.innerHTML = '';

    // Skipped for "All time" — the next card already IS that chart, bucketed better.
    if (range.days) {
      const recent = dailyCounts(promptStamps, range.days);
      const peak = peakPoint(recent);
      host.appendChild(chartCard({
        title: 'Daily generation activity',
        sub: 'Renders per day over the trailing ' + range.label + '.',
        body: areaChart(recent, { height: 250, unit: 'generations', maxLabels: 10 }),
        notes: [
          'Avg ' + averageValue(recent) + ' / day',
          peak ? 'Peak ' + fmtNum(peak.value) + ' on ' + peak.label : 'No renders in this window',
          fmtNum(recent.reduce((s, p) => s + p.value, 0)) + ' in ' + range.label,
        ],
      }));
    }

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
    const range = currentRange();
    const scoped = rowsInRange(promptRows, range);
    /** @type {Record<string, {scoped: number, total: number}>} */
    const byEmail = {};
    const bump = (email, field) => {
      if (!byEmail[email]) byEmail[email] = { scoped: 0, total: 0 };
      byEmail[email][field]++;
    };
    const emailOf = (r) => {
      const email = String(r[7] || '').trim().toLowerCase();
      return !email || email === 'unknown' ? null : email;
    };
    promptRows.forEach((r) => { const e = emailOf(r); if (e) bump(e, 'total'); });
    scoped.forEach((r) => { const e = emailOf(r); if (e) bump(e, 'scoped'); });

    const top = Object.keys(byEmail)
      .map((email) => ({ email, scoped: byEmail[email].scoped, total: byEmail[email].total }))
      .filter((u) => u.scoped > 0)
      .sort((a, b) => b.scoped - a.scoped)
      .slice(0, 10);

    const heading = qs('#adm-top-users-range');
    if (heading) heading.textContent = range.label;

    const wrap = qs('#adm-top-users');
    wrap.innerHTML = '';
    if (!top.length) {
      wrap.appendChild(el('p', { className: 'adm-empty', textContent: 'No attributed generations in this window.' }));
      return;
    }
    const max = top[0].scoped || 1;
    const tbl = el('table', { className: 'adm-table' });
    tbl.appendChild(el('thead', null, [el('tr', null, [
      el('th', { textContent: 'Email' }), el('th', { textContent: range.label }),
      el('th', { textContent: 'Share' }), el('th', { textContent: 'All' }),
    ])]));
    const body = el('tbody');
    top.forEach((u) => {
      const track = el('span', { className: 'adm-mini-track' });
      track.appendChild(el('span', { className: 'adm-mini-fill', style: 'width:' + Math.max(3, (u.scoped / max) * 100) + '%' }));
      body.appendChild(el('tr', null, [
        el('td', { textContent: u.email }),
        el('td', { className: 'adm-num', textContent: fmtNum(u.scoped) }),
        el('td', null, [track]),
        el('td', { className: 'adm-num', textContent: fmtNum(u.total) }),
      ]));
    });
    tbl.appendChild(body);
    wrap.appendChild(tbl);
  }

  function renderRecentSignups() {
    const range = currentRange();
    const since = range.days ? startOfDaysAgo(range.days - 1).getTime() : -Infinity;
    const recent = (ctx.data.users || [])
      .filter((u) => { const t = new Date(u.createdAt).getTime(); return !isNaN(t) && t >= since; })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const heading = qs('#adm-recent-signups-range');
    if (heading) heading.textContent = range.label;

    const wrap = qs('#adm-recent-signups');
    wrap.innerHTML = '';
    if (!recent.length) {
      wrap.appendChild(el('p', { className: 'adm-empty', textContent: 'No signups in this window.' }));
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
    const chatRows = stripHeader(ctx.data.chatRows || []);
    const maskRows = stripHeader(ctx.data.maskRows || []);
    renderRangeBar();
    renderStats(promptRows, chatRows, maskRows);
    renderCharts(promptRows.map((r) => r[0]));
    renderTopUsers(promptRows);
    renderRecentSignups();
  }

  return { render };
}
