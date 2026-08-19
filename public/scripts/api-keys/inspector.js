// The master list: everything this account HAS, in one column, with the detail pane
// showing whichever one is selected.
//
// WHY A LIST AND NOT FOUR STACKED CARDS. The page used to show balance, keys, packs and
// ledger as four boxes of equal weight, which works while an account has two keys and
// stops working at ten — the list grows the page instead of the list. Here the column
// is fixed and every row is the same shape, so an agency with a key per brokerage reads
// exactly like a hobbyist with one.
//
// BILLING IS A ROW, NOT A HEADER. Credits are an account-level object, the same kind of
// thing as a key, so they get the same affordance rather than a permanent banner. That
// is the whole reason this shape scales: anything the account owns can become a row.
//
// SELECTION SEMANTICS. `aria-current` on a button, not a tablist. A tablist promises
// arrow-key navigation between tabs, and a list that also holds a search box and a
// create button is not a tab strip; plain buttons keep the natural tab order and
// promise nothing they do not deliver.
//
// NO `data-lang` ANYWHERE IN HERE. The rail is rebuilt on every paint, so a node
// carrying one would be localized only until the next render; every string is looked up
// through i18n.js instead, and the composition root repaints on `languagechange`.

import { escapeHtml } from '../escape-html.js';
import { t, plural } from './i18n.js';
import { formatAgo, formatCount, keyStatus, statusLabel } from './format.js';

/**
 * The two account-level rows, which are selectable exactly like a key.
 *
 * The labels are keys, not text: they are resolved at render time so a language switch
 * repaints them with everything else.
 */
export const ACCOUNT_ITEMS = [
  { id: 'usage', key: 'apiKeys.nav.usage', english: 'Usage' },
  { id: 'billing', key: 'apiKeys.nav.billing', english: 'Credits & billing' },
];

/**
 * Which item the URL is asking for.
 *
 * `#key/<id>` rather than a bare `#<id>`: a key id is opaque, and the prefix is what
 * makes a pasted link readable and keeps the two namespaces from colliding the day an
 * account-level row is called `ak_…`. An unknown id resolves to null so the caller can
 * fall back rather than render an empty pane for a key that was revoked and cleaned up.
 * @param {string} hash - `location.hash`.
 * @param {any[]} keys - The key records, used to reject ids that no longer exist.
 * @returns {string | null} The selection id, or null.
 */
export function selectionFromHash(hash, keys) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) return null;
  if (ACCOUNT_ITEMS.some((i) => i.id === raw)) return raw;
  const m = /^key\/(.+)$/.exec(raw);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  return (keys || []).some((k) => String(k.id) === id) ? id : null;
}

/**
 * The URL fragment for a selection.
 * @param {string} selection - An account item id or a key id.
 * @returns {string} e.g. `#key/ak_123`.
 */
export function hashFor(selection) {
  if (ACCOUNT_ITEMS.some((i) => i.id === selection)) return '#' + selection;
  return '#key/' + encodeURIComponent(String(selection));
}

/**
 * What to show when the URL says nothing.
 *
 * The first live key, because that is the object a returning developer came for; an
 * account with none of them lands on billing, which is where the next useful action is
 * (buy credits) rather than on an empty key pane.
 * @param {any[]} keys - The key records.
 * @returns {string} A selection id.
 */
export function defaultSelection(keys) {
  const live = (keys || []).find((k) => !k.revokedAt);
  return live ? String(live.id) : 'billing';
}

/**
 * One row.
 * @param {{ id: string, title: string, sub: string, selected: boolean, muted?: boolean, status?: string }} item - Row data.
 * @returns {string} HTML.
 */
function rowHtml(item) {
  return (
    '<button type="button" class="ak-item' + (item.muted ? ' ak-item--muted' : '') + '"'
    + ' data-ak-select="' + escapeHtml(item.id) + '"'
    + (item.selected ? ' aria-current="page"' : '')
    + '>'
    + '<span class="ak-item__title">' + escapeHtml(item.title) + '</span>'
    + '<span class="ak-item__sub">'
    + (item.status ? '<span class="ak-dot ak-dot--' + escapeHtml(item.status) + '" aria-hidden="true"></span>' : '')
    + escapeHtml(item.sub)
    + '</span>'
    + '</button>'
  );
}

/**
 * Render the whole column.
 *
 * `filter` hides KEYS ONLY — the account rows stay put. Filtering them out would mean a
 * search for "prod" silently removes the way back to the balance, and a list that can
 * be emptied by typing is a list people stop typing in.
 * @param {HTMLElement | null} host - The container.
 * @param {{ keys?: any[], credits?: any, usage?: any, selected?: string, filter?: string, now?: number }} state - What to draw.
 * @returns {void}
 */
export function renderList(host, state = {}) {
  if (!host) return;
  const keys = Array.isArray(state.keys) ? state.keys : [];
  const nowMs = state.now || Date.now();
  const filter = String(state.filter || '').trim().toLowerCase();
  const usageByKey = new Map((state.usage?.keys || []).map((k) => [String(k.keyId), k]));

  const live = keys.filter((k) => !k.revokedAt);
  const balance = Number(state.credits?.balance ?? 0);
  const delivered7d = Number(state.usage?.totals?.delivered7d ?? 0);

  const account = ACCOUNT_ITEMS.map((item) =>
    rowHtml({
      id: item.id,
      title: t(item.key, item.english),
      sub: item.id === 'billing'
        ? plural('apiKeys.list.credits', balance, { one: '{count} credit', other: '{count} credits' })
        : plural('apiKeys.list.rendersWeek', delivered7d, {
          one: '{count} render this week',
          other: '{count} renders this week',
        }),
      selected: state.selected === item.id,
    })).join('');

  const matching = keys.filter((k) => {
    if (!filter) return true;
    return (String(k.name || '') + ' ' + String(k.prefix || '')).toLowerCase().includes(filter);
  });

  const keyRows = matching
    .map((k) => {
      const status = keyStatus(k, nowMs);
      const usage = usageByKey.get(String(k.id));
      const sub = status === 'revoked'
        ? statusLabel('revoked')
        : formatAgo(k.lastUsedAt, nowMs)
          + (usage && usage.delivered7d
            ? ' · ' + t('apiKeys.list.thisWeek', '{count} this week', { count: formatCount(usage.delivered7d) })
            : '');
      return rowHtml({
        id: String(k.id),
        title: String(k.name || t('apiKeys.key.fallbackName', 'API key')),
        sub,
        status,
        muted: status === 'revoked',
        selected: state.selected === String(k.id),
      });
    })
    .join('');

  const keysBody = keyRows
    || (filter
      ? '<p class="ak-list__none">'
        + escapeHtml(t('apiKeys.list.noMatch', 'No key matches “{query}”.', { query: state.filter }))
        + '</p>'
      : '<p class="ak-list__none">' + escapeHtml(t('apiKeys.list.none', 'No keys yet.')) + '</p>');

  host.innerHTML =
    '<p class="ak-list__group">' + escapeHtml(t('apiKeys.group.account', 'Account')) + '</p>'
    + account
    + '<p class="ak-list__group">'
    + escapeHtml(t('apiKeys.group.keys', 'Keys · {count} live', { count: formatCount(live.length) }))
    + '</p>'
    + keysBody;
}
