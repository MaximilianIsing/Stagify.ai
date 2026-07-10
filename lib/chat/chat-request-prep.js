// Pre-routing preparation for POST /api/chat — the JSON-endpoint mirror of
// chat-upload-prep.js. Extracted verbatim from routes/chat.js: dedup
// diagnostics, detection of a usable image already in conversation history,
// message-tag application, assembly of the OpenAI messages array (image
// cleaning + downscaling), and the DEBUG-only outgoing-payload logging.
//
// deps: { DEBUG_MODE, downscaleImageForGPT }
import { filterUnsupportedFiles } from './chat-history.js';
import { logger } from '../logger.js';

export default function createChatRequestPrep(deps) {
  const { DEBUG_MODE, downscaleImageForGPT } = deps;

  // DEBUG-only: list which of the original `messages` were dropped as duplicates.
  // The caller runs this only when the counts differ.
  function logDedupDiagnostics(messages, deduplicatedMessages) {
    if (!DEBUG_MODE) return;
    const removedCount = messages.length - deduplicatedMessages.length;
    logger.debug(`[Deduplication] Removed ${removedCount} duplicate message(s) from ${messages.length} total messages`);
    // Log which messages were duplicates
    const seenKeys = new Set();
    messages.forEach((msg, idx) => {
      const key = Array.isArray(msg.content)
        ? `${msg.role}:${JSON.stringify(msg.content.map(item => item.type === 'text' ? item.text : item.type))}`
        : `${msg.role}:${typeof msg.content === 'string' ? msg.content.trim() : 'non-string'}`;
      if (seenKeys.has(key)) {
        logger.debug(`[Deduplication] Duplicate found at index ${idx}: ${msg.role} message`);
      } else {
        seenKeys.add(key);
      }
    });
  }

  // Find an image already present in the conversation to reuse for staging.
  // Staged assistant images win over user uploads (they are the target of a
  // modification). Returns { hasImageInHistory, imageFromHistory, isStagedImage }.
  function detectHistoryImage(messages, deduplicatedMessages) {
    let hasImageInHistory = false;
    let imageFromHistory = null;
    let isStagedImage = false;

    // First, check for staged images (from assistant messages) - prioritize these for modifications
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const imageItem = msg.content.find(item => item.type === 'image_url' && item.isStaged);
        if (imageItem && imageItem.image_url && imageItem.image_url.url) {
          hasImageInHistory = true;
          imageFromHistory = imageItem.image_url.url;
          isStagedImage = true;
          if (DEBUG_MODE) {
            logger.debug(`[Staging] Found staged image in conversation history`);
          }
          break;
        }
      }
    }

    // If no staged image found, check for user-uploaded images
    if (!hasImageInHistory) {
      for (let i = deduplicatedMessages.length - 1; i >= 0; i--) {
        const msg = deduplicatedMessages[i];
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          const imageItem = msg.content.find(item => item.type === 'image_url');
          if (imageItem && imageItem.image_url && imageItem.image_url.url) {
            hasImageInHistory = true;
            imageFromHistory = imageItem.image_url.url;
            if (DEBUG_MODE) {
              logger.debug(`[Staging] Found user-uploaded image in conversation history`);
            }
            break;
          }
        }
      }
    }

    return { hasImageInHistory, imageFromHistory, isStagedImage };
  }

  // Prefix the last user message with the routing tag the client selected
  // (Generate/Stage/CAD-Stage/Describe). Mutates `filteredMessages` in place.
  function applyMessageTag(filteredMessages, messageTag) {
    if (messageTag && messageTag !== 'auto' && filteredMessages.length > 0) {
      const lastMessage = filteredMessages[filteredMessages.length - 1];
      if (lastMessage.role === 'user') {
        const tagMap = {
          'generate': '[TAG: Generate]',
          'stage': '[TAG: Stage]',
          'cad-stage': '[TAG: CAD-Stage]',
          'describe': '[TAG: Describe/Recall]'
        };
        const tagText = tagMap[messageTag] || '';

        if (Array.isArray(lastMessage.content)) {
          // Find the first text item or add one
          const textItem = lastMessage.content.find(item => item.type === 'text');
          if (textItem) {
            textItem.text = `${tagText} ${textItem.text}`.trim();
          } else {
            lastMessage.content.unshift({ type: 'text', text: tagText });
          }
        } else if (typeof lastMessage.content === 'string') {
          lastMessage.content = `${tagText} ${lastMessage.content}`.trim();
        }
      }
    }
  }

  // Assemble the OpenAI messages array: system instruction first, then each
  // filtered message with current-message images cleaned to the { type,
  // image_url: { url } } shape OpenAI expects and downscaled before send.
  async function buildChatMessages({ filteredMessages, systemInstruction }) {
    return [
      { role: 'system', content: systemInstruction },
      ...await Promise.all(filteredMessages.map(async (msg) => {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          // User message with images - only current message has images, apply filter
          const { filteredContent } = filterUnsupportedFiles(msg.content);
          // Clean image objects - remove extra properties that OpenAI doesn't accept and downscale images
          const cleanedContent = await Promise.all(filteredContent.map(async (item) => {
            if (item.type === 'image_url' && item.image_url && item.image_url.url) {
              // Downscale image if needed before sending to GPT
              const downscaledUrl = await downscaleImageForGPT(item.image_url.url);
              // Only keep the structure OpenAI expects: { type: 'image_url', image_url: { url: '...' } }
              return {
                type: 'image_url',
                image_url: {
                  url: downscaledUrl
                }
              };
            }
            return item;
          }));
          return {
            role: 'user',
            content: cleanedContent
          };
        } else {
          // All other messages are text-only (images stripped)
          return {
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content
          };
        }
      }))
    ];
  }

  // DEBUG-only: log the outgoing payload size and a per-message summary.
  function logChatPayload({ openaiMessages }) {
    if (!DEBUG_MODE) return;
    const messagesJson = JSON.stringify(openaiMessages);
    const payloadSize = Buffer.byteLength(messagesJson, 'utf8');
    const payloadSizeKB = (payloadSize / 1024).toFixed(2);
    const payloadSizeMB = (payloadSize / (1024 * 1024)).toFixed(2);

    logger.debug('=== SENDING TO AI (CHAT) ===');
    logger.debug('Payload size:', payloadSize, 'bytes (', payloadSizeKB, 'KB /', payloadSizeMB, 'MB)');
    logger.debug('Number of messages:', openaiMessages.length);
    // Log individual messages instead of full array
    logger.debug('--- MESSAGES ---');
    openaiMessages.forEach((msg, index) => {
      if (msg.role === 'system') {
        logger.debug(`Message ${index + 1} [SYSTEM]:`, msg.content.substring(0, 500) + (msg.content.length > 500 ? '... [truncated]' : ''));
      } else if (msg.role === 'user') {
        if (Array.isArray(msg.content)) {
          const textItems = msg.content.filter(item => item.type === 'text');
          const imageItems = msg.content.filter(item => item.type === 'image_url');
          const textContent = textItems.map(item => item.text).join(' ');
          logger.debug(`Message ${index + 1} [USER]: Text: "${textContent.substring(0, 200)}${textContent.length > 200 ? '...' : ''}" | Images: ${imageItems.length}`);
        } else {
          logger.debug(`Message ${index + 1} [USER]:`, msg.content.substring(0, 200) + (msg.content.length > 200 ? '...' : ''));
        }
      } else if (msg.role === 'assistant') {
        if (Array.isArray(msg.content)) {
          const textItems = msg.content.filter(item => item.type === 'text');
          const textContent = textItems.map(item => item.text).join(' ');
          logger.debug(`Message ${index + 1} [ASSISTANT]:`, textContent.substring(0, 200) + (textContent.length > 200 ? '...' : ''));
        } else {
          logger.debug(`Message ${index + 1} [ASSISTANT]:`, msg.content.substring(0, 200) + (msg.content.length > 200 ? '...' : ''));
        }
      }
    });
    logger.debug('----------------');

    // Log image data sizes if present
    openaiMessages.forEach((msg, idx) => {
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        msg.content.forEach((item, itemIdx) => {
          if (item.type === 'image_url' && item.image_url && item.image_url.url) {
            const imageDataSize = Buffer.byteLength(item.image_url.url, 'utf8');
            logger.debug(`Message ${idx}, Image ${itemIdx}: ${(imageDataSize / 1024).toFixed(2)} KB`);
          }
        });
      }
    });
    logger.debug('============================');
    logger.debug('Calling OpenAI API...');
  }

  return { logDedupDiagnostics, detectHistoryImage, applyMessageTag, buildChatMessages, logChatPayload };
}
