// DEBUG-only image-context dump shared by /api/chat and /api/chat-upload,
// extracted verbatim from routes/chat.js.
//
// Both handlers logged the same four lines around the image context they are
// about to fold into the system instruction, differing only in the endpoint
// label inside the banner. The two original banners were
//
//   === IMAGE CONTEXT SENT TO AI (CHAT) ===          (39 chars)
//   ========================================         (40 chars)
//   === IMAGE CONTEXT SENT TO AI (CHAT-UPLOAD) ===   (46 chars)
//   ===============================================  (47 chars)
//
// i.e. the closing rule is always one '=' wider than the header, so it is
// derived here rather than passed in. test/chat/chat-image-context-log.test.js
// pins both endpoints' exact strings so the derivation cannot drift.
import { logger } from '../logger.js';

/**
 * DEBUG-only: dump the image context that is about to be appended to the system
 * instruction, or note that the conversation has no images. No-op unless `debugMode`.
 * @param {{ imageContext: string, label: string, debugMode: boolean }} args - The assembled image context, the endpoint label used in the banner ('CHAT' | 'CHAT-UPLOAD'), and the injected DEBUG_MODE flag.
 * @returns {void}
 */
export function logImageContextDebug({ imageContext, label, debugMode }) {
  if (!debugMode) return;
  if (imageContext) {
    const header = `=== IMAGE CONTEXT SENT TO AI (${label}) ===`;
    logger.debug(header);
    logger.debug(imageContext);
    logger.debug('='.repeat(header.length + 1));
  } else {
    logger.debug('[Image Context] No images in conversation history');
  }
}
