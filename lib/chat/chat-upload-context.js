// Request→context assembly for POST /api/chat-upload, extracted verbatim from
// routes/chat.js.
//
// The multipart upload endpoint has to reconstruct, from form fields, what the
// JSON endpoint gets for free: the conversation history (a JSON string field) and
// the system instruction (base prompt + the image context of the PRIOR history +
// the base-image selection context). It then patches the user-content array with
// a stand-in text item when the upload carried no usable message.
//
// Everything here is pre-routing input shaping. Pure apart from the DEBUG-only
// image-context dump and the JSON-parse error log.
//
// deps: none injected — DEBUG_MODE arrives as an explicit `debugMode` argument.
import { buildChatUploadSystemInstruction, getStagifyDateContext } from '../staging/prompts.js';
import { getPriorHistoryForImageContext, buildImageContext, getBaseImageSelectionContext, collectImagesFromHistory } from './chat-history.js';
import { logImageContextDebug } from './chat-image-context-log.js';
import { logger } from '../logger.js';

/**
 * The note appended when the current upload's image(s) are the only ones in the
 * conversation, so the model must not ask "did you mean the first or the second
 * image?".
 */
export const SOLE_UPLOAD_NOTE =
  '\n\nCURRENT UPLOAD NOTE: The image(s) in THIS user message are the only image(s) in the conversation so far. Do not ask whether the user meant a first or second image — proceed with this upload.';

/**
 * Parse the `conversationHistory` form field. Accepts either a JSON string or an
 * already-parsed value; a malformed string is logged and degrades to an empty
 * history rather than failing the request (original behaviour).
 * @param {string | any[] | undefined} raw - The raw `conversationHistory` form field.
 * @returns {any[]} The parsed history, or [] when absent/unparseable.
 */
export function parseConversationHistory(raw) {
  let conversationHistory = [];
  if (raw) {
    try {
      conversationHistory = typeof raw === 'string'
        ? JSON.parse(raw)
        : raw;
    } catch (error) {
      logger.error('Error parsing conversation history:', error);
      conversationHistory = [];
    }
  }
  return conversationHistory;
}

/**
 * Build the upload endpoint's system instruction and the history slice it was
 * derived from: base upload prompt (+ memories, + date), then the image context of
 * the history EXCLUDING the files being uploaded right now, then the base-image
 * selection context. Also emits the DEBUG-only image-context dump.
 * @param {{ memories: import('../types/chat.js').Memory[], files: import('../types/chat.js').UploadedFile[], conversationHistory: any[], baseImageIndex: number | null, debugMode: boolean }} args - Stored memories, the current upload's files (their filenames are excluded from the image context), the deduplicated history, the parsed base-image index, and the injected DEBUG_MODE flag.
 * @returns {{ systemInstruction: string, historyForImageContext: any[], imageContext: string }} The assembled instruction, the prior-history slice used for image indexing, and the raw image context.
 */
export function buildUploadContext({ memories, files, conversationHistory, baseImageIndex, debugMode }) {
  let systemInstruction = buildChatUploadSystemInstruction({ memories, dateContext: getStagifyDateContext() });

  const currentUploadFilenames = (files || []).map((f) => f.originalname).filter(Boolean);
  const historyForImageContext = getPriorHistoryForImageContext(conversationHistory, currentUploadFilenames);
  const { imageContext } = buildImageContext(historyForImageContext);

  logImageContextDebug({ imageContext, label: 'CHAT-UPLOAD', debugMode });

  if (imageContext) {
    systemInstruction += imageContext;
  }
  systemInstruction += getBaseImageSelectionContext(baseImageIndex, historyForImageContext);

  return { systemInstruction, historyForImageContext, imageContext };
}

/**
 * Append SOLE_UPLOAD_NOTE when this upload carries image(s) and the prior history
 * has none — otherwise return the instruction unchanged.
 * @param {{ systemInstruction: string, hasImages: boolean, historyForImageContext: any[] }} args - The instruction so far, whether the upload contains images, and the prior-history slice.
 * @returns {string} The (possibly extended) system instruction.
 */
export function appendSoleUploadNote({ systemInstruction, hasImages, historyForImageContext }) {
  if (hasImages && collectImagesFromHistory(historyForImageContext).length === 0) {
    return systemInstruction + SOLE_UPLOAD_NOTE;
  }
  return systemInstruction;
}

/**
 * Ensure the user-content array is never effectively empty: prepend a stand-in text
 * item so the model has something to answer. MUTATES `userContent` in place.
 *
 * The two branches are NOT symmetrical, and that asymmetry is original: with
 * unsupported files present the "is the existing text item blank?" test trims
 * (`!text.trim()`), while the no-unsupported-files branch does not (`!text`). Kept
 * verbatim.
 * @param {{ userContent: any[], message: string, unsupportedFiles: Array<{ name: string, type: string }> }} args - The content array to patch, the user's message, and the rejected-file list.
 * @returns {void}
 */
export function applyDefaultUserContentText({ userContent, message, unsupportedFiles }) {
  // If there are unsupported files, ensure the AI acknowledges them
  if (unsupportedFiles.length > 0) {
    // The unsupported files are already mentioned in userContent, but make sure there's a clear message
    if (!message || !message.trim()) {
      // If no user message, add a prompt for the AI to acknowledge unsupported files

      if (userContent.length === 0 || (userContent.length === 1 && userContent[0].type === 'text' && !userContent[0].text.trim())) {
        userContent.unshift({ type: 'text', text: `I uploaded ${unsupportedFiles.length > 1 ? 'some files' : 'a file'} but ${unsupportedFiles.length > 1 ? 'they are' : 'it is'} in an unsupported format.` });
      }
    }
  } else if (userContent.length === 0 || (userContent.length === 1 && userContent[0].type === 'text' && !userContent[0].text)) {
    // Only add default message if no unsupported files and no content
    userContent.unshift({ type: 'text', text: 'Please analyze these files.' });
  }
}
