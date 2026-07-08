// GPT-vision image annotation (description + CAD/blueprint classification).
// Factory injects the OpenAI client; the rest are direct imports. Extracted from server.js.
import { DEBUG_MODE } from '../config/runtime-flags.js';
import { downscaleImageForGPT } from './image-primitives.js';

export function createImageAnnotation({ openai }) {
  async function annotateImage(imageDataUrl, isCAD = false, detectBlueprint = false) {
    try {
      if (!openai) {
        if (DEBUG_MODE) {
          console.log('[Image Annotation] OpenAI not initialized, skipping annotation');
        }
        return null;
      }
      
      // Downscale image first to save tokens
      const downscaledUrl = await downscaleImageForGPT(imageDataUrl);
      
      // Build prompt based on whether we need to detect blueprint
      let promptText = 'Briefly describe this image in 5-10 words. Then, on a new line, answer: "CAD: True" if this is a blueprint, floor plan, or architectural drawing (top-down 2D plan view), or "CAD: False" if it is a normal room photo or 3D interior view.';
      if (isCAD) {
        // For explicitly CAD images, just get description and mark as CAD: True
        promptText = 'Briefly describe this image in 5-10 words. Then, on a new line, answer: "CAD: True".';
      } else if (!detectBlueprint) {
        // For staged/generated images that are not CAD, just get description and mark as CAD: False
        promptText = 'Briefly describe this image in 5-10 words. Then, on a new line, answer: "CAD: False".';
      }
      
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: promptText },
              { type: 'image_url', image_url: { url: downscaledUrl } }
            ]
          }
        ],
        temperature: 0.3,
        max_tokens: 50
      });
      
      let annotation = completion.choices[0].message.content.trim();
      
      // Extract CAD classification from the response
      const cadMatch = annotation.match(/CAD:\s*(True|False)/i);
      if (cadMatch) {
        // Remove the CAD: True/False line from the annotation text
        annotation = annotation.replace(/\n?\s*CAD:\s*(True|False)\s*\.?$/i, '').trim();
        // Add CAD classification back in standardized format
        const cadValue = cadMatch[1];
        annotation += ` CAD: ${cadValue}`;
      } else {
        // If API didn't return CAD classification, use the provided isCAD value
        annotation += ` CAD: ${isCAD ? 'True' : 'False'}`;
        if (DEBUG_MODE) {
          console.log(`[Image Annotation] Warning: API did not return CAD classification, using default: ${isCAD ? 'True' : 'False'}`);
        }
      }
      
      if (DEBUG_MODE) {
        console.log(`[Image Annotation] Generated annotation: "${annotation}"`);
      }
      return annotation;
    } catch (error) {
      console.error('[Image Annotation] Error annotating image:', error);
      return null;
    }
  }

  return { annotateImage };
}
