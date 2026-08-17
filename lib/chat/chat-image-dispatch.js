// Image-dispatch slice of the AI Designer pipeline (lib/chat/chat-pipeline.js):
// produce NEW images from AI action requests that do not need the staging
// precedence logic — text-to-image generation and CAD blueprint → render.
//
// deps: { DEBUG_MODE, annotateImage, getGeminiImageModel, processImageGeneration,
//         blueprintTo3D, incPromptCount, renderPersistence }
import { getImageFromHistory, resolveCadImageIndex, collectImagesFromHistory } from './chat-history.js';
import { detectImageMimeType } from '../image/image-primitives.js';
import { normalizeStampOptions } from '../image/stamp-disclosure.js';
import { newRenderId } from '../data/object-keys.js';
import { logger } from '../logger.js';

/**
 * The blueprint render succeeded and was then WITHHELD, because the disclosure stamp
 * fails closed (lib/image/stamp-disclosure.js). Distinct from the generic apology for
 * the same reason chat-staging.js keeps its own copy: "try again" sends the user back
 * into the same wall, paying for a Pro-model render each time.
 */
const CAD_DISCLOSURE_FAILURE_NOTE = '\n\nI rendered the floor plan, but I couldn\'t add the "Virtually staged" label to it — so I haven\'t sent the image through, rather than give you an unlabelled one. Ask me to render it without the label and it\'ll come straight back.';

/**
 * Turn the routing model's `disclosure` object into the stamp params blueprintTo3D wants.
 *
 * Mirrors chat-staging.js's stampParamsFromRouting: the model's choice goes through the
 * same normalizeStampOptions every checkbox surface uses, and the badge LANGUAGE is not
 * the model's to pick — it comes from the request, because only the browser knows what
 * language the user is reading the site in.
 * @param {import('../types/chat.js').CadRequest} cadRequest - The routing entry.
 * @param {import('express').Request | undefined} req - The turn's request; carries the site language.
 * @returns {{ enabled: boolean, lang: string, style: string, scale: number }} Validated stamp params.
 */
function stampFromCadRouting(cadRequest, req) {
  const disclosure = /** @type {any} */ (cadRequest?.disclosure);
  const { lang, style, scale } = normalizeStampOptions({
    lang: /** @type {any} */ (req)?.body?.stampLang,
    style: disclosure?.style,
    scale: disclosure?.scale,
  });
  // NON-NULL IS THE FLAG. DISCLOSURE_ROUTING_FIELD has no `enabled` property — its shape
  // is `{ style, scale }` or null — so `!!disclosure` is the whole test, exactly as
  // chat-staging.js reads it. (Probing a `.enabled` that cannot exist happened to work
  // via a `??` fallback, but it invited someone to "fix" it into a real bug.)
  //
  // An eye-level render is a furnished photograph of a real listing, so it carries the
  // same disclosure obligation a staged photo does and the model does not get to opt out
  // of it. A top-down plan render is a diagram, so there the routing decision stands.
  const enabled = normalizeCadViewForStamp(cadRequest) === 'eye-level' || !!disclosure;
  return { enabled, lang, style, scale };
}

/** The requested view, defaulted the same way cad-handling.js defaults it. */
function normalizeCadViewForStamp(cadRequest) {
  return cadRequest?.view === 'eye-level' ? 'eye-level' : 'top-down';
}

/**
 * Build the new-image dispatch bundle: produce NEW images from AI action
 * requests that skip the staging-precedence logic — text-to-image generation
 * and CAD blueprint → render.
 * @param {{ DEBUG_MODE: boolean, annotateImage: (dataUrl: string, isCad?: boolean) => Promise<string|null>, getGeminiImageModel: (model: string) => string, processImageGeneration: (prompt: string, req: import('express').Request, model: string) => Promise<string|null>, blueprintTo3D: (image: Buffer, options?: import('../types/image.js').BlueprintRenderOptions) => Promise<Buffer>, incPromptCount?: () => void, renderPersistence?: any }} deps - Injected dependencies.
 * @returns {{ runGenerateRequests: Function, runCadRequests: Function }} The new-image dispatch bundle.
 */
export default function createImageDispatch(deps) {
  const {
    DEBUG_MODE, annotateImage, getGeminiImageModel, processImageGeneration, blueprintTo3D,
    // Both optional so an older caller (and every existing spec's deps bag) keeps working:
    // absent, this slice behaves exactly as it did before — which is the bug, but a
    // missing collaborator must degrade, not throw, on a paid turn.
    incPromptCount = null,
    renderPersistence = null,
  } = deps;

  /**
   * Run the AI's generate request(s) (single or array, capped at 3, filtered to
   * shouldGenerate && prompt). Per-image errors are swallowed so the loop
   * continues; textSuffix is an apology set only when requests existed but every
   * requested generation produced zero images.
   * @param {{ generateRequestFromAI: import('../types/chat.js').GenerateRequest | import('../types/chat.js').GenerateRequest[] | null, req: import('express').Request, selectedModel: string }} args - AI generate decision (single or array), the request, and the model.
   * @returns {Promise<{ generatedImages: import('../types/chat.js').GeneratedImageResult[], textSuffix: string }>} Generated images (each { image, annotationPromise }) and an apology suffix when every generation failed.
   */
  async function runGenerateRequests({ generateRequestFromAI, req, selectedModel }) {
    const generatedImages = [];
    let textSuffix = '';

    if (generateRequestFromAI) {
      // Normalize to array (max 3)
      const generateRequests = Array.isArray(generateRequestFromAI)
        ? generateRequestFromAI.slice(0, 3).filter(g => g.shouldGenerate && g.prompt)
        : (generateRequestFromAI.shouldGenerate && generateRequestFromAI.prompt ? [generateRequestFromAI] : []);

      if (generateRequests.length > 0) {
        if (DEBUG_MODE) {
          logger.debug(`[Image Generation] Processing ${generateRequests.length} generation request(s) from AI`);
        }

        for (let i = 0; i < generateRequests.length; i++) {
          const genRequest = generateRequests[i];
          // The shouldGenerate/prompt filter above guarantees a prompt, but that
          // doesn't narrow the element type — pin it to a string local.
          const prompt = genRequest.prompt;
          if (!prompt) continue;
          try {
            if (DEBUG_MODE) {
              logger.debug(`[Image Generation] Processing generation request ${i + 1}/${generateRequests.length}:`, prompt.substring(0, 100) + '...');
            }
            const geminiModel = getGeminiImageModel(selectedModel);
            const generatedImage = await processImageGeneration(prompt, req, geminiModel);
            if (generatedImage) {
              // Annotate generated image in parallel
              const annotationPromise = annotateImage(generatedImage).then(annotation => {
                if (DEBUG_MODE) {
                  logger.debug(`[Image Annotation] Annotation for generated image ${i + 1}: ${annotation || 'failed'}`);
                }
                return annotation;
              }).catch(err => {
                logger.error(`[Image Annotation] Error annotating generated image ${i + 1}:`, err);
                return null;
              });

              generatedImages.push({
                image: generatedImage,
                annotationPromise: annotationPromise
              });
              if (DEBUG_MODE) {
                logger.debug(`[Image Generation] Successfully generated image ${i + 1}/${generateRequests.length}`);
              }
            }
          } catch (error) {
            logger.error(`[Image Generation] Error generating image ${i + 1}:`, error);
            // Continue with other images if one fails
          }
        }

        if (generateRequests.length > 0 && generatedImages.length === 0) {
          textSuffix = '\n\nSorry, I encountered an error while generating the images. Please try again.';
        }
      }
    }

    return { generatedImages, textSuffix };
  }

  /**
   * Run the AI's CAD request(s) (single or array, capped at 3, filtered to
   * shouldProcessCAD): resolve the blueprint index, decode the blueprint plus
   * any furniture-reference buffers from history data URLs, and render via
   * blueprintTo3D. Per-item errors continue; the apology suffix is appended only
   * when a lone request (cadRequests.length === 1) fails.
   * @param {{ cadRequestFromAI: import('../types/chat.js').CadRequest | import('../types/chat.js').CadRequest[] | null, history: import('../types/chat.js').ChatMessage[], baseImageIndex: number | null, currentMessageHasImage: boolean, req?: import('express').Request, user?: any }} args - AI CAD decision plus history/selection context; `req` carries the site language for the disclosure badge and `user` is the account the gallery rows belong to.
   * @returns {Promise<{ cadResults: import('../types/chat.js').CadResult[], textSuffix: string }>} CAD render results (each { cadImage, params, annotationPromise }) and an apology suffix on a lone failure.
   */
  async function runCadRequests({ cadRequestFromAI, history, baseImageIndex, currentMessageHasImage, req, user }) {
    const cadResults = [];
    let textSuffix = '';
    /** Accumulated for ONE gallery block after the loop — see persistCadToGallery. */
    const pendingGallery = [];

    if (cadRequestFromAI) {
      // Normalize to array (max 3)
      const cadRequests = Array.isArray(cadRequestFromAI)
        ? cadRequestFromAI.slice(0, 3).filter(c => c.shouldProcessCAD)
        : (cadRequestFromAI.shouldProcessCAD ? [cadRequestFromAI] : []);

      if (cadRequests.length > 0) {
        if (DEBUG_MODE) {
          logger.debug(`[CAD] Processing ${cadRequests.length} CAD request(s) from AI`);
        }

        for (let i = 0; i < cadRequests.length; i++) {
          const cadRequest = cadRequests[i];
          // Per-request, not per-turn: each entry references its own furniture, so a miss
          // must be reported against the render it actually affected.
          let missingFurniture = 0;
          if (DEBUG_MODE) {
            logger.debug(`[CAD] Processing CAD request ${i + 1}/${cadRequests.length}:`, cadRequest);
          }

          try {
            const imageIndex = resolveCadImageIndex(cadRequest, baseImageIndex, history, currentMessageHasImage);
            if (DEBUG_MODE) {
              logger.debug(`[CAD] Processing CAD request from AI, index: ${imageIndex}`);
            }

            // Retrieve the blueprint image from conversation history
            const blueprintImage = getImageFromHistory(history, imageIndex);

            if (blueprintImage && blueprintImage.url) {
              if (DEBUG_MODE) {
                logger.debug(`[CAD] Found blueprint image at index ${imageIndex}`);
              }

              // Extract base64 data from the image URL
              const base64Data = blueprintImage.url.split(',')[1];
              if (base64Data) {
                const imageBuffer = Buffer.from(base64Data, 'base64');
                const mimeType = blueprintImage.url.match(/data:([^;]+)/)?.[1] || 'image/png';

                // Retrieve furniture images if specified
                const furnitureImages = [];
                if (cadRequest.furnitureImageIndex !== null && cadRequest.furnitureImageIndex !== undefined) {
                  const furnitureIndices = Array.isArray(cadRequest.furnitureImageIndex)
                    ? cadRequest.furnitureImageIndex
                    : [cadRequest.furnitureImageIndex];

                  // BOUND-CHECK before resolving. getImageFromHistory does NOT return null
                  // for an out-of-range index — it falls back to index 0 (see
                  // chat-image-collection.js). That fallback is right for "which room did
                  // you mean", and actively wrong here: an index the model got wrong
                  // resolved to the most recent image, which for a CAD turn is THE
                  // BLUEPRINT ITSELF, so the plan was handed back to the renderer as a
                  // furniture reference. The old code's DEBUG-only "not found" log could
                  // never fire.
                  const availableImages = collectImagesFromHistory(history).length;

                  // A reference the user asked for and did NOT get is a change to the
                  // deliverable, so it is counted and reported rather than debug-logged.
                  for (const furnitureIndex of furnitureIndices) {
                    if (furnitureIndex !== null && furnitureIndex !== undefined) {
                      const inRange = Number.isInteger(furnitureIndex)
                        && furnitureIndex >= 0
                        && furnitureIndex < availableImages
                        && furnitureIndex !== imageIndex; // never the blueprint
                      const furnitureImage = inRange ? getImageFromHistory(history, furnitureIndex) : null;
                      const furnitureUrl = furnitureImage?.url || null;
                      const furnitureBase64Data = furnitureUrl ? furnitureUrl.split(',')[1] : null;
                      if (furnitureUrl && furnitureBase64Data) {
                        const furnitureBuffer = Buffer.from(furnitureBase64Data, 'base64');
                        const furnitureMimeType = furnitureUrl.match(/data:([^;]+)/)?.[1] || 'image/png';
                        furnitureImages.push({
                          image: furnitureBuffer,
                          mimeType: furnitureMimeType
                        });
                        if (DEBUG_MODE) {
                          logger.debug(`[CAD] Found furniture image at index ${furnitureIndex}`);
                        }
                      } else {
                        missingFurniture += 1;
                        if (DEBUG_MODE) {
                          logger.debug(`[CAD] Furniture image at index ${furnitureIndex} not found`);
                        }
                      }
                    }
                  }
                }

                if (DEBUG_MODE) {
                  logger.debug(`[CAD] Processing blueprint with CAD function${furnitureImages.length > 0 ? ` (with ${furnitureImages.length} furniture image(s))` : ''}${cadRequest.additionalPrompt ? ` (with additional prompt: ${cadRequest.additionalPrompt.substring(0, 50)}...)` : ''}...`);
                }
                // Process the blueprint through CAD function
                const additionalPrompt = cadRequest.additionalPrompt || null;
                const view = cadRequest.view === 'eye-level' ? 'eye-level' : 'top-down';
                // The model's own output, before the delivery upscale — the bytes the
                // gallery stores. Only wired when there is somewhere to put them, so
                // nothing is captured when the gallery is off.
                let native = null;
                const wantNative = Boolean(renderPersistence?.enabled() && user);
                const cadResultBuffer = await blueprintTo3D(imageBuffer, {
                  mimeType,
                  furnitureImages,
                  additionalPrompt,
                  view,
                  room: cadRequest.room || null,
                  stamp: stampFromCadRouting(cadRequest, req),
                  onNative: wantNative ? (buffer) => { native = { buffer }; } : null,
                });

                // Convert result buffer to data URL. Label it with the RENDER's own
                // format, never the blueprint's: parseGeminiResponse discards the
                // part's mimeType, so this used to reuse `mimeType` from the input and
                // a JPEG floor plan produced `data:image/jpeg;base64,<PNG bytes>`.
                // OpenAI vision validates the declared type against the bytes, so the
                // annotateImage call below failed for every non-PNG blueprint —
                // swallowed by its own .catch — and downloads got the wrong extension.
                const cadImageBase64 = cadResultBuffer.toString('base64');
                const cadMimeType = await detectImageMimeType(cadResultBuffer);
                const cadImageForDisplay = `data:${cadMimeType};base64,${cadImageBase64}`;

                // Annotate in parallel — and the CAD flag is PER VIEW, not always true.
                //
                // The flag decides which pipeline a FOLLOW-UP takes: the system instruction
                // says an image marked "CAD: True" must re-enter CAD-staging rather than
                // normal staging. That is right for a top-down plan render, which is still
                // a plan view and re-renders coherently.
                //
                // It is wrong for eye-level. That output is an ordinary interior
                // photograph, so marking it CAD:True sent "make the sofa leather" back into
                // blueprintTo3D — handing a PHOTOGRAPH to a prompt that opens "the image
                // provided is a 2D top-down floor plan, read it as a set of measurements".
                // Marked false, refinements go to normal staging, which is exactly the
                // pipeline built for editing a room photo.
                const annotationPromise = annotateImage(cadImageForDisplay, view === 'top-down').then(annotation => {
                  if (DEBUG_MODE) {
                    logger.debug(`[Image Annotation] Annotation for CAD render ${i + 1}: ${annotation || 'failed'}`);
                  }
                  return annotation;
                }).catch(err => {
                  logger.error(`[Image Annotation] Error annotating CAD render ${i + 1}:`, err);
                  return null;
                });

                cadResults.push({
                  cadImage: cadImageForDisplay,
                  params: cadRequest,
                  annotationPromise: annotationPromise
                });

                // Count the render. A blueprint render is a gemini-3-pro-image call —
                // the most expensive model in the app — and it was the only image-
                // producing path that never incremented anything.
                if (typeof incPromptCount === 'function') incPromptCount();

                // Accumulated, not persisted here: one block after the loop keeps the
                // gallery out of the hot path, mirroring chat-staging.js.
                if (native) {
                  pendingGallery.push({
                    // The NATIVE bytes, not `cadResultBuffer` — that one is the delivered
                    // upscale, which render-persistence.js explicitly never stores.
                    native,
                    sourceBuffer: imageBuffer,
                    params: cadRequest,
                    view,
                    room: cadRequest.room || null,
                    // HistoryImage carries `filename` only — the raw upload's
                    // `originalname` is normalized into it upstream.
                    sourceName: blueprintImage.filename || 'Floor plan',
                  });
                }

                if (missingFurniture > 0) {
                  textSuffix += missingFurniture === 1
                    ? '\n\nI couldn\'t find one of the furniture photos you referenced, so it isn\'t in this render. Re-upload it and I\'ll add it in.'
                    : `\n\nI couldn't find ${missingFurniture} of the furniture photos you referenced, so they aren't in this render. Re-upload them and I'll add them in.`;
                }

                if (DEBUG_MODE) {
                  logger.debug(`[CAD] Successfully generated ${view} render ${i + 1}/${cadRequests.length} from blueprint${furnitureImages.length > 0 ? ' with furniture' : ''}`);
                }
              } else {
                // Both this branch and the one below used to return NOTHING and set no
                // textSuffix, so the user got the routing model's cheerful "Here's your
                // render!" with no image attached and no hint that anything went wrong.
                logger.error('[CAD] Failed to extract base64 data from the blueprint image');
                textSuffix += '\n\nI couldn\'t read that floor plan image — the file looks corrupted. Could you upload it again?';
              }
            } else {
              logger.error(`[CAD] Blueprint image at index ${imageIndex} not found`);
              textSuffix += '\n\nI couldn\'t find the floor plan I was meant to render. Could you upload it again, or point me at it in the thumbnail strip?';
            }
          } catch (error) {
            logger.error(`[CAD] Error processing CAD request ${i + 1}:`, error);
            // Continue with other CAD requests if one fails
            if (cadRequests.length === 1) {
              // The disclosure stamp fails CLOSED, so a stamp failure is a render that
              // SUCCEEDED and was withheld — not one that failed. Telling that user to
              // "try again" sends them back into the same wall, paying each time.
              textSuffix += error?.code === 'DISCLOSURE_STAMP_FAILED'
                ? CAD_DISCLOSURE_FAILURE_NOTE
                : '\n\nSorry, I encountered an error while processing the CAD blueprint. Please try again.';
            }
          }
        }

        persistCadToGallery({ pendingGallery, user });
      }
    }

    return { cadResults, textSuffix };
  }

  /**
   * Turn this turn's blueprint renders into gallery entries.
   *
   * ONE CALL PER RESULT sharing a batch id, for the same reason chat-staging.js does it
   * that way: the AI Designer's three CAD requests can each target a different floor plan
   * from the conversation, so batching them would put the wrong plan behind the
   * before/after slider.
   *
   * Wrapped whole and never rethrows — the user has already been charged for these
   * renders and already has the images in the chat. A history feature must not be able to
   * turn a successful paid turn into a 500.
   *
   * @param {{ pendingGallery: any[], user: any }} arg
   */
  function persistCadToGallery({ pendingGallery, user }) {
    if (!pendingGallery.length || !renderPersistence?.enabled() || !user) return;
    try {
      const batchId = newRenderId();
      pendingGallery.forEach((item, index) => {
        const pending = renderPersistence.recordPending({
          user,
          // Both chat endpoints sit behind requireProAccount, so there is no free branch.
          isPro: true,
          natives: [item.native],
          params: item.params,
          model: 'gemini-3-pro-image',
          batchId,
          variationBase: index,
          // A qualifier, because `view` is NOT a column — per the naming rule in
          // public/scripts/render-name.js, store a qualifier only for something the
          // schema cannot already derive. For eye-level that is the room, which is the
          // part that distinguishes two renders of the same plan.
          extra: {
            source: 'designer',
            sourceName: item.sourceName,
            qualifier: item.view === 'eye-level' ? (item.room || 'Interior view') : 'Floor plan',
          },
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
      logger.error('[gallery] could not record AI Designer blueprint renders; the chat turn is unaffected:', error);
    }
  }

  return { runGenerateRequests, runCadRequests };
}
