// chat routes, extracted verbatim from server.js.
import express from 'express';
import createChatPipeline from '../lib/chat/chat-pipeline.js';
import createUploadPrep from '../lib/chat/chat-upload-prep.js';
import path from 'path';
import { DESIGNER_ROUTING_RESPONSE_FORMAT, buildChatSystemInstruction, buildChatUploadSystemInstruction, getStagifyDateContext, buildWelcomeMessagePrompt, WELCOME_MESSAGE_SYSTEM } from '../lib/staging/prompts.js';
import { filterUnsupportedFiles, deduplicateMessages, filterConversationHistory, stripImagesFromHistory, collectImagesFromHistory, getPriorHistoryForImageContext, parseBaseImageIndex, getBaseImageSelectionContext, findMostRecentStagedImageIndex, userWantsToAddFurnitureToRoom, resolveDualUploadStaging, resolveDualUploadFromMessageContent, buildImageContext } from '../lib/chat/chat-history.js';
import { parseDesignerRoutingCompletion, aiResponseDefersImageAction, chatWillProcessSlowImages, chatIntentType } from '../lib/chat/chat-routing.js';
import { wantsStreamedChatResponse, initChatSse, writeChatSseEvent, finishStreamedChatResponse } from '../lib/chat/chat-sse.js';

export default function createChatRouter(deps) {
  // Direct deps used by the handlers. The post-routing dispatch deps
  // (staging/generate/CAD/memory helpers, image resolution, etc.) are consumed
  // by createChatPipeline(deps) below rather than referenced here.
  const { openai, genLimiter, chatUpload, DEBUG_MODE, requireProAccount, loadMemories, getTemperatureForModel, getUserIdentifier, downscaleImageForGPT, logChatToFile } = deps;
  const router = express.Router();
  const { applyMemoryActions, runGenerateRequests, resolveRecalledImage, resolveRequestedImage, runCadRequests, runStagingRequests, buildDesignerResponse } = createChatPipeline(deps);
  const { buildUploadUserContent, buildUploadMessages, logUploadPayload, runUploadRouting } = createUploadPrep(deps);

router.get('/api/welcome-message', async (req, res) => {
  try {
    if (!requireProAccount(req, res)) return;

    // Get user identifier from query or generate from IP
    const userId = req.query.userId || getUserIdentifier(req);
    
    // Load stored memories for this user
    const memories = loadMemories(userId);
    
    // Check if user has memories (returning user)
    const isReturningUser = memories && memories.length > 0;
    
    if (isReturningUser) {
      // Generate personalized welcome message using AI
      try {
        if (!openai) {
          // Fallback to generic if AI not available
          return res.json({ 
            message: 'Welcome back to Stagify AI Designer! I can help you stage rooms, answer questions, and assist with interior design. How can I help you today?',
            isReturning: true
          });
        }
        
        const prompt = buildWelcomeMessagePrompt(memories);

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: WELCOME_MESSAGE_SYSTEM },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 150
    });
        
        const personalizedMessage = completion.choices[0].message.content.trim();
        
        return res.json({ 
          message: personalizedMessage,
          isReturning: true
        });
      } catch (error) {
        console.error('Error generating personalized welcome message:', error);
        // Fallback to generic
        return res.json({ 
          message: 'Welcome back to Stagify AI Designer! I can help you stage rooms, answer questions, and assist with interior design. How can I help you today?',
          isReturning: true
        });
      }
    } else {
      // First-time user - return generic welcome message
      return res.json({ 
        message: 'Hello! I\'m Stagify AI Designer, your AI assistant for room staging and interior design. I can help you:\n• Stage rooms by uploading images and describing your desired style\n• Answer questions about interior design and home staging\n• Modify and refine staged room designs\n• Convert your top-down floorplans into 3D renders\n\nUpload an image of a room to get started, or ask me anything about interior design!',
        isReturning: false
      });
    }
  } catch (error) {
    console.error('Error in welcome message endpoint:', error);
    // Fallback to generic message
    res.json({ 
      message: 'Hello! I\'m Stagify AI Designer, your AI assistant for room staging and interior design. Upload an image of a room to get started, or ask me anything!',
      isReturning: false
    });
  }
});

router.post('/api/chat', genLimiter, async (req, res) => {
  try {
    if (!requireProAccount(req, res)) return;

    if (!openai) {
      return res.status(500).json({ error: 'AI service not properly configured' });
    }

    const { messages, model, messageTag, baseImageIndex: baseImageIndexRaw } = req.body;
    const baseImageIndex = parseBaseImageIndex(baseImageIndexRaw);
    
    // Get model from request or default to gpt-4o-mini
    const selectedModel = model || 'gpt-4o-mini';
    
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Messages array is required' });
    }

    // Deduplicate messages to prevent double counting
    const deduplicatedMessages = deduplicateMessages(messages);
    if (deduplicatedMessages.length !== messages.length) {
      const removedCount = messages.length - deduplicatedMessages.length;
      if (DEBUG_MODE) {
        console.log(`[Deduplication] Removed ${removedCount} duplicate message(s) from ${messages.length} total messages`);
        // Log which messages were duplicates
        const seenKeys = new Set();
        messages.forEach((msg, idx) => {
          const key = Array.isArray(msg.content) 
            ? `${msg.role}:${JSON.stringify(msg.content.map(item => item.type === 'text' ? item.text : item.type))}`
            : `${msg.role}:${typeof msg.content === 'string' ? msg.content.trim() : 'non-string'}`;
          if (seenKeys.has(key)) {
            console.log(`[Deduplication] Duplicate found at index ${idx}: ${msg.role} message`);
          } else {
            seenKeys.add(key);
          }
        });
      }
    }
    
    // Check message limit (20 user messages max)
    const userMessageCount = deduplicatedMessages.filter(msg => msg.role === 'user').length;
    if (userMessageCount >= 20) {
      return res.json({
        response: "You've reached the maximum conversation context limit (20 messages). Please reload the chat by clicking the reload button (↻) to the left of the file upload button to start a fresh conversation.",
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
        console.log('=== IMAGE CONTEXT SENT TO AI (CHAT) ===');
        console.log(imageContext);
        console.log('========================================');
      } else {
        console.log('[Image Context] No images in conversation history');
      }
    }
    
    // Build system instruction with memories
    let systemInstruction = buildChatSystemInstruction({ imageContext, memories, dateContext: getStagifyDateContext(), baseSelectionContext: getBaseImageSelectionContext(baseImageIndex, deduplicatedMessages) });

    // Get the last user message
    const lastUserMessage = messages.filter(m => m.role === 'user').pop();
    const lastUserMessageText = lastUserMessage ? (typeof lastUserMessage.content === 'string' ? lastUserMessage.content : '') : '';
    
    // Check if there are images in conversation history (from user uploads or staged images)
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
            console.log(`[Staging] Found staged image in conversation history`);
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
              console.log(`[Staging] Found user-uploaded image in conversation history`);
            }
            break;
          }
        }
      }
    }

    // Strip images from conversation history (except current message) to prevent payload size issues
    // Only send text context, images will be requested via special mechanism if needed
    const strippedMessages = stripImagesFromHistory(deduplicatedMessages, true); // Keep images in current message only
    
    // Apply middleman filter to remove unsupported files
    const filteredMessages = filterConversationHistory(strippedMessages);
    
    // Add message tag to the last user message if provided
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
    
    const openaiMessages = [
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

    // Debug logging - log what's being sent to AI (ALWAYS log, not just in DEBUG_MODE)
    const messagesJson = JSON.stringify(openaiMessages);
    const payloadSize = Buffer.byteLength(messagesJson, 'utf8');
    const payloadSizeKB = (payloadSize / 1024).toFixed(2);
    const payloadSizeMB = (payloadSize / (1024 * 1024)).toFixed(2);
    
    if (DEBUG_MODE) {
      console.log('=== SENDING TO AI (CHAT) ===');
      console.log('Payload size:', payloadSize, 'bytes (', payloadSizeKB, 'KB /', payloadSizeMB, 'MB)');
      console.log('Number of messages:', openaiMessages.length);
      // Log individual messages instead of full array
      console.log('--- MESSAGES ---');
      openaiMessages.forEach((msg, index) => {
        if (msg.role === 'system') {
          console.log(`Message ${index + 1} [SYSTEM]:`, msg.content.substring(0, 500) + (msg.content.length > 500 ? '... [truncated]' : ''));
        } else if (msg.role === 'user') {
          if (Array.isArray(msg.content)) {
            const textItems = msg.content.filter(item => item.type === 'text');
            const imageItems = msg.content.filter(item => item.type === 'image_url');
            const textContent = textItems.map(item => item.text).join(' ');
            console.log(`Message ${index + 1} [USER]: Text: "${textContent.substring(0, 200)}${textContent.length > 200 ? '...' : ''}" | Images: ${imageItems.length}`);
          } else {
            console.log(`Message ${index + 1} [USER]:`, msg.content.substring(0, 200) + (msg.content.length > 200 ? '...' : ''));
          }
        } else if (msg.role === 'assistant') {
          if (Array.isArray(msg.content)) {
            const textItems = msg.content.filter(item => item.type === 'text');
            const textContent = textItems.map(item => item.text).join(' ');
            console.log(`Message ${index + 1} [ASSISTANT]:`, textContent.substring(0, 200) + (textContent.length > 200 ? '...' : ''));
          } else {
            console.log(`Message ${index + 1} [ASSISTANT]:`, msg.content.substring(0, 200) + (msg.content.length > 200 ? '...' : ''));
          }
        }
      });
      console.log('----------------');
      
      // Log image data sizes if present
      openaiMessages.forEach((msg, idx) => {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          msg.content.forEach((item, itemIdx) => {
            if (item.type === 'image_url' && item.image_url && item.image_url.url) {
              const imageDataSize = Buffer.byteLength(item.image_url.url, 'utf8');
              console.log(`Message ${idx}, Image ${itemIdx}: ${(imageDataSize / 1024).toFixed(2)} KB`);
            }
          });
        }
      });
        console.log('============================');
        console.log('Calling OpenAI API...');
    }

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
      console.error('[GPT] Error calling OpenAI API:', gptError);
      console.error('[GPT] Error stack:', gptError.stack);
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
        console.log('[AI Designer] Suppressed staging/generate/cad: response asks clarifying questions');
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
      console.log('=== AI CHAT DEBUG ===');
      console.log('User ID:', userId);
      console.log('User message:', lastUserMessageText);
      console.log('AI response:', text);
      console.log('Memories loaded:', memories.length);
      if (memories.length > 0) {
        console.log('Memories:', memories.map(m => m.content).join(', '));
      }
      console.log('====================');
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
    console.error('Error in chat:', error);
    if (res.headersSent) {
      writeChatSseEvent(res, 'error', {
        error: 'Chat processing failed',
        details: error.message,
      });
      res.end();
    } else {
      res.status(500).json({ 
        error: 'Chat processing failed', 
        details: error.message 
      });
    }
  }
});

router.post('/api/chat-upload', genLimiter, chatUpload.array('files', 5), async (req, res) => {
  try {
    if (!requireProAccount(req, res)) return;

    if (!openai) {
      return res.status(500).json({ error: 'AI service not properly configured' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
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
        console.error('Error parsing conversation history:', error);
        conversationHistory = [];
      }
    }
    
    // Deduplicate conversation history to prevent double counting
    const originalHistoryLength = conversationHistory.length;
    conversationHistory = deduplicateMessages(conversationHistory);
    if (conversationHistory.length !== originalHistoryLength) {
      const removedCount = originalHistoryLength - conversationHistory.length;
      
      if (DEBUG_MODE) {
        console.log(`[Deduplication] Removed ${removedCount} duplicate message(s) from conversation history (${originalHistoryLength} -> ${conversationHistory.length})`);
        // Log which messages were duplicates
        const seenKeys = new Set();
        const original = conversationHistory.length < originalHistoryLength ? 
          JSON.parse(conversationHistoryStr || '[]') : conversationHistory;
        original.forEach((msg, idx) => {
          const key = Array.isArray(msg.content) 
            ? `${msg.role}:${JSON.stringify(msg.content.map(item => item.type === 'text' ? item.text : item.type))}`
            : `${msg.role}:${typeof msg.content === 'string' ? msg.content.trim() : 'non-string'}`;
          if (seenKeys.has(key)) {
            console.log(`[Deduplication] Duplicate found at index ${idx}: ${msg.role} message`);
          } else {
            seenKeys.add(key);
          }
        });
      }
    }
    
    // Check message limit (20 user messages max)
    const userMessageCount = conversationHistory.filter(msg => msg.role === 'user').length;
    if (userMessageCount >= 20) {
      return res.json({
        response: "You've reached the maximum conversation context limit (20 messages). Please reload the chat by clicking the reload button (↻) to the left of the file upload button to start a fresh conversation.",
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
        console.log('=== IMAGE CONTEXT SENT TO AI (CHAT-UPLOAD) ===');
        console.log(imageContext);
        console.log('===============================================');
      } else {
        console.log('[Image Context] No images in conversation history');
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
        console.log('[AI Designer] Suppressed staging/generate/cad: response asks clarifying questions');
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
      console.log('=== AI CHAT-UPLOAD DEBUG ===');
      console.log('User ID:', userId);
      console.log('User message:', message);
      console.log('Files:', fileInfo.map(f => `${f.name} (${f.type})`).join(', '));
      console.log('AI response:', text);
      console.log('Memories loaded:', memories.length);
      if (memories.length > 0) {
        console.log('Memories:', memories.map(m => m.content).join(', '));
      }
      console.log('============================');
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
    console.error('[Chat Upload] Fatal error in chat-upload endpoint:', error);
    console.error('[Chat Upload] Error stack:', error.stack);
    
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
      const files = req.files ? (Array.isArray(req.files) ? req.files : [req.files]) : [];
      
      if ((isFileTypeError || files.length > 0) && openai) {
        // Find unsupported files by checking extensions and MIME types
        const unsupportedFiles = files.filter(file => {
          const ext = path.extname(file.originalname).toLowerCase();
          const supportedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
          return ext === '.avif' || 
                 file.mimetype === 'image/avif' ||
                 (file.mimetype.startsWith('image/') && !supportedImageTypes.includes(file.mimetype));
        });
        
        if (unsupportedFiles.length > 0) {
          const fileTypes = unsupportedFiles.map(file => {
            const ext = path.extname(file.originalname).toLowerCase();
            if (ext === '.avif' || file.mimetype === 'image/avif') {
              return 'AVIF';
            }
            return ext.toUpperCase().substring(1) || file.mimetype;
          });
          
          const uniqueFileTypes = [...new Set(fileTypes)];
          const fileTypeList = uniqueFileTypes.length === 1 
            ? uniqueFileTypes[0] 
            : uniqueFileTypes.join(', ');
          
          const aiResponse = `I'm unable to handle ${uniqueFileTypes.length > 1 ? 'these file types' : 'this file type'}: ${fileTypeList}. ` +
                           `Supported file types are: images (JPEG, JPG, PNG, WebP, GIF), PDFs, and text files. ` +
                           `Please convert ${unsupportedFiles.length > 1 ? 'these files' : 'this file'} to a supported format and try again.`;
          
          return res.json({ 
            response: aiResponse,
            files: unsupportedFiles.map(f => ({ name: f.originalname, type: f.mimetype })),
            memories: { stores: [], forgets: [] }
          });
        }
      }
    } catch (aiError) {
      console.error('Error generating AI error response:', aiError);
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
