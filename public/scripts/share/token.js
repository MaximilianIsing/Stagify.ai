// Reading the share token out of the URL.
//
// The token is the whole credential, and it lives in the PATH — which is why the page
// sets `Referrer-Policy: no-referrer` (see routes/share-public.js). It is never put in a
// query string, never logged, and never written into the DOM: an element carrying it is
// one "copy outer HTML" away from being pasted into a support ticket.

/** The one place the share URL grammar is written down. */
export const SHARE_PATH_PREFIX = '/s/';

/**
 * The token for the page currently open, or '' when the path is not a share URL.
 *
 * base64url only, and length-bounded: the server would refuse anything else anyway, but
 * a client-side check means a mistyped URL never becomes a request.
 *
 * @param {string} [pathname] - Injectable for tests.
 * @returns {string} The token, or '' when there is not one.
 */
export function parseShareToken(pathname = window.location.pathname) {
  if (!String(pathname).startsWith(SHARE_PATH_PREFIX)) return '';
  const raw = String(pathname).slice(SHARE_PATH_PREFIX.length).split('/')[0];
  return /^[A-Za-z0-9_-]{16,128}$/.test(raw) ? raw : '';
}

/**
 * The manifest URL for a token.
 * @param {string} token @returns {string}
 */
export function manifestUrl(token) {
  return `/api/share/${encodeURIComponent(token)}`;
}
