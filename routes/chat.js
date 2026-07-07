// chat routes, extracted verbatim from server.js.
import express from 'express';
import createChatPipeline from '../lib/chat-pipeline.js';
import path from 'path';
import { DESIGNER_ROUTING_RESPONSE_FORMAT, buildChatSystemInstruction, buildChatUploadSystemInstruction } from '../lib/prompts.js';

export default function createChatRouter(deps) {
  // Direct deps used by the handlers. The post-routing dispatch deps
  // (staging/generate/CAD/memory helpers, image resolution, etc.) are consumed
  // by createChatPipeline(deps) below rather than referenced here.
  const { openai, genLimiter, chatUpload, DEBUG_MODE, requireProAccount, loadMemories, getTemperatureForModel, getUserIdentifier, annotateImage, downscaleImageForGPT, filterUnsupportedFiles, deduplicateMessages, filterConversationHistory, stripImagesFromHistory, collectImagesFromHistory, getPriorHistoryForImageContext, parseBaseImageIndex, getBaseImageSelectionContext, findMostRecentStagedImageIndex, userWantsToAddFurnitureToRoom, resolveDualUploadStaging, resolveDualUploadFromMessageContent, buildImageContext, getStagifyDateContext, parseDesignerRoutingCompletion, aiResponseDefersImageAction, wantsStreamedChatResponse, chatWillProcessSlowImages, chatIntentType, initChatSse, writeChatSseEvent, finishStreamedChatResponse, logChatToFile } = deps;
  const router = express.Router();
  const { applyMemoryActions, runGenerateRequests, resolveRecalledImage, resolveRequestedImage, runCadRequests, runStagingRequests, buildDesignerResponse } = createChatPipeline(deps);

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
        
        // Build context from memories
        let memoriesContext = '';
        if (memories.length > 0) {
          memoriesContext = '\n\nUser information:\n';
          memories.forEach((memory, index) => {
            memoriesContext += `${index + 1}. ${memory.content}\n`;
          });
        }
        
        const prompt = `Generate a brief, friendly, personalized welcome message for a returning user of Stagify AI Designer.${memoriesContext}

The message should:
- Be warm and welcoming
- Reference something from their previous interactions if relevant
- Be concise (2-3 sentences)
- Mention that you're ready to help with room staging, design questions, or other requests
- Sound natural and conversational

Just return the message text, no additional formatting.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are a friendly AI assistant for Stagify.ai. Generate brief, personalized welcome messages.' },
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
    const { imageContext, imagesSentToGPT, originalImageIndex } = buildImageContext(deduplicatedMessages);
    
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
    const { imageContext, imagesSentToGPT, originalImageIndex } = buildImageContext(historyForImageContext);
    
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

    // Build user message content array
    const userContent = [];
    
    // Add text message if provided
    if (message && message.trim()) {
      let messageText = message;
      // Add message tag to the message if provided
      if (messageTag && messageTag !== 'auto') {
        const tagMap = {
          'generate': '[TAG: Generate]',
          'stage': '[TAG: Stage]',
          'cad-stage': '[TAG: CAD-Stage]',
          'describe': '[TAG: Describe/Recall]'
        };
        messageText = `${tagMap[messageTag] || ''} ${messageText}`.trim();
      }
      userContent.push({ type: 'text', text: messageText });
    } else if (messageTag && messageTag !== 'auto') {
      // If no text message but tag is provided, add tag as text
      const tagMap = {
        'generate': '[TAG: Generate]',
        'stage': '[TAG: Stage]',
        'cad-stage': '[TAG: CAD-Stage]',
        'describe': '[TAG: Describe/Recall]'
      };
      userContent.push({ type: 'text', text: tagMap[messageTag] || '' });
    }
    
    // Define supported file types
    const supportedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
    const supportedTypes = [
      ...supportedImageTypes,
      'application/pdf',
      'text/plain', 'text/markdown',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    
    // Process all files and check for unsupported types
    const fileInfo = [];
    let hasImages = false;
    let firstImageFile = null;
    const unsupportedFiles = [];
    
    for (const file of files) {
      fileInfo.push({ name: file.originalname, type: file.mimetype });
      
      // Check file extension first
      const ext = path.extname(file.originalname).toLowerCase();
      
      // Explicitly check for AVIF and other unsupported formats FIRST
      const isAVIF = ext === '.avif' || file.mimetype === 'image/avif' || file.mimetype === 'image/avif-sequence';
      
      if (isAVIF) {
        unsupportedFiles.push({ name: file.originalname, type: file.mimetype, ext: ext, fileType: 'AVIF' });
        // Add to userContent as text so AI can acknowledge it, but DON'T send the image to OpenAI
        if (userContent.length === 0 || userContent[userContent.length - 1].type !== 'text') {
          userContent.push({ type: 'text', text: '' });
        }
        const lastTextIndex = userContent.length - 1;
        userContent[lastTextIndex].text += (userContent[lastTextIndex].text ? '\n\n' : '') + 
          `I uploaded a file named "${file.originalname}" but it is in AVIF format which is not supported.`;
        continue; // Skip this file - don't process it
      }
      
      // Check if file type is supported (for non-AVIF files)
      const isSupported = supportedTypes.includes(file.mimetype) || 
                         (ext === '.jpg' || ext === '.jpeg') ||
                         (file.mimetype.startsWith('image/') && supportedImageTypes.some(t => file.mimetype.includes(t.split('/')[1])));
      
      if (!isSupported) {
        const fileType = ext.toUpperCase().substring(1) || file.mimetype;
        unsupportedFiles.push({ name: file.originalname, type: file.mimetype, ext: ext, fileType: fileType });
        // Add to userContent as text so AI can acknowledge it, but DON'T send unsupported files to OpenAI
        if (userContent.length === 0 || userContent[userContent.length - 1].type !== 'text') {
          userContent.push({ type: 'text', text: '' });
        }
        const lastTextIndex = userContent.length - 1;
        userContent[lastTextIndex].text += (userContent[lastTextIndex].text ? '\n\n' : '') + 
          `I uploaded a file named "${file.originalname}" but it is in ${fileType} format which is not supported.`;
        continue; // Skip this file - don't process it
      }
      
      // Only process supported files - double check it's not AVIF
      const isStillAVIF = ext === '.avif' || file.mimetype === 'image/avif' || file.mimetype === 'image/avif-sequence';
      if (isStillAVIF) {
        // Safety check - if AVIF somehow got here, skip it
        unsupportedFiles.push({ name: file.originalname, type: file.mimetype, ext: ext, fileType: 'AVIF' });
        if (userContent.length === 0 || userContent[userContent.length - 1].type !== 'text') {
          userContent.push({ type: 'text', text: '' });
        }
        const lastTextIndex = userContent.length - 1;
        userContent[lastTextIndex].text += (userContent[lastTextIndex].text ? '\n\n' : '') + 
          `I uploaded a file named "${file.originalname}" but it is in AVIF format which is not supported.`;
        continue;
      }
      
      if (file.mimetype.startsWith('image/') && supportedImageTypes.includes(file.mimetype)) {
        hasImages = true;
        if (!firstImageFile) {
          firstImageFile = file;
        }
        // For images, use vision API - only for supported formats
        const imageData = file.buffer.toString('base64');
        const imageDataUrl = `data:${file.mimetype};base64,${imageData}`;
        
        // Annotate image in parallel (don't await - let it run in background)
        const annotationPromise = annotateImage(imageDataUrl, false, true).then(annotation => {
          if (DEBUG_MODE) {
            console.log(`[Image Annotation] Annotation for ${file.originalname}: ${annotation || 'failed'}`);
          }
          return annotation;
        }).catch(err => {
          console.error(`[Image Annotation] Error annotating ${file.originalname}:`, err);
          return null;
        });
        
        userContent.push({
          type: 'image_url',
          image_url: {
            url: imageDataUrl
          },
          filename: file.originalname, // Store filename for later reference
          originalname: file.originalname,
          annotationPromise: annotationPromise // Store promise so we can await it later
        });
      } else {
        // For text/PDF files, include content in the message
        let fileContent = '';
        if (file.mimetype.startsWith('text/')) {
          fileContent = file.buffer.toString('utf8');
        } else {
          // For PDFs and other binary files, we can't directly process them
          fileContent = `[File: ${file.originalname}, Type: ${file.mimetype} - Content cannot be directly read]`;
        }
        
        // Add file content as text
        if (userContent.length === 0 || userContent[userContent.length - 1].type !== 'text') {
          userContent.push({ type: 'text', text: '' });
        }
        const lastTextIndex = userContent.length - 1;
        userContent[lastTextIndex].text += (userContent[lastTextIndex].text ? '\n\n' : '') + 
          `File: ${file.originalname}\n${fileContent}`;
      }
    }
    
    if (hasImages && collectImagesFromHistory(historyForImageContext).length === 0) {
      systemInstruction +=
        '\n\nCURRENT UPLOAD NOTE: The image(s) in THIS user message are the only image(s) in the conversation so far. Do not ask whether the user meant a first or second image — proceed with this upload.';
    }
    
    // If there are unsupported files, ensure the AI acknowledges them
    if (unsupportedFiles.length > 0) {
      // The unsupported files are already mentioned in userContent, but make sure there's a clear message
      if (!message || !message.trim()) {
        // If no user message, add a prompt for the AI to acknowledge unsupported files
        const unsupportedText = unsupportedFiles.map(f => {
          const fileType = f.fileType || (f.ext ? f.ext.toUpperCase().substring(1) : f.type);
          return `"${f.name}" (${fileType} format)`;
        }).join(' and ');
        
        if (userContent.length === 0 || (userContent.length === 1 && userContent[0].type === 'text' && !userContent[0].text.trim())) {
          userContent.unshift({ type: 'text', text: `I uploaded ${unsupportedFiles.length > 1 ? 'some files' : 'a file'} but ${unsupportedFiles.length > 1 ? 'they are' : 'it is'} in an unsupported format.` });
        }
      }
    } else if (userContent.length === 0 || (userContent.length === 1 && userContent[0].type === 'text' && !userContent[0].text)) {
      // Only add default message if no unsupported files and no content
      userContent.unshift({ type: 'text', text: 'Please analyze these files.' });
    }
    
    // MIDDLEMAN CHECK: Filter unsupported files from userContent before sending to OpenAI
    const { filteredContent: filteredUserContent, unsupportedFiles: detectedUnsupported } = filterUnsupportedFiles(userContent, files);
    
    // Also filter conversation history to ensure no unsupported files slip through
    const filteredConversationHistory = filterConversationHistory(conversationHistory);
    
    // Strip images from conversation history (except current message) to prevent payload size issues
    const strippedHistory = stripImagesFromHistory(filteredConversationHistory, false);
    
    // Update messages array with filtered conversation history (images stripped)
    const safeMessages = [
      { role: 'system', content: systemInstruction },
      ...strippedHistory.map(msg => {
        // All messages in history are text-only (images stripped)
        return {
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: msg.content
        };
      })
    ];
    
    // Wait for image annotations and type detection to complete and store them
    const cleanedUserContent = await Promise.all(filteredUserContent.map(async (item) => {
      if (item.type === 'image_url' && item.image_url && item.image_url.url) {
        // Wait for annotation if it's still in progress
        let annotation = null;
        if (item.annotationPromise) {
          annotation = await item.annotationPromise;
        }
        
        // Downscale image if needed before sending to GPT
        const downscaledUrl = await downscaleImageForGPT(item.image_url.url);
        
        // Store annotation separately (not in the OpenAI payload)
        // OpenAI only accepts: { type: 'image_url', image_url: { url: '...' } }
        const imageItem = {
          type: 'image_url',
          image_url: {
            url: downscaledUrl
          }
        };
        
        // Store annotation separately for later use (not sent to OpenAI)
        imageItem._annotation = annotation;
        imageItem._filename = item.filename || item.originalname;
        
        return imageItem;
      }
      return item;
    }));
    
    // Clean content for OpenAI - create completely fresh objects with ONLY the properties OpenAI expects
    const openaiContent = cleanedUserContent.map(item => {
      if (item.type === 'image_url') {
        // OpenAI only accepts: { type: 'image_url', image_url: { url: '...' } }
        // Create a completely new object with ONLY these properties
        return {
          type: 'image_url',
          image_url: {
            url: item.image_url.url
          }
        };
      } else if (item.type === 'text') {
        // For text items, only include type and text
        return {
          type: 'text',
          text: item.text
        };
      }
      // For any other types, return as-is
      return item;
    });
    
    // Add the current user message with cleaned content (images included, annotations removed)
    safeMessages.push({
      role: 'user',
      content: openaiContent
    });

    // Use OpenAI GPT with vision support for images
    // Model is already set from req.body above
    
    // Debug logging - log what's being sent to AI (ALWAYS log, not just in DEBUG_MODE)
    const messagesJson = JSON.stringify(safeMessages);
    const payloadSize = Buffer.byteLength(messagesJson, 'utf8');
    const payloadSizeKB = (payloadSize / 1024).toFixed(2);
    const payloadSizeMB = (payloadSize / (1024 * 1024)).toFixed(2);
    
    if (DEBUG_MODE) {
      console.log('=== SENDING TO AI (CHAT-UPLOAD) ===');
      console.log('Payload size:', payloadSize, 'bytes (', payloadSizeKB, 'KB /', payloadSizeMB, 'MB)');
      console.log('Model:', selectedModel);
      console.log('Has images:', hasImages);
      console.log('Number of messages:', safeMessages.length);
    }
    
    if (DEBUG_MODE) {
      // Log individual messages instead of full array
      console.log('--- MESSAGES ---');
      safeMessages.forEach((msg, index) => {
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
    }
    
    // Log image data sizes if present
    safeMessages.forEach((msg, idx) => {
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        msg.content.forEach((item, itemIdx) => {
          if (item.type === 'image_url' && item.image_url && item.image_url.url) {
            const imageDataSize = Buffer.byteLength(item.image_url.url, 'utf8');
            if (DEBUG_MODE) {
              console.log(`Message ${idx}, Image ${itemIdx}: ${(imageDataSize / 1024).toFixed(2)} KB`);
            }
          }
        });
      }
    });
    
    let text;
    let aiResponseJson = null;
    let memoryActionsFromAI = { stores: [], forgets: [] };
    let stagingRequestFromAI = null;
    let imageRequestFromAI = null;
    let recallRequestFromAI = null;
    let generateRequestFromAI = null;
    let cadRequestFromAI = null;
    
    try {
      if (DEBUG_MODE) {
        console.log('Calling OpenAI API...');
      }
      
      // Final safety check: ensure all image objects only have the expected structure
      const finalMessages = safeMessages.map(msg => {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          return {
            ...msg,
            content: msg.content.map(item => {
              if (item.type === 'image_url' && item.image_url) {
                // Strip any extra properties - only keep what OpenAI expects
                return {
                  type: 'image_url',
                  image_url: {
                    url: item.image_url.url
                  }
                };
              }
              return item;
            })
          };
        }
        return msg;
      });
      
      const completion = await openai.chat.completions.create({
        model: selectedModel,
        messages: finalMessages,
        temperature: getTemperatureForModel(selectedModel),
        response_format: DESIGNER_ROUTING_RESPONSE_FORMAT
      });

      aiResponseJson = parseDesignerRoutingCompletion(completion);
      text = aiResponseJson.response || completion.choices[0].message.content;
      memoryActionsFromAI = aiResponseJson.memories || { stores: [], forgets: [] };
      stagingRequestFromAI = aiResponseJson.staging || null;
      imageRequestFromAI = aiResponseJson.imageRequest || null;
      recallRequestFromAI = aiResponseJson.recall || null;
      generateRequestFromAI = aiResponseJson.generate || null;
      cadRequestFromAI = aiResponseJson.cad || null;
    } catch (openaiError) {
      // If OpenAI API fails (e.g., due to unsupported image format), let the AI respond about it
      if (DEBUG_MODE) {
        console.error('OpenAI API error:', openaiError);
      }
      
      // Check if error is related to image processing
      const errorMessage = openaiError.message || '';
      const errorCode = openaiError.code || '';
      const isImageFormatError = errorCode === 'invalid_image_format' || 
                                errorMessage.toLowerCase().includes('unsupported image') ||
                                errorMessage.toLowerCase().includes('invalid image format');
      
      if (isImageFormatError || unsupportedFiles.length > 0) {
        // Create a message for the AI to respond about unsupported files
        const errorUserContent = [];
        if (message && message.trim()) {
          errorUserContent.push({ type: 'text', text: message });
        }
        
        // Add information about unsupported files
        if (unsupportedFiles.length > 0) {
          unsupportedFiles.forEach(file => {
            const fileType = file.fileType || (file.ext === '.avif' ? 'AVIF' : (file.ext ? file.ext.toUpperCase().substring(1) : file.type));
            errorUserContent.push({ 
              type: 'text', 
              text: `I uploaded "${file.name}" but it is in ${fileType} format which is not supported.` 
            });
          });
        } else if (isImageFormatError) {
          // If we got an image format error but didn't catch it earlier, mention it
          errorUserContent.push({ 
            type: 'text', 
            text: 'I uploaded an image file but it appears to be in an unsupported format.' 
          });
        }
        
        if (errorUserContent.length === 0) {
          errorUserContent.push({ type: 'text', text: 'I uploaded a file but encountered an error processing it.' });
        }
        
        // Filter conversation history in error handler too to prevent unsupported files
        const filteredErrorHistory = filterConversationHistory(conversationHistory);
        const errorMessages = [
          { role: 'system', content: systemInstruction },
          ...filteredErrorHistory,
          { role: 'user', content: errorUserContent }
        ];
        
        const errorCompletion = await openai.chat.completions.create({
          model: selectedModel,
          messages: errorMessages,
          temperature: getTemperatureForModel(selectedModel),
          response_format: DESIGNER_ROUTING_RESPONSE_FORMAT
        });
        
        aiResponseJson = parseDesignerRoutingCompletion(errorCompletion);
        text = aiResponseJson.response || errorCompletion.choices[0].message.content;
        memoryActionsFromAI = aiResponseJson.memories || { stores: [], forgets: [] };
        stagingRequestFromAI = aiResponseJson.staging || null;
        imageRequestFromAI = aiResponseJson.imageRequest || null;
        recallRequestFromAI = aiResponseJson.recall || null;
        generateRequestFromAI = aiResponseJson.generate || null;
      } else {
        // Re-throw if it's not an image-related error
        throw openaiError;
      }
    }

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
