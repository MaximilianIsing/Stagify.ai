// Staging-dispatch slice of the AI Designer pipeline (lib/chat/chat-pipeline.js):
// run the AI's staging request(s). The chat-vs-upload divergence arrives via the
// injected resolveDualUpload / resolveFallbackImage callbacks and the
// applyOriginalKeywordFallback flag (call-time params, unchanged) — nothing new
// to inject.
//
// deps: { DEBUG_MODE, annotateImage, getGeminiImageModel, processStaging, incPromptCount,
//         renderPersistence }
import { DUAL_UPLOAD_ROOM_PROMPT_SUFFIX } from '../staging/prompts.js';
import { getImageFromHistory, getOriginalImageIndex, applyAddFurnitureStagingFallback, applyBaseImageIndexToStagingParams } from './chat-history.js';
import { newRenderId } from '../data/object-keys.js';
import { logger } from '../logger.js';

/**
 * Factory for the staging-dispatch slice of the AI Designer pipeline: builds the
 * bundle that runs the AI's staging request(s). The chat-vs-upload divergence is
 * supplied per call via the injected callbacks, so only cross-cutting collaborators
 * are injected here.
 * @param {{ DEBUG_MODE: boolean, annotateImage: (dataUrl: string) => Promise<string|null>, getGeminiImageModel: (model: string) => string, processStaging: (image: Buffer, params: import('../types/staging.js').StagingParams, req: import('express').Request, furniture: Buffer|Buffer[]|null, model: string) => Promise<string|null>, incPromptCount: () => void, renderPersistence?: any }} deps - Injected dependencies.
 * @returns {{ runStagingRequests: Function }} The staging-dispatch bundle.
 */
export default function createStagingDispatch(deps) {
  const {
    DEBUG_MODE, annotateImage, getGeminiImageModel, processStaging, incPromptCount,
    // Optional, and absent in every existing spec's deps bag: with no gallery configured
    // (or an older caller) this whole slice behaves exactly as it did before.
    renderPersistence = null,
  } = deps;

  // Run the AI's staging request(s) (single or array, max 3). The two divergent
  // parts of the original handlers are injected:
  //   - resolveDualUpload():    returns a { roomBuffer, furnitureBuffers, source } or null
  //   - resolveFallbackImage(): returns a { buffer, source, logMessage } or null
  //                             (used only when there's no dual upload and no
  //                              usePreviousImage selection)
  //   - applyOriginalKeywordFallback: whether to run the "original/first image"
  //                             keyword override (chat: always; upload: only when
  //                             the current message has no image)
  // Returns { stagingResults, textSuffix }.
  /**
   * Run the AI's staging request(s) (single or array, normalized to an array capped
   * at 3). Resolves each request's target image by a 3-way precedence — dual upload
   * > usePreviousImage index (an out-of-range index falls back to index 0) > the
   * injected resolveFallbackImage — then stages it. incPromptCount() fires only on a
   * successful stage. Per-item errors are swallowed so remaining requests continue;
   * an apology suffix is appended only when there is a single request that fails or
   * finds no image. History images are decoded from their data-URL buffers.
   * @param {{ stagingRequestFromAI: import('../types/chat.js').StagingRequest | import('../types/chat.js').StagingRequest[] | null, history: import('../types/chat.js').ChatMessage[], userMessageText: string, userId: string, req: import('express').Request, selectedModel: string, baseImageIndex: number | null, currentMessageHasImage: boolean, currentImageBuffer: Buffer | null, applyOriginalKeywordFallback: boolean, resolveDualUpload: () => import('../types/chat.js').DualUploadResolution | null, resolveFallbackImage: () => import('../types/chat.js').FallbackImageResolution | null, user?: any }} args - AI staging decision plus all context; the two handler-specific behaviors arrive as the resolveDualUpload/resolveFallbackImage callbacks and the applyOriginalKeywordFallback flag. `user` is the Stagify+ account the resulting gallery entries belong to.
   * @returns {Promise<{ stagingResults: import('../types/chat.js').StagingResult[], textSuffix: string }>} Staged results (each { stagedImage, params, annotationPromise }) and an apology suffix for a lone failure/no-image.
   */
  async function runStagingRequests({
    stagingRequestFromAI,
    history,
    userMessageText,
    userId,
    req,
    selectedModel,
    baseImageIndex,
    currentMessageHasImage,
    currentImageBuffer,
    applyOriginalKeywordFallback,
    resolveDualUpload,
    resolveFallbackImage,
    // The Stagify+ account this turn belongs to. Absent means no gallery entry, which is
    // what every existing spec (and any caller that has not been updated) gets.
    user = null,
  }) {
    const stagingResults = [];
    /** @type {{ native: { buffer: Buffer }, sourceBuffer: Buffer, params: any, sourceName: string, model: string }[]} */
    const pendingGallery = [];
    let textSuffix = '';

    if (stagingRequestFromAI) {
      // Normalize to array (max 3)
      const stagingRequests = Array.isArray(stagingRequestFromAI)
        ? stagingRequestFromAI.slice(0, 3).filter(s => s.shouldStage)
        : (stagingRequestFromAI.shouldStage ? [stagingRequestFromAI] : []);

      if (stagingRequests.length > 0) {
        if (DEBUG_MODE) {
          logger.debug(`[Staging] Processing ${stagingRequests.length} staging request(s) from AI`);
        }

        for (let i = 0; i < stagingRequests.length; i++) {
          const stagingRequest = stagingRequests[i];
          if (DEBUG_MODE) {
            logger.debug(`[Staging] Processing staging request ${i + 1}/${stagingRequests.length}:`, stagingRequest);
          }

          // Build staging params from AI response
          let stagingParams = {
            roomType: stagingRequest.roomType || 'Other',
            furnitureStyle: 'custom', // Always use custom
            additionalPrompt: stagingRequest.additionalPrompt || '',
            removeFurniture: stagingRequest.removeFurniture || false,
            usePreviousImage: stagingRequest.usePreviousImage !== undefined ? stagingRequest.usePreviousImage : false,
            furnitureImageIndex: stagingRequest.furnitureImageIndex !== undefined && stagingRequest.furnitureImageIndex !== null ? stagingRequest.furnitureImageIndex : null,
            styleReference: stagingRequest.styleReference === true
          };

          const addFurnitureFallback = applyAddFurnitureStagingFallback(
            stagingParams,
            userMessageText,
            history,
            {
              currentMessageHasImage,
              currentImageBuffer,
              baseImageIndex,
            }
          );
          stagingParams = addFurnitureFallback.stagingParams;
          const furnitureFromCurrentUpload = addFurnitureFallback.furnitureFromCurrentUpload;

          // Fallback: If user mentions "original", "first", or "initial" image but AI didn't set usePreviousImage correctly
          if (applyOriginalKeywordFallback) {
            const messageLower = userMessageText.toLowerCase();
            const hasOriginalKeywords = messageLower.includes('original') ||
                                        messageLower.includes('first image') ||
                                        messageLower.includes('initial image') ||
                                        messageLower.includes('go back to') ||
                                        messageLower.includes('refer back to');

            if (hasOriginalKeywords && (stagingParams.usePreviousImage === false || stagingParams.usePreviousImage === null)) {
              // Find the original (first) user-uploaded image
              const originalImageIndex = getOriginalImageIndex(history);
              if (originalImageIndex !== null) {
                if (DEBUG_MODE) {
                  logger.debug(`[Staging] Fallback: User mentioned "original" but AI didn't set usePreviousImage. Overriding to use original image at index ${originalImageIndex}`);
                }
                stagingParams.usePreviousImage = originalImageIndex;
              } else {
                // If no original found, use most recent (index 0)
                if (DEBUG_MODE) {
                  logger.debug(`[Staging] Fallback: User mentioned "original" but no original image found. Using most recent image (index 0) as fallback`);
                }
                stagingParams.usePreviousImage = 0;
              }
            }
          }

          stagingParams = applyBaseImageIndexToStagingParams(
            stagingParams,
            baseImageIndex,
            history,
            {
              userMessage: userMessageText,
              currentMessageHasImage,
            }
          );

          if (stagingParams) {
            try {
              let imageBuffer = null;
              let imageSource = '';
              let sourceName = '';
              let furnitureImageBuffer = furnitureFromCurrentUpload || null;

              const dualUpload = resolveDualUpload();
              if (dualUpload) {
                imageBuffer = dualUpload.roomBuffer;
                furnitureImageBuffer = dualUpload.furnitureBuffers;
                imageSource = dualUpload.source;
                if (!stagingParams.additionalPrompt || !stagingParams.additionalPrompt.includes('user\'s actual room photo')) {
                  stagingParams = {
                    ...stagingParams,
                    additionalPrompt: (stagingParams.additionalPrompt || '') + DUAL_UPLOAD_ROOM_PROMPT_SUFFIX,
                  };
                }
              } else if (stagingParams.usePreviousImage !== false && stagingParams.usePreviousImage !== null) {
                // AI requested a previous image - use the AI's chosen index
                const imageIndex = typeof stagingParams.usePreviousImage === 'number' ? stagingParams.usePreviousImage : 0;
                if (DEBUG_MODE) {
                  logger.debug(`[Staging] Looking for image at index ${imageIndex}`);
                }

                const previousImage = getImageFromHistory(history, imageIndex);

                if (previousImage && previousImage.url) {
                  const base64Data = previousImage.url.split(',')[1];
                  if (base64Data) {
                    imageBuffer = Buffer.from(base64Data, 'base64');
                    imageSource = previousImage.isStaged ? `staged image (index ${imageIndex})` : `user-uploaded image (index ${imageIndex})`;
                    if (DEBUG_MODE) {
                      logger.debug(`[Staging] Using previous ${imageSource}`);
                    }
                  } else {
                    if (DEBUG_MODE) {
                      logger.debug(`[Staging] Previous image found but base64 data extraction failed`);
                    }
                  }
                } else {
                  if (DEBUG_MODE) {
                    logger.debug(`[Staging] Previous image at index ${imageIndex} not found`);
                  }
                  // Fallback: try to use the most recent image (index 0) if requested index doesn't exist
                  if (imageIndex > 0) {
                    if (DEBUG_MODE) {
                      logger.debug(`[Staging] Attempting fallback to index 0`);
                    }
                    const fallbackImage = getImageFromHistory(history, 0);
                    if (fallbackImage && fallbackImage.url) {
                      const base64Data0 = fallbackImage.url.split(',')[1];
                      if (base64Data0) {
                        imageBuffer = Buffer.from(base64Data0, 'base64');
                        imageSource = fallbackImage.isStaged ? `staged image (fallback to index 0)` : `user-uploaded image (fallback to index 0)`;
                        if (DEBUG_MODE) {
                          logger.debug(`[Staging] Using fallback ${imageSource}`);
                        }
                      }
                    }
                  }
                }
              } else {
                // Neither a dual upload nor a previous-image selection: use the
                // handler-specific fallback (chat: conversation history; upload:
                // the current message's uploaded image).
                const fb = resolveFallbackImage();
                if (fb) {
                  imageBuffer = fb.buffer;
                  imageSource = fb.source;
                  // Only /api/chat-upload's resolver carries one, and only when the upload
                  // is the ROOM rather than a furniture photo. Everywhere else this stays
                  // '' and the gallery name simply has no suffix.
                  sourceName = fb.sourceName || '';
                  if (DEBUG_MODE && fb.logMessage) {
                    logger.debug(fb.logMessage);
                  }
                }
              }

              // Retrieve furniture image if specified (skip if dual upload already set furniture buffers)
              if (!dualUpload && !furnitureImageBuffer && stagingParams.furnitureImageIndex !== null && stagingParams.furnitureImageIndex !== undefined) {
                const furnitureIndex = typeof stagingParams.furnitureImageIndex === 'number' ? stagingParams.furnitureImageIndex : null;
                if (furnitureIndex !== null) {
                  if (DEBUG_MODE) {
                    logger.debug(`[Staging] Looking for furniture image at index ${furnitureIndex}`);
                  }
                  const furnitureImage = getImageFromHistory(history, furnitureIndex);

                  if (furnitureImage && furnitureImage.url) {
                    const base64Data = furnitureImage.url.split(',')[1];
                    if (base64Data) {
                      furnitureImageBuffer = Buffer.from(base64Data, 'base64');
                      if (DEBUG_MODE) {
                        logger.debug(`[Staging] Found furniture image at index ${furnitureIndex}`);
                      }
                    }
                  } else {
                    if (DEBUG_MODE) {
                      logger.debug(`[Staging] Furniture image at index ${furnitureIndex} not found`);
                    }
                  }
                }
              }

              if (imageBuffer) {
                try {
                  const geminiModel = getGeminiImageModel(selectedModel);
                  // The model's own output, before the delivery upscale — the same bytes
                  // the interior handler stores. Only wired when there is somewhere to put
                  // them, so nothing is decoded when the gallery is off.
                  let native = null;
                  const onNative = renderPersistence?.enabled() && user
                    ? (buffer) => { native = { buffer }; }
                    : null;
                  // A COPY, not a mutation: stagingParams is pushed into stagingResults
                  // below and travels on to buildDesignerResponse. JSON.stringify would
                  // drop a function, but a function riding on a response object is a trap
                  // waiting for the first person who reaches for structuredClone.
                  const stagedImage = await processStaging(
                    imageBuffer, { ...stagingParams, onNative }, req, furnitureImageBuffer, geminiModel,
                  );
                  if (stagedImage) {
                    if (native) {
                      // Accumulated, not persisted here. One block after the loop keeps the
                      // gallery out of the hot path and gives the drift guard a single site
                      // to find.
                      pendingGallery.push({
                        native,
                        sourceBuffer: imageBuffer,
                        params: stagingParams,
                        sourceName,
                        model: geminiModel,
                      });
                    }
                    // Increment prompt count for staging
                    incPromptCount();

                    // Annotate staged image in parallel
                    const annotationPromise = annotateImage(stagedImage).then(annotation => {
                      if (DEBUG_MODE) {
                        logger.debug(`[Image Annotation] Annotation for staged image ${i + 1}: ${annotation || 'failed'}`);
                      }
                      return annotation;
                    }).catch(err => {
                      logger.error(`[Image Annotation] Error annotating staged image ${i + 1}:`, err);
                      return null;
                    });

                    stagingResults.push({
                      stagedImage: stagedImage,
                      params: stagingParams,
                      annotationPromise: annotationPromise
                    });
                    if (DEBUG_MODE) {
                      logger.debug(`[Staging] Successfully processed staging ${i + 1}/${stagingRequests.length} for user ${userId} from ${imageSource}${furnitureImageBuffer ? ' with furniture image' : ''}`);
                    }
                  }
                } catch (stagingError) {
                  logger.error(`[Staging] Error processing staging ${i + 1}:`, stagingError);
                  logger.error(`[Staging] Error stack:`, stagingError.stack);
                  // Continue with other staging requests if one fails
                  if (stagingRequests.length === 1) {
                    textSuffix += '\n\nSorry, I encountered an error while staging the room. Please try again.';
                  }
                }
              } else {
                if (DEBUG_MODE) {
                  logger.debug(`[Staging] No image found for staging ${i + 1}`);
                }
                if (stagingRequests.length === 1) {
                  textSuffix += '\n\nSorry, I couldn\'t find the image to stage. Please make sure you\'ve uploaded an image.';
                }
              }
            } catch (error) {
              logger.error(`[Staging] Error in staging request ${i + 1}:`, error);
              logger.error(`[Staging] Error stack:`, error.stack);
              // Continue with other staging requests if one fails
              if (stagingRequests.length === 1) {
                textSuffix += '\n\nSorry, I encountered an error while processing the staging request. Please try again.';
              }
            }
          }
        }
      }
    }

    persistToGallery({ pendingGallery, user });
    return { stagingResults, textSuffix };
  }

  /**
   * Turn this turn's staged results into gallery entries.
   *
   * ONE CALL PER RESULT, sharing a batch id — not one call with N natives, which is what
   * the interior handler does. The difference is real: interior variations are N renders of
   * ONE photo, so they share a `sourceBuffer`, while the AI Designer's three staging
   * requests can each target a different image from the conversation. Batching them would
   * put the wrong room behind the before/after slider.
   *
   * Wrapped whole and never rethrows: the user has already been charged for these renders
   * and already has the images in the chat. A history feature must not be able to turn a
   * successful paid turn into a 500 — the same posture as
   * lib/staging/virtual-staging-handler.js.
   *
   * @param {{ pendingGallery: any[], user: any }} arg
   */
  function persistToGallery({ pendingGallery, user }) {
    if (!pendingGallery.length || !renderPersistence?.enabled() || !user) return;
    try {
      const batchId = newRenderId();
      pendingGallery.forEach((item, index) => {
        const pending = renderPersistence.recordPending({
          user,
          // Both chat endpoints sit behind requireProAccount, so there is no free branch
          // here — unlike the interior path, which serves both tiers.
          isPro: true,
          natives: [item.native],
          params: item.params,
          model: item.model,
          batchId,
          variationBase: index,
          // No qualifier: the designer's is its `roomType`, which is already a column, so
          // public/scripts/render-name.js derives it. Note that roomType is a GUESS the
          // routing model made and defaults to 'Other' — which that module suppresses
          // rather than printing, because "AI Designer — Other" reads like a bug.
          //
          // The 5-10 word GPT description (lib/image/image-annotation.js) would be a
          // better qualifier and is already being computed in parallel a few lines above —
          // but it is a PROMISE, and these rows must be written synchronously before the
          // response so the gallery cap stays unraceable. Awaiting it here would put an
          // OpenAI round-trip on the critical path of a paid render.
          extra: { source: 'designer', sourceName: item.sourceName },
        });
        if (pending) {
          void renderPersistence.uploadInBackground({
            entries: pending.entries,
            sourceBuffer: item.sourceBuffer,
            refUploads: [],
            user,
          }).catch(() => {});
        }
      });
    } catch (error) {
      logger.error('[gallery] could not record AI Designer renders; the chat turn is unaffected:', error);
    }
  }

  return { runStagingRequests };
}
