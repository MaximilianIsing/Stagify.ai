// chat routes, extracted verbatim from server.js.
//
// Both handlers are orchestration only: each cohesive step lives in a module
// under lib/chat/ (see chat-request-prep / chat-upload-prep / chat-upload-context
// for preparation, chat-pipeline for dispatch, chat-post-routing for sequencing).
//
// ONE THING TO KNOW BEFORE EDITING: /api/chat and /api/chat-upload are NOT two
// copies of the same flow. The post-routing dispatch runs generation BEFORE
// staging on /api/chat and staging BEFORE generation on /api/chat-upload. That
// order is passed into runPostRoutingDispatch explicitly by each handler
// (GENERATE_THEN_STAGING vs STAGING_THEN_GENERATE); it decides which step's
// text suffix lands first and which model call happens first, so collapsing the
// two handlers — or defaulting the order — is a silent behaviour change.
import { createAsyncRouter } from '../lib/http/async-router.js';
import createChatPipeline from '../lib/chat/chat-pipeline.js';
import createUploadPrep from '../lib/chat/chat-upload-prep.js';
import { buildChatSystemInstruction, getStagifyDateContext } from '../lib/staging/prompts.js';
import { deduplicateMessages, filterConversationHistory, stripImagesFromHistory, parseBaseImageIndex, getBaseImageSelectionContext, resolveDualUploadStaging, resolveDualUploadFromMessageContent, buildImageContext } from '../lib/chat/chat-history.js';
import { writeChatSseEvent } from '../lib/chat/chat-sse.js';
import { sendError } from '../lib/http/http-helpers.js';
import { reportError } from '../lib/http/error-ref.js';
import createWelcomeMessageHandler from '../lib/chat/welcome-message-handler.js';
import createChatRequestPrep from '../lib/chat/chat-request-prep.js';
import { resolveUploadErrorBody } from '../lib/chat/chat-upload-error.js';
import { isContextLimitReached, buildContextLimitResponse } from '../lib/chat/chat-context-limit.js';
import { logImageContextDebug } from '../lib/chat/chat-image-context-log.js';
import { extractCurrentMessageImage } from '../lib/chat/chat-current-image.js';
import { resolveHistoryFallbackImage, resolveCurrentUploadFallbackImage } from '../lib/chat/chat-staging-fallback.js';
import { parseConversationHistory, buildUploadContext, appendSoleUploadNote, applyDefaultUserContentText } from '../lib/chat/chat-upload-context.js';
import { resolveAddFurnitureStaging } from '../lib/chat/chat-furniture-staging.js';
import { extractUploadImageAnnotations } from '../lib/chat/chat-upload-annotations.js';
import createPostRoutingDispatch, { GENERATE_THEN_STAGING, STAGING_THEN_GENERATE } from '../lib/chat/chat-post-routing.js';
import { resolveChatModel } from '../lib/config/model-config.js';

/**
 * Build the AI Designer chat router (/api/chat, /api/chat-upload,
 * /api/welcome-message). `deps` is the injection bag from server.js; it is
 * forwarded wholesale to the sub-factories (chat-pipeline / upload-prep /
 * welcome / request-prep), each of which destructures its own slice — so this
 * type covers every prop consumed anywhere in the chat subsystem, not just the
 * ones referenced directly below.
 *
 * @param {{
 *   openai: any,
 *   genLimiter: import('express').RequestHandler,
 *   chatUpload: import('multer').Multer,
 *   DEBUG_MODE: boolean,
 *   requireProAccount: (req: import('express').Request, res: import('express').Response) => any,
 *   recordStagingActivity?: ReturnType<typeof import('../lib/services/auth-helpers.js').createAuthHelpers>['recordStagingActivity'],
 *   loadMemories: (userId: any) => any[],
 *   saveMemories: Function,
 *   getTemperatureForModel: (model: string) => number,
 *   getGeminiImageModel: typeof import('../lib/config/model-config.js').getGeminiImageModel,
 *   annotateImage: (imageDataUrl: string, isCAD?: boolean, detectBlueprint?: boolean) => Promise<string | null>,
 *   downscaleImageForGPT: (dataUrl: string) => Promise<string>,
 *   processImageGeneration: ReturnType<typeof import('../lib/staging/staging-generation.js').createStagingGeneration>['processImageGeneration'],
 *   processStaging: ReturnType<typeof import('../lib/staging/staging-generation.js').createStagingGeneration>['processStaging'],
 *   logChatToFile: ReturnType<typeof import('../lib/services/logging.js').createLogging>['logChatToFile'],
 *   blueprintTo3D: ReturnType<typeof import('../lib/staging/cad-handling.js').createCadHandling>['blueprintTo3D'],
 *   incPromptCount: typeof import('../lib/data/counters.js').incPromptCount,
 *   renderPersistence?: ReturnType<typeof import('../lib/staging/render-persistence.js').createRenderPersistence>,
 * }} deps - Injected OpenAI client, rate-limit + upload middleware, the pro gate,
 *   memory load/save, model resolvers, the image annotation/downscale/staging/
 *   generation/CAD helpers, chat CSV logging, the prompt counter, and the gallery
 *   writer. The bag is forwarded wholesale to createChatPipeline, so `renderPersistence`
 *   reaches lib/chat/chat-staging.js without this file naming it again — only the
 *   STAGING path uses it. Image GENERATION deliberately writes nothing: a text-to-image
 *   reply is a conversational artifact, not a render of a property, and it carries no
 *   room type, no style and no source photo to name an entry by.
 */
export default function createChatRouter(deps) {
  // Direct deps used by the handlers. The post-routing dispatch deps
  // (staging/generate/CAD/memory helpers, image resolution, CSV+debug logging,
  // SSE streaming, etc.) are consumed by createChatPipeline(deps) below rather
  // than referenced here.
  const { openai, genLimiter, chatUpload, DEBUG_MODE, requireProAccount, loadMemories } = deps;
  const recordStagingActivity = deps.recordStagingActivity || (() => false);
  const router = createAsyncRouter();

  /**
   * Mark a trial/paid account as having actually used the AI Designer.
   *
   * The AI Designer is Stagify+ only, so every image it produces is trial usage — but
   * it wrote no activity timestamp at all, so the lifecycle sweep classified a user who
   * lived in this tool as "signed up but never staged". They were then sent the day-1
   * "you haven't staged anything yet" nudge and never the mid-trial value email.
   *
   * Only image-producing turns count: a plain chat message is a conversation, not a
   * render, and treating it as activation would make the signal meaningless.
   * @param {any} user - The validated pro account for this request.
   * @param {{ stagingResults?: any[], generatedImages?: any[] }} dispatch - The post-routing dispatch result.
   */
  function recordDesignerActivity(user, dispatch) {
    const produced = (dispatch?.stagingResults?.length || 0) + (dispatch?.generatedImages?.length || 0);
    if (produced > 0) recordStagingActivity(user);
  }
  const { applyMemoryActions, runGenerateRequests, resolveRecalledImage, resolveRequestedImage, runCadRequests, runStagingRequests, buildDesignerResponse, applyPostRoutingSuppression, logRoutingOutcome, beginChatStream, sendChatResponse } = createChatPipeline(deps);
  const { buildUploadUserContent, buildUploadMessages, logUploadPayload, runUploadRouting, logUploadDedupDiagnostics } = createUploadPrep(deps);
  const { handleWelcomeMessage } = createWelcomeMessageHandler(deps);
  const { logDedupDiagnostics, detectHistoryImage, applyMessageTag, buildChatMessages, logChatPayload, runChatRouting } = createChatRequestPrep(deps);
  const { runPostRoutingDispatch } = createPostRoutingDispatch({
    runStagingRequests, runGenerateRequests, resolveRecalledImage, resolveRequestedImage, runCadRequests,
  });

router.get('/api/welcome-message', handleWelcomeMessage);

router.post('/api/chat', genLimiter, async (req, res) => {
  try {
    const proUser = requireProAccount(req, res);
    if (!proUser) return;

    if (!openai) {
      return sendError(res, 500, 'AI service not properly configured');
    }

    const { messages, model, messageTag, baseImageIndex: baseImageIndexRaw } = req.body;
    const baseImageIndex = parseBaseImageIndex(baseImageIndexRaw);

    // Resolve the client-supplied model through the allow-list — this value is
    // forwarded to OpenAI verbatim. requireProAccount above already guarantees a
    // paid account, hence isPro: true.
    const selectedModel = resolveChatModel(model, { isPro: true });

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return sendError(res, 400, 'Messages array is required');
    }

    // Deduplicate messages to prevent double counting
    const deduplicatedMessages = deduplicateMessages(messages);
    if (deduplicatedMessages.length !== messages.length) {
      logDedupDiagnostics(messages, deduplicatedMessages);
    }

    // Check message limit (see lib/chat/chat-context-limit.js)
    if (isContextLimitReached(deduplicatedMessages)) {
      return res.json(buildContextLimitResponse());
    }

    // Key per-user data on the validated session account — NOT a client-supplied
    // body field. Trusting req.body.userId here would let any signed-in user read
    // or overwrite another account's memories by passing that account's id (IDOR).
    const userId = proUser.id;

    // Load stored memories for this user
    let memories = loadMemories(userId);

    // Build context about available images in history with annotations
    const { imageContext } = buildImageContext(deduplicatedMessages);
    logImageContextDebug({ imageContext, label: 'CHAT', debugMode: DEBUG_MODE });

    // Build system instruction with memories
    const systemInstruction = buildChatSystemInstruction({ imageContext, memories, dateContext: getStagifyDateContext(), baseSelectionContext: getBaseImageSelectionContext(baseImageIndex, deduplicatedMessages) });

    // Get the last user message
    const lastUserMessage = messages.filter(m => m.role === 'user').pop();
    const lastUserMessageText = lastUserMessage ? (typeof lastUserMessage.content === 'string' ? lastUserMessage.content : '') : '';

    // Check if there are images in conversation history (from user uploads or staged images)
    const { imageFromHistory, isStagedImage } = detectHistoryImage(messages, deduplicatedMessages);

    // Strip images from conversation history (except current message) to prevent payload size issues
    // Only send text context, images will be requested via special mechanism if needed
    const strippedMessages = stripImagesFromHistory(deduplicatedMessages, true); // Keep images in current message only

    // Apply middleman filter to remove unsupported files
    const filteredMessages = filterConversationHistory(strippedMessages);

    // Add message tag to the last user message if provided
    applyMessageTag(filteredMessages, messageTag);

    const openaiMessages = await buildChatMessages({ filteredMessages, systemInstruction });

    // Debug logging - log what's being sent to AI (DEBUG_MODE only)
    logChatPayload({ openaiMessages });

    // Ask the model for a routing decision. A failed call is answered here (not by
    // the outer catch) so the client still gets a user-facing `response` string.
    const routing = await runChatRouting({ openaiMessages, selectedModel });
    if (routing.routingError) {
      return sendError(res, 500, 'Failed to get AI response', {
        details: 'The AI service encountered an error. Please try again.',
        response: 'I apologize, but I encountered an error processing your request. Please try again.',
      });
    }
    const { text, memoryActionsFromAI, imageRequestFromAI, recallRequestFromAI } = routing;
    let { stagingRequestFromAI, generateRequestFromAI, cadRequestFromAI } = routing;

    ({ stagingRequestFromAI, generateRequestFromAI, cadRequestFromAI } = applyPostRoutingSuppression({
      text,
      userMessageText: lastUserMessageText,
      history: messages,
      stagingRequestFromAI,
      generateRequestFromAI,
      cadRequestFromAI,
    }));

    // Log chat to CSV + DEBUG dump.
    logRoutingOutcome({ req, userId, userMessageText: lastUserMessageText, text, files: [], memories, label: 'CHAT' });

    // Apply the AI's memory stores/forgets.
    const memoryResult = applyMemoryActions({
      memoryActionsFromAI,
      memories,
      userId,
      userMessageText: lastUserMessageText,
    });
    memories = memoryResult.memories;
    const memoryActions = memoryResult.memoryActions;

    const streamMode = beginChatStream({
      req, res, text, memoryActions,
      stagingRequestFromAI, generateRequestFromAI, cadRequestFromAI,
    });

    // The current-message image is loop-invariant AND shared by the staging and CAD
    // steps (which used to re-scan lastUserMessage.content with identical
    // predicates), so resolve it once up front.
    const currentImage = extractCurrentMessageImage(lastUserMessage);

    const dispatch = await runPostRoutingDispatch({
      text,
      // Image generation runs before staging in this endpoint (original order) —
      // the OPPOSITE of /api/chat-upload. See lib/chat/chat-post-routing.js.
      order: GENERATE_THEN_STAGING,
      generateArgs: { generateRequestFromAI, req, selectedModel },
      stagingArgs: {
        stagingRequestFromAI,
        history: messages,
        userMessageText: lastUserMessageText,
        userId,
        req,
        selectedModel,
        baseImageIndex,
        currentMessageHasImage: currentImage.hasImage,
        currentImageBuffer: currentImage.buffer,
        applyOriginalKeywordFallback: true,
        resolveDualUpload: () => resolveDualUploadFromMessageContent(
          lastUserMessage && Array.isArray(lastUserMessage.content) ? lastUserMessage.content : null,
          lastUserMessageText
        ),
        resolveFallbackImage: () => resolveHistoryFallbackImage({ imageFromHistory, isStagedImage }),
        // The account the resulting gallery entries belong to. The whole user, not just
        // `userId` above, because renderPersistence needs the plan to apply the cap.
        user: proUser,
      },
      recallArgs: { recallRequestFromAI, history: messages },
      requestedArgs: {
        imageRequestFromAI,
        history: messages,
        baseMessages: openaiMessages,
        systemInstruction,
        userMessageText: lastUserMessageText,
        analysisUserText: lastUserMessageText,
        selectedModel,
      },
      cadArgs: {
        cadRequestFromAI,
        history: messages,
        baseImageIndex,
        currentMessageHasImage: currentImage.hasImage,
      },
    });

    recordDesignerActivity(proUser, dispatch);

    const response = await buildDesignerResponse({
      text: dispatch.text,
      memoryActions,
      stagingResults: dispatch.stagingResults,
      generatedImages: dispatch.generatedImages,
      requestedImageForDisplay: dispatch.requestedImageForDisplay,
      recalledImageForDisplay: dispatch.recalledImageForDisplay,
      cadResults: dispatch.cadResults,
    });

    sendChatResponse({ res, response, streamMode });
  } catch (error) {
    const ref = reportError('chat', error);
    if (res.headersSent) {
      writeChatSseEvent(res, 'error', { error: 'Chat processing failed', ref });
      res.end();
    } else {
      sendError(res, 500, 'Chat processing failed', { ref });
    }
  }
});

router.post('/api/chat-upload', genLimiter, chatUpload.array('files', 5), async (req, res) => {
  try {
    const proUser = requireProAccount(req, res);
    if (!proUser) return;

    if (!openai) {
      return sendError(res, 500, 'AI service not properly configured');
    }

    if (!req.files || req.files.length === 0) {
      return sendError(res, 400, 'No files provided');
    }

    // Get message tag from form data
    const messageTag = req.body.messageTag;

    // Key per-user data on the validated session account, never a body field (see /api/chat).
    const userId = proUser.id;

    // Load stored memories for this user
    let memories = loadMemories(userId);

    const { message = '', conversationHistory: conversationHistoryStr, model } = req.body;
    // `.array()` uploads give an array; the map-shaped `.fields()` fallback is
    // any-cast here — at the entry — so every downstream module can name the
    // UploadedFile[] it actually receives instead of widening its own contract.
    /** @type {import('../lib/types/chat.js').UploadedFile[]} */
    const files = Array.isArray(req.files) ? /** @type {any} */ (req.files) : /** @type {any} */ ([req.files]);

    // Allow-listed before it reaches OpenAI (see /api/chat); pro-gated above.
    const selectedModel = resolveChatModel(model, { isPro: true });

    // Parse conversation history if provided, then deduplicate it to prevent double counting
    const originalHistory = parseConversationHistory(conversationHistoryStr);
    const conversationHistory = deduplicateMessages(originalHistory);
    logUploadDedupDiagnostics(originalHistory, conversationHistory);

    // Check message limit (see lib/chat/chat-context-limit.js)
    if (isContextLimitReached(conversationHistory)) {
      return res.json(buildContextLimitResponse());
    }

    // System instruction = base upload prompt + the image context of the history
    // BEFORE this upload + the base-image selection context.
    const baseImageIndexUpload = parseBaseImageIndex(req.body.baseImageIndex);
    const { systemInstruction: contextInstruction, historyForImageContext } = buildUploadContext({
      memories,
      files,
      conversationHistory,
      baseImageIndex: baseImageIndexUpload,
      debugMode: DEBUG_MODE,
    });

    const { userContent, fileInfo, hasImages, firstImageFile, unsupportedFiles } = buildUploadUserContent({ files, message, messageTag });
    const systemInstruction = appendSoleUploadNote({ systemInstruction: contextInstruction, hasImages, historyForImageContext });

    // Make sure the model always has something to answer (unsupported-file
    // acknowledgement, or a generic "analyze these files").
    applyDefaultUserContentText({ userContent, message, unsupportedFiles });

    const { filteredUserContent, safeMessages, cleanedUserContent } = await buildUploadMessages({ systemInstruction, userContent, files, conversationHistory });

    // Use OpenAI GPT with vision support for images
    // Model is already set from req.body above

    logUploadPayload({ safeMessages, selectedModel, hasImages });
    const routing = await runUploadRouting({ safeMessages, selectedModel, message, unsupportedFiles, conversationHistory, systemInstruction });
    const { text, memoryActionsFromAI, imageRequestFromAI, recallRequestFromAI } = routing;
    let { stagingRequestFromAI, generateRequestFromAI, cadRequestFromAI } = routing;
    ({ stagingRequestFromAI, generateRequestFromAI, cadRequestFromAI } = applyPostRoutingSuppression({
      text,
      userMessageText: message,
      history: conversationHistory,
      stagingRequestFromAI,
      generateRequestFromAI,
      cadRequestFromAI,
    }));

    // Log chat to CSV + DEBUG dump.
    logRoutingOutcome({ req, userId, userMessageText: message, text, files, memories, label: 'CHAT-UPLOAD', fileInfo });

    // Apply the AI's memory stores/forgets.
    const memoryResult = applyMemoryActions({
      memoryActionsFromAI,
      memories,
      userId,
      userMessageText: message,
    });
    memories = memoryResult.memories;
    const memoryActions = memoryResult.memoryActions;

    // Check if current message has an image
    const currentMessageHasImage = firstImageFile !== null;

    // Upload-only rescue: synthesize a staging request when the user is adding
    // uploaded furniture to a room they already staged.
    stagingRequestFromAI = resolveAddFurnitureStaging({ stagingRequestFromAI, message, conversationHistory });

    const streamModeUpload = beginChatStream({
      req, res, text, memoryActions,
      stagingRequestFromAI, generateRequestFromAI, cadRequestFromAI,
    });

    const dispatch = await runPostRoutingDispatch({
      text,
      // Staging runs before generation in this endpoint (original order) — the
      // OPPOSITE of /api/chat. See lib/chat/chat-post-routing.js.
      order: STAGING_THEN_GENERATE,
      stagingArgs: {
        stagingRequestFromAI,
        history: conversationHistory,
        userMessageText: message,
        userId,
        req,
        selectedModel,
        baseImageIndex: baseImageIndexUpload,
        currentMessageHasImage,
        currentImageBuffer: firstImageFile ? firstImageFile.buffer : null,
        applyOriginalKeywordFallback: !currentMessageHasImage,
        resolveDualUpload: () => resolveDualUploadStaging(files, cleanedUserContent, message),
        resolveFallbackImage: () => resolveCurrentUploadFallbackImage({ firstImageFile, message }),
        // See the /api/chat handler above — same reason, and the two must stay in step.
        user: proUser,
      },
      generateArgs: { generateRequestFromAI, req, selectedModel },
      recallArgs: { recallRequestFromAI, history: conversationHistory },
      requestedArgs: {
        imageRequestFromAI,
        history: conversationHistory,
        baseMessages: safeMessages,
        systemInstruction,
        userMessageText: (message || ''),
        analysisUserText: (message || 'Please analyze this image.'),
        selectedModel,
      },
      cadArgs: {
        cadRequestFromAI,
        history: conversationHistory,
        baseImageIndex: baseImageIndexUpload,
        currentMessageHasImage,
      },
    });

    // Extract image annotations from cleanedUserContent to return to frontend
    // (uses the private _annotation property, which is never sent to OpenAI).
    const imageAnnotations = extractUploadImageAnnotations({ cleanedUserContent, filteredUserContent });

    recordDesignerActivity(proUser, dispatch);

    const response = await buildDesignerResponse({
      text: dispatch.text,
      memoryActions,
      stagingResults: dispatch.stagingResults,
      generatedImages: dispatch.generatedImages,
      requestedImageForDisplay: dispatch.requestedImageForDisplay,
      recalledImageForDisplay: dispatch.recalledImageForDisplay,
      cadResults: dispatch.cadResults,
      extraFields: { files: fileInfo },
      imageAnnotations,
    });

    sendChatResponse({ res, response, streamMode: streamModeUpload });
  } catch (error) {
    const ref = reportError('chat.upload', error);

    if (res.headersSent) {
      writeChatSseEvent(res, 'error', { error: 'Chat upload processing failed', ref });
      res.end();
      return;
    }

    // Try to have the AI respond about the error, especially for unsupported file types
    const errorBody = resolveUploadErrorBody({ error, reqFiles: req.files, openai });
    if (errorBody) {
      return res.json(errorBody);
    }

    // Fallback to generic error - always send a response to prevent hanging requests
    if (!res.headersSent) {
      sendError(res, 500, 'File processing failed', {
        details: 'An unexpected error occurred. Please try again.',
        ref,
        response: 'I apologize, but I encountered an unexpected error processing your files. Please try again.',
      });
    }
  }
});

  return router;
}
