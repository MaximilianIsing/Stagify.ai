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
import { downscaleImage, padBufferToAspectRatio, orientedDimensions, upscaleForDelivery, nearestGeminiAspectRatio, cropToAspectRatio } from '../image/image-primitives.js';
import { stampVirtuallyStaged } from '../image/stamp-disclosure.js';
import { generatePrompt, styleReferencePromptSuffix, furnitureReferencePromptSuffix, qualityRetryFeedbackSuffix } from './prompts.js';
import { normalizeFurnitureBuffers } from './staging-pipeline.js';

/**
 * Build the Gemini image-generation API (quality-gate retry wrapper plus the text-to-image
 * and virtual-staging generators) bound to this server's AI clients and reviewers.
 * @param {{ genAI: { getGenerativeModel: (options: any) => any } | null, DEBUG_MODE: boolean, runQualityRetry: typeof import('./staging-pipeline.js').generateWithQualityRetry, reviewImageQuality: ReturnType<typeof import('../image/image-review.js').createImageReview>['reviewImageQuality'], QUALITY_MAX_ATTEMPTS: number, logPromptToFile: ReturnType<typeof import('../services/logging.js').createLogging>['logPromptToFile'] }} deps - Injected Gemini client, debug flag, the options-object generateWithQualityRetry (runQualityRetry), the quality reviewer, the attempt cap, and the CSV prompt logger.
 * @returns {{ generateWithQualityRetry: (generateOnce: (attempt: number) => Promise<string>, label?: string, onImageProduced?: ((attempt: number) => void) | null, reviewFn?: Function | null, maxAttempts?: number) => Promise<any>, processImageGeneration: (prompt: string, req: import('express').Request, geminiModel?: string) => Promise<any>, processStaging: (imageBuffer: Buffer, stagingParams: import('../types/staging.js').StagingParams, req: import('express').Request, furnitureImageBuffer?: Buffer | Buffer[] | null, geminiModel?: string) => Promise<any> }} The staging-generation API.
 */
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
  /**
   * Run an image-producing function up to maxAttempts times, returning the first "perfect"
   * result or the highest-scoring one. Thin wrapper binding this server's defaults onto the
   * options-object retry logic in staging-pipeline.js (keeps the POSITIONAL signature).
   * @param {(attempt: number) => Promise<string>} generateOnce - Produces a data-URL image for the given attempt (or throws).
   * @param {string} [label='image'] - Label used in diagnostic logging.
   * @param {((attempt: number) => void) | null} [onImageProduced=null] - Fires once per attempt that yields an image (used to meter per-attempt billing).
   * @param {((url: string) => Promise<import('../types/image.js').ImageReviewResult>) | null} [reviewFn=null] - Quality reviewer; defaults to the injected reviewImageQuality.
   * @param {number} [maxAttempts=QUALITY_MAX_ATTEMPTS] - Max attempts before returning the best-scoring result.
   * @param {((attempt: number, review: import('../types/image.js').ImageReviewResult) => void) | null} [onReviewDegraded=null] - Fires when an image is accepted on an unreviewed (degraded) verdict.
   * @returns {Promise<any>} The chosen result from the retry loop.
   */
  async function generateWithQualityRetry(generateOnce, label = 'image', onImageProduced = null, reviewFn = null, maxAttempts = QUALITY_MAX_ATTEMPTS, onReviewDegraded = null) {
    return runQualityRetry(generateOnce, {
      label,
      onImageProduced,
      onReviewDegraded,
      reviewFn: reviewFn || reviewImageQuality,
      maxAttempts,
      debug: DEBUG_MODE,
    });
  }

  /**
   * Generate a text-to-image result via Gemini, gated by the quality-retry loop.
   * @param {string} prompt - The image-generation prompt.
   * @param {import('express').Request} req - Express request (used for per-attempt usage metering).
   * @param {string} [geminiModel='gemini-2.5-flash-image'] - Gemini image model id.
   * @returns {Promise<any>} The generated image result from the retry loop.
   */
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

      // Generate, with the self-check quality gate retrying poor results. On a
      // retry, fold the previous attempt's QA verdict into the prompt so the
      // regeneration targets the named defect instead of re-rolling blindly.
      const resultDataUrl = await generateWithQualityRetry(async (attempt, feedback) => {
        const attemptParts = feedback
          ? [{ text: fullPrompt + qualityRetryFeedbackSuffix(feedback) }]
          : generatePrompt;
        const result = await model.generateContent(attemptParts);
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

      // Enlarge the finished ~1 MP model output for delivery (interpolation only — no
      // new detail) and ship it as WebP, same as processStaging. Text-to-image has no
      // source image to lock the aspect ratio back to, so this is the only post-step.
      return await upscaleForDelivery(resultDataUrl);
    } catch (error) {
      logger.error('Error generating image:', error);
      throw error;
    }
  }

  /**
   * Virtually stage a room image per the staging params (optionally with a furniture
   * reference), gated by the quality-retry loop.
   * @param {Buffer} imageBuffer - The room image bytes to stage.
   * @param {import('../types/staging.js').StagingParams} stagingParams - The per-request staging descriptor.
   * @param {import('express').Request} req - Express request (used for per-attempt usage metering).
   * @param {Buffer | Buffer[] | null} [furnitureImageBuffer=null] - Optional furniture reference image bytes.
   * @param {string} [geminiModel='gemini-2.5-flash-image'] - Gemini image model id.
   * @returns {Promise<any>} The staged image result from the retry loop.
   */
  async function processStaging(imageBuffer, stagingParams, req, furnitureImageBuffer = null, geminiModel = 'gemini-2.5-flash-image') {
    // The CSV row is written ONCE, at the end, from whichever path we leave by —
    // it records the outcome, so it cannot be written up front. `promptText` is
    // filled in as soon as the prompt exists; a failure before that still logs a
    // row (with an empty prompt) so the error rate counts it. `logged` guards the
    // success path and the catch from both firing.
    const startedAt = Date.now();
    let promptText = '';
    let logged = false;
    // Images THIS render produced. Deliberately not `req._stagingGenerations`, which is
    // the request-wide total across every variation: reading that here made each row
    // report the running total rather than its own cost, and once variations run
    // concurrently the value a row happened to observe is timing-dependent too. The
    // request-wide counter is still what enterprise billing meters — it just isn't what
    // a single render's row should say.
    let ownGenerations = 0;
    const logOutcome = (status, errorCode) => {
      if (logged) return;
      logged = true;
      logPromptToFile(
        promptText,
        stagingParams.roomType,
        stagingParams.furnitureStyle ?? '',
        stagingParams.additionalPrompt ?? '',
        stagingParams.removeFurniture ?? '',
        req?.body?.userRole || 'unknown',
        req?.body?.userReferralSource || 'unknown',
        req?.body?.authenticatedEmail || req?.body?.userEmail || 'unknown',
        req,
        {
          status,
          durationMs: Date.now() - startedAt,
          model: geminiModel,
          // Every image the quality gate produced for THIS render, retries included —
          // the cost of the render, not just whether it worked.
          attempts: ownGenerations,
          errorCode,
        },
      );
    };

    try {
      if (!genAI) {
        throw new Error('AI service not properly configured');
      }

      const processedImageBuffer = await downscaleImage(imageBuffer);
      const base64Image = processedImageBuffer.toString("base64");

      // Source aspect ratio: used to letterbox furniture refs to the room's shape
      // (below) and to lock the output back to it after generation (Gemini drifts).
      // Use the VISUAL (EXIF-oriented) dimensions — downscaleImage bakes orientation
      // into the pixels the model sees, so a rotated phone photo must not yield an
      // inverted ratio here.
      const srcMeta = await sharp(imageBuffer).metadata().catch(() => null);
      const srcDims = orientedDimensions(srcMeta);
      const roomAR = srcDims ? srcDims.width / srcDims.height : null;
      // Pin the output aspect ratio at the source: ask Gemini for the nearest ratio it
      // supports (set on the model below) so the result lands in a stable bucket. Without
      // this, the model's small AR wobble is re-anchored every round of an iterative
      // "download → re-upload → stage again" workflow and compounds into a visible
      // horizontal stretch. Verified honored by both the fast (2.5) and pro (3.1) models.
      const arPin = srcDims ? nearestGeminiAspectRatio(srcDims.width, srcDims.height) : null;

      // Typed as the SDK's Part[] so the mixed text/inlineData parts match
      // generateContent()'s `(string | Part)[]` parameter (union-array inference alone
      // doesn't line up with Part's discriminated members).
      /** @type {Array<import('@google/generative-ai').Part>} */
      const prompt = [
        // `promptOverride` lets a caller whose request is not a room-type/furniture-style
        // combination supply the whole prompt itself (the Exterior Studio does). Everything
        // else in this function — the EXIF-oriented aspect-ratio pin, the quality-retry
        // loop, per-attempt metering, the CSV row, the crop safety net, the delivery
        // upscale and the onNative gallery hook — is exactly what any image edit needs, so
        // the seam is one field rather than a second copy of the pipeline.
        { text: stagingParams.promptOverride || generatePrompt(
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

      // Capture the prompt the model will see; the row itself is written by
      // logOutcome once we know whether this render succeeded.
      promptText = prompt[0].text ?? '';

      if (DEBUG_MODE) {
        logger.debug(`[Staging] Using Gemini model: ${geminiModel}`);
      }
      const model = genAI.getGenerativeModel({
        model: geminiModel,
        // imageConfig rides the generationConfig passthrough (same channel mask-edit uses
        // for `seed`); the SDK forwards it verbatim to the REST endpoint, which both image
        // models honor. Pins the output shape so iterative round-trips don't drift.
        ...(arPin ? { generationConfig: { imageConfig: { aspectRatio: arPin.label } } } : {}),
      });

      // Furniture references to also show the QA reviewer (so it knows what was meant
      // to be added). Re-encode to JPEG so the data-URL MIME is always correct.
      const furnitureReviewUrls = [];
      for (const fb of furnitureBuffers) {
        try { furnitureReviewUrls.push(`data:image/jpeg;base64,${(await sharp(fb).jpeg().toBuffer()).toString('base64')}`); } catch { /* skip a furniture ref that fails to encode */ }
      }

      // The quality gate is opt-OUT. It exists because generative staging invents a whole
      // room and can invent it badly — a melted sofa is worth paying a vision pass and up
      // to two regenerations to catch. An edit that only relights a photograph it was
      // handed has no such failure mode to shop for: re-rolling produces a different sky,
      // not a better one, at three times the cost and three times the wait.
      //
      // A synthetic pass rather than a null reviewFn, because generateWithQualityRetry
      // requires one. Deliberately NOT marked `degraded`: that flag means "shipped
      // unreviewed because the reviewer broke", and it warns and sets `_qaDegraded` so an
      // outage is visible. Switching the gate off on purpose must not read as an outage in
      // the same dashboard.
      //
      // maxAttempts is left alone. The loop only re-enters on a THROW, so with the
      // reviewer always passing this is ONE generation in the happy path while a transient
      // provider error is still retried — the half of the retry worth keeping.
      const reviewer = stagingParams.skipQualityReview
        ? async () => ({ perfect: true, score: 100, reason: 'quality gate disabled for this path' })
        : (/** @type {string} */ url) => reviewImageQuality(url, {
          instruction: (stagingParams.additionalPrompt && stagingParams.additionalPrompt.trim())
            ? stagingParams.additionalPrompt.trim()
            : `Stage this ${stagingParams.roomType || 'room'} professionally`,
          furnitureDataUrls: furnitureReviewUrls,
          // The default rubric grades "AI-generated INTERIOR real-estate photos" against
          // interior failure modes. A caller working on something else has to be able to
          // swap it, or the reviewer both judges the wrong thing and stays silent about
          // the defects that render actually produces.
          basePrompt: stagingParams.reviewBasePrompt || null,
        });

      // Generate, with the self-check quality gate retrying poor results. On a
      // retry, fold the previous attempt's QA verdict into the prompt so the
      // regeneration targets the named defect instead of re-rolling blindly.
      const resultDataUrl = await generateWithQualityRetry(async (attempt, feedback) => {
        const attemptPrompt = feedback
          ? [{ ...prompt[0], text: prompt[0].text + qualityRetryFeedbackSuffix(feedback) }, ...prompt.slice(1)]
          : prompt;
        const result = await model.generateContent(attemptPrompt);
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
        ownGenerations += 1;
        if (req) req._stagingGenerations = (req._stagingGenerations || 0) + 1;
      }, reviewer, QUALITY_MAX_ATTEMPTS, () => {
        // This render shipped without QA (reviewer disabled or erroring). Recorded
        // on the request so logOutcome can put it in the render log — otherwise a
        // reviewer outage is invisible and the dashboard reports a clean 100%.
        if (req) req._qaDegraded = true;
      });

      // The aspect ratio is pinned at the source (imageConfig.aspectRatio above), so the
      // model returns a stable bucket and iterative round-trips no longer drift — no
      // post-hoc stretch needed. This crop is only a safety net for the rare output that
      // ignores the pin: it centre-crops back to the pinned ratio (no stretch, no
      // distortion) and no-ops on an honored bucket.
      let finalDataUrl = resultDataUrl;
      if (arPin) {
        const m = /^data:image\/\w+;base64,(.+)$/.exec(resultDataUrl);
        if (m) {
          const cropped = await cropToAspectRatio(Buffer.from(m[1], 'base64'), arPin.ratio);
          finalDataUrl = `data:image/png;base64,${cropped.toString('base64')}`;
        }
      }

      // Burn in the "virtually staged" disclosure, if the user asked for it.
      //
      // THIS POSITION IS THE WHOLE DESIGN — do not move it. It is after the quality gate
      // (so the reviewer never grades the badge as a defect) and before BOTH the onNative
      // hook and the delivery upscale, which each read `finalDataUrl`. One call therefore
      // labels the delivered image AND the gallery master, and it is structurally
      // impossible for those two to disagree. Stamping after the upscale would leave the
      // stored copy unlabelled — and that is the copy an agent re-downloads months later
      // and publishes.
      //
      // NOT wrapped in try/catch on purpose: the stamp fails closed. Letting it unwind to
      // the catch below logs DISCLOSURE_STAMP_FAILED and fails the render, rather than
      // quietly delivering an unlabelled image the user believes carries a disclosure.
      if (stagingParams.labelVirtuallyStaged) {
        finalDataUrl = await stampVirtuallyStaged(finalDataUrl, { lang: stagingParams.stampLang });
      }

      // Hand the NATIVE result to anyone who asked for it, before the upscale below
      // discards it. The gallery stores this rather than the delivery image: the upscale
      // is interpolation, so it is ~6x the bytes for no extra detail. Best-effort by
      // construction — a persistence hook must never be able to fail a paid render, so
      // its throw is swallowed here rather than unwinding the generation.
      if (typeof stagingParams.onNative === 'function') {
        try {
          const m = /^data:image\/(\w+);base64,(.+)$/.exec(finalDataUrl);
          // Deliberately NO sharp call here to read dimensions: this runs on the
          // generation path, and the persistence module already decodes the buffer to
          // re-encode it. Handing over the bytes and letting the consumer derive the
          // rest keeps the hook to a base64 decode.
          if (m) stagingParams.onNative(Buffer.from(m[2], 'base64'), { format: m[1] });
        } catch (hookError) {
          logger.error('[Staging] onNative hook threw; the render is unaffected:', hookError);
        }
      }

      // Enlarge the finished ~1 MP model output for delivery (interpolation only — no
      // new detail) and ship it as WebP so the larger image is a smaller payload than
      // the PNG. The client sizes its canvas to the returned image's natural dimensions,
      // so this also raises the resolution of the JPEG the user downloads.
      const delivered = await upscaleForDelivery(finalDataUrl);
      logOutcome('ok', '');
      return delivered;
    } catch (error) {
      logOutcome('failed', error?.code || error?.name || 'ERROR');
      logger.error('Error processing staging:', error);
      throw error;
    }
  }

  return { generateWithQualityRetry, processImageGeneration, processStaging };
}
