// Every network call the Listing Studio (projects.html) makes, and the only file
// that knows the /api/projects endpoint shapes. The islands and the entry talk to
// the backend exclusively through here, so a route rename is a one-file change.
//
// Two things in here are load-bearing and easy to get wrong elsewhere:
//
//  1. EVERY request carries `Authorization: Bearer <token>` — the whole surface is
//     Stagify+ only, so an unauthenticated call is a 401, not a degraded page.
//  2. RENDER IMAGES ARE NOT DATA URLS, and an <img src> cannot carry a header. So
//     the bytes are fetched here with the bearer header and wrapped in a `blob:`
//     URL (CSP allows blob: under img-src). Object URLs are *not* garbage-collected
//     with the element — the caller must revoke them, which is what
//     `makeBlobRegistry` in ./render-grid.js exists for. Do not call
//     URL.createObjectURL anywhere else in this feature.
//
// Nothing here is named `create*` on purpose: `test/frontend/island-deps-typed.test.js`
// pins the exported `create*`-factory population by name, and these are plain request
// helpers rather than injected islands. Factories in this feature use `make*`/`mount*`.

/**
 * @typedef {import('./state.js').PjProject} PjProject
 * @typedef {import('./state.js').PjPhoto} PjPhoto
 * @typedef {import('./state.js').PjProgress} PjProgress
 * @typedef {import('./state.js').PjRender} PjRender
 * @typedef {import('./state.js').PjProjectDetail} PjProjectDetail
 */

// The share shapes come from the SERVER's own type file rather than a local copy. They
// are produced by lib/data/project-shares.js and consumed here unchanged, so a
// hand-written duplicate here could only ever drift out of agreement with the producer.
/**
 * @typedef {import('../../../lib/types/projects.js').ProjectShare} ProjectShare
 * @typedef {import('../../../lib/types/projects.js').ShareSettings} ShareSettings
 * @typedef {import('../../../lib/types/projects.js').ShareFeedback} ShareFeedback
 */

/** Root of the listing API. Every path below is built from this. */
export const BASE = '/api/projects';

/** localStorage key that auth.js writes the session token to. */
export const TOKEN_KEY = 'stagifyAuthToken';

/** A failed API call, carrying the HTTP status so callers can branch on 401/404. */
export class ApiError extends Error {
  /**
   * @param {string} message - Already user-presentable (see apiErrorMessage).
   * @param {number} status - HTTP status, or 0 when the request never completed.
   * @param {string} [code] - Machine-readable code from the response body, if any.
   */
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * The session token, preferring auth.js's accessor over reading storage directly
 * (it is the one place that knows the key, and it may start hashing/rotating).
 * @returns {string|null}
 */
export function authToken() {
  const auth = typeof window === 'undefined' ? null : window.StagifyAuth;
  if (auth && typeof auth.getToken === 'function') {
    try {
      return auth.getToken() || null;
    } catch (e) { /* storage blocked — fall through */ }
  }
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch (e) {
    return null;
  }
}

/**
 * Headers for a listing-API request. Deliberately does NOT set Content-Type:
 * requestJson adds it for JSON bodies, and a multipart upload must let the browser
 * set it (with the boundary) or the server cannot parse the form.
 * @returns {Record<string, string>}
 */
export function authHeaders() {
  /** @type {Record<string, string>} */
  const headers = { Accept: 'application/json' };
  const token = authToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** @param {string} value @returns {string} */
const seg = (value) => encodeURIComponent(String(value));

/** @param {string} projectId @returns {string} */
export function projectPath(projectId) {
  return `${BASE}/${seg(projectId)}`;
}

/** @param {string} projectId @param {string} photoId @returns {string} */
export function photoPath(projectId, photoId) {
  return `${projectPath(projectId)}/photos/${seg(photoId)}`;
}

/**
 * The render-image route. Built as a path (not fetched) so the grid can key its
 * blob cache on it and so this is unit-testable without a network.
 * @param {string} projectId
 * @param {string} renderId
 * @returns {string}
 */
export function renderImagePath(projectId, renderId) {
  return `${projectPath(projectId)}/renders/${seg(renderId)}/image`;
}

/**
 * The source-photo companion of renderImagePath — the tray thumbnails and the
 * before/after "before" pane.
 *
 * Same contract as the render serve: Stagify+ only, ownership keyed on the validated
 * session, 404 (not 403) for a foreign or unknown photo, content type derived from the
 * stored key, `Cache-Control: private, …, immutable` and `nosniff`.
 *
 * Both callers still degrade explicitly when the bytes do not arrive — a 404 for a
 * photo whose blob is gone, or a transport failure — showing "No preview available" /
 * "Image unavailable" rather than a broken image. That matters most on the before pane:
 * a blank box there would be a lie about what the operator is comparing against.
 * @param {string} projectId
 * @param {string} photoId
 * @returns {string}
 */
export function photoImagePath(projectId, photoId) {
  return `${photoPath(projectId, photoId)}/image`;
}

/**
 * The bulk-download route: every current render of a listing as one zip.
 *
 * Exported as a path so the caller can fetch it with the bearer header like everything else
 * here. It CANNOT be an `<a href>`: the whole surface is Stagify+ only, a plain navigation
 * carries no Authorization header, and the result is a 401 in a new tab. That is exactly
 * why the studio previously had no download at all — the images only ever existed as
 * authenticated `blob:` URLs.
 * @param {string} projectId
 * @returns {string}
 */
export function rendersZipPath(projectId) {
  return `${projectPath(projectId)}/renders.zip`;
}

/**
 * A user-presentable message for a failed request.
 *
 * The server's own `error` string wins when it sent one; otherwise a status-specific
 * sentence. Never interpolates a raw exception — the backend deliberately returns
 * `{ ref }` rather than internals on 5xx.
 * @param {number} status - HTTP status (0 for a transport failure).
 * @param {Record<string, unknown>|null} [payload] - Parsed response body, if any.
 * @returns {string}
 */
export function apiErrorMessage(status, payload) {
  const raw = payload ? payload.error : null;
  const fromBody = typeof raw === 'string' ? raw.trim() : '';
  if (fromBody) return fromBody;
  if (status === 0) return 'Could not reach the server. Check your connection and try again.';
  if (status === 401) return 'Your session expired. Sign in again to continue.';
  if (status === 403) return 'Listing Studio is a Stagify+ feature.';
  if (status === 404) return 'That listing no longer exists.';
  if (status === 409) return 'That listing changed while you were working. Reload it.';
  if (status === 413) return 'Those photos are too large to upload together. Try a smaller batch.';
  if (status === 429) return 'Too many requests. Give it a minute and try again.';
  if (status >= 500) return 'The server had a problem with that. Please try again.';
  return `That request failed (${status}).`;
}

/**
 * Turn a non-ok Response into an ApiError, reading the body once.
 * @param {Response} res
 * @returns {Promise<ApiError>}
 */
async function errorFor(res) {
  /** @type {Record<string, unknown>|null} */
  let payload = null;
  try {
    payload = await res.json();
  } catch (e) { /* empty or non-JSON body — status alone carries the meaning */ }
  const code = payload && typeof payload.code === 'string' ? payload.code : undefined;
  return new ApiError(apiErrorMessage(res.status, payload), res.status, code);
}

/**
 * One JSON request against the listing API.
 * @param {string} path
 * @param {{ method?: string, body?: unknown, signal?: AbortSignal }} [opts]
 * @returns {Promise<any>}
 */
async function requestJson(path, opts = {}) {
  /** @type {RequestInit & { headers: Record<string, string> }} */
  const init = { method: opts.method || 'GET', headers: authHeaders() };
  if (opts.signal) init.signal = opts.signal;
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  /** @type {Response} */
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    // A transport failure has no status; give it 0 so callers can tell it apart
    // from a server rejection rather than showing "failed (undefined)".
    throw new ApiError(apiErrorMessage(0, null), 0);
  }
  if (!res.ok) throw await errorFor(res);
  try {
    return await res.json();
  } catch (e) {
    return {};
  }
}

// ── Projects ─────────────────────────────────────────────────────────────────

/**
 * @param {{ title: string, address: string }} fields
 * @returns {Promise<{ project: PjProject }>}
 */
export function newProject(fields) {
  return requestJson(BASE, { method: 'POST', body: fields });
}

/**
 * @param {number} [limit]
 * @returns {Promise<{ projects: PjProject[] }>}
 */
export function fetchProjects(limit = 50) {
  return requestJson(`${BASE}?limit=${encodeURIComponent(String(limit))}`);
}

/**
 * The full listing: project, photos, renders, bibles and the progress counters.
 * @param {string} projectId
 * @returns {Promise<PjProjectDetail>}
 */
export function fetchProject(projectId) {
  return requestJson(projectPath(projectId));
}

/**
 * @param {string} projectId
 * @param {{ title?: string, address?: string, status?: string }} fields
 * @returns {Promise<{ project: PjProject }>}
 */
export function patchProject(projectId, fields) {
  return requestJson(projectPath(projectId), { method: 'PATCH', body: fields });
}

/**
 * @param {string} projectId
 * @returns {Promise<{ ok: boolean, deleted?: unknown }>}
 */
export function removeProject(projectId) {
  return requestJson(projectPath(projectId), { method: 'DELETE' });
}

// ── Photos ───────────────────────────────────────────────────────────────────

/**
 * Upload a batch of photos as multipart/form-data under the field name "photos".
 *
 * Uses XMLHttpRequest rather than fetch for one reason: `fetch` exposes no upload
 * progress, and a 40-photo batch is tens of megabytes — a UI with no progress reads
 * as a hang. The server takes the batch in ONE request, so the fraction reported is
 * batch-level; per-file rows resolve when the response names which photos landed.
 *
 * @param {string} projectId
 * @param {File[]} files - At most 40; validate with validateFiles() first.
 * @param {(fraction: number) => void} [onProgress] - 0..1, batch-level.
 * @returns {Promise<{ photos: PjPhoto[], duplicates?: unknown[] }>}
 */
export function postPhotos(projectId, files, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const file of files) form.append('photos', file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${projectPath(projectId)}/photos`);
    // Content-Type is intentionally absent from authHeaders() — the browser must
    // set it, with the multipart boundary, or the server cannot parse the form.
    for (const [name, value] of Object.entries(authHeaders())) xhr.setRequestHeader(name, value);

    if (onProgress && xhr.upload) {
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
      });
    }
    xhr.addEventListener('load', () => {
      /** @type {Record<string, unknown>|null} */
      let payload = null;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch (e) { /* handled below */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        const photos = payload && Array.isArray(payload.photos) ? payload.photos : [];
        const duplicates = payload && Array.isArray(payload.duplicates) ? payload.duplicates : [];
        resolve({ photos, duplicates });
        return;
      }
      const code = payload && typeof payload.code === 'string' ? payload.code : undefined;
      reject(new ApiError(apiErrorMessage(xhr.status, payload), xhr.status, code));
    });
    xhr.addEventListener('error', () => reject(new ApiError(apiErrorMessage(0, null), 0)));
    xhr.addEventListener('abort', () => reject(new ApiError('Upload cancelled.', 0)));
    xhr.send(form);
  });
}

/**
 * Override a photo's clustering. The auto-assignment is a first draft; this is how
 * the operator corrects it (room, room type, hero/support role, order).
 * @param {string} projectId
 * @param {string} photoId
 * @param {{ roomKey?: string, roomType?: string, frameRole?: string, seq?: number }} fields
 * @returns {Promise<{ photo: PjPhoto }>}
 */
export function patchPhoto(projectId, photoId, fields) {
  return requestJson(photoPath(projectId, photoId), { method: 'PATCH', body: fields });
}

/**
 * @param {string} projectId
 * @param {string} photoId
 * @returns {Promise<{ ok: boolean }>}
 */
export function removePhoto(projectId, photoId) {
  return requestJson(photoPath(projectId, photoId), { method: 'DELETE' });
}

// ── Staging, progress, bibles ────────────────────────────────────────────────

/**
 * @param {string} projectId
 * @param {{ furnitureStyle: string, removeFurniture: boolean, variationCount: number,
 *   additionalPrompt?: string }} options - `additionalPrompt` is clamped to 500 by the
 *   route and persisted with the listing; the studio had no input for it at all.
 * @returns {Promise<{ ok: boolean, queued?: number }>}
 */
export function startStaging(projectId, options) {
  return requestJson(`${projectPath(projectId)}/stage`, { method: 'POST', body: options });
}

/**
 * Stop a run: every `queued` row for this listing moves to a terminal state. Renders
 * already `ok` are untouched — cancelling must never cost work already paid for.
 * @param {string} projectId
 * @returns {Promise<{ ok: boolean, cancelled?: number }>}
 */
export function cancelStaging(projectId) {
  return requestJson(`${projectPath(projectId)}/cancel`, { method: 'POST' });
}

/**
 * Requeue ONE failed render, keeping the bible it was conditioned on so the retry produces
 * a frame that still matches its room.
 * @param {string} projectId
 * @param {string} renderId
 * @returns {Promise<{ ok: boolean, render?: PjRender }>}
 */
export function retryRender(projectId, renderId) {
  return requestJson(`${projectPath(projectId)}/renders/${seg(renderId)}/retry`, {
    method: 'POST',
  });
}

/**
 * @param {string} projectId
 * @returns {Promise<{ progress: PjProgress, status: string }>}
 */
export function fetchProgress(projectId) {
  return requestJson(`${projectPath(projectId)}/progress`);
}

/**
 * Re-derive a room's look. Supersedes that room's existing renders — the caller
 * must have warned the operator before getting here.
 * @param {string} projectId
 * @param {string} roomKey
 * @returns {Promise<{ ok: boolean, superseded?: number, queued?: number }>}
 */
export function regenerateBible(projectId, roomKey) {
  return requestJson(`${projectPath(projectId)}/rooms/${seg(roomKey)}/bible/regenerate`, {
    method: 'POST',
  });
}

// ── Client share links ───────────────────────────────────────────────────────
//
// FOUR CALLS, ONE PATH. The share for a listing is a singleton from the client's point of
// view — there is at most one live link — so all four verbs address `…/share` and the
// server decides what "replace" means.
//
// THE TOKEN IS HASHED AT REST, exactly like a password (lib/data/project-shares.js stores
// only its digest). `newShare` is therefore the ONLY call that can ever answer with the
// URL, and it answers with it once. `fetchShare` can report that a live link exists — when
// it was made, how often it has been opened — but it cannot report *what it is*. Callers
// must hold the minted URL in memory and say so plainly when they no longer have it; do
// not cache it in storage, and do not try to rebuild it from the share id. Rotating (a
// second POST) is the supported way to get an address back.

/** @param {string} projectId @returns {string} */
export function sharePath(projectId) {
  return `${projectPath(projectId)}/share`;
}

/**
 * The live share for a listing, plus the revoked/expired ones behind it.
 *
 * `share` is null when the listing has never been shared or its only link is dead. Nothing
 * in this response carries the token — see the section header.
 * @param {string} projectId
 * @returns {Promise<{ share: ProjectShare|null, history: ProjectShare[] }>}
 */
export function fetchShare(projectId) {
  return requestJson(sharePath(projectId));
}

/**
 * Mint a client link, replacing any live one.
 *
 * `url` is the plaintext address and this is the only response that ever carries it.
 * `replaced` is true when an existing link was rotated out from under someone who may
 * already be holding it — the caller is expected to say so.
 * @param {string} projectId
 * @param {{ settings?: Partial<ShareSettings>, expiresInDays?: number|null }} [body]
 * @returns {Promise<{ share: ProjectShare, token: string, url: string, replaced: boolean }>}
 */
export function newShare(projectId, body) {
  return requestJson(sharePath(projectId), { method: 'POST', body: body || {} });
}

/**
 * Reconfigure the live link in place — what the page shows, and when it stops working.
 *
 * The whole settings bag goes every time rather than a diff: the server normalizes it
 * through an allowlist, so a partial send is how a field silently reverts to its default.
 * @param {string} projectId
 * @param {{ settings: ShareSettings, expiresInDays?: number|null }} body
 * @returns {Promise<{ share: ProjectShare }>}
 */
export function patchShare(projectId, body) {
  return requestJson(sharePath(projectId), { method: 'PATCH', body });
}

/**
 * Kill every live link for the listing. `revoked` is how many rows this turned off.
 * @param {string} projectId
 * @returns {Promise<{ ok: boolean, revoked?: number }>}
 */
export function revokeShare(projectId) {
  return requestJson(sharePath(projectId), { method: 'DELETE' });
}

/**
 * What the client sent back through the share link: one row per verdict they submitted,
 * NEWEST FIRST.
 *
 * The log is APPEND-ONLY — a seller who changes their mind about a room adds a row rather
 * than editing one — so the caller reduces it to the current state per room
 * (`latestPerRoom` in ./share-feedback.js) instead of rendering the history.
 *
 * Note it hangs off the LISTING, not off `sharePath`: responses outlive the link that
 * collected them, so revoking or rotating a share must not take the seller's sign-off with
 * it. `roomKey` is null on a response about the whole listing, and `userId` is the
 * listing's OWNER — the viewer is never identified beyond the name they chose to type.
 * @param {string} projectId
 * @returns {Promise<{ feedback: ShareFeedback[] }>}
 */
export function fetchShareFeedback(projectId) {
  return requestJson(`${projectPath(projectId)}/feedback`);
}

// ── Image bytes ──────────────────────────────────────────────────────────────

/**
 * Fetch image bytes with the bearer header and wrap them in an object URL.
 *
 * THE CALLER OWNS REVOCATION. An un-revoked object URL pins its blob for the life
 * of the document, so a long session over a 90-render listing leaks tens of
 * megabytes. Hand the result to a makeBlobRegistry (./render-grid.js) rather than
 * assigning it to an <img> and forgetting it.
 * @param {string} path - From renderImagePath() or photoImagePath().
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>} A `blob:` URL.
 */
export async function fetchImageBlobUrl(path, signal) {
  return fetchBlobUrl(path, signal);
}

/**
 * The same fetch-with-bearer-then-wrap for a non-image body — today, the renders zip.
 *
 * Separated only by name: an authenticated download of ANY type has to come through a
 * fetch, because a header cannot ride on a navigation or an `<a href>`. Ownership is
 * unchanged and still the caller's; a one-shot download should revoke as soon as the click
 * has been dispatched (see ./download.js) rather than handing it to a registry.
 * @param {string} path
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>} A `blob:` URL.
 */
export async function fetchBlobUrl(path, signal) {
  /** @type {Response} */
  let res;
  try {
    res = await fetch(path, signal ? { headers: authHeaders(), signal } : { headers: authHeaders() });
  } catch (e) {
    throw new ApiError(apiErrorMessage(0, null), 0);
  }
  if (!res.ok) throw await errorFor(res);
  return URL.createObjectURL(await res.blob());
}
