// Furniture reference photos: the up-to-five images a user attaches to a staging
// request, kept so the gallery can show what was asked for.
//
// WHY THESE ARE DEDUPED AND THE RENDERS ARE NOT
// An agent picks the same sofa photo out of the same folder for room after room of one
// listing. Storing it per render would multiply the gallery's footprint by up to five
// for no information gain. So a reference is CONTENT-ADDRESSED: one object per distinct
// image, referenced by many renders, and a second upload of the same bytes is a row
// insert with no network call at all.
//
// The hash is `sha256(userId + ':' + RAW upload bytes)` — see refHashFor in
// lib/data/object-keys.js for why raw (deterministic across libvips versions) and why
// salted per user (dedupe where it pays, no user id in the key, and an unconditional
// delete on erasure instead of a "does anyone else still use this?" question).
//
// NO REFERENCE COUNTS — the lifetime is DERIVED
// A denormalized `ref_count` has two failure modes and one is user-visible: a lost
// decrement leaks an object (harmless, the orphan sweep gets it), but a double-decrement
// deletes bytes a live gallery entry still points at, which is a broken image forever.
// There is no counter to get wrong if there is no counter, so "is this reference still
// used" is an indexed NOT EXISTS against `render_refs`, evaluated inside the same
// transaction that removes the rows. Exact by construction rather than by reconciliation.
// The sweep itself lives in staged-renders.js, because that is where deletion happens.
import { getDb } from './db.js';
import { GALLERY_SCHEMA } from './gallery-schema.js';
import { keyForRef, refHashFor } from './object-keys.js';
import { REFS_FOR_RENDERS_SQL } from './gallery-page-reads.js';

/** Most references one render may carry — the same ceiling multer enforces on upload. */
export const MAX_REFS_PER_RENDER = 5;

/**
 * Open the reference store.
 * @param {string} baseDir - Handed to getDb, as every store in lib/data does.
 */
export function createRenderRefs(baseDir) {
  const db = getDb(baseDir);
  db.exec(GALLERY_SCHEMA);

  const q = {
    getRef: db.prepare('SELECT ref_hash, storage_key, bytes FROM ref_objects WHERE ref_hash = ?'),
    insRef: db.prepare(`
      INSERT OR IGNORE INTO ref_objects (ref_hash, storage_key, bytes, width, height, created_at, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    insLink: db.prepare('INSERT OR REPLACE INTO render_refs (render_id, seq, ref_hash, user_id) VALUES (?, ?, ?, ?)'),
    forRender: db.prepare(`
      SELECT rr.seq, o.ref_hash, o.storage_key, o.bytes, o.width, o.height
      FROM render_refs rr JOIN ref_objects o ON o.ref_hash = rr.ref_hash
      WHERE rr.render_id = ? ORDER BY rr.seq
    `),
    // The same read for a PAGE of renders — see gallery-page-reads.js for why json_each.
    forRenders: db.prepare(REFS_FOR_RENDERS_SQL),
    countForUser: db.prepare('SELECT COUNT(*) AS n FROM ref_objects WHERE user_id = ?'),
  };

  return {
    MAX_REFS_PER_RENDER,

    /**
     * The content address for one uploaded reference.
     * @param {string} userId - The uploader.
     * @param {Buffer | Uint8Array} rawBuffer - The RAW upload bytes, before any re-encode.
     * @returns {string} 64 lowercase hex.
     */
    hashFor(userId, rawBuffer) {
      return refHashFor(userId, rawBuffer);
    },

    /**
     * Reserve a reference object, telling the caller whether its bytes still need
     * uploading.
     *
     * `INSERT OR IGNORE` plus the returned flag is what makes dedupe cheap AND
     * race-safe: two renders submitting the same photo at once both call this, exactly
     * one gets `created: true`, and the other skips the encode and the PUT entirely.
     * A duplicate upload would be harmless (same key, same bytes) but it is pure waste.
     *
     * @param {{ userId: string, refHash: string, bytes?: number, width?: number,
     *   height?: number, ext?: string, now?: number }} arg
     * @returns {{ refHash: string, storageKey: string, created: boolean }} `created`
     *   false means the object is already in the store — do not re-upload.
     */
    ensureRef({ userId, refHash, bytes = 0, width, height, ext = 'webp', now = Date.now() }) {
      const storageKey = keyForRef({ refHash, ext });
      const res = q.insRef.run(refHash, storageKey, bytes, width ?? null, height ?? null, now, userId);
      if (res.changes) return { refHash, storageKey, created: true };
      // Already present: return the key that is actually stored rather than the one we
      // would have built, in case an older row used a different extension.
      const existing = /** @type {any} */ (q.getRef.get(refHash));
      return { refHash, storageKey: existing?.storage_key ?? storageKey, created: false };
    },

    /**
     * Attach references to a render, in the order the user supplied them.
     *
     * Not transactional on its own — the caller runs it inside the insert transaction in
     * staged-renders.js, so a render and its references become visible together.
     *
     * @param {{ renderId: string, userId: string, refHashes: string[] }} arg
     * @returns {number} How many links were written.
     */
    link({ renderId, userId, refHashes }) {
      const capped = (refHashes ?? []).slice(0, MAX_REFS_PER_RENDER);
      capped.forEach((refHash, seq) => q.insLink.run(renderId, seq, refHash, userId));
      return capped.length;
    },

    /**
     * The references one render used, in order.
     * @param {string} renderId
     * @returns {{ seq: number, ref_hash: string, storage_key: string, bytes: number,
     *   width: number | null, height: number | null }[]}
     */
    forRender(renderId) {
      return /** @type {any} */ (q.forRender.all(renderId));
    },

    /**
     * The references a whole page of renders used, grouped by render.
     *
     * The gallery listing used to call {@link forRender} once per row inside its map, so a
     * page cost one statement per tile on top of everything else it was already doing per
     * tile. This is those reads in one.
     *
     * MOST RENDERS HAVE NO REFERENCES AT ALL — they are the up-to-five furniture photos an
     * agent optionally attaches — so the old shape spent most of its sixty statements
     * learning that the answer was empty. Such a render is ABSENT from the map, not
     * present with an empty array; the caller defaults it.
     *
     * Rows carry `render_id` (the single-render statement's do not) because the grouping
     * key has to come back from SQL. Nothing downstream reads it, and stripping it would
     * cost an object copy per row to remove a field no caller looks at.
     *
     * @param {string[]} renderIds
     * @returns {Map<string, { render_id: string, seq: number, ref_hash: string,
     *   storage_key: string, bytes: number, width: number | null, height: number | null }[]>}
     */
    forRenders(renderIds) {
      const out = new Map();
      if (!renderIds?.length) return out;
      for (const row of /** @type {any[]} */ (q.forRenders.all(JSON.stringify(renderIds)))) {
        const list = out.get(row.render_id);
        if (list) list.push(row);
        else out.set(row.render_id, [row]);
      }
      return out;
    },

    /** @param {string} userId @returns {number} Distinct reference objects this account owns. */
    countForUser(userId) {
      return /** @type {any} */ (q.countForUser.get(userId)).n;
    },
  };
}
