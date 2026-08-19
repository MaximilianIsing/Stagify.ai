// The detail pane for ONE key: what it is, what it has been doing, and the one
// irreversible thing you can do to it.
//
// WHAT IS NOT HERE, AND WHY. There is no "show key" affordance and there never can be —
// the server stores a digest, so after the create dialog closes the plaintext does not
// exist anywhere. The pane shows the display prefix instead, which is exactly enough to
// match this row against a line in an access log and nowhere near enough to call the
// API with. There is also no "rotate": that would be create-then-revoke, two calls with
// a window in between where either both or neither key works, and the API has no
// endpoint that does it atomically. Offering a button for it would be a promise the
// backend cannot keep.
//
// REVOKE IS WALLED OFF. It breaks whatever is using the key, immediately and with no
// undo, so it lives in its own bordered block at the bottom rather than in the header
// next to Rename. That separation is the point: the two are one tab-stop apart in the
// old flat list, and the wrong one is unrecoverable.
//
// Every string resolves through i18n.js — see the note in inspector.js for why nothing
// this file renders may carry `data-lang`.

import { escapeHtml } from '../escape-html.js';
import { chartHtml } from './usage-chart.js';
import { t, plural } from './i18n.js';
import {
  formatAgo, formatCount, formatDuration, formatPercent, formatStamp,
  keyStatus, noValue, percent, statusLabel,
} from './format.js';

/**
 * One stat tile.
 * @param {string} label - What it is.
 * @param {string} value - The number.
 * @param {string} [note] - The line under it.
 * @returns {string} HTML.
 */
function statHtml(label, value, note) {
  return (
    '<div class="ak-stat">'
    + '<span class="ak-stat__label">' + escapeHtml(label) + '</span>'
    + '<span class="ak-stat__value">' + escapeHtml(value) + '</span>'
    + '<span class="ak-stat__note">' + escapeHtml(note || '') + '</span>'
    + '</div>'
  );
}

/**
 * One definition-list field.
 * @param {string} term - The label.
 * @param {string} value - The value, already plain text.
 * @param {{ mono?: boolean }} [opts] - Render the value as code.
 * @returns {string} HTML.
 */
function fieldHtml(term, value, opts = {}) {
  const v = opts.mono ? '<code>' + escapeHtml(value) + '</code>' : escapeHtml(value);
  return '<div class="ak-field"><dt>' + escapeHtml(term) + '</dt><dd>' + v + '</dd></div>';
}

/**
 * The pane.
 *
 * THREE usage states, not two, and conflating the last two is the easy mistake. `usage`
 * is this key's row from GET /api/api-usage; `usageLoaded` says whether that call
 * answered at all. A key with no traffic in the window has NO row, so without the flag
 * "you have not called us this month" and "we could not count your renders" render
 * identically — and only one of those is the account's fault.
 * @param {any} key - The public key record.
 * @param {{ usage?: any, usageLoaded?: boolean, windowDays?: number, now?: number, buckets?: any[] }} [opts] - Usage context.
 * @returns {string} HTML.
 */
export function keyDetailHtml(key, opts = {}) {
  if (!key) return '';
  const nowMs = opts.now || Date.now();
  const status = keyStatus(key, nowMs);
  const windowDays = Number(opts.windowDays) || 30;
  const revoked = status === 'revoked';

  // A loaded summary with no row for this key IS an answer: zero of everything. Only an
  // unanswered call leaves `row` null, and only that prints the no-value placeholder.
  const idle = { delivered: 0, refunded: 0, inFlight: 0, creditsSpent: 0, delivered7d: 0, medianMs: null };
  const row = opts.usage || (opts.usageLoaded ? idle : null);

  const delivered = row ? Number(row.delivered || 0) : null;
  const refunded = row ? Number(row.refunded || 0) : null;
  const rate = row ? percent(delivered, delivered + refunded) : null;

  /** @returns {string} The note under the delivery rate. */
  function deliveredNote() {
    if (!row) return t('apiKeys.note.usageUnavailable', 'usage unavailable');
    if (refunded) return t('apiKeys.note.refunded', '{count} refunded', { count: formatCount(refunded) });
    return delivered
      ? t('apiKeys.note.noFailures', 'no failed renders')
      : t('apiKeys.note.nothingYet', 'nothing rendered yet');
  }

  const stats =
    statHtml(
      t('apiKeys.stat.renders', 'Renders · {days}d', { days: windowDays }),
      row ? formatCount(delivered) : noValue(),
      row
        ? t('apiKeys.note.lastSeven', '{count} in the last 7 days', { count: formatCount(row.delivered7d || 0) })
        : t('apiKeys.note.usageUnavailable', 'usage unavailable'),
    )
    + statHtml(
      t('apiKeys.stat.delivered', 'Delivered'),
      formatPercent(rate),
      deliveredNote(),
    )
    + statHtml(
      t('apiKeys.stat.median', 'Median render'),
      row ? formatDuration(row.medianMs) : noValue(),
      row && row.inFlight
        ? t('apiKeys.note.inFlight', '{count} in flight now', { count: formatCount(row.inFlight) })
        : t('apiKeys.note.endToEnd', 'end to end'),
    )
    + statHtml(
      t('apiKeys.stat.creditsSpent', 'Credits spent'),
      row ? formatCount(row.creditsSpent || 0) : noValue(),
      t('apiKeys.note.throughKey', 'through this key'),
    );

  // A revoked key keeps its history — that is the whole reason revoked keys stay
  // listed — but loses every control, including Rename. Renaming a key nobody can use
  // rewrites the label on an audit trail.
  const actions = revoked
    ? ''
    : '<button type="button" class="dev-btn dev-btn--small" data-ak-rename="' + escapeHtml(String(key.id)) + '">'
      + escapeHtml(t('apiKeys.key.rename', 'Rename')) + '</button>';

  const danger = revoked
    ? '<div class="ak-note">'
      + escapeHtml(t(
        'apiKeys.key.revokedNote',
        'Revoked on {when}. The row stays here so this key still resolves to a name in an access log.',
        { when: formatStamp(key.revokedAt) },
      ))
      + '</div>'
    : '<div class="ak-danger">'
      + '<h3>' + escapeHtml(t('apiKeys.key.danger.title', 'Revoke this key')) + '</h3>'
      + '<p>' + escapeHtml(t(
        'apiKeys.key.danger.body',
        'Anything using it stops working immediately, and this cannot be undone. '
        + 'The key stays listed afterwards so you can still recognise it in an access log.',
      )) + '</p>'
      + '<button type="button" class="dev-btn dev-btn--small dev-btn--danger" data-revoke-key="'
      + escapeHtml(String(key.id)) + '">' + escapeHtml(t('apiKeys.key.danger.cta', 'Revoke key')) + '</button>'
      + '</div>';

  return (
    '<header class="ak-detail__head">'
    + '<div>'
    + '<h2 id="ak-detail-title">'
    + escapeHtml(String(key.name || t('apiKeys.key.fallbackName', 'API key')))
    + ' <span class="ak-tag ak-tag--' + status + '">' + escapeHtml(statusLabel(status)) + '</span></h2>'
    + '<p class="ak-detail__sub"><code>' + escapeHtml(String(key.prefix || '')) + '…</code>'
    + ' · ' + escapeHtml(t('apiKeys.key.lastUsed', 'last used {ago}', { ago: formatAgo(key.lastUsedAt, nowMs) }))
    + '</p>'
    + '</div>'
    + '<div class="ak-detail__actions">' + actions + '</div>'
    + '</header>'
    + '<div class="ak-stats">' + stats + '</div>'
    + '<section class="ak-panel">'
    + '<h3>' + escapeHtml(plural('apiKeys.key.chart', windowDays, {
      one: 'Renders · last day',
      other: 'Renders · last {count} days',
    })) + '</h3>'
    + chartHtml(opts.buckets || [])
    + '</section>'
    + '<dl class="ak-fields">'
    + fieldHtml(t('apiKeys.key.prefix', 'Key prefix'), String(key.prefix || '') + '…', { mono: true })
    + fieldHtml(t('apiKeys.key.created', 'Created'), formatStamp(key.createdAt))
    + fieldHtml(t('apiKeys.key.lastUsedField', 'Last used'), formatStamp(key.lastUsedAt))
    + (revoked ? fieldHtml(t('apiKeys.key.revokedField', 'Revoked'), formatStamp(key.revokedAt)) : '')
    + '</dl>'
    + danger
  );
}

/**
 * The inline rename form, which replaces the key's title in place.
 *
 * In place rather than in a dialog: renaming is a low-stakes correction, and a modal
 * for it would be heavier than the mistake it fixes. The create dialog stays modal
 * because what it shows can never be shown again.
 * @param {any} key - The key being renamed.
 * @returns {string} HTML.
 */
export function renameFormHtml(key) {
  return (
    '<form class="ak-rename" data-ak-rename-form="' + escapeHtml(String(key.id)) + '">'
    + '<label class="sr-only" for="ak-rename-input">'
    + escapeHtml(t('apiKeys.key.nameLabel', 'Key name')) + '</label>'
    + '<input class="dev-input" id="ak-rename-input" name="name" type="text" maxlength="60"'
    + ' value="' + escapeHtml(String(key.name || '')) + '" autocomplete="off">'
    + '<button type="submit" class="dev-btn dev-btn--small dev-btn--primary">'
    + escapeHtml(t('apiKeys.key.save', 'Save')) + '</button>'
    + '<button type="button" class="dev-btn dev-btn--small" data-ak-rename-cancel>'
    + escapeHtml(t('apiKeys.key.cancel', 'Cancel')) + '</button>'
    + '</form>'
  );
}
