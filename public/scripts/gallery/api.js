// The gallery's HTTP calls.
//
// One place that knows the endpoint shapes, so the view never builds a URL. Every call
// is authenticated by the session the browser already holds — `credentials: 'include'`,
// unlike the share page, which deliberately sends none.

/** Read the bearer token the app stores after sign-in. */
function authHeaders() {
  try {
    const token = window.localStorage.getItem('stagifyAuthToken');
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    // A browser with storage blocked is signed out, not broken.
    return {};
  }
}

/**
 * @param {string} url @param {RequestInit} [init] @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: boolean, status: number, body: any }>}
 */
async function call(url, init = {}, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url, {
      ...init,
      credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...authHeaders(), ...(init.headers ?? {}) },
    });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  } catch {
    // A network failure is reported as a status the caller can branch on rather than a
    // throw that would have to be caught at every call site.
    return { ok: false, status: 0, body: null };
  }
}

/**
 * One page of the gallery, optionally narrowed by a search.
 *
 * `q` is sent only when there is something to search for, so an ordinary load stays the
 * same URL it always was — which is what keeps the fixture routing in the specs, and any
 * cache in front of this, matching on the plain path.
 *
 * @param {{ offset?: number, q?: string }} [arg] @param {typeof fetch} [fetchImpl]
 */
export function listGallery({ offset = 0, q = '' } = {}, fetchImpl = fetch) {
  const query = `offset=${encodeURIComponent(String(offset))}`
    + (q ? `&q=${encodeURIComponent(q)}` : '');
  return call(`/api/gallery?${query}`, { method: 'GET' }, fetchImpl);
}

// There is no mint and no revoke here because there are no such routes: a link arrives
// with the listing, for every entry, and deleting the render is what takes one down.

/**
 * Name a render, or clear the name it has.
 *
 * An empty string is the reset, not a validation failure — the server stores NULL and the
 * page goes back to deriving `<Style> <Room type>`. The ceiling and the trimming are the
 * store's job, so this sends what was typed and reads back what was kept.
 *
 * @param {string} id @param {string} name @param {typeof fetch} [fetchImpl]
 */
export function renameRender(id, name, fetchImpl = fetch) {
  return call(`/api/gallery/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify({ name }),
  }, fetchImpl);
}

/**
 * Change what a live link publishes, without rotating it.
 *
 * `settings` is the WHOLE bag, never a delta: the store rebuilds it from what arrives, so
 * sending `{ showBefore }` alone would blank the headline, note and contact details that
 * came back with the entry. Callers merge onto `entry.share.settings` and send the result.
 *
 * @param {string} id @param {Record<string, any>} settings @param {typeof fetch} [fetchImpl]
 */
export function updateShareSettings(id, settings, fetchImpl = fetch) {
  return call(`/api/gallery/${encodeURIComponent(id)}/share`, {
    method: 'PATCH', body: JSON.stringify({ settings }),
  }, fetchImpl);
}

/** @param {string} id @param {typeof fetch} [fetchImpl] */
export function deleteRender(id, fetchImpl = fetch) {
  return call(`/api/gallery/${encodeURIComponent(id)}`, { method: 'DELETE' }, fetchImpl);
}
