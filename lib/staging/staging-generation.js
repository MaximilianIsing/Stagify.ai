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
import { generatePrompt, styleReferencePromptSuffix, furnitureReferencePromptSuffix, qualityRetryFeedbackSuffix } from './prompts.js';
import { designBiblePromptSuffix } from './prompts-continuity.js';
import { normalizeFurnitureBuffers } from './staging-pipeline.js';

/**
 * Build the Gemini image-generation API (quality-gate retry wrapper plus the text-to-image
 * and virtual-staging generators) bound to this server's AI clients and reviewers.
 * @param {{ genAI: { getGenerativeModel: (options: any) => any } | null, DEBUG_MODE: boolean, runQualityRetry: typeof import('./staging-pipeline.js').generateWithQualityRetry, reviewImageQuality: ReturnType<typeof import('../image/image-review.js').createImageReview>['reviewImageQuality'], reviewDesignConsistency?: ReturnType<typeof import('../image/image-review.js').createImageReview>['reviewDesignConsistency'] | null, QUALITY_MAX_ATTEMPTS: number, logPromptToFile: ReturnType<typeof import('../services/logging.js').createLogging>['logPromptToFile'] }} deps - Injected Gemini client, debug flag, the options-object generateWithQualityRetry (runQualityRetry), the quality reviewer, the OPTIONAL design-continuity reviewer (absent → the bible path falls back to the quality gate alone), the attempt cap, and the CSV prompt logger.
 * @returns {{ generateWithQualityRetry: (generateOnce: (attempt: number) => Promise<string>, label?: string, onImageProduced?: ((attempt: number) => void) | null, reviewFn?: Function | null, maxAttempts?: number) => Promise<any>, processImageGeneration: (prompt: string, req: import('express').Request, geminiModel?: string) => Promise<any>, processStaging: (imageBuffer: Buffer, stagingParams: import('../types/staging.js').StagingParams, req: import('express').Request | null, furnitureImageBuffer?: Buffer | Buffer[] | null, geminiModel?: string, outcome?: import('../types/staging.js').StagingOutcome | null) => Promise<any> }} The staging-generation API.
 */
export function createStagingGeneration(deps) {
  // reviewDesignConsistency is optional so an existing composition root (and every
  // test harness that builds this factory) keeps working without it; the bible path
  // simply falls back to the quality gate alone when it is absent.
  const { genAI, DEBUG_MODE, runQualityRetry, reviewImageQuality, reviewDesignConsistency = null, QUALITY_MAX_ATTEMPTS, logPromptToFile } = deps;

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
   * @returns {Promise<any>} The chosen result from the retry loop.
   */
  async function generateWithQualityRetry(generateOnce, label = 'image', onImageProduced = null, reviewFn = null, maxAttempts = QUALITY_MAX_ATTEMPTS) {
    return runQualityRetry(generateOnce, {
      label,
      onImageProduced,
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
   * @param {import('../types/staging.js').StagingOutcome | null} [outcome=null] - Optional out-parameter. When supplied, per-render stats (prompt text, model, attempt count, and the final quality/consistency scores) are written onto it. Added for the listing worker, which persists them as a render row's audit trail and has no `req` to hang them off; existing callers pass nothing and are unaffected.
   * @returns {Promise<any>} The staged image result from the retry loop.
   */
  async function processStaging(imageBuffer, stagingParams, req, furnitureImageBuffer = null, geminiModel = 'gemini-2.5-flash-image', outcome = null) {
    // Last verdicts seen by the reviewer wrapper below. The retry loop returns only the
    // winning image, so a score the caller wants to persist has to be captured as it
    // goes past. `continuity` is only ever set on the design-bible path.
    //
    // Held on an object rather than in two `let`s on purpose: these are written inside a
    // callback the retry loop invokes, and TypeScript's control-flow analysis does not
    // follow assignments across that closure boundary — a plain `let x = null` stays
    // narrowed to `null` at the read site, so the truthy branch collapses to `never`.
    // A property read is re-widened by the intervening calls, which keeps this honest
    // without reaching for a cast.
    /** @type {{ continuity: { perfect: boolean, score: number, reason: string, slots: Array<{ slot: string, match: boolean }>, checked?: boolean } | null, quality: { perfect: boolean, score: number, reason: string } | null, attempts: number, best: { score: number, quality: { perfect: boolean, score: number, reason: string } | null, continuity: { perfect: boolean, score: number, reason: string, slots: Array<{ slot: string, match: boolean }>, checked?: boolean } | null } | null }} */
    const seen = { continuity: null, quality: null, attempts: 0, best: null };
    // The verdicts belonging to the attempt the retry loop will actually RETURN, tracked by
    // mirroring its selection rule: it keeps the first `perfect` result, else the
    // highest-scoring one, ranked by this same composed score.
    //
    // Last-write-wins recorded whichever attempt merely ran last, so the audit trail
    // routinely described an image that was discarded (best attempt scored 90, the row said
    // 10). Keying by the image's data URL was the first fix and is not sufficient — two
    // attempts can produce byte-identical output and collapse onto one key.
    /** @type {{ score: number, quality: { perfect: boolean, score: number, reason: string } | null, continuity: { perfect: boolean, score: number, reason: string, slots: Array<{ slot: string, match: boolean }>, checked?: boolean } | null } | null} */
    /**
     * Record this attempt's verdicts if it is the best seen so far. Strictly greater, so a
     * tie keeps the EARLIER attempt — the same tie-break generateWithQualityRetry applies.
     * @param {number} score @param {any} quality @param {any} continuity
     */
    const noteAttempt = (score, quality, continuity) => {
      if (!seen.best || score > seen.best.score) seen.best = { score, quality, continuity };
    };
    // The CSV row is written ONCE, at the end, from whichever path we leave by —
    // it records the outcome, so it cannot be written up front. `promptText` is
    // filled in as soon as the prompt exists; a failure before that still logs a
    // row (with an empty prompt) so the error rate counts it. `logged` guards the
    // success path and the catch from both firing.
    const startedAt = Date.now();
    let promptText = '';
    let logged = false;
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
        // `stagingParams.ownerEmail` is the LISTING path's answer to the same question. That
        // path renders from a background worker with no `req`, so every column here fell back
        // to the literal 'unknown' — including the email. That was a GDPR hole, not untidiness:
        // `LOG_REDACTIONS` matches prompt_logs.csv rows on the email cell, so an erasure could
        // never find them, and the row carries `additionalPrompt` verbatim — up to 500
        // characters a listing agent routinely fills with an address and client notes.
        req?.body?.authenticatedEmail || req?.body?.userEmail
          || (typeof stagingParams.ownerEmail === 'string' && stagingParams.ownerEmail)
          || 'unknown',
        req,
        {
          status,
          durationMs: Date.now() - startedAt,
          model: geminiModel,
          // Every image the quality gate produced, retries included — the cost of
          // the render, not just whether it worked.
          attempts: req?._stagingGenerations || 0,
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
      // Which of the three meanings the extra images carry. The plumbing is shared;
      // only the instruction differs, and picking the wrong one actively instructs the
      // model to do the opposite of what the caller wants (the style suffix, applied to
      // a listing support frame, tells it to CHANGE the furniture).
      const bible = stagingParams.designBible ?? null;
      // Unlike the other two modes the bible is useful with no reference image at all —
      // it is a structured text description of the room's locked pieces — so it is
      // appended outside the has-references guard. A support frame whose hero render
      // could not be loaded still gets text conditioning rather than a blind re-stage.
      if (bible) {
        prompt[0].text += designBiblePromptSuffix(bible, furnitureBuffers.length);
        if (DEBUG_MODE) {
          logger.debug(`[Staging] Design-bible conditioning: ${Array.isArray(bible.pieces) ? bible.pieces.length : 0} piece(s), ${furnitureBuffers.length} hero reference image(s)`);
        }
      }
      if (furnitureBuffers.length > 0) {
        if (!bible) {
          prompt[0].text += stagingParams.styleReference
            ? styleReferencePromptSuffix(furnitureBuffers.length)
            : furnitureReferencePromptSuffix(
                furnitureBuffers.length,
                Boolean(stagingParams.preserveExistingStaging)
              );
          if (DEBUG_MODE) {
            logger.debug(`[Staging] Including ${furnitureBuffers.length} ${stagingParams.styleReference ? 'style' : 'furniture'} reference image(s) in staging request`);
          }
        }
        if (anyReferencePadded) {
          // The furniture wording ("use only the subject shown") is actively wrong for a
          // hero reference: that image is a whole room, and telling the model to extract
          // "the subject" from it invites a cut-out instead of a continuity match.
          prompt[0].text += bible
            ? '\n\nNOTE ON THE REFERENCE VIEW: The reference image has transparent/empty padding added around it to match this photo\'s shape. Ignore that padding entirely — it is not part of the room. Read only the actual photographed room inside it.'
            : '\n\nNOTE ON REFERENCE IMAGES: One or more reference images have transparent/empty padding added around them to match the room\'s shape. Ignore that empty padding entirely — use only the actual furniture/subject shown, and scale it naturally within the room.';
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

      const qaInstruction = (stagingParams.additionalPrompt && stagingParams.additionalPrompt.trim())
        ? stagingParams.additionalPrompt.trim()
        : `Stage this ${stagingParams.roomType || 'room'} professionally`;

      // The quality reviewer's furniture guide reads "the remaining images are the
      // furniture pieces the user uploaded to be included — check it was incorporated".
      // On the bible path the extra image is a whole ROOM, so handing it over under that
      // wording asks the reviewer to check a sofa-sized room photo was placed in the
      // room, and it will fail every frame. The references are withheld there instead,
      // and the continuity reviewer — which knows what that image actually is — judges them.
      // Whether the composed worst-of reviewer is in play. A bible alone is not enough:
      // without an injected continuity reviewer (or a loadable hero frame) the quality
      // verdict IS the ranking, and it must still be recorded.
      const heroReviewUrl = bible ? (furnitureReviewUrls[0] ?? null) : null;
      const usesContinuity = !!(bible && heroReviewUrl && typeof reviewDesignConsistency === 'function');

      const qualityOnly = async (/** @type {string} */ url) => {
        const verdict = await reviewImageQuality(url, {
          instruction: qaInstruction,
          furnitureDataUrls: bible ? [] : furnitureReviewUrls,
        });
        // On the quality-only path the composed score IS the quality score, so this is the
        // ranking the retry loop will use. The bible path calls noteAttempt itself, below,
        // with the worst-of score.
        if (!usesContinuity) noteAttempt(verdict.score, verdict, null);
        return verdict;
      };

      // Two gates on the bible path, combined WORST-OF rather than averaged. Averaging
      // lets a gorgeous render with the wrong sofa through, and that specific outcome —
      // beautiful and inconsistent — is the entire failure this feature exists to
      // prevent. Returning the loser's verdict (not just its score) also carries the
      // right "WHY:" line into qualityRetryFeedbackSuffix, so the retry is told the
      // sofa drifted instead of being nudged about generic quality.
      const reviewFn = (usesContinuity && heroReviewUrl && reviewDesignConsistency)
        ? async (/** @type {string} */ url) => {
            const [quality, continuity] = await Promise.all([
              qualityOnly(url),
              reviewDesignConsistency(heroReviewUrl, url, bible),
            ]);
            const loser = continuity.score < quality.score ? continuity : quality;
            noteAttempt(loser.score, quality, continuity);
            // `perfect` is ANDed, never inherited from whichever verdict won on score.
            // Comparing scores alone let a NAMED mismatch through: the continuity prompt
            // invites "SCORE: 100" for one mild substitution, so a verdict of
            // {perfect: false, score: 100, slots: [sofa: mismatch]} tied with a perfect
            // quality verdict, `100 < 100` was false, and the retry loop stopped on the
            // first attempt and shipped the wrong sofa. Whichever reviewer refuses,
            // the attempt is not perfect.
            return { ...loser, perfect: quality.perfect && continuity.perfect };
          }
        : qualityOnly;

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
        if (req) req._stagingGenerations = (req._stagingGenerations || 0) + 1;
        // Counted separately as well: the listing worker has no `req` to meter on, and
        // an attempt count is the cost of the render it needs to record.
        seen.attempts += 1;
      }, reviewFn);

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

      // Enlarge the finished ~1 MP model output for delivery (interpolation only — no
      // new detail) and ship it as WebP so the larger image is a smaller payload than
      // the PNG. The client sizes its canvas to the returned image's natural dimensions,
      // so this also raises the resolution of the JPEG the user downloads.
      const delivered = await upscaleForDelivery(finalDataUrl);
      logOutcome('ok', '');
      if (outcome) {
        const chosen = seen.best || { quality: null, continuity: null };
        const continuity = chosen.continuity;
        outcome.promptText = promptText;
        outcome.model = geminiModel;
        outcome.attempts = seen.attempts;
        outcome.durationMs = Date.now() - startedAt;
        outcome.qualityScore = chosen.quality ? chosen.quality.score : null;
        // null, not 100, when no continuity check ran. "Unchecked" and "checked and
        // perfect" must stay distinguishable downstream: the UI promises the user that
        // continuity was enforced, and a defaulted score would let it promise that
        // about a frame nothing ever looked at.
        //
        // `checked === false` is the reviewer's own fail-open sentinel — a null client, a
        // thrown model error, an unreadable frame, or a bible with no critical pieces. Those
        // all return {perfect: true, score: 100} so the retry loop accepts the image, which
        // is correct; persisting that 100 was not. It reached the grid as a confident
        // "Consistency 100.00" on a frame no reviewer ever saw, which is precisely what the
        // docblock on this field forbids. Unchecked is null, whatever score came back with it.
        outcome.consistencyScore = continuity && continuity.checked !== false ? continuity.score : null;
        outcome.mismatchedSlots = continuity && continuity.checked !== false
          ? continuity.slots.filter((s) => !s.match).map((s) => s.slot)
          : [];
      }
      return delivered;
    } catch (error) {
      logOutcome('failed', error?.code || error?.name || 'ERROR');
      if (outcome) {
        outcome.promptText = promptText;
        outcome.model = geminiModel;
        outcome.attempts = seen.attempts;
        outcome.durationMs = Date.now() - startedAt;
        outcome.errorCode = error?.code || error?.name || 'ERROR';
      }
      logger.error('Error processing staging:', error);
      throw error;
    }
  }

  return { generateWithQualityRetry, processImageGeneration, processStaging };
}
