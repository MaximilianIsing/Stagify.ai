// The one network call this page makes.
//
// EVERY FAILURE IS THE SAME FAILURE. The server answers 404 for a revoked link, an expired
// link, a typo'd token and a link that never existed — deliberately, so a stranger holding
// a guessed token learns nothing from the response. This module preserves that: it returns
// `{ ok: false }` for a non-200, for an unparseable body, and for a dead network alike,
// and it carries no status or message forward. There is nothing truthful the page could
// say about WHY, and inventing a reason ("this link expired") would be a lie to the
// seller. So the caller gets one bit and renders one calm state.
//
// It also never throws. A rejected promise here would surface as a blank page with a
// console error nobody on a phone will ever see.

import { manifestUrl } from './token.js';
import { normalizeListing } from './model.js';

/**
 * @typedef {import('./model.js').ShareListing} ShareListing
 */

/**
 * Fetch and narrow the listing manifest.
 *
 * @param {string} token - The token from the path.
 * @param {typeof fetch} [fetchImpl] - Injected for tests; defaults to the global.
 * @returns {Promise<{ ok: true, listing: ShareListing } | { ok: false }>}
 */
export async function fetchListing(token, fetchImpl) {
  const call = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!token || !call) return { ok: false };

  let response;
  try {
    response = await call(manifestUrl(token), {
      headers: { Accept: 'application/json' },
      // No cookies, no bearer token: this endpoint is anonymous by design, and sending
      // credentials to it would be the only thing on the page that could leak a session
      // into a link the broker forwards to strangers.
      credentials: 'omit',
    });
  } catch {
    return { ok: false };
  }

  if (!response || !response.ok) return { ok: false };

  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false };
  }

  const listing = body && typeof body === 'object' ? body.listing : null;
  if (!listing || typeof listing !== 'object') return { ok: false };
  return { ok: true, listing: normalizeListing(listing) };
}
