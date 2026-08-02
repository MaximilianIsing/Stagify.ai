// Fetching the share manifest.
//
// EVERY FAILURE COLLAPSES TO `{ ok: false }`. The server answers one identical 404 for
// unknown, revoked, expired, not-yours and not-yet-uploaded, specifically so the surface
// cannot be used to sort real tokens from invented ones. Distinguishing them here — a
// different message for a 404 than for a network error, say — would rebuild that oracle
// in the client and hand it to anyone who opens devtools.

/**
 * Fetch and shape the manifest.
 *
 * @param {string} url - From manifestUrl().
 * @param {typeof fetch} [fetchImpl] - Injectable for tests.
 * @returns {Promise<{ ok: true, manifest: any } | { ok: false }>}
 */
export async function fetchManifest(url, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      // The token is already in the path and there is no session here; sending
      // credentials would attach the OWNER's cookies if they happen to open their own
      // link, which is a different (and confusing) request than the one a buyer makes.
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false };
    const manifest = await res.json();
    if (!manifest || !Array.isArray(manifest.rooms)) return { ok: false };
    return { ok: true, manifest };
  } catch {
    return { ok: false };
  }
}
