// Admin "Referrals" tab — create, retire and delete campaign short-URLs
// (/columbia, …) and read each one's numbers.
//
// Links are operator data, so this panel is the only place they exist: the server
// registers no route per slug, it resolves them from the store. Layout is a compact
// list plus an on-demand detail card, rather than every link's full chart stacked,
// so the tab stays readable once there are a dozen campaigns.
//
// Retiring and deleting are deliberately two different buttons. "Retire" stops the
// URL resolving but keeps the row and its clicks — a campaign's results outlive the
// campaign. Only a retired link offers "Delete permanently", so the destructive
// action can't be the one you reach for by accident.
//
// Everything labelled a "click" has already had automated traffic filtered out
// server-side (lib/data/referral-links.js); the bot figure is surfaced separately so
// a quiet campaign is distinguishable from one whose hits were all link-preview
// crawlers.

import { qs, el, fmtDateTime, copyToClipboard } from './helpers.js';
import { chartCard, areaChart, rankedBars, chartEmpty, fmtNum, PALETTE } from './charts.js';

/** 'YYYY-MM-DD' → 'Jul 1'. Parsed as UTC to match the server's day buckets. */
function dayLabel(date) {
  var d = new Date(String(date) + 'T00:00:00Z');
  if (isNaN(d.getTime())) return String(date);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Epoch ms → readable stamp, or an em dash. */
function whenText(ts) {
  return ts ? fmtDateTime(new Date(ts).toISOString()) : '—';
}

function pill(text, tone) {
  return el('span', { className: 'adm-pill' + (tone ? ' adm-pill--' + tone : ''), textContent: text });
}

/**
 * Build the Referrals-tab controller.
 *
 * @param {object} deps
 * @param {(url: string, method: string, body?: any, isForm?: boolean) => Promise<any>} deps.apiSend
 *   Request helper from the entry (holds the session key).
 */
export function createReferralsPanel({ apiSend }) {
  var _loaded = false;
  var _loading = false;
  /** @type {any[]} */
  var _links = [];
  /** @type {string | null} */
  var _selected = null;

  // ── messages ───────────────────────────────────────────────────────────────

  function setFormMsg(text, kind) {
    var box = qs('#adm-ref-form-msg');
    if (!box) return;
    box.textContent = text || '';
    box.className = 'adm-inline-msg' + (kind ? ' adm-inline-msg--' + kind : '');
  }

  // ── list ───────────────────────────────────────────────────────────────────

  function actionButton(label, cls, onClick) {
    var b = el('button', { className: 'adm-ref-action ' + cls, type: 'button', textContent: label });
    b.addEventListener('click', function (ev) {
      // Rows are clickable (they open the detail); an action must not also select.
      if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
      onClick(b);
    });
    return b;
  }

  function rowFor(link) {
    var url = location.origin + link.path;
    var tr = el('tr', { className: 'adm-ref-row' + (link.slug === _selected ? ' adm-ref-row--on' : '') });

    tr.appendChild(el('td', null, [
      el('span', { className: 'adm-ref-slug', textContent: link.path }),
      link.active ? null : el('span', { className: 'adm-badge adm-badge-cancelled', textContent: 'retired' }),
    ]));
    tr.appendChild(el('td', { textContent: link.label }));
    tr.appendChild(el('td', { className: 'adm-num', textContent: fmtNum(link.clicks) }));
    tr.appendChild(el('td', { className: 'adm-num', textContent: fmtNum(link.last7) }));
    tr.appendChild(el('td', { textContent: whenText(link.lastClickAt) }));

    var actions = el('td', { className: 'adm-ref-actions' });
    actions.appendChild(actionButton('Copy', 'adm-ref-action--quiet', function (btn) {
      copyToClipboard(url, btn);
    }));
    if (link.active) {
      actions.appendChild(actionButton('Retire', 'adm-ref-action--warn', function () {
        act('/api/admin/referrals/' + link.slug + '/deactivate', 'POST', link.path + ' is retired — the URL no longer works, its history is kept.');
      }));
    } else {
      actions.appendChild(actionButton('Restore', 'adm-ref-action--quiet', function () {
        act('/api/admin/referrals/' + link.slug + '/activate', 'POST', link.path + ' works again.');
      }));
      // Offered only once a link is retired, so the irreversible button is never
      // the one sitting next to a live campaign.
      actions.appendChild(actionButton('Delete', 'adm-ref-action--danger', function () {
        var msg = 'Permanently delete ' + link.path + '?\n\nThis also erases its '
          + fmtNum(link.clicks) + ' recorded click(s). This cannot be undone.';
        if (!confirm(msg)) return;
        act('/api/admin/referrals/' + link.slug, 'DELETE', link.path + ' deleted.');
      }));
    }
    tr.appendChild(actions);

    tr.addEventListener('click', function () {
      _selected = _selected === link.slug ? null : link.slug;
      render();
    });
    return tr;
  }

  function renderList() {
    var host = qs('#adm-referrals');
    if (!host) return;
    host.innerHTML = '';

    var count = qs('#adm-ref-count');
    if (count) count.textContent = String(_links.length);

    if (!_links.length) {
      host.appendChild(el('p', {
        className: 'adm-empty',
        textContent: 'No links yet. Create one above and share it — every visit through it gets counted here.',
      }));
      return;
    }

    var tbl = el('table', { className: 'adm-table adm-ref-table' });
    tbl.appendChild(el('thead', null, [el('tr', null, [
      el('th', { textContent: 'Link' }),
      el('th', { textContent: 'Name' }),
      el('th', { textContent: 'Clicks' }),
      el('th', { textContent: '7 days' }),
      el('th', { textContent: 'Last click' }),
      el('th', { textContent: '' }),
    ])]));
    var body = el('tbody');
    _links.forEach(function (link) { body.appendChild(rowFor(link)); });
    tbl.appendChild(body);
    host.appendChild(tbl);
    host.appendChild(el('p', { className: 'adm-more', textContent: 'Select a link to see its chart and traffic sources.' }));
  }

  // ── detail ─────────────────────────────────────────────────────────────────

  function detailCard(link) {
    var card = el('div', { className: 'adm-card adm-ref-card' });
    card.appendChild(el('h2', null, [
      document.createTextNode(link.label),
      el('span', { className: 'adm-count-chip', textContent: fmtNum(link.clicks) + ' clicks' }),
    ]));
    if (link.note) card.appendChild(el('p', { className: 'adm-card-sub', textContent: link.note }));

    var url = location.origin + link.path;
    var row = el('div', { className: 'adm-host-url-row' });
    row.appendChild(el('div', { className: 'adm-host-url', title: url, textContent: url }));
    var copy = el('button', { className: 'adm-host-copy', type: 'button', textContent: 'Copy' });
    copy.addEventListener('click', function () { copyToClipboard(url, copy); });
    row.appendChild(copy);
    card.appendChild(row);

    var stats = el('div', { className: 'adm-summary' });
    stats.appendChild(pill('All time: ' + fmtNum(link.clicks), 'blue'));
    stats.appendChild(pill('Last ' + link.windowDays + ' days: ' + fmtNum(link.windowClicks)));
    stats.appendChild(pill('Last 7 days: ' + fmtNum(link.last7)));
    stats.appendChild(pill('Last click: ' + whenText(link.lastClickAt)));
    if (link.botHits) stats.appendChild(pill(fmtNum(link.botHits) + ' bot hits excluded'));
    if (!link.active) stats.appendChild(pill('Retired ' + whenText(link.deactivatedAt)));
    card.appendChild(stats);

    var points = (link.series || []).map(function (p) {
      return { label: dayLabel(p.date), value: p.value };
    });
    card.appendChild(chartCard({
      title: 'Clicks per day',
      sub: 'Human visits through ' + link.path + ' over the trailing ' + link.windowDays + ' days.',
      body: link.clicks || link.windowClicks
        ? areaChart(points, { height: 220, color: PALETTE[1], unit: 'clicks', maxLabels: 10 })
        : chartEmpty('No clicks recorded yet — share the link above to start counting.'),
      notes: [
        link.firstClickAt ? 'First click ' + whenText(link.firstClickAt) : 'No clicks yet',
        fmtNum(link.windowClicks) + ' in the last ' + link.windowDays + ' days',
      ],
    }));

    var sources = el('div', { className: 'adm-ref-sources' });
    sources.appendChild(el('h3', { className: 'adm-ref-sources-title', textContent: 'Where the clicks came from' }));
    if (link.referrers && link.referrers.length) {
      sources.appendChild(rankedBars(
        link.referrers.map(function (r) { return { label: r.source, value: r.value }; }),
        { unit: 'clicks', colorful: true },
      ));
    } else {
      // The common case for a link handed out on paper, in a QR code, or in a DM:
      // browsers send no Referer for those, so an empty list is not a bug.
      sources.appendChild(el('p', {
        className: 'adm-empty',
        textContent: 'No referring sites recorded. Links opened from a QR code, a message app, or typed by hand arrive with no referrer — that is normal.',
      }));
    }
    card.appendChild(sources);
    return card;
  }

  function renderDetail() {
    var host = qs('#adm-ref-detail');
    if (!host) return;
    host.innerHTML = '';
    if (!_selected) return;
    var link = _links.filter(function (l) { return l.slug === _selected; })[0];
    // The selected link can vanish under us (deleted in another tab, or by the
    // delete button itself) — drop the selection rather than rendering nothing.
    if (!link) { _selected = null; return; }
    host.appendChild(detailCard(link));
  }

  function render() {
    renderList();
    renderDetail();
  }

  // ── server actions ─────────────────────────────────────────────────────────

  /** Run a mutating call, then reload the list so every number is server-truth. */
  function act(url, method, okMessage) {
    setFormMsg('', null);
    return apiSend(url, method).then(function () {
      setFormMsg(okMessage, 'ok');
      return load();
    }).catch(function (e) {
      setFormMsg(e && e.message ? e.message : 'That did not work.', 'err');
    });
  }

  function load() {
    return apiSend('/api/admin/referrals', 'GET').then(function (j) {
      _links = (j && j.links) || [];
      _loaded = true;
      render();
    });
  }

  function create() {
    var slugEl = /** @type {HTMLInputElement} */ (qs('#adm-ref-slug'));
    var labelEl = /** @type {HTMLInputElement} */ (qs('#adm-ref-label'));
    var noteEl = /** @type {HTMLInputElement} */ (qs('#adm-ref-note'));
    var btn = /** @type {HTMLButtonElement} */ (qs('#adm-ref-create'));
    if (!slugEl || !labelEl || !btn) return;

    var payload = {
      slug: (slugEl.value || '').trim().toLowerCase(),
      label: (labelEl.value || '').trim(),
      note: (noteEl && noteEl.value ? noteEl.value : '').trim(),
    };
    if (!payload.slug) { setFormMsg('Enter a URL for the link.', 'err'); return; }
    if (!payload.label) { setFormMsg('Give the link a name so you can tell it apart later.', 'err'); return; }

    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = 'Creating…';
    setFormMsg('', null);

    apiSend('/api/admin/referrals', 'POST', payload).then(function (j) {
      slugEl.value = ''; labelEl.value = ''; if (noteEl) noteEl.value = '';
      updatePreview();
      var made = (j && j.link) || null;
      setFormMsg(made ? 'Created ' + location.origin + made.path + ' — it works right now.' : 'Link created.', 'ok');
      if (made) _selected = made.slug;
      return load();
    }).catch(function (e) {
      // The server's message names the exact problem (reserved name, already
      // taken, bad characters), so it is shown verbatim rather than generalised.
      setFormMsg(e && e.message ? e.message : 'Could not create the link.', 'err');
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = original;
    });
  }

  /** Live "this is the URL you'll get" line under the slug field. */
  function updatePreview() {
    var slugEl = /** @type {HTMLInputElement} */ (qs('#adm-ref-slug'));
    var out = qs('#adm-ref-preview');
    if (!slugEl || !out) return;
    var slug = (slugEl.value || '').trim().toLowerCase();
    out.textContent = slug ? location.origin + '/' + slug : '';
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  function ensureLoaded() {
    if (_loaded || _loading) return;
    _loading = true;
    var host = qs('#adm-referrals');
    if (host) host.innerHTML = '<div class="adm-loading"><span class="adm-spinner"></span>Loading…</div>';
    load().catch(function (e) {
      if (host) {
        host.innerHTML = '';
        host.appendChild(el('div', {
          className: 'adm-host-err',
          textContent: 'Could not load referral links: ' + (e && e.message ? e.message : 'error'),
        }));
      }
    }).finally(function () { _loading = false; });
  }

  /** Refetch on the next tab open — used by Refresh and by sign-out. */
  function reset() {
    _loaded = false; _loading = false; _links = []; _selected = null;
    var host = qs('#adm-referrals');
    if (host) host.innerHTML = '';
    var detail = qs('#adm-ref-detail');
    if (detail) detail.innerHTML = '';
    setFormMsg('', null);
  }

  function init() {
    var btn = qs('#adm-ref-create');
    if (btn) btn.addEventListener('click', create);
    var slugEl = qs('#adm-ref-slug');
    if (slugEl) slugEl.addEventListener('input', updatePreview);
    var form = qs('#adm-ref-form');
    if (form) {
      form.addEventListener('submit', function (ev) {
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        create();
      });
    }
  }

  return { init: init, ensureLoaded: ensureLoaded, reset: reset };
}
