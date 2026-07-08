// Post-routing dispatch pipeline for the AI Designer chat endpoints.
//
// Both /api/chat and /api/chat-upload call OpenAI to get a routing decision,
// then run the SAME sequence of side-effecting steps on that decision:
// memory writes, image generation, staging, recall, image-request analysis,
// CAD rendering, and response assembly. Those steps used to be inlined (and
// duplicated) in each ~1,400-line handler. They are extracted here verbatim.
//
// The two handlers differ only in a few well-defined spots (which history
// array they read, how they resolve a "dual upload", and what the final
// image fallback is). Those differences are passed in as explicit params /
// small callbacks so each handler keeps its exact original behavior.
//
// NOTE: a handful of the original console.log calls were gated on DEBUG_MODE
// in one handler but not the other (pure logging inconsistencies). Here they
// are uniformly DEBUG_MODE-gated. No functional behavior changed.
import { DESIGNER_ROUTING_RESPONSE_FORMAT, DUAL_UPLOAD_ROOM_PROMPT_SUFFIX } from './prompts.js';
import { getImageFromHistory, getOriginalImageIndex, resolveCadImageIndex, applyAddFurnitureStagingFallback, applyBaseImageIndexToStagingParams } from './chat-history.js';
import { parseDesignerRoutingCompletion } from './chat-routing.js';

export default function createChatPipeline(deps) {
  const {
    DEBUG_MODE,
    openai,
    annotateImage,
    downscaleImageForGPT,
    getGeminiImageModel,
    getTemperatureForModel,
    processImageGeneration,
    processStaging,
    blueprintTo3D,
    incPromptCount,
    saveMemories,
  } = deps;

  // Await every result's annotationPromise and collect the non-null ones into
  // a { `${prefix}_${i}`: annotation } map. Replaces 6 identical inline loops.
  async function awaitAnnotations(results, prefix) {
    const out = {};
    for (let i = 0; i < results.length; i++) {
      if (results[i].annotationPromise) {
        const annotation = await results[i].annotationPromise;
        if (annotation) out[`${prefix}_${i}`] = annotation;
      }
    }
    return out;
  }

  // Apply the AI's memory stores/forgets against the user's memory list.
  // Reassigns `memories` internally (forget = filter), so callers must use the
  // returned `memories`. Returns { memories, memoryActions }.
  function applyMemoryActions({ memoryActionsFromAI, memories, userId, userMessageText }) {
    const memoryActions = { stores: [], forgets: [] };
    if (userMessageText && memoryActionsFromAI) {
      if (DEBUG_MODE) {
        console.log(`[Memory] Processing memory actions from AI response:`, memoryActionsFromAI);
      }

      // Process forget actions first
      if (memoryActionsFromAI.forgets && memoryActionsFromAI.forgets.length > 0) {
        // Check if user wants to forget all memories
        if (memoryActionsFromAI.forgets.includes('all')) {
          const forgottenCount = memories.length;
          memories = [];
          memoryActions.forgets = ['all'];
          if (DEBUG_MODE) {
            console.log(`Forgot ALL ${forgottenCount} memories for user ${userId}`);
          }
        } else {
          // Process individual memory forgets
          for (const memoryId of memoryActionsFromAI.forgets) {
            const initialLength = memories.length;
            // Try exact ID match first
            memories = memories.filter(m => m.id !== memoryId);

            if (memories.length < initialLength) {
              memoryActions.forgets.push(memoryId);
              if (DEBUG_MODE) {
                console.log(`Forgot memory with ID for user ${userId}:`, memoryId);
              }
            } else {
              // Try to find by content match if ID didn't work
              const memoryToForget = memories.find(m =>
                m.content.toLowerCase().includes(memoryId.toLowerCase()) ||
                memoryId.toLowerCase().includes(m.content.toLowerCase()) ||
                m.id.includes(memoryId) ||
                memoryId.includes(m.id)
              );

              if (memoryToForget) {
                memories = memories.filter(m => m.id !== memoryToForget.id);
                memoryActions.forgets.push(memoryToForget.id);
                if (DEBUG_MODE) {
                  console.log(`Forgot memory for user ${userId}:`, memoryToForget.content);
                }
              }
            }
          }
        }
      }

      // Process store actions
      if (memoryActionsFromAI.stores && memoryActionsFromAI.stores.length > 0) {
        for (const memoryContent of memoryActionsFromAI.stores) {
          if (memoryContent && memoryContent.trim()) {
            const newMemory = {
              id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
              content: memoryContent.trim(),
              timestamp: new Date().toISOString(),
              userMessage: userMessageText.substring(0, 100) // Store first 100 chars for context
            };
            memories.push(newMemory);
            memoryActions.stores.push(newMemory.content);
            if (DEBUG_MODE) {
              console.log(`Stored new memory for user ${userId}:`, newMemory.content);
            }
          }
        }
      }

      // Save memories if any changes were made
      if (memoryActions.stores.length > 0 || memoryActions.forgets.length > 0) {
        saveMemories(userId, memories);
      }
    }
    return { memories, memoryActions };
  }

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
          console.log(`[Image Generation] Processing ${generateRequests.length} generation request(s) from AI`);
        }

        for (let i = 0; i < generateRequests.length; i++) {
          const genRequest = generateRequests[i];
          try {
            if (DEBUG_MODE) {
              console.log(`[Image Generation] Processing generation request ${i + 1}/${generateRequests.length}:`, genRequest.prompt.substring(0, 100) + '...');
            }
            const geminiModel = getGeminiImageModel(selectedModel);
            const generatedImage = await processImageGeneration(genRequest.prompt, req, geminiModel);
            if (generatedImage) {
              // Annotate generated image in parallel
              const annotationPromise = annotateImage(generatedImage).then(annotation => {
                if (DEBUG_MODE) {
                  console.log(`[Image Annotation] Annotation for generated image ${i + 1}: ${annotation || 'failed'}`);
                }
                return annotation;
              }).catch(err => {
                console.error(`[Image Annotation] Error annotating generated image ${i + 1}:`, err);
                return null;
              });

              generatedImages.push({
                image: generatedImage,
                annotationPromise: annotationPromise
              });
              if (DEBUG_MODE) {
                console.log(`[Image Generation] Successfully generated image ${i + 1}/${generateRequests.length}`);
              }
            }
          } catch (error) {
            console.error(`[Image Generation] Error generating image ${i + 1}:`, error);
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

  // Recall (retrieve + display, no analysis) a previous image by index.
  // Returns the image data URL or null.
  function resolveRecalledImage({ recallRequestFromAI, history }) {
    let recalledImageForDisplay = null;
    if (recallRequestFromAI && recallRequestFromAI.shouldRecall) {
      try {
        const imageIndex = typeof recallRequestFromAI.imageIndex === 'number' ? recallRequestFromAI.imageIndex : 0;
        if (DEBUG_MODE) {
          console.log(`[Recall] Processing recall request from AI, index: ${imageIndex}`);
        }

        // Retrieve the image from conversation history
        const recalledImage = getImageFromHistory(history, imageIndex);

        if (recalledImage && recalledImage.url) {
          if (DEBUG_MODE) {
            console.log(`[Recall] Found image at index ${imageIndex}`);
          }
          recalledImageForDisplay = recalledImage.url;
        } else {
          if (DEBUG_MODE) {
            console.log(`[Recall] Image at index ${imageIndex} not found`);
          }
        }
      } catch (error) {
        console.error('Error processing recall request:', error);
        // Continue with original response if recall fails
      }
    }
    return recalledImageForDisplay;
  }

  // Handle an image-request: always return the image for display; if the user
  // asked to describe/analyze it, make a second GPT call and return the new
  // reply text. Returns { requestedImageForDisplay, text }.
  // `userMessageText` drives the analyze-vs-view decision; `analysisUserText`
  // is the text placed in the analysis GPT call.
  async function resolveRequestedImage({
    imageRequestFromAI,
    history,
    baseMessages,
    systemInstruction,
    userMessageText,
    analysisUserText,
    selectedModel,
    text,
  }) {
    let requestedImageForDisplay = null;
    if (imageRequestFromAI && imageRequestFromAI.requestImage) {
      try {
        const imageIndex = typeof imageRequestFromAI.imageIndex === 'number' ? imageRequestFromAI.imageIndex : 0;
        if (DEBUG_MODE) {
          console.log(`[Image Request] Processing image request from AI, index: ${imageIndex}`);
        }

        // Retrieve the image from conversation history
        const requestedImage = getImageFromHistory(history, imageIndex);

        if (requestedImage && requestedImage.url) {
          if (DEBUG_MODE) {
            console.log(`[Image Request] Found image at index ${imageIndex}`);
          }

          // Store the image URL to return in response for display
          requestedImageForDisplay = requestedImage.url;

          // Check if user wants to analyze/describe the image (vs just view it)
          // Only analyze if explicitly asking for description/analysis, not just "show me"
          const messageLower = userMessageText.toLowerCase();
          const wantsAnalysis = (messageLower.includes('describe') && !messageLower.includes('show')) ||
                               (messageLower.includes('analyze') && !messageLower.includes('show')) ||
                               (messageLower.includes('what') && messageLower.includes('in') && !messageLower.includes('show')) ||
                               messageLower.includes('tell me about') ||
                               (messageLower.includes('explain') && !messageLower.includes('show'));

          if (wantsAnalysis) {
            if (DEBUG_MODE) {
              console.log(`[Image Request] User wants analysis, sending to GPT for analysis`);
            }
            // Make another GPT call with the image for analysis
            const imageAnalysisMessages = [
              { role: 'system', content: systemInstruction },
              ...baseMessages.slice(1), // Skip the original system message, keep the rest
              {
                role: 'user',
                content: [
                  { type: 'text', text: analysisUserText },
                  {
                    type: 'image_url',
                    image_url: {
                      url: await downscaleImageForGPT(requestedImage.url)
                    }
                  }
                ]
              }
            ];

            const imageAnalysisCompletion = await openai.chat.completions.create({
              model: selectedModel,
              messages: imageAnalysisMessages,
              temperature: getTemperatureForModel(selectedModel),
              response_format: DESIGNER_ROUTING_RESPONSE_FORMAT
            });

            const imageAnalysisJson = parseDesignerRoutingCompletion(imageAnalysisCompletion);
            text = imageAnalysisJson.response || imageAnalysisCompletion.choices[0].message.content;

            if (DEBUG_MODE) {
              console.log(`[Image Request] Successfully analyzed image, response: ${text.substring(0, 100)}...`);
            }
          } else {
            // User just wants to see the image - keep the original text response
            if (DEBUG_MODE) {
              console.log(`[Image Request] User wants to view image, returning image for display`);
            }
          }
        } else {
          if (DEBUG_MODE) {
            console.log(`[Image Request] Image at index ${imageIndex} not found`);
          }
        }
      } catch (error) {
        console.error('Error processing image request:', error);
        // Continue with original response if image request fails
      }
    }
    return { requestedImageForDisplay, text };
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
          console.log(`[CAD] Processing ${cadRequests.length} CAD request(s) from AI`);
        }

        for (let i = 0; i < cadRequests.length; i++) {
          const cadRequest = cadRequests[i];
          if (DEBUG_MODE) {
            console.log(`[CAD] Processing CAD request ${i + 1}/${cadRequests.length}:`, cadRequest);
          }

          try {
            const imageIndex = resolveCadImageIndex(cadRequest, baseImageIndex, history, currentMessageHasImage);
            if (DEBUG_MODE) {
              console.log(`[CAD] Processing CAD request from AI, index: ${imageIndex}`);
            }

            // Retrieve the blueprint image from conversation history
            const blueprintImage = getImageFromHistory(history, imageIndex);

            if (blueprintImage && blueprintImage.url) {
              if (DEBUG_MODE) {
                console.log(`[CAD] Found blueprint image at index ${imageIndex}`);
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
                            console.log(`[CAD] Found furniture image at index ${furnitureIndex}`);
                          }
                        }
                      } else {
                        if (DEBUG_MODE) {
                          console.log(`[CAD] Furniture image at index ${furnitureIndex} not found`);
                        }
                      }
                    }
                  }
                }

                if (DEBUG_MODE) {
                  console.log(`[CAD] Processing blueprint with CAD function${furnitureImages.length > 0 ? ` (with ${furnitureImages.length} furniture image(s))` : ''}${cadRequest.additionalPrompt ? ` (with additional prompt: ${cadRequest.additionalPrompt.substring(0, 50)}...)` : ''}...`);
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
                    console.log(`[Image Annotation] Annotation for CAD render ${i + 1}: ${annotation || 'failed'}`);
                  }
                  return annotation;
                }).catch(err => {
                  console.error(`[Image Annotation] Error annotating CAD render ${i + 1}:`, err);
                  return null;
                });

                cadResults.push({
                  cadImage: cadImageForDisplay,
                  params: cadRequest,
                  annotationPromise: annotationPromise
                });

                if (DEBUG_MODE) {
                  console.log(`[CAD] Successfully generated 3D render ${i + 1}/${cadRequests.length} from blueprint${furnitureImages.length > 0 ? ' with furniture' : ''}`);
                }
              } else {
                if (DEBUG_MODE) {
                  console.log(`[CAD] Failed to extract base64 data from blueprint image`);
                }
              }
            } else {
              if (DEBUG_MODE) {
                console.log(`[CAD] Blueprint image at index ${imageIndex} not found`);
              }
            }
          } catch (error) {
            if (DEBUG_MODE) {
              console.error(`[CAD] Error processing CAD request ${i + 1}:`, error);
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
          console.log(`[Staging] Processing ${stagingRequests.length} staging request(s) from AI`);
        }

        for (let i = 0; i < stagingRequests.length; i++) {
          const stagingRequest = stagingRequests[i];
          if (DEBUG_MODE) {
            console.log(`[Staging] Processing staging request ${i + 1}/${stagingRequests.length}:`, stagingRequest);
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
                  console.log(`[Staging] Fallback: User mentioned "original" but AI didn't set usePreviousImage. Overriding to use original image at index ${originalImageIndex}`);
                }
                stagingParams.usePreviousImage = originalImageIndex;
              } else {
                // If no original found, use most recent (index 0)
                if (DEBUG_MODE) {
                  console.log(`[Staging] Fallback: User mentioned "original" but no original image found. Using most recent image (index 0) as fallback`);
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
                  console.log(`[Staging] Looking for image at index ${imageIndex}`);
                }

                const previousImage = getImageFromHistory(history, imageIndex);

                if (previousImage && previousImage.url) {
                  const base64Data = previousImage.url.split(',')[1];
                  if (base64Data) {
                    imageBuffer = Buffer.from(base64Data, 'base64');
                    imageSource = previousImage.isStaged ? `staged image (index ${imageIndex})` : `user-uploaded image (index ${imageIndex})`;
                    if (DEBUG_MODE) {
                      console.log(`[Staging] Using previous ${imageSource}`);
                    }
                  } else {
                    if (DEBUG_MODE) {
                      console.log(`[Staging] Previous image found but base64 data extraction failed`);
                    }
                  }
                } else {
                  if (DEBUG_MODE) {
                    console.log(`[Staging] Previous image at index ${imageIndex} not found`);
                  }
                  // Fallback: try to use the most recent image (index 0) if requested index doesn't exist
                  if (imageIndex > 0) {
                    if (DEBUG_MODE) {
                      console.log(`[Staging] Attempting fallback to index 0`);
                    }
                    const fallbackImage = getImageFromHistory(history, 0);
                    if (fallbackImage && fallbackImage.url) {
                      const base64Data0 = fallbackImage.url.split(',')[1];
                      if (base64Data0) {
                        imageBuffer = Buffer.from(base64Data0, 'base64');
                        imageSource = fallbackImage.isStaged ? `staged image (fallback to index 0)` : `user-uploaded image (fallback to index 0)`;
                        if (DEBUG_MODE) {
                          console.log(`[Staging] Using fallback ${imageSource}`);
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
                    console.log(fb.logMessage);
                  }
                }
              }

              // Retrieve furniture image if specified (skip if dual upload already set furniture buffers)
              if (!dualUpload && !furnitureImageBuffer && stagingParams.furnitureImageIndex !== null && stagingParams.furnitureImageIndex !== undefined) {
                const furnitureIndex = typeof stagingParams.furnitureImageIndex === 'number' ? stagingParams.furnitureImageIndex : null;
                if (furnitureIndex !== null) {
                  if (DEBUG_MODE) {
                    console.log(`[Staging] Looking for furniture image at index ${furnitureIndex}`);
                  }
                  const furnitureImage = getImageFromHistory(history, furnitureIndex);

                  if (furnitureImage && furnitureImage.url) {
                    const base64Data = furnitureImage.url.split(',')[1];
                    if (base64Data) {
                      furnitureImageBuffer = Buffer.from(base64Data, 'base64');
                      if (DEBUG_MODE) {
                        console.log(`[Staging] Found furniture image at index ${furnitureIndex}`);
                      }
                    }
                  } else {
                    if (DEBUG_MODE) {
                      console.log(`[Staging] Furniture image at index ${furnitureIndex} not found`);
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
                        console.log(`[Image Annotation] Annotation for staged image ${i + 1}: ${annotation || 'failed'}`);
                      }
                      return annotation;
                    }).catch(err => {
                      console.error(`[Image Annotation] Error annotating staged image ${i + 1}:`, err);
                      return null;
                    });

                    stagingResults.push({
                      stagedImage: stagedImage,
                      params: stagingParams,
                      annotationPromise: annotationPromise
                    });
                    if (DEBUG_MODE) {
                      console.log(`[Staging] Successfully processed staging ${i + 1}/${stagingRequests.length} for user ${userId} from ${imageSource}${furnitureImageBuffer ? ' with furniture image' : ''}`);
                    }
                  }
                } catch (stagingError) {
                  console.error(`[Staging] Error processing staging ${i + 1}:`, stagingError);
                  console.error(`[Staging] Error stack:`, stagingError.stack);
                  // Continue with other staging requests if one fails
                  if (stagingRequests.length === 1) {
                    textSuffix += '\n\nSorry, I encountered an error while staging the room. Please try again.';
                  }
                }
              } else {
                if (DEBUG_MODE) {
                  console.log(`[Staging] No image found for staging ${i + 1}`);
                }
                if (stagingRequests.length === 1) {
                  textSuffix += '\n\nSorry, I couldn\'t find the image to stage. Please make sure you\'ve uploaded an image.';
                }
              }
            } catch (error) {
              console.error(`[Staging] Error in staging request ${i + 1}:`, error);
              console.error(`[Staging] Error stack:`, error.stack);
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

  // Assemble the JSON response body from all dispatch results, awaiting the
  // image annotations. `extraFields` are top-level fields inserted right after
  // `response` (e.g. { files } for the upload endpoint); `imageAnnotations` is
  // the upload endpoint's per-upload annotation map.
  async function buildDesignerResponse({
    text,
    memoryActions,
    stagingResults,
    generatedImages,
    requestedImageForDisplay,
    recalledImageForDisplay,
    cadResults,
    extraFields = {},
    imageAnnotations = null,
  }) {
    const response = {
      response: text,
      ...extraFields,
      memories: memoryActions
    };

    // Handle multiple staging results
    const stagedImageAnnotations = await awaitAnnotations(stagingResults, 'staged');
    if (stagingResults.length > 0) {
      if (stagingResults.length === 1) {
        // Single result - maintain backward compatibility
        response.stagedImage = stagingResults[0].stagedImage;
        response.stagingParams = stagingResults[0].params;
      } else {
        // Multiple results - return as array
        response.stagedImages = stagingResults.map(r => r.stagedImage);
        response.stagingParams = stagingResults.map(r => r.params);
      }
      // Include annotations if available
      if (Object.keys(stagedImageAnnotations).length > 0) {
        response.stagedImageAnnotations = stagedImageAnnotations;
      }
    }

    // Handle multiple generated images
    const generatedImageAnnotations = await awaitAnnotations(generatedImages, 'generated');
    if (generatedImages.length > 0) {
      if (generatedImages.length === 1) {
        // Single result - maintain backward compatibility
        response.generatedImage = generatedImages[0].image || generatedImages[0];
      } else {
        // Multiple results - return as array
        response.generatedImages = generatedImages.map(g => g.image || g);
      }
      // Include annotations if available
      if (Object.keys(generatedImageAnnotations).length > 0) {
        response.generatedImageAnnotations = generatedImageAnnotations;
      }
    }

    if (requestedImageForDisplay) {
      response.requestedImage = requestedImageForDisplay;
    }

    if (recalledImageForDisplay) {
      response.recalledImage = recalledImageForDisplay;
    }

    // Handle multiple CAD results
    const cadImageAnnotations = await awaitAnnotations(cadResults, 'cad');
    if (cadResults.length > 0) {
      if (cadResults.length === 1) {
        // Single result - maintain backward compatibility
        response.cadImage = cadResults[0].cadImage;
        const cadImageAnnotation = cadResults[0].annotationPromise ? await cadResults[0].annotationPromise : null;
        if (cadImageAnnotation) {
          response.cadImageAnnotation = cadImageAnnotation;
        }
      } else {
        // Multiple results - return as array
        response.cadImages = cadResults.map(r => r.cadImage);
        response.cadParams = cadResults.map(r => r.params);
      }
      // Include annotations if available
      if (Object.keys(cadImageAnnotations).length > 0) {
        response.cadImageAnnotations = cadImageAnnotations;
      }
    }

    if (imageAnnotations && Object.keys(imageAnnotations).length > 0) {
      response.imageAnnotations = imageAnnotations;
    }

    return response;
  }

  return {
    applyMemoryActions,
    runGenerateRequests,
    resolveRecalledImage,
    resolveRequestedImage,
    runCadRequests,
    runStagingRequests,
    buildDesignerResponse,
  };
}
