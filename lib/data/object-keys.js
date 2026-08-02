// Object keys for the gallery's bytes — the naming, and the gate that keeps a key
// from becoming a path traversal. Pure: no filesystem, no network, no database.
//
// THE LAYOUT
//   renders/<renderId>/after.webp    the staged result, at the model's native size
//   renders/<renderId>/before.webp   the source photo (owner's gallery only)
//   renders/<renderId>/thumb.webp    480px, for the gallery grid
//   refs/<refHash>.webp              a furniture reference photo, content-addressed
//
// WHY NO USER ID APPEARS IN ANY KEY
// Three independent reasons, and the parked Listing Studio's `projects/<projectId>/…`
// layout would have violated all three:
//   1. A presigned URL for a share is handed to a buyer. The URL must not tell them
//      whose account produced the image.
//   2. `blob_tombstones` (lib/data/blob-tombstones.js) holds keys AFTER the rows that
//      named them are gone. If the key carried a user id, that queue would itself be a
//      record of erased people — and erasure would have to erase its own work queue.
//   3. The reference hash is SALTED with the user id, which buys per-user dedupe and
//      keeps the id out of the key in the same operation.
//
// WHY THE VALIDATION IS DOUBLED (and where the second gate lives)
// These keys come out of the database and reach a route that serves bytes back, which
// makes them the classic traversal vector: one `../../auth-store.db` in a storage_key
// and that route hands out password hashes. Gate 1 is here — a strict whole-string
// regex, so `..`, absolute paths, backslashes, percent-encoding and NUL fail because
// those characters are simply not in any allowed class. Gate 2 (`resolveWithinRoot`)
// lives in lib/data/object-store-local.js, because it is only meaningful where a key
// still becomes a filesystem path. Against a bucket there is no path to escape from,
// and pretending otherwise would be cargo cult.
//
// Adapted from lib/data/project-storage.js on origin/experimental/listing-studio — the
// gate-1 regex and the "one function builds a key, one takes it apart" rule transfer
// directly; the filesystem half does not.
import crypto from 'crypto';

/** The blob roles one render has. Order is display order in the gallery detail panel. */
export const RENDER_ROLES = Object.freeze(['after', 'before', 'thumb']);

/**
 * Every key prefix `keyForRender` and `keyForRef` can produce, mapped to how erasure
 * reaches the bytes under it.
 *
 * This is not documentation — `test/data/user-deletion.test.js` asserts that every
 * prefix the builders below can emit appears here. The existing data-dir drift guard
 * discovers targets by scanning for `path.join(<dataDir>, …)` calls, so it passes
 * VACUOUSLY for anything living in a bucket; this map is what restores the
 * "classify it or fail the build" property for off-box bytes.
 */
export const R2_PREFIXES = Object.freeze({
  'renders/': 'render bytes (after/before/thumb) — erased via blob_tombstones, sourced from render_blobs.user_id',
  'refs/': 'furniture reference bytes — erased via blob_tombstones, sourced from ref_objects.user_id',
});

/**
 * Gate 1: the only key shape this store will touch.
 *
 * Render ids are 32 lowercase hex in practice (`newRenderId`); the 8–64 range leaves
 * room for a different minter without reopening this regex. Reference hashes are
 * exactly 64 — a full sha256 — because that is the only thing `refHashFor` produces.
 */
export const OBJECT_KEY_PATTERN =
  /^(renders\/[a-f0-9]{8,64}\/(?:after|before|thumb)|refs\/[a-f0-9]{64})\.[a-z0-9]{2,5}$/;

/** Render ids on their own, for callers that build a prefix rather than a full key. */
export const RENDER_ID_PATTERN = /^[a-f0-9]{8,64}$/;

/**
 * The refusal every gate throws, carrying a `code` so a route can answer 400/404
 * instead of leaking a key or a path in a 500.
 * @param {string} message - What was refused.
 * @returns {Error} With `code: 'EUNSAFEKEY'`.
 */
export function unsafeKey(message) {
  const err = new Error(`[object-keys] ${message}`);
  /** @type {any} */ (err).code = 'EUNSAFEKEY';
  return err;
}

/**
 * Gate 1 as a predicate.
 * @param {unknown} key - Candidate key, usually straight out of a database row.
 * @returns {boolean} True when it matches {@link OBJECT_KEY_PATTERN} exactly.
 */
export function isSafeObjectKey(key) {
  return typeof key === 'string' && OBJECT_KEY_PATTERN.test(key);
}

/**
 * Normalize a caller-supplied extension: strip leading dots, lowercase it.
 * @param {unknown} ext - e.g. `.WEBP`, `webp`.
 * @returns {string} e.g. `webp`.
 */
function cleanExtension(ext) {
  return String(ext == null ? '' : ext).replace(/^\.+/, '').toLowerCase();
}

/**
 * Build the canonical key for one render blob.
 *
 * POSIX separators always, on every platform, because this string is persisted: a key
 * written on Windows has to resolve against Render's Linux disk and against R2. Throws
 * rather than returning a bad key — a caller that gets this wrong would otherwise
 * persist an unservable `storage_key` and only find out when somebody asked for the
 * image back.
 *
 * @param {{ renderId: string, role: string, ext?: string }} arg - `role` is one of
 *   {@link RENDER_ROLES}; `ext` may carry a leading dot or not, and defaults to webp.
 * @returns {string} e.g. `renders/<renderId>/after.webp`
 * @throws {Error} `code: 'EUNSAFEKEY'` when the pieces cannot make a legal key.
 */
export function keyForRender({ renderId, role, ext = 'webp' }) {
  const key = `renders/${String(renderId).toLowerCase()}/${role}.${cleanExtension(ext)}`;
  if (!RENDER_ROLES.includes(String(role)) || !isSafeObjectKey(key)) {
    throw unsafeKey(`refusing to build a render key from ${JSON.stringify({ renderId, role, ext })}`);
  }
  return key;
}

/**
 * Build the canonical key for one furniture reference blob.
 * @param {{ refHash: string, ext?: string }} arg - `refHash` from {@link refHashFor}.
 * @returns {string} e.g. `refs/<64 hex>.webp`
 * @throws {Error} `code: 'EUNSAFEKEY'` when the pieces cannot make a legal key.
 */
export function keyForRef({ refHash, ext = 'webp' }) {
  const key = `refs/${String(refHash).toLowerCase()}.${cleanExtension(ext)}`;
  if (!isSafeObjectKey(key)) {
    throw unsafeKey(`refusing to build a ref key from ${JSON.stringify({ refHash, ext })}`);
  }
  return key;
}

/**
 * The content address of one furniture reference, scoped to its uploader.
 *
 * RAW UPLOAD BYTES, not the normalized/encoded bytes. Encoding first would make the
 * hash depend on the libvips build, so a sharp upgrade would silently re-key every
 * reference in the store and dedupe would stop working against everything uploaded
 * before it. Raw bytes are deterministic forever, and they catch the reuse pattern that
 * actually happens: the agent picks the same file out of the same folder for photo
 * after photo of one listing.
 *
 * SALTED WITH THE USER ID, for three reasons. It keeps the id out of the key (see the
 * header); it scopes dedupe to one account, so no cross-account inference is possible
 * from a hash collision; and it makes GDPR erasure an UNCONDITIONAL delete rather than
 * a "does anyone else still reference this?" question. Cross-user dedupe of a stock
 * furniture photo would be a rounding error; being able to say "erasure deleted their
 * bytes, full stop" is not.
 *
 * @param {string} userId - The uploader's account id.
 * @param {Buffer | Uint8Array} buffer - The RAW upload bytes, before any re-encode.
 * @returns {string} 64 lowercase hex characters.
 */
export function refHashFor(userId, buffer) {
  return crypto
    .createHash('sha256')
    .update(`${String(userId)}:`)
    .update(buffer)
    .digest('hex');
}

/**
 * Which {@link R2_PREFIXES} entry a key belongs to.
 * @param {string} key - A storage key.
 * @returns {string | null} The matching prefix, or null when the key is not one of ours.
 */
export function prefixOf(key) {
  if (!isSafeObjectKey(key)) return null;
  return Object.keys(R2_PREFIXES).find((p) => String(key).startsWith(p)) ?? null;
}

/**
 * Mint an id for a new render. 32 hex from the CSPRNG — the same shape and source as
 * the session tokens in lib/data/session-tokens.js, because this id also ends up in a
 * URL a stranger can see (`renders/<id>/after.webp` inside a presigned link).
 * @returns {string} 32 lowercase hex characters.
 */
export function newRenderId() {
  return crypto.randomBytes(16).toString('hex');
}
