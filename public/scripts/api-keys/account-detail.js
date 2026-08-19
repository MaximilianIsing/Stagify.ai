// The two account-level panes: Usage and Credits & billing.
//
// They are separate rows in the rail, and separate panes here, because they answer
// questions that are only related by accident. Usage is "is my integration healthy" —
// traffic, failures, how long a render takes. Billing is "can it keep running" — a
// balance, a ledger and four packs. Merging them is what produced the old page's
// balance card, where a number you check daily sat in the same box as a purchase flow
// you touch once a month.
//
// Both panes emit HOSTS for the two islands that already existed — `#ak-packs` and
// `#ak-ledger` — rather than rendering packs and ledger rows themselves. The pane is
// re-rendered on every selection change, so those islands are re-run against the fresh
// hosts by the composition root; credit-packs.js is also what developers.html uses, and
// duplicating it here would be the second copy of the price table.
//
// Every string resolves through i18n.js — see the note in inspector.js for why nothing
// this file renders may carry `data-lang`. The one exception is the suspended notice,
// which is `data-lang-html` because it contains a mailto link; the composition root
// re-applies the pack after every paint, which is what makes that safe.

import { escapeHtml } from '../escape-html.js';
import { chartHtml } from './usage-chart.js';
import { t, plural } from './i18n.js';
import { formatCount, formatDuration, formatPercent, noValue, percent } from './format.js';

/**
 * A stat tile. Same shape as key-detail's, because the two panes sit one click apart
 * and a tile that changed size between them would read as a different kind of number.
 * @param {string} label - What it is.
 * @param {string} value - The number.
 * @param {string} [note] - The line under it.
 * @param {string} [modifier] - Extra class suffix, e.g. `accent`.
 * @returns {string} HTML.
 */
function statHtml(label, value, note, modifier) {
  return (
    '<div class="ak-stat' + (modifier ? ' ak-stat--' + escapeHtml(modifier) : '') + '">'
    + '<span class="ak-stat__label">' + escapeHtml(label) + '</span>'
    + '<span class="ak-stat__value">' + escapeHtml(value) + '</span>'
    + '<span class="ak-stat__note">' + escapeHtml(note || '') + '</span>'
    + '</div>'
  );
}

/**
 * How long the balance lasts at the last week's pace.
 *
 * The seven-day window rather than the thirty-day one: an integration that doubled its
 * traffic last Tuesday is burning at the new rate, and a month-long average would tell
 * someone they have three weeks left on the day before they run out. Returns null when
 * nothing was rendered — a runway divided by a zero burn is infinity, and printing that
 * as a number of days would be a lie in the reassuring direction.
 * @param {number} balance - Credits on hand.
 * @param {any} usage - The usage summary, or null.
 * @returns {number | null} Whole days, or null.
 */
export function runwayDays(balance, usage) {
  const week = Number(usage?.totals?.delivered7d || 0);
  if (!(week > 0) || !(Number(balance) > 0)) return null;
  return Math.max(1, Math.floor(Number(balance) / (week / 7)));
}

/**
 * The Usage pane.
 * @param {{ usage?: any, keys?: any[] }} state - The dashboard state.
 * @returns {string} HTML.
 */
export function usageDetailHtml(state = {}) {
  const usage = state.usage;
  const keys = Array.isArray(state.keys) ? state.keys : [];
  const days = Number(usage?.days) || 30;
  const totals = usage?.totals || null;

  if (!usage) {
    return (
      '<header class="ak-detail__head"><div><h2 id="ak-detail-title">'
      + escapeHtml(t('apiKeys.usage.title', 'Usage')) + '</h2>'
      + '<p class="ak-detail__sub">'
      + escapeHtml(t('apiKeys.usage.failedTitle', 'Could not load usage just now.'))
      + '</p></div></header>'
      + '<p class="ak-empty">' + escapeHtml(t(
        'apiKeys.usage.failedBody',
        'Your keys and balance are unaffected. This pane counts requests, and that count is '
        + 'the only thing missing. Reload to try again.',
      )) + '</p>'
    );
  }

  const delivered = Number(totals.delivered || 0);
  const refunded = Number(totals.refunded || 0);
  const rate = percent(delivered, delivered + refunded);

  const names = new Map(keys.map((k) => [String(k.id), String(k.name || t('apiKeys.key.fallbackName', 'API key'))]));
  const rows = (usage.keys || [])
    .slice()
    .sort((a, b) => Number(b.delivered || 0) - Number(a.delivered || 0))
    .map((k) => {
      const keyId = String(k.keyId);
      return (
        '<tr>'
        + '<td><button type="button" class="ak-linkbtn" data-ak-select="' + escapeHtml(keyId) + '">'
        + escapeHtml(names.get(keyId) || t('apiKeys.usage.deletedKey', 'Deleted key')) + '</button></td>'
        + '<td class="dev-num">' + escapeHtml(formatCount(k.delivered)) + '</td>'
        + '<td class="dev-num">' + escapeHtml(formatCount(k.refunded)) + '</td>'
        + '<td class="dev-num">' + escapeHtml(formatDuration(k.medianMs)) + '</td>'
        + '<td class="dev-num">' + escapeHtml(formatCount(k.creditsSpent)) + '</td>'
        + '</tr>'
      );
    })
    .join('');

  const breakdown = rows
    ? '<div class="dev-table-scroll"><table class="dev-table">'
      + '<thead><tr>'
      + '<th>' + escapeHtml(t('apiKeys.usage.thKey', 'Key')) + '</th>'
      + '<th>' + escapeHtml(t('apiKeys.stat.delivered', 'Delivered')) + '</th>'
      + '<th>' + escapeHtml(t('apiKeys.usage.thRefunded', 'Refunded')) + '</th>'
      + '<th>' + escapeHtml(t('apiKeys.usage.thMedian', 'Median')) + '</th>'
      + '<th>' + escapeHtml(t('apiKeys.usage.thCredits', 'Credits')) + '</th>'
      + '</tr></thead>'
      + '<tbody>' + rows + '</tbody></table></div>'
    : '<p class="ak-empty">' + escapeHtml(t('apiKeys.usage.empty', 'No requests in this window.')) + '</p>';

  // The sample cap is stated rather than hidden. The median is taken from the most
  // recent N durations, and a reader comparing it against their own logs deserves to
  // know that rather than wondering why the two disagree on a busy month.
  const sampleNote = Number(usage.durationSample) > 0
    ? '<p class="ak-footnote">' + escapeHtml(t(
      'apiKeys.usage.sampleNote',
      'Median timed from the most recent {count} delivered renders. Days are UTC.',
      { count: formatCount(usage.durationSample) },
    )) + '</p>'
    : '';

  return (
    '<header class="ak-detail__head"><div>'
    + '<h2 id="ak-detail-title">' + escapeHtml(t('apiKeys.usage.title', 'Usage')) + '</h2>'
    + '<p class="ak-detail__sub">' + escapeHtml(plural('apiKeys.usage.lede', days, {
      one: 'Last day, across every key on the account.',
      other: 'Last {count} days, across every key on the account.',
    })) + '</p>'
    + '</div></header>'
    + '<div class="ak-stats">'
    + statHtml(
      t('apiKeys.stat.renders', 'Renders · {days}d', { days }),
      formatCount(delivered),
      t('apiKeys.note.lastSeven', '{count} in the last 7 days', { count: formatCount(totals.delivered7d || 0) }),
    )
    + statHtml(
      t('apiKeys.stat.delivered', 'Delivered'),
      formatPercent(rate),
      refunded
        ? t('apiKeys.note.refundedAuto', '{count} refunded automatically', { count: formatCount(refunded) })
        : t('apiKeys.note.noFailures', 'no failed renders'),
    )
    + statHtml(
      t('apiKeys.stat.median', 'Median render'),
      formatDuration(totals.medianMs),
      t('apiKeys.note.endToEnd', 'end to end'),
    )
    + statHtml(
      t('apiKeys.stat.creditsSpent', 'Credits spent'),
      formatCount(totals.creditsSpent || 0),
      t('apiKeys.note.inWindow', 'in this window'),
    )
    + '</div>'
    + '<section class="ak-panel"><h3>' + escapeHtml(t('apiKeys.usage.perDay', 'Renders per day')) + '</h3>'
    + chartHtml(usage.buckets || [])
    + '</section>'
    + '<section class="ak-panel"><h3>' + escapeHtml(t('apiKeys.usage.byKey', 'By key')) + '</h3>'
    + breakdown + sampleNote + '</section>'
  );
}

/**
 * The Credits & billing pane.
 *
 * Emits the two island hosts and nothing they own. `#ak-packs` keeps its
 * `data-loading` attribute so a slow pack fetch says "Loading pricing…" instead of
 * showing an empty grid, exactly as it did on the old page.
 * @param {{ credits?: any, usage?: any }} state - The dashboard state.
 * @returns {string} HTML.
 */
export function billingDetailHtml(state = {}) {
  const credits = state.credits || {};
  const balance = Number(credits.balance || 0);
  const purchased = Number(credits.lifetimePurchased || 0);
  const spent = Number(credits.lifetimeSpent || 0);
  const runway = runwayDays(balance, state.usage);

  // data-lang-html rather than a t() call: this one carries a mailto link, and putting
  // markup through t() would mean either trusting a pack with innerHTML or splitting the
  // sentence around the address in eleven languages.
  const suspended = credits.suspended
    ? '<div class="dev-alert" id="ak-suspended" data-lang-html="apiKeys.billing.suspended">'
      + 'This account is suspended and cannot render. '
      + 'Contact <a href="mailto:team@stagify.ai">team@stagify.ai</a>.</div>'
    : '';

  return (
    '<header class="ak-detail__head"><div>'
    + '<h2 id="ak-detail-title">' + escapeHtml(t('apiKeys.billing.title', 'Credits & billing')) + '</h2>'
    + '<p class="ak-detail__sub">' + escapeHtml(t(
      'apiKeys.billing.lede',
      'Prepaid. One credit is one delivered image, and a render that fails is refunded automatically.',
    )) + '</p>'
    + '</div></header>'
    + '<div class="ak-stats">'
    + statHtml(
      t('apiKeys.stat.balance', 'Balance'),
      formatCount(balance),
      plural('apiKeys.note.images', balance, { one: 'image', other: 'images' }),
      'accent',
    )
    + statHtml(t('apiKeys.stat.purchased', 'Purchased'), formatCount(purchased), t('apiKeys.note.allTime', 'all time'))
    + statHtml(t('apiKeys.stat.spent', 'Spent'), formatCount(spent), t('apiKeys.note.allTime', 'all time'))
    + statHtml(
      t('apiKeys.stat.runway', 'Runway'),
      runway == null
        ? noValue()
        : plural('apiKeys.note.runwayDays', runway, { one: '≈ {count} day', other: '≈ {count} days' }),
      runway == null
        ? t('apiKeys.note.noBurn', 'no renders in the last week')
        : t('apiKeys.note.weekPace', 'at this week’s pace'),
    )
    + '</div>'
    + suspended
    + '<section class="ak-panel"><h3>' + escapeHtml(t('apiKeys.billing.buy', 'Buy credits')) + '</h3>'
    + '<div class="dev-packs" id="ak-packs" data-loading="true">'
    + '<p class="dev-packs__loading" data-lang="developers.packs.loading">Loading pricing…</p></div>'
    + '</section>'
    + '<section class="ak-panel"><h3>' + escapeHtml(t('apiKeys.billing.activity', 'Recent activity')) + '</h3>'
    + '<div class="dev-table-scroll"><table class="dev-table">'
    + '<thead><tr>'
    + '<th>' + escapeHtml(t('apiKeys.billing.thWhen', 'When')) + '</th>'
    + '<th>' + escapeHtml(t('apiKeys.billing.thWhat', 'What')) + '</th>'
    + '<th>' + escapeHtml(t('apiKeys.billing.thChange', 'Change')) + '</th>'
    + '<th>' + escapeHtml(t('apiKeys.stat.balance', 'Balance')) + '</th>'
    + '</tr></thead>'
    + '<tbody id="ak-ledger" aria-live="polite"></tbody></table></div>'
    + '</section>'
  );
}
