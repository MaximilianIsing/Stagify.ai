// Quality-retry loop for AI image generation, extracted from server.js so the
// retry/scoring logic can be unit-tested without any real model calls.
//
// Contract:
//   generateOnce(attempt) → Promise<imageUrl | null>   (throws if generation fails)
//   reviewFn(url)         → Promise<{ perfect: boolean, score: number }>
//
// Behavior: retries up to `maxAttempts`. Returns the first image the reviewer calls
// "perfect" (stopping early); otherwise the best-scored image produced; and if no
// attempt ever produced an image, rethrows the last generation error. `null` results
// are skipped without being reviewed. `onImageProduced(attempt)` fires once per image
// actually produced. Pure given its arguments — no I/O, no globals.
import { logger } from '../logger.js';

/**
 * Retry an image generation up to `maxAttempts` times, returning the first image the
 * reviewer deems "perfect" (stopping early) or otherwise the best-scored image produced;
 * if no attempt ever produces an image, the last generation error is rethrown.
 * @param {(attempt: number) => (Promise<string|null>|string|null)} generateOnce - Produces one image (a data-URL string) for the given 1-based attempt, or null to skip; may throw.
 * @param {{
 *   label?: string,
 *   onImageProduced?: ((attempt: number) => void) | null,
 *   reviewFn?: (url: string) => Promise<import('../types/image.js').ImageReviewResult>,
 *   maxAttempts?: number,
 *   debug?: boolean,
 * }} [options] - Retry config; `reviewFn` and `maxAttempts` are typed optional because the `= {}` default allows omission, but both are validated as required at runtime (throws otherwise).
 * @returns {Promise<string>} The first "perfect" image URL, else the best-scored image produced.
 */
export async function generateWithQualityRetry(generateOnce, {
  label = 'image',
  onImageProduced = null,
  reviewFn,
  maxAttempts,
  debug = false,
} = {}) {
  if (typeof reviewFn !== 'function') {
    throw new Error('generateWithQualityRetry: reviewFn is required');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('generateWithQualityRetry: maxAttempts must be a positive integer');
  }

  let best = null; // { url, score }
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let url;
    try {
      url = await generateOnce(attempt);
    } catch (error) {
      lastError = error;
      if (debug && attempt < maxAttempts) {
        logger.debug(`[Quality] ${label}: regenerating — attempt ${attempt}/${maxAttempts} failed to produce an image (${error.message}).`);
      }
      continue; // try again; if all fail we rethrow below
    }
    if (!url) continue;
    if (typeof onImageProduced === 'function') onImageProduced(attempt);
    const { perfect, score } = await reviewFn(url);
    if (debug) {
      logger.debug(`[Quality] ${label} attempt ${attempt}/${maxAttempts}: ${perfect ? 'perfect — accepted' : `not perfect (score ${score})`}`);
    }
    if (perfect) return url;
    if (!best || score > best.score) best = { url, score };
    if (debug && attempt < maxAttempts) {
      logger.debug(`[Quality] ${label}: regenerating — attempt ${attempt} was not perfect (quality score ${score}).`);
    }
  }
  if (best) {
    if (debug) logger.debug(`[Quality] ${label}: no attempt was perfect; returning best (score ${best.score}).`);
    return best.url;
  }
  // Never produced an image at all — surface the last generation error.
  throw lastError || new Error('Image generation failed');
}

/**
 * Normalize the various furniture-image input shapes (a single Buffer, an array, or
 * null/undefined) into a flat array of at most 5 valid Buffers.
 * @param {Buffer | Buffer[] | null | undefined} furnitureImageInput - One furniture image, an array of them, or nothing.
 * @returns {Buffer[]} The normalized furniture buffers (empty when there is no input; capped at 5).
 */
export function normalizeFurnitureBuffers(furnitureImageInput) {
  if (!furnitureImageInput) return [];
  const raw = Array.isArray(furnitureImageInput) ? furnitureImageInput : [furnitureImageInput];
  return raw.filter((b) => b && Buffer.isBuffer(b)).slice(0, 5);
}
