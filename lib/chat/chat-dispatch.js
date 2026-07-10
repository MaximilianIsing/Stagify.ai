// Shared post-routing orchestration glue for the AI Designer chat endpoints
// (slice of lib/chat/chat-pipeline.js). Once /api/chat and /api/chat-upload have
// a routing decision from OpenAI, they run the SAME glue around the pipeline's
// dispatch steps:
//   - suppress image actions when the model is only asking a clarifying question
//     (and drop a stray generate when the user is adding furniture to a staged room)
//   - log the outcome (business CSV row + a DEBUG-only dump)
//   - open / close the optional SSE stream
// Those blocks used to be copy-pasted into both handlers; they live here so there
// is one copy. The endpoint-specific bits (which history array is read, the
// staging/generate ORDER, upload-only staging synthesis and image-annotation
// extraction) stay in the handlers — this module only owns what is identical.
//
// deps: { DEBUG_MODE, logChatToFile }. DEBUG_MODE is read from the injected deps
// bundle (NOT lib/config/runtime-flags.js) so a test's injected value governs logging.
import { aiResponseDefersImageAction, chatWillProcessSlowImages, chatIntentType } from './chat-routing.js';
import { userWantsToAddFurnitureToRoom, findMostRecentStagedImageIndex } from './chat-history.js';
import { wantsStreamedChatResponse, initChatSse, writeChatSseEvent, finishStreamedChatResponse } from './chat-sse.js';
import { logger } from '../logger.js';

/**
 * Build the shared post-routing orchestration glue both chat handlers compose:
 * action suppression, outcome logging, and SSE stream begin/finish.
 * @param {{ DEBUG_MODE: boolean, logChatToFile: (userId: string, userMessage: string, aiResponse: string, files: any, ipAddress: string, userAgent: string) => void }} deps - Injected debug flag and the chat CSV writer.
 * @returns {{ applyPostRoutingSuppression: Function, logRoutingOutcome: Function, beginChatStream: Function, sendChatResponse: Function }} The dispatch-glue bundle.
 */
export default function createChatDispatch(deps) {
  const { DEBUG_MODE, logChatToFile } = deps;

  /**
   * Apply the two request-nulling rules both handlers share, in order:
   *   1. If the AI's reply only asks a clarifying question, suppress every image
   *      action (staging + generate + cad) so nothing is rendered yet.
   *   2. If the user is asking to add furniture to a room that already has a staged
   *      image in `history`, drop the generate request (staging handles it instead).
   * Pure w.r.t. `history`/text; returns the possibly-nulled requests — callers reassign.
   * @param {{ text: string, userMessageText: string, history: import('../types/chat.js').ChatMessage[], stagingRequestFromAI: any, generateRequestFromAI: any, cadRequestFromAI: any }} args - The reply text, the user's message, the history to scan for a staged image, and the three image requests.
   * @returns {{ stagingRequestFromAI: any, generateRequestFromAI: any, cadRequestFromAI: any }} The (possibly-nulled) staging/generate/cad requests.
   */
  function applyPostRoutingSuppression({ text, userMessageText, history, stagingRequestFromAI, generateRequestFromAI, cadRequestFromAI }) {
    if (aiResponseDefersImageAction(text)) {
      if (DEBUG_MODE) {
        logger.debug('[AI Designer] Suppressed staging/generate/cad: response asks clarifying questions');
      }
      stagingRequestFromAI = null;
      generateRequestFromAI = null;
      cadRequestFromAI = null;
    }

    if (userWantsToAddFurnitureToRoom(userMessageText) && findMostRecentStagedImageIndex(history) !== null) {
      generateRequestFromAI = null;
    }

    return { stagingRequestFromAI, generateRequestFromAI, cadRequestFromAI };
  }

  /**
   * Record the request outcome: always append the business CSV row, then (DEBUG only)
   * dump a per-request diagnostic block. `fileInfo`, when given, adds a "Files:" line
   * — the only shape difference between the /api/chat and /api/chat-upload dumps.
   * @param {{ req: import('express').Request, userId: string, userMessageText: string, text: string, files: any, memories: import('../types/chat.js').Memory[], label: string, fileInfo?: Array<{ name: string, type: string }> }} args - The request (for ip/ua), identity + message + reply, the files arg forwarded to the CSV writer, the loaded memories, the DEBUG label ('CHAT' | 'CHAT-UPLOAD'), and the optional upload file summary.
   * @returns {void}
   */
  function logRoutingOutcome({ req, userId, userMessageText, text, files, memories, label, fileInfo }) {
    const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';
    logChatToFile(userId, userMessageText, text, files, ipAddress, userAgent);

    if (!DEBUG_MODE) return;
    const header = `=== AI ${label} DEBUG ===`;
    logger.debug(header);
    logger.debug('User ID:', userId);
    logger.debug('User message:', userMessageText);
    if (fileInfo) {
      logger.debug('Files:', fileInfo.map(f => `${f.name} (${f.type})`).join(', '));
    }
    logger.debug('AI response:', text);
    logger.debug('Memories loaded:', memories.length);
    if (memories.length > 0) {
      logger.debug('Memories:', memories.map(m => m.content).join(', '));
    }
    logger.debug('='.repeat(header.length));
  }

  /**
   * Decide whether to stream, and if so open the SSE channel with the initial status +
   * message events. Streaming is used only when the client asked for it AND the routing
   * decision will run a slow image step (staging/generate/cad). Returns the decision so
   * the caller can branch the final send.
   * @param {{ req: import('express').Request, res: import('express').Response, text: string, memoryActions: import('../types/chat.js').MemoryActions, stagingRequestFromAI: any, generateRequestFromAI: any, cadRequestFromAI: any }} args - The req/res pair, the reply text + memory actions to emit first, and the three image requests that gate streaming.
   * @returns {boolean} Whether the response is being streamed (SSE already opened when true).
   */
  function beginChatStream({ req, res, text, memoryActions, stagingRequestFromAI, generateRequestFromAI, cadRequestFromAI }) {
    const streamMode =
      wantsStreamedChatResponse(req) &&
      chatWillProcessSlowImages(stagingRequestFromAI, generateRequestFromAI, cadRequestFromAI);
    if (streamMode) {
      initChatSse(res);
      writeChatSseEvent(res, 'status', {
        type: chatIntentType(stagingRequestFromAI, generateRequestFromAI, cadRequestFromAI),
      });
      writeChatSseEvent(res, 'message', {
        response: text,
        memories: memoryActions,
      });
    }
    return streamMode;
  }

  /**
   * Send the assembled response the right way for the mode: finish the SSE stream when
   * streaming, otherwise a plain JSON body.
   * @param {{ res: import('express').Response, response: any, streamMode: boolean }} args - The response object, the assembled payload, and the streaming decision from beginChatStream.
   * @returns {void}
   */
  function sendChatResponse({ res, response, streamMode }) {
    if (streamMode) {
      finishStreamedChatResponse(res, response);
    } else {
      res.json(response);
    }
  }

  return { applyPostRoutingSuppression, logRoutingOutcome, beginChatStream, sendChatResponse };
}
