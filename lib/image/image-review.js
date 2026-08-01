// Gemini-vision quality/QA reviewers for generated + mask-edited images and the
// stageability pre-check. All fail OPEN so a flaky reviewer never blocks a user.
// Factory injects the Gemini client. Extracted verbatim from server.js.
import { DEBUG_MODE } from '../config/runtime-flags.js';
import { logger } from '../logger.js';
import { downscaleImage, downscaleImageForGPT } from './image-primitives.js';
import { QUALITY_REVIEW_PROMPT, REVIEW_WHY_SUFFIX, MASK_REVIEW_PROMPT } from '../staging/prompts.js';
import { CONSISTENCY_REVIEW_PROMPT } from '../staging/prompts-continuity.js';
import { STAGEABLE_IMAGE_CHECK_PROMPT, DEFAULT_UNSTAGEABLE_REASON, UNSTAGEABLE_CODES, GENERIC_UNSTAGEABLE_CODE } from '../staging/unstageable.js';

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
 * @returns {{ reviewImageQuality: (imageDataUrl: string, opts?: { instruction?: string, furnitureDataUrls?: string[] }) => Promise<{ perfect: boolean, score: number, reason: string }>, reviewMaskEdit: (originalDataUrl: string, editedDataUrl: string, opts?: { instruction?: string, locatorDataUrl?: string | null, locatorMarked?: boolean, referenceDataUrl?: string | null }) => Promise<{ perfect: boolean, score: number, reason: string }>, validateStageableImage: (imageBuffer: Buffer) => Promise<{ valid: boolean, code: string | null, reason: string }>, reviewDesignConsistency: (heroDataUrl: string, candidateDataUrl: string, bible: import('../types/projects.js').DesignBible | null | undefined) => Promise<{ perfect: boolean, score: number, reason: string, slots: Array<{ slot: string, match: boolean }>, checked: boolean }> }} The QA reviewer API.
 */
export function createImageReview({ genAI }) {
  // Send a text+image prompt to the grader and return its raw (trimmed) reply.
  // Thinking off + temperature 0 for a fast, deterministic verdict. Throws on model
  // error so each reviewer's own try/catch fails open. Only ever called after a
  // `!genAI` guard, so `genAI` is non-null here.
  async function grade(parts, maxOutputTokens) {
    // Callers all early-return on `!genAI`, but that guard doesn't narrow across
    // this closure boundary; re-assert it here (throws → the caller's try/catch
    // fails open, same as any other grader error).
    if (!genAI) throw new Error('Gemini reviewer not configured');
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
   * Pre-check whether an uploaded image is a stageable room/space/furniture photo.
   *
   * The grader answers with a single digit from the fixed UNSTAGEABLE_CODES taxonomy
   * (0 = valid) rather than free-form prose, so the copy the user sees is ours — stable,
   * translatable, and loggable as a category — instead of whatever the model improvised.
   *
   * Fails open (valid) when genAI is null, on any error, AND on an unreadable reply:
   * a garbled verdict must not cost a real customer a legitimate upload, which is the
   * same reasoning behind the prompt's "when unsure, answer 0".
   * @param {Buffer} imageBuffer - The uploaded image bytes.
   * @returns {Promise<{ valid: boolean, code: string | null, reason: string }>} valid flag, the stable rejection code (null when valid), and the English rejection copy.
   */
  async function validateStageableImage(imageBuffer) {
    if (!genAI) return { valid: true, code: null, reason: '' };
    try {
      const processed = await downscaleImage(imageBuffer);
      const parts = [
        { text: STAGEABLE_IMAGE_CHECK_PROMPT },
        { inlineData: { mimeType: 'image/jpeg', data: processed.toString('base64') } },
      ];
      // One line, "CODE: <n>" — 16 tokens is ample and caps a runaway reply.
      const raw = await grade(parts, 16);
      const m = raw.match(/CODE:\s*(\d)/i);
      // No digit at all → fail open (see above), and say so: a grader that stopped
      // emitting the format is a silent gate outage, not a routine rejection.
      if (!m) {
        logger.warn(`[Validate] unreadable grader reply, allowing image: ${raw.replace(/\s+/g, ' ').slice(0, 120)}`);
        return { valid: true, code: null, reason: '' };
      }
      if (m[1] === '0') return { valid: true, code: null, reason: '' };
      // A digit outside the taxonomy is still a rejection — the grader did say "not
      // valid" — so honor it with the generic copy rather than discarding the verdict.
      const entry = UNSTAGEABLE_CODES[m[1]];
      if (DEBUG_MODE) logger.debug(`[Validate] upload rejected as not stageable: ${raw.replace(/\s+/g, ' ')}`);
      return entry
        ? { valid: false, code: entry.code, reason: entry.message }
        : { valid: false, code: GENERIC_UNSTAGEABLE_CODE, reason: DEFAULT_UNSTAGEABLE_REASON };
    } catch (error) {
      logger.error('[Validate] stageability check failed, allowing image:', error.message);
      return { valid: true, code: null, reason: '' };
    }
  }

  /**
   * Judge whether a support frame reproduces the SAME physical furniture as its room's
   * hero frame, per that room's design bible.
   *
   * Unlike its siblings this reviewer has a per-item verdict, because the retry it
   * feeds needs to name what drifted: the raw reply carries one `SLOT: <name> = …`
   * line per piece the grader could actually see, and the parsed `slots` array is
   * what lets the caller say "the sofa changed" instead of "something is off".
   *
   * Only CRITICAL pieces are sent. A non-critical piece drifting (a different plant,
   * a moved cushion) is not worth a paid regeneration, and including them would dilute
   * the score with noise the caller has already decided to tolerate.
   *
   * Fails open like every other reviewer here — but note the caller's obligation:
   * "no verdict" is not "consistent". A frame rendered while this reviewer was down
   * must not be reported to the user as continuity-checked.
   *
   * @param {string} heroDataUrl - The room's hero render (the agreed staging), as a data: URL.
   * @param {string} candidateDataUrl - The support frame under review, as a data: URL.
   * @param {import('../types/projects.js').DesignBible | null | undefined} bible - The room's design bible; a falsy or piece-less bible passes through as approved.
   * @returns {Promise<{ perfect: boolean, score: number, reason: string, slots: Array<{ slot: string, match: boolean }>, checked: boolean }>} Verdict with a 0–100 score, the raw reviewer text, the per-slot results the grader reported, and  — false on every fail-open exit, so a caller never persists a sentinel score as a real one.
   */
  async function reviewDesignConsistency(heroDataUrl, candidateDataUrl, bible) {
    // `checked: false` on every fail-open exit. The caller must be able to tell 'no
    // reviewer ran' from 'a reviewer ran and found nothing wrong' — persisting the 100 from
    // these sentinels reached the UI as a confident 'Consistency 100.00' on a frame nothing
    // had ever compared. `perfect: true` still stands so the retry loop accepts the image.
    if (!genAI) return { perfect: true, score: 100, reason: 'reviewer disabled', slots: [], checked: false };
    const critical = Array.isArray(bible?.pieces) ? bible.pieces.filter((p) => p && p.critical) : [];
    // Nothing to check is not the same as nothing wrong, but there is no verdict to
    // give either — pass through and let the caller decide what to claim.
    if (critical.length === 0) return { perfect: true, score: 100, reason: 'no critical pieces', slots: [], checked: false };
    try {
      const heroPart = dataUrlToPart(await downscaleImageForGPT(heroDataUrl));
      const candPart = dataUrlToPart(await downscaleImageForGPT(candidateDataUrl));
      if (!heroPart || !candPart) {
        logger.warn('[Continuity] could not prepare both frames, accepting image');
        return { perfect: true, score: 100, reason: 'reviewer input error', slots: [], checked: false };
      }
      const pieceList = critical
        .map((p) => `- ${p.slot}: ${p.identity}`)
        .join('\n');
      /** @type {GeminiPart[]} */
      const parts = [
        { text: `${CONSISTENCY_REVIEW_PROMPT}\nTHE PIECES TO CHECK:\n${pieceList}${REVIEW_WHY_SUFFIX}` },
        heroPart,
        candPart,
      ];
      // One SLOT line per critical piece plus PERFECT/SCORE/WHY. 24 tokens a slot is
      // generous; the floor keeps a 1-piece bible from truncating mid-verdict.
      const raw = await grade(parts, Math.max(120, 60 + critical.length * 24));
      /** @type {Array<{ slot: string, match: boolean }>} */
      const slots = [];
      for (const m of raw.matchAll(/SLOT:\s*([a-z0-9-]{1,40})\s*=\s*(match|mismatch)/gi)) {
        slots.push({ slot: m[1].toLowerCase(), match: m[2].toLowerCase() === 'match' });
      }
      const mismatched = slots.filter((s) => !s.match);
      const declaredPerfect = /PERFECT:\s*true/i.test(raw);
      // Trust the per-slot lines over the summary when they disagree: the summary is
      // one token the model can fumble, whereas a "SLOT: sofa = mismatch" line is a
      // specific claim it had to construct. Disagreement means NOT perfect either way.
      const perfect = declaredPerfect && mismatched.length === 0;
      if (perfect) return { perfect: true, score: 100, reason: raw, slots, checked: true };
      const m = raw.match(/SCORE:\s*(\d{1,3})/i);
      let score = m ? Math.max(0, Math.min(100, parseInt(m[1], 10))) : 0;
      // The grader declared success but named a mismatch: it gave no score for a
      // verdict it thought was passing, so derive one from the slots rather than
      // ranking this attempt at 0 and discarding an otherwise-usable frame.
      if (!m && declaredPerfect && slots.length > 0) {
        score = Math.round(((slots.length - mismatched.length) / slots.length) * 100);
      }
      if (DEBUG_MODE) {
        logger.debug(`[Continuity] not consistent (score ${score}); mismatched: ${mismatched.map((s) => s.slot).join(', ') || 'unnamed'}`);
      }
      return { perfect: false, score, reason: raw, slots, checked: true };
    } catch (error) {
      logger.error('[Continuity] review failed, accepting image:', error.message);
      return { perfect: true, score: 100, reason: 'reviewer error', slots: [], checked: false };
    }
  }

  return { reviewImageQuality, reviewMaskEdit, validateStageableImage, reviewDesignConsistency };
}
