// Access tab — who opened this console, from where, and what was refused.
//
// Reads GET /api/admin/access-log (routes/admin/access.js) over the store in
// lib/data/admin-access.js. Two questions, so two tables: "who has been here"
// (one row per IP, the recognition view) and "what just happened" (the flat feed).
//
// THERE IS NO NAME COLUMN, and that is not an omission. The console has no
// per-person accounts — everyone signs in with the same endpoint_key — so the
// honest handle on a person is their IP and their device. A name field here would
// be a claim the data cannot support.
//
// One payload holds everything, so the outcome filter is client-side: switching
// between All / Opens / Refused must not cost a round-trip, and the totals have to
// stay put while you do it.

import { qs, el, fmtDateTime } from './helpers.js';
import { fmtNum } from './charts.js';

/** Rows are grouped by outcome for the filter strip; 'all' means no filter. */
var FILTERS = [
  { key: 'all', label: 'Everything' },
  { key: 'open', label: 'Opens' },
  { key: 'signin', label: 'Sign-ins' },
  { key: 'denied', label: 'Refused' },
];

var OUTCOME_LABEL = { open: 'Opened', signin: 'Signed in', denied: 'Refused' };
// Reuses the existing badge palette rather than inventing colours: green for a
// normal open, brand for the sign-in that created the session, red for a refusal.
var OUTCOME_BADGE = { open: 'adm-badge-active', signin: 'adm-badge-pro', denied: 'adm-badge-cancelled' };
var REASON_LABEL = {
  'bad-key': 'wrong access key',
  'bad-session': 'expired or revoked session',
  'no-credential': 'no credential offered',
};

/**
 * @param {object} deps
 * @param {(url: string, method: string, body?: any, isForm?: boolean) => Promise<any>} deps.apiSend
 */
export function createAccessPanel({ apiSend }) {
  var _loaded = false;
  var _loading = false;
  var _data = null;
  var _filter = 'all';

  /** Location as one line, or an em dash. Unresolved is not "nowhere". */
  function placeOf(geo) {
    if (!geo) return '—';
    var parts = [geo.city, geo.country].filter(Boolean);
    return parts.length ? parts.join(', ') : '—';
  }

  function deviceOf(row) {
    if (row.browser && row.os) return row.browser + ' on ' + row.os;
    return row.browser || row.os || 'Unknown device';
  }

  function when(ts) {
    return ts ? fmtDateTime(new Date(ts).toISOString()) : '—';
  }

  // ── filter strip ───────────────────────────────────────────────────────────

  function renderFilter() {
    var host = qs('#adm-access-filter');
    if (!host) return;
    host.innerHTML = '';
    FILTERS.forEach(function (f) {
      var b = el('button', {
        className: 'adm-range-btn' + (f.key === _filter ? ' active' : ''),
        textContent: f.label,
      });
      b.addEventListener('click', function () {
        _filter = f.key;
        render();
      });
      host.appendChild(b);
    });
  }

  // ── summary pills ──────────────────────────────────────────────────────────

  function renderSummary() {
    var host = qs('#adm-access-summary');
    if (!host) return;
    host.innerHTML = '';
    if (!_data) return;

    if (_data.configured === false) {
      host.appendChild(el('div', {
        className: 'adm-inline-msg',
        textContent: 'Access recording is switched off, so nothing new is being logged.',
      }));
      return;
    }

    var s = _data.summary || {};
    var wrap = el('div', { className: 'adm-summary' });
    [
      { label: 'Dashboard opens', value: s.opens, cls: '' },
      { label: 'Sign-ins', value: s.signins, cls: ' adm-pill--blue' },
      // The one number worth a colour change: a non-zero refusal count is the
      // whole reason this tab exists, and it should not read like the others.
      { label: 'Refused attempts', value: s.denied, cls: s.denied ? ' adm-pill--warn' : '' },
      { label: 'Distinct addresses', value: s.distinctIps, cls: '' },
    ].forEach(function (p) {
      wrap.appendChild(el('span', {
        className: 'adm-pill' + p.cls,
        textContent: fmtNum(p.value || 0) + ' ' + p.label,
      }));
    });
    host.appendChild(wrap);
  }

  // ── who has been here ──────────────────────────────────────────────────────

  function visitorRow(v) {
    var tr = el('tr');

    var ipCell = el('td');
    ipCell.appendChild(el('div', { className: 'adm-acc-ip', textContent: v.ip }));
    if (v.isBot) ipCell.appendChild(el('span', { className: 'adm-badge', textContent: 'bot' }));
    tr.appendChild(ipCell);

    tr.appendChild(el('td', { className: 'adm-acc-loc', textContent: placeOf(v.geo) }));

    var devCell = el('td');
    (v.devices || []).slice(0, 3).forEach(function (d) {
      devCell.appendChild(el('div', { textContent: deviceOf(d) }));
    });
    if (!(v.devices || []).length) devCell.appendChild(el('div', { textContent: 'Unknown device' }));
    tr.appendChild(devCell);

    tr.appendChild(el('td', { className: 'adm-num', textContent: fmtNum(v.opens || 0) }));
    tr.appendChild(el('td', { className: 'adm-num', textContent: fmtNum(v.signins || 0) }));

    var deniedCell = el('td', { className: 'adm-num' });
    if (v.denied) deniedCell.appendChild(el('span', { className: 'adm-badge adm-badge-cancelled', textContent: fmtNum(v.denied) }));
    else deniedCell.textContent = '0';
    tr.appendChild(deniedCell);

    tr.appendChild(el('td', { textContent: when(v.firstSeen) }));
    tr.appendChild(el('td', { textContent: when(v.lastSeen) }));
    return tr;
  }

  function renderVisitors() {
    var host = qs('#adm-access-visitors');
    if (!host) return;
    host.innerHTML = '';
    if (!_data) return;

    var visitors = (_data.summary && _data.summary.visitors) || [];
    if (!visitors.length) {
      host.appendChild(el('div', {
        className: 'adm-empty',
        textContent: 'Nobody has opened this console yet.',
      }));
      return;
    }

    var tbl = el('table', { className: 'adm-table' });
    tbl.appendChild(el('thead', null, [el('tr', null, [
      el('th', { textContent: 'Address' }),
      el('th', { textContent: 'Location' }),
      el('th', { textContent: 'Device' }),
      el('th', { textContent: 'Opens' }),
      el('th', { textContent: 'Sign-ins' }),
      el('th', { textContent: 'Refused' }),
      el('th', { textContent: 'First seen' }),
      el('th', { textContent: 'Last seen' }),
    ])]));
    var body = el('tbody');
    visitors.forEach(function (v) { body.appendChild(visitorRow(v)); });
    tbl.appendChild(body);
    host.appendChild(tbl);

    var chip = qs('#adm-access-count');
    if (chip) chip.textContent = String(visitors.length);
  }

  // ── what just happened ─────────────────────────────────────────────────────

  function eventRow(r) {
    var tr = el('tr');

    var whenCell = el('td');
    whenCell.appendChild(el('div', { textContent: when(r.lastTs || r.ts) }));
    // A collapsed burst says so, rather than pretending to be one event or
    // flooding the table with twelve near-identical rows.
    if (r.hits > 1) {
      whenCell.appendChild(el('span', {
        className: 'adm-acc-hits',
        textContent: '×' + fmtNum(r.hits),
        title: 'Repeated ' + r.hits + ' times, starting ' + when(r.ts),
      }));
    }
    tr.appendChild(whenCell);

    var outCell = el('td');
    outCell.appendChild(el('span', {
      className: 'adm-badge ' + (OUTCOME_BADGE[r.outcome] || ''),
      textContent: OUTCOME_LABEL[r.outcome] || r.outcome,
    }));
    if (r.outcome === 'denied' && r.reason) {
      outCell.appendChild(el('div', { className: 'adm-acc-loc', textContent: REASON_LABEL[r.reason] || r.reason }));
    }
    tr.appendChild(outCell);

    tr.appendChild(el('td', null, [
      el('div', { className: 'adm-acc-ip', textContent: r.ip }),
      el('div', { className: 'adm-acc-loc', textContent: placeOf(r.geo) }),
    ]));
    tr.appendChild(el('td', { textContent: deviceOf(r) }));
    tr.appendChild(el('td', { className: 'adm-acc-loc', textContent: r.path || '—' }));
    return tr;
  }

  function renderEvents() {
    var host = qs('#adm-access-rows');
    if (!host) return;
    host.innerHTML = '';
    if (!_data) return;

    var rows = (_data.rows || []).filter(function (r) {
      return _filter === 'all' || r.outcome === _filter;
    });

    if (!rows.length) {
      host.appendChild(el('div', {
        className: 'adm-empty',
        textContent: _filter === 'all' ? 'No access recorded yet.' : 'Nothing matches that filter.',
      }));
      return;
    }

    var tbl = el('table', { className: 'adm-table' });
    tbl.appendChild(el('thead', null, [el('tr', null, [
      el('th', { textContent: 'When' }),
      el('th', { textContent: 'What happened' }),
      el('th', { textContent: 'From' }),
      el('th', { textContent: 'Device' }),
      el('th', { textContent: 'Path' }),
    ])]));
    var body = el('tbody');
    rows.forEach(function (r) { body.appendChild(eventRow(r)); });
    tbl.appendChild(body);
    host.appendChild(tbl);
  }

  function render() {
    renderFilter();
    renderSummary();
    renderVisitors();
    renderEvents();
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  function load() {
    return apiSend('/api/admin/access-log', 'GET').then(function (j) {
      _data = j || null;
      _loaded = true;
      render();
    });
  }

  function ensureLoaded() {
    if (_loaded || _loading) return;
    _loading = true;
    var host = qs('#adm-access-rows');
    if (host) host.innerHTML = '<div class="adm-loading"><span class="adm-spinner"></span>Loading…</div>';
    load().catch(function (e) {
      if (host) {
        host.innerHTML = '';
        host.appendChild(el('div', {
          className: 'adm-host-err',
          textContent: 'Could not load the access log: ' + (e && e.message ? e.message : 'error'),
        }));
      }
    }).finally(function () { _loading = false; });
  }

  /** Refetch on the next tab open — used by Refresh and by sign-out. */
  function reset() {
    _loaded = false; _loading = false; _data = null;
    ['#adm-access-summary', '#adm-access-visitors', '#adm-access-rows'].forEach(function (sel) {
      var host = qs(sel);
      if (host) host.innerHTML = '';
    });
  }

  function init() {
    renderFilter();
  }

  return { init: init, ensureLoaded: ensureLoaded, reset: reset };
}
