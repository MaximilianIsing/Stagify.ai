// Image-retrieval slice of the AI Designer pipeline (lib/chat/chat-pipeline.js):
// retrieve an already-existing history image by index. resolveRecalledImage
// only displays; resolveRequestedImage optionally re-runs GPT to analyze it.
//
// deps: { DEBUG_MODE, openai, downscaleImageForGPT, getTemperatureForModel }
import { DESIGNER_ROUTING_RESPONSE_FORMAT } from '../staging/prompts.js';
import { getImageFromHistory } from './chat-history.js';
import { parseDesignerRoutingCompletion } from './chat-routing.js';
import { logger } from '../logger.js';

export default function createImageRetrieval(deps) {
  const { DEBUG_MODE, openai, downscaleImageForGPT, getTemperatureForModel } = deps;

  // Recall (retrieve + display, no analysis) a previous image by index.
  // Returns the image data URL or null.
  function resolveRecalledImage({ recallRequestFromAI, history }) {
    let recalledImageForDisplay = null;
    if (recallRequestFromAI && recallRequestFromAI.shouldRecall) {
      try {
        const imageIndex = typeof recallRequestFromAI.imageIndex === 'number' ? recallRequestFromAI.imageIndex : 0;
        if (DEBUG_MODE) {
          logger.debug(`[Recall] Processing recall request from AI, index: ${imageIndex}`);
        }

        // Retrieve the image from conversation history
        const recalledImage = getImageFromHistory(history, imageIndex);

        if (recalledImage && recalledImage.url) {
          if (DEBUG_MODE) {
            logger.debug(`[Recall] Found image at index ${imageIndex}`);
          }
          recalledImageForDisplay = recalledImage.url;
        } else {
          if (DEBUG_MODE) {
            logger.debug(`[Recall] Image at index ${imageIndex} not found`);
          }
        }
      } catch (error) {
        logger.error('Error processing recall request:', error);
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
          logger.debug(`[Image Request] Processing image request from AI, index: ${imageIndex}`);
        }

        // Retrieve the image from conversation history
        const requestedImage = getImageFromHistory(history, imageIndex);

        if (requestedImage && requestedImage.url) {
          if (DEBUG_MODE) {
            logger.debug(`[Image Request] Found image at index ${imageIndex}`);
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
              logger.debug(`[Image Request] User wants analysis, sending to GPT for analysis`);
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
              logger.debug(`[Image Request] Successfully analyzed image, response: ${text.substring(0, 100)}...`);
            }
          } else {
            // User just wants to see the image - keep the original text response
            if (DEBUG_MODE) {
              logger.debug(`[Image Request] User wants to view image, returning image for display`);
            }
          }
        } else {
          if (DEBUG_MODE) {
            logger.debug(`[Image Request] Image at index ${imageIndex} not found`);
          }
        }
      } catch (error) {
        logger.error('Error processing image request:', error);
        // Continue with original response if image request fails
      }
    }
    return { requestedImageForDisplay, text };
  }

  return { resolveRecalledImage, resolveRequestedImage };
}
