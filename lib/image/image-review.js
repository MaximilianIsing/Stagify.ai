// GPT-vision quality/QA reviewers for generated + mask-edited images and the
// stageability pre-check. All fail OPEN so a flaky reviewer never blocks a user.
// Factory injects the OpenAI client. Extracted verbatim from server.js.
import { DEBUG_MODE } from '../config/runtime-flags.js';
import { logger } from '../logger.js';
import { downscaleImage, downscaleImageForGPT } from './image-primitives.js';
import { QUALITY_REVIEW_PROMPT, REVIEW_WHY_SUFFIX, MASK_REVIEW_PROMPT, STAGEABLE_IMAGE_CHECK_PROMPT, DEFAULT_UNSTAGEABLE_REASON } from '../staging/prompts.js';

/**
 * Build the GPT-vision QA reviewers (quality, mask-edit, stageability) bound to the
 * injected OpenAI client. Every reviewer FAILS OPEN so a flaky reviewer never blocks a user.
 * @param {{ openai: { chat: { completions: { create: (args: any) => Promise<any> } } } | null }} deps - Injected OpenAI client (typed structurally around the used `chat.completions.create` because the SDK's strict content-part types reject these dynamically-built review payloads); reviewers pass through as approved when null.
 * @returns {{ reviewImageQuality: (imageDataUrl: string, opts?: { instruction?: string, furnitureDataUrls?: string[] }) => Promise<{ perfect: boolean, score: number, reason: string }>, reviewMaskEdit: (originalDataUrl: string, editedDataUrl: string, opts?: { instruction?: string, locatorDataUrl?: string | null, locatorMarked?: boolean, referenceDataUrl?: string | null }) => Promise<{ perfect: boolean, score: number, reason: string }>, validateStageableImage: (imageBuffer: Buffer) => Promise<{ valid: boolean, reason: string }> }} The QA reviewer API.
 */
export function createImageReview({ openai }) {
  /**
   * QA-review a generated/staged image against an optional user instruction and furniture
   * references. Fails open (returns perfect) when openai is null or on any error.
   * @param {string} imageDataUrl - The image to review, as a data: URL.
   * @param {{ instruction?: string, furnitureDataUrls?: string[] }} [opts] - Optional instruction to judge against and furniture reference data URLs to check for inclusion.
   * @returns {Promise<{ perfect: boolean, score: number, reason: string }>} Verdict with a 0–100 score and the raw reviewer text.
   */
  async function reviewImageQuality(imageDataUrl, opts = {}) {
    if (!openai) return { perfect: true, score: 100, reason: 'reviewer disabled' };
    try {
      const { instruction = '', furnitureDataUrls = [] } = opts;
      const mainUrl = await downscaleImageForGPT(imageDataUrl);
      const extraUrls = [];
      if (Array.isArray(furnitureDataUrls)) {
        for (const u of furnitureDataUrls) {
          try { extraUrls.push(await downscaleImageForGPT(u)); } catch { /* skip a furniture ref that fails to downscale */ }
        }
      }
      let guide = ' Image 1 is the photo to review.';
      if (extraUrls.length) {
        guide += ` The remaining ${extraUrls.length === 1 ? 'image is the furniture piece' : 'images are the furniture pieces'} the user uploaded to be included — check it was incorporated in a reasonable way (an exact match is NOT required; do not flag minor differences in shape, color, or angle).`;
      }
      const instr = (instruction && instruction.trim())
        ? ` The user's request was: "${instruction.trim()}". A result that reasonably fulfills this request is GOOD even if it differs from what you might have chosen — judge against the request, not your own taste.`
        : '';
      const content = [
        { type: 'text', text: QUALITY_REVIEW_PROMPT + instr + guide + (DEBUG_MODE ? REVIEW_WHY_SUFFIX : '') },
        { type: 'image_url', image_url: { url: mainUrl } },
      ];
      for (const u of extraUrls) content.push({ type: 'image_url', image_url: { url: u } });
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content }],
        temperature: 0,
        max_tokens: DEBUG_MODE ? 220 : 80,
      });
      const raw = (completion.choices[0].message.content || '').trim();
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
   * area. Fails open when openai is null or on any error.
   * @param {string} originalDataUrl - The original room image (data: URL).
   * @param {string} editedDataUrl - The edited image (data: URL).
   * @param {{ instruction?: string, locatorDataUrl?: string | null, locatorMarked?: boolean, referenceDataUrl?: string | null }} [opts] - Optional instruction, a locator/mask image, whether the locator is a magenta outline, and a reference image to match.
   * @returns {Promise<{ perfect: boolean, score: number, reason: string }>} Verdict with a 0–100 score and the raw reviewer text.
   */
  async function reviewMaskEdit(originalDataUrl, editedDataUrl, opts = {}) {
    if (!openai) return { perfect: true, score: 100, reason: 'reviewer disabled' };
    try {
      const { instruction = '', locatorDataUrl = null, locatorMarked = false, referenceDataUrl = null } = opts;
      const origSmall = await downscaleImageForGPT(originalDataUrl);
      const editSmall = await downscaleImageForGPT(editedDataUrl);
      let guide = ' Image 1 is the ORIGINAL room; image 2 is AFTER the edit.';
      const extras = [];
      if (locatorDataUrl) { try { extras.push({ desc: locatorMarked ? 'outline' : 'mask', url: await downscaleImageForGPT(locatorDataUrl) }); } catch { /* optional reviewer image; skip on failure */ } }
      if (referenceDataUrl) { try { extras.push({ desc: 'reference', url: await downscaleImageForGPT(referenceDataUrl) }); } catch { /* optional reviewer image; skip on failure */ } }
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
      const content = [
        { type: 'text', text: MASK_REVIEW_PROMPT + instr + guide + (DEBUG_MODE ? REVIEW_WHY_SUFFIX : '') },
        { type: 'image_url', image_url: { url: origSmall } },
        { type: 'image_url', image_url: { url: editSmall } },
      ];
      for (const e of extras) content.push({ type: 'image_url', image_url: { url: e.url } });
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content }],
        temperature: 0,
        max_tokens: DEBUG_MODE ? 220 : 80,
      });
      const raw = (completion.choices[0].message.content || '').trim();
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
   * open (valid) when openai is null or on any error.
   * @param {Buffer} imageBuffer - The uploaded image bytes.
   * @returns {Promise<{ valid: boolean, reason: string }>} valid flag and a friendly rejection reason when invalid.
   */
  async function validateStageableImage(imageBuffer) {
    if (!openai) return { valid: true, reason: '' };
    try {
      const processed = await downscaleImage(imageBuffer);
      const dataUrl = `data:image/jpeg;base64,${processed.toString('base64')}`;
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: STAGEABLE_IMAGE_CHECK_PROMPT },
              // detail: 'low' → one ~512px tile (~85 image tokens) instead of
              // high-detail tiling. A room/not-a-room judgment needs nothing more,
              // and it makes the call several times faster (and cheaper).
              { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
            ],
          },
        ],
        temperature: 0,
        max_tokens: 60,
      });
      const raw = (completion.choices[0].message.content || '').trim();
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
