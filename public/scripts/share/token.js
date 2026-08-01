// The share link's addressing rules, in one place.
//
// A share page is reached at `/s/<token>` — the token is a PATH SEGMENT, never a query
// string. That is deliberate on the server's side (a path is what the referrer policy and
// the CDN treat as the resource), and it matters here for one reason: `?token=` would be
// the obvious thing to reach for, and it would silently work in development while every
// real link 404'd. So the parse is pinned to the path and nothing else reads it.
//
// Everything that lands in a URL is re-encoded on the way out. The ids are server-issued,
// but they arrive over the wire and get concatenated into a request path; encoding them is
// what makes "the id contained a slash" a 404 instead of a request to a different route.

/** The path prefix a share link is served under. */
export const SHARE_PREFIX = '/s/';

/** The API root every share request hangs off. */
export const API_ROOT = '/api/share';

/**
 * Pull the share token out of a location pathname.
 *
 * Matches `/s/<token>` with an optional trailing slash and nothing after it. A deeper
 * path, a bare `/s/`, or anything else answers `null` — the caller renders the
 * unavailable state rather than firing a request that cannot succeed.
 *
 * The captured segment is percent-DEcoded, because the browser hands back what is in the
 * address bar; a malformed escape keeps the raw text rather than throwing.
 *
 * @param {string} pathname - Typically `location.pathname`.
 * @returns {string|null} The decoded token, or `null` when the path is not a share link.
 */
export function parseShareToken(pathname) {
  const raw = typeof pathname === 'string' ? pathname : '';
  const match = raw.match(/^\/s\/([^/?#]+)\/?$/);
  if (!match) return null;
  let token = match[1];
  try {
    token = decodeURIComponent(token);
  } catch {
    // A malformed escape sequence is not a reason to lose the token — the server is the
    // authority on whether it is valid, and it will answer 404 if it is not.
  }
  return token ? token : null;
}

/**
 * URL of the listing manifest for a token.
 * @param {string} token
 * @returns {string}
 */
export function manifestUrl(token) {
  return `${API_ROOT}/${encodeURIComponent(token)}`;
}

/**
 * URL of this link's feedback collection — GET reads back what the link has already said,
 * POST records one more answer. A collection URL, not a per-answer one: the token is the
 * whole identity here, and there is nothing else to key on.
 * @param {string} token
 * @returns {string}
 */
export function feedbackUrl(token) {
  return `${API_ROOT}/${encodeURIComponent(token)}/feedback`;
}

/**
 * URL of a staged render's bytes.
 * @param {string} token
 * @param {string} renderId
 * @returns {string}
 */
export function renderUrl(token, renderId) {
  return `${API_ROOT}/${encodeURIComponent(token)}/render/${encodeURIComponent(renderId)}`;
}

/**
 * URL of an original (pre-staging) photo's bytes. Only ever built when the listing opted
 * into the before/after view AND the frame actually carries a photo id.
 * @param {string} token
 * @param {string} photoId
 * @returns {string}
 */
export function photoUrl(token, photoId) {
  return `${API_ROOT}/${encodeURIComponent(token)}/photo/${encodeURIComponent(photoId)}`;
}
