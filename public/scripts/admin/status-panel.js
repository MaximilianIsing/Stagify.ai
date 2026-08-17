// The Server status tab: the operator's view of the same monitor that feeds the
// public /status page, plus the controls that page has no business exposing.
//
// WHAT MAKES IT "DEEPER" THAN /status, concretely — everything here is either hidden
// from the public payload or deliberately softened on it:
//   - coverage per window. A 100% figure means nothing without knowing we only
//     watched four of the last 24 hours, and the public page shows the percentage
//     alone. Here the two sit together, and a partial window says so.
//   - a 30-day graph. The public page draws 24h and 7d; the admin snapshot adds the
//     third window, which is the one that shows a pattern rather than an event.
//   - the monitor's own configuration (heartbeat cadence, the gap that counts as an
//     outage, retention, where the state lives) — the numbers you need to know
//     whether an absence of incidents means "healthy" or "not watching".
//   - both feeds separated: heartbeat-detected gaps vs. what a human posted.
//
// It polls while its tab is open, because the whole point of a status view is that
// it is current — every other panel is a snapshot of the last Refresh.

import { qs, el, fmtDateTime } from './helpers.js';
import { showErrorToast } from '../toast.js';

const POLL_MS = 30 * 1000;

/** Windows the admin view reports, widest last. */
const WINDOWS = [
  { key: '24h', label: '24 hours' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
];

/** Compact duration: the same shape the public page uses, so the two agree. */
export function fmtDuration(ms) {
  const v = Math.max(0, Number(ms) || 0);
  if (v < 1000) return '0s';
  const s = Math.round(v / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + (m % 60) + 'm';
  const d = Math.floor(h / 24);
  return d + 'd ' + (h % 24) + 'h';
}

/** "12s ago" / "4m ago". Null is never, not zero. */
export function fmtAgo(ms) {
  if (ms === null || ms === undefined) return 'never';
  const v = Math.max(0, Number(ms) || 0);
  if (v < 60000) return Math.round(v / 1000) + 's ago';
  if (v < 3600000) return Math.round(v / 60000) + 'm ago';
  if (v < 86400000) return Math.round(v / 3600000) + 'h ago';
  return Math.round(v / 86400000) + 'd ago';
}

/** Truncated, never rounded up: 99.97% must not read as 100%. */
export function fmtPct(v) {
  if (v === null || v === undefined) return '—';
  return (Math.floor(v * 100 + 1e-6) / 100).toFixed(2) + '%';
}

/**
 * An epoch ms for a `datetime-local` input, in LOCAL time.
 *
 * `toISOString` is UTC, so feeding it straight to the input offsets the value by the
 * viewer's timezone — an operator in New York would post an incident five hours off
 * without a single thing looking wrong.
 */
export function toLocalInputValue(ms) {
  const d = new Date(ms);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

/** The inverse. `new Date(value)` reads a datetime-local string as local time. */
export function fromLocalInputValue(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {object} deps
 * @param {(url: string, method: string, body?: any, isForm?: boolean) => Promise<any>} deps.apiSend
 */
export function createStatusPanel({ apiSend }) {
  let loaded = false;
  let timer = null;
  /** @type {any} */
  let snapshot = null;

  // ── Rendering ────────────────────────────────────────────────────────────

  function statePill(data) {
    const up = data.currentState === 'up';
    return el('span', {
      className: 'adm-live-pill ' + (up ? 'adm-live-pill--up' : 'adm-live-pill--down'),
      textContent: up ? 'Operational' : 'Disruption',
    });
  }

  /** The live header: what is true right now, and how well we can even tell. */
  function liveCard(data) {
    const card = el('div', { className: 'adm-card adm-live' });
    const head = el('div', { className: 'adm-live-head' }, [
      statePill(data),
      el('span', {
        className: 'adm-live-beat',
        textContent: 'Heartbeat ' + fmtAgo(data.lastCheckedMsAgo),
        title: data.lastBeat ? fmtDateTime(new Date(data.lastBeat).toISOString()) : 'No heartbeat recorded',
      }),
      el('a', {
        className: 'adm-live-link', href: '/status', target: '_blank', rel: 'noopener',
        textContent: 'Public page ↗',
      }),
    ]);
    card.appendChild(head);

    const cfg = data.config || {};
    const facts = [
      ['Monitoring since', data.monitoringSince ? fmtDateTime(new Date(data.monitoringSince).toISOString()) : '—'],
      ['Boots recorded', String(data.bootCount || 0)],
      ['Heartbeat every', fmtDuration(cfg.intervalMs || data.intervalMs)],
      ['Counts as down after', fmtDuration(cfg.gapThresholdMs)],
      ['Incident retention', (cfg.retentionDays || 90) + ' days'],
      ['Incidents on record', String(data.totalIncidents || 0)],
    ];
    const grid = el('div', { className: 'adm-detail-info-grid adm-live-facts' });
    for (const [k, v] of facts) {
      grid.appendChild(el('div', { className: 'adm-detail-kv' }, [
        el('strong', { textContent: k + ': ' }),
        el('span', { textContent: v }),
      ]));
    }
    card.appendChild(grid);

    // The caveat the public page cannot make: a single-instance server cannot
    // report its own downtime while it is down.
    card.appendChild(el('p', {
      className: 'adm-live-note',
      textContent: 'Downtime is inferred from missed heartbeats on the next boot — a server '
        + 'cannot report an outage while it is down. Anything the process survived has to be '
        + 'posted by hand below.',
    }));
    return card;
  }

  /** One window: the percentage, and the two numbers that qualify it. */
  function windowCards(data) {
    const wrap = el('div', { className: 'adm-stats adm-status-stats' });
    for (const w of WINDOWS) {
      const win = (data.windows && data.windows[w.key]) || {};
      const card = el('div', { className: 'adm-stat' });
      card.appendChild(el('div', { className: 'adm-stat-head' }, [
        el('span', { className: 'adm-stat-lbl', textContent: w.label }),
      ]));
      card.appendChild(el('span', { className: 'adm-stat-val', textContent: fmtPct(win.uptimePct) }));
      const coverage = Math.round((win.coverage || 0) * 100);
      card.appendChild(el('span', {
        className: 'adm-stat-hint',
        textContent: fmtDuration(win.downMs) + ' down · ' + win.incidents + ' incident'
          + (win.incidents === 1 ? '' : 's'),
      }));
      // Coverage below 100% means the window predates monitoring, so the percentage
      // describes less time than its label claims. Saying so is the difference
      // between a status page and a reassurance.
      card.appendChild(el('span', {
        className: 'adm-stat-hint' + (coverage < 100 ? ' adm-stat-hint--warn' : ''),
        textContent: coverage < 100 ? 'only ' + coverage + '% of this window monitored' : 'full window monitored',
      }));
      wrap.appendChild(card);
    }
    return wrap;
  }

  function barsCard(data, key, label) {
    const buckets = (data.buckets && data.buckets[key]) || [];
    const card = el('div', { className: 'adm-card adm-chart-card' });
    card.appendChild(el('div', { className: 'adm-chart-head' }, [
      el('h2', {}, [
        document.createTextNode(label),
        el('span', { className: 'adm-card-tag', textContent: buckets.length + ' bars' }),
      ]),
    ]));
    const strip = el('div', { className: 'adm-upbars', role: 'img', 'aria-label': label + ' uptime' });
    for (const b of buckets) {
      const pct = b.uptimePct === null || b.uptimePct === undefined ? 'no data' : fmtPct(b.uptimePct);
      strip.appendChild(el('span', {
        className: 'adm-upbar adm-upbar--' + b.state,
        title: fmtDateTime(new Date(b.start).toISOString()) + ' · ' + pct
          + (b.downMs ? ' · ' + fmtDuration(b.downMs) + ' down' : ''),
      }));
    }
    card.appendChild(strip);
    card.appendChild(el('div', { className: 'adm-upbars-axis' }, [
      el('span', { textContent: label.replace('Last ', '') + ' ago' }),
      el('span', { textContent: 'now' }),
    ]));
    return card;
  }

  function legend() {
    const wrap = el('div', { className: 'adm-upbars-legend' });
    for (const [state, label] of [['up', 'Operational'], ['partial', 'Partial'], ['down', 'Down'], ['nodata', 'No data']]) {
      wrap.appendChild(el('span', {}, [
        el('i', { className: 'adm-upbar adm-upbar--' + state }),
        el('span', { textContent: label }),
      ]));
    }
    return wrap;
  }

  function renderBody() {
    const host = qs('#adm-status-body');
    if (!host || !snapshot) return;
    host.innerHTML = '';
    host.appendChild(liveCard(snapshot));
    host.appendChild(windowCards(snapshot));
    const grid = el('div', { className: 'adm-chart-grid adm-chart-grid--2col' });
    grid.appendChild(barsCard(snapshot, '24h', 'Last 24 hours'));
    grid.appendChild(barsCard(snapshot, '7d', 'Last 7 days'));
    const wide = barsCard(snapshot, '30d', 'Last 30 days');
    wide.classList.add('adm-chart-card--wide');
    grid.appendChild(wide);
    host.appendChild(grid);
    host.appendChild(legend());
  }

  // ── Incident log ─────────────────────────────────────────────────────────

  function actionButtons(inc) {
    const cell = el('div', { className: 'adm-ref-actions' });
    if (inc.source !== 'manual') return cell;

    if (inc.ongoing) {
      const resolve = el('button', { className: 'adm-ref-action adm-ref-action--quiet', type: 'button', textContent: 'Resolve' });
      resolve.addEventListener('click', () => {
        resolve.disabled = true;
        apiSend('/api/admin/incidents/' + encodeURIComponent(inc.id) + '/resolve', 'POST')
          .then(() => refresh())
          .catch((e) => { resolve.disabled = false; showErrorToast('Could not resolve: ' + e.message); });
      });
      cell.appendChild(resolve);
    }

    const del = el('button', { className: 'adm-ref-action adm-ref-action--danger', type: 'button', textContent: 'Delete' });
    del.addEventListener('click', () => {
      // It is on the public status page; removing it is a publishing action.
      if (!confirm('Delete this incident?\n\n"' + inc.cause + '"\n\nIt disappears from the public status page immediately.')) return;
      del.disabled = true;
      apiSend('/api/admin/incidents/' + encodeURIComponent(inc.id), 'DELETE')
        .then(() => refresh())
        .catch((e) => { del.disabled = false; showErrorToast('Could not delete: ' + e.message); });
    });
    cell.appendChild(del);
    return cell;
  }

  function incidentRow(inc) {
    const tr = el('tr', {});

    const when = el('td', {}, [
      el('div', { textContent: fmtDateTime(new Date(inc.start).toISOString()) }),
      el('div', {
        className: 'adm-inc-end',
        textContent: inc.ongoing ? 'ongoing' : '→ ' + fmtDateTime(new Date(inc.end).toISOString()),
      }),
    ]);
    tr.appendChild(when);

    tr.appendChild(el('td', {}, [
      el('div', { className: 'adm-inc-title', textContent: inc.cause || 'Downtime' }),
      inc.ongoing ? el('span', { className: 'adm-badge adm-badge-cancelled', textContent: 'Ongoing' }) : null,
    ]));

    tr.appendChild(el('td', {}, [
      el('span', {
        className: 'adm-badge ' + (inc.source === 'manual' ? 'adm-badge-pro' : 'adm-badge-free'),
        textContent: inc.source === 'manual' ? 'Posted' : 'Detected',
      }),
    ]));

    tr.appendChild(el('td', {}, [
      el('span', {
        className: 'adm-badge ' + (inc.affectsUptime ? 'adm-badge-enterprise' : 'adm-badge-free'),
        textContent: inc.affectsUptime ? 'Counts' : 'Notice',
      }),
    ]));

    tr.appendChild(el('td', { className: 'adm-num', textContent: fmtDuration(inc.durationMs) }));
    tr.appendChild(el('td', {}, [actionButtons(inc)]));
    return tr;
  }

  function renderIncidents() {
    const host = qs('#adm-inc-table');
    if (!host || !snapshot) return;
    // Both feeds in one table: the admin snapshot carries the manual entries
    // separately, and `incidents` already interleaves them newest-first.
    const rows = snapshot.incidents || [];
    const count = qs('#adm-inc-count');
    if (count) {
      const posted = rows.filter((r) => r.source === 'manual').length;
      count.textContent = rows.length + ' shown · ' + posted + ' posted by hand';
    }

    host.innerHTML = '';
    if (!rows.length) {
      host.appendChild(el('p', { className: 'adm-empty', textContent: 'No incidents recorded, detected or posted.' }));
      return;
    }
    const table = el('table', { className: 'adm-table' });
    const thead = el('thead', {}, [el('tr', {}, ['When', 'What', 'Source', 'Uptime', 'Duration', ''].map(
      (h) => el('th', { textContent: h }),
    ))]);
    table.appendChild(thead);
    const tbody = el('tbody', {});
    rows.forEach((inc) => tbody.appendChild(incidentRow(inc)));
    table.appendChild(tbody);
    host.appendChild(table);
  }

  /** A dot on the rail while something is unresolved, so it is visible from any tab. */
  function renderRailDot() {
    const dot = qs('#tc-status');
    if (!dot) return;
    const live = (snapshot && (snapshot.incidents || []).some((i) => i.ongoing)) || false;
    if (live) dot.removeAttribute('hidden');
    else dot.setAttribute('hidden', 'hidden');
  }

  function renderAll() {
    renderBody();
    renderIncidents();
    renderRailDot();
  }

  // ── Data ─────────────────────────────────────────────────────────────────

  /**
   * Fetch, then render — with the catch around the FETCH only.
   *
   * Wrapping both in one `.catch` meant a TypeError in the rendering half was
   * reported to the operator as "Could not load server status", and worse, was
   * swallowed: a missing DOM method left the panel silently half-drawn with a
   * network-shaped excuse on screen. A render bug now rejects, which surfaces in the
   * console where a bug belongs.
   */
  function refresh() {
    return apiSend('/api/admin/status', 'GET').then((data) => {
      snapshot = data;
      loaded = true;
      return data;
    }, (e) => {
      const host = qs('#adm-status-body');
      if (host && !snapshot) {
        host.innerHTML = '';
        host.appendChild(el('p', { className: 'adm-empty', textContent: 'Could not load server status: ' + e.message }));
      }
      return null;
    }).then((data) => {
      if (data) renderAll();
      return data;
    });
  }

  /**
   * Poll only while this tab is the visible one. A background tab polling every 30s
   * for a page nobody is looking at is pure noise in the logs — and the panel
   * re-renders on open anyway.
   */
  function tick() {
    const panel = qs('#panel-status');
    if (!panel || !panel.classList.contains('active')) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    refresh();
  }

  // ── Wiring ───────────────────────────────────────────────────────────────

  function postIncident(e) {
    e.preventDefault();
    const btn = qs('#adm-inc-post');
    const msg = qs('#adm-inc-msg');
    const title = qs('#adm-inc-title');
    const body = {
      title: title ? title.value : '',
      start: fromLocalInputValue(qs('#adm-inc-start') && qs('#adm-inc-start').value),
      end: fromLocalInputValue(qs('#adm-inc-end') && qs('#adm-inc-end').value),
      affectsUptime: !!(qs('#adm-inc-affects') && qs('#adm-inc-affects').checked),
    };
    if (msg) { msg.textContent = ''; msg.className = 'adm-inline-msg'; }
    if (btn) { btn.disabled = true; btn.textContent = 'Posting…'; }

    apiSend('/api/admin/incidents', 'POST', body).then(() => {
      if (title) title.value = '';
      const end = qs('#adm-inc-end');
      if (end) end.value = '';
      resetStartField();
      if (msg) { msg.className = 'adm-inline-msg adm-inline-msg--ok'; msg.textContent = '✓ Posted. It is on the public status page now.'; }
      return refresh();
    }).catch((err) => {
      // The server's message is written for whoever is filling in this form, so it
      // is shown verbatim rather than replaced with a generic failure.
      if (msg) { msg.className = 'adm-inline-msg adm-inline-msg--err'; msg.textContent = err.message; }
    }).finally(() => {
      if (btn) { btn.disabled = false; btn.textContent = 'Post incident'; }
    });
  }

  /** Default the start to now, in the operator's own timezone. */
  function resetStartField() {
    const start = qs('#adm-inc-start');
    if (start) start.value = toLocalInputValue(Date.now());
  }

  function init() {
    const form = qs('#adm-inc-form');
    if (form) form.addEventListener('submit', postIncident);
    resetStartField();
    if (typeof setInterval === 'function') {
      // `any` because this runs in both worlds: the browser's setInterval returns a
      // number, Node's (which the DOM-stubbed suites use) returns a Timeout — and
      // only the latter can be unref'd, which is what stops the poll holding the
      // test runner open forever.
      const handle = /** @type {any} */ (setInterval(tick, POLL_MS));
      timer = handle;
      if (handle && typeof handle.unref === 'function') handle.unref();
    }
  }

  return {
    init,
    /** Called when the tab opens: first load fetches, later opens re-poll. */
    ensureLoaded() {
      if (!loaded) return refresh();
      return refresh();
    },
    /** Sign-out / Refresh: drop what we know so nothing stale is shown. */
    reset() {
      loaded = false;
      snapshot = null;
      const host = qs('#adm-status-body');
      if (host) host.innerHTML = '';
      const table = qs('#adm-inc-table');
      if (table) table.innerHTML = '';
      renderRailDot();
    },
    _stop() { if (timer) clearInterval(timer); timer = null; },
  };
}
