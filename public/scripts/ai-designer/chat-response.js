import { consumeChatSse } from './chat-sse-client.js';
import { lang, getPdfAlt } from './i18n.js';
import { imageCountSuffix } from './format.js';

/**
 * Turns the server's chat reply — streamed SSE or a plain JSON body — into chat
 * messages, conversation-history entries and image cards (staged / generated /
 * CAD / recalled / requested). Extracted from ai-designer-app.js. The live
 * conversation history is read through a getter (the entry reassigns it on
 * reset); the pending staging base-name via getter/setter. Chat-message,
 * image-viewer and thumbnail-strip island functions are injected.
 *
 * @param {any} deps
 * @returns {{ handleChatFetchResponse: (response: Response, typingId: string, messageType: string, onRetry: () => void) => Promise<void> }}
 */
export function createChatResponse(deps) {
  const {
    addMessage, addErrorMessage, updateLastAssistantText, getLastAssistantContentEl,
    showMessageImageLoading, removeMessageImageLoading, removeTypingIndicator,
    createAIImageWithDownload, syncImageThumbnailStrip, collectImagesFromConversationHistory,
    getConversationHistory, getPendingStagingRootBaseName, setPendingStagingRootBaseName,
  } = deps;

  async function handleChatFetchResponse(response, typingId, messageType, onRetry) {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream')) {
      let streamedText = '';
      // The server tells us the real intent (generating/staging/analyzing)
      // once it decides — use it for the slow image phase instead of the tag.
      let resolvedType = messageType;
      await consumeChatSse(response, {
        onStatus(payload) {
          if (payload && payload.type) resolvedType = payload.type;
        },
        onMessage(payload) {
          removeTypingIndicator(typingId);
          streamedText = payload.response || '';
          addMessage('assistant', streamedText);
          showMessageImageLoading(resolvedType);
        },
        onImages(payload) {
          removeMessageImageLoading();
          processAssistantChatData(
            { ...payload, response: payload.response || streamedText },
            typingId,
            { imagesOnly: true }
          );
        },
        onError() {
          removeTypingIndicator(typingId);
          removeMessageImageLoading();
          addErrorMessage(lang('pdf.error.generic', 'Sorry, I encountered an error. Please try again.'), onRetry);
        },
      });
      return;
    }
    const data = await response.json();
    removeTypingIndicator(typingId);
    processAssistantChatData(data, typingId);
  }

  function processAssistantChatData(data, typingId, options) {
    const imagesOnly = options && options.imagesOnly === true;
    let addedAssistantImages = false;

    if (data.error) {
      if (!imagesOnly) {
        addMessage('assistant', 'Sorry, I encountered an error: ' + data.error);
      }
      return;
    }
    if (data.contextLimitReached) {
      if (!imagesOnly) {
        addMessage('assistant', data.response);
      }
      return;
    }

    if (imagesOnly && data.response) {
      updateLastAssistantText(data.response);
    }

    if (data.imageAnnotations && Object.keys(data.imageAnnotations).length > 0) {
      for (let i = getConversationHistory().length - 1; i >= 0; i--) {
        const msg = getConversationHistory()[i];
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          msg.content.forEach(item => {
            if (item.type === 'image_url') {
              const filename = item.filename;
              if (filename && data.imageAnnotations[filename]) {
                item.annotation = data.imageAnnotations[filename];
              } else {
                const matchingKey = Object.keys(data.imageAnnotations).find(key =>
                  filename && (filename.includes(key) || key.includes(filename))
                );
                if (matchingKey) {
                  item.annotation = data.imageAnnotations[matchingKey];
                }
              }
            }
          });
          break;
        }
      }
    }

    const stagedImages = data.stagedImages || (data.stagedImage ? [data.stagedImage] : []);
    if (stagedImages.length > 0) {
      addedAssistantImages = true;
      const rootBaseName = getPendingStagingRootBaseName() || 'Upload';
      setPendingStagingRootBaseName(null);
      const priorStagedCount = collectImagesFromConversationHistory()
        .filter((img) => img.isStaged && img.rootBaseName === rootBaseName).length;
      if (!imagesOnly) {
        addMessage('assistant', data.response);
      }
      const lastMessage = getLastAssistantContentEl();
      if (lastMessage) {
        stagedImages.forEach((stagedImage, index) => {
          const stagedImageDiv = document.createElement('div');
          stagedImageDiv.style.cssText = 'margin-top: 12px; text-align: left;';
          const imageContainer = createAIImageWithDownload(
            stagedImage,
            getPdfAlt('stagedRoom', { suffix: imageCountSuffix(index, stagedImages.length) }),
            `staged-${index + 1}`,
            rootBaseName
          );
          stagedImageDiv.appendChild(imageContainer);
          lastMessage.appendChild(stagedImageDiv);
        });
      }
      /** @type {Array<Record<string, any>>} */
      const contentItems = [{ type: 'text', text: data.response }];
      stagedImages.forEach((stagedImage, index) => {
        const annotationKey = stagedImages.length === 1 ? 'staged_0' : `staged_${index}`;
        const annotation = data.stagedImageAnnotations && data.stagedImageAnnotations[annotationKey]
          ? data.stagedImageAnnotations[annotationKey]
          : null;
        contentItems.push({
          type: 'image_url',
          image_url: { url: stagedImage },
          isStaged: true,
          rootBaseName,
          stagedNumber: priorStagedCount + index + 1,
          _annotation: annotation,
        });
      });
      const assistantMessage = { role: 'assistant', content: contentItems };
      const lastMsg = getConversationHistory()[getConversationHistory().length - 1];
      const isDuplicate = lastMsg &&
        lastMsg.role === 'assistant' &&
        JSON.stringify(lastMsg.content) === JSON.stringify(assistantMessage.content);
      if (!isDuplicate) {
        getConversationHistory().push(assistantMessage);
      }
    } else if (data.generatedImages || data.generatedImage) {
      const generatedImages = data.generatedImages || (data.generatedImage ? [data.generatedImage] : []);
      addedAssistantImages = true;
      if (!imagesOnly) {
        addMessage('assistant', data.response);
      }
      const lastMessage = getLastAssistantContentEl();
      if (lastMessage) {
        generatedImages.forEach((generatedImage, index) => {
          const generatedImageDiv = document.createElement('div');
          generatedImageDiv.style.cssText = 'margin-top: 12px; text-align: left;';
          const imageContainer = createAIImageWithDownload(
            generatedImage,
            getPdfAlt('generatedImage', { suffix: imageCountSuffix(index, generatedImages.length) }),
            `generated-image-${index}`
          );
          generatedImageDiv.appendChild(imageContainer);
          lastMessage.appendChild(generatedImageDiv);
        });
      }
      /** @type {Array<Record<string, any>>} */
      const contentItems = [{ type: 'text', text: data.response }];
      generatedImages.forEach((generatedImage, index) => {
        const annotationKey = generatedImages.length === 1 ? 'generated_0' : `generated_${index}`;
        const annotation = data.generatedImageAnnotations && data.generatedImageAnnotations[annotationKey]
          ? data.generatedImageAnnotations[annotationKey]
          : null;
        contentItems.push({
          type: 'image_url',
          image_url: { url: generatedImage },
          isGenerated: true,
          _annotation: annotation,
        });
      });
      const assistantMessage = { role: 'assistant', content: contentItems };
      const lastMsg = getConversationHistory()[getConversationHistory().length - 1];
      const isDuplicate = lastMsg &&
        lastMsg.role === 'assistant' &&
        JSON.stringify(lastMsg.content) === JSON.stringify(assistantMessage.content);
      if (!isDuplicate) {
        getConversationHistory().push(assistantMessage);
      }
    } else if (data.cadImage || (data.cadImages && data.cadImages.length > 0)) {
      addedAssistantImages = true;
      if (!imagesOnly) {
        addMessage('assistant', data.response);
      }
      const cadImages = data.cadImages || (data.cadImage ? [data.cadImage] : []);
      if (cadImages.length > 0) {
        const lastMessage = getLastAssistantContentEl();
        if (lastMessage) {
          cadImages.forEach((cadImage, index) => {
            const cadImageDiv = document.createElement('div');
            cadImageDiv.style.cssText = 'margin-top: 12px; text-align: left;';
            const imageContainer = createAIImageWithDownload(
              cadImage,
              getPdfAlt('cadRender', { suffix: imageCountSuffix(index, cadImages.length) }),
              `cad-render-${index}`
            );
            cadImageDiv.appendChild(imageContainer);
            lastMessage.appendChild(cadImageDiv);
          });
        }
        const cadAnnotation = data.cadImageAnnotation || null;
        const cadAnnotations = data.cadImageAnnotations || {};
        const cadAssistantMessage = {
          role: 'assistant',
          content: [
            { type: 'text', text: data.response },
            ...cadImages.map((cadImage, index) => ({
              type: 'image_url',
              image_url: { url: cadImage },
              isGenerated: true,
              _annotation: cadImages.length === 1 ? cadAnnotation : (cadAnnotations[`cad_${index}`] || null),
            })),
          ],
        };
        const lastMsg2 = getConversationHistory()[getConversationHistory().length - 1];
        const isDuplicate2 = lastMsg2 &&
          lastMsg2.role === 'assistant' &&
          JSON.stringify(lastMsg2.content) === JSON.stringify(cadAssistantMessage.content);
        if (!isDuplicate2) {
          getConversationHistory().push(cadAssistantMessage);
        }
      }
    } else if (data.recalledImage) {
      addedAssistantImages = true;
      if (!imagesOnly) {
        addMessage('assistant', data.response);
      }
      const lastMessage = getLastAssistantContentEl();
      if (lastMessage) {
        const recalledImageDiv = document.createElement('div');
        recalledImageDiv.style.cssText = 'margin-top: 12px; text-align: left;';
        const imageContainer = createAIImageWithDownload(data.recalledImage, getPdfAlt('recalledImage'), 'recalled-image');
        recalledImageDiv.appendChild(imageContainer);
        lastMessage.appendChild(recalledImageDiv);
      }
      const assistantMessage = { role: 'assistant', content: data.response };
      const lastMsg = getConversationHistory()[getConversationHistory().length - 1];
      const isDuplicate = lastMsg &&
        lastMsg.role === 'assistant' &&
        JSON.stringify(lastMsg.content) === JSON.stringify(assistantMessage.content);
      if (!isDuplicate) {
        getConversationHistory().push(assistantMessage);
      }
    } else if (data.requestedImage) {
      addedAssistantImages = true;
      if (!imagesOnly) {
        addMessage('assistant', data.response);
      }
      const lastMessage = getLastAssistantContentEl();
      if (lastMessage) {
        const requestedImageDiv = document.createElement('div');
        requestedImageDiv.style.cssText = 'margin-top: 12px; text-align: left;';
        const imageContainer = createAIImageWithDownload(data.requestedImage, getPdfAlt('requestedImage'), 'requested-image');
        requestedImageDiv.appendChild(imageContainer);
        lastMessage.appendChild(requestedImageDiv);
      }
      const assistantMessage = { role: 'assistant', content: data.response };
      const lastMsg = getConversationHistory()[getConversationHistory().length - 1];
      const isDuplicate = lastMsg &&
        lastMsg.role === 'assistant' &&
        JSON.stringify(lastMsg.content) === JSON.stringify(assistantMessage.content);
      if (!isDuplicate) {
        getConversationHistory().push(assistantMessage);
      }
    } else if (!imagesOnly) {
      addMessage('assistant', data.response);
      const assistantMessage = { role: 'assistant', content: data.response };
      const lastMsg = getConversationHistory()[getConversationHistory().length - 1];
      const isDuplicate = lastMsg &&
        lastMsg.role === 'assistant' &&
        JSON.stringify(lastMsg.content) === JSON.stringify(assistantMessage.content);
      if (!isDuplicate) {
        getConversationHistory().push(assistantMessage);
      }
    }

    syncImageThumbnailStrip({ preferNewest: addedAssistantImages });
    setPendingStagingRootBaseName(null);
  }

  return { handleChatFetchResponse };
}
