// Staging-dispatch slice of the AI Designer pipeline (lib/chat/chat-pipeline.js):
// run the AI's staging request(s). The chat-vs-upload divergence arrives via the
// injected resolveDualUpload / resolveFallbackImage callbacks and the
// applyOriginalKeywordFallback flag (call-time params, unchanged) — nothing new
// to inject.
//
// deps: { DEBUG_MODE, annotateImage, getGeminiImageModel, processStaging, incPromptCount }
import { DUAL_UPLOAD_ROOM_PROMPT_SUFFIX } from '../staging/prompts.js';
import { getImageFromHistory, getOriginalImageIndex, applyAddFurnitureStagingFallback, applyBaseImageIndexToStagingParams } from './chat-history.js';
import { logger } from '../logger.js';

/**
 * Factory for the staging-dispatch slice of the AI Designer pipeline: builds the
 * bundle that runs the AI's staging request(s). The chat-vs-upload divergence is
 * supplied per call via the injected callbacks, so only cross-cutting collaborators
 * are injected here.
 * @param {{ DEBUG_MODE: boolean, annotateImage: (dataUrl: string) => Promise<string|null>, getGeminiImageModel: (model: string) => string, processStaging: (image: Buffer, params: import('../types/staging.js').StagingParams, req: import('express').Request, furniture: Buffer|Buffer[]|null, model: string) => Promise<string|null>, incPromptCount: () => void }} deps - Injected dependencies.
 * @returns {{ runStagingRequests: Function }} The staging-dispatch bundle.
 */
export default function createStagingDispatch(deps) {
  const { DEBUG_MODE, annotateImage, getGeminiImageModel, processStaging, incPromptCount } = deps;

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
   * @param {{ stagingRequestFromAI: import('../types/chat.js').StagingRequest | import('../types/chat.js').StagingRequest[] | null, history: import('../types/chat.js').ChatMessage[], userMessageText: string, userId: string, req: import('express').Request, selectedModel: string, baseImageIndex: number | null, currentMessageHasImage: boolean, currentImageBuffer: Buffer | null, applyOriginalKeywordFallback: boolean, resolveDualUpload: () => import('../types/chat.js').DualUploadResolution | null, resolveFallbackImage: () => import('../types/chat.js').FallbackImageResolution | null }} args - AI staging decision plus all context; the two handler-specific behaviors arrive as the resolveDualUpload/resolveFallbackImage callbacks and the applyOriginalKeywordFallback flag.
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
  }) {
    const stagingResults = [];
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
                  const stagedImage = await processStaging(imageBuffer, stagingParams, req, furnitureImageBuffer, geminiModel);
                  if (stagedImage) {
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

    return { stagingResults, textSuffix };
  }

  return { runStagingRequests };
}
