// Conversation-history sanitization: strip unsupported image types, drop
// duplicate messages, and collapse history images to text placeholders before
// a payload reaches OpenAI. Split out of chat-history.js; pure over their
// inputs except for DEBUG_MODE-gated logging.
import { DEBUG_MODE } from '../config/runtime-flags.js';
import { logger } from '../logger.js';

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
