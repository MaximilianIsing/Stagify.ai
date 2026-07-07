// Pre-routing preparation for the /api/chat-upload endpoint: turn the multipart
// upload into GPT-ready messages and run the routing completion. Extracted
// verbatim from the handler (byte-exact slices; only wrapped in functions).
import path from 'path';
import { DESIGNER_ROUTING_RESPONSE_FORMAT } from './prompts.js';

export default function createUploadPrep(deps) {
  const {
    DEBUG_MODE,
    openai,
    annotateImage,
    downscaleImageForGPT,
    getTemperatureForModel,
    parseDesignerRoutingCompletion,
    filterUnsupportedFiles,
    filterConversationHistory,
    stripImagesFromHistory,
  } = deps;

  // Validate/annotate each uploaded file and build the user-message content
  // array. Returns { userContent, fileInfo, hasImages, firstImageFile, unsupportedFiles }.
  function buildUploadUserContent({ files, message, messageTag }) {
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
        let fileContent; // set by both branches below
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
    return { userContent, fileInfo, hasImages, firstImageFile, unsupportedFiles };
  }

  // Filter + strip conversation history, await image annotations/downscaling,
  // and assemble the OpenAI messages array (system + history + current upload).
  // Returns { filteredUserContent, safeMessages, cleanedUserContent }.
  async function buildUploadMessages({ systemInstruction, userContent, files, conversationHistory }) {
    // MIDDLEMAN CHECK: Filter unsupported files from userContent before sending to OpenAI
    const { filteredContent: filteredUserContent } = filterUnsupportedFiles(userContent, files);
    
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
    return { filteredUserContent, safeMessages, cleanedUserContent };
  }

  // DEBUG-only: log the outgoing payload size and per-message summaries.
  function logUploadPayload({ safeMessages, selectedModel, hasImages }) {
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
  }

  // Call OpenAI for the routing decision, with a fallback pass that lets the AI
  // respond about unsupported/invalid image formats. Returns the parsed routing
  // fields. Re-throws non-image errors to the caller's outer handler.
  async function runUploadRouting({ safeMessages, selectedModel, message, unsupportedFiles, conversationHistory, systemInstruction }) {
    // These are assigned on every path that returns (the try's success path sets
    // all of them; the catch's image-error path sets all except cadRequestFromAI,
    // and its non-image path re-throws). cadRequestFromAI keeps a null default
    // because the catch path intentionally leaves it unset.
    let text;
    let aiResponseJson;
    let memoryActionsFromAI;
    let stagingRequestFromAI;
    let imageRequestFromAI;
    let recallRequestFromAI;
    let generateRequestFromAI;
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
    return { text, aiResponseJson, memoryActionsFromAI, stagingRequestFromAI, imageRequestFromAI, recallRequestFromAI, generateRequestFromAI, cadRequestFromAI };
  }

  return { buildUploadUserContent, buildUploadMessages, logUploadPayload, runUploadRouting };
}
