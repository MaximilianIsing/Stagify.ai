// staging routes, extracted verbatim from server.js.
import { createAsyncRouter } from '../lib/http/async-router.js';
import { sendError } from '../lib/http/http-helpers.js';
import { reportError } from '../lib/http/error-ref.js';
import { createMaskEditHandler } from '../lib/staging/mask-edit.js';
import { createSegmentHandler } from '../lib/staging/segment.js';
import { IMAGE_DATA_URL_RE, isImageDataUrl, decodeImageDataUrl } from '../lib/staging/data-url.js';
import sharp from 'sharp';
import { withDisclosureMetadata } from '../lib/image/output-metadata.js';
import { DELIVERY_MAX_EDGE } from '../lib/image/image-primitives.js';
import { logger } from '../lib/logger.js';
import {
  validateImageLimiter as defaultValidateImageLimiter,
  galleryImportLimiter as defaultGalleryImportLimiter,
  disclosurePreviewLimiter as defaultDisclosurePreviewLimiter,
  stampImageLimiter as defaultStampImageLimiter,
  downloadResultLimiter as defaultDownloadResultLimiter,
} from '../lib/http/rate-limiters.js';
import {
  normalizePreviewParams,
  renderDisclosurePreview,
  PREVIEW_CONTENT_TYPE,
} from '../lib/image/disclosure-preview.js';
import { stampVirtuallyStaged } from '../lib/image/stamp-disclosure.js';

// A validate-image payload must be a base64 image data URL — both studios build one
// with canvas.toDataURL() — so anything else is not a real upload. Checking the shape
// here costs a regex instead of a paid vision call. The definition is shared with
// mask-edit and segment (lib/staging/data-url.js) so the three cannot drift apart.

// Ceiling on the DECODED image the pre-check will look at, enforced from the encoded
// length so an oversized payload is refused before a buffer is allocated for it. The
// studios downscale to a <=1024px JPEG (a few hundred KB) before posting; this leaves
// generous room for the rare fallback that posts the original photo, while stopping a
// caller from pushing the full 25MB JSON limit through a paid vision call.
const MAX_VALIDATE_IMAGE_BYTES = 8 * 1024 * 1024;

// Ceiling on the image POST /api/stamp-image will stamp, enforced the same way and for the
// same reason. Larger than the pre-check's because this one is NOT a downscaled probe: it is
// the finished full-resolution composite the user is about to download, straight off a
// canvas as PNG, which is a far heavier encoding than the JPEG the studios send above.
//
// Deliberately BELOW what the body parser would allow: /api/stamp-image is on
// JSON_LARGE_LIMIT_PATHS, whose 25MB applies to the ENCODED body, i.e. ~18.7MB decoded. A
// ceiling above that would never fire, and the caller would get the parser's generic 413
// instead of a message naming the image.
const MAX_STAMP_IMAGE_BYTES = 16 * 1024 * 1024;

// Ceiling on the image POST /api/download-result will resize+re-encode, enforced the
// same way and for the same reason as MAX_STAMP_IMAGE_BYTES: this is the finished
// full-resolution result the user is about to download, not a downscaled probe.
const MAX_DOWNLOAD_RESULT_BYTES = 16 * 1024 * 1024;

// The largest edge a resize request may ask for. download-menu.js's own 2× row can
// already request up to double a DELIVERY_MAX_EDGE image, so this is that same ceiling
// doubled — generous enough for every row buildSizeRows ever computes, tight enough that
// a forged request can't make sharp allocate an arbitrary canvas.
const MAX_DOWNLOAD_RESULT_EDGE = DELIVERY_MAX_EDGE * 2;

/**
 * A positive integer within MAX_DOWNLOAD_RESULT_EDGE, or null.
 * @param {unknown} value
 * @returns {number | null}
 */
function clampDownloadDim(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0 || n > MAX_DOWNLOAD_RESULT_EDGE) return null;
  return n;
}

/**
 * Build the virtual-staging router. `deps` is the full injection bag shared by
 * this router's inline handlers and the sibling handler factories
 * (mask-edit / segment), each of which destructures its own slice.
 *
 * @param {{
 *   genAI: { getGenerativeModel: (options: any) => any } | null,
 *   genLimiter: import('express').RequestHandler,
 *   validateImageLimiter?: import('express').RequestHandler,
 *   stagingProcessUpload: import('express').RequestHandler,
 *   stagingEndpointKeyGuard: import('express').RequestHandler,
 *   setSensitiveHeaders: (res: import('express').Response) => void,
 *   getAuthUserFromRequest: (req: import('express').Request) => any,
 *   requireProAccount: (req: import('express').Request, res: import('express').Response) => any,
 *   enterpriseDomainForUser: ReturnType<typeof import('../lib/services/auth-helpers.js').createAuthHelpers>['enterpriseDomainForUser'],
 *   reportEnterpriseUsage: ReturnType<typeof import('../lib/services/auth-helpers.js').createAuthHelpers>['reportEnterpriseUsage'],
 *   recordStagingActivity?: ReturnType<typeof import('../lib/services/auth-helpers.js').createAuthHelpers>['recordStagingActivity'],
 *   logRejectionToFile?: ReturnType<typeof import('../lib/services/logging.js').createLogging>['logRejectionToFile'],
 *   validateStageableImage: (imageBuffer: Buffer) => Promise<{ valid: boolean, code: string | null, reason: string }>,
 *   handleVirtualStagingMultipart: (req: import('express').Request, res: import('express').Response, meta: import('../lib/types/staging.js').VirtualStagingMeta) => Promise<import('express').Response | void>,
 *   handleExteriorMultipart: (req: import('express').Request, res: import('express').Response, user: any) => Promise<import('express').Response | void>,
 *   handleMaskingSave: (req: import('express').Request, res: import('express').Response, user: any) => Promise<import('express').Response | void>,
 *   galleryImportLimiter?: import('express').RequestHandler,
 *   disclosurePreviewLimiter?: import('express').RequestHandler,
 *   stampImageLimiter?: import('express').RequestHandler,
 *   downloadResultLimiter?: import('express').RequestHandler,
 *   downscaleImage: typeof import('../lib/image/image-primitives.js').downscaleImage,
 *   padBufferToAspectRatio: typeof import('../lib/image/image-primitives.js').padBufferToAspectRatio,
 *   buildMarkedRoomImage: typeof import('../lib/image/image-primitives.js').buildMarkedRoomImage,
 *   normalizeMaskOutputToRoom: typeof import('../lib/image/image-primitives.js').normalizeMaskOutputToRoom,
 *   compositeForReview: typeof import('../lib/image/image-primitives.js').compositeForReview,
 *   reviewMaskEdit: ReturnType<typeof import('../lib/image/image-review.js').createImageReview>['reviewMaskEdit'],
 *   generateWithQualityRetry: ReturnType<typeof import('../lib/staging/staging-generation.js').createStagingGeneration>['generateWithQualityRetry'],
 *   maskReferencePromptSuffix: typeof import('../lib/staging/prompts.js').maskReferencePromptSuffix,
 *   logMaskEditToFile: ReturnType<typeof import('../lib/services/logging.js').createLogging>['logMaskEditToFile'],
 *   DEBUG_MODE: boolean,
 *   MAX_MASK_PROMPT_LENGTH: number,
 *   MAX_SEGMENT_QUERY_LENGTH: number,
 *   QUALITY_MAX_ATTEMPTS: number,
 * }} deps - Injected AI clients, upload/rate-limit middleware, auth + enterprise-usage
 *   helpers, image-pipeline primitives, the QA reviewer, CSV logging, the virtual-staging
 *   multipart handler, and route-tuning constants. Passed whole to the sibling
 *   mask-edit / segment factories, which each type their own slice.
 *   `validateImageLimiter` is a test seam only: omitted (or null) it falls back to
 *   the shared `validateImageLimiter`, so the pre-check is never mounted with
 *   genLimiter as its only ceiling. `disclosurePreviewLimiter` is the same seam for the
 *   badge preview, which has no other ceiling at all, and `stampImageLimiter` for
 *   /api/stamp-image, which likewise has no genLimiter in front of it. `downloadResultLimiter`
 *   is the same seam for /api/download-result.
 */
export default function createStagingRouter(deps) {
  // Names used by the handlers still inlined below. The /api/mask-edit and
  // /api/segment handlers are built by the sibling factories (which each
  // destructure their own slice of the full `deps`).
  const { genLimiter, validateImageLimiter, galleryImportLimiter: injectedGalleryImportLimiter, stagingProcessUpload, setSensitiveHeaders, getAuthUserFromRequest, requireProAccount, validateStageableImage, handleVirtualStagingMultipart, handleExteriorMultipart, handleMaskingSave, stagingEndpointKeyGuard } = deps;
  // Optional so every existing test harness can mount this router unchanged; a
  // missing rejection log must never break a route.
  const logRejection = deps.logRejectionToFile || (() => {});
  const router = createAsyncRouter();
  const preCheckLimiter = validateImageLimiter ?? defaultValidateImageLimiter;
  const galleryImportLimiter = injectedGalleryImportLimiter ?? defaultGalleryImportLimiter;
  const previewLimiter = deps.disclosurePreviewLimiter ?? defaultDisclosurePreviewLimiter;
  // ── Cost guards, NOT the auth boundary ──────────────────────────────────────
  // These two run BEFORE multer on the upload routes below. multer reads the whole
  // multipart body into memory before any handler runs, so without them an anonymous
  // request made this single-instance process allocate 25MB x 6 files and only then
  // reach the in-handler check that tells it to sign in. genLimiter bounds the RATE of
  // those requests (60 per 5 min per IP), not the cost of one, and memory pressure is
  // concurrency-bound rather than rate-bound.
  //
  // They do NOT replace the in-handler check, which stays the authority: this runs
  // before req.body exists, so it can only see `Authorization: Bearer`, while the
  // handler sees the header AND the form field. A caller rejected here would have been
  // rejected there too — with the same status, code and message, which is why the
  // literal below is copied from the handler rather than reworded.
  const requireSessionBeforeUpload = (req, res, next) => {
    if (!getAuthUserFromRequest(req)) {
      return sendError(res, 401, 'Please sign in to stage images', { code: 'AUTH_REQUIRED' });
    }
    return next();
  };
  // requireProAccount writes its own 401/403 and returns null, so reusing it here makes
  // the pre-gate's reply byte-identical to the handler's by construction.
  const requireProBeforeUpload = (req, res, next) => (requireProAccount(req, res) ? next() : undefined);
  const stampLimiter = deps.stampImageLimiter ?? defaultStampImageLimiter;
  const downloadResultLimiter = deps.downloadResultLimiter ?? defaultDownloadResultLimiter;

// What the "Preview" hover in the staging modal shows: the user's chosen badge style and
// size, stamped onto a sample photo by the SAME code that will stamp their render. See
// lib/image/disclosure-preview.js for why this is drawn here rather than mocked in CSS,
// and why an unauthenticated renderer is safe.
//
// Unauthenticated on purpose. The controls it serves sit in a modal any visitor can open,
// and gating the preview behind sign-in would mean the one explanation of what the option
// does is missing for the people deciding whether to sign up. It renders nothing the
// visitor supplies: every input is snapped to a closed set before it reaches sharp.
router.get('/api/disclosure-preview', previewLimiter, async (req, res) => {
  const params = normalizePreviewParams(req.query);
  try {
    const image = await renderDisclosurePreview(params);
    // Short max-age rather than immutable: the URL carries the CONFIGURATION, not a build
    // id, so the same URL legitimately renders different bytes after a deploy that retunes
    // the badge. An hour kills the repeat traffic from dragging the slider without letting
    // a stale preview outlive a design change by a week.
    res.set('Cache-Control', 'public, max-age=3600');
    res.type(PREVIEW_CONTENT_TYPE);
    return res.send(image);
  } catch (error) {
    // A broken preview must never look like a broken FEATURE: the badge itself is fine, so
    // answer with a status the frontend can hide the popup on rather than an error card.
    return sendError(res, 500, 'Preview unavailable', { ref: reportError('staging.disclosure-preview', error) });
  }
});

// requireSessionBeforeUpload is a cost guard ahead of multer, not the gate — see its
// definition above. The check below stays the authority and is the one to read.
router.post('/api/process-image', genLimiter, requireSessionBeforeUpload, stagingProcessUpload, async (req, res) => {
  try {
    const sessionUser = getAuthUserFromRequest(req);

    if (!sessionUser) {
      return sendError(res, 401, 'Please sign in to stage images', { code: 'AUTH_REQUIRED' });
    }

    await handleVirtualStagingMultipart(req, res, {
      user: sessionUser,
      recordUsage: true,
      treatAsPro: false,
    });
  } catch (error) {
    // Guard headersSent, as the endpoint-key twin below already does. Both call the
    // same handleVirtualStagingMultipart, which answers the request itself on the
    // happy path and on its own 429 — so anything thrown AFTER that point reached a
    // sendError that threw ERR_HTTP_HEADERS_SENT, rejected the async handler, and
    // ended at Express's default handler, which destroys the socket. The client saw
    // a truncated response instead of the successful JSON it was already receiving.
    if (res.headersSent) return undefined;
    // A model that returned no image is an expected outcome with its own 422 and
    // code, not an internal failure — it gets no reference to quote. `error` may not
    // be an object (a thrown string would make `.code` a second TypeError here).
    if (error && /** @type {any} */ (error).code === 'NO_IMAGE_GENERATED') {
      logger.error('Error processing image:', error);
      return sendError(res, 422, 'This image couldn\'t be staged. Please try a different photo of an interior room.', {
        code: 'NO_IMAGE_GENERATED',
      });
    }
    // The disclosure stamp fails CLOSED (lib/image/stamp-disclosure.js), so the render
    // completed and was then withheld rather than shipped unlabelled. Say exactly that,
    // and offer the one action that gets the user their image — the alternative reads as
    // a random failure and they simply retry into the same wall. Still reported: this is
    // an environment/asset fault, so every occurrence should reach Sentry.
    if (error && /** @type {any} */ (error).code === 'DISCLOSURE_STAMP_FAILED') {
      return sendError(res, 500, 'We couldn\'t add the "virtually staged" label, so your image wasn\'t delivered. Untick that option to stage without it.', {
        code: 'DISCLOSURE_STAMP_FAILED',
        ref: reportError('staging.disclosure-stamp', error),
      });
    }
    return sendError(res, 500, 'Image processing failed', { ref: reportError('staging.process-image', error) });
  }
});

router.post('/api/validate-image', genLimiter, preCheckLimiter, async (req, res) => {
  try {
    // Signed-in only. Every accepted request spends a paid Gemini vision call, and
    // genLimiter is a per-IP ceiling — a cost cap, not an identity — so anonymously
    // this was free AI on rotating IPs. Nothing legitimate is lost: this is the
    // pre-flight for staging, and staging itself has always required an account
    // (/api/process-image 401s), so a caller who can't pass this gate could never
    // have used the verdict. Both studios already send the session token, and both
    // treat any non-2xx as "valid" (fail open), so a signed-out browser silently
    // skips the pre-check and still meets the real gate one request later.
    const preCheckUser = getAuthUserFromRequest(req);
    if (!preCheckUser) {
      return sendError(res, 401, 'Please sign in to stage images', { code: 'AUTH_REQUIRED' });
    }
    // Cheap prechecks before the paid call: reject a payload that cannot be a real
    // upload rather than paying Gemini to tell us so. Both studios treat any non-2xx
    // as "valid" (fail open), so neither refusal can block a legitimate upload.
    const { image } = req.body || {};
    if (!image || typeof image !== 'string' || !IMAGE_DATA_URL_RE.test(image)) {
      return sendError(res, 400, 'Image is required');
    }
    // base64 carries 3 bytes per 4 characters, so the encoded length bounds the
    // decoded size without decoding it first.
    if ((image.length - image.indexOf(',') - 1) * 0.75 > MAX_VALIDATE_IMAGE_BYTES) {
      return sendError(res, 413, 'Image is too large to pre-check');
    }
    // No "is a reviewer configured?" short-circuit here on purpose: this used to gate
    // on `openai`, which stopped being the reviewer's client when the grader moved to
    // Gemini — so an unset OPENAI key silently disabled a Gemini-powered check.
    // validateStageableImage already returns valid when its own client is missing, so
    // the route stays out of it rather than re-deriving which client is in play.
    let imageBuffer;
    try {
      imageBuffer = Buffer.from(image.slice(image.indexOf(',') + 1), 'base64');
      if (!imageBuffer || imageBuffer.length === 0) throw new Error('empty buffer');
    } catch {
      return sendError(res, 400, 'Invalid image data');
    }
    const { valid, code, reason } = await validateStageableImage(imageBuffer);
    if (!valid) {
      // The likeliest first-session abandonment there is: someone uploads the wrong
      // kind of photo, is told no, and leaves. Nothing recorded it, so it was
      // invisible in every funnel. Best-effort — a logging failure must not turn a
      // clean rejection into a 500.
      logRejection('unstageable', code || 'UNSTAGEABLE', reason || '', {
        email: preCheckUser.email, userId: preCheckUser.id, req,
      });
    }
    setSensitiveHeaders(res);
    // `code` is the stable category the client localizes; `reason` is the canonical
    // English copy, and doubles as the client's fallback until a translation exists.
    return res.json({ valid, code: valid ? null : code, reason: valid ? '' : reason });
  } catch (error) {
    logger.error('Error validating image:', error);
    // Fail open — never block a real upload because our check errored.
    return res.json({ valid: true, code: null, reason: '' });
  }
});

// requireProBeforeUpload is a cost guard ahead of multer, not the gate — see its
// definition above. The requireProAccount call below stays the authority.
router.post('/api/enhance-exterior', genLimiter, requireProBeforeUpload, stagingProcessUpload, async (req, res) => {
  try {
    // Stagify+ only, and this is the real gate — the Exterior Studio page reveals its
    // controls from JS, which is a UI affordance, not a boundary. requireProAccount
    // answers 401 AUTH_REQUIRED / 403 PRO_REQUIRED itself and returns null.
    const proUser = requireProAccount(req, res);
    if (!proUser) return undefined;

    await handleExteriorMultipart(req, res, proUser);
  } catch (error) {
    // Same headersSent guard as /api/process-image above, for the same reason: the
    // handler answers the request itself, so anything thrown after that point would
    // otherwise reach Express's default handler and destroy a socket mid-response.
    if (res.headersSent) return undefined;
    if (error && /** @type {any} */ (error).code === 'NO_IMAGE_GENERATED') {
      logger.error('Error enhancing exterior:', error);
      return sendError(res, 422, 'This photo couldn\'t be enhanced. Please try a different photo of the property exterior.', {
        code: 'NO_IMAGE_GENERATED',
      });
    }
    // Same fail-closed disclosure branch as /api/process-image, and it has to be repeated
    // here because this route has its own catch: the stamp throws rather than shipping an
    // unlabelled photo, so the render succeeded and was then WITHHELD. Without this branch
    // that arrives as "Exterior enhancement failed" — a generic fault, which the user
    // answers by retrying into the same wall forever. The one action that gets them their
    // photo is naming the option to untick.
    if (error && /** @type {any} */ (error).code === 'DISCLOSURE_STAMP_FAILED') {
      return sendError(res, 500, 'We couldn\'t add the "virtually staged" label, so your photo wasn\'t delivered. Untick that option to enhance without it.', {
        code: 'DISCLOSURE_STAMP_FAILED',
        ref: reportError('staging.disclosure-stamp', error),
      });
    }
    return sendError(res, 500, 'Exterior enhancement failed', { ref: reportError('staging.enhance-exterior', error) });
  }
});

router.post('/api/stage-by-endpoint-key', stagingEndpointKeyGuard, stagingProcessUpload, async (req, res) => {
  try {
    await handleVirtualStagingMultipart(req, res, {
      user: null,
      recordUsage: false,
      treatAsPro: true,
    });
  } catch (error) {
    const ref = reportError('staging.stage-by-endpoint-key', error);
    if (!res.headersSent) {
      // Same fail-closed disclosure branch as /api/process-image. A partner integration can
      // request the label too (it rides the same handler), so it needs the same distinct
      // code — otherwise a withheld-but-successful render is indistinguishable from a
      // generation failure and gets retried forever.
      if (error && /** @type {any} */ (error).code === 'DISCLOSURE_STAMP_FAILED') {
        return sendError(res, 500, 'We couldn\'t add the "virtually staged" label, so your image wasn\'t delivered. Retry without that option to stage without it.', {
          code: 'DISCLOSURE_STAMP_FAILED',
          ref,
        });
      }
      return sendError(res, 500, 'Image processing failed', { ref });
    }
  }
});

// The Masking Studio's "Looks Good" → a gallery entry. Mounted HERE rather than in
// routes/gallery.js on purpose: this router already owns every surface that produces
// pixels, already has genLimiter and requireProAccount, and gallery.js's own limiter is a
// page-listing budget rather than a byte budget.
//
// Named for the surface, not generically. The requirement is that the basic mask editor and
// the AI Designer's mask editor never write to the gallery, and an `/api/gallery-import`
// would be an open invitation to wire them up to it.
//
// TWO limiters: genLimiter for the session-wide budget and galleryImportLimiter for the
// bytes. See lib/http/rate-limiters.js for why this one endpoint earns its own ceiling.
//
// NOTE that `deps` here does NOT contain renderPersistence — handleMaskingSave arrives
// pre-built from server.js, exactly as handleExteriorMultipart does. That is what keeps
// createMaskEditHandler(deps) below structurally unable to reach the gallery.
router.post('/api/masking-studio/save', galleryImportLimiter, genLimiter, async (req, res) => {
  try {
    // Stagify+ only, and this is the real gate — the studio page reveals itself from JS,
    // which is a UI affordance and not a boundary.
    const proUser = requireProAccount(req, res);
    if (!proUser) return undefined;

    await handleMaskingSave(req, res, proUser);
  } catch (error) {
    if (res.headersSent) return undefined;
    return sendError(res, 500, 'Could not save that to your gallery', {
      ref: reportError('staging.masking-save', error),
    });
  }
});

// Burn the "virtually staged" disclosure into a finished image the CLIENT built.
//
// Every other user of stampVirtuallyStaged() reaches it from inside a render the server was
// already holding. Basic Mask cannot: it composites its result in the browser
// (compositeMaskedEdit in public/scripts/mask-core.js) and downloads that canvas directly,
// so the finished pixels exist nowhere else. Hence one round trip, at download time.
//
// It cannot be folded into /api/mask-edit either. That route returns the model's edit, which
// the browser then composites BACK over the untouched original everywhere outside the
// painted mask — a badge stamped there would be erased by the very next step unless the user
// happened to paint the bottom-right corner.
//
// Stamping and only stamping: nothing is stored, nothing is metered, no model is called. The
// response is the input with a badge on it, or an error — never the input unchanged. See
// lib/image/stamp-disclosure.js for why that module fails closed, and note the same
// reasoning applies with more force here, because the user has explicitly asked for the
// label and is about to save the file believing it carries one.
router.post('/api/stamp-image', stampLimiter, async (req, res) => {
  try {
    // Stagify+ only: this serves Basic Mask, which is itself Stagify+ only (the nav row is
    // locked and /api/mask-edit gates the same way). Answers 401/403 itself and returns null.
    const proUser = requireProAccount(req, res);
    if (!proUser) return undefined;

    const { image } = req.body || {};
    if (!isImageDataUrl(image)) {
      return sendError(res, 400, 'Image must be a base64 image data URL');
    }
    // Bound the decode from the ENCODED length, before a buffer exists for it — the same
    // 3-bytes-per-4-characters arithmetic /api/validate-image uses above.
    if ((image.length - image.indexOf(',') - 1) * 0.75 > MAX_STAMP_IMAGE_BYTES) {
      return sendError(res, 413, 'Image is too large to label');
    }

    // The SAME normalizer the preview route uses, so the badge the user approved in the
    // popover and the badge burned into their download are configured identically. Re-deriving
    // the allow-lists here is exactly how the two would drift.
    const params = normalizePreviewParams(req.body || {});
    const stamped = await stampVirtuallyStaged(image, params);

    // Invisible provenance metadata, layered on top of the visible badge above.
    // stampVirtuallyStaged() itself always emits an untagged PNG and is out of scope to
    // modify, so this is a second, cheap PNG-to-PNG pass. Best-effort, unlike the stamp
    // above: a failure here must not block delivery of an otherwise-correctly-labelled
    // image, so it falls back to the stamped-but-untagged bytes rather than failing closed.
    let output = stamped;
    try {
      const stampedBuffer = decodeImageDataUrl(stamped);
      const tagged = await withDisclosureMetadata(sharp(stampedBuffer), { mode: 'edited' }).png().toBuffer();
      output = `data:image/png;base64,${tagged.toString('base64')}`;
    } catch (error) {
      logger.warn('[staging] could not embed disclosure metadata on /api/stamp-image:', error);
    }

    setSensitiveHeaders(res);
    return res.json({ success: true, image: output });
  } catch (error) {
    if (res.headersSent) return undefined;
    // Distinct code, same contract as /api/process-image: the client must be able to tell
    // "we could not label it" from "the request failed", because only the first one has an
    // action attached — and it must never quietly save the unlabelled file instead.
    if (error && /** @type {any} */ (error).code === 'DISCLOSURE_STAMP_FAILED') {
      return sendError(res, 500, 'We couldn\'t add the "virtually staged" label, so your image wasn\'t delivered. Untick that option to download without it.', {
        code: 'DISCLOSURE_STAMP_FAILED',
        ref: reportError('staging.stamp-image', error),
      });
    }
    return sendError(res, 500, 'Could not label that image', {
      ref: reportError('staging.stamp-image', error),
    });
  }
});

// Server-side resize + re-encode of a finished staging result, for the homepage tool's
// download button and resolution menu (public/scripts/app/download-menu.js). Those used to
// resize entirely on <canvas> and export straight to JPEG — which meant nothing downloaded
// from that button could ever carry the invisible provenance metadata upscaleForDelivery()
// embeds server-side, because a browser canvas export has no concept of EXIF/XMP
// passthrough, full stop (see lib/image/output-metadata.js). Moving the resize here closes
// that gap for every resolution the menu offers, not just one.
//
// Same access level as /api/process-image, NOT /api/stamp-image: any signed-in session,
// free or Pro, since a user already had to sign in to stage the image being downloaded.
//
// FAILS OPEN on the client: download-menu.js falls back to its old client-side canvas path
// on any error from this route, so a hiccup here costs a user their metadata for one
// download, never the download itself — unlike the visible-stamp routes above, there is no
// DISCLOSURE_STAMP_FAILED-style distinguishable error to give the client, because there is
// nothing for the client to react to; it just retries the old way.
router.post('/api/download-result', downloadResultLimiter, async (req, res) => {
  try {
    const sessionUser = getAuthUserFromRequest(req);
    if (!sessionUser) {
      return sendError(res, 401, 'Please sign in to download', { code: 'AUTH_REQUIRED' });
    }

    const { image, width, height } = req.body || {};
    if (!isImageDataUrl(image)) {
      return sendError(res, 400, 'Image must be a base64 image data URL');
    }
    // Bound the decode from the ENCODED length, before a buffer exists for it — the same
    // pattern MAX_STAMP_IMAGE_BYTES uses above.
    if ((image.length - image.indexOf(',') - 1) * 0.75 > MAX_DOWNLOAD_RESULT_BYTES) {
      return sendError(res, 413, 'Image is too large to download');
    }
    const w = clampDownloadDim(width);
    const h = clampDownloadDim(height);
    if (!w || !h) {
      return sendError(res, 400, 'width and height must be positive integers');
    }

    const buffer = decodeImageDataUrl(image);
    // fit: 'fill' — an exact stretch to (w, h), matching what
    // ctx.drawImage(canvas, 0, 0, w, h) already did client-side. download-menu.js's own row
    // math (buildSizeRows) is what keeps w/h proportional; this route trusts that math the
    // same way the client did, rather than re-deriving an aspect ratio here.
    const out = await withDisclosureMetadata(
      sharp(buffer).resize(w, h, { fit: 'fill' }),
      { mode: 'staged' },
    ).jpeg({ quality: 92 }).toBuffer(); // 92 matches download-menu.js's JPEG_QUALITY (0.92)

    setSensitiveHeaders(res);
    return res.json({ success: true, image: `data:image/jpeg;base64,${out.toString('base64')}` });
  } catch (error) {
    if (res.headersSent) return undefined;
    return sendError(res, 500, 'Could not prepare that download', {
      ref: reportError('staging.download-result', error),
    });
  }
});

router.post('/api/mask-edit', genLimiter, createMaskEditHandler(deps));

router.post('/api/segment', genLimiter, createSegmentHandler(deps));

  return router;
}
