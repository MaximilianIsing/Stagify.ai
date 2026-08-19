// The "recent activity" table: what moved the balance, and when.
//
// Every row in this table is a row in api_credit_ledger, which is the SOURCE of the
// balance rather than a log of it (lib/data/api-billing.js). That is why a refund shows
// as its own +1 line instead of the debit quietly vanishing: a customer asking "why am
// I down three credits" needs to see the three charges and the one refund, not a number
// that silently disagrees with their own count.

import { escapeHtml } from '../escape-html.js';
import { t, locale } from './i18n.js';
import { noValue } from './format.js';

/**
 * English for the ledger's `reason` codes, and the key each looks up.
 *
 * The CODE is what the database stores and what the API returns; these are only how it
 * is read out. An unknown code prints itself rather than "undefined" — a reason added
 * server-side before the packs catch up should show something a support ticket can
 * quote, not a blank cell.
 */
const REASONS = {
  purchase: 'Credits purchased',
  debit: 'Render',
  refund: 'Render failed, refunded',
  clawback: 'Payment reversed',
  grant: 'Credits granted',
  adjustment: 'Adjustment',
};

/**
 * @param {string} reason - The stored reason code.
 * @returns {string} Something a person can read.
 */
export function reasonLabel(reason) {
  const english = REASONS[reason];
  if (!english) return String(reason || t('apiKeys.ledger.activity', 'Activity'));
  return t('apiKeys.ledger.' + reason, english);
}

/**
 * Date and time, since several entries can land in one day.
 * @param {number} ms - Epoch millis.
 * @returns {string} A short local datetime.
 */
export function formatStamp(ms) {
  if (!ms) return noValue();
  try {
    return new Date(Number(ms)).toLocaleString(locale(), {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return noValue();
  }
}

/**
 * Render the ledger rows.
 * @param {HTMLElement | null} host - The tbody.
 * @param {any[]} entries - Ledger rows, newest first.
 * @returns {void}
 */
export function renderLedger(host, entries) {
  if (!host) return;
  if (!entries || !entries.length) {
    host.innerHTML = '<tr><td colspan="4" class="dev-empty">'
      + escapeHtml(t('apiKeys.billing.empty', 'Nothing yet.')) + '</td></tr>';
    return;
  }
  host.innerHTML = entries
    .map((e) => {
      const delta = Number(e.delta);
      // The sign is carried by a class as well as the glyph, so the direction survives
      // for anyone who cannot distinguish the two colours.
      const cls = delta >= 0 ? 'dev-pos' : 'dev-neg';
      const sign = delta >= 0 ? '+' : '';
      return (
        '<tr>'
        + '<td class="dev-num">' + escapeHtml(formatStamp(e.createdAt)) + '</td>'
        + '<td>' + escapeHtml(reasonLabel(e.reason)) + '</td>'
        + '<td class="dev-num ' + cls + '">' + escapeHtml(sign + String(delta)) + '</td>'
        + '<td class="dev-num">' + escapeHtml(String(e.balanceAfter)) + '</td>'
        + '</tr>'
      );
    })
    .join('');
}
