// Gemini image-generation pipeline, lifted out of the composition root
// (server.js): the quality-gate retry wrapper plus the two generators
// (text-to-image and virtual staging). Instantiated with this server's AI
// clients + reviewers.
//
// deps: { genAI, DEBUG_MODE, runQualityRetry, reviewImageQuality,
//         QUALITY_MAX_ATTEMPTS, logPromptToFile }
//   - runQualityRetry: the options-object generateWithQualityRetry export from
//     ./staging-pipeline.js (the retry/quality logic, unit-testable without real
//     model calls). This module wraps it back into the POSITIONAL signature the
//     routers depend on.
import sharp from 'sharp';
import { logger } from '../logger.js';
import { downscaleImage, enforceAspectRatio, padBufferToAspectRatio } from '../image/image-primitives.js';
import { generatePrompt, styleReferencePromptSuffix, furnitureReferencePromptSuffix } from './prompts.js';
import { normalizeFurnitureBuffers } from './staging-pipeline.js';

export function createStagingGeneration(deps) {
  const { genAI, DEBUG_MODE, runQualityRetry, reviewImageQuality, QUALITY_MAX_ATTEMPTS, logPromptToFile } = deps;

  // Run an image-producing function up to QUALITY_MAX_ATTEMPTS times, returning the
  // first "perfect" result or, failing that, the highest-scoring one.
  // `generateOnce(attempt)` must resolve to a data-URL string (or throw).
  // `onImageProduced(attempt)` (optional) fires once for every attempt that
  // actually yields an image — used to meter billing per generation attempt
  // (including quality-gate retries).
  // Thin wrapper binding this server's defaults (DEBUG_MODE, the reviewImageQuality
  // reviewer, QUALITY_MAX_ATTEMPTS). The retry/quality logic itself lives in
  // lib/staging/staging-pipeline.js so it can be unit-tested without real model calls. The
  // signature is unchanged, so all call sites and the router deps stay identical.
  async function generateWithQualityRetry(generateOnce, label = 'image', onImageProduced = null, reviewFn = null, maxAttempts = QUALITY_MAX_ATTEMPTS) {
    return runQualityRetry(generateOnce, {
      label,
      onImageProduced,
      reviewFn: reviewFn || reviewImageQuality,
      maxAttempts,
      debug: DEBUG_MODE,
    });
  }

  async function processImageGeneration(prompt, req, geminiModel = 'gemini-2.5-flash-image') {
    try {
      if (!genAI) {
        throw new Error('Gemini AI service not properly configured');
      }

      if (DEBUG_MODE) {
        logger.debug(`[Image Generation] Generating image with prompt: "${prompt}"`);
        logger.debug(`[Image Generation] Using Gemini model: ${geminiModel}`);
      }

      // Use Gemini's image generation model (text-to-image, no input image needed)
      const model = genAI.getGenerativeModel({ model: geminiModel });

      // For text-to-image generation, we only send the text prompt
      const fullPrompt = `${prompt}

Composition: frame the full scene naturally, keeping ceilings, floors, walls, and the key subject matter completely in view (use a tight crop or close-up ONLY if the user explicitly requested one).`;
      const generatePrompt = [
        { text: fullPrompt }
      ];

      // Generate, with the self-check quality gate retrying poor results.
      return await generateWithQualityRetry(async () => {
        const result = await model.generateContent(generatePrompt);
        const response = await result.response;

        if (!response || !response.candidates || response.candidates.length === 0) {
          throw new Error('Image generation failed - no results generated');
        }

        for (const part of response.candidates[0].content.parts) {
          if (part.inlineData) {
            if (DEBUG_MODE) {
              logger.debug(`[Image Generation] Successfully generated image`);
            }
            return `data:image/png;base64,${part.inlineData.data}`;
          }
        }

        throw new Error('No image data in AI response');
      }, 'generation', null, (url) => reviewImageQuality(url, { instruction: prompt }));
    } catch (error) {
      logger.error('Error generating image:', error);
      throw error;
    }
  }

  async function processStaging(imageBuffer, stagingParams, req, furnitureImageBuffer = null, geminiModel = 'gemini-2.5-flash-image') {
    try {
      if (!genAI) {
        throw new Error('AI service not properly configured');
      }

      const processedImageBuffer = await downscaleImage(imageBuffer);
      const base64Image = processedImageBuffer.toString("base64");

      // Source aspect ratio: used to letterbox furniture refs to the room's shape
      // (below) and to lock the output back to it after generation (Gemini drifts).
      const srcMeta = await sharp(imageBuffer).metadata().catch(() => null);
      const roomAR = srcMeta && srcMeta.width && srcMeta.height ? srcMeta.width / srcMeta.height : null;

      // Typed as the SDK's Part[] so the mixed text/inlineData parts match
      // generateContent()'s `(string | Part)[]` parameter (union-array inference alone
      // doesn't line up with Part's discriminated members).
      /** @type {Array<import('@google/generative-ai').Part>} */
      const prompt = [
        { text: generatePrompt(
          stagingParams.roomType,
          stagingParams.furnitureStyle,
          stagingParams.additionalPrompt,
          stagingParams.removeFurniture
        ) },
        {
          inlineData: {
            mimeType: "image/jpeg",
            data: base64Image,
          },
        },
      ];

      const furnitureBuffers = normalizeFurnitureBuffers(furnitureImageBuffer);
      let anyReferencePadded = false;
      for (const buf of furnitureBuffers) {
        const processedFurnitureBuffer = await downscaleImage(buf);
        // Letterbox the reference to the room's aspect ratio (transparent margins) so
        // its shape can't pull Gemini's output off the room's AR — same technique the
        // mask editor uses. No-op when the shapes already match; falls back to the
        // plain JPEG on any error so staging never breaks.
        let refBuf = processedFurnitureBuffer;
        let refMime = "image/jpeg";
        if (roomAR) {
          try {
            const padded = await padBufferToAspectRatio(processedFurnitureBuffer, roomAR, 0.02);
            if (padded.padded) {
              refBuf = padded.buffer;
              refMime = "image/png";
              anyReferencePadded = true;
            }
          } catch (padErr) {
            if (DEBUG_MODE) logger.warn('[Staging] Furniture aspect-ratio match failed; sending as-is:', padErr.message);
          }
        }
        prompt.push({
          inlineData: {
            mimeType: refMime,
            data: refBuf.toString("base64"),
          },
        });
      }
      if (furnitureBuffers.length > 0) {
        // Same extra-image plumbing serves both furniture references and style
        // references — only the instruction differs.
        prompt[0].text += stagingParams.styleReference
          ? styleReferencePromptSuffix(furnitureBuffers.length)
          : furnitureReferencePromptSuffix(
              furnitureBuffers.length,
              Boolean(stagingParams.preserveExistingStaging)
            );
        if (DEBUG_MODE) {
          logger.debug(`[Staging] Including ${furnitureBuffers.length} ${stagingParams.styleReference ? 'style' : 'furniture'} reference image(s) in staging request`);
        }
        if (anyReferencePadded) {
          prompt[0].text += '\n\nNOTE ON REFERENCE IMAGES: One or more reference images have transparent/empty padding added around them to match the room\'s shape. Ignore that empty padding entirely — use only the actual furniture/subject shown, and scale it naturally within the room.';
        }
      }

      // Log prompt to file
      logPromptToFile(
        prompt[0].text,
        stagingParams.roomType,
        stagingParams.furnitureStyle,
        stagingParams.additionalPrompt,
        stagingParams.removeFurniture,
        req?.body?.userRole || 'unknown',
        req?.body?.userReferralSource || 'unknown',
        req?.body?.authenticatedEmail || req?.body?.userEmail || 'unknown',
        req
      );

      if (DEBUG_MODE) {
        logger.debug(`[Staging] Using Gemini model: ${geminiModel}`);
      }
      const model = genAI.getGenerativeModel({ model: geminiModel });

      // Furniture references to also show the QA reviewer (so it knows what was meant
      // to be added). Re-encode to JPEG so the data-URL MIME is always correct.
      const furnitureReviewUrls = [];
      for (const fb of furnitureBuffers) {
        try { furnitureReviewUrls.push(`data:image/jpeg;base64,${(await sharp(fb).jpeg().toBuffer()).toString('base64')}`); } catch { /* skip a furniture ref that fails to encode */ }
      }

      // Generate, with the self-check quality gate retrying poor results.
      const resultDataUrl = await generateWithQualityRetry(async () => {
        const result = await model.generateContent(prompt);
        const response = await result.response;

        if (!response || !response.candidates || response.candidates.length === 0) {
          throw new Error('AI processing failed - no results generated');
        }

        for (const part of response.candidates[0].content.parts) {
          if (part.inlineData) {
            return `data:image/png;base64,${part.inlineData.data}`;
          }
        }

        const noImageErr = /** @type {Error & { code?: string }} */ (new Error('No image data in AI response'));
        noImageErr.code = 'NO_IMAGE_GENERATED';
        throw noImageErr;
      }, 'staging', () => {
        // Meter every staging generation attempt (initial + quality-gate retries)
        // so enterprise usage is billed per generated image. Furniture erases run
        // outside this path and are intentionally NOT counted.
        if (req) req._stagingGenerations = (req._stagingGenerations || 0) + 1;
      }, (url) => reviewImageQuality(url, {
        instruction: (stagingParams.additionalPrompt && stagingParams.additionalPrompt.trim())
          ? stagingParams.additionalPrompt.trim()
          : `Stage this ${stagingParams.roomType || 'room'} professionally`,
        furnitureDataUrls: furnitureReviewUrls,
      }));

      // Lock the result to the source aspect ratio (crop excess, centered).
      if (srcMeta && srcMeta.width && srcMeta.height) {
        const m = /^data:image\/\w+;base64,(.+)$/.exec(resultDataUrl);
        if (m) {
          const fixed = await enforceAspectRatio(
            Buffer.from(m[1], 'base64'),
            srcMeta.width,
            srcMeta.height
          );
          return `data:image/png;base64,${fixed.toString('base64')}`;
        }
      }
      return resultDataUrl;
    } catch (error) {
      logger.error('Error processing staging:', error);
      throw error;
    }
  }

  return { generateWithQualityRetry, processImageGeneration, processStaging };
}
