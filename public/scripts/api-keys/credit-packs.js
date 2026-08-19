// The credit-pack cards, shared by developers.html (read-only pricing) and
// api-keys.html (the same cards, with a buy button).
//
// FETCHED, NOT HARD-CODED. Both pages read GET /api/api-credits/packs, which is served
// straight from lib/data/credit-packs.js — the same table the Stripe webhook checks a
// payment against. Hard-coding the prices into two HTML files would give us three
// copies of the truth and no test that they agree; a customer reading one number on the
// docs page and being charged another is the exact failure that is worth a fetch.
//
// A pack with no configured Stripe price id is filtered out server-side, so an
// environment with billing half-configured shows fewer cards rather than cards that
// lead to a broken checkout.

import { escapeHtml } from '../escape-html.js';

/**
 * Format a price in whole currency units.
 * @param {number} cents - Amount in minor units.
 * @param {string} currency - ISO currency code.
 * @returns {string} e.g. "$15.00".
 */
export function formatPrice(cents, currency) {
  const amount = Number(cents) / 100;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: String(currency || 'usd').toUpperCase(),
    }).format(amount);
  } catch {
    // An unknown currency code must not blank the whole price.
    return amount.toFixed(2) + ' ' + String(currency || '').toUpperCase();
  }
}

/**
 * Per-image price, to three decimals — the number a developer actually compares.
 * @param {{ amountCents: number, credits: number, currency: string }} pack - The pack.
 * @returns {string} e.g. "$0.150 an image".
 */
export function formatUnitPrice(pack) {
  return formatUnitAmount(pack) + ' an image';
}

/**
 * Just the money, with no unit noun attached.
 *
 * Split out of formatUnitPrice because the docs page is served in eleven languages and
 * "an image" has to be a translatable node of its own — it cannot be concatenated into
 * a string the renderer then escapes. formatUnitPrice stays for callers that want the
 * whole English phrase in one piece.
 * @param {{ amountCents: number, credits: number }} pack - The pack.
 * @returns {string} e.g. "$0.150".
 */
export function formatUnitAmount(pack) {
  const per = Number(pack.amountCents) / Number(pack.credits) / 100;
  return '$' + per.toFixed(3);
}

/**
 * Render the cards into a container.
 * @param {HTMLElement | null} host - The grid element.
 * @param {any[]} packs - Packs from the API.
 * @param {{ buyable?: boolean, buyLabel?: string }} [opts] - Whether to render a buy
 *   button, and what it says. The LABEL comes from the caller rather than from a
 *   `data-lang` here: only the dashboard renders a buy button, so the string belongs in
 *   its namespace, and this file stays shared between two pages without either owning a
 *   key the other never shows.
 * @returns {void}
 */
export function renderPacks(host, packs, opts = {}) {
  if (!host) return;
  host.removeAttribute('data-loading');

  if (!packs || !packs.length) {
    // Says what is true — that nothing can be bought right now — rather than showing an
    // empty grid that reads as a broken page.
    host.innerHTML = '<p class="dev-packs__empty" data-lang-html="developers.packs.empty">'
      + 'Credit packs are not available right now. '
      + 'Please <a href="contact.html">get in touch</a> and we will sort you out.</p>';
    return;
  }

  host.innerHTML = packs
    .map((p) => {
      const id = escapeHtml(String(p.id));
      const buy = opts.buyable
        ? '<button type="button" class="dev-btn dev-btn--primary" data-buy-pack="' + id + '">'
          + escapeHtml(opts.buyLabel || 'Buy') + '</button>'
        : '';
      return (
        '<div class="dev-pack">'
        + '<div class="dev-pack__credits">' + escapeHtml(String(p.credits)) + '</div>'
        // data-lang so the docs page, which is server-rendered per language, can have
        // these two labels translated after the grid arrives — the packs are fetched, so
        // they land AFTER language-loader.js has already walked the document once.
        // developers-pricing.js re-applies; api-keys.html is English-only and ignores it.
        + '<div class="dev-pack__unit" data-lang="developers.packs.images">images</div>'
        + '<p class="dev-pack__price">' + escapeHtml(formatPrice(p.amountCents, p.currency)) + '</p>'
        + '<p class="dev-pack__each">' + escapeHtml(formatUnitAmount(p))
        + ' <span data-lang="developers.packs.each">an image</span></p>'
        + buy
        + '</div>'
      );
    })
    .join('');
}

/**
 * Fetch the pack table.
 *
 * Unauthenticated: pricing is public, and developers.html shows it to signed-out
 * visitors.
 * @param {typeof fetch} [fetchImpl] - Injectable for tests.
 * @returns {Promise<any[]>} The packs, or [] on any failure.
 */
export async function loadPacks(fetchImpl) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  try {
    const res = await doFetch('/api/api-credits/packs');
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body.packs) ? body.packs : [];
  } catch {
    return [];
  }
}
