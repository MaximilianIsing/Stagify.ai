// chat routes, extracted verbatim from server.js.
import express from 'express';

export default function createChatRouter(deps) {
  const { openai, genLimiter, chatUpload, DEBUG_MODE, requireProAccount, loadMemories, saveMemories, getTemperatureForModel, getGeminiImageModel, getUserIdentifier, annotateImage, downscaleImageForGPT, filterUnsupportedFiles, deduplicateMessages, filterConversationHistory, stripImagesFromHistory, collectImagesFromHistory, getPriorHistoryForImageContext, parseBaseImageIndex, getBaseImageSelectionContext, applyBaseImageIndexToStagingParams, resolveCadImageIndex, findMostRecentStagedImageIndex, userWantsToAddFurnitureToRoom, resolveDualUploadStaging, resolveDualUploadFromMessageContent, applyAddFurnitureStagingFallback, getImageFromHistory, buildImageContext, getOriginalImageIndex, getStagifyDateContext, parseDesignerRoutingCompletion, aiResponseDefersImageAction, wantsStreamedChatResponse, chatWillProcessSlowImages, chatIntentType, initChatSse, writeChatSseEvent, finishStreamedChatResponse, processImageGeneration, processStaging, logChatToFile, blueprintTo3D, incPromptCount } = deps;
  const router = express.Router();

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
    let systemInstruction = 'You are a helpful AI assistant for Stagify.ai, a room staging and interior design service. ';
    systemInstruction += 'Your primary purpose is to help users with room staging, interior design, and home decoration. ';
    systemInstruction += 'You have THREE main capabilities: (1) STAGE/MODIFY existing room images - add furniture and decor to uploaded room photos, (2) GENERATE completely new images from text descriptions - create brand new images from scratch based on user descriptions, and (3) CAD-STAGE blueprints/floor plans - convert 2D architectural drawings into 3D staged renders. ';
    systemInstruction += 'You can also answer questions about interior design and provide design advice. ';
    systemInstruction += '\n\nCRITICAL: Stay on topic. Your primary focus is room staging and interior design, but you can:';
    systemInstruction += '\n- Have friendly, introductory conversations and get to know the user';
    systemInstruction += '\n- Answer questions about room staging and interior design';
    systemInstruction += '\n- Discuss home decoration, furniture, design styles, color schemes, and layouts';
    systemInstruction += '\n- Explain Stagify.ai features and functionality';
    systemInstruction += '\n- Help with file uploads and image processing';
    systemInstruction += '\n\nIf a user asks about completely unrelated topics (such as writing essays, general knowledge questions, or subjects that have nothing to do with design or your service), politely redirect them. However, feel free to be conversational, friendly, and engage in introductory small talk.';
    systemInstruction += '\n\nIMPORTANT: Check file types. Supported file types are: images (JPEG, JPG, PNG, WebP, GIF), PDFs, and text files. ';
    systemInstruction += 'If a user uploads an unsupported file type, you must inform them clearly which file type is not supported. ';
    systemInstruction += 'For example: "I\'m sorry, but [filename.xyz] is not a supported file type. Supported types are: images (JPEG, JPG, PNG, WebP, GIF), PDFs, and text files." ';
    systemInstruction += '\n\nIMPORTANT: Previous messages may reference files with placeholders like "[Image: filename.jpg]" or "[Staged image: filename.jpg]". These are references to files that were uploaded or generated in previous messages. The actual file data is NOT included to save bandwidth. Only files from the CURRENT message have their actual data included.';
    systemInstruction += imageContext;
    if (memories.length > 0) {
      systemInstruction += '\n\nImportant information to remember:\n';
      memories.forEach((memory, index) => {
        systemInstruction += `${index + 1}. ${memory.content}\n`;
      });
    }
    systemInstruction += '\n\nYou must respond with a JSON object containing:';
    systemInstruction += '\n- "response": Your text response to the user';
    systemInstruction += '\n- "memories": { "stores": ["memory description 1", ...], "forgets": ["memory ID 1", ...] } - Store or forget memories based on the conversation. To forget ALL memories, use "forgets": ["all"]';
    systemInstruction += '\n- "staging": { "shouldStage": true/false, "roomType": "Living room"|"Bedroom"|"Kitchen"|"Bathroom"|"Dining room"|"Office"|"Other", "additionalPrompt": "detailed staging description", "removeFurniture": true/false, "usePreviousImage": false|0|1|2|..., "furnitureImageIndex": null|0|1|2|... } OR "staging": [ { "shouldStage": true, ... }, { "shouldStage": true, ... }, ... ] - Request staging if the user wants to stage/modify a room image (ONLY use staging when the user has uploaded or is referring to an existing room image to modify). If the user wants to add a specific piece of furniture from a previous message, set "furnitureImageIndex" to the index of that furniture image (0 = most recent image, 1 = second most recent, etc.). You can provide MULTIPLE staging requests (up to 3) in an array if the user asks for multiple variations (e.g., "stage this room in 3 different themes"). Each staging request in the array will be processed separately.';
    systemInstruction += '\n- "imageRequest": { "requestImage": true/false, "imageIndex": 0|1|2|... } - Request to view/analyze a previous image by index (0 = most recent, 1 = second most recent, etc.). Use this when the user asks to "show me", "see", "view", "display", "describe", or "analyze" a previous image. The image will be displayed to the user. If the user also wants analysis/description, the system will analyze it automatically.';
    systemInstruction += '\n- "recall": { "shouldRecall": true/false, "imageIndex": 0|1|2|... } - Recall and display a previous image by index (0 = most recent, 1 = second most recent, etc.). Use this when the user asks to "see", "show", "recall", or "bring back" an old image. This works for ANY image in the conversation history: user-uploaded images, staged images, generated images, and CAD renders. This is simpler than imageRequest - it just retrieves and displays the image without analysis. If user says "original image", "first image", or "initial image", use the original image index shown above.';
    systemInstruction += '\n- "generate": { "shouldGenerate": true/false, "prompt": "detailed image generation prompt" } OR "generate": [ { "shouldGenerate": true, "prompt": "..." }, { "shouldGenerate": true, "prompt": "..." }, ... ] - Generate a completely new image from text description. This is a core capability - you can create brand new images from scratch based on user descriptions. Use generation when: (1) user wants to create a NEW image from scratch with no existing image involved, (2) user asks to "generate", "create", "draw", "make", or "design" a new image, (3) user describes a scene/room/space they want to see without uploading or referring to an existing image. DO NOT use generation when they uploaded an image or are referring to a previous image - use staging instead. You can provide MULTIPLE generation requests (up to 3) in an array if the user asks for multiple variations. Each generation request in the array will be processed separately.';
    systemInstruction += '\n\nIMPORTANT DISTINCTION - You have THREE image capabilities:\n- Use "staging" when: user uploaded a room photo (3D perspective view of an interior space), user refers to a previous room photo with "CAD: False", user wants to modify/redesign an existing room photo that is NOT a CAD-staged image. Staging adds furniture and decor to existing room photos.\n- Use "cad" (CAD-staging) when: (1) user uploaded a blueprint/floor plan (2D top-down architectural drawing), (2) user refers to a previous blueprint, (3) user says "stage" but the image is a blueprint/floor plan, OR (4) user wants to modify an image that has "CAD: True" in the image context - ALWAYS use CAD-staging for blueprints and CAD-staged images, even if the user says "stage". CAD-staging converts 2D floor plans into 3D staged renders.\n- Use "generate" when: user wants to create a completely new image from text only (no existing image involved), user asks to "generate", "create", "draw", "make", or "design" a new image, user describes a scene/room/space they want to see without uploading or referring to an existing image. Generation creates brand new images from scratch based on text descriptions - this is a core capability you have.';
    systemInstruction += '\n\nSTAGING RULES (for room photos only):';
    systemInstruction += '\n- CRITICAL: Regular staging is ONLY for room photos (3D perspective interior views). If the user uploads or refers to a blueprint/floor plan (2D top-down architectural drawing), use CAD-staging ("cad" field) instead, even if they say "stage".';
    systemInstruction += '\n- CRITICAL: Before using regular staging, check the image context above. If the image you are modifying has "CAD: True" in its annotation, you MUST use CAD-staging ("cad" field) instead, NOT regular staging. This includes images you previously created with CAD-staging - if a user asks to modify a CAD-staged image, use CAD-staging again.';
    systemInstruction += '\n- Set "shouldStage": true if the user wants to stage a room photo, modify a room photo, change colors/walls/furniture, or apply any visual changes to a room photo (NOT a blueprint, and NOT a CAD-staged image with CAD: True)';
    systemInstruction += '\n- Set "usePreviousImage": false if using the current message\'s image, or the index (0 = most recent, 1 = second most recent, etc.) if modifying a previous image';
    systemInstruction += '\n- If user says "original image", "first image", or "initial image", use the original image index shown above';
    systemInstruction += '\n- Set "furnitureImageIndex" to the index of a furniture image from a previous message if the user wants to add a specific piece of furniture (e.g., "add that chair", "include the red sofa from before"). The furniture image will be sent to the staging system alongside the room image.';
    systemInstruction += '\n- IMPORTANT: When adding furniture to a room, set "usePreviousImage" to the TARGET ROOM index — the staged or uploaded room photo, NOT the furniture upload. Priority: (1) thumbnail strip base image if the user selected one, (2) the room obvious from conversation, (3) most recent staged room. If the user uploads furniture in the CURRENT message, set "furnitureImageIndex" to null — the system attaches it automatically. If furniture is from a prior message, set "furnitureImageIndex" to that index. NEVER use "generate" for this — use "staging" only.';
    systemInstruction += '\n- The "additionalPrompt" should be a detailed, comprehensive description of the staging request. IMPORTANT: Always emphasize that architecture (walls, windows, doors, room structure) and existing furniture must be preserved exactly as they appear - only add new furniture and decor, do not modify what\'s already there unless explicitly requested. CRITICAL: Preserve the exact aspect ratio and full frame — do not crop, zoom, or cut off any part of the room unless the user explicitly asked for a tighter crop';
    systemInstruction += '\n- Set "styleReference": true ONLY when the user provides an image to match an aesthetic/style ("stage it like this", "match this vibe") rather than a specific furniture piece to place. Then "usePreviousImage" is still the room to stage; the reference image guides the look only. Otherwise omit it or set false.';
    systemInstruction += '\n- If "shouldStage" is false, you can omit the "staging" field or set it to null';
    systemInstruction += '\n\nIMAGE REQUEST RULES:';
    systemInstruction += '\n- Set "requestImage": true if the user asks to see, describe, analyze, or look at a previous image';
    systemInstruction += '\n- Set "imageIndex" to the index of the image (0 = most recent, 1 = second most recent, etc.)';
    systemInstruction += '\n- If user says "original image", "first image", or "initial image", use the original image index shown above';
    systemInstruction += '\n- If "requestImage" is false, you can omit the "imageRequest" field or set it to null';
    systemInstruction += '\n\nRECALL RULES:';
    systemInstruction += '\n- Set "shouldRecall": true if the user asks to see, show, recall, or bring back an old image';
    systemInstruction += '\n- You can recall ANY image from the conversation: user-uploaded images, images you staged, images you generated, or CAD-staging renders you created';
    systemInstruction += '\n- Set "imageIndex" to the index of the image (0 = most recent, 1 = second most recent, etc.)';
    systemInstruction += '\n- Check the "Available images in conversation history" list above to find the correct index for any image (including your own generated/staged images)';
    systemInstruction += '\n- If user says "original image", "first image", or "initial image", use the original image index shown above';
    systemInstruction += '\n- If user asks to see "the image I generated" or "the staged image", look for "generated image" or "staged image" in the image list above';
    systemInstruction += '\n- If "shouldRecall" is false, you can omit the "recall" field or set it to null';
    systemInstruction += '\n\nCAD-STAGING RULES (for blueprints/floor plans and CAD-staged images):';
    systemInstruction += '\n- "cad": { "shouldProcessCAD": true/false, "imageIndex": 0|1|2|..., "furnitureImageIndex": null|0|1|2|...|[...], "additionalPrompt": "detailed CAD-staging description" } OR "cad": [ { "shouldProcessCAD": true, ... }, { "shouldProcessCAD": true, ... }, ... ] - CAD-staging processes a top-down blueprint/floor plan image to create a 3D render. This is DIFFERENT from regular staging. Use CAD-staging when: (1) the user uploads a top-down blueprint, floor plan, or architectural drawing (2D plan view from above), OR (2) the user wants to modify an image that has "CAD: True" in its annotation (check the image context above). CRITICAL: Even if the user says "stage this blueprint" or "stage this floor plan", you MUST use CAD-staging (set "shouldProcessCAD": true), NOT regular staging. CRITICAL: If the user asks to modify a previously CAD-staged image (one with "CAD: True" in the image context), you MUST use CAD-staging again, NOT regular staging. Regular staging is ONLY for room photos (3D perspective views), NOT for blueprints or CAD-staged images. Set "imageIndex" to the index of the blueprint or CAD-staged image (0 = most recent, 1 = second most recent, etc.). If the user uploads a blueprint in the current message, use imageIndex 0. If the user wants to include specific furniture pieces in the 3D render, set "furnitureImageIndex" to the index (or array of indices) of the furniture image(s) from previous messages. The "additionalPrompt" should be a detailed description of any specific requirements, themes, styles, or preferences the user has (e.g., "medieval theme", "modern minimalist", "cozy atmosphere", etc.). The CAD-staging function will convert the blueprint to a top-down 3D render and include the furniture and styling preferences if specified. You can provide MULTIPLE CAD requests (up to 3) in an array if the user asks for multiple variations (e.g., "stage this blueprint in 3 different themes"). Each CAD request in the array will be processed separately.';
    systemInstruction += '\n- CRITICAL: If the user uploads or refers to a blueprint/floor plan (2D top-down architectural drawing), you MUST set "shouldProcessCAD": true, even if they say "stage". Blueprints ALWAYS use CAD-staging, never regular staging.';
    systemInstruction += '\n- CRITICAL: If the user asks to modify an image that has "CAD: True" in the image context above, you MUST use CAD-staging ("cad" field), NOT regular staging. Always check the CAD classification in the image annotations before deciding which pipeline to use.';
    systemInstruction += '\n- CRITICAL: Regular staging ("staging" field) is ONLY for room photos (3D perspective interior views). If you see a blueprint/floor plan OR an image with "CAD: True", use CAD-staging instead.';
    systemInstruction += '\n- Set "furnitureImageIndex" to the index (or array of indices) of furniture images from previous messages if the user wants to include specific furniture in the 3D render';
    systemInstruction += '\n- If "shouldProcessCAD" is false, you can omit the "cad" field or set it to null';
    systemInstruction += AI_DESIGNER_RESPONSE_ACTION_RULES;
    systemInstruction += AI_DESIGNER_IMAGE_FRAMING_RULES;
    systemInstruction += STAGIFY_SELF_KNOWLEDGE;
    systemInstruction += getStagifyDateContext();
    systemInstruction += getBaseImageSelectionContext(baseImageIndex, deduplicatedMessages);

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
    try {
      const completion = await openai.chat.completions.create({
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

    // Process memory actions from AI response
    const memoryActions = { stores: [], forgets: [] };
    if (lastUserMessageText && memoryActionsFromAI) {
      if (DEBUG_MODE) {
        console.log(`[Memory] Processing memory actions from AI response:`, memoryActionsFromAI);
      }
      
      // Process forget actions first
      if (memoryActionsFromAI.forgets && memoryActionsFromAI.forgets.length > 0) {
        // Check if user wants to forget all memories
        if (memoryActionsFromAI.forgets.includes('all')) {
          const forgottenCount = memories.length;
          memories = [];
          memoryActions.forgets = ['all'];
          console.log(`Forgot ALL ${forgottenCount} memories for user ${userId}`);
        } else {
          // Process individual memory forgets
          for (const memoryId of memoryActionsFromAI.forgets) {
            const initialLength = memories.length;
            // Try exact ID match first
            memories = memories.filter(m => m.id !== memoryId);
            
            if (memories.length < initialLength) {
              memoryActions.forgets.push(memoryId);
              if (DEBUG_MODE) {
                console.log(`Forgot memory with ID for user ${userId}:`, memoryId);
              }
            } else {
              // Try to find by content match if ID didn't work
              const memoryToForget = memories.find(m => 
                m.content.toLowerCase().includes(memoryId.toLowerCase()) ||
                memoryId.toLowerCase().includes(m.content.toLowerCase()) ||
                m.id.includes(memoryId) ||
                memoryId.includes(m.id)
              );
              
              if (memoryToForget) {
                memories = memories.filter(m => m.id !== memoryToForget.id);
                memoryActions.forgets.push(memoryToForget.id);
                if (DEBUG_MODE) {
                  console.log(`Forgot memory for user ${userId}:`, memoryToForget.content);
                }
              }
            }
          }
        }
      }
      
      // Process store actions
      if (memoryActionsFromAI.stores && memoryActionsFromAI.stores.length > 0) {
        for (const memoryContent of memoryActionsFromAI.stores) {
          if (memoryContent && memoryContent.trim()) {
            const newMemory = {
              id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
              content: memoryContent.trim(),
              timestamp: new Date().toISOString(),
              userMessage: lastUserMessageText.substring(0, 100) // Store first 100 chars for context
            };
            memories.push(newMemory);
            memoryActions.stores.push(newMemory.content);
            if (DEBUG_MODE) {
              console.log(`Stored new memory for user ${userId}:`, newMemory.content);
            }
          }
        }
      }
      
      // Save memories if any changes were made
      if (memoryActions.stores.length > 0 || memoryActions.forgets.length > 0) {
        saveMemories(userId, memories);
      }
    }

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

    // Process image generation request(s) from AI response (supports single or array)
    let generatedImages = [];
    
    if (generateRequestFromAI) {
      // Normalize to array (max 3)
      const generateRequests = Array.isArray(generateRequestFromAI) 
        ? generateRequestFromAI.slice(0, 3).filter(g => g.shouldGenerate && g.prompt)
        : (generateRequestFromAI.shouldGenerate && generateRequestFromAI.prompt ? [generateRequestFromAI] : []);
      
      if (generateRequests.length > 0) {
        if (DEBUG_MODE) {
          console.log(`[Image Generation] Processing ${generateRequests.length} generation request(s) from AI`);
        }
        
        for (let i = 0; i < generateRequests.length; i++) {
          const genRequest = generateRequests[i];
          try {
            if (DEBUG_MODE) {
              console.log(`[Image Generation] Processing generation request ${i + 1}/${generateRequests.length}:`, genRequest.prompt.substring(0, 100) + '...');
            }
            const geminiModel = getGeminiImageModel(selectedModel);
            const generatedImage = await processImageGeneration(genRequest.prompt, req, geminiModel);
            if (generatedImage) {
              // Annotate generated image in parallel
              const annotationPromise = annotateImage(generatedImage).then(annotation => {
                if (DEBUG_MODE) {
                  console.log(`[Image Annotation] Annotation for generated image ${i + 1}: ${annotation || 'failed'}`);
                }
                return annotation;
              }).catch(err => {
                console.error(`[Image Annotation] Error annotating generated image ${i + 1}:`, err);
                return null;
              });
              
              generatedImages.push({
                image: generatedImage,
                annotationPromise: annotationPromise
              });
              if (DEBUG_MODE) {
                console.log(`[Image Generation] Successfully generated image ${i + 1}/${generateRequests.length}`);
              }
            }
          } catch (error) {
            console.error(`[Image Generation] Error generating image ${i + 1}:`, error);
            // Continue with other images if one fails
          }
        }
        
        if (generateRequests.length > 0 && generatedImages.length === 0) {
          text = text + '\n\nSorry, I encountered an error while generating the images. Please try again.';
        }
      }
    }
    
    // Process staging request(s) from AI response (supports single or array)
    let stagingResults = [];
    
    if (stagingRequestFromAI) {
      // Normalize to array (max 3)
      const stagingRequests = Array.isArray(stagingRequestFromAI)
        ? stagingRequestFromAI.slice(0, 3).filter(s => s.shouldStage)
        : (stagingRequestFromAI.shouldStage ? [stagingRequestFromAI] : []);
      
      if (stagingRequests.length > 0) {
        if (DEBUG_MODE) {
          console.log(`[Staging] Processing ${stagingRequests.length} staging request(s) from AI`);
        }
        
        for (let i = 0; i < stagingRequests.length; i++) {
          const stagingRequest = stagingRequests[i];
          if (DEBUG_MODE) {
            console.log(`[Staging] Processing staging request ${i + 1}/${stagingRequests.length}:`, stagingRequest);
          }
          
          // Build staging params from AI response
          let stagingParams = {
            roomType: stagingRequest.roomType || 'Other',
            furnitureStyle: 'custom', // Always use custom
            additionalPrompt: stagingRequest.additionalPrompt || '',
            removeFurniture: stagingRequest.removeFurniture || false,
            usePreviousImage: stagingRequest.usePreviousImage !== undefined ? stagingRequest.usePreviousImage : false,
            furnitureImageIndex: stagingRequest.furnitureImageIndex !== undefined && stagingRequest.furnitureImageIndex !== null ? stagingRequest.furnitureImageIndex : null,
            styleReference: stagingRequest.styleReference === true
          };

          let currentMessageImageBuffer = null;
          let currentMessageHasImageInChat = false;
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

          const addFurnitureFallbackChat = applyAddFurnitureStagingFallback(
            stagingParams,
            lastUserMessageText,
            messages,
            {
              currentMessageHasImage: currentMessageHasImageInChat,
              currentImageBuffer: currentMessageImageBuffer,
              baseImageIndex,
            }
          );
          stagingParams = addFurnitureFallbackChat.stagingParams;
          const furnitureFromCurrentUpload = addFurnitureFallbackChat.furnitureFromCurrentUpload;
          
          // Fallback: If user mentions "original", "first", or "initial" image but AI didn't set usePreviousImage correctly
          const messageLower = lastUserMessageText.toLowerCase();
          const hasOriginalKeywords = messageLower.includes('original') || 
                                      messageLower.includes('first image') || 
                                      messageLower.includes('initial image') ||
                                      messageLower.includes('go back to') ||
                                      messageLower.includes('refer back to');
          
          if (hasOriginalKeywords && (stagingParams.usePreviousImage === false || stagingParams.usePreviousImage === null)) {
            // Find the original (first) user-uploaded image
            const originalImageIndex = getOriginalImageIndex(messages);
            if (originalImageIndex !== null) {
              if (DEBUG_MODE) {
                console.log(`[Staging] Fallback: User mentioned "original" but AI didn't set usePreviousImage. Overriding to use original image at index ${originalImageIndex}`);
              }
              stagingParams.usePreviousImage = originalImageIndex;
            } else {
              // If no original found, use most recent (index 0)
              if (DEBUG_MODE) {
                console.log(`[Staging] Fallback: User mentioned "original" but no original image found. Using most recent image (index 0) as fallback`);
              }
              stagingParams.usePreviousImage = 0;
            }
          }

          stagingParams = applyBaseImageIndexToStagingParams(
            stagingParams,
            baseImageIndex,
            messages,
            {
              userMessage: lastUserMessageText,
              currentMessageHasImage: currentMessageHasImageInChat,
            }
          );
          
          if (stagingParams) {
            try {
              let imageBuffer = null;
              let imageSource = '';
              let furnitureImageBuffer = furnitureFromCurrentUpload || null;

              const dualUploadStagingChat = resolveDualUploadFromMessageContent(
                lastUserMessage && Array.isArray(lastUserMessage.content) ? lastUserMessage.content : null,
                lastUserMessageText
              );
              if (dualUploadStagingChat) {
                imageBuffer = dualUploadStagingChat.roomBuffer;
                furnitureImageBuffer = dualUploadStagingChat.furnitureBuffers;
                imageSource = dualUploadStagingChat.source;
                if (!stagingParams.additionalPrompt || !stagingParams.additionalPrompt.includes('user\'s actual room photo')) {
                  stagingParams = {
                    ...stagingParams,
                    additionalPrompt: (stagingParams.additionalPrompt || '') + DUAL_UPLOAD_ROOM_PROMPT_SUFFIX,
                  };
                }
              } else if (stagingParams.usePreviousImage !== false && stagingParams.usePreviousImage !== null) {
              // AI requested a previous image - use the AI's chosen index (AI should use context to determine the correct image)
              const imageIndex = typeof stagingParams.usePreviousImage === 'number' ? stagingParams.usePreviousImage : 0;
              if (DEBUG_MODE) {
                console.log(`[Staging] Looking for image at index ${imageIndex}`);
              }
              
              const previousImage = getImageFromHistory(messages, imageIndex);
              
              if (previousImage && previousImage.url) {
                const base64Data = previousImage.url.split(',')[1];
                if (base64Data) {
                  imageBuffer = Buffer.from(base64Data, 'base64');
                  imageSource = previousImage.isStaged ? `staged image (index ${imageIndex})` : `user-uploaded image (index ${imageIndex})`;
                  if (DEBUG_MODE) {
                    console.log(`[Staging] Using previous ${imageSource}`);
                  }
                } else {
                  if (DEBUG_MODE) {
                    console.log(`[Staging] Previous image found but base64 data extraction failed`);
                  }
                }
              } else {
                if (DEBUG_MODE) {
                  console.log(`[Staging] Previous image at index ${imageIndex} not found`);
                }
                // Fallback: try to use the most recent image (index 0) if requested index doesn't exist
                if (imageIndex > 0) {
                  if (DEBUG_MODE) {
                    console.log(`[Staging] Attempting fallback to index 0`);
                  }
                  const fallbackImage = getImageFromHistory(messages, 0);
                  if (fallbackImage && fallbackImage.url) {
                    const base64Data = fallbackImage.url.split(',')[1];
                    if (base64Data) {
                      imageBuffer = Buffer.from(base64Data, 'base64');
                      imageSource = fallbackImage.isStaged ? `staged image (fallback to index 0)` : `user-uploaded image (fallback to index 0)`;
                      if (DEBUG_MODE) {
                        console.log(`[Staging] Using fallback ${imageSource}`);
                      }
                    }
                  }
                }
              }
            } else if (imageFromHistory) {
              // Fallback to old logic if usePreviousImage is false but we have imageFromHistory
              const base64Data = imageFromHistory.split(',')[1];
              if (base64Data) {
                imageBuffer = Buffer.from(base64Data, 'base64');
                imageSource = isStagedImage ? 'staged image' : 'conversation history';
                if (DEBUG_MODE) {
                  console.log(`[Staging] Using image from conversation history (fallback)`);
                }
              }
            }
            
            // Retrieve furniture image if specified (skip if dual upload already set furniture buffers)
            if (!dualUploadStagingChat && !furnitureImageBuffer && stagingParams.furnitureImageIndex !== null && stagingParams.furnitureImageIndex !== undefined) {
              const furnitureIndex = typeof stagingParams.furnitureImageIndex === 'number' ? stagingParams.furnitureImageIndex : null;
              if (furnitureIndex !== null) {
                if (DEBUG_MODE) {
                  console.log(`[Staging] Looking for furniture image at index ${furnitureIndex}`);
                }
                const furnitureImage = getImageFromHistory(messages, furnitureIndex);
                
                if (furnitureImage && furnitureImage.url) {
                  const base64Data = furnitureImage.url.split(',')[1];
                  if (base64Data) {
                    furnitureImageBuffer = Buffer.from(base64Data, 'base64');
                    if (DEBUG_MODE) {
                      console.log(`[Staging] Found furniture image at index ${furnitureIndex}`);
                    }
                  }
                } else {
                  if (DEBUG_MODE) {
                    console.log(`[Staging] Furniture image at index ${furnitureIndex} not found`);
                  }
                }
              }
            }
            
            if (imageBuffer) {
              try {
                const geminiModel = getGeminiImageModel(selectedModel);
                const stagedImage = await processStaging(imageBuffer, stagingParams, req, furnitureImageBuffer, geminiModel);
                if (stagedImage) {
                  // Increment prompt count for staging
                  incPromptCount();
                  
                  // Annotate staged image in parallel
                  const annotationPromise = annotateImage(stagedImage).then(annotation => {
                    if (DEBUG_MODE) {
                      console.log(`[Image Annotation] Annotation for staged image ${i + 1}: ${annotation || 'failed'}`);
                    }
                    return annotation;
                  }).catch(err => {
                    console.error(`[Image Annotation] Error annotating staged image ${i + 1}:`, err);
                    return null;
                  });
                  
                  stagingResults.push({
                    stagedImage: stagedImage,
                    params: stagingParams,
                    annotationPromise: annotationPromise
                  });
                  if (DEBUG_MODE) {
                    console.log(`[Staging] Successfully processed staging ${i + 1}/${stagingRequests.length} for user ${userId} from ${imageSource}${furnitureImageBuffer ? ' with furniture image' : ''}`);
                  }
                }
              } catch (stagingError) {
                console.error(`[Staging] Error processing staging ${i + 1}:`, stagingError);
                console.error(`[Staging] Error stack:`, stagingError.stack);
                // Continue with other staging requests if one fails
                // Add error message to text response
                if (stagingRequests.length === 1) {
                  text = (text || '') + '\n\nSorry, I encountered an error while staging the room. Please try again.';
                }
              }
            } else {
              if (DEBUG_MODE) {
                console.log(`[Staging] No image found for staging ${i + 1}`);
              }
              if (stagingRequests.length === 1) {
                text = (text || '') + '\n\nSorry, I couldn\'t find the image to stage. Please make sure you\'ve uploaded an image.';
              }
            }
          } catch (error) {
            console.error(`[Staging] Error in staging request ${i + 1}:`, error);
            console.error(`[Staging] Error stack:`, error.stack);
            // Continue with other staging requests if one fails
            if (stagingRequests.length === 1) {
              text = (text || '') + '\n\nSorry, I encountered an error while processing the staging request. Please try again.';
            }
          }
          }
        }
      }
    }

    // Process recall request from AI response (simpler than imageRequest - just retrieves and displays)
    let recalledImageForDisplay = null;
    if (recallRequestFromAI && recallRequestFromAI.shouldRecall) {
      try {
        const imageIndex = typeof recallRequestFromAI.imageIndex === 'number' ? recallRequestFromAI.imageIndex : 0;
        if (DEBUG_MODE) {
          console.log(`[Recall] Processing recall request from AI, index: ${imageIndex}`);
        }
        
        // Retrieve the image from conversation history
        const recalledImage = getImageFromHistory(messages, imageIndex);
        
        if (recalledImage && recalledImage.url) {
          if (DEBUG_MODE) {
            console.log(`[Recall] Found image at index ${imageIndex}`);
          }
          recalledImageForDisplay = recalledImage.url;
        } else {
          if (DEBUG_MODE) {
            console.log(`[Recall] Image at index ${imageIndex} not found`);
          }
        }
      } catch (error) {
        console.error('Error processing recall request:', error);
        // Continue with original response if recall fails
      }
    }

    // Process image request from AI response
    let requestedImageForDisplay = null;
    if (imageRequestFromAI && imageRequestFromAI.requestImage) {
      try {
        const imageIndex = typeof imageRequestFromAI.imageIndex === 'number' ? imageRequestFromAI.imageIndex : 0;
        if (DEBUG_MODE) {
          console.log(`[Image Request] Processing image request from AI, index: ${imageIndex}`);
        }
        
        // Retrieve the image from conversation history
        const requestedImage = getImageFromHistory(messages, imageIndex);
        
        if (requestedImage && requestedImage.url) {
          if (DEBUG_MODE) {
            console.log(`[Image Request] Found image at index ${imageIndex}`);
          }
          
          // Store the image URL to return in response for display
          requestedImageForDisplay = requestedImage.url;
          
          // Check if user wants to analyze/describe the image (vs just view it)
          // Only analyze if explicitly asking for description/analysis, not just "show me"
          const messageLower = lastUserMessageText.toLowerCase();
          const wantsAnalysis = (messageLower.includes('describe') && !messageLower.includes('show')) || 
                               (messageLower.includes('analyze') && !messageLower.includes('show')) || 
                               (messageLower.includes('what') && messageLower.includes('in') && !messageLower.includes('show')) ||
                               messageLower.includes('tell me about') ||
                               (messageLower.includes('explain') && !messageLower.includes('show'));
          
          if (wantsAnalysis) {
            if (DEBUG_MODE) {
              console.log(`[Image Request] User wants analysis, sending to GPT for analysis`);
            }
            // Make another GPT call with the image for analysis
            const imageAnalysisMessages = [
              { role: 'system', content: systemInstruction },
              ...openaiMessages.slice(1), // Skip the original system message, keep the rest
              {
                role: 'user',
                content: [
                  { type: 'text', text: lastUserMessageText },
                  {
                    type: 'image_url',
                    image_url: {
                      url: await downscaleImageForGPT(requestedImage.url)
                    }
                  }
                ]
              }
            ];
            
            const imageAnalysisCompletion = await openai.chat.completions.create({
              model: selectedModel,
              messages: imageAnalysisMessages,
              temperature: getTemperatureForModel(selectedModel),
              response_format: DESIGNER_ROUTING_RESPONSE_FORMAT
            });
            
            const imageAnalysisJson = parseDesignerRoutingCompletion(imageAnalysisCompletion);
            text = imageAnalysisJson.response || imageAnalysisCompletion.choices[0].message.content;
            
            if (DEBUG_MODE) {
              console.log(`[Image Request] Successfully analyzed image, response: ${text.substring(0, 100)}...`);
            }
          } else {
            // User just wants to see the image - keep the original text response
            if (DEBUG_MODE) {
              console.log(`[Image Request] User wants to view image, returning image for display`);
            }
          }
        } else {
          if (DEBUG_MODE) {
            console.log(`[Image Request] Image at index ${imageIndex} not found`);
          }
        }
      } catch (error) {
        console.error('Error processing image request:', error);
        // Continue with original response if image request fails
      }
    }

    // Process CAD request(s) from AI response (supports single or array)
    let cadResults = [];
    
    if (cadRequestFromAI) {
      // Normalize to array (max 3)
      const cadRequests = Array.isArray(cadRequestFromAI)
        ? cadRequestFromAI.slice(0, 3).filter(c => c.shouldProcessCAD)
        : (cadRequestFromAI.shouldProcessCAD ? [cadRequestFromAI] : []);
      
      if (cadRequests.length > 0) {
        if (DEBUG_MODE) {
          console.log(`[CAD] Processing ${cadRequests.length} CAD request(s) from AI`);
        }
        
        for (let i = 0; i < cadRequests.length; i++) {
          const cadRequest = cadRequests[i];
          if (DEBUG_MODE) {
            console.log(`[CAD] Processing CAD request ${i + 1}/${cadRequests.length}:`, cadRequest);
          }
          
          try {
            const imageIndex = resolveCadImageIndex(
              cadRequest,
              baseImageIndex,
              messages,
              Boolean(
                lastUserMessage &&
                  Array.isArray(lastUserMessage.content) &&
                  lastUserMessage.content.some(
                    (item) => item.type === 'image_url' && item.image_url && item.image_url.url
                  )
              )
            );
            if (DEBUG_MODE) {
              console.log(`[CAD] Processing CAD request from AI, index: ${imageIndex}`);
            }
            
            // Retrieve the blueprint image from conversation history
            const blueprintImage = getImageFromHistory(messages, imageIndex);
            
            if (blueprintImage && blueprintImage.url) {
              if (DEBUG_MODE) {
                console.log(`[CAD] Found blueprint image at index ${imageIndex}`);
              }
              
              // Extract base64 data from the image URL
              const base64Data = blueprintImage.url.split(',')[1];
              if (base64Data) {
                const imageBuffer = Buffer.from(base64Data, 'base64');
                const mimeType = blueprintImage.url.match(/data:([^;]+)/)?.[1] || 'image/png';
                
                // Retrieve furniture images if specified
                const furnitureImages = [];
                if (cadRequest.furnitureImageIndex !== null && cadRequest.furnitureImageIndex !== undefined) {
                  const furnitureIndices = Array.isArray(cadRequest.furnitureImageIndex) 
                    ? cadRequest.furnitureImageIndex 
                    : [cadRequest.furnitureImageIndex];
                  
                  for (const furnitureIndex of furnitureIndices) {
                    if (furnitureIndex !== null && furnitureIndex !== undefined) {
                      const furnitureImage = getImageFromHistory(messages, furnitureIndex);
                      if (furnitureImage && furnitureImage.url) {
                        const furnitureBase64Data = furnitureImage.url.split(',')[1];
                        if (furnitureBase64Data) {
                          const furnitureBuffer = Buffer.from(furnitureBase64Data, 'base64');
                          const furnitureMimeType = furnitureImage.url.match(/data:([^;]+)/)?.[1] || 'image/png';
                          furnitureImages.push({
                            image: furnitureBuffer,
                            mimeType: furnitureMimeType
                          });
                          if (DEBUG_MODE) {
                            console.log(`[CAD] Found furniture image at index ${furnitureIndex}`);
                          }
                        }
                      } else {
                        if (DEBUG_MODE) {
                          console.log(`[CAD] Furniture image at index ${furnitureIndex} not found`);
                        }
                      }
                    }
                  }
                }
                
                if (DEBUG_MODE) {
                  console.log(`[CAD] Processing blueprint with CAD function${furnitureImages.length > 0 ? ` (with ${furnitureImages.length} furniture image(s))` : ''}${cadRequest.additionalPrompt ? ` (with additional prompt: ${cadRequest.additionalPrompt.substring(0, 50)}...)` : ''}...`);
                }
                // Process the blueprint through CAD function
                const additionalPrompt = cadRequest.additionalPrompt || null;
                const cadResultBuffer = await blueprintTo3D(imageBuffer, mimeType, furnitureImages, additionalPrompt);
                
                // Convert result buffer to data URL
                const cadImageBase64 = cadResultBuffer.toString('base64');
                const cadImageForDisplay = `data:${mimeType};base64,${cadImageBase64}`;
                
                // Annotate CAD image in parallel
                const annotationPromise = annotateImage(cadImageForDisplay, true).then(annotation => {
                  if (DEBUG_MODE) {
                    console.log(`[Image Annotation] Annotation for CAD render ${i + 1}: ${annotation || 'failed'}`);
                  }
                  return annotation;
                }).catch(err => {
                  console.error(`[Image Annotation] Error annotating CAD render ${i + 1}:`, err);
                  return null;
                });
                
                cadResults.push({
                  cadImage: cadImageForDisplay,
                  params: cadRequest,
                  annotationPromise: annotationPromise
                });
                
                if (DEBUG_MODE) {
                  console.log(`[CAD] Successfully generated 3D render ${i + 1}/${cadRequests.length} from blueprint${furnitureImages.length > 0 ? ' with furniture' : ''}`);
                }
              } else {
                if (DEBUG_MODE) {
                  console.log(`[CAD] Failed to extract base64 data from blueprint image`);
                }
              }
            } else {
              if (DEBUG_MODE) {
                console.log(`[CAD] Blueprint image at index ${imageIndex} not found`);
              }
            }
          } catch (error) {
            if (DEBUG_MODE) {
              console.error(`[CAD] Error processing CAD request ${i + 1}:`, error);
            }
            // Continue with other CAD requests if one fails
            if (cadRequests.length === 1) {
              text = (text || '') + '\n\nSorry, I encountered an error while processing the CAD blueprint. Please try again.';
            }
          }
        }
      }
    }
    
    // Legacy support: maintain cadImageForDisplay and cadAnnotationPromise for backward compatibility
    let cadImageForDisplay = null;
    let cadAnnotationPromise = null;
    if (cadResults.length > 0) {
      cadImageForDisplay = cadResults[0].cadImage;
      cadAnnotationPromise = cadResults[0].annotationPromise;
    }

    // Wait for all annotations to complete before building response
    const stagedImageAnnotations = {};
    if (stagingResults.length > 0) {
      for (let i = 0; i < stagingResults.length; i++) {
        if (stagingResults[i].annotationPromise) {
          const annotation = await stagingResults[i].annotationPromise;
          if (annotation) {
            stagedImageAnnotations[`staged_${i}`] = annotation;
          }
        }
      }
    }
    
    const generatedImageAnnotations = {};
    if (generatedImages.length > 0) {
      for (let i = 0; i < generatedImages.length; i++) {
        if (generatedImages[i].annotationPromise) {
          const annotation = await generatedImages[i].annotationPromise;
          if (annotation) {
            generatedImageAnnotations[`generated_${i}`] = annotation;
          }
        }
      }
    }
    
    // Wait for all CAD annotations to complete
    const cadImageAnnotations = {};
    if (cadResults.length > 0) {
      for (let i = 0; i < cadResults.length; i++) {
        if (cadResults[i].annotationPromise) {
          const annotation = await cadResults[i].annotationPromise;
          if (annotation) {
            cadImageAnnotations[`cad_${i}`] = annotation;
          }
        }
      }
    }
    
    // Legacy support
    let cadImageAnnotation = null;
    if (cadImageForDisplay && cadAnnotationPromise) {
      cadImageAnnotation = await cadAnnotationPromise;
    }

    // Return JSON response with text, memory actions, staging result(s), generated image(s), and requested image if available
    const response = { 
      response: text,
      memories: memoryActions
    };
    
    // Handle multiple staging results
    if (stagingResults.length > 0) {
      if (stagingResults.length === 1) {
        // Single result - maintain backward compatibility
        response.stagedImage = stagingResults[0].stagedImage;
        response.stagingParams = stagingResults[0].params;
      } else {
        // Multiple results - return as array
        response.stagedImages = stagingResults.map(r => r.stagedImage);
        response.stagingParams = stagingResults.map(r => r.params);
      }
      // Include annotations if available
      if (Object.keys(stagedImageAnnotations).length > 0) {
        response.stagedImageAnnotations = stagedImageAnnotations;
      }
    }
    
    // Handle multiple generated images
    if (generatedImages.length > 0) {
      if (generatedImages.length === 1) {
        // Single result - maintain backward compatibility
        response.generatedImage = generatedImages[0].image || generatedImages[0];
      } else {
        // Multiple results - return as array
        response.generatedImages = generatedImages.map(g => g.image || g);
      }
      // Include annotations if available
      if (Object.keys(generatedImageAnnotations).length > 0) {
        response.generatedImageAnnotations = generatedImageAnnotations;
      }
    }
    
    if (requestedImageForDisplay) {
      response.requestedImage = requestedImageForDisplay;
    }
    
    if (recalledImageForDisplay) {
      response.recalledImage = recalledImageForDisplay;
    }
    
    // Handle multiple CAD results
    if (cadResults.length > 0) {
      if (cadResults.length === 1) {
        // Single result - maintain backward compatibility
        response.cadImage = cadResults[0].cadImage;
        if (cadImageAnnotation) {
          response.cadImageAnnotation = cadImageAnnotation;
        }
      } else {
        // Multiple results - return as array
        response.cadImages = cadResults.map(r => r.cadImage);
        response.cadParams = cadResults.map(r => r.params);
      }
      // Include annotations if available
      if (Object.keys(cadImageAnnotations).length > 0) {
        response.cadImageAnnotations = cadImageAnnotations;
      }
    }
    
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
    let systemInstruction = 'You are a helpful AI assistant for Stagify.ai, a room staging and interior design service. ';
    systemInstruction += 'Your primary purpose is to help users with room staging, interior design, and home decoration. ';
    systemInstruction += 'You have THREE main capabilities: (1) STAGE/MODIFY existing room images - add furniture and decor to uploaded room photos, (2) GENERATE completely new images from text descriptions - create brand new images from scratch based on user descriptions, and (3) CAD-STAGE blueprints/floor plans - convert 2D architectural drawings into 3D staged renders. ';
    systemInstruction += 'You can also answer questions about interior design and provide design advice. ';
    systemInstruction += '\n\nCRITICAL: Stay on topic. Your primary focus is room staging and interior design, but you can:';
    systemInstruction += '\n- Have friendly, introductory conversations and get to know the user';
    systemInstruction += '\n- Answer questions about room staging and interior design';
    systemInstruction += '\n- Discuss home decoration, furniture, design styles, color schemes, and layouts';
    systemInstruction += '\n- Explain Stagify.ai features and functionality';
    systemInstruction += '\n- Help with file uploads and image processing';
    systemInstruction += '\n\nIf a user asks about completely unrelated topics (such as writing essays, general knowledge questions, or subjects that have nothing to do with design or your service), politely redirect them. However, feel free to be conversational, friendly, and engage in introductory small talk.';
    systemInstruction += '\n\nIMPORTANT: Check file types. Supported file types are: images (JPEG, JPG, PNG, WebP, GIF), PDFs, and text files. ';
    systemInstruction += 'If a user uploads an unsupported file type, you must inform them clearly which file type is not supported. ';
    systemInstruction += 'For example: "I\'m sorry, but [filename.xyz] is not a supported file type. Supported types are: images (JPEG, JPG, PNG, WebP, GIF), PDFs, and text files." ';
    systemInstruction += '\n\nIMPORTANT: Previous messages may reference files with placeholders like "[Image: filename.jpg]" or "[Staged image: filename.jpg]". These are references to files that were uploaded or generated in previous messages. The actual file data is NOT included to save bandwidth. Only files from the CURRENT message have their actual data included.';
    if (memories.length > 0) {
      systemInstruction += '\n\nImportant information to remember:\n';
      memories.forEach((memory, index) => {
        systemInstruction += `${index + 1}. ${memory.content}\n`;
      });
    }
    systemInstruction += '\n\nYou must respond with a JSON object containing:';
    systemInstruction += '\n- "response": Your text response to the user';
    systemInstruction += '\n- "memories": { "stores": ["memory description 1", ...], "forgets": ["memory ID 1", ...] } - Store or forget memories based on the conversation. To forget ALL memories, use "forgets": ["all"]';
    systemInstruction += '\n- "staging": { "shouldStage": true/false, "roomType": "Living room"|"Bedroom"|"Kitchen"|"Bathroom"|"Dining room"|"Office"|"Other", "additionalPrompt": "detailed staging description", "removeFurniture": true/false, "usePreviousImage": false|0|1|2|..., "furnitureImageIndex": null|0|1|2|... } OR "staging": [ { "shouldStage": true, ... }, { "shouldStage": true, ... }, ... ] - Request staging if the user wants to stage/modify a room image (ONLY use staging when the user has uploaded or is referring to an existing room image to modify). If the user wants to add a specific piece of furniture from a previous message, set "furnitureImageIndex" to the index of that furniture image (0 = most recent image, 1 = second most recent, etc.). You can provide MULTIPLE staging requests (up to 3) in an array if the user asks for multiple variations (e.g., "stage this room in 3 different themes"). Each staging request in the array will be processed separately.';
    systemInstruction += '\n- "imageRequest": { "requestImage": true/false, "imageIndex": 0|1|2|... } - Request to view/analyze a previous image by index (0 = most recent, 1 = second most recent, etc.). Use this when the user asks to "show me", "see", "view", or "display" a previous image. The image will be displayed to the user. If the user also wants analysis/description, the system will analyze it automatically.';
    systemInstruction += '\n- "generate": { "shouldGenerate": true/false, "prompt": "detailed image generation prompt" } OR "generate": [ { "shouldGenerate": true, "prompt": "..." }, { "shouldGenerate": true, "prompt": "..." }, ... ] - Generate a completely new image from text description (ONLY use generation when the user wants to create a NEW image from scratch, NOT when they want to modify an existing room image. If they uploaded an image or are referring to a previous image, use staging instead). You can provide MULTIPLE generation requests (up to 3) in an array if the user asks for multiple variations. Each generation request in the array will be processed separately.';
    systemInstruction += '\n\nIMPORTANT DISTINCTION:\n- Use "staging" when: user uploaded a room photo (3D perspective view of an interior space), user refers to a previous room photo with "CAD: False", user wants to modify/redesign an existing room photo that is NOT a CAD-staged image\n- Use "cad" (CAD-staging) when: (1) user uploaded a blueprint/floor plan (2D top-down architectural drawing), (2) user refers to a previous blueprint, (3) user says "stage" but the image is a blueprint/floor plan, OR (4) user wants to modify an image that has "CAD: True" in the image context - ALWAYS use CAD-staging for blueprints and CAD-staged images, even if the user says "stage"\n- Use "generate" when: user wants to create a completely new image from text only (no existing image involved), user asks to "generate", "create", "draw", or "make" an image of something that is NOT a room modification';
    systemInstruction += '\n\nSTAGING RULES (for room photos only):';
    systemInstruction += '\n- CRITICAL: Regular staging is ONLY for room photos (3D perspective interior views). If the user uploads or refers to a blueprint/floor plan (2D top-down architectural drawing), use CAD-staging ("cad" field) instead, even if they say "stage".';
    systemInstruction += '\n- CRITICAL: Before using regular staging, check the image context above. If the image you are modifying has "CAD: True" in its annotation, you MUST use CAD-staging ("cad" field) instead, NOT regular staging. This includes images you previously created with CAD-staging - if a user asks to modify a CAD-staged image, use CAD-staging again.';
    systemInstruction += '\n- Set "shouldStage": true if the user wants to stage a room photo, modify a room photo, change colors/walls/furniture, or apply any visual changes to a room photo (NOT a blueprint, and NOT a CAD-staged image with CAD: True)';
    systemInstruction += '\n- Set "usePreviousImage": false if using the current message\'s image, or the index (0 = most recent, 1 = second most recent, etc.) if modifying a previous image';
    systemInstruction += '\n- IMPORTANT: When adding furniture to a room, set "usePreviousImage" to the TARGET ROOM index — the staged or uploaded room photo, NOT the furniture upload. Priority: (1) thumbnail strip base image if the user selected one, (2) the room obvious from conversation, (3) most recent staged room. If the user uploads furniture in the CURRENT message, set "furnitureImageIndex" to null — the system attaches it automatically. If furniture is from a prior message, set "furnitureImageIndex" to that index. NEVER use "generate" for this — use "staging" only.';
    systemInstruction += '\n- The "additionalPrompt" should be a detailed, comprehensive description of the staging request. IMPORTANT: Always emphasize that architecture (walls, windows, doors, room structure) and existing furniture must be preserved exactly as they appear - only add new furniture and decor, do not modify what\'s already there unless explicitly requested. CRITICAL: Preserve the exact aspect ratio and full frame — do not crop, zoom, or cut off any part of the room unless the user explicitly asked for a tighter crop';
    systemInstruction += '\n- Set "styleReference": true ONLY when the user provides an image to match an aesthetic/style ("stage it like this", "match this vibe") rather than a specific furniture piece to place. Then "usePreviousImage" is still the room to stage; the reference image guides the look only. Otherwise omit it or set false.';
    systemInstruction += '\n- If "shouldStage" is false, you can omit the "staging" field or set it to null';
    systemInstruction += '\n\nIMAGE REQUEST RULES:';
    systemInstruction += '\n- Set "requestImage": true if the user asks to see, describe, analyze, or look at a previous image';
    systemInstruction += '\n- Set "imageIndex" to the index of the image (0 = most recent, 1 = second most recent, etc.)';
    systemInstruction += '\n- If user says "original image", "first image", or "initial image", use the original image index shown above';
    systemInstruction += '\n- If "requestImage" is false, you can omit the "imageRequest" field or set it to null';
    systemInstruction += '\n\nRECALL RULES:';
    systemInstruction += '\n- "recall": { "shouldRecall": true/false, "imageIndex": 0|1|2|... } - Recall and display a previous image by index (0 = most recent, 1 = second most recent, etc.). Use this when the user asks to "see", "show", "recall", or "bring back" an old image. This works for ANY image in the conversation history: user-uploaded images, staged images, generated images, and CAD-staging renders. This is simpler than imageRequest - it just retrieves and displays the image without analysis. If user says "original image", "first image", or "initial image", use the original image index shown above.';
    systemInstruction += '\n- Set "shouldRecall": true if the user asks to see, show, recall, or bring back an old image';
    systemInstruction += '\n- You can recall ANY image from the conversation: user-uploaded images, images you staged, images you generated, or CAD-staging renders you created';
    systemInstruction += '\n- Set "imageIndex" to the index of the image (0 = most recent, 1 = second most recent, etc.)';
    systemInstruction += '\n- Check the "Available images in conversation history" list above to find the correct index for any image (including your own generated/staged images)';
    systemInstruction += '\n- If user says "original image", "first image", or "initial image", use the original image index shown above';
    systemInstruction += '\n- If user asks to see "the image I generated" or "the staged image", look for "generated image" or "staged image" in the image list above';
    systemInstruction += '\n- If "shouldRecall" is false, you can omit the "recall" field or set it to null';
    systemInstruction += '\n\nCAD-STAGING RULES (for blueprints/floor plans and CAD-staged images):';
    systemInstruction += '\n- "cad": { "shouldProcessCAD": true/false, "imageIndex": 0|1|2|..., "furnitureImageIndex": null|0|1|2|...|[...], "additionalPrompt": "detailed CAD-staging description" } OR "cad": [ { "shouldProcessCAD": true, ... }, { "shouldProcessCAD": true, ... }, ... ] - CAD-staging processes a top-down blueprint/floor plan image to create a 3D render. This is DIFFERENT from regular staging. Use CAD-staging when: (1) the user uploads a top-down blueprint, floor plan, or architectural drawing (2D plan view from above), OR (2) the user wants to modify an image that has "CAD: True" in its annotation (check the image context above). CRITICAL: Even if the user says "stage this blueprint" or "stage this floor plan", you MUST use CAD-staging (set "shouldProcessCAD": true), NOT regular staging. CRITICAL: If the user asks to modify a previously CAD-staged image (one with "CAD: True" in the image context), you MUST use CAD-staging again, NOT regular staging. Regular staging is ONLY for room photos (3D perspective views), NOT for blueprints or CAD-staged images. Set "imageIndex" to the index of the blueprint or CAD-staged image (0 = most recent, 1 = second most recent, etc.). If the user uploads a blueprint in the current message, use imageIndex 0. If the user wants to include specific furniture pieces in the 3D render, set "furnitureImageIndex" to the index (or array of indices) of the furniture image(s) from previous messages. The "additionalPrompt" should be a detailed description of any specific requirements, themes, styles, or preferences the user has (e.g., "medieval theme", "modern minimalist", "cozy atmosphere", etc.). The CAD-staging function will convert the blueprint to a top-down 3D render and include the furniture and styling preferences if specified. You can provide MULTIPLE CAD requests (up to 3) in an array if the user asks for multiple variations (e.g., "stage this blueprint in 3 different themes"). Each CAD request in the array will be processed separately.';
    systemInstruction += '\n- CRITICAL: If the user uploads or refers to a blueprint/floor plan (2D top-down architectural drawing), you MUST set "shouldProcessCAD": true, even if they say "stage". Blueprints ALWAYS use CAD-staging, never regular staging.';
    systemInstruction += '\n- CRITICAL: If the user asks to modify an image that has "CAD: True" in the image context above, you MUST use CAD-staging ("cad" field), NOT regular staging. Always check the CAD classification in the image annotations before deciding which pipeline to use.';
    systemInstruction += '\n- CRITICAL: Regular staging ("staging" field) is ONLY for room photos (3D perspective interior views). If you see a blueprint/floor plan OR an image with "CAD: True", use CAD-staging instead.';
    systemInstruction += '\n- Set "furnitureImageIndex" to the index (or array of indices) of furniture images from previous messages if the user wants to include specific furniture in the 3D render';
    systemInstruction += '\n- If "shouldProcessCAD" is false, you can omit the "cad" field or set it to null';
    systemInstruction += AI_DESIGNER_RESPONSE_ACTION_RULES;
    systemInstruction += AI_DESIGNER_IMAGE_FRAMING_RULES;
    systemInstruction += STAGIFY_SELF_KNOWLEDGE;
    systemInstruction += getStagifyDateContext();

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

    // Process memory actions from AI response
    const memoryActions = { stores: [], forgets: [] };
    if (message && memoryActionsFromAI) {
      if (DEBUG_MODE) {
        console.log(`[Memory] Processing memory actions from AI response:`, memoryActionsFromAI);
      }
      
      // Process forget actions first
      if (memoryActionsFromAI.forgets && memoryActionsFromAI.forgets.length > 0) {
        // Check if user wants to forget all memories
        if (memoryActionsFromAI.forgets.includes('all')) {
          const forgottenCount = memories.length;
          memories = [];
          memoryActions.forgets = ['all'];
          if (DEBUG_MODE) {
            console.log(`Forgot ALL ${forgottenCount} memories for user ${userId}`);
          }
        } else {
          // Process individual memory forgets
          for (const memoryId of memoryActionsFromAI.forgets) {
            const initialLength = memories.length;
            // Try exact ID match first
            memories = memories.filter(m => m.id !== memoryId);
            
            if (memories.length < initialLength) {
              memoryActions.forgets.push(memoryId);
              console.log(`Forgot memory with ID for user ${userId}:`, memoryId);
            } else {
              // Try to find by content match if ID didn't work
              const memoryToForget = memories.find(m => 
                m.content.toLowerCase().includes(memoryId.toLowerCase()) ||
                memoryId.toLowerCase().includes(m.content.toLowerCase()) ||
                m.id.includes(memoryId) ||
                memoryId.includes(m.id)
              );
              
              if (memoryToForget) {
                memories = memories.filter(m => m.id !== memoryToForget.id);
                memoryActions.forgets.push(memoryToForget.id);
                console.log(`Forgot memory for user ${userId}:`, memoryToForget.content);
              }
            }
          }
        }
      }
      
      // Process store actions
      if (memoryActionsFromAI.stores && memoryActionsFromAI.stores.length > 0) {
        for (const memoryContent of memoryActionsFromAI.stores) {
          if (memoryContent && memoryContent.trim()) {
            const newMemory = {
              id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9),
              content: memoryContent.trim(),
              timestamp: new Date().toISOString(),
              userMessage: message.substring(0, 100) // Store first 100 chars for context
            };
            memories.push(newMemory);
            memoryActions.stores.push(newMemory.content);
            if (DEBUG_MODE) {
              console.log(`Stored new memory for user ${userId}:`, newMemory.content);
            }
          }
        }
      }
      
      // Save memories if any changes were made
      if (memoryActions.stores.length > 0 || memoryActions.forgets.length > 0) {
        saveMemories(userId, memories);
      }
    }

    // Process staging request(s) from AI response (supports single or array)
    let stagingResults = [];
    
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
    
    if (stagingRequestFromAI) {
      // Normalize to array (max 3)
      const stagingRequests = Array.isArray(stagingRequestFromAI)
        ? stagingRequestFromAI.slice(0, 3).filter(s => s.shouldStage)
        : (stagingRequestFromAI.shouldStage ? [stagingRequestFromAI] : []);
      
      if (stagingRequests.length > 0) {
        if (DEBUG_MODE) {
          console.log(`[Staging] Processing ${stagingRequests.length} staging request(s) from AI`);
        }
        
        for (let i = 0; i < stagingRequests.length; i++) {
          const stagingRequest = stagingRequests[i];
          if (DEBUG_MODE) {
            console.log(`[Staging] Processing staging request ${i + 1}/${stagingRequests.length}:`, stagingRequest);
          }
          
          // Build staging params from AI response
          let stagingParams = {
            roomType: stagingRequest.roomType || 'Other',
            furnitureStyle: 'custom', // Always use custom
            additionalPrompt: stagingRequest.additionalPrompt || '',
            removeFurniture: stagingRequest.removeFurniture || false,
            usePreviousImage: stagingRequest.usePreviousImage !== undefined ? stagingRequest.usePreviousImage : false,
            furnitureImageIndex: stagingRequest.furnitureImageIndex !== undefined && stagingRequest.furnitureImageIndex !== null ? stagingRequest.furnitureImageIndex : null,
            styleReference: stagingRequest.styleReference === true
          };

          const addFurnitureFallbackUpload = applyAddFurnitureStagingFallback(
            stagingParams,
            message,
            conversationHistory,
            {
              currentMessageHasImage,
              currentImageBuffer: firstImageFile ? firstImageFile.buffer : null,
              baseImageIndex: baseImageIndexUpload,
            }
          );
          stagingParams = addFurnitureFallbackUpload.stagingParams;
          const furnitureFromCurrentUpload = addFurnitureFallbackUpload.furnitureFromCurrentUpload;
          
          // Fallback: If user mentions "original", "first", or "initial" image but AI didn't set usePreviousImage correctly
          if (!currentMessageHasImage) {
            const messageLower = message.toLowerCase();
            const hasOriginalKeywords = messageLower.includes('original') || 
                                        messageLower.includes('first image') || 
                                        messageLower.includes('initial image') ||
                                        messageLower.includes('go back to') ||
                                        messageLower.includes('refer back to');
            
            if (hasOriginalKeywords && (stagingParams.usePreviousImage === false || stagingParams.usePreviousImage === null)) {
              // Find the original (first) user-uploaded image
              const originalImageIndex = getOriginalImageIndex(conversationHistory);
              if (originalImageIndex !== null) {
                if (DEBUG_MODE) {
                  console.log(`[Staging] Fallback: User mentioned "original" but AI didn't set usePreviousImage. Overriding to use original image at index ${originalImageIndex}`);
                }
                stagingParams.usePreviousImage = originalImageIndex;
              } else {
                // If no original found, use most recent (index 0)
                if (DEBUG_MODE) {
                  console.log(`[Staging] Fallback: User mentioned "original" but no original image found. Using most recent image (index 0) as fallback`);
                }
                stagingParams.usePreviousImage = 0;
              }
            }
          }

          stagingParams = applyBaseImageIndexToStagingParams(
            stagingParams,
            baseImageIndexUpload,
            conversationHistory,
            {
              userMessage: message,
              currentMessageHasImage,
            }
          );
          
          if (stagingParams) {
            try {
            let imageBuffer = null;
            let imageSource = '';
            let furnitureImageBuffer = furnitureFromCurrentUpload || null;

            const dualUploadStaging = resolveDualUploadStaging(files, cleanedUserContent, message);
            if (dualUploadStaging) {
              imageBuffer = dualUploadStaging.roomBuffer;
              furnitureImageBuffer = dualUploadStaging.furnitureBuffers;
              imageSource = dualUploadStaging.source;
              if (!stagingParams.additionalPrompt || !stagingParams.additionalPrompt.includes('user\'s actual room photo')) {
                stagingParams = {
                  ...stagingParams,
                  additionalPrompt: (stagingParams.additionalPrompt || '') + DUAL_UPLOAD_ROOM_PROMPT_SUFFIX,
                };
              }
            } else if (stagingParams.usePreviousImage !== false && stagingParams.usePreviousImage !== null) {
            // AI requested a previous image
            const imageIndex = typeof stagingParams.usePreviousImage === 'number' ? stagingParams.usePreviousImage : 0;
            
            // Use the AI's chosen image index (AI should use context to determine the correct image)
            // Debug: Log conversation history structure
            if (DEBUG_MODE) {
              console.log(`[Staging] Looking for image at index ${imageIndex}`);
              console.log(`[Staging] Conversation history length: ${conversationHistory.length}`);
            }
            if (DEBUG_MODE) {
              console.log(`[Staging] Conversation history structure:`, JSON.stringify(conversationHistory.map(msg => ({
                role: msg.role,
                hasContent: !!msg.content,
                contentType: Array.isArray(msg.content) ? 'array' : typeof msg.content,
                contentLength: Array.isArray(msg.content) ? msg.content.length : (typeof msg.content === 'string' ? msg.content.length : 0),
                hasImages: Array.isArray(msg.content) ? msg.content.some(item => item.type === 'image_url') : false
              })), null, 2));
            }
            
            const previousImage = getImageFromHistory(conversationHistory, imageIndex);
            
            if (previousImage && previousImage.url) {
              const base64Data = previousImage.url.split(',')[1];
              if (base64Data) {
                imageBuffer = Buffer.from(base64Data, 'base64');
                imageSource = previousImage.isStaged ? `staged image (index ${imageIndex})` : `user-uploaded image (index ${imageIndex})`;
                if (DEBUG_MODE) {
                  console.log(`[Staging] Using previous ${imageSource}`);
                }
              } else {
                if (DEBUG_MODE) {
                  console.log(`[Staging] Previous image found but base64 data extraction failed`);
                }
              }
            } else {
              if (DEBUG_MODE) {
                console.log(`[Staging] Previous image at index ${imageIndex} not found`);
              }
              // Fallback: try to use the most recent image (index 0) if requested index doesn't exist
              if (imageIndex > 0) {
                if (DEBUG_MODE) {
                  console.log(`[Staging] Attempting fallback to index 0`);
                }
                const fallbackImage = getImageFromHistory(conversationHistory, 0);
                if (fallbackImage && fallbackImage.url) {
                  const base64Data = fallbackImage.url.split(',')[1];
                  if (base64Data) {
                    imageBuffer = Buffer.from(base64Data, 'base64');
                    imageSource = fallbackImage.isStaged ? `staged image (fallback to index 0)` : `user-uploaded image (fallback to index 0)`;
                    if (DEBUG_MODE) {
                      console.log(`[Staging] Using fallback ${imageSource}`);
                    }
                  }
                }
              }
            }
          } else if (firstImageFile && !userWantsToAddFurnitureToRoom(message)) {
            // Use current message's image as the room (initial staging — not a furniture reference upload)
            imageBuffer = firstImageFile.buffer;
            imageSource = 'current message';
            if (DEBUG_MODE) {
              console.log(`[Staging] Using image from current message`);
            }
          }
          
          // Retrieve furniture image if specified (skip if dual upload already set furniture buffers)
          if (!dualUploadStaging && !furnitureImageBuffer && stagingParams.furnitureImageIndex !== null && stagingParams.furnitureImageIndex !== undefined) {
            const furnitureIndex = typeof stagingParams.furnitureImageIndex === 'number' ? stagingParams.furnitureImageIndex : null;
            if (furnitureIndex !== null) {
              if (DEBUG_MODE) {
                console.log(`[Staging] Looking for furniture image at index ${furnitureIndex}`);
              }
              const furnitureImage = getImageFromHistory(conversationHistory, furnitureIndex);
              
              if (furnitureImage && furnitureImage.url) {
                const base64Data = furnitureImage.url.split(',')[1];
                if (base64Data) {
                  furnitureImageBuffer = Buffer.from(base64Data, 'base64');
                  console.log(`[Staging] Found furniture image at index ${furnitureIndex}`);
                }
              } else {
                console.log(`[Staging] Furniture image at index ${furnitureIndex} not found`);
              }
            }
          }
          
            if (imageBuffer) {
              try {
                const geminiModel = getGeminiImageModel(selectedModel);
                const stagedImage = await processStaging(imageBuffer, stagingParams, req, furnitureImageBuffer, geminiModel);
                if (stagedImage) {
                  // Increment prompt count for staging
                  incPromptCount();
                  
                  // Annotate staged image in parallel
                  const annotationPromise = annotateImage(stagedImage).then(annotation => {
                    if (DEBUG_MODE) {
                      console.log(`[Image Annotation] Annotation for staged image ${i + 1}: ${annotation || 'failed'}`);
                    }
                    return annotation;
                  }).catch(err => {
                    console.error(`[Image Annotation] Error annotating staged image ${i + 1}:`, err);
                    return null;
                  });
                  
                  stagingResults.push({
                    stagedImage: stagedImage,
                    params: stagingParams,
                    annotationPromise: annotationPromise
                  });
                  if (DEBUG_MODE) {
                    console.log(`[Staging] Successfully processed staging ${i + 1}/${stagingRequests.length} for user ${userId} from ${imageSource}${furnitureImageBuffer ? ' with furniture image' : ''}`);
                  }
                }
              } catch (stagingError) {
                console.error(`[Staging] Error processing staging ${i + 1}:`, stagingError);
                console.error(`[Staging] Error stack:`, stagingError.stack);
                // Continue with other staging requests if one fails
                if (stagingRequests.length === 1) {
                  text = (text || '') + '\n\nSorry, I encountered an error while staging the room. Please try again.';
                }
              }
            } else {
              console.log(`[Staging] No image found for staging ${i + 1}`);
              if (stagingRequests.length === 1) {
                text = (text || '') + '\n\nSorry, I couldn\'t find the image to stage. Please make sure you\'ve uploaded an image.';
              }
            }
          } catch (error) {
            console.error(`[Staging] Error in staging request ${i + 1}:`, error);
            console.error(`[Staging] Error stack:`, error.stack);
            // Continue with other staging requests if one fails
            if (stagingRequests.length === 1) {
              text = (text || '') + '\n\nSorry, I encountered an error while processing the staging request. Please try again.';
            }
          }
          }
        }
      }
    }

    // Process image generation request(s) from AI response (supports single or array)
    let generatedImages = [];
    
    if (generateRequestFromAI) {
      // Normalize to array (max 3)
      const generateRequests = Array.isArray(generateRequestFromAI) 
        ? generateRequestFromAI.slice(0, 3).filter(g => g.shouldGenerate && g.prompt)
        : (generateRequestFromAI.shouldGenerate && generateRequestFromAI.prompt ? [generateRequestFromAI] : []);
      
      if (generateRequests.length > 0) {
        console.log(`[Image Generation] Processing ${generateRequests.length} generation request(s) from AI`);
        
        for (let i = 0; i < generateRequests.length; i++) {
          const genRequest = generateRequests[i];
          try {
            console.log(`[Image Generation] Processing generation request ${i + 1}/${generateRequests.length}:`, genRequest.prompt.substring(0, 100) + '...');
            const geminiModel = getGeminiImageModel(selectedModel);
            const generatedImage = await processImageGeneration(genRequest.prompt, req, geminiModel);
            if (generatedImage) {
              // Annotate generated image in parallel
              const annotationPromise = annotateImage(generatedImage).then(annotation => {
                if (DEBUG_MODE) {
                  console.log(`[Image Annotation] Annotation for generated image ${i + 1}: ${annotation || 'failed'}`);
                }
                return annotation;
              }).catch(err => {
                console.error(`[Image Annotation] Error annotating generated image ${i + 1}:`, err);
                return null;
              });
              
              generatedImages.push({
                image: generatedImage,
                annotationPromise: annotationPromise
              });
              console.log(`[Image Generation] Successfully generated image ${i + 1}/${generateRequests.length}`);
            }
          } catch (error) {
            console.error(`[Image Generation] Error generating image ${i + 1}:`, error);
            // Continue with other images if one fails
          }
        }
        
        if (generateRequests.length > 0 && generatedImages.length === 0) {
          text = text + '\n\nSorry, I encountered an error while generating the images. Please try again.';
        }
      }
    }

    // Process recall request from AI response (simpler than imageRequest - just retrieves and displays)
    let recalledImageForDisplay = null;
    if (recallRequestFromAI && recallRequestFromAI.shouldRecall) {
      try {
        const imageIndex = typeof recallRequestFromAI.imageIndex === 'number' ? recallRequestFromAI.imageIndex : 0;
        console.log(`[Recall] Processing recall request from AI, index: ${imageIndex}`);
        
        // Retrieve the image from conversation history
        const recalledImage = getImageFromHistory(conversationHistory, imageIndex);
        
        if (recalledImage && recalledImage.url) {
          console.log(`[Recall] Found image at index ${imageIndex}`);
          recalledImageForDisplay = recalledImage.url;
        } else {
          console.log(`[Recall] Image at index ${imageIndex} not found`);
        }
      } catch (error) {
        console.error('Error processing recall request:', error);
        // Continue with original response if recall fails
      }
    }

    // Process image request from AI response
    let requestedImageForDisplay = null;
    if (imageRequestFromAI && imageRequestFromAI.requestImage) {
      try {
        const imageIndex = typeof imageRequestFromAI.imageIndex === 'number' ? imageRequestFromAI.imageIndex : 0;
        console.log(`[Image Request] Processing image request from AI, index: ${imageIndex}`);
        
        // Retrieve the image from conversation history
        const requestedImage = getImageFromHistory(conversationHistory, imageIndex);
        
        if (requestedImage && requestedImage.url) {
          console.log(`[Image Request] Found image at index ${imageIndex}`);
          
          // Store the image URL to return in response for display
          requestedImageForDisplay = requestedImage.url;
          
          // Check if user wants to analyze/describe the image (vs just view it)
          // Only analyze if explicitly asking for description/analysis, not just "show me"
          const messageLower = (message || '').toLowerCase();
          const wantsAnalysis = (messageLower.includes('describe') && !messageLower.includes('show')) || 
                               (messageLower.includes('analyze') && !messageLower.includes('show')) || 
                               (messageLower.includes('what') && messageLower.includes('in') && !messageLower.includes('show')) ||
                               messageLower.includes('tell me about') ||
                               (messageLower.includes('explain') && !messageLower.includes('show'));
          
          if (wantsAnalysis) {
            console.log(`[Image Request] User wants analysis, sending to GPT`);
            // Build messages for image analysis (include conversation history context)
            const imageAnalysisMessages = [
              { role: 'system', content: systemInstruction },
              ...safeMessages.slice(1), // Skip the original system message, keep the rest
              {
                role: 'user',
                content: [
                  { type: 'text', text: message || 'Please analyze this image.' },
                  {
                    type: 'image_url',
                    image_url: {
                      url: await downscaleImageForGPT(requestedImage.url)
                    }
                  }
                ]
              }
            ];
            
            const imageAnalysisCompletion = await openai.chat.completions.create({
              model: selectedModel,
              messages: imageAnalysisMessages,
              temperature: getTemperatureForModel(selectedModel),
              response_format: DESIGNER_ROUTING_RESPONSE_FORMAT
            });
            
            const imageAnalysisJson = parseDesignerRoutingCompletion(imageAnalysisCompletion);
            text = imageAnalysisJson.response || imageAnalysisCompletion.choices[0].message.content;
            
            console.log(`[Image Request] Successfully analyzed image, response: ${text.substring(0, 100)}...`);
          } else {
            // User just wants to see the image - keep the original text response
            console.log(`[Image Request] User wants to view image, returning image for display`);
          }
        } else {
          console.log(`[Image Request] Image at index ${imageIndex} not found`);
        }
      } catch (error) {
        console.error('Error processing image request:', error);
        // Continue with original response if image request fails
      }
    }

    // Process CAD request(s) from AI response (supports single or array)
    let cadResultsUpload = [];
    
    if (cadRequestFromAI) {
      // Normalize to array (max 3)
      const cadRequests = Array.isArray(cadRequestFromAI)
        ? cadRequestFromAI.slice(0, 3).filter(c => c.shouldProcessCAD)
        : (cadRequestFromAI.shouldProcessCAD ? [cadRequestFromAI] : []);
      
      if (cadRequests.length > 0) {
        if (DEBUG_MODE) {
          console.log(`[CAD] Processing ${cadRequests.length} CAD request(s) from AI`);
        }
        
        for (let i = 0; i < cadRequests.length; i++) {
          const cadRequest = cadRequests[i];
          if (DEBUG_MODE) {
            console.log(`[CAD] Processing CAD request ${i + 1}/${cadRequests.length}:`, cadRequest);
          }
          
          try {
            const imageIndex = resolveCadImageIndex(
              cadRequest,
              baseImageIndexUpload,
              conversationHistory,
              currentMessageHasImage
            );
            if (DEBUG_MODE) {
              console.log(`[CAD] Processing CAD request from AI, index: ${imageIndex}`);
            }
            
            // Retrieve the blueprint image from conversation history
            const blueprintImage = getImageFromHistory(conversationHistory, imageIndex);
            
            if (blueprintImage && blueprintImage.url) {
              if (DEBUG_MODE) {
                console.log(`[CAD] Found blueprint image at index ${imageIndex}`);
              }
              
              // Extract base64 data from the image URL
              const base64Data = blueprintImage.url.split(',')[1];
              if (base64Data) {
                const imageBuffer = Buffer.from(base64Data, 'base64');
                const mimeType = blueprintImage.url.match(/data:([^;]+)/)?.[1] || 'image/png';
                
                // Retrieve furniture images if specified
                const furnitureImages = [];
                if (cadRequest.furnitureImageIndex !== null && cadRequest.furnitureImageIndex !== undefined) {
                  const furnitureIndices = Array.isArray(cadRequest.furnitureImageIndex) 
                    ? cadRequest.furnitureImageIndex 
                    : [cadRequest.furnitureImageIndex];
                  
                  for (const furnitureIndex of furnitureIndices) {
                    if (furnitureIndex !== null && furnitureIndex !== undefined) {
                      const furnitureImage = getImageFromHistory(conversationHistory, furnitureIndex);
                      if (furnitureImage && furnitureImage.url) {
                        const furnitureBase64Data = furnitureImage.url.split(',')[1];
                        if (furnitureBase64Data) {
                          const furnitureBuffer = Buffer.from(furnitureBase64Data, 'base64');
                          const furnitureMimeType = furnitureImage.url.match(/data:([^;]+)/)?.[1] || 'image/png';
                          furnitureImages.push({
                            image: furnitureBuffer,
                            mimeType: furnitureMimeType
                          });
                          if (DEBUG_MODE) {
                            console.log(`[CAD] Found furniture image at index ${furnitureIndex}`);
                          }
                    }
                  } else {
                    if (DEBUG_MODE) {
                      console.log(`[CAD] Furniture image at index ${furnitureIndex} not found`);
                    }
                  }
                }
              }
            }
            
                if (DEBUG_MODE) {
                  console.log(`[CAD] Processing blueprint with CAD function${furnitureImages.length > 0 ? ` (with ${furnitureImages.length} furniture image(s))` : ''}${cadRequest.additionalPrompt ? ` (with additional prompt: ${cadRequest.additionalPrompt.substring(0, 50)}...)` : ''}...`);
                }
                // Process the blueprint through CAD function
                const additionalPrompt = cadRequest.additionalPrompt || null;
                const cadResultBuffer = await blueprintTo3D(imageBuffer, mimeType, furnitureImages, additionalPrompt);
                
                // Convert result buffer to data URL
                const cadImageBase64 = cadResultBuffer.toString('base64');
                const cadImageForDisplay = `data:${mimeType};base64,${cadImageBase64}`;
                
                // Annotate CAD image in parallel
                const annotationPromise = annotateImage(cadImageForDisplay, true).then(annotation => {
                  if (DEBUG_MODE) {
                    console.log(`[Image Annotation] Annotation for CAD render ${i + 1}: ${annotation || 'failed'}`);
                  }
                  return annotation;
                }).catch(err => {
                  console.error(`[Image Annotation] Error annotating CAD render ${i + 1}:`, err);
                  return null;
                });
                
                cadResultsUpload.push({
                  cadImage: cadImageForDisplay,
                  params: cadRequest,
                  annotationPromise: annotationPromise
                });
                
                if (DEBUG_MODE) {
                  console.log(`[CAD] Successfully generated 3D render ${i + 1}/${cadRequests.length} from blueprint${furnitureImages.length > 0 ? ' with furniture' : ''}`);
                }
              } else {
                if (DEBUG_MODE) {
                  console.log(`[CAD] Failed to extract base64 data from blueprint image`);
                }
              }
            } else {
              if (DEBUG_MODE) {
                console.log(`[CAD] Blueprint image at index ${imageIndex} not found`);
              }
            }
          } catch (error) {
            if (DEBUG_MODE) {
              console.error(`[CAD] Error processing CAD request ${i + 1}:`, error);
            }
            // Continue with other CAD requests if one fails
            if (cadRequests.length === 1) {
              text = (text || '') + '\n\nSorry, I encountered an error while processing the CAD blueprint. Please try again.';
            }
          }
        }
      }
    }
    
    // Legacy support: maintain cadImageForDisplay and cadAnnotationPromiseUpload for backward compatibility
    let cadImageForDisplay = null;
    let cadAnnotationPromiseUpload = null;
    if (cadResultsUpload.length > 0) {
      cadImageForDisplay = cadResultsUpload[0].cadImage;
      cadAnnotationPromiseUpload = cadResultsUpload[0].annotationPromise;
    }

    // Wait for all annotations to complete before building response
    const stagedImageAnnotationsUpload = {};
    if (stagingResults.length > 0) {
      for (let i = 0; i < stagingResults.length; i++) {
        if (stagingResults[i].annotationPromise) {
          const annotation = await stagingResults[i].annotationPromise;
          if (annotation) {
            stagedImageAnnotationsUpload[`staged_${i}`] = annotation;
          }
        }
      }
    }
    
    const generatedImageAnnotationsUpload = {};
    if (generatedImages.length > 0) {
      for (let i = 0; i < generatedImages.length; i++) {
        if (generatedImages[i].annotationPromise) {
          const annotation = await generatedImages[i].annotationPromise;
          if (annotation) {
            generatedImageAnnotationsUpload[`generated_${i}`] = annotation;
          }
        }
      }
    }
    
    // Wait for all CAD annotations to complete
    const cadImageAnnotationsUpload = {};
    if (cadResultsUpload.length > 0) {
      for (let i = 0; i < cadResultsUpload.length; i++) {
        if (cadResultsUpload[i].annotationPromise) {
          const annotation = await cadResultsUpload[i].annotationPromise;
          if (annotation) {
            cadImageAnnotationsUpload[`cad_${i}`] = annotation;
          }
        }
      }
    }
    
    // Legacy support
    let cadImageAnnotationUpload = null;
    if (cadImageForDisplay && cadAnnotationPromiseUpload) {
      cadImageAnnotationUpload = await cadAnnotationPromiseUpload;
    }

    // Extract image annotations from cleanedUserContent to return to frontend
    // Note: We use _annotation (private property) which is not sent to OpenAI
    const imageAnnotations = {};
    cleanedUserContent.forEach((item, idx) => {
      if (item.type === 'image_url' && item._annotation) {
        const filename = item._filename || (filteredUserContent[idx] && (filteredUserContent[idx].filename || filteredUserContent[idx].originalname));
        if (filename) {
          imageAnnotations[filename] = item._annotation;
        }
      }
    });
    
    // Return JSON response with text, memory actions, staging result(s), generated image(s), requested image, recalled image, and annotations if available
    const response = { 
      response: text,
      files: fileInfo,
      memories: memoryActions
    };
    
    // Handle multiple staging results
    if (stagingResults.length > 0) {
      if (stagingResults.length === 1) {
        // Single result - maintain backward compatibility
        response.stagedImage = stagingResults[0].stagedImage;
        response.stagingParams = stagingResults[0].params;
      } else {
        // Multiple results - return as array
        response.stagedImages = stagingResults.map(r => r.stagedImage);
        response.stagingParams = stagingResults.map(r => r.params);
      }
      // Include annotations if available
      if (Object.keys(stagedImageAnnotationsUpload).length > 0) {
        response.stagedImageAnnotations = stagedImageAnnotationsUpload;
      }
    }
    
    // Handle multiple generated images
    if (generatedImages.length > 0) {
      if (generatedImages.length === 1) {
        // Single result - maintain backward compatibility
        response.generatedImage = generatedImages[0].image || generatedImages[0];
      } else {
        // Multiple results - return as array
        response.generatedImages = generatedImages.map(g => g.image || g);
      }
      // Include annotations if available
      if (Object.keys(generatedImageAnnotationsUpload).length > 0) {
        response.generatedImageAnnotations = generatedImageAnnotationsUpload;
      }
    }
    
    if (requestedImageForDisplay) {
      response.requestedImage = requestedImageForDisplay;
    }
    
    if (recalledImageForDisplay) {
      response.recalledImage = recalledImageForDisplay;
    }
    
    // Handle multiple CAD results
    if (cadResultsUpload.length > 0) {
      if (cadResultsUpload.length === 1) {
        // Single result - maintain backward compatibility
        response.cadImage = cadResultsUpload[0].cadImage;
        if (cadImageAnnotationUpload) {
          response.cadImageAnnotation = cadImageAnnotationUpload;
        }
      } else {
        // Multiple results - return as array
        response.cadImages = cadResultsUpload.map(r => r.cadImage);
        response.cadParams = cadResultsUpload.map(r => r.params);
      }
      // Include annotations if available
      if (Object.keys(cadImageAnnotationsUpload).length > 0) {
        response.cadImageAnnotations = cadImageAnnotationsUpload;
      }
    }
    
    if (Object.keys(imageAnnotations).length > 0) {
      response.imageAnnotations = imageAnnotations;
    }
    
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
