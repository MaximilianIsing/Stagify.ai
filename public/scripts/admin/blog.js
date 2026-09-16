// Admin "Blog" tab — how often each article is opened, and which ones are working.
//
// The shape mirrors the Referrals tab next door: a compact ranked list plus an
// on-demand detail card, rather than fifteen full charts stacked, so the tab stays
// readable as the blog grows.
//
// Two things worth knowing when reading the numbers:
//   * Everything labelled a "read" has already had automated traffic filtered out
//     server-side (lib/data/blog-views.js). The bot figure is surfaced separately,
//     so a quiet article is distinguishable from one whose hits were all crawlers.
//   * The list is ranked by the SELECTED WINDOW, not by lifetime reads — "which
//     posts are doing best" is a question about now. Lifetime is the tiebreak and
//     is shown in its own column, so an old, heavily-read article is still visible.

import { qs, el, fmtDate, fmtDateTime } from './helpers.js';
import { chartCard, areaChart, rankedBars, chartEmpty, fmtNum, PALETTE } from './charts.js';

/** The windows the operator can switch between, in days. */
const WINDOWS = [7, 30, 90];

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

/** The daily-reads chart for one post, or for the whole blog. */
function readsChart(series, opts) {
  var points = (series || []).map(function (p) { return { label: dayLabel(p.date), value: p.value }; });
  var any = points.some(function (p) { return p.value > 0; });
  return chartCard({
    title: opts.title,
    sub: opts.sub,
    wide: !!opts.wide,
    body: any
      ? areaChart(points, { height: opts.height || 220, color: opts.color || PALETTE[0], unit: 'reads', maxLabels: 10 })
      : chartEmpty(opts.empty || 'No reads recorded in this window.'),
    notes: opts.notes || [],
  });
}

/**
 * Build the Blog-tab controller.
 *
 * @param {object} deps
 * @param {(url: string, method: string, body?: any, isForm?: boolean) => Promise<any>} deps.apiSend
 *   Request helper from the entry (holds the session key).
 */
export function createBlogPanel({ apiSend }) {
  var _loaded = false;
  var _loading = false;
  var _days = 30;
  /** @type {any} */
  var _data = null;
  /** @type {string | null} */
  var _selected = null;

  // ── summary ────────────────────────────────────────────────────────────────

  function renderSummary() {
    var host = qs('#adm-blog-summary');
    if (!host) return;
    host.innerHTML = '';
    if (!_data) return;
    var t = _data.totals || {};

    var stats = el('div', { className: 'adm-summary' });
    stats.appendChild(pill('All time: ' + fmtNum(t.views) + ' reads', 'blue'));
    stats.appendChild(pill('Last ' + _data.days + ' days: ' + fmtNum(t.windowViews)));
    stats.appendChild(pill(fmtNum(t.posts) + ' articles'));
    if (t.unread) stats.appendChild(pill(fmtNum(t.unread) + ' never opened', 'warn'));
    if (t.botHits) stats.appendChild(pill(fmtNum(t.botHits) + ' bot hits excluded'));
    host.appendChild(stats);

    if (_data.configured === false) {
      // The catalog still renders; say plainly that nothing is being counted rather
      // than showing a wall of zeroes that reads as "nobody visits the blog".
      host.appendChild(el('p', {
        className: 'adm-inline-msg adm-inline-msg--err',
        textContent: 'View counting is not configured on this server, so these numbers are all zero.',
      }));
      return;
    }

    host.appendChild(readsChart(t.series, {
      title: 'Blog reads per day',
      sub: 'Every article combined, over the trailing ' + _data.days + ' days. Automated traffic excluded.',
      wide: true,
      height: 240,
      color: PALETTE[2],
      empty: 'No reads recorded in this window yet.',
      notes: [fmtNum(t.windowViews) + ' reads in ' + _data.days + ' days', fmtNum(t.views) + ' all time'],
    }));
  }

  // ── list ───────────────────────────────────────────────────────────────────

  function rowFor(post) {
    var tr = el('tr', { className: 'adm-ref-row' + (post.slug === _selected ? ' adm-ref-row--on' : '') });

    tr.appendChild(el('td', null, [
      el('span', { className: 'adm-blog-title', textContent: post.title }),
      post.retired ? el('span', { className: 'adm-badge adm-badge-cancelled', textContent: 'removed' }) : null,
    ]));
    tr.appendChild(el('td', { textContent: post.publishedAt ? fmtDate(post.publishedAt) : '—' }));
    tr.appendChild(el('td', { className: 'adm-num', textContent: fmtNum(post.windowViews) }));
    tr.appendChild(el('td', { className: 'adm-num', textContent: fmtNum(post.last7) }));
    tr.appendChild(el('td', { className: 'adm-num', textContent: fmtNum(post.views) }));
    tr.appendChild(el('td', { textContent: whenText(post.lastViewAt) }));

    tr.addEventListener('click', function () {
      _selected = _selected === post.slug ? null : post.slug;
      render();
    });
    return tr;
  }

  function renderList() {
    var host = qs('#adm-blog-list');
    if (!host) return;
    host.innerHTML = '';

    var posts = (_data && _data.posts) || [];
    var count = qs('#adm-blog-count');
    if (count) count.textContent = String(posts.length);
    var chip = qs('#tc-blog');
    if (chip) chip.textContent = String(posts.length);

    if (!posts.length) {
      host.appendChild(el('p', {
        className: 'adm-empty',
        textContent: 'No articles found in public/blog.',
      }));
      return;
    }

    var tbl = el('table', { className: 'adm-table adm-blog-table' });
    tbl.appendChild(el('thead', null, [el('tr', null, [
      el('th', { textContent: 'Article' }),
      el('th', { textContent: 'Published' }),
      el('th', { textContent: _data.days + ' days' }),
      el('th', { textContent: '7 days' }),
      el('th', { textContent: 'All time' }),
      el('th', { textContent: 'Last read' }),
    ])]));
    var body = el('tbody');
    posts.forEach(function (post) { body.appendChild(rowFor(post)); });
    tbl.appendChild(body);
    host.appendChild(tbl);
    host.appendChild(el('p', {
      className: 'adm-more',
      textContent: 'Ranked by reads in the last ' + _data.days + ' days. Select an article to see its chart and traffic sources.',
    }));
  }

  // ── detail ─────────────────────────────────────────────────────────────────

  function detailCard(post) {
    var card = el('div', { className: 'adm-card adm-ref-card' });
    card.appendChild(el('h2', null, [
      document.createTextNode(post.title),
      el('span', { className: 'adm-count-chip', textContent: fmtNum(post.views) + ' reads' }),
    ]));

    var url = location.origin + post.path;
    var row = el('div', { className: 'adm-host-url-row' });
    var link = el('a', { className: 'adm-host-url', href: post.path, target: '_blank', rel: 'noopener', title: url, textContent: url });
    row.appendChild(link);
    card.appendChild(row);

    var stats = el('div', { className: 'adm-summary' });
    stats.appendChild(pill('All time: ' + fmtNum(post.views), 'blue'));
    stats.appendChild(pill('Last ' + post.windowDays + ' days: ' + fmtNum(post.windowViews)));
    stats.appendChild(pill('Last 7 days: ' + fmtNum(post.last7)));
    stats.appendChild(pill('Last read: ' + whenText(post.lastViewAt)));
    if (post.publishedAt) stats.appendChild(pill('Published ' + fmtDate(post.publishedAt)));
    if (post.botHits) stats.appendChild(pill(fmtNum(post.botHits) + ' bot hits excluded'));
    if (post.retired) stats.appendChild(pill('No longer published', 'warn'));
    card.appendChild(stats);

    card.appendChild(readsChart(post.series, {
      title: 'Reads per day',
      sub: 'Opens of ' + post.path + ' over the trailing ' + post.windowDays + ' days.',
      color: PALETTE[1],
      empty: 'No reads recorded yet for this article.',
      notes: [
        post.firstViewAt ? 'First read ' + whenText(post.firstViewAt) : 'No reads yet',
        fmtNum(post.windowViews) + ' in the last ' + post.windowDays + ' days',
      ],
    }));

    var sources = el('div', { className: 'adm-ref-sources' });
    sources.appendChild(el('h3', { className: 'adm-ref-sources-title', textContent: 'Where the readers came from' }));
    if (post.referrers && post.referrers.length) {
      sources.appendChild(rankedBars(
        post.referrers.map(function (r) { return { label: r.source, value: r.value }; }),
        { unit: 'reads', colorful: true },
      ));
    } else {
      // Normal for search traffic that strips the referrer, for links opened from a
      // messaging app, and for anyone typing the URL — an empty list is not a bug.
      sources.appendChild(el('p', {
        className: 'adm-empty',
        textContent: 'No referring sites recorded. Search engines, messaging apps and typed URLs often send no referrer — that is normal.',
      }));
    }
    card.appendChild(sources);
    return card;
  }

  function renderDetail() {
    var host = qs('#adm-blog-detail');
    if (!host) return;
    host.innerHTML = '';
    if (!_selected || !_data) return;
    var post = (_data.posts || []).filter(function (p) { return p.slug === _selected; })[0];
    // The selection can vanish under us when the window changes and a post drops
    // out of the payload — drop it rather than rendering nothing.
    if (!post) { _selected = null; return; }
    host.appendChild(detailCard(post));
  }

  function renderWindow() {
    var host = qs('#adm-blog-window');
    if (!host) return;
    host.innerHTML = '';
    WINDOWS.forEach(function (days) {
      var b = el('button', {
        type: 'button',
        className: 'adm-range-btn' + (days === _days ? ' active' : ''),
        textContent: days + ' days',
      });
      b.addEventListener('click', function () {
        if (_days === days) return;
        _days = days;
        load().catch(function () { /* surfaced by the list's error state */ });
      });
      host.appendChild(b);
    });
  }

  function render() {
    renderWindow();
    renderSummary();
    renderList();
    renderDetail();
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  function load() {
    return apiSend('/api/admin/blog-views?days=' + _days, 'GET').then(function (j) {
      _data = j || null;
      _loaded = true;
      render();
    });
  }

  function ensureLoaded() {
    if (_loaded || _loading) return;
    _loading = true;
    var host = qs('#adm-blog-list');
    if (host) host.innerHTML = '<div class="adm-loading"><span class="adm-spinner"></span>Loading…</div>';
    load().catch(function (e) {
      if (host) {
        host.innerHTML = '';
        host.appendChild(el('div', {
          className: 'adm-host-err',
          textContent: 'Could not load blog readership: ' + (e && e.message ? e.message : 'error'),
        }));
      }
    }).finally(function () { _loading = false; });
  }

  /** Refetch on the next tab open — used by Refresh and by sign-out. */
  function reset() {
    _loaded = false; _loading = false; _data = null; _selected = null;
    ['#adm-blog-summary', '#adm-blog-list', '#adm-blog-detail'].forEach(function (sel) {
      var host = qs(sel);
      if (host) host.innerHTML = '';
    });
  }

  function init() {
    renderWindow();
  }

  return { init: init, ensureLoaded: ensureLoaded, reset: reset };
}
