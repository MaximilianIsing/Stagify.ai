// The /api/mask-edit request, shared by both mask editors.
//
// Both built the same body and unpacked the same response; they differed only in
// where the source image and the model name came from, so those are arguments.
// The bearer token is read here because both copies read the same global — it is
// the app's single auth accessor, not a per-editor choice.
import { buildModelMask } from '../mask-core.js';

/**
 * Load a data URL / URL into an Image, resolving once decoded.
 * @param {string} src
 * @returns {Promise<HTMLImageElement>}
 */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('Failed to load edited image'));
    im.src = src;
  });
}

/**
 * POST the current strokes + prompt (+ optional reference) to the model and
 * resolve to the raw edited image. Throws on a non-ok response or a payload with
 * no image.
 *
 * The MODEL mask is built here from the draw canvas: sending the grown mask
 * rather than the raw brush is what makes the secret brush expansion actually
 * enlarge the edited region.
 *
 * @param {{
 *   image: string,
 *   drawCanvas: HTMLCanvasElement,
 *   w: number,
 *   h: number,
 *   prompt: string,
 *   coreGrow: number,
 *   model: string,
 *   referenceImage?: string | null,
 * }} args
 * @returns {Promise<HTMLImageElement>} The raw edited image, before compositing.
 */
export async function requestMaskEdit({ image, drawCanvas, w, h, prompt, coreGrow, model, referenceImage }) {
  const mask = buildModelMask(drawCanvas, w, h, coreGrow).toDataURL('image/png');
  const token = window.StagifyAuth && window.StagifyAuth.getToken();
  const response = await fetch('/api/mask-edit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify({
      image,
      mask,
      prompt,
      model,
      authToken: token || undefined,
      ...(referenceImage ? { referenceImage } : {}),
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.editedImage) {
    throw new Error(data.error || 'Failed to process masked edit');
  }
  return loadImage(data.editedImage);
}
