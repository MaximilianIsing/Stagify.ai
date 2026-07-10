// chat routes, extracted verbatim from server.js.
import { createAsyncRouter } from '../lib/http/async-router.js';
import createChatPipeline from '../lib/chat/chat-pipeline.js';
import createUploadPrep from '../lib/chat/chat-upload-prep.js';
import { DESIGNER_ROUTING_RESPONSE_FORMAT, buildChatSystemInstruction, buildChatUploadSystemInstruction, getStagifyDateContext } from '../lib/staging/prompts.js';
import { deduplicateMessages, filterConversationHistory, stripImagesFromHistory, collectImagesFromHistory, getPriorHistoryForImageContext, parseBaseImageIndex, getBaseImageSelectionContext, findMostRecentStagedImageIndex, userWantsToAddFurnitureToRoom, resolveDualUploadStaging, resolveDualUploadFromMessageContent, buildImageContext } from '../lib/chat/chat-history.js';
import { parseDesignerRoutingCompletion, aiResponseDefersImageAction, chatWillProcessSlowImages, chatIntentType } from '../lib/chat/chat-routing.js';
import { wantsStreamedChatResponse, initChatSse, writeChatSseEvent, finishStreamedChatResponse } from '../lib/chat/chat-sse.js';
import { sendError } from '../lib/http/http-helpers.js';
import createWelcomeMessageHandler from '../lib/chat/welcome-message-handler.js';
import createChatRequestPrep from '../lib/chat/chat-request-prep.js';
import { buildUnsupportedFileErrorBody } from '../lib/chat/chat-upload-error.js';
import { logger } from '../lib/logger.js';

// A single conversation is capped at this many user messages before the client
// must start a fresh chat. Keeps the model's context window (and per-request
// cost) bounded; the client resets by reloading the chat.
const MAX_USER_MESSAGES = 20;
const CONTEXT_LIMIT_MESSAGE =
  `You've reached the maximum conversation context limit (${MAX_USER_MESSAGES} messages). ` +
  'Please reload the chat by clicking the reload button (↻) to the left of the file upload ' +
  'button to start a fresh conversation.';

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
 *   loadMemories: (userId: any) => any[],
 *   saveMemories: Function,
 *   getTemperatureForModel: (model: string) => number,
 *   getGeminiImageModel: typeof import('../lib/config/model-config.js').getGeminiImageModel,
 *   getUserIdentifier: (req: import('express').Request) => string,
 *   annotateImage: (imageDataUrl: string, isCAD?: boolean, detectBlueprint?: boolean) => Promise<string | null>,
 *   downscaleImageForGPT: (dataUrl: string) => Promise<string>,
 *   processImageGeneration: ReturnType<typeof import('../lib/staging/staging-generation.js').createStagingGeneration>['processImageGeneration'],
 *   processStaging: ReturnType<typeof import('../lib/staging/staging-generation.js').createStagingGeneration>['processStaging'],
 *   logChatToFile: ReturnType<typeof import('../lib/services/logging.js').createLogging>['logChatToFile'],
 *   blueprintTo3D: typeof import('../lib/staging/cad-handling.js').blueprintTo3D,
 *   incPromptCount: typeof import('../lib/data/counters.js').incPromptCount,
 * }} deps - Injected OpenAI client, rate-limit + upload middleware, the pro gate,
 *   memory load/save, model resolvers, the image annotation/downscale/staging/
 *   generation/CAD helpers, chat CSV logging, and the prompt counter.
 */
export default function createChatRouter(deps) {
  // Direct deps used by the handlers. The post-routing dispatch deps
  // (staging/generate/CAD/memory helpers, image resolution, etc.) are consumed
  // by createChatPipeline(deps) below rather than referenced here.
  const { openai, genLimiter, chatUpload, DEBUG_MODE, requireProAccount, loadMemories, getTemperatureForModel, getUserIdentifier, logChatToFile } = deps;
  const router = createAsyncRouter();
  const { applyMemoryActions, runGenerateRequests, resolveRecalledImage, resolveRequestedImage, runCadRequests, runStagingRequests, buildDesignerResponse } = createChatPipeline(deps);
  const { buildUploadUserContent, buildUploadMessages, logUploadPayload, runUploadRouting } = createUploadPrep(deps);
  const { handleWelcomeMessage } = createWelcomeMessageHandler(deps);
  const { logDedupDiagnostics, detectHistoryImage, applyMessageTag, buildChatMessages, logChatPayload } = createChatRequestPrep(deps);

router.get('/api/welcome-message', handleWelcomeMessage);

router.post('/api/chat', genLimiter, async (req, res) => {
  try {
    if (!requireProAccount(req, res)) return;

    if (!openai) {
      return sendError(res, 500, 'AI service not properly configured');
    }

    const { messages, model, messageTag, baseImageIndex: baseImageIndexRaw } = req.body;
    const baseImageIndex = parseBaseImageIndex(baseImageIndexRaw);
    
    // Get model from request or default to gpt-4o-mini
    const selectedModel = model || 'gpt-4o-mini';
    
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return sendError(res, 400, 'Messages array is required');
    }

    // Deduplicate messages to prevent double counting
    const deduplicatedMessages = deduplicateMessages(messages);
    if (deduplicatedMessages.length !== messages.length) {
      logDedupDiagnostics(messages, deduplicatedMessages);
    }

    // Check message limit (see MAX_USER_MESSAGES)
    const userMessageCount = deduplicatedMessages.filter(msg => msg.role === 'user').length;
    if (userMessageCount >= MAX_USER_MESSAGES) {
      return res.json({
        response: CONTEXT_LIMIT_MESSAGE,
        contextLimitReached: true
      });
    }

    // Get user identifier
    const userId = getUserIdentifier(req);
    
    // Load stored memories for this user
    let memories = loadMemories(userId);
    
    // Build context about available images in history with annotations
    const { imageContext } = buildImageContext(deduplicatedMessages);
    
    // Log image context for debugging
    if (DEBUG_MODE) {
      if (imageContext) {
        logger.debug('=== IMAGE CONTEXT SENT TO AI (CHAT) ===');
        logger.debug(imageContext);
        logger.debug('========================================');
      } else {
        logger.debug('[Image Context] No images in conversation history');
      }
    }
    
    // Build system instruction with memories
    let systemInstruction = buildChatSystemInstruction({ imageContext, memories, dateContext: getStagifyDateContext(), baseSelectionContext: getBaseImageSelectionContext(baseImageIndex, deduplicatedMessages) });

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

    // Use OpenAI GPT with JSON response format
    let aiResponseJson;
    let completion;
    try {
      completion = await openai.chat.completions.create({
        model: selectedModel,
        messages: openaiMessages,
        temperature: getTemperatureForModel(selectedModel),
        response_format: DESIGNER_ROUTING_RESPONSE_FORMAT
      });

      aiResponseJson = parseDesignerRoutingCompletion(completion);
    } catch (gptError) {
      logger.error('[GPT] Error calling OpenAI API:', gptError);
      logger.error('[GPT] Error stack:', gptError.stack);
      return res.status(500).json({ 
        error: 'Failed to get AI response', 
        details: 'The AI service encountered an error. Please try again.',
        response: 'I apologize, but I encountered an error processing your request. Please try again.'
      });
    }
    let text = aiResponseJson.response || completion.choices[0].message.content;
    const memoryActionsFromAI = aiResponseJson.memories || { stores: [], forgets: [] };
    let stagingRequestFromAI = aiResponseJson.staging || null;
    const imageRequestFromAI = aiResponseJson.imageRequest || null;
    const recallRequestFromAI = aiResponseJson.recall || null;
    let generateRequestFromAI = aiResponseJson.generate || null;
    let cadRequestFromAI = aiResponseJson.cad || null;

    if (aiResponseDefersImageAction(text)) {
      if (DEBUG_MODE) {
        logger.debug('[AI Designer] Suppressed staging/generate/cad: response asks clarifying questions');
      }
      stagingRequestFromAI = null;
      generateRequestFromAI = null;
      cadRequestFromAI = null;
    }

    if (userWantsToAddFurnitureToRoom(lastUserMessageText) && findMostRecentStagedImageIndex(messages) !== null) {
      generateRequestFromAI = null;
    }
    
    // Log chat to CSV file
    const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';
    logChatToFile(userId, lastUserMessageText, text, [], ipAddress, userAgent);
    
    // Debug logging
    if (DEBUG_MODE) {
      logger.debug('=== AI CHAT DEBUG ===');
      logger.debug('User ID:', userId);
      logger.debug('User message:', lastUserMessageText);
      logger.debug('AI response:', text);
      logger.debug('Memories loaded:', memories.length);
      if (memories.length > 0) {
        logger.debug('Memories:', memories.map(m => m.content).join(', '));
      }
      logger.debug('====================');
    }

    // Apply the AI's memory stores/forgets.
    const memoryResult = applyMemoryActions({
      memoryActionsFromAI,
      memories,
      userId,
      userMessageText: lastUserMessageText,
    });
    memories = memoryResult.memories;
    const memoryActions = memoryResult.memoryActions;

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

    // Image generation runs before staging in this endpoint (original order).
    const generateOut = await runGenerateRequests({ generateRequestFromAI, req, selectedModel });
    const generatedImages = generateOut.generatedImages;
    if (generateOut.textSuffix) text = text + generateOut.textSuffix;

    // Staging. The current-message image is loop-invariant, so resolve it once.
    let currentMessageHasImageInChat = false;
    let currentMessageImageBuffer = null;
    if (lastUserMessage && Array.isArray(lastUserMessage.content)) {
      const currentImageItem = lastUserMessage.content.find(
        (item) => item.type === 'image_url' && item.image_url && item.image_url.url
      );
      if (currentImageItem) {
        currentMessageHasImageInChat = true;
        const b64 = currentImageItem.image_url.url.split(',')[1];
        if (b64) currentMessageImageBuffer = Buffer.from(b64, 'base64');
      }
    }
    const stagingOut = await runStagingRequests({
      stagingRequestFromAI,
      history: messages,
      userMessageText: lastUserMessageText,
      userId,
      req,
      selectedModel,
      baseImageIndex,
      currentMessageHasImage: currentMessageHasImageInChat,
      currentImageBuffer: currentMessageImageBuffer,
      applyOriginalKeywordFallback: true,
      resolveDualUpload: () => resolveDualUploadFromMessageContent(
        lastUserMessage && Array.isArray(lastUserMessage.content) ? lastUserMessage.content : null,
        lastUserMessageText
      ),
      resolveFallbackImage: () => {
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
      },
    });
    const stagingResults = stagingOut.stagingResults;
    if (stagingOut.textSuffix) text = (text || '') + stagingOut.textSuffix;

    // Recall.
    const recalledImageForDisplay = resolveRecalledImage({ recallRequestFromAI, history: messages });

    // Image request (may re-run GPT to analyze, replacing text).
    const requestedOut = await resolveRequestedImage({
      imageRequestFromAI,
      history: messages,
      baseMessages: openaiMessages,
      systemInstruction,
      userMessageText: lastUserMessageText,
      analysisUserText: lastUserMessageText,
      selectedModel,
      text,
    });
    const requestedImageForDisplay = requestedOut.requestedImageForDisplay;
    text = requestedOut.text;

    // CAD.
    const cadCurrentMessageHasImage = Boolean(
      lastUserMessage &&
        Array.isArray(lastUserMessage.content) &&
        lastUserMessage.content.some(
          (item) => item.type === 'image_url' && item.image_url && item.image_url.url
        )
    );
    const cadOut = await runCadRequests({
      cadRequestFromAI,
      history: messages,
      baseImageIndex,
      currentMessageHasImage: cadCurrentMessageHasImage,
    });
    const cadResults = cadOut.cadResults;
    if (cadOut.textSuffix) text = (text || '') + cadOut.textSuffix;

    const response = await buildDesignerResponse({
      text,
      memoryActions,
      stagingResults,
      generatedImages,
      requestedImageForDisplay,
      recalledImageForDisplay,
      cadResults,
    });

    if (streamMode) {
      finishStreamedChatResponse(res, response);
    } else {
      res.json(response);
    }
  } catch (error) {
    logger.error('Error in chat:', error);
    if (res.headersSent) {
      writeChatSseEvent(res, 'error', {
        error: 'Chat processing failed',
        details: error.message,
      });
      res.end();
    } else {
      sendError(res, 500, 'Chat processing failed', { details: error.message });
    }
  }
});

router.post('/api/chat-upload', genLimiter, chatUpload.array('files', 5), async (req, res) => {
  try {
    if (!requireProAccount(req, res)) return;

    if (!openai) {
      return sendError(res, 500, 'AI service not properly configured');
    }

    if (!req.files || req.files.length === 0) {
      return sendError(res, 400, 'No files provided');
    }

    // Get message tag from form data
    const messageTag = req.body.messageTag;
    
    // Get user identifier
    const userId = getUserIdentifier(req);
    
    // Load stored memories for this user
    let memories = loadMemories(userId);
    
    // Build system instruction with memories (base instruction, will add image context after parsing conversationHistory)
    let systemInstruction = buildChatUploadSystemInstruction({ memories, dateContext: getStagifyDateContext() });

    const { message = '', conversationHistory: conversationHistoryStr, model } = req.body;
    const files = Array.isArray(req.files) ? req.files : [req.files];
    
    // Get model from request or default to gpt-4o-mini
    const selectedModel = model || 'gpt-4o-mini';
    
    // Parse conversation history if provided
    let conversationHistory = [];
    if (conversationHistoryStr) {
      try {
        conversationHistory = typeof conversationHistoryStr === 'string' 
          ? JSON.parse(conversationHistoryStr) 
          : conversationHistoryStr;
      } catch (error) {
        logger.error('Error parsing conversation history:', error);
        conversationHistory = [];
      }
    }
    
    // Deduplicate conversation history to prevent double counting
    const originalHistoryLength = conversationHistory.length;
    conversationHistory = deduplicateMessages(conversationHistory);
    if (conversationHistory.length !== originalHistoryLength) {
      const removedCount = originalHistoryLength - conversationHistory.length;
      
      if (DEBUG_MODE) {
        logger.debug(`[Deduplication] Removed ${removedCount} duplicate message(s) from conversation history (${originalHistoryLength} -> ${conversationHistory.length})`);
        // Log which messages were duplicates
        const seenKeys = new Set();
        const original = conversationHistory.length < originalHistoryLength ? 
          JSON.parse(conversationHistoryStr || '[]') : conversationHistory;
        original.forEach((msg, idx) => {
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
    }
    
    // Check message limit (see MAX_USER_MESSAGES)
    const userMessageCount = conversationHistory.filter(msg => msg.role === 'user').length;
    if (userMessageCount >= MAX_USER_MESSAGES) {
      return res.json({
        response: CONTEXT_LIMIT_MESSAGE,
        contextLimitReached: true
      });
    }
    
    // Build context about available images in history with annotations (now that conversationHistory is parsed)
    const currentUploadFilenames = (files || []).map((f) => f.originalname).filter(Boolean);
    const historyForImageContext = getPriorHistoryForImageContext(conversationHistory, currentUploadFilenames);
    const { imageContext } = buildImageContext(historyForImageContext);
    
    // Log image context for debugging
    if (DEBUG_MODE) {
      if (imageContext) {
        logger.debug('=== IMAGE CONTEXT SENT TO AI (CHAT-UPLOAD) ===');
        logger.debug(imageContext);
        logger.debug('===============================================');
      } else {
        logger.debug('[Image Context] No images in conversation history');
      }
    }
    
    if (imageContext) {
      systemInstruction += imageContext;
    }
    const baseImageIndexUpload = parseBaseImageIndex(req.body.baseImageIndex);
    systemInstruction += getBaseImageSelectionContext(baseImageIndexUpload, historyForImageContext);

    const { userContent, fileInfo, hasImages, firstImageFile, unsupportedFiles } = buildUploadUserContent({ files, message, messageTag });
    if (hasImages && collectImagesFromHistory(historyForImageContext).length === 0) {
      systemInstruction +=
        '\n\nCURRENT UPLOAD NOTE: The image(s) in THIS user message are the only image(s) in the conversation so far. Do not ask whether the user meant a first or second image — proceed with this upload.';
    }
    
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
    
    const { filteredUserContent, safeMessages, cleanedUserContent } = await buildUploadMessages({ systemInstruction, userContent, files, conversationHistory });

    // Use OpenAI GPT with vision support for images
    // Model is already set from req.body above
    
    logUploadPayload({ safeMessages, selectedModel, hasImages });
    const routing = await runUploadRouting({ safeMessages, selectedModel, message, unsupportedFiles, conversationHistory, systemInstruction });
    let text = routing.text;
    const memoryActionsFromAI = routing.memoryActionsFromAI;
    let stagingRequestFromAI = routing.stagingRequestFromAI;
    const imageRequestFromAI = routing.imageRequestFromAI;
    const recallRequestFromAI = routing.recallRequestFromAI;
    let generateRequestFromAI = routing.generateRequestFromAI;
    let cadRequestFromAI = routing.cadRequestFromAI;
    if (aiResponseDefersImageAction(text)) {
      if (DEBUG_MODE) {
        logger.debug('[AI Designer] Suppressed staging/generate/cad: response asks clarifying questions');
      }
      stagingRequestFromAI = null;
      generateRequestFromAI = null;
      cadRequestFromAI = null;
    }

    if (userWantsToAddFurnitureToRoom(message) && findMostRecentStagedImageIndex(conversationHistory) !== null) {
      generateRequestFromAI = null;
    }
    
    // Log chat to CSV file
    const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';
    logChatToFile(userId, message, text, files, ipAddress, userAgent);
    
    // Debug logging
    if (DEBUG_MODE) {
      logger.debug('=== AI CHAT-UPLOAD DEBUG ===');
      logger.debug('User ID:', userId);
      logger.debug('User message:', message);
      logger.debug('Files:', fileInfo.map(f => `${f.name} (${f.type})`).join(', '));
      logger.debug('AI response:', text);
      logger.debug('Memories loaded:', memories.length);
      if (memories.length > 0) {
        logger.debug('Memories:', memories.map(m => m.content).join(', '));
      }
      logger.debug('============================');
    }

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

    if (
      !stagingRequestFromAI &&
      userWantsToAddFurnitureToRoom(message) &&
      findMostRecentStagedImageIndex(conversationHistory) !== null
    ) {
      stagingRequestFromAI = {
        shouldStage: true,
        roomType: 'Other',
        additionalPrompt: message || 'Add the uploaded furniture to the existing staged room.',
        removeFurniture: false,
        usePreviousImage: false,
        furnitureImageIndex: null,
      };
    }

    const streamModeUpload =
      wantsStreamedChatResponse(req) &&
      chatWillProcessSlowImages(stagingRequestFromAI, generateRequestFromAI, cadRequestFromAI);
    if (streamModeUpload) {
      initChatSse(res);
      writeChatSseEvent(res, 'status', {
        type: chatIntentType(stagingRequestFromAI, generateRequestFromAI, cadRequestFromAI),
      });
      writeChatSseEvent(res, 'message', {
        response: text,
        memories: memoryActions,
      });
    }

    // Staging runs before generation in this endpoint (original order).
    const stagingOut = await runStagingRequests({
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
      resolveFallbackImage: () => {
        if (firstImageFile && !userWantsToAddFurnitureToRoom(message)) {
          return {
            buffer: firstImageFile.buffer,
            source: 'current message',
            logMessage: '[Staging] Using image from current message',
          };
        }
        return null;
      },
    });
    const stagingResults = stagingOut.stagingResults;
    if (stagingOut.textSuffix) text = (text || '') + stagingOut.textSuffix;

    // Image generation.
    const generateOut = await runGenerateRequests({ generateRequestFromAI, req, selectedModel });
    const generatedImages = generateOut.generatedImages;
    if (generateOut.textSuffix) text = text + generateOut.textSuffix;

    // Recall.
    const recalledImageForDisplay = resolveRecalledImage({ recallRequestFromAI, history: conversationHistory });

    // Image request (may re-run GPT to analyze, replacing text).
    const requestedOut = await resolveRequestedImage({
      imageRequestFromAI,
      history: conversationHistory,
      baseMessages: safeMessages,
      systemInstruction,
      userMessageText: (message || ''),
      analysisUserText: (message || 'Please analyze this image.'),
      selectedModel,
      text,
    });
    const requestedImageForDisplay = requestedOut.requestedImageForDisplay;
    text = requestedOut.text;

    // CAD.
    const cadOut = await runCadRequests({
      cadRequestFromAI,
      history: conversationHistory,
      baseImageIndex: baseImageIndexUpload,
      currentMessageHasImage,
    });
    const cadResults = cadOut.cadResults;
    if (cadOut.textSuffix) text = (text || '') + cadOut.textSuffix;

    // Extract image annotations from cleanedUserContent to return to frontend
    // (uses the private _annotation property, which is never sent to OpenAI).
    const imageAnnotations = {};
    cleanedUserContent.forEach((item, idx) => {
      if (item.type === 'image_url' && item._annotation) {
        const filename = item._filename || (filteredUserContent[idx] && (filteredUserContent[idx].filename || filteredUserContent[idx].originalname));
        if (filename) {
          imageAnnotations[filename] = item._annotation;
        }
      }
    });

    const response = await buildDesignerResponse({
      text,
      memoryActions,
      stagingResults,
      generatedImages,
      requestedImageForDisplay,
      recalledImageForDisplay,
      cadResults,
      extraFields: { files: fileInfo },
      imageAnnotations,
    });

    if (streamModeUpload) {
      finishStreamedChatResponse(res, response);
    } else {
      res.json(response);
    }
  } catch (error) {
    logger.error('[Chat Upload] Fatal error in chat-upload endpoint:', error);
    logger.error('[Chat Upload] Error stack:', error.stack);
    
    if (res.headersSent) {
      writeChatSseEvent(res, 'error', {
        error: 'Chat upload processing failed',
        details: error.message,
      });
      res.end();
      return;
    }
    
    // Try to have the AI respond about the error, especially for unsupported file types
    try {
      const errorMessage = error.message || '';
      const isFileTypeError = errorMessage.toLowerCase().includes('image') || 
                             errorMessage.toLowerCase().includes('format') || 
                             errorMessage.toLowerCase().includes('avif') ||
                             errorMessage.toLowerCase().includes('unsupported');
      
      // Check if we have files in the request
      // `.array()` uploads give an array; the map-shaped `.fields()` fallback is any-cast
      // so the common File[] branch keeps its `.originalname`/`.mimetype` type checking.
      /** @type {Express.Multer.File[]} */
      const files = req.files ? (Array.isArray(req.files) ? req.files : /** @type {any} */ ([req.files])) : [];
      
      if ((isFileTypeError || files.length > 0) && openai) {
        const errorBody = buildUnsupportedFileErrorBody(files);
        if (errorBody) {
          return res.json(errorBody);
        }
      }
    } catch (aiError) {
      logger.error('Error generating AI error response:', aiError);
    }
    
    // Fallback to generic error - always send a response to prevent hanging requests
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'File processing failed', 
        details: 'An unexpected error occurred. Please try again.',
        response: 'I apologize, but I encountered an unexpected error processing your files. Please try again.'
      });
    }
  }
});

  return router;
}
