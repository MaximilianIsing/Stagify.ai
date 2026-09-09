// Admin "API usage" tab — how much the public render API is actually being used.
//
// The operator's counterpart to the developer console at /api-keys.html. That page
// answers "how is MY integration doing"; this one answers the three questions the
// console could not ask at all: how much traffic the API carries, which accounts
// carry it, and whether the prepaid credits behind it were sold or given away.
//
// LAZY, LIKE REFERRALS AND STATUS. Its data is one server-side aggregate, not a slice
// of the CSV burst in admin.js#loadAll — so it fetches when its tab is first opened,
// refetches when the range changes, and is invalidated (not refetched) by Refresh.
// Nothing here polls: unlike the status monitor, none of these numbers are a live
// gauge, and a background query per 30 seconds against api_requests would be load
// spent on a tab nobody is reading.
//
// REFUNDS ARE FOLDED IN, NOT LISTED. A refunded request is a render that was charged
// and then given back, so it belongs in the same column as the delivered one and in a
// column of its own in the table — not in a separate failure feed. `stackedBarChart`
// keeps the column height meaning "requests that day" for exactly this reason.
//
// SILENCE MUST BE HONEST. A window with no traffic says so; a median with no sample
// renders as an em dash. Neither may render as a zero — see the same-named section of
// docs/guides/admin-dashboard.md. A fresh install is the empty case, so it is the
// state this panel is most likely to be seen in first.

import { qs, el, fmtDateTime, iconDiv } from './helpers.js';
import { chartCard, chartEmpty, stackedBarChart, rankedBars, legend, fmtNum, PALETTE } from './charts.js';

/** Windows the tab offers. Bounded by what the endpoint will serve (90 days). */
const RANGES = [
  { key: '7', days: 7, label: '7 days', short: '7d' },
  { key: '30', days: 30, label: '30 days', short: '30d' },
  { key: '90', days: 90, label: '90 days', short: '90d' },
];

const DEFAULT_RANGE = '30';

/** Accounts drawn in the ranked chart. The table below it carries the rest. */
const RANKED_TOP = 8;

/** Delivered, then refunded — the stack order, bottom first. */
const C_DELIVERED = PALETTE[0];
const C_REFUNDED = PALETTE[6];

/**
 * UTC day label. The server buckets by UTC day (lib/analytics/api-usage.js), so these
 * are labelled in UTC too rather than being silently shifted into the operator's
 * timezone — a bucket boundary that moves with the reader is a bug report waiting.
 * @param {number} ms - Bucket start, epoch millis.
 * @returns {string} e.g. "18 Aug".
 */
export function dayLabel(ms) {
  try {
    return new Date(Number(ms)).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', timeZone: 'UTC',
    });
  } catch (e) {
    return '';
  }
}

/**
 * A duration for humans. Null is "no sample", which is not the same as "0 ms".
 * @param {number | null | undefined} ms - Milliseconds, or null.
 * @returns {string} e.g. "8.4s", or an em dash.
 */
export function fmtMs(ms) {
  if (ms === null || ms === undefined) return '—';
  var v = Math.max(0, Number(ms) || 0);
  if (v < 1000) return Math.round(v) + 'ms';
  if (v < 60000) return (v / 1000).toFixed(1) + 's';
  return Math.floor(v / 60000) + 'm ' + Math.round((v % 60000) / 1000) + 's';
}

/**
 * Share of requests that were handed back, as a percentage string.
 *
 * Null when nothing was attempted: a 0% refund rate on zero requests is a claim of
 * perfect reliability made by an idle API.
 * @param {number} delivered - Settled successfully.
 * @param {number} refunded - Charged then given back.
 * @returns {string | null} e.g. "4.1%", or null when there is nothing to divide.
 */
export function refundRate(delivered, refunded) {
  var total = (Number(delivered) || 0) + (Number(refunded) || 0);
  if (!total) return null;
  return ((refunded / total) * 100).toFixed(1) + '%';
}

/**
 * Build the API-usage tab controller.
 *
 * @param {object} deps
 * @param {(url: string, method: string, body?: any, isForm?: boolean) => Promise<any>} deps.apiSend
 *   Request helper from the entry (holds the admin session credential).
 * @returns {{ init: () => void, ensureLoaded: () => void, reset: () => void }} The panel.
 */
export function createApiUsagePanel({ apiSend }) {
  var _loaded = false;
  var _loading = false;
  var _range = DEFAULT_RANGE;
  /** @type {any} */
  var _usage = null;
  /** Set when the server answered but had no aggregator to answer WITH. */
  var _unavailable = false;

  function currentRange() {
    for (var i = 0; i < RANGES.length; i++) if (RANGES[i].key === _range) return RANGES[i];
    return RANGES[1];
  }

  // ── Range selector ────────────────────────────────────────────────────────

  // Same segmented control as the Overview tab's, but it refetches rather than
  // re-filtering: the aggregation happens in SQL, so a wider window is a new query
  // and not a slice of something already in memory.
  function renderRangeBar() {
    var host = qs('#adm-api-range');
    if (!host) return;
    host.innerHTML = '';
    host.appendChild(el('span', { className: 'adm-range-label', textContent: 'Showing' }));
    var track = el('div', { className: 'adm-range-track', role: 'group', 'aria-label': 'API usage date range' });
    RANGES.forEach(function (r) {
      var btn = el('button', {
        type: 'button',
        className: 'adm-range-btn' + (r.key === _range ? ' active' : ''),
        'aria-pressed': r.key === _range ? 'true' : 'false',
        textContent: r.label,
      });
      btn.addEventListener('click', function () {
        if (_range === r.key) return;
        _range = r.key;
        _loaded = false;
        renderRangeBar();
        ensureLoaded();
      });
      track.appendChild(btn);
    });
    host.appendChild(track);
  }

  // ── Stat cards ────────────────────────────────────────────────────────────

  function statCard(spec) {
    var tone = spec.tone || 'blue';
    var card = el('div', { className: 'adm-stat adm-stat--' + tone });
    card.appendChild(el('div', { className: 'adm-stat-head' }, [
      iconDiv(spec.icon, 'adm-stat-icon--' + tone),
      el('span', { className: 'adm-stat-lbl', textContent: spec.label }),
    ]));
    card.appendChild(el('span', { className: 'adm-stat-val', textContent: spec.value }));
    if (spec.hint) card.appendChild(el('span', { className: 'adm-stat-hint', textContent: spec.hint }));
    return card;
  }

  function renderStats() {
    var host = qs('#adm-api-stats');
    if (!host) return;
    host.innerHTML = '';
    if (!_usage) return;

    var t = _usage.traffic;
    var e = _usage.economics;
    var k = _usage.keys;
    var suffix = ' · ' + currentRange().short;
    var rate = refundRate(t.delivered, t.refunded);

    [
      {
        icon: 'gen', tone: 'blue', label: 'Renders delivered' + suffix, value: fmtNum(t.delivered),
        hint: t.inFlight ? fmtNum(t.inFlight) + ' still in flight' : 'None in flight',
      },
      {
        icon: 'chart', tone: 'amber', label: 'Refunded' + suffix, value: fmtNum(t.refunded),
        // The rate is the number that matters, and it is absent rather than 0%
        // when the window carried no traffic at all.
        hint: rate === null ? 'No requests in this window' : rate + ' of requests',
      },
      {
        icon: 'pro', tone: 'purple', label: 'Credits burned' + suffix, value: fmtNum(t.creditsBurned),
        hint: fmtNum(e.lifetimeSpent) + ' all time',
      },
      {
        icon: 'chart', tone: 'cyan', label: 'Median render' + suffix, value: fmtMs(t.medianMs),
        // The sample size is stated because the median is taken from a bounded,
        // newest-first sample rather than from the whole window.
        hint: t.durationSample ? 'from ' + fmtNum(t.durationSample) + ' renders' : 'No completed renders yet',
      },
      {
        icon: 'users', tone: 'green', label: 'Active accounts' + suffix, value: fmtNum(_usage.accountsTotal),
        hint: fmtNum(k.accounts) + ' hold a key',
      },
      {
        icon: 'ent', tone: 'blue', label: 'Live keys', value: fmtNum(k.active),
        hint: fmtNum(k.total) + ' created, ' + fmtNum(Math.max(0, k.total - k.active)) + ' revoked',
      },
    ].forEach(function (c) { host.appendChild(statCard(c)); });
  }

  // ── Charts ────────────────────────────────────────────────────────────────

  function renderCharts() {
    var host = qs('#adm-api-charts');
    if (!host) return;
    host.innerHTML = '';
    if (!_usage) return;

    var buckets = _usage.buckets || [];
    var delivered = _usage.traffic.delivered;
    var refunded = _usage.traffic.refunded;
    var hasTraffic = delivered + refunded > 0;

    var points = buckets.map(function (b) {
      return {
        label: dayLabel(b.day),
        short: dayLabel(b.day),
        values: [b.delivered, b.refunded],
      };
    });

    var body;
    if (!hasTraffic) {
      // Not an all-zero chart: a full-width row of empty columns looks identical to
      // a broken one, and this is the state a fresh install is always in.
      body = chartEmpty('No API requests in this window.');
    } else {
      body = stackedBarChart(points, {
        height: 250,
        colors: [C_DELIVERED, C_REFUNDED],
        labels: ['Delivered', 'Refunded'],
        unit: 'requests',
        maxLabels: 10,
      });
    }

    var card = chartCard({
      title: 'Daily API requests',
      sub: 'Requests per UTC day over the trailing ' + currentRange().label + '. The cap on each column is the part that was refunded.',
      body: body,
      wide: true,
      notes: hasTraffic
        ? [
          'Avg ' + (Math.round(((delivered + refunded) / Math.max(1, buckets.length)) * 10) / 10) + ' / day',
          fmtNum(delivered) + ' delivered',
          fmtNum(refunded) + ' refunded',
        ]
        : [],
    });
    if (hasTraffic) {
      card.appendChild(legend([
        { label: 'Delivered', value: delivered, color: C_DELIVERED },
        { label: 'Refunded', value: refunded, color: C_REFUNDED },
      ]));
    }
    host.appendChild(card);

    // Who the traffic belongs to. Ranked bars rather than a second time series:
    // the question here is concentration — whether the API is one customer or ten.
    var accounts = _usage.accounts || [];
    var top = accounts.slice(0, RANKED_TOP).filter(function (a) { return a.delivered > 0; });
    host.appendChild(chartCard({
      title: 'Busiest accounts',
      sub: 'Renders delivered per account over the same window.',
      body: top.length
        ? rankedBars(top.map(function (a) {
          return { label: a.email || a.userId || '(deleted account)', value: a.delivered };
        }), { unit: 'renders', colorful: true })
        : chartEmpty('No account has called the API in this window.'),
      wide: true,
    }));
  }

  // ── Accounts table ────────────────────────────────────────────────────────

  function renderAccounts() {
    var host = qs('#adm-api-accounts');
    if (!host) return;
    host.innerHTML = '';
    if (!_usage) return;

    var accounts = _usage.accounts || [];
    var count = qs('#adm-api-account-count');
    if (count) count.textContent = String(_usage.accountsTotal || 0);

    if (!accounts.length) {
      host.appendChild(el('p', {
        className: 'adm-empty',
        textContent: 'No account has called the API in this window. Traffic appears here as soon as a key is used.',
      }));
      return;
    }

    var tbl = el('table', { className: 'adm-table adm-api-table' });
    tbl.appendChild(el('thead', null, [el('tr', null, [
      el('th', { textContent: 'Account' }),
      el('th', { textContent: 'Delivered' }),
      el('th', { textContent: 'Refunded' }),
      el('th', { textContent: 'In flight' }),
      el('th', { textContent: 'Credits' }),
      el('th', { textContent: '7 days' }),
      el('th', { textContent: 'Keys' }),
      el('th', { textContent: 'Last call' }),
    ])]));

    var body = el('tbody');
    accounts.forEach(function (a) {
      // textContent throughout: an account email is user-supplied data and this
      // table is the operator's, not a place to start trusting it.
      var who = el('td');
      who.appendChild(el('span', {
        className: 'adm-api-acct',
        textContent: a.email || '(deleted account)',
      }));
      if (a.plan) who.appendChild(el('span', { className: 'adm-api-plan', textContent: a.plan }));

      body.appendChild(el('tr', null, [
        who,
        el('td', { textContent: fmtNum(a.delivered) }),
        el('td', { textContent: fmtNum(a.refunded) }),
        el('td', { textContent: fmtNum(a.inFlight) }),
        el('td', { textContent: fmtNum(a.creditsSpent) }),
        el('td', { textContent: fmtNum(a.delivered7d) }),
        el('td', { textContent: fmtNum(a.keysUsed) }),
        el('td', { textContent: a.lastRequestAt ? fmtDateTime(new Date(a.lastRequestAt).toISOString()) : '—' }),
      ]));
    });
    tbl.appendChild(body);
    host.appendChild(tbl);

    // Say so when the list is capped, rather than presenting the top slice as the
    // whole population.
    if ((_usage.accountsTotal || 0) > accounts.length) {
      host.appendChild(el('p', {
        className: 'adm-more',
        textContent: 'Showing the top ' + accounts.length + ' of ' + _usage.accountsTotal + ' accounts by volume.',
      }));
    }
  }

  // ── Credit economics ──────────────────────────────────────────────────────

  function renderEconomics() {
    var host = qs('#adm-api-economics');
    if (!host) return;
    host.innerHTML = '';
    if (!_usage) return;

    var e = _usage.economics;
    var rows = [
      {
        label: 'Sold in this window',
        value: fmtNum(e.purchasedInWindow),
        hint: 'Credits bought through Stripe.',
      },
      {
        label: 'Granted in this window',
        value: fmtNum(e.grantedInWindow),
        // Kept apart from the line above on purpose: both add balance and both let
        // someone render, but only one of them was paid for.
        hint: 'Credits issued by hand, not paid for.',
      },
      {
        label: 'Burned in this window',
        value: fmtNum(_usage.traffic.creditsBurned),
        hint: 'Credits consumed by delivered renders.',
      },
      {
        label: 'Outstanding balance',
        value: fmtNum(e.outstanding),
        // The liability framing is the honest one: these renders are already paid
        // for and still owed.
        hint: 'Bought and not yet spent — renders still owed across ' + fmtNum(e.fundedAccounts) + ' account(s).',
      },
      {
        label: 'Lifetime purchased',
        value: fmtNum(e.lifetimePurchased),
        hint: fmtNum(e.lifetimeSpent) + ' spent all time.',
      },
      {
        label: 'Suspended accounts',
        value: fmtNum(e.suspended),
        hint: e.suspended ? 'Cannot spend until reinstated.' : 'None suspended.',
      },
    ];

    var list = el('div', { className: 'adm-api-econ' });
    rows.forEach(function (r) {
      list.appendChild(el('div', { className: 'adm-api-econ-row' }, [
        el('span', { className: 'adm-api-econ-lbl', textContent: r.label }),
        el('span', { className: 'adm-api-econ-val', textContent: r.value }),
        el('span', { className: 'adm-api-econ-hint', textContent: r.hint }),
      ]));
    });
    host.appendChild(list);
  }

  // ── Load ──────────────────────────────────────────────────────────────────

  function renderAll() {
    renderRangeBar();
    if (_unavailable) {
      var note = qs('#adm-api-stats');
      if (note) {
        note.innerHTML = '';
        note.appendChild(el('p', {
          className: 'adm-empty',
          textContent: 'API usage is unavailable on this deployment — the server reported no usage store.',
        }));
      }
      ['#adm-api-charts', '#adm-api-accounts', '#adm-api-economics'].forEach(function (sel) {
        var host = qs(sel);
        if (host) host.innerHTML = '';
      });
      return;
    }
    renderStats();
    renderCharts();
    renderAccounts();
    renderEconomics();
  }

  function load() {
    return apiSend('/api/admin/api-usage?days=' + currentRange().days, 'GET').then(function (j) {
      _usage = (j && j.usage) || null;
      // A null payload is the documented degrade path, not a failure: the endpoint
      // answers 200 with `{ usage: null }` on a deployment that has no aggregator.
      _unavailable = !_usage;
      _loaded = true;
      renderAll();
    });
  }

  /** Fetch once per range. Repeated tab opens are free. */
  function ensureLoaded() {
    if (_loaded || _loading) return;
    _loading = true;
    var host = qs('#adm-api-stats');
    if (host) host.innerHTML = '<div class="adm-loading"><span class="adm-spinner"></span>Loading…</div>';
    load().catch(function (e) {
      if (host) {
        host.innerHTML = '';
        host.appendChild(el('div', {
          className: 'adm-host-err',
          textContent: 'Could not load API usage: ' + (e && e.message ? e.message : 'error'),
        }));
      }
    }).finally(function () { _loading = false; });
  }

  /** Refetch on the next tab open — used by Refresh and by sign-out. */
  function reset() {
    _loaded = false; _loading = false; _usage = null; _unavailable = false;
    ['#adm-api-stats', '#adm-api-charts', '#adm-api-accounts', '#adm-api-economics'].forEach(function (sel) {
      var host = qs(sel);
      if (host) host.innerHTML = '';
    });
    var count = qs('#adm-api-account-count');
    if (count) count.textContent = '0';
  }

  function init() {
    renderRangeBar();
  }

  return { init: init, ensureLoaded: ensureLoaded, reset: reset };
}
