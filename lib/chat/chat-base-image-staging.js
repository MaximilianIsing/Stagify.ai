// Base-image selection + staging-param resolution: fold the user's thumbnail
// selection and message-text intent into the AI-decided staging params, and pick
// which history image a CAD/add-furniture request should target. Split out of
// chat-history.js; pure except for DEBUG_MODE-gated logging.
import { DEBUG_MODE } from '../config/runtime-flags.js';
import { logger } from '../logger.js';
import { ADD_FURNITURE_PRESERVATION_SUFFIX } from '../staging/prompts.js';
import {
  collectImagesFromHistory,
  findMostRecentStagedImageIndex,
  getOriginalImageIndex,
} from './chat-image-collection.js';
import {
  userWantsToAddFurnitureToRoom,
  isRoomImageForFurniturePlacement,
} from './chat-image-classification.js';

/**
 * Parse the client-supplied base-image index into a non-negative integer, or null when
 * absent/invalid.
 * @param {string | number | null | undefined} raw - The raw index value (e.g. from a form field or query).
 * @returns {number | null} The parsed non-negative index, or null.
 */
export function parseBaseImageIndex(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Build the system-prompt note describing which thumbnail-strip image the user selected as the
 * base for this request, so the model targets that image for staging/CAD.
 * @param {number | null} baseImageIndex - The selected image index (or null when none selected).
 * @param {import('../types/chat.js').ChatMessage[]} messages - The conversation messages (for resolving the image).
 * @returns {string} The selection-context prompt fragment (empty when there is no valid selection).
 */
export function getBaseImageSelectionContext(baseImageIndex, messages) {
  if (baseImageIndex === null) return '';
  const images = collectImagesFromHistory(messages);
  if (baseImageIndex >= images.length) return '';
  const img = images[baseImageIndex];
  const typeLabel = img.isStaged ? 'staged' : img.isGenerated ? 'generated/CAD' : 'uploaded';
  const name = img.filename ? ` (${img.filename})` : '';
  return (
    `\n\nUSER UI SELECTION: The user selected image index ${baseImageIndex} in the thumbnail strip as the base for this request — ${typeLabel} image${name}. ` +
    `For staging or CAD that modifies an existing image in this turn, use index ${baseImageIndex} for usePreviousImage or imageIndex unless they clearly meant a different image or are only doing text-to-image generation. ` +
    `If they are adding, placing, or staging furniture, put it IN THIS selected room (index ${baseImageIndex}). The selected image is the room to modify — not the furniture reference, unless it is clearly only a product photo with no room context.`
  );
}

/**
 * Fold the user's thumbnail-strip selection into the staging params (setting usePreviousImage,
 * and clearing furnitureImageIndex when adding furniture to the selected room), unless the
 * current message already carries the image to stage.
 * @param {import('../types/staging.js').StagingParams} stagingParams - The AI-decided staging params.
 * @param {number | null} baseImageIndex - The selected base-image index (or null).
 * @param {import('../types/chat.js').ChatMessage[]} messages - The conversation messages.
 * @param {{ userMessage?: string, currentMessageHasImage?: boolean }} [options] - The user's text and whether the current message includes an image.
 * @returns {any} The (possibly adjusted) staging params (returned loosely so it does not narrow the caller's inferred staging-params variable).
 */
export function applyBaseImageIndexToStagingParams(stagingParams, baseImageIndex, messages, options = {}) {
  if (baseImageIndex === null || !stagingParams) return stagingParams;
  const images = collectImagesFromHistory(messages);
  if (baseImageIndex >= images.length) return stagingParams;

  const { userMessage = '', currentMessageHasImage = false } = options;
  const addingFurniture = currentMessageHasImage && userWantsToAddFurnitureToRoom(userMessage);

  if (currentMessageHasImage && !addingFurniture) {
    return stagingParams;
  }

  if (addingFurniture && currentMessageHasImage) {
    return { ...stagingParams, usePreviousImage: baseImageIndex, furnitureImageIndex: null };
  }

  if (addingFurniture) {
    return { ...stagingParams, usePreviousImage: baseImageIndex };
  }

  return { ...stagingParams, usePreviousImage: baseImageIndex };
}

/**
 * Decide which history image index a CAD request should target: the user's thumbnail
 * selection wins over the model's index, unless the current message carries its own image.
 * @param {import('../types/chat.js').CadRequest} cadRequest - The AI CAD request (`.imageIndex`).
 * @param {number | null} baseImageIndex - The selected base-image index (or null).
 * @param {import('../types/chat.js').ChatMessage[]} messages - The conversation messages.
 * @param {boolean} [currentMessageHasImage=false] - Whether the current message includes an image.
 * @returns {number} The resolved image index.
 */
export function resolveCadImageIndex(cadRequest, baseImageIndex, messages, currentMessageHasImage = false) {
  const aiIndex = typeof cadRequest.imageIndex === 'number' ? cadRequest.imageIndex : 0;
  if (baseImageIndex === null || currentMessageHasImage) return aiIndex;
  const images = collectImagesFromHistory(messages);
  if (baseImageIndex >= images.length) return aiIndex;
  return baseImageIndex;
}

/**
 * Choose which existing image is the ROOM to add furniture into: prefer a valid thumbnail
 * selection, then the most recent staged image, then a sole room candidate, then message-text
 * hints ("original room", "that room").
 * @param {import('../types/chat.js').ChatMessage[]} messages - The conversation messages.
 * @param {{ baseImageIndex?: number | null, userMessage?: string }} [options] - The selected base index and the user's text.
 * @returns {number | null} The chosen room image index, or null when none can be resolved.
 */
export function resolveTargetRoomImageIndex(messages, options = {}) {
  const { baseImageIndex = null, userMessage = '' } = options;
  const images = collectImagesFromHistory(messages);

  if (baseImageIndex !== null && baseImageIndex < images.length) {
    if (isRoomImageForFurniturePlacement(images[baseImageIndex])) {
      return baseImageIndex;
    }
  }

  const stagedIndex = findMostRecentStagedImageIndex(messages);
  if (stagedIndex !== null) return stagedIndex;

  const roomCandidates = images
    .map((img, index) => ({ img, index }))
    .filter(({ img }) => isRoomImageForFurniturePlacement(img));

  if (roomCandidates.length === 1) {
    return roomCandidates[0].index;
  }

  const m = (userMessage || '').toLowerCase();
  if (/\b(original|first|initial)\b/.test(m) && /\b(room|image|photo)\b/.test(m)) {
    const orig = getOriginalImageIndex(messages);
    if (orig !== null) return orig;
  }

  if (/\b(that|this|the)\s+(room|space|listing|photo)\b/.test(m) || /\bstaged room\b/.test(m)) {
    if (roomCandidates.length > 0) return roomCandidates[0].index;
  }

  return null;
}

/**
 * When the user uploads a furniture reference to add to an existing staged room, force that
 * room as the base image (preserving its staging) and treat the upload as the furniture
 * reference. No-op when the message is not an add-furniture request or no room can be resolved.
 * @param {import('../types/staging.js').StagingParams} stagingParams - The AI-decided staging params.
 * @param {string} userMessage - The user's message text.
 * @param {import('../types/chat.js').ChatMessage[]} historyMessages - The conversation history.
 * @param {{ currentMessageHasImage?: boolean, currentImageBuffer?: Buffer | null, baseImageIndex?: number | null }} [options] - Whether/what the current message uploaded and the selected base index.
 * @returns {{ stagingParams: any, furnitureFromCurrentUpload: any }} The adjusted params and the furniture buffer taken from the current upload (or null) — typed loosely so they do not narrow the caller's inferred locals.
 */
export function applyAddFurnitureStagingFallback(stagingParams, userMessage, historyMessages, options = {}) {
  const { currentMessageHasImage = false, currentImageBuffer = null, baseImageIndex = null } = options;
  if (!userWantsToAddFurnitureToRoom(userMessage)) {
    return { stagingParams, furnitureFromCurrentUpload: null };
  }

  const roomIndex = resolveTargetRoomImageIndex(historyMessages, { baseImageIndex, userMessage });
  if (roomIndex === null) {
    return { stagingParams, furnitureFromCurrentUpload: null };
  }

  const next = { ...stagingParams, preserveExistingStaging: true };
  if (!next.additionalPrompt || !next.additionalPrompt.includes('already-staged room')) {
    next.additionalPrompt = (next.additionalPrompt || '') + ADD_FURNITURE_PRESERVATION_SUFFIX;
  }

  if (currentMessageHasImage) {
    next.usePreviousImage = roomIndex;
    next.furnitureImageIndex = null;
    if (DEBUG_MODE) {
      logger.debug(`[Staging] Add-furniture fallback: room index ${roomIndex}, furniture from current upload`);
    }
    return { stagingParams: next, furnitureFromCurrentUpload: currentImageBuffer };
  }

  if (next.usePreviousImage === false || next.usePreviousImage === null) {
    next.usePreviousImage = roomIndex;
  }
  if (DEBUG_MODE) {
    logger.debug(`[Staging] Add-furniture fallback: modifying room at index ${roomIndex}`);
  }
  return { stagingParams: next, furnitureFromCurrentUpload: null };
}
