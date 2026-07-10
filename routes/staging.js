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
 *   genAI: { getGenerativeModel: (options: any) => any },
 *   openai: import('openai').default | null,
 *   genLimiter: import('express').RequestHandler,
 *   stagingProcessUpload: import('express').RequestHandler,
 *   stagingEndpointKeyGuard: import('express').RequestHandler,
 *   setSensitiveHeaders: (res: import('express').Response) => void,
 *   getAuthUserFromRequest: (req: import('express').Request) => any,
 *   getUserIdentifier: (req: import('express').Request) => string,
 *   requireProAccount: (req: import('express').Request, res: import('express').Response) => any,
 *   enterpriseDomainForUser: Function,
 *   reportEnterpriseUsage: Function,
 *   validateStageableImage: (imageBuffer: Buffer) => Promise<{ valid: boolean, reason: string }>,
 *   handleVirtualStagingMultipart: (req: import('express').Request, res: import('express').Response, meta: import('../lib/types/staging.js').VirtualStagingMeta) => Promise<import('express').Response | void>,
 *   downscaleImage: Function,
 *   padBufferToAspectRatio: Function,
 *   buildMarkedRoomImage: Function,
 *   normalizeMaskOutputToRoom: Function,
 *   compositeForReview: Function,
 *   reviewMaskEdit: Function,
 *   generateWithQualityRetry: Function,
 *   maskReferencePromptSuffix: Function,
 *   logMaskEditToFile: Function,
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
  const { openai, genLimiter, stagingProcessUpload, setSensitiveHeaders, getAuthUserFromRequest, validateStageableImage, handleVirtualStagingMultipart, stagingEndpointKeyGuard } = deps;
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
    // No reviewer configured → nothing to validate against, let it through.
    if (!openai) {
      return res.json({ valid: true, reason: '' });
    }
    let imageBuffer;
    try {
      imageBuffer = Buffer.from(image.slice(image.indexOf(',') + 1), 'base64');
      if (!imageBuffer || imageBuffer.length === 0) throw new Error('empty buffer');
    } catch {
      return sendError(res, 400, 'Invalid image data');
    }
    const { valid, reason } = await validateStageableImage(imageBuffer);
    setSensitiveHeaders(res);
    return res.json({ valid, reason: valid ? '' : reason });
  } catch (error) {
    logger.error('Error validating image:', error);
    // Fail open — never block a real upload because our check errored.
    return res.json({ valid: true, reason: '' });
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
