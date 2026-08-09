// staging routes, extracted verbatim from server.js.
import { createAsyncRouter } from '../lib/http/async-router.js';
import { sendError } from '../lib/http/http-helpers.js';
import { reportError } from '../lib/http/error-ref.js';
import { createMaskEditHandler } from '../lib/staging/mask-edit.js';
import { createSegmentHandler } from '../lib/staging/segment.js';
import { IMAGE_DATA_URL_RE } from '../lib/staging/data-url.js';
import { logger } from '../lib/logger.js';
import {
  validateImageLimiter as defaultValidateImageLimiter,
  galleryImportLimiter as defaultGalleryImportLimiter,
} from '../lib/http/rate-limiters.js';

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
 *   genLimiter as its only ceiling.
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

router.post('/api/process-image', genLimiter, stagingProcessUpload, async (req, res) => {
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

router.post('/api/enhance-exterior', genLimiter, stagingProcessUpload, async (req, res) => {
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

router.post('/api/mask-edit', genLimiter, createMaskEditHandler(deps));

router.post('/api/segment', genLimiter, createSegmentHandler(deps));

  return router;
}
