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
        console.log(`[Quality] ${label}: regenerating — attempt ${attempt}/${maxAttempts} failed to produce an image (${error.message}).`);
      }
      continue; // try again; if all fail we rethrow below
    }
    if (!url) continue;
    if (typeof onImageProduced === 'function') onImageProduced(attempt);
    const { perfect, score } = await reviewFn(url);
    if (debug) {
      console.log(`[Quality] ${label} attempt ${attempt}/${maxAttempts}: ${perfect ? 'perfect — accepted' : `not perfect (score ${score})`}`);
    }
    if (perfect) return url;
    if (!best || score > best.score) best = { url, score };
    if (debug && attempt < maxAttempts) {
      console.log(`[Quality] ${label}: regenerating — attempt ${attempt} was not perfect (quality score ${score}).`);
    }
  }
  if (best) {
    if (debug) console.log(`[Quality] ${label}: no attempt was perfect; returning best (score ${best.score}).`);
    return best.url;
  }
  // Never produced an image at all — surface the last generation error.
  throw lastError || new Error('Image generation failed');
}

export function normalizeFurnitureBuffers(furnitureImageInput) {
  if (!furnitureImageInput) return [];
  const raw = Array.isArray(furnitureImageInput) ? furnitureImageInput : [furnitureImageInput];
  return raw.filter((b) => b && Buffer.isBuffer(b)).slice(0, 5);
}
