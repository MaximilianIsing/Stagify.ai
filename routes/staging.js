// staging routes, extracted verbatim from server.js.
import { createAsyncRouter } from '../lib/http/async-router.js';
import { sendError } from '../lib/http/http-helpers.js';
import { createMaskEditHandler } from '../lib/staging/mask-edit.js';
import { createSegmentHandler } from '../lib/staging/segment.js';
import { logger } from '../lib/logger.js';

/**
 * Build the virtual-staging router. `deps` is the full injection bag shared by
 * this router's inline handlers and the sibling handler factories
 * (mask-edit / segment), each of which destructures its own slice.
 *
 * @param {{
 *   genAI: { getGenerativeModel: (options: any) => any } | null,
 *   genLimiter: import('express').RequestHandler,
 *   stagingProcessUpload: import('express').RequestHandler,
 *   stagingEndpointKeyGuard: import('express').RequestHandler,
 *   setSensitiveHeaders: (res: import('express').Response) => void,
 *   getAuthUserFromRequest: (req: import('express').Request) => any,
 *   requireProAccount: (req: import('express').Request, res: import('express').Response) => any,
 *   enterpriseDomainForUser: ReturnType<typeof import('../lib/services/auth-helpers.js').createAuthHelpers>['enterpriseDomainForUser'],
 *   reportEnterpriseUsage: ReturnType<typeof import('../lib/services/auth-helpers.js').createAuthHelpers>['reportEnterpriseUsage'],
 *   validateStageableImage: (imageBuffer: Buffer) => Promise<{ valid: boolean, code: string | null, reason: string }>,
 *   handleVirtualStagingMultipart: (req: import('express').Request, res: import('express').Response, meta: import('../lib/types/staging.js').VirtualStagingMeta) => Promise<import('express').Response | void>,
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
 */
export default function createStagingRouter(deps) {
  // Names used by the handlers still inlined below. The /api/mask-edit and
  // /api/segment handlers are built by the sibling factories (which each
  // destructure their own slice of the full `deps`).
  const { genLimiter, stagingProcessUpload, setSensitiveHeaders, getAuthUserFromRequest, validateStageableImage, handleVirtualStagingMultipart, stagingEndpointKeyGuard } = deps;
  const router = createAsyncRouter();

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
    logger.error('Error processing image:', error);
    if (error.code === 'NO_IMAGE_GENERATED') {
      return sendError(res, 422, 'This image couldn\'t be staged. Please try a different photo of an interior room.', {
        code: 'NO_IMAGE_GENERATED',
      });
    }
    return sendError(res, 500, 'Image processing failed', { details: error.message });
  }
});

router.post('/api/validate-image', genLimiter, async (req, res) => {
  try {
    const { image } = req.body || {};
    if (!image || typeof image !== 'string' || !image.includes(',')) {
      return sendError(res, 400, 'Image is required');
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

router.post('/api/stage-by-endpoint-key', stagingEndpointKeyGuard, stagingProcessUpload, async (req, res) => {
  try {
    await handleVirtualStagingMultipart(req, res, {
      user: null,
      recordUsage: false,
      treatAsPro: true,
    });
  } catch (error) {
    logger.error('Error in stage-by-endpoint-key:', error);
    if (!res.headersSent) {
      return sendError(res, 500, 'Image processing failed', { details: error.message });
    }
  }
});

router.post('/api/mask-edit', genLimiter, createMaskEditHandler(deps));

router.post('/api/segment', genLimiter, createSegmentHandler(deps));

  return router;
}
