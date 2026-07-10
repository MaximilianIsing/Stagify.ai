// Gemini-vision quality/QA reviewers for generated + mask-edited images and the
// stageability pre-check. All fail OPEN so a flaky reviewer never blocks a user.
// Factory injects the Gemini client. Extracted verbatim from server.js.
import { DEBUG_MODE } from '../config/runtime-flags.js';
import { logger } from '../logger.js';
import { downscaleImage, downscaleImageForGPT } from './image-primitives.js';
import { QUALITY_REVIEW_PROMPT, REVIEW_WHY_SUFFIX, MASK_REVIEW_PROMPT, STAGEABLE_IMAGE_CHECK_PROMPT, DEFAULT_UNSTAGEABLE_REASON } from '../staging/prompts.js';

// The grader is Gemini 2.5 Flash-Lite — a cheap, fast vision judge, and cheaper per
// image than the gpt-4o-mini it replaced. Thinking is disabled per call (these are
// glance-judgments; with thinking ON the output-token budget can be spent on
// reasoning and starve the visible verdict — see lib/staging/segment.js).
const GRADER_MODEL = 'gemini-2.5-flash-lite';

/** @typedef {{ text: string } | { inlineData: { mimeType: string, data: string } }} GeminiPart */

// Parse a `data:<mime>;base64,...` URL into a Gemini inlineData part. Returns null
// when the string is not a base64 data URL, so the caller can skip it instead of
// sending garbage to the model.
function dataUrlToPart(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  return m ? { inlineData: { mimeType: m[1], data: m[2] } } : null;
}

/**
 * Build the Gemini-vision QA reviewers (quality, mask-edit, stageability) bound to the
 * injected Gemini client. Every reviewer FAILS OPEN so a flaky reviewer never blocks a user.
 * @param {{ genAI: { getGenerativeModel: (options: any) => any } | null }} deps - Injected Gemini client (typed structurally around the used `getGenerativeModel().generateContent` because the SDK's strict content-part types reject these dynamically-built review payloads); reviewers pass through as approved when null.
 * @returns {{ reviewImageQuality: (imageDataUrl: string, opts?: { instruction?: string, furnitureDataUrls?: string[] }) => Promise<{ perfect: boolean, score: number, reason: string }>, reviewMaskEdit: (originalDataUrl: string, editedDataUrl: string, opts?: { instruction?: string, locatorDataUrl?: string | null, locatorMarked?: boolean, referenceDataUrl?: string | null }) => Promise<{ perfect: boolean, score: number, reason: string }>, validateStageableImage: (imageBuffer: Buffer) => Promise<{ valid: boolean, reason: string }> }} The QA reviewer API.
 */
export function createImageReview({ genAI }) {
  // Send a text+image prompt to the grader and return its raw (trimmed) reply.
  // Thinking off + temperature 0 for a fast, deterministic verdict. Throws on model
  // error so each reviewer's own try/catch fails open. Only ever called after a
  // `!genAI` guard, so `genAI` is non-null here.
  async function grade(parts, maxOutputTokens) {
    const model = genAI.getGenerativeModel({
      model: GRADER_MODEL,
      generationConfig: {
        temperature: 0,
        maxOutputTokens,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    const result = await model.generateContent(parts);
    const response = await result.response;
    return (response.text() || '').trim();
  }

  /**
   * QA-review a generated/staged image against an optional user instruction and furniture
   * references. Fails open (returns perfect) when genAI is null or on any error.
   * @param {string} imageDataUrl - The image to review, as a data: URL.
   * @param {{ instruction?: string, furnitureDataUrls?: string[] }} [opts] - Optional instruction to judge against and furniture reference data URLs to check for inclusion.
   * @returns {Promise<{ perfect: boolean, score: number, reason: string }>} Verdict with a 0–100 score and the raw reviewer text.
   */
  async function reviewImageQuality(imageDataUrl, opts = {}) {
    if (!genAI) return { perfect: true, score: 100, reason: 'reviewer disabled' };
    try {
      const { instruction = '', furnitureDataUrls = [] } = opts;
      const mainPart = dataUrlToPart(await downscaleImageForGPT(imageDataUrl));
      const extraParts = [];
      if (Array.isArray(furnitureDataUrls)) {
        for (const u of furnitureDataUrls) {
          try {
            const p = dataUrlToPart(await downscaleImageForGPT(u));
            if (p) extraParts.push(p);
          } catch { /* skip a furniture ref that fails to downscale */ }
        }
      }
      let guide = ' Image 1 is the photo to review.';
      if (extraParts.length) {
        guide += ` The remaining ${extraParts.length === 1 ? 'image is the furniture piece' : 'images are the furniture pieces'} the user uploaded to be included — check it was incorporated in a reasonable way (an exact match is NOT required; do not flag minor differences in shape, color, or angle).`;
      }
      const instr = (instruction && instruction.trim())
        ? ` The user's request was: "${instruction.trim()}". A result that reasonably fulfills this request is GOOD even if it differs from what you might have chosen — judge against the request, not your own taste.`
        : '';
      // Always ask for the "WHY: ..." line, not just in DEBUG: the quality-retry
      // loop feeds that named defect back into the next generation attempt
      // (qualityRetryFeedbackSuffix) so a retry can fix the specific problem
      // rather than re-roll blindly. The extra room fits PERFECT+SCORE+WHY.
      /** @type {GeminiPart[]} */
      const parts = [{ text: QUALITY_REVIEW_PROMPT + instr + guide + REVIEW_WHY_SUFFIX }];
      if (mainPart) parts.push(mainPart);
      for (const p of extraParts) parts.push(p);
      const raw = await grade(parts, DEBUG_MODE ? 220 : 160);
      const perfect = /PERFECT:\s*true/i.test(raw);
      if (perfect) return { perfect: true, score: 100, reason: raw };
      const m = raw.match(/SCORE:\s*(\d{1,3})/i);
      // No score on a "not perfect" verdict → treat as a low score for ranking.
      const score = m ? Math.max(0, Math.min(100, parseInt(m[1], 10))) : 0;
      if (DEBUG_MODE) logger.debug(`[Quality] reviewer flagged NOT perfect (score ${score}): ${raw.replace(/\s+/g, ' ')}`);
      return { perfect: false, score, reason: raw };
    } catch (error) {
      logger.error('[Quality] review failed, accepting image:', error.message);
      return { perfect: true, score: 100, reason: 'reviewer error' };
    }
  }

  /**
   * QA-review a mask edit against the original, judging only inside the masked/outlined
   * area. Fails open when genAI is null or on any error.
   * @param {string} originalDataUrl - The original room image (data: URL).
   * @param {string} editedDataUrl - The edited image (data: URL).
   * @param {{ instruction?: string, locatorDataUrl?: string | null, locatorMarked?: boolean, referenceDataUrl?: string | null }} [opts] - Optional instruction, a locator/mask image, whether the locator is a magenta outline, and a reference image to match.
   * @returns {Promise<{ perfect: boolean, score: number, reason: string }>} Verdict with a 0–100 score and the raw reviewer text.
   */
  async function reviewMaskEdit(originalDataUrl, editedDataUrl, opts = {}) {
    if (!genAI) return { perfect: true, score: 100, reason: 'reviewer disabled' };
    try {
      const { instruction = '', locatorDataUrl = null, locatorMarked = false, referenceDataUrl = null } = opts;
      const origPart = dataUrlToPart(await downscaleImageForGPT(originalDataUrl));
      const editPart = dataUrlToPart(await downscaleImageForGPT(editedDataUrl));
      let guide = ' Image 1 is the ORIGINAL room; image 2 is AFTER the edit.';
      const extras = [];
      if (locatorDataUrl) { try { const p = dataUrlToPart(await downscaleImageForGPT(locatorDataUrl)); if (p) extras.push({ desc: locatorMarked ? 'outline' : 'mask', part: p }); } catch { /* optional reviewer image; skip on failure */ } }
      if (referenceDataUrl) { try { const p = dataUrlToPart(await downscaleImageForGPT(referenceDataUrl)); if (p) extras.push({ desc: 'reference', part: p }); } catch { /* optional reviewer image; skip on failure */ } }
      let idx = 3;
      for (const e of extras) {
        if (e.desc === 'outline') guide += ` Image ${idx} is the SAME room with the editable area outlined in magenta — judge ONLY inside that outline and ignore everything outside it. The magenta line is just a location guide, NOT part of the photo, so never count it as a defect.`;
        else if (e.desc === 'mask') guide += ` Image ${idx} is the MASK: only the WHITE area was editable — judge ONLY inside it and ignore everything outside it.`;
        else guide += ` Image ${idx} is the REFERENCE the user wanted placed inside the masked area — the edit should resemble its identity (its exact angle and background do not matter).`;
        idx++;
      }
      const instr = (instruction && instruction.trim())
        ? ` The user's instruction was: "${instruction.trim()}". Judge whether the edit reflects THIS instruction. If it asked to REMOVE, clear, delete, or empty something, then a now-empty or barer masked area is CORRECT and expected — do NOT flag that as "removed too much".`
        : '';
      /** @type {GeminiPart[]} */
      const parts = [{ text: MASK_REVIEW_PROMPT + instr + guide + (DEBUG_MODE ? REVIEW_WHY_SUFFIX : '') }];
      if (origPart) parts.push(origPart);
      if (editPart) parts.push(editPart);
      for (const e of extras) parts.push(e.part);
      const raw = await grade(parts, DEBUG_MODE ? 220 : 80);
      const perfect = /PERFECT:\s*true/i.test(raw);
      if (perfect) return { perfect: true, score: 100, reason: raw };
      const m = raw.match(/SCORE:\s*(\d{1,3})/i);
      const score = m ? Math.max(0, Math.min(100, parseInt(m[1], 10))) : 0;
      if (DEBUG_MODE) logger.debug(`[Mask QA] reviewer flagged NOT perfect (score ${score}): ${raw.replace(/\s+/g, ' ')}`);
      return { perfect: false, score, reason: raw };
    } catch (error) {
      logger.error('[Mask QA] review failed, accepting image:', error.message);
      return { perfect: true, score: 100, reason: 'reviewer error' };
    }
  }

  /**
   * Pre-check whether an uploaded image is a stageable room/space/furniture photo. Fails
   * open (valid) when genAI is null or on any error.
   * @param {Buffer} imageBuffer - The uploaded image bytes.
   * @returns {Promise<{ valid: boolean, reason: string }>} valid flag and a friendly rejection reason when invalid.
   */
  async function validateStageableImage(imageBuffer) {
    if (!genAI) return { valid: true, reason: '' };
    try {
      const processed = await downscaleImage(imageBuffer);
      const parts = [
        { text: STAGEABLE_IMAGE_CHECK_PROMPT },
        { inlineData: { mimeType: 'image/jpeg', data: processed.toString('base64') } },
      ];
      const raw = await grade(parts, 60);
      const valid = /VALID:\s*true/i.test(raw);
      if (valid) return { valid: true, reason: '' };
      const m = raw.match(/REASON:\s*(.+)/i);
      const reason = m && m[1] ? m[1].trim().replace(/^["']|["']$/g, '') : '';
      if (DEBUG_MODE) logger.debug(`[Validate] upload rejected as not stageable: ${raw.replace(/\s+/g, ' ')}`);
      return { valid: false, reason: reason || DEFAULT_UNSTAGEABLE_REASON };
    } catch (error) {
      logger.error('[Validate] stageability check failed, allowing image:', error.message);
      return { valid: true, reason: '' };
    }
  }

  return { reviewImageQuality, reviewMaskEdit, validateStageableImage };
}
