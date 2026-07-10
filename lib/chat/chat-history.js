// Conversation-history and image-resolution helpers for the AI Designer chat
// flow. Extracted verbatim from server.js. Pure over their inputs (messages,
// staging params, uploaded files) except for DEBUG_MODE-gated logging.
import { DEBUG_MODE } from '../config/runtime-flags.js';
import { logger } from '../logger.js';
import { ADD_FURNITURE_PRESERVATION_SUFFIX } from '../staging/prompts.js';

/**
 * Middleman filter that removes unsupported image types (AVIF and any non-JPEG/PNG/WebP/GIF)
 * from a message's content array before it reaches OpenAI, converting each rejected image
 * into an explanatory text item. Non-array content is returned unchanged.
 * @param {any} content - A message `content` array (ContentItem[]) — or any non-array value, returned as-is.
 * @param {import('../types/chat.js').UploadedFile[]} [files] - Uploaded files, used to recover the original filename by matching base64 data.
 * @returns {{ filteredContent: any[], unsupportedFiles: Array<{ name: string, type: string }> }} The filtered content and the list of rejected files (name + format).
 */
export function filterUnsupportedFiles(content, files = []) {
  if (!Array.isArray(content)) {
    return content; // If not an array, return as-is
  }
  
  const supportedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
  const filteredContent = [];
  const unsupportedFiles = [];
  
  for (const item of content) {
    if (item.type === 'image_url' && item.image_url && item.image_url.url) {
      const url = item.image_url.url;
      
      // Check for AVIF in the data URL - only check MIME type, not filename
      const isAVIF = url.includes('data:image/avif') || 
                     url.includes('image/avif;');
      
      // Extract MIME type from data URL (format: data:image/jpeg;base64,...)
      const mimeMatch = url.match(/data:([^;]+)/);
      const mimeType = mimeMatch ? mimeMatch[1].toLowerCase() : '';
      
      // Check if MIME type is unsupported
      const isUnsupported = isAVIF || 
                           (mimeType.startsWith('image/') && !supportedImageTypes.includes(mimeType));
      
      if (isUnsupported) {
        // Find the corresponding file to get its name
        let fileName = 'the file';
        if (files && files.length > 0) {
          // Try to match by base64 data
          const base64Data = url.split(',')[1];
          if (base64Data) {
            const matchingFile = files.find(f => {
              try {
                const fileBase64 = f.buffer.toString('base64');
                return fileBase64.substring(0, 100) === base64Data.substring(0, 100);
              } catch {
                return false;
              }
            });
            if (matchingFile) {
              fileName = matchingFile.originalname;
            }
          }
        }
        
        const fileType = isAVIF ? 'AVIF' : (mimeType.split('/')[1]?.toUpperCase() || 'unsupported format');
        unsupportedFiles.push({ name: fileName, type: fileType });
        
        // Convert to text instead of image
        filteredContent.push({
          type: 'text',
          text: `I uploaded "${fileName}" but it is in ${fileType} format which is not supported.`
        });
      } else {
        // Supported image - keep it
        filteredContent.push(item);
      }
    } else {
      // Not an image - keep as-is
      filteredContent.push(item);
    }
  }
  
  return { filteredContent, unsupportedFiles };
}

/**
 * Filters unsupported files from conversation history messages
 */
// Deduplicate messages based on role and content
/**
 * Deduplicate messages by role + normalized content (images compared as placeholders, text
 * trimmed, array items order-normalized), preserving first occurrence. Non-array input is
 * returned unchanged.
 * @param {import('../types/chat.js').ChatMessage[]} messages - The conversation messages.
 * @returns {import('../types/chat.js').ChatMessage[]} The deduplicated messages.
 */
export function deduplicateMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  
  const seen = new Set();
  const deduplicated = [];
  
  for (const msg of messages) {
    // Skip invalid messages
    if (!msg || !msg.role) {
      continue;
    }
    
    // Create a unique key based on role and content
    let key;
    if (Array.isArray(msg.content)) {
      // For array content, stringify the structure (without base64 data for images)
      const simplifiedContent = msg.content.map(item => {
        if (item.type === 'image_url' && item.image_url && item.image_url.url) {
          // For images, use a placeholder to avoid comparing base64 data
          return { type: 'image_url', image_url: { url: '[IMAGE_DATA]' } };
        } else if (item.type === 'text') {
          // Normalize text content (trim whitespace)
          return { type: 'text', text: (item.text || '').trim() };
        }
        return item;
      });
      // Sort array items to ensure consistent ordering
      simplifiedContent.sort((a, b) => {
        if (a.type !== b.type) return a.type.localeCompare(b.type);
        if (a.type === 'text' && b.type === 'text') {
          return (a.text || '').localeCompare(b.text || '');
        }
        return 0;
      });
      key = `${msg.role}:${JSON.stringify(simplifiedContent)}`;
    } else if (typeof msg.content === 'string') {
      // Normalize text content (trim whitespace) for consistent comparison
      key = `${msg.role}:${msg.content.trim()}`;
    } else {
      // Fallback for other content types
      key = `${msg.role}:${JSON.stringify(msg.content)}`;
    }
    
    // Only add if we haven't seen this exact message before
    if (!seen.has(key)) {
      seen.add(key);
      deduplicated.push(msg);
    } else {
      // Log when we skip a duplicate
      if (DEBUG_MODE) {
        const contentPreview = Array.isArray(msg.content) 
          ? `[${msg.content.length} items]` 
          : (typeof msg.content === 'string' ? msg.content.substring(0, 50) : 'non-string');
        logger.debug(`[Deduplication] Skipping duplicate ${msg.role} message: ${contentPreview}...`);
      }
    }
  }
  
  return deduplicated;
}

/**
 * Run {@link filterUnsupportedFiles} over every user message's content array so unsupported
 * files never slip into OpenAI via conversation history. Non-array input is returned as-is.
 * @param {import('../types/chat.js').ChatMessage[]} messages - The conversation messages.
 * @returns {import('../types/chat.js').ChatMessage[]} The history with unsupported files stripped from user messages.
 */
export function filterConversationHistory(messages) {
  if (!Array.isArray(messages)) {
    return messages;
  }
  
  return messages.map(msg => {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const { filteredContent } = filterUnsupportedFiles(msg.content);
      return {
        ...msg,
        content: filteredContent
      };
    }
    return msg;
  });
}

/**
 * Replace images in history with text placeholders (filename / "[Staged image ...]"),
 * keeping text context, to avoid payload bloat. Optionally keeps the images in the current
 * (last user) message. Non-array input is returned as-is.
 * @param {import('../types/chat.js').ChatMessage[]} messages - The conversation messages.
 * @param {boolean} [keepCurrentMessageImages=false] - When true, keep images in the last user message.
 * @returns {import('../types/chat.js').ChatMessage[]} The history with images stripped to text references.
 */
export function stripImagesFromHistory(messages, keepCurrentMessageImages = false) {
  if (!Array.isArray(messages)) {
    return messages;
  }
  
  return messages.map((msg, index) => {
    const isLastMessage = index === messages.length - 1;
    const shouldKeepImages = keepCurrentMessageImages && isLastMessage && msg.role === 'user';
    
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      if (shouldKeepImages) {
        // Keep images in current message
        return msg;
      } else {
        // Replace images with filename references, keep text
        const textParts = [];
        let imageCount = 0;
        
        msg.content.forEach(item => {
          if (item.type === 'text') {
            textParts.push(item.text);
          } else if (item.type === 'image_url') {
            imageCount++;
            // Try to extract filename from metadata or use generic name
            const filename = item.filename || item.originalname || (imageCount === 1 ? 'uploaded_image.jpg' : `image_${imageCount}.jpg`);
            const isStaged = item.isStaged || false;
            if (isStaged) {
              textParts.push(`[Staged image from previous message]`);
            } else {
              textParts.push(`[Image: ${filename}]`);
            }
          }
        });
        
        const textContent = textParts.join('\n\n');
        return {
          role: 'user',
          content: textContent || '[Previous message]'
        };
      }
    } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      // Replace images with references, keep text
      const textParts = [];
      
      msg.content.forEach(item => {
        if (item.type === 'text') {
          textParts.push(item.text);
        } else if (item.type === 'image_url') {
          textParts.push(`[Staged image from previous message]`);
        }
      });
      
      const textContent = textParts.join('\n\n');
      return {
        role: 'assistant',
        content: textContent || '[Previous response]'
      };
    }
    return msg;
  });
}

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
        imageMessages.push({
          url: imageItem.image_url.url,
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
        imageMessages.push({
          url: imageItem.image_url.url,
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
    .map((item) => item.filename || item.originalname)
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
 * Heuristic: does the user's message ask to add/place a piece of furniture into a room
 * (vs. a fresh full-room staging)?
 * @param {string} messageText - The user's message text.
 * @returns {boolean} true when the phrasing indicates adding furniture to an existing room.
 */
export function userWantsToAddFurnitureToRoom(messageText) {
  if (!messageText || typeof messageText !== 'string') return false;
  const m = messageText.toLowerCase();
  if (/\b(this|that|the)\s+(chair|sofa|couch|table|desk|lamp|bed|ottoman|dresser|armchair)\b/.test(m)) {
    return true;
  }
  if (/\badd (this|the|that|my|a)\b/.test(m) && /\b(chair|sofa|couch|table|desk|lamp|bed|furniture|piece|it)\b/.test(m)) {
    return true;
  }
  return (
    /\b(add|include|put|place|incorporate|insert|use)\b/.test(m) &&
    /\b(chair|sofa|couch|table|desk|lamp|bed|furniture|piece|item|this|it|these|that)\b/.test(m)
  );
}

/**
 * Heuristic: is this image a standalone furniture reference (a product shot) rather than a
 * room? Based on filename/annotation terms; staged/generated images are never furniture refs.
 * @param {{ isStaged?: boolean, isGenerated?: boolean, filename?: string | null, annotation?: string | null }} img - An image descriptor (HistoryImage or a lightweight { filename, annotation } meta).
 * @returns {boolean} true when the image looks like a furniture reference.
 */
export function isLikelyFurnitureReferenceImage(img) {
  if (!img || img.isStaged || img.isGenerated) return false;
  const hay = `${img.filename || ''} ${img.annotation || ''}`.toLowerCase();
  const furnitureTerms = /\b(chair|sofa|couch|table|desk|lamp|bed|ottoman|dresser|armchair|furniture|stool|bench|nightstand|credenza|sideboard|recliner)\b/;
  const roomTerms = /\b(room|living|bedroom|kitchen|bathroom|dining|office|interior|staging|staged|floor plan|blueprint|empty)\b/;
  return furnitureTerms.test(hay) && !roomTerms.test(hay);
}

/**
 * Whether an image can serve as the ROOM to place furniture into (staged/generated images
 * always qualify; otherwise anything not classified as a furniture reference).
 * @param {{ isStaged?: boolean, isGenerated?: boolean, filename?: string | null, annotation?: string | null }} img - An image descriptor.
 * @returns {boolean} true when the image is a valid room target.
 */
export function isRoomImageForFurniturePlacement(img) {
  if (!img) return false;
  if (img.isStaged || img.isGenerated) return true;
  return !isLikelyFurnitureReferenceImage(img);
}

/**
 * Classify an uploaded image's role from its filename/annotation (and staged/generated flags).
 * @param {{ isStaged?: boolean, isGenerated?: boolean, filename?: string | null, annotation?: string | null }} img - An image descriptor.
 * @returns {'room' | 'furniture' | 'unknown'} The inferred role.
 */
export function classifyUploadImageRole(img) {
  if (!img) return 'unknown';
  if (img.isStaged || img.isGenerated) return 'room';
  const hay = `${img.filename || ''} ${img.annotation || ''}`.toLowerCase();
  const furnitureTerms =
    /\b(chair|sofa|couch|table|desk|lamp|bed|ottoman|dresser|armchair|furniture piece|product shot|isolated|white background|dining chair|sectional|nightstand|stool|bench|credenza|sideboard|recliner)\b/;
  const roomTerms =
    /\b(room|living room|bedroom|kitchen|bathroom|dining room|office|interior|empty room|unfurnished|listing photo|real estate|walls|windows|floor|space)\b/;
  const furnitureHit = furnitureTerms.test(hay);
  const roomHit = roomTerms.test(hay);
  if (furnitureHit && !roomHit) return 'furniture';
  if (roomHit && !furnitureHit) return 'room';
  if (isLikelyFurnitureReferenceImage(img)) return 'furniture';
  if (roomHit) return 'room';
  return 'unknown';
}

/**
 * Split classified upload entries into a single room + one-or-more furniture references,
 * applying fallbacks (e.g. the common "furniture first, room second" two-image order).
 * @param {Array<{ role: string, buffer?: Buffer, filename?: string }>} entries - Classified upload entries.
 * @returns {{ room: any, furniture: any[] } | null} The room + furniture partition, or null when it cannot be split confidently.
 */
export function partitionDualUploadEntries(entries) {
  const rooms = entries.filter((e) => e.role === 'room');
  const furniture = entries.filter((e) => e.role === 'furniture');
  const unknown = entries.filter((e) => e.role === 'unknown');

  if (rooms.length >= 1 && furniture.length >= 1) {
    return { room: rooms[0], furniture: [...furniture, ...unknown] };
  }
  if (rooms.length === 1 && unknown.length >= 1 && furniture.length === 0) {
    return { room: rooms[0], furniture: unknown };
  }
  if (furniture.length === 1 && unknown.length >= 1 && rooms.length === 0) {
    return { room: unknown[0], furniture };
  }
  if (entries.length === 2 && rooms.length === 0 && furniture.length === 0) {
    // Common upload order: furniture first, room second
    return { room: entries[entries.length - 1], furniture: [entries[0]] };
  }
  return null;
}

/**
 * Detect a "room + furniture" dual upload among the current multipart files and split it into
 * a room buffer plus furniture buffers. Returns null when it is not a confident dual upload.
 * @param {any[]} files - The current multipart upload files (multer's array or fields shape).
 * @param {any[]} annotatedUserContent - The annotated user-content items (used to recover per-file annotations).
 * @param {string} message - The user's message text (used for "stage my room" fallbacks).
 * @returns {import('../types/chat.js').DualUploadResolution | null} The room + furniture split, or null.
 */
export function resolveDualUploadStaging(files, annotatedUserContent, message) {
  const imageFiles = (files || []).filter((f) => f.mimetype && f.mimetype.startsWith('image/'));
  if (imageFiles.length < 2) return null;

  const entries = imageFiles
    .map((file) => {
      const contentItem = (annotatedUserContent || []).find(
        (item) =>
          item.type === 'image_url' &&
          (item._filename === file.originalname || item.filename === file.originalname)
      );
      const meta = {
        filename: file.originalname,
        annotation: contentItem?._annotation || contentItem?.annotation || null,
      };
      return {
        buffer: file.buffer,
        role: classifyUploadImageRole(meta),
        filename: file.originalname,
      };
    })
    .filter((e) => e.buffer);

  if (entries.length < 2) return null;

  let partition = partitionDualUploadEntries(entries);
  const m = (message || '').toLowerCase();
  if (!partition && /\bstage\s+(my|the|this)\s+room\b/.test(m) && entries.length === 2) {
    partition = { room: entries[entries.length - 1], furniture: [entries[0]] };
  }
  if (!partition) return null;

  const furnitureBuffers = partition.furniture.map((e) => e.buffer).filter(Boolean);
  if (!partition.room?.buffer || furnitureBuffers.length === 0) return null;

  if (DEBUG_MODE) {
    logger.debug(
      `[Staging] Dual upload split: room="${partition.room.filename}", furniture=[${partition.furniture.map((f) => f.filename).join(', ')}]`
    );
  }

  return {
    roomBuffer: partition.room.buffer,
    furnitureBuffers,
    source: 'current upload (room + furniture)',
  };
}

/**
 * Same as {@link resolveDualUploadStaging} but sourcing the images from a message's content
 * array (data URLs) instead of multipart files. Returns null when it is not a dual upload.
 * @param {any[]} userMessageContent - A user message's content items (image_url data URLs).
 * @param {string} message - The user's message text (used for "stage my room" fallbacks).
 * @returns {import('../types/chat.js').DualUploadResolution | null} The room + furniture split, or null.
 */
export function resolveDualUploadFromMessageContent(userMessageContent, message) {
  if (!Array.isArray(userMessageContent)) return null;
  const imageItems = userMessageContent.filter(
    (item) => item.type === 'image_url' && item.image_url && item.image_url.url
  );
  if (imageItems.length < 2) return null;

  const entries = imageItems
    .map((item) => {
      const meta = {
        filename: item.filename || item.originalname,
        annotation: item._annotation || item.annotation || null,
      };
      const b64 = item.image_url.url.split(',')[1];
      if (!b64) return null;
      return {
        buffer: Buffer.from(b64, 'base64'),
        role: classifyUploadImageRole(meta),
        filename: meta.filename || 'upload',
      };
    })
    .filter(Boolean);

  if (entries.length < 2) return null;

  let partition = partitionDualUploadEntries(entries);
  const m = (message || '').toLowerCase();
  if (!partition && /\bstage\s+(my|the|this)\s+room\b/.test(m) && entries.length === 2) {
    partition = { room: entries[entries.length - 1], furniture: [entries[0]] };
  }
  if (!partition) return null;

  const furnitureBuffers = partition.furniture.map((e) => e.buffer).filter(Boolean);
  if (!partition.room?.buffer || furnitureBuffers.length === 0) return null;

  return {
    roomBuffer: partition.room.buffer,
    furnitureBuffers,
    source: 'message upload (room + furniture)',
  };
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
