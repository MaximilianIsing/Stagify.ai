// POST /api/mask-edit request pipeline, extracted verbatim from
// routes/staging.js. Decodes the image + mask, resizes the mask to the image,
// builds the translucent-magenta locator overlay (buildMarkedRoomImage, B/W
// fallback), assembles the enhancedPrompt + locator cues, letterboxes an
// optional reference image to the room aspect ratio, runs the quality-retry
// loop (normalizeMaskOutputToRoom + compositeForReview + reviewMaskEdit),
// meters enterprise usage, writes the CSV log, and shapes the JSON response.
// The genLimiter middleware stays in the route registration.
//
// CRITICAL: deps.generateWithQualityRetry here uses the POSITIONAL server.js
// signature (generateOnce, label, onImageProduced, reviewFn, maxAttempts) — NOT
// the options-object signature of lib/staging/staging-pipeline.js. The call is
// copied verbatim; do not "reconcile" it.
//
// deps: { genAI, requireProAccount, MAX_MASK_PROMPT_LENGTH, QUALITY_MAX_ATTEMPTS,
//         DEBUG_MODE, downscaleImage, padBufferToAspectRatio, buildMarkedRoomImage,
//         normalizeMaskOutputToRoom, reviewMaskEdit, compositeForReview,
//         generateWithQualityRetry, maskReferencePromptSuffix, logMaskEditToFile,
//         getUserIdentifier, enterpriseDomainForUser, reportEnterpriseUsage }
import sharp from 'sharp';
import { sendError } from '../http/http-helpers.js';
import { logger } from '../logger.js';

/**
 * Build the POST /api/mask-edit Express handler bound to the injected AI client, image
 * helpers, and quality-retry loop. Decodes the image + mask, builds the magenta locator
 * overlay, runs the mask-edit quality-retry loop, meters enterprise usage, logs, and shapes
 * the JSON response.
 * @param {{ genAI: { getGenerativeModel: (options: any) => any } | null, requireProAccount: (req: import('express').Request, res: import('express').Response) => any, MAX_MASK_PROMPT_LENGTH: number, QUALITY_MAX_ATTEMPTS: number, DEBUG_MODE: boolean, downscaleImage: typeof import('../image/image-primitives.js').downscaleImage, padBufferToAspectRatio: typeof import('../image/image-primitives.js').padBufferToAspectRatio, buildMarkedRoomImage: typeof import('../image/image-primitives.js').buildMarkedRoomImage, normalizeMaskOutputToRoom: typeof import('../image/image-primitives.js').normalizeMaskOutputToRoom, reviewMaskEdit: ReturnType<typeof import('../image/image-review.js').createImageReview>['reviewMaskEdit'], compositeForReview: typeof import('../image/image-primitives.js').compositeForReview, generateWithQualityRetry: ReturnType<typeof import('./staging-generation.js').createStagingGeneration>['generateWithQualityRetry'], maskReferencePromptSuffix: typeof import('./prompts.js').maskReferencePromptSuffix, logMaskEditToFile: ReturnType<typeof import('../services/logging.js').createLogging>['logMaskEditToFile'], getUserIdentifier: typeof import('../http/http-helpers.js').getUserIdentifier, enterpriseDomainForUser: ReturnType<typeof import('../services/auth-helpers.js').createAuthHelpers>['enterpriseDomainForUser'], reportEnterpriseUsage: ReturnType<typeof import('../services/auth-helpers.js').createAuthHelpers>['reportEnterpriseUsage'] }} deps - Injected AI client, pro gate, limits, image helpers, the POSITIONAL-signature generateWithQualityRetry, prompt-suffix + CSV-logging helpers, and enterprise-usage metering.
 * @returns {(req: import('express').Request, res: import('express').Response) => Promise<import('express').Response | void>} The POST /api/mask-edit Express handler.
 */
export function createMaskEditHandler(deps) {
  const {
    genAI,
    requireProAccount,
    MAX_MASK_PROMPT_LENGTH,
    QUALITY_MAX_ATTEMPTS,
    DEBUG_MODE,
    downscaleImage,
    padBufferToAspectRatio,
    buildMarkedRoomImage,
    normalizeMaskOutputToRoom,
    reviewMaskEdit,
    compositeForReview,
    generateWithQualityRetry,
    maskReferencePromptSuffix,
    logMaskEditToFile,
    getUserIdentifier,
    enterpriseDomainForUser,
    reportEnterpriseUsage,
  } = deps;

  return async (req, res) => {
    try {
      const proUser = requireProAccount(req, res);
      if (!proUser) return;

      if (!genAI) {
        return sendError(res, 500, 'AI service not properly configured');
      }

      const { image, mask, prompt, model, referenceImage, seed, batch } = req.body;

      const trimmedPrompt = typeof prompt === 'string' ? prompt.trim() : '';
      if (!image || !mask || !trimmedPrompt) {
        return sendError(res, 400, 'Image, mask, and prompt are required');
      }
      if (trimmedPrompt.length > MAX_MASK_PROMPT_LENGTH) {
        return sendError(res, 400, `Prompt is too long (max ${MAX_MASK_PROMPT_LENGTH} characters)`);
      }

      // Optional reproducibility seed — passed through to Gemini best-effort (the
      // image models make no determinism promise, but the request accepts it).
      // `batch` is the multi-area client's hint of how many sibling requests this
      // click fanned out into; big batches get a trimmed quality-retry budget so
      // one click can't cascade into batch × 3 Gemini generations.
      // Wrap into int32 range — Gemini rejects seeds outside [0, 2^31-1], and the
      // per-attempt +1 shift below must not overflow either.
      const seedBase = Number.isInteger(seed)
        ? ((seed % 0x7fffffff) + 0x7fffffff) % 0x7fffffff
        : null;
      const batchSize = Number.isInteger(batch) ? Math.max(1, Math.min(6, batch)) : 1;
      const maxQualityAttempts = batchSize >= 3 ? 2 : QUALITY_MAX_ATTEMPTS;

      // Get model from request or default to fast model
      const selectedModel = model || 'gpt-4o-mini';
      // Masking always uses the 2.5-flash image model regardless of selected tier
      const geminiModel = 'gemini-2.5-flash-image';

      // Convert base64 data URLs to buffers
      const imageDataUrl = image.split(',');
      const maskDataUrl = mask.split(',');

      /** @type {Buffer} */
      let imageBuffer = Buffer.from(imageDataUrl[1], 'base64');
      let maskBuffer = Buffer.from(maskDataUrl[1], 'base64');

      // Downscale image if needed (Gemini has size limits)
      imageBuffer = await downscaleImage(imageBuffer);
      const imageBase64 = imageBuffer.toString('base64');

      // Process mask to match image size
      const imageMetadata = await sharp(imageBuffer).metadata();
      const maskMetadata = await sharp(maskBuffer).metadata();
      // sharp types width/height as optional; a room image without real dimensions
      // can't be mask-edited. Pin them to non-null locals once (property narrowing
      // wouldn't survive the awaits below) so every downstream call gets a number.
      if (imageMetadata.width == null || imageMetadata.height == null) {
        throw new Error('[Mask Edit] Could not read room image dimensions');
      }
      const roomWidth = imageMetadata.width;
      const roomHeight = imageMetadata.height;

      // Resize mask to match image dimensions exactly
      const resizedMaskBuffer = await sharp(maskBuffer)
        .resize(roomWidth, roomHeight, {
          fit: 'fill'
        })
        .png()
        .toBuffer();

      const maskBase64 = resizedMaskBuffer.toString('base64');

      if (DEBUG_MODE) {
        logger.debug('[Mask Edit] Processing masked image edit with Gemini');
        logger.debug('[Mask Edit] Prompt:', trimmedPrompt);
        logger.debug('[Mask Edit] Image size:', roomWidth, 'x', roomHeight);
        logger.debug('[Mask Edit] Mask size:', maskMetadata.width, 'x', maskMetadata.height, '(resized to match image)');
      }

      // LOCATION CUE: instead of a separate B/W mask (which Gemini aligns to the room
      // poorly), hand it the SAME room with the target area highlighted in translucent
      // magenta. Gemini generates from the clean room (image 1) and uses the highlighted
      // copy (image 2) only to see WHERE to apply the edit — much stronger spatial
      // grounding. Falls back to the plain B/W mask if the overlay can't be built.
      let locatorBase64 = maskBase64;
      let locatorMarked = false;
      try {
        const markedRoom = await buildMarkedRoomImage(imageBuffer, resizedMaskBuffer, roomWidth, roomHeight);
        locatorBase64 = markedRoom.toString('base64');
        locatorMarked = true;
      } catch (markErr) {
        logger.warn('[Mask Edit] Could not build highlighted room; falling back to B/W mask:', markErr.message);
      }
      const loc = locatorMarked
        ? { second: 'the SAME room with the target area OUTLINED by a bright magenta line', region: 'the area inside the magenta outline', boundary: 'the magenta outline', guide: ' The magenta outline ONLY marks the boundary of where to edit — it is NOT part of the room. Do NOT draw the magenta line, and NEVER fill any area with magenta or paint a magenta patch, anywhere in your output.' }
        : { second: 'a white mask marking the area to change', region: 'the white masked region', boundary: 'the white boundary', guide: '' };

      // Enhance the prompt to ensure only the masked area is edited
      let enhancedPrompt = `${trimmedPrompt}. CRITICAL INSTRUCTIONS: The FIRST image is the room to edit — produce your result as an edited version of that exact photo. The SECOND image is ${loc.second}, showing you EXACTLY where to apply the change.${loc.guide} Make the requested change ONLY inside ${loc.region}, and do NOT change anything outside it. Preserve the exact room layout, all furniture positions, wall colors, windows, doors, flooring, lighting, and every other detail exactly as they appear in the first image. Within ${loc.region}, make ONLY the change described — do NOT erase, delete, or strip out existing furniture, fixtures, windows, decor, or architectural features unless the instruction explicitly asks you to remove them, and never leave a blank wall, empty floor, or featureless void where content existed. The edit must blend seamlessly with the unchanged surroundings. Do NOT change the image aspect ratio, canvas size, orientation, or framing — the output must match the first image's dimensions exactly. WHEN THE INSTRUCTION ADDS OR PLACES A NEW OBJECT (furniture, decor, a fixture, a plant, lighting, etc.): the ENTIRE object — including its legs, arms, back, any overhang, and its contact shadow — MUST fit COMPLETELY INSIDE ${loc.region}, leaving a small margin between the object and ${loc.boundary}. SCALE THE OBJECT DOWN as much as needed so it sits fully within ${loc.region} — a smaller, fully-contained object is REQUIRED. NEVER let any part of the object reach, touch, or cross ${loc.boundary}: anything outside that area is discarded, so an object that extends past it will look cut off, sliced, or faded. Center and size the object so none of it is clipped and it reads as a complete, naturally placed item placed in the exact spot you were shown.`;

      let referenceInline = null;
      if (referenceImage && typeof referenceImage === 'string' && referenceImage.includes(',')) {
        logger.info('[Mask Edit] Reference photo received from client');
        try {
          const refB64 = referenceImage.slice(referenceImage.indexOf(',') + 1);
          // Typed as the general `Buffer` (ArrayBufferLike) so sharp's `.toBuffer()` result,
          // which is `Buffer<ArrayBufferLike>`, can be reassigned without a generic mismatch.
          /** @type {Buffer} */
          let refBuffer = Buffer.from(refB64, 'base64');
          if (!refBuffer || refBuffer.length === 0) throw new Error('empty reference buffer');
          refBuffer = await downscaleImage(refBuffer);
          // Normalize to PNG so the bytes ALWAYS match the declared MIME (downscaleImage
          // may have re-encoded to JPEG) and the format is one Gemini reliably accepts.
          // PNG preserves any transparency — a cut-out furniture reference is the cleanest
          // possible subject. This sharp pass also validates the payload is a real,
          // decodable image — if it isn't, it throws and we continue without a reference.
          refBuffer = await sharp(refBuffer).png().toBuffer();
          let refMeta = await sharp(refBuffer).metadata();
          // Letterbox the reference to the ROOM's aspect ratio with transparent
          // padding, so EVERY image sent to Gemini (room, highlighted room, reference) shares one
          // aspect ratio. Mixed input aspect ratios make the model emit its output at
          // a different aspect ratio; that output can't be composited back onto the
          // original, so the inserted furniture ends up mis-scaled and "doesn't fit".
          try {
            const roomAR = roomWidth / roomHeight;
            const padded = await padBufferToAspectRatio(refBuffer, roomAR);
            if (padded.padded) {
              refBuffer = padded.buffer;
              refMeta = await sharp(refBuffer).metadata();
            }
          } catch (padErr) {
            logger.warn('[Mask Edit] Reference aspect-ratio match failed; sending reference as-is:', padErr.message);
          }
          referenceInline = { mimeType: 'image/png', data: refBuffer.toString('base64') };
          enhancedPrompt += maskReferencePromptSuffix();
          logger.info(
            `[Mask Edit] Reference photo attached for Gemini — ${refMeta.width || '?'}×${refMeta.height || '?'} png, matched to room AR ${roomWidth}×${roomHeight} (${Math.round(refBuffer.length / 1024)} KB)`
          );
        } catch (refErr) {
          referenceInline = null;
          logger.warn('[Mask Edit] Reference photo received but failed to process; continuing without it:', refErr.message);
        }
      } else if (referenceImage) {
        logger.warn('[Mask Edit] referenceImage field present but invalid (expected data URL string)');
      }

      // Build the prompt with image and mask
      const geminiPrompt = [
        {
          text: enhancedPrompt
        },
        {
          inlineData: {
            mimeType: "image/png",
            data: imageBase64,
          },
        },
        {
          inlineData: {
            mimeType: "image/png",
            data: locatorBase64,
          },
        },
      ];
      if (referenceInline) {
        geminiPrompt.push({ inlineData: referenceInline });
      }

      if (DEBUG_MODE) {
        logger.debug('[Mask Edit] Using Gemini model:', geminiModel, '(selected model:', selectedModel, ')');
        logger.debug('[Mask Edit] Gemini input parts:', geminiPrompt.length, '(text + room + ' + (locatorMarked ? 'highlighted-room' : 'mask') + (referenceInline ? ' + reference)' : ')'));
      }

      // Generate with the same GPT-vision quality gate the main staging uses, but
      // with a mask-aware reviewer that also rejects edits which removed too much.
      // Review each result, regenerate on obvious mistakes, up to 3 attempts total,
      // returning the first perfect result or the best-scoring one.
      const originalForReview = `data:image/png;base64,${imageBase64}`;
      let maskGenerations = 0;
      const editedImageDataUrl = await generateWithQualityRetry(async (attempt) => {
        // Seed shifts per attempt: if a quality retry fires, an identical seed
        // would just re-court the same rejected output.
        const modelInstance = genAI.getGenerativeModel({
          model: geminiModel,
          ...(seedBase !== null ? { generationConfig: { seed: (seedBase + attempt - 1) % 0x7fffffff } } : {}),
        });
        const result = await modelInstance.generateContent(geminiPrompt);
        const response = await result.response;

        if (!response || !response.candidates || response.candidates.length === 0) {
          throw new Error('Gemini processing failed - no results generated');
        }

        for (const part of response.candidates[0].content.parts) {
          if (part.inlineData) {
            // Lock the output to the room's aspect ratio before it reaches the client
            // composite (which stretches it onto the original canvas) — otherwise a
            // drifted AR warps the edit out of alignment with the surroundings.
            return await normalizeMaskOutputToRoom(part.inlineData.data, roomWidth, roomHeight);
          }
        }

        throw new Error('No image data in Gemini response');
      }, 'mask-edit', () => {
        // Meter every attempt (initial + quality-gate retries) for enterprise usage.
        maskGenerations += 1;
      }, async (editedUrl) => {
        // Review the COMBINED result (original + edit composited through the mask),
        // i.e. what the user actually gets — so outside-mask drift never causes a
        // false reject and the "removed too much" check reflects the real outcome.
        const combined = await compositeForReview(
          imageBuffer, resizedMaskBuffer, editedUrl, roomWidth, roomHeight
        );
        return reviewMaskEdit(originalForReview, combined, {
          instruction: trimmedPrompt,
          locatorDataUrl: `data:image/png;base64,${locatorBase64}`,
          locatorMarked,
          referenceDataUrl: referenceInline ? `data:${referenceInline.mimeType};base64,${referenceInline.data}` : null,
        });
      }, maxQualityAttempts);

      if (DEBUG_MODE) {
        logger.debug('[Mask Edit] Successfully generated edited image with Gemini');
        try {
          const outMeta = await sharp(Buffer.from(editedImageDataUrl.split(',')[1], 'base64')).metadata();
          logger.debug(`[Mask Edit] Model output ${outMeta.width}×${outMeta.height} vs room ${roomWidth}×${roomHeight}${referenceInline ? ' (reference used)' : ''}`);
        } catch { /* debug-only metadata; ignore logging failures */ }
      }

      // Log the mask edit request
      const userId = getUserIdentifier(req);
      logMaskEditToFile(trimmedPrompt, selectedModel, geminiModel, roomWidth, roomHeight, userId, req);

      const entDomain = enterpriseDomainForUser(proUser);
      if (entDomain) {
        reportEnterpriseUsage(entDomain, maskGenerations || 1);
      }

      return res.json({
        success: true,
        editedImage: editedImageDataUrl,
        referenceUsed: Boolean(referenceInline),
      });

    } catch (error) {
      logger.error('Error processing mask edit:', error);
      return sendError(res, 500, 'Failed to process masked edit', { details: error.message });
    }
  };
}
