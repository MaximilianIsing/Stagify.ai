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

/** @param {{ offset?: number }} [arg] @param {typeof fetch} [fetchImpl] */
export function listGallery({ offset = 0 } = {}, fetchImpl = fetch) {
  return call(`/api/gallery?offset=${encodeURIComponent(String(offset))}`, { method: 'GET' }, fetchImpl);
}

/** @param {string} id @param {any} [settings] @param {typeof fetch} [fetchImpl] */
export function mintShare(id, settings, fetchImpl = fetch) {
  return call(`/api/gallery/${encodeURIComponent(id)}/share`, {
    method: 'POST', body: JSON.stringify({ settings: settings ?? {} }),
  }, fetchImpl);
}

/** @param {string} id @param {typeof fetch} [fetchImpl] */
export function revokeShare(id, fetchImpl = fetch) {
  return call(`/api/gallery/${encodeURIComponent(id)}/share`, { method: 'DELETE' }, fetchImpl);
}

/** @param {string} id @param {typeof fetch} [fetchImpl] */
export function deleteRender(id, fetchImpl = fetch) {
  return call(`/api/gallery/${encodeURIComponent(id)}`, { method: 'DELETE' }, fetchImpl);
}
