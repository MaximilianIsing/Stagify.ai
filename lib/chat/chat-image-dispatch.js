// Image-dispatch slice of the AI Designer pipeline (lib/chat/chat-pipeline.js):
// produce NEW images from AI action requests that do not need the staging
// precedence logic — text-to-image generation and CAD blueprint → 3D render.
//
// deps: { DEBUG_MODE, annotateImage, getGeminiImageModel, processImageGeneration, blueprintTo3D }
import { getImageFromHistory, resolveCadImageIndex } from './chat-history.js';
import { logger } from '../logger.js';

export default function createImageDispatch(deps) {
  const { DEBUG_MODE, annotateImage, getGeminiImageModel, processImageGeneration, blueprintTo3D } = deps;

  // Run the AI's generate request(s) (single or array, max 3). Returns
  // { generatedImages, textSuffix } — textSuffix is appended to the reply when
  // every requested generation failed.
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
          try {
            if (DEBUG_MODE) {
              logger.debug(`[Image Generation] Processing generation request ${i + 1}/${generateRequests.length}:`, genRequest.prompt.substring(0, 100) + '...');
            }
            const geminiModel = getGeminiImageModel(selectedModel);
            const generatedImage = await processImageGeneration(genRequest.prompt, req, geminiModel);
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

  // Run the AI's CAD request(s) (single or array, max 3): resolve the blueprint
  // index, gather any furniture references, and render via blueprintTo3D.
  // Returns { cadResults, textSuffix }.
  async function runCadRequests({ cadRequestFromAI, history, baseImageIndex, currentMessageHasImage }) {
    const cadResults = [];
    let textSuffix = '';

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

                  for (const furnitureIndex of furnitureIndices) {
                    if (furnitureIndex !== null && furnitureIndex !== undefined) {
                      const furnitureImage = getImageFromHistory(history, furnitureIndex);
                      if (furnitureImage && furnitureImage.url) {
                        const furnitureBase64Data = furnitureImage.url.split(',')[1];
                        if (furnitureBase64Data) {
                          const furnitureBuffer = Buffer.from(furnitureBase64Data, 'base64');
                          const furnitureMimeType = furnitureImage.url.match(/data:([^;]+)/)?.[1] || 'image/png';
                          furnitureImages.push({
                            image: furnitureBuffer,
                            mimeType: furnitureMimeType
                          });
                          if (DEBUG_MODE) {
                            logger.debug(`[CAD] Found furniture image at index ${furnitureIndex}`);
                          }
                        }
                      } else {
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
                const cadResultBuffer = await blueprintTo3D(imageBuffer, mimeType, furnitureImages, additionalPrompt);

                // Convert result buffer to data URL
                const cadImageBase64 = cadResultBuffer.toString('base64');
                const cadImageForDisplay = `data:${mimeType};base64,${cadImageBase64}`;

                // Annotate CAD image in parallel
                const annotationPromise = annotateImage(cadImageForDisplay, true).then(annotation => {
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

                if (DEBUG_MODE) {
                  logger.debug(`[CAD] Successfully generated 3D render ${i + 1}/${cadRequests.length} from blueprint${furnitureImages.length > 0 ? ' with furniture' : ''}`);
                }
              } else {
                if (DEBUG_MODE) {
                  logger.debug(`[CAD] Failed to extract base64 data from blueprint image`);
                }
              }
            } else {
              if (DEBUG_MODE) {
                logger.debug(`[CAD] Blueprint image at index ${imageIndex} not found`);
              }
            }
          } catch (error) {
            if (DEBUG_MODE) {
              logger.error(`[CAD] Error processing CAD request ${i + 1}:`, error);
            }
            // Continue with other CAD requests if one fails
            if (cadRequests.length === 1) {
              textSuffix += '\n\nSorry, I encountered an error while processing the CAD blueprint. Please try again.';
            }
          }
        }
      }
    }

    return { cadResults, textSuffix };
  }

  return { runGenerateRequests, runCadRequests };
}
