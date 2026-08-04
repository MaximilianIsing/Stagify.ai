// Turning a finished staging request into a gallery entry.
//
// THE SPLIT, AND WHY IT IS NOT NEGOTIABLE
// Rows are written SYNCHRONOUSLY, before the response: the free-tier cap must be exact
// and unraceable, which means it has to run inside the insert transaction (see
// lib/data/staged-renders.js). That is microseconds of better-sqlite3.
//
// Bytes are pushed ASYNCHRONOUSLY, after the response has been sent: three sharp
// encodes per variation plus the object-store PUTs, roughly 200-500 ms of CPU and
// network. The user has already waited a minute for the render. Making them wait again
// so a history feature can save a copy would be charging them for our convenience.
//
// A FAILED SAVE IS SILENT, ON PURPOSE
// The client already has the image — it is in the response. If the upload fails the row
// stays `pending`, the manifest (which filters on `ok`) simply never shows it, and the
// stale sweep marks it failed an hour later. Interrupting somebody to say "we could not
// add this to your history" is noise about a problem they cannot act on.
//
// WHAT GETS STORED, AND WHAT DELIBERATELY DOES NOT
// The delivery image never does. `upscaleForDelivery` enlarges the ~1 MP model output to
// as much as 4096px so the downloaded JPEG looks bigger; measured on a detailed source
// that is ~737 KB against ~110 KB for the native buffer, and every one of those extra
// bytes is lanczos interpolation carrying no additional detail. The gallery stores the
// native result, a source photo capped to the result's own long edge (storing a 1600px
// "before" next to a 1024px "after" is backwards), and a thumbnail.
import sharp from 'sharp';
import { keyForRender, newRenderId } from '../data/object-keys.js';
import { buildRenderExtra } from '../data/render-extra.js';
import { logger } from '../logger.js';

/** Encoder settings per role. Sizes measured on a detailed 2400px source. */
export const ENCODES = Object.freeze({
  // No resize: the model's native output IS the master. Capped only as a backstop
  // against a future model returning something enormous.
  after: { maxEdge: 2048, quality: 82 },
  before: { maxEdge: 1280, quality: 78 },
  thumb: { maxEdge: 480, quality: 75 },
});

/** Reference photos are provenance display, not a deliverable. */
export const REF_ENCODE = { maxEdge: 640, quality: 72 };

/**
 * Re-encode one image to WebP at a bounded size.
 * @param {Buffer} buffer - Source bytes.
 * @param {{ maxEdge: number, quality: number }} spec
 * @returns {Promise<{ buffer: Buffer, width: number, height: number }>}
 */
async function encode(buffer, spec) {
  const out = await sharp(buffer)
    .rotate() // honour EXIF before measuring, or a portrait phone photo stores sideways
    .resize({ width: spec.maxEdge, height: spec.maxEdge, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: spec.quality })
    .toBuffer({ resolveWithObject: true });
  return { buffer: out.data, width: out.info.width, height: out.info.height };
}

/**
 * Build the persistence helper.
 *
 * @param {{ objectStore: import('../data/object-store.js').ObjectStore,
 *   stagedRenders: ReturnType<typeof import('../data/staged-renders.js').createStagedRenders>,
 *   renderRefs: ReturnType<typeof import('../data/render-refs.js').createRenderRefs>,
 *   blobReaper?: { drain: (opts?: any) => Promise<any> } }} deps
 */
export function createRenderPersistence({ objectStore, stagedRenders, renderRefs, blobReaper }) {
  /**
   * Whether the gallery can accept anything at all. False on Render with no R2
   * configured, which is a deliberate "no gallery" rather than a fallback that would
   * fill the app volume — see lib/data/object-store.js.
   */
  const enabled = () => !!objectStore?.configured;

  /**
   * Reserve gallery rows for one request's results, and enforce the account's cap.
   *
   * SYNCHRONOUS and fast. Returns the ids and the planned object keys so the caller can
   * hand them straight to {@link uploadInBackground}.
   *
   * EVERY WRITER GOES THROUGH HERE, which is why `extra` is sanitized in this function and
   * not at the four call sites. `buildRenderExtra` rejects an unknown `source` by returning
   * null, so a typo in a new writer costs that render its name rather than its row — and a
   * writer that forgets `extra` entirely is caught by the drift guard in
   * test/data/render-extra.test.js, not by a runtime failure on a paid render.
   *
   * @param {{ user: { id: string, plan?: string }, isPro: boolean,
   *   natives: { buffer: Buffer }[], params: any, model?: string, batchId?: string,
   *   extra?: { source?: string, qualifier?: string, sourceName?: string } | null,
   *   variationBase?: number, now?: number }} arg - `variationBase` offsets the `variation`
   *   column. The AI Designer stages up to three DIFFERENT photos in one turn and so calls
   *   this once per result rather than once with three natives; without the offset all
   *   three would land as variation 0 of the same batch.
   * @returns {{ entries: { id: string, native: Buffer }[],
   *   evicted: { id: string, hadLiveShare: boolean }[] } | null} Null when the gallery
   *   is off, which callers treat as "skip persistence entirely".
   */
  function recordPending({
    user, isPro, natives, params, model, batchId, extra, variationBase = 0, now = Date.now(),
  }) {
    if (!enabled() || !user || !natives?.length) return null;
    const entries = [];
    const evicted = [];
    const builtExtra = buildRenderExtra(extra);
    natives.forEach((native, index) => {
      const id = newRenderId();
      const res = stagedRenders.record({
        render: {
          id,
          userId: user.id,
          roomType: params?.roomType,
          furnitureStyle: params?.furnitureStyle,
          additionalPrompt: params?.additionalPrompt,
          removeFurniture: !!params?.removeFurniture,
          model,
          variation: variationBase + index,
          batchId: batchId ?? undefined,
          extra: builtExtra,
        },
        // Keys are planned up front so a crash mid-upload leaves a row whose bytes the
        // stale sweep can still find and tombstone.
        blobs: ['after', 'thumb'].map((role) => ({ role, storageKey: keyForRender({ renderId: id, role }) })),
        isPro,
        now,
      });
      entries.push({ id, native: native.buffer });
      evicted.push(...res.evicted);
    });
    return { entries, evicted };
  }

  /**
   * Encode and upload one request's bytes, then mark the rows visible.
   *
   * NEVER REJECTS, and never throws synchronously. It is invoked as `void
   * uploadInBackground(...)` from the response path; an unhandled rejection in Node 22
   * exits the process, so a failed image save must not be able to take the server down.
   *
   * @param {{ entries: { id: string, native: Buffer }[], sourceBuffer?: Buffer | null,
   *   refUploads?: { buffer: Buffer }[], user: { id: string } }} arg
   * @returns {Promise<{ ok: number, failed: number }>}
   */
  async function uploadInBackground({ entries, sourceBuffer, refUploads, user }) {
    const result = { ok: 0, failed: 0 };
    try {
      if (!enabled()) return result;

      // The source photo is shared by every variation of one request, so it is encoded
      // ONCE and uploaded under each render's own key. Encoding it per variation would
      // triple the CPU for identical bytes.
      let encodedSource = null;
      if (sourceBuffer) {
        try {
          encodedSource = await encode(sourceBuffer, ENCODES.before);
        } catch (error) {
          // A source that will not decode costs the before/after slider, nothing else.
          logger.warn('[gallery] could not encode the source photo:', error);
        }
      }

      for (const entry of entries) {
        try {
          const after = await encode(entry.native, ENCODES.after);
          const thumb = await encode(entry.native, ENCODES.thumb);

          await objectStore.put(keyForRender({ renderId: entry.id, role: 'after' }), after.buffer, 'image/webp');
          await objectStore.put(keyForRender({ renderId: entry.id, role: 'thumb' }), thumb.buffer, 'image/webp');
          if (encodedSource) {
            await objectStore.put(
              keyForRender({ renderId: entry.id, role: 'before' }),
              encodedSource.buffer,
              'image/webp',
            );
            stagedRenders.recordBlob(entry.id, 'before', keyForRender({ renderId: entry.id, role: 'before' }),
              encodedSource.buffer.length, user.id);
          }
          stagedRenders.recordBlob(entry.id, 'after', keyForRender({ renderId: entry.id, role: 'after' }),
            after.buffer.length, user.id);
          stagedRenders.recordBlob(entry.id, 'thumb', keyForRender({ renderId: entry.id, role: 'thumb' }),
            thumb.buffer.length, user.id);

          // Only now does the entry become visible. The manifest filters on `ok`, so a
          // half-uploaded render is absent rather than a set of broken images.
          stagedRenders.markOk(entry.id, { width: after.width, height: after.height });
          result.ok += 1;
        } catch (error) {
          logger.error(`[gallery] could not store render ${entry.id}:`, error);
          result.failed += 1;
        }
      }

      if (refUploads?.length) await storeReferences({ user, refUploads, renderIds: entries.map((e) => e.id) });

      // Anything the eviction in recordPending queued is owed a deletion; kick it now
      // rather than waiting up to five minutes for the interval.
      if (blobReaper) await blobReaper.drain().catch(() => {});
    } catch (error) {
      logger.error('[gallery] background persistence failed outright:', error);
    }
    return result;
  }

  /**
   * Swap a finished render's result bytes for a refined version.
   *
   * AWAITED by its caller, unlike {@link uploadInBackground} — the Masking Studio's save is
   * a request whose whole purpose is this write, so answering 200 before it succeeded would
   * be lying. It still never throws, for the same reason everything else here does not.
   *
   * ORDER IS A SECURITY REQUIREMENT, not a style choice. The database row is claimed FIRST,
   * with ownership in its WHERE, and only then are bytes PUT. Reversed, anyone who guessed
   * a render id would overwrite `renders/<victim>/after.webp` before the guarded UPDATE
   * harmlessly failed — the row would survive and the victim's pixels would not.
   *
   * The keys are unchanged, so a PUT failure after the row was claimed leaves an entry
   * whose thumbnail and full image briefly disagree. That is transient and self-healing:
   * pressing Looks Good again re-PUTs both. It is also the same class of partial failure
   * the insert path already accepts.
   *
   * @param {{ renderId: string, user: { id: string }, native: Buffer }} arg
   * @returns {Promise<boolean>} False when there was no live, finished row of the caller's
   *   to replace — the caller then inserts instead.
   */
  async function replaceInBackground({ renderId, user, native }) {
    try {
      if (!enabled() || !user || !native) return false;
      const after = await encode(native, ENCODES.after);
      const thumb = await encode(native, ENCODES.thumb);
      const keys = {
        after: keyForRender({ renderId, role: 'after' }),
        thumb: keyForRender({ renderId, role: 'thumb' }),
      };
      // Claim the row before a single byte moves. `replaceResult` refuses anything that is
      // not a live, finished render belonging to this account.
      const claimed = stagedRenders.replaceResult({
        id: renderId,
        userId: user.id,
        width: after.width,
        height: after.height,
        blobs: [
          { role: 'after', storageKey: keys.after, bytes: after.buffer.length },
          { role: 'thumb', storageKey: keys.thumb, bytes: thumb.buffer.length },
        ],
      });
      if (!claimed) return false;
      await objectStore.put(keys.after, after.buffer, 'image/webp');
      await objectStore.put(keys.thumb, thumb.buffer, 'image/webp');
      return true;
    } catch (error) {
      logger.error(`[gallery] could not replace render ${renderId}:`, error);
      return false;
    }
  }

  /**
   * Store the furniture references for a request, deduped.
   *
   * Content-addressed: the second render that uses the same sofa photo skips both the
   * encode and the PUT. Failures are per-reference and non-fatal — a missing reference
   * costs a thumbnail in the detail panel, not the gallery entry.
   *
   * @param {{ user: { id: string }, refUploads: { buffer: Buffer }[], renderIds: string[] }} arg
   */
  async function storeReferences({ user, refUploads, renderIds }) {
    const hashes = [];
    for (const upload of refUploads) {
      try {
        // Hash the RAW upload bytes — see refHashFor. Encoding first would make the
        // hash depend on the libvips build, so a sharp upgrade would re-key everything.
        const refHash = renderRefs.hashFor(user.id, upload.buffer);
        const reserved = renderRefs.ensureRef({ userId: user.id, refHash });
        if (reserved.created) {
          const encoded = await encode(upload.buffer, REF_ENCODE);
          await objectStore.put(reserved.storageKey, encoded.buffer, 'image/webp');
        }
        hashes.push(refHash);
      } catch (error) {
        logger.warn('[gallery] could not store a furniture reference:', error);
      }
    }
    if (!hashes.length) return;
    for (const renderId of renderIds) {
      try {
        renderRefs.link({ renderId, userId: user.id, refHashes: hashes });
      } catch (error) {
        logger.warn(`[gallery] could not link references to ${renderId}:`, error);
      }
    }
  }

  return { enabled, recordPending, uploadInBackground, replaceInBackground };
}
