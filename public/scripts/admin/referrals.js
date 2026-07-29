// Admin "Referrals" tab — one card per campaign short-URL (/columbia, …) showing
// the copyable link, its click totals, a daily chart, and where the clicks came
// from. Kept out of renderers.js so that file stays under its line cap, and lazy-
// loaded on first tab open like the Emails gallery.
//
// Data comes from GET /api/admin/referrals. Everything labelled a "click" there has
// already had automated traffic filtered out server-side (lib/data/referral-links.js);
// the bot figure is surfaced separately so a quiet campaign is distinguishable from
// one whose hits were all link-preview crawlers.

import { qs, el, fmtDateTime, copyToClipboard } from './helpers.js';
import { chartCard, areaChart, rankedBars, chartEmpty, fmtNum, PALETTE } from './charts.js';

/** 'YYYY-MM-DD' → 'Jul 1'. Parsed as UTC to match the server's day buckets. */
function dayLabel(date) {
  var d = new Date(String(date) + 'T00:00:00Z');
  if (isNaN(d.getTime())) return String(date);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
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

  function linkCard(link) {
    var card = el('div', { className: 'adm-card adm-ref-card' });

    card.appendChild(el('h2', null, [
      document.createTextNode(link.label || link.slug),
      el('span', { className: 'adm-count-chip', textContent: fmtNum(link.clicks) + ' clicks' }),
    ]));
    if (link.note) card.appendChild(el('p', { className: 'adm-card-sub', textContent: link.note }));

    // The shareable URL, built from this page's origin so it is right in local dev
    // and on the real domain without a config value.
    var url = location.origin + (link.path || '/' + link.slug);
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
    stats.appendChild(pill('Last click: ' + (link.lastClickAt ? fmtDateTime(new Date(link.lastClickAt).toISOString()) : '—')));
    if (link.botHits) stats.appendChild(pill(fmtNum(link.botHits) + ' bot hits excluded'));
    card.appendChild(stats);

    var points = (link.series || []).map(function (p) {
      return { label: dayLabel(p.date), value: p.value };
    });
    card.appendChild(chartCard({
      title: 'Clicks per day',
      sub: 'Human visits through ' + (link.path || '/' + link.slug) + ' over the trailing ' + link.windowDays + ' days.',
      body: link.clicks || link.windowClicks
        ? areaChart(points, { height: 220, color: PALETTE[1], unit: 'clicks', maxLabels: 10 })
        : chartEmpty('No clicks recorded yet — share the link above to start counting.'),
      notes: [
        link.firstClickAt ? 'First click ' + fmtDateTime(new Date(link.firstClickAt).toISOString()) : 'No clicks yet',
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

  function render(links) {
    var host = qs('#adm-referrals');
    if (!host) return;
    host.innerHTML = '';
    if (!links || !links.length) {
      host.appendChild(el('div', { className: 'adm-detail-empty', textContent: 'No referral links are configured.' }));
      return;
    }
    links.forEach(function (link) { host.appendChild(linkCard(link)); });
  }

  function ensureLoaded() {
    if (_loaded || _loading) return;
    _loading = true;
    var host = qs('#adm-referrals');
    if (host) host.innerHTML = '<div class="adm-loading"><span class="adm-spinner"></span>Loading…</div>';
    apiSend('/api/admin/referrals', 'GET').then(function (j) {
      _loaded = true; _loading = false;
      render((j && j.links) || []);
    }).catch(function (e) {
      _loading = false;
      if (host) {
        host.innerHTML = '';
        host.appendChild(el('div', {
          className: 'adm-host-err',
          textContent: 'Could not load referral stats: ' + (e && e.message ? e.message : 'error'),
        }));
      }
    });
  }

  /** Refetch on the next tab open — used by Refresh and by sign-out. */
  function reset() {
    _loaded = false; _loading = false;
    var host = qs('#adm-referrals');
    if (host) host.innerHTML = '';
  }

  return { ensureLoaded: ensureLoaded, reset: reset };
}
