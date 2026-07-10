// The image index-space primitive for the AI Designer chat flow:
// collectImagesFromHistory flattens every upload/staged/generated image into a
// most-recent-first list, and the retrieval/index/context helpers address that
// space. Split out of chat-history.js; pure except for DEBUG_MODE-gated logging.
import { DEBUG_MODE } from '../config/runtime-flags.js';
import { logger } from '../logger.js';

/**
 * Collect every image in the conversation (user uploads + staged/generated assistant images)
 * into a flat, most-recent-first list — the index space that usePreviousImage / imageIndex /
 * recall address.
 * @param {import('../types/chat.js').ChatMessage[]} messages - The conversation messages.
 * @returns {import('../types/chat.js').HistoryImage[]} Resolved images, index 0 = most recent.
 */
export function collectImagesFromHistory(messages) {
  const imageMessages = [];
  if (!Array.isArray(messages)) return imageMessages;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const imageItems = msg.content.filter(
        (item) => item.type === 'image_url' && item.image_url && item.image_url.url
      );
      for (let j = imageItems.length - 1; j >= 0; j--) {
        const imageItem = imageItems[j];
        const url = imageItem.image_url?.url;
        if (!url) continue;
        imageMessages.push({
          url,
          isStaged: false,
          isGenerated: false,
          messageIndex: i,
          filename: imageItem.filename || imageItem.originalname || null,
          annotation: imageItem._annotation || imageItem.annotation || null,
        });
      }
    } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const imageItems = msg.content.filter(
        (item) =>
          item.type === 'image_url' &&
          item.image_url &&
          item.image_url.url &&
          (item.isStaged || item.isGenerated)
      );
      for (let j = imageItems.length - 1; j >= 0; j--) {
        const imageItem = imageItems[j];
        const url = imageItem.image_url?.url;
        if (!url) continue;
        imageMessages.push({
          url,
          isStaged: imageItem.isStaged || false,
          isGenerated: imageItem.isGenerated || false,
          messageIndex: i,
          filename: imageItem.filename || imageItem.originalname || null,
          annotation: imageItem._annotation || imageItem.annotation || null,
        });
      }
    }
  }
  return imageMessages;
}

/**
 * When the client includes the current upload in conversationHistory, drop that trailing user
 * message so image context does not count the same file twice.
 * @param {import('../types/chat.js').ChatMessage[]} conversationHistory - The full conversation history.
 * @param {string[]} currentUploadFilenames - Filenames of the files uploaded in the current turn.
 * @returns {import('../types/chat.js').ChatMessage[]} The history, minus the trailing message if it just duplicates the current upload.
 */
export function getPriorHistoryForImageContext(conversationHistory, currentUploadFilenames) {
  if (!Array.isArray(conversationHistory) || conversationHistory.length === 0) {
    return conversationHistory || [];
  }
  if (!currentUploadFilenames || currentUploadFilenames.length === 0) {
    return conversationHistory;
  }
  const last = conversationHistory[conversationHistory.length - 1];
  if (last.role !== 'user' || !Array.isArray(last.content)) {
    return conversationHistory;
  }
  const lastImageNames = last.content
    .filter((item) => item.type === 'image_url' && item.image_url && item.image_url.url)
    .map((item) => item.filename || item.originalname || '')
    .filter(Boolean);
  if (lastImageNames.length === 0) {
    return conversationHistory;
  }
  const currentSet = new Set(currentUploadFilenames);
  const duplicatesCurrentUpload = lastImageNames.every((name) => currentSet.has(name));
  if (duplicatesCurrentUpload) {
    return conversationHistory.slice(0, -1);
  }
  return conversationHistory;
}

/**
 * Find the index (in the collectImagesFromHistory space) of the most recent staged image.
 * @param {import('../types/chat.js').ChatMessage[]} messages - The conversation messages.
 * @returns {number | null} The staged image's index, or null when there is none.
 */
export function findMostRecentStagedImageIndex(messages) {
  const imageMessages = collectImagesFromHistory(messages);
  const idx = imageMessages.findIndex((img) => img.isStaged);
  return idx >= 0 ? idx : null;
}

/**
 * Retrieve a history image by index (0 = most recent). Falls back to the most recent image
 * when the requested index is out of range but images exist.
 * @param {import('../types/chat.js').ChatMessage[]} messages - The conversation messages.
 * @param {number} [imageIndex=0] - The index to retrieve (0 = most recent).
 * @returns {import('../types/chat.js').HistoryImage | null} The resolved image, or null when there are none.
 */
export function getImageFromHistory(messages, imageIndex = 0) {
  if (!Array.isArray(messages)) {
    if (DEBUG_MODE) {
      logger.debug(`[getImageFromHistory] Messages is not an array:`, typeof messages);
    }
    return null;
  }

  const imageMessages = collectImagesFromHistory(messages);

  if (DEBUG_MODE) {
    logger.debug(`[getImageFromHistory] Total images found: ${imageMessages.length}, requested index: ${imageIndex}`);
    imageMessages.forEach((img, idx) => {
      const kind = img.isStaged ? 'staged' : img.isGenerated ? 'generated' : 'user-uploaded';
      logger.debug(`[getImageFromHistory] Found ${kind} image at index ${idx}, filename: ${img.filename || 'unknown'}`);
    });
  }

  // Return the image at the requested index (0 = most recent)
  if (imageIndex >= 0 && imageIndex < imageMessages.length) {
    return imageMessages[imageIndex];
  }

  // If requested index doesn't exist but we have images, return the most recent (index 0) as fallback
  if (imageMessages.length > 0) {
    if (DEBUG_MODE) {
      logger.debug(`[getImageFromHistory] Requested index ${imageIndex} not found, returning most recent image (index 0) as fallback`);
    }
    return imageMessages[0];
  }

  return null;
}

/**
 * Build the "available images in conversation history" block (with per-image annotations, CAD
 * flags, and the original-image marker) injected into the GPT system instruction.
 * @param {import('../types/chat.js').ChatMessage[]} messages - The conversation messages.
 * @returns {{ imageContext: string, imagesSentToGPT: any[], originalImageIndex: number | null }} The context string, the list of images sent to GPT, and the original-image index.
 */
export function buildImageContext(messages) {
  const imageMessages = [];
  const imagesSentToGPT = []; // Separate list of images that were sent to GPT (for assistant messages)

  if (!Array.isArray(messages)) {
    return { imageContext: '', imagesSentToGPT: [], originalImageIndex: null };
  }

  // Collect ALL images in reverse chronological order (most recent first)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      // Get ALL images from this message
      const imageItems = msg.content.filter(item => item.type === 'image_url' && item.image_url && item.image_url.url);
      // Process images in reverse order within the message
      for (let j = imageItems.length - 1; j >= 0; j--) {
        const imageItem = imageItems[j];
        const filename = imageItem.filename || imageItem.originalname || null;
        const annotation = imageItem._annotation || imageItem.annotation || null;
        imageMessages.push({
          index: imageMessages.length,
          type: 'user-uploaded',
          messageIndex: i,
          filename: filename,
          annotation: annotation
        });
        // User-uploaded images are sent to GPT
        imagesSentToGPT.push({
          index: imagesSentToGPT.length,
          type: 'user-uploaded',
          filename: filename,
          annotation: annotation
        });
      }
    } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      // Get ALL staged and generated images from this message
      const imageItems = msg.content.filter(item =>
        item.type === 'image_url' &&
        item.image_url &&
        item.image_url.url &&
        (item.isStaged || item.isGenerated)
      );
      // Process images in reverse order within the message
      for (let j = imageItems.length - 1; j >= 0; j--) {
        const imageItem = imageItems[j];
        const filename = imageItem.filename || imageItem.originalname || null;
        const imageType = imageItem.isStaged ? 'staged' : 'generated';
        const annotation = imageItem._annotation || imageItem.annotation || null;
        imageMessages.push({
          index: imageMessages.length,
          type: imageType,
          messageIndex: i,
          filename: filename,
          annotation: annotation
        });
        // AI-generated images are also sent to GPT in future messages
        imagesSentToGPT.push({
          index: imagesSentToGPT.length,
          type: imageType,
          filename: filename,
          annotation: annotation
        });
      }
    }
  }

  // Find the original (first) user-uploaded image
  const userUploadedImages = imageMessages.filter(img => img.type === 'user-uploaded');
  let originalImageIndex = null;
  if (userUploadedImages.length > 0) {
    originalImageIndex = userUploadedImages[userUploadedImages.length - 1].index;
  }

  // Build image context string
  let imageContext = '';
  if (imageMessages.length > 0) {
    imageContext = '\n\nAvailable images in conversation history (index 0 = most recent, higher index = older):\n';
    imageMessages.forEach((img, idx) => {
      let description = `${img.type} image`;
      if (img.filename) {
        description += ` (filename: ${img.filename})`;
      }
      if (img.annotation) {
        // Parse CAD classification from annotation
        const cadMatch = img.annotation.match(/CAD:\s*(True|False)/i);
        const isCAD = cadMatch ? cadMatch[1].toLowerCase() === 'true' : false;
        // Remove CAD classification from description for cleaner display, but show it separately
        const annotationWithoutCAD = img.annotation.replace(/\s*CAD:\s*(True|False)/i, '').trim();
        description += ` - ${annotationWithoutCAD}`;
        description += ` [CAD: ${isCAD ? 'True' : 'False'}]`;
      } else {
        // If no annotation, default to False for CAD
        description += ` [CAD: False]`;
      }
      if (idx === originalImageIndex) {
        description += ' [ORIGINAL/FIRST USER-UPLOADED IMAGE]';
      }
      imageContext += `- Index ${idx}: ${description}\n`;
    });
    if (originalImageIndex !== null) {
      imageContext += `\nIMPORTANT: The "original image" or "first image" is at index ${originalImageIndex}. When the user says "original image", "first image", "initial image", "go back to the original", or "refer back to the original image", use index ${originalImageIndex} in the staging request.`;
    }
    imageContext += `\nIMPORTANT: When multiple images are uploaded in the same message, they are indexed separately. Use the filename and annotation to identify which image the user is referring to (e.g., if user says "add this chair", look for an image with "chair" in the filename or annotation).`;
    imageContext += `\nIMPORTANT: All images in the list above (user-uploaded, staged, generated, and CAD-staging renders) can be recalled using the recall function. Generated and staged images you created are included in this list and can be recalled by their index.`;

    // Add separate list of images sent to GPT
    if (imagesSentToGPT.length > 0) {
      imageContext += `\n\nImages sent to GPT in previous messages (for reference when building responses):\n`;
      imagesSentToGPT.forEach((img, idx) => {
        // Parse CAD classification from annotation
        let cadStatus = 'False';
        let annotationText = img.annotation || '';
        if (img.annotation) {
          const cadMatch = img.annotation.match(/CAD:\s*(True|False)/i);
          cadStatus = cadMatch ? cadMatch[1] : 'False';
          // Remove CAD classification from annotation text for cleaner display
          annotationText = img.annotation.replace(/\s*CAD:\s*(True|False)/i, '').trim();
        }
        let description = `${img.type} image`;
        if (img.filename) {
          description += ` (filename: ${img.filename})`;
        }
        if (annotationText) {
          description += ` - ${annotationText}`;
        }
        description += ` [CAD: ${cadStatus}]`;
        imageContext += `- GPT Image ${idx}: ${description}\n`;
      });
    }
  }

  return { imageContext, imagesSentToGPT, originalImageIndex };
}

/**
 * Get the index (in the most-recent-first image space) of the original (first) user-uploaded
 * image in the conversation.
 * @param {import('../types/chat.js').ChatMessage[]} messages - The conversation messages.
 * @returns {number | null} The original image's index, or null when none was uploaded.
 */
export function getOriginalImageIndex(messages) {
  if (!Array.isArray(messages)) {
    return null;
  }

  const userUploadedImages = [];

  // Collect all user-uploaded images in reverse chronological order (most recent first)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const imageItem = msg.content.find(item => item.type === 'image_url');
      if (imageItem && imageItem.image_url && imageItem.image_url.url) {
        userUploadedImages.push({
          index: userUploadedImages.length,
          messageIndex: i
        });
      }
    }
  }

  // The original image is at the highest index (oldest)
  if (userUploadedImages.length > 0) {
    return userUploadedImages[userUploadedImages.length - 1].index;
  }

  return null;
}
