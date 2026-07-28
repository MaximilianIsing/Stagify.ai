// The endpoint-specific "final image fallback" for runStagingRequests, extracted
// verbatim from routes/chat.js.
//
// When a staging request has neither a dual upload nor a usePreviousImage
// selection, the staging dispatch asks its caller for one last candidate image.
// The two endpoints answer differently, which is why this is a callback rather
// than something the dispatch resolves itself:
//   - /api/chat has no multipart upload, so it falls back to the newest image
//     already in the conversation (a staged assistant image wins over a user one);
//   - /api/chat-upload falls back to the image in THIS upload — unless the user is
//     asking to add furniture to an existing staged room, in which case the
//     uploaded photo is the furniture, not the room, and must not become the base.
//
// Pure over their arguments; no deps bundle.
import { userWantsToAddFurnitureToRoom } from './chat-history.js';

/**
 * /api/chat: reuse the image detected in conversation history (see
 * chat-request-prep's detectHistoryImage) as the staging base. Returns null when
 * there is no such image or its data URL carries no base64 payload.
 * @param {{ imageFromHistory: string | null, isStagedImage: boolean }} args - The history image data URL and whether it came from a staged assistant message.
 * @returns {import('../types/chat.js').FallbackImageResolution | null} The fallback image, or null when unavailable.
 */
export function resolveHistoryFallbackImage({ imageFromHistory, isStagedImage }) {
  if (imageFromHistory) {
    const base64Data = imageFromHistory.split(',')[1];
    if (base64Data) {
      return {
        buffer: Buffer.from(base64Data, 'base64'),
        source: isStagedImage ? 'staged image' : 'conversation history',
        logMessage: '[Staging] Using image from conversation history (fallback)',
      };
    }
  }
  return null;
}

/**
 * /api/chat-upload: use the first image of the current upload as the staging base,
 * unless the message reads as "add this furniture to my staged room" — then the
 * upload is the furniture and the room must come from history instead.
 * @param {{ firstImageFile: import('../types/chat.js').UploadedFile | null, message: string }} args - The first image file of this upload (if any) and the user's message.
 * @returns {import('../types/chat.js').FallbackImageResolution | null} The fallback image, or null when unavailable/suppressed.
 */
export function resolveCurrentUploadFallbackImage({ firstImageFile, message }) {
  if (firstImageFile && !userWantsToAddFurnitureToRoom(message)) {
    return {
      buffer: firstImageFile.buffer,
      source: 'current message',
      logMessage: '[Staging] Using image from current message',
    };
  }
  return null;
}
