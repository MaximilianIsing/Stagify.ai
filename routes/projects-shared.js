// Pure helpers shared by the three Listing-Studio route modules — routes/projects.js
// (the front door: listings, photos, image bytes), routes/projects-queue.js (the staging
// queue) and routes/projects-download.js (the render archive).
//
// WHY A SHARED MODULE RATHER THAN AN IMPORT BETWEEN THE ROUTE FILES
// routes/projects.js imports both sibling registrars, so if a sibling imported a clamp
// back out of it the three files would form an import cycle. Everything here is pure —
// no store, no response, no I/O — so it can sit beneath all three and be tested directly.
//
// Every function here is a CLAMP or a FILTER, i.e. the layer that decides what a
// caller-supplied string is allowed to become. `slugify` in particular is what stands
// between an operator-typed listing title and a `Content-Disposition` header, and
// `groupByRoom` is what decides which photos get billed for a render.

import { OTHER_ROOM_TYPE } from '../lib/staging/room-clustering.js';

/** @typedef {import('../lib/types/projects.js').Project} Project */
/** @typedef {import('../lib/types/projects.js').ProjectPhoto} ProjectPhoto */

/**
 * Why a photo is being left out of the staging run. Stable codes — the studio localizes
 * them and the API reports them, so they must not be prose.
 */
export const SKIP_REASONS = Object.freeze({
  NO_ROOM: 'NO_ROOM',
  EXCLUDED: 'EXCLUDED',
  UNSTAGEABLE: 'UNSTAGEABLE',
  NOT_A_ROOM: 'NOT_A_ROOM',
});

/**
 * Why this frame will not be staged, or null when it will be.
 *
 * The four reasons, and why each is a reason:
 *   * NO_ROOM — no room assignment yet. There is nothing to be consistent WITH.
 *   * EXCLUDED — the operator marked the frame 'excluded' (kept in the shoot, never staged).
 *   * UNSTAGEABLE — the upload gate rejected it (`stageable === false`). The tray already
 *     says "Cannot be staged: <code>", so staging it anyway would bill for a render of a
 *     photo we have already refused.
 *   * NOT_A_ROOM — the frame is not an interior at all. `roomType === 'Other'` is what the
 *     clusterer returns for an exterior facade, a garage, a stairwell (see the prompt in
 *     room-clustering.js), and EVERY real listing shoot contains several. Staging them was
 *     the single worst thing this feature did on a first real upload: it spent money putting
 *     furniture on a driveway, then failed the whole room's bible extraction because there
 *     was no furniture to pin — so the broker paid for a render they would never use AND
 *     watched that room stall. `promptMatrix` has no 'Other' entry either, so those renders
 *     were being built from the generic fallback prompt.
 *
 * NOT_A_ROOM IS A DEFAULT, NOT A VERDICT. The override is the room-type control the tray
 * already shows on every thumbnail: give the frame a real room type and it stages. That is
 * deliberately the ONLY override — keying it off `frameRole: 'hero'` as well would make the
 * rule "an exterior stages unless… unless…", and an operator who wants a sunroom staged is
 * one dropdown away from saying so.
 *
 * `stageable` is TRI-state: null means "not checked yet" (the vision pre-check has not come
 * back), which is NOT a rejection — those frames are kept, matching the fail-open posture of
 * the upload route.
 * @param {ProjectPhoto} photo - The frame.
 * @returns {string|null} A `SKIP_REASONS` code, or null when the frame will be staged.
 */
export function skipReasonFor(photo) {
  if (!photo) return SKIP_REASONS.NO_ROOM;
  if (!photo.roomKey) return SKIP_REASONS.NO_ROOM;
  if (photo.frameRole === 'excluded') return SKIP_REASONS.EXCLUDED;
  if (photo.stageable === false) return SKIP_REASONS.UNSTAGEABLE;
  if (String(photo.roomType || '') === OTHER_ROOM_TYPE) return SKIP_REASONS.NOT_A_ROOM;
  return null;
}

/** Extension → Content-Type for the two byte routes. Unknown extensions are NOT guessed. */
export const SERVE_CONTENT_TYPES = /** @type {Record<string, string>} */ ({
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
});

/**
 * The lowercase extension a storage key was written with, sanitized to the characters a
 * key may legally contain (see STORAGE_KEY_PATTERN in lib/data/project-storage.js).
 * Sanitizing rather than trusting matters because this string is reused as a *filename*
 * extension inside the zip archive.
 * @param {string|null|undefined} storageKey - The stored blob key.
 * @returns {string} e.g. 'webp'; '' when there is no usable extension.
 */
export function extensionOf(storageKey) {
  const raw = String(storageKey ?? '').split('.').pop()?.toLowerCase() || '';
  const clean = raw.replace(/[^a-z0-9]/g, '').slice(0, 5);
  return clean;
}

/**
 * Content type for a stored blob, derived from its key's extension.
 *
 * Never assume a format. A render is usually WebP but `upscaleForDelivery` fails open to
 * PNG, and a source photo is whatever the operator uploaded (PNG/JPG/WebP) — so both byte
 * routes read the extension the key was written with. An unknown extension serves
 * `application/octet-stream` rather than a guess, which (with `nosniff`) makes a
 * mislabelled blob a download rather than something the browser interprets.
 * @param {string|null|undefined} storageKey - The stored blob key.
 * @returns {string} The Content-Type header value.
 */
export function serveContentType(storageKey) {
  return SERVE_CONTENT_TYPES[extensionOf(storageKey)] || 'application/octet-stream';
}

/**
 * Trim and hard-clamp a caller-supplied string.
 * @param {unknown} value - Raw body field.
 * @param {number} max - Maximum characters kept.
 * @returns {string} The clamped string ('' when the field was not a string).
 */
export function clampText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Parse and clamp a caller-supplied integer.
 * @param {unknown} value - Raw query/body field.
 * @param {number} min - Lower bound (inclusive).
 * @param {number} max - Upper bound (inclusive).
 * @param {number} fallback - Used when the value is absent or unparseable.
 * @returns {number} An integer within [min, max].
 */
export function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * @param {unknown} value - Raw truthy-ish body field.
 * @returns {boolean} Normalized boolean.
 */
export function asBool(value) {
  return value === true || value === 'true' || value === 'on' || value === 1 || value === '1';
}

/**
 * Reduce any string to a safe path/header fragment: lowercase, ASCII, `[a-z0-9-]` only.
 *
 * This is a SECURITY clamp, not cosmetics. Its output is interpolated into a
 * `Content-Disposition` filename and into zip entry names, so a quote, a newline, a `/`
 * or a `..` surviving here would be header injection or a path escape in whatever
 * unpacks the archive. The allowlist is positive (drop everything not matched), so a
 * character class nobody thought of is dropped rather than passed.
 * @param {unknown} value - Any caller- or model-supplied label (a listing title, a room type).
 * @param {number} max - Maximum characters kept.
 * @returns {string} The slug, or '' when nothing survived.
 */
export function slugify(value, max) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    // Drop the combining marks NFKD just split off, BEFORE the allowlist runs. Without this
    // they are non-alphanumeric and become separators, so an accent in the MIDDLE of a word
    // shatters it: 'Rôôm' → 'ro-o-m', 'Málaga' → 'ma-laga'. Real-estate addresses carry
    // accents constantly, and the result is a zip full of files named after fragments.
    // Stripping them instead folds the letter to its base — 'room', 'malaga'.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, Math.max(1, max))
    .replace(/-+$/g, '');
}

/**
 * Merge a patch into a project's `extra` bag and serialize it for `updateProject`, which
 * takes the column's raw JSON string. `getProject` has already parsed the existing value
 * (null when it was unparseable), so a corrupt bag is replaced rather than propagated.
 * @param {Project|null} project - Project row.
 * @param {Record<string, unknown>} patch - Keys to set.
 * @returns {string} The serialized `extra_json`.
 */
export function mergeExtraJson(project, patch) {
  return JSON.stringify({ ...(project?.extra || {}), ...patch });
}

/**
 * @param {Project|null} project - Project row.
 * @returns {number} Stored variationCount, clamped 1–3.
 */
export function storedVariationCount(project) {
  const settings = project?.extra?.jobSettings;
  const raw = settings && typeof settings === 'object' ? /** @type {Record<string, unknown>} */ (settings).variationCount : null;
  return clampInt(raw, 1, 3, 1);
}

/**
 * Group photos by room, dropping every frame `skipReasonFor` refuses.
 *
 * ONE PREDICATE, ONE CHOKEPOINT. This function is what both the upload route (choosing each
 * room's hero) and the stage route (building the enqueue plan) group through, so the rule
 * about what gets staged lives in exactly one place and the two cannot disagree. They did
 * once — a photo the upload gate had rejected was ineligible to LEAD a room but still got
 * enqueued as a support frame — and that is why `skipReasonFor` is shared rather than
 * inlined here.
 * @param {ProjectPhoto[]} photos - Photos of one project.
 * @returns {Map<string, ProjectPhoto[]>} roomKey → its stageable photos, in input order.
 */
export function groupByRoom(photos) {
  /** @type {Map<string, ProjectPhoto[]>} */
  const rooms = new Map();
  for (const photo of photos) {
    // `skipReasonFor` returning null already implies a room key (NO_ROOM is its first
    // branch), but the narrowing does not survive the function boundary — so re-read it
    // into a local rather than asserting, and let a falsy key skip on its own.
    if (skipReasonFor(photo)) continue;
    const roomKey = photo.roomKey;
    if (!roomKey) continue;
    const list = rooms.get(roomKey);
    if (list) list.push(photo);
    else rooms.set(roomKey, [photo]);
  }
  return rooms;
}
