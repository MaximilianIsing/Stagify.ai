// The Masking Studio's "Looks Good" → a gallery entry.
//
// Every other writer in this directory turns a MODEL CALL into a gallery row. This one
// does not generate anything: the studio composites its per-area edits on a canvas in the
// browser, so the finished image only ever exists client-side, and the only way it reaches
// the gallery is by being posted back. That single difference explains most of what looks
// unusual below.
//
// ONE OUTCOME: INSERT. Every save creates a new gallery entry. There used to be a second,
// REPLACE, taken when the studio had been opened on one of the owner's existing renders via
// "Refine in Masking Studio" — that hand-off has been removed from the product, so no
// `renderId` can reach this handler and the branch went with it. If the hand-off ever comes
// back, the replace path has to come back with it; do not reintroduce one without the other.
//
// NO METERING HERE, AND DO NOT COPY IT IN. The generations this image is made of were
// already metered at /api/mask-edit, one call per painted area — `reportEnterpriseUsage`
// and `recordStagingActivity` both ran there. Saving is not a generation. The block that
// looks copyable is in exterior-handler.js, two files away, and copying it would bill
// enterprise customers twice for work they already paid for.
//
// deps: { renderPersistence }
//   - No genAI, no processStaging, no authStore: nothing here calls a model or resolves an
//     account. The router has already established the Stagify+ user via requireProAccount.
import { logger } from '../logger.js';
import { sendError } from '../http/http-helpers.js';
import { isImageDataUrl, decodeImageDataUrl } from './data-url.js';
import { stampVirtuallyStaged, readStampRequest } from '../image/stamp-disclosure.js';

/**
 * Ceiling on a single posted image, in decoded bytes.
 *
 * The studio works at at most 1920×1080 (public/scripts/masking-studio-app.js), so a
 * q0.92 JPEG of one is comfortably under a megabyte and this is roughly eight times the
 * realistic worst case. It exists so a hostile client cannot make the process allocate an
 * arbitrary buffer, and it is checked on the DECODED length rather than the string's, since
 * base64 inflates by a third and the string ceiling is the body parser's job.
 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** How many painted areas one composite may claim. Matches the studio's colour palette. */
const MAX_AREAS = 6;

/** Ceiling on the joined per-area prompts, matching the exterior handler's free-text cap. */
const MAX_PROMPT_LENGTH = 500;

/**
 * The gallery name's qualifier for a masking render: how many areas were edited.
 *
 * Pluralized HERE rather than in public/scripts/render-name.js, because that module is
 * shared with the public share page, which loads no language pack and has no plural
 * machinery — and because the count is not in any column, so it has to be stored anyway.
 *
 * @param {number} areas @returns {string}
 */
export function areasQualifier(areas) {
  const n = Number.isFinite(areas) ? Math.max(1, Math.min(MAX_AREAS, Math.floor(areas))) : 1;
  return `${n} area${n === 1 ? '' : 's'}`;
}

/**
 * Build the Masking Studio save handler.
 *
 * @param {{ renderPersistence?: any }} deps - Injected dependencies.
 * @returns {{ handleMaskingSave: (req: import('express').Request, res: import('express').Response, user: any) => Promise<any> }}
 */
export function createMaskingSaveHandler(deps) {
  const { renderPersistence = null } = deps;

  /**
   * Save one composited result, replacing an existing entry when we can and inserting when
   * we cannot.
   *
   * @param {import('express').Request} req - JSON body, already size-limited by the router.
   * @param {import('express').Response} res - Express response.
   * @param {any} user - The Stagify+ account, already established by requireProAccount.
   * @returns {Promise<any>}
   */
  async function handleMaskingSave(req, res, user) {
    const { after, before, areas, prompts, sourceName } = req.body ?? {};

    if (!isImageDataUrl(after)) {
      return sendError(res, 400, 'No composited image provided');
    }
    // `before` is optional but must be valid IF present — a malformed one costs the
    // before/after slider, so it is dropped rather than failing the whole save.
    const beforeOk = isImageDataUrl(before);

    // Measured on what the CLIENT sent, before any stamping: the ceiling exists to stop a
    // hostile client from making the process allocate an arbitrary buffer, so it has to be
    // the gate the payload passes through first.
    const rawAfterBuffer = decodeImageDataUrl(after);
    if (rawAfterBuffer.length > MAX_IMAGE_BYTES) {
      return sendError(res, 413, 'That image is too large to save');
    }

    // "Label as virtually staged" — burned in HERE for the gallery copy.
    //
    // The studio composites in the browser, so its two exits reach the badge differently:
    // Download posts to /api/stamp-image because those pixels are nowhere else, while this
    // request is already carrying them. Stamping there too would upload the same megabyte
    // twice for an identical result.
    //
    // The stored master is the copy that matters most. It is what the owner re-downloads
    // months later and what a share link serves — an unlabelled one outlives every session
    // that could have explained it.
    //
    // `before` is deliberately NOT stamped: it is the pristine room photo, which is not
    // virtually staged, and labelling it would be a false claim about the one image in the
    // pair that is honest by construction.
    const stamp = readStampRequest(req.body ?? {});
    let afterBuffer = rawAfterBuffer;
    if (stamp.enabled) {
      try {
        const stamped = await stampVirtuallyStaged(after, stamp);
        afterBuffer = decodeImageDataUrl(stamped);
      } catch (error) {
        // FAIL CLOSED, exactly as /api/process-image does. Saving the unlabelled composite
        // instead would put an undisclosed photo in the gallery under a request that asked
        // for a disclosure — and unlike a failed download, nothing would ever tell the user.
        // The client can retry by pressing "Looks Good" again; savedDigest is only set on a
        // successful save.
        logger.error('[gallery] masking save could not apply the disclosure:', error);
        return sendError(res, 500, 'We couldn\'t add the "virtually staged" label, so nothing was saved to your gallery. Untick that option to save without it.', {
          code: 'DISCLOSURE_STAMP_FAILED',
        });
      }
    }
    let beforeBuffer = null;
    if (beforeOk) {
      const decoded = decodeImageDataUrl(before);
      if (decoded.length <= MAX_IMAGE_BYTES) beforeBuffer = decoded;
    }

    // Not an error: with no object store configured there is no gallery at all, and the
    // studio's save is a nicety on top of a download the user already has. Mirrors how
    // routes/gallery.js reports `enabled: false` rather than failing.
    if (!renderPersistence?.enabled()) {
      return res.json({ success: true, gallery: null });
    }

    const joinedPrompts = Array.isArray(prompts)
      ? prompts.filter((p) => typeof p === 'string' && p.trim()).join('; ').slice(0, MAX_PROMPT_LENGTH)
      : '';

    try {
      const pending = renderPersistence.recordPending({
        user,
        // This route is Pro-only by construction, so there is no free branch to mirror.
        isPro: true,
        natives: [{ buffer: afterBuffer }],
        params: {
          // The studio never asks for either, and renderMeta skips empty values — so the
          // detail panel shows no blank Room/Style rows rather than two lying ones.
          roomType: '',
          furnitureStyle: '',
          additionalPrompt: joinedPrompts,
          removeFurniture: false,
        },
        extra: { source: 'masking', qualifier: areasQualifier(areas), sourceName },
      });
      if (!pending) return res.json({ success: true, gallery: null });

      // Awaited, unlike the generate paths: this request exists to do this write, so
      // answering before it lands would be reporting a save that had not happened.
      await renderPersistence.uploadInBackground({
        entries: pending.entries,
        sourceBuffer: beforeBuffer,
        // Per-area furniture reference photos are deliberately not sent. The client holds
        // up to six as data URLs, and posting them would multiply the payload for a
        // provenance thumbnail nobody asked for.
        refUploads: [],
        user,
      });

      return res.json({
        success: true,
        gallery: { ids: pending.entries.map((e) => e.id), evicted: pending.evicted, tier: 'pro' },
      });
    } catch (error) {
      logger.error('[gallery] masking save failed:', error);
      return sendError(res, 500, 'Could not save that to your gallery');
    }
  }

  return { handleMaskingSave };
}
