// "Add this furniture to my staged room" rescue for POST /api/chat-upload,
// extracted verbatim from routes/chat.js.
//
// Upload-only: when the user uploads a furniture photo and asks for it to be put
// into the room they already staged, the routing model sometimes returns no
// staging action at all. If the conversation already contains a staged image, the
// handler synthesizes one so the upload is not silently dropped.
//
// Pure over its arguments; no deps bundle.
import { userWantsToAddFurnitureToRoom, findMostRecentStagedImageIndex } from './chat-history.js';

/**
 * Return the staging request to dispatch: the model's own when it produced one,
 * otherwise a synthesized "add the uploaded furniture to the existing staged room"
 * request when (a) the message reads as such a request and (b) the history actually
 * holds a staged image. Returns the input unchanged in every other case.
 * @param {{ stagingRequestFromAI: any, message: string, conversationHistory: any[] }} args - The routing model's staging request (possibly null), the user's message, and the deduplicated conversation history.
 * @returns {any} The staging request to dispatch (possibly synthesized).
 */
export function resolveAddFurnitureStaging({ stagingRequestFromAI, message, conversationHistory }) {
  if (
    !stagingRequestFromAI &&
    userWantsToAddFurnitureToRoom(message) &&
    findMostRecentStagedImageIndex(conversationHistory) !== null
  ) {
    return {
      shouldStage: true,
      roomType: 'Other',
      additionalPrompt: message || 'Add the uploaded furniture to the existing staged room.',
      removeFurniture: false,
      usePreviousImage: false,
      furnitureImageIndex: null,
    };
  }
  return stagingRequestFromAI;
}
