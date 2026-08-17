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
 * @param {{
 *   addMessage: (role: string, content: string, files?: File[] | null) => void,
 *   addErrorMessage: (text: string, onRetry?: () => void) => void,
 *   updateLastAssistantText: (text: string) => void,
 *   getLastAssistantContentEl: () => HTMLElement | null,
 *   showMessageImageLoading: (messageType: string) => void,
 *   removeMessageImageLoading: () => void,
 *   removeTypingIndicator: (id: string) => void,
 *   createAIImageWithDownload: (imageSrc: string, altText: string, imageType?: string, baseName?: string) => HTMLElement,
 *   syncImageThumbnailStrip: (options?: { preferNewest?: boolean }) => void,
 *   collectImagesFromConversationHistory: () => import('./types.js').AdImage[],
 *   getConversationHistory: () => import('./types.js').AdHistoryEntry[],
 *   getPendingStagingRootBaseName: () => string | null,
 *   setPendingStagingRootBaseName: (v: string | null) => void,
 * }} deps - The chat-message, image-viewer and thumbnail-strip island APIs,
 *   plus accessors for the two pieces of entry-owned state this needs: the live
 *   conversation history (read through a getter because the entry REASSIGNS it
 *   on reset) and the pending staging base name.
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

    // STAGED / GENERATED / CAD ARE NOT MUTUALLY EXCLUSIVE — do not turn these back into
    // an `else if` ladder. lib/chat/chat-post-routing.js runs the staging, generate and
    // CAD steps UNCONDITIONALLY, so one turn can carry all three. As a ladder, a turn
    // that staged a room AND rendered a floor plan silently dropped the floor plan from
    // both the transcript and the history the next turn is built from — the render was
    // paid for, produced, and thrown away in the browser.
    //
    // What the ladder DID get right, and what the shape below preserves: the assistant's
    // text bubble is added exactly once, and exactly one history entry is pushed, with
    // every image from the turn in it.
    const stagedImages = data.stagedImages || (data.stagedImage ? [data.stagedImage] : []);
    const generatedImages = data.generatedImages || (data.generatedImage ? [data.generatedImage] : []);
    const cadImages = data.cadImages || (data.cadImage ? [data.cadImage] : []);
    const newImageCount = stagedImages.length + generatedImages.length + cadImages.length;

    if (newImageCount > 0) {
      addedAssistantImages = true;
      const rootBaseName = getPendingStagingRootBaseName() || 'Upload';
      setPendingStagingRootBaseName(null);
      const priorStagedCount = collectImagesFromConversationHistory()
        .filter((img) => img.isStaged && img.rootBaseName === rootBaseName).length;
      if (!imagesOnly) {
        addMessage('assistant', data.response);
      }

      // Appended in the order the pipeline produced them.
      const lastMessage = getLastAssistantContentEl();
      if (lastMessage) {
        const appendImage = (url, alt, downloadName, baseName) => {
          const wrapper = document.createElement('div');
          wrapper.style.cssText = 'margin-top: 12px; text-align: left;';
          wrapper.appendChild(createAIImageWithDownload(url, alt, downloadName, baseName));
          lastMessage.appendChild(wrapper);
        };
        stagedImages.forEach((stagedImage, index) => {
          appendImage(
            stagedImage,
            getPdfAlt('stagedRoom', { suffix: imageCountSuffix(index, stagedImages.length) }),
            `staged-${index + 1}`,
            rootBaseName
          );
        });
        generatedImages.forEach((generatedImage, index) => {
          appendImage(
            generatedImage,
            getPdfAlt('generatedImage', { suffix: imageCountSuffix(index, generatedImages.length) }),
            `generated-image-${index}`
          );
        });
        // Alt text follows the VIEW. "3D render from floor plan" is right for a top-down
        // plan render and wrong for an eye-level one, which is a photograph of a room —
        // and alt text is read by people who cannot see which of the two they got.
        const cadViews = data.cadViews || [];
        cadImages.forEach((cadImage, index) => {
          const altKey = cadViews[index] === 'eye-level' ? 'cadRenderInterior' : 'cadRender';
          appendImage(
            cadImage,
            getPdfAlt(altKey, { suffix: imageCountSuffix(index, cadImages.length) }),
            `cad-render-${index}`
          );
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
      // The single-result server response carries `cadImageAnnotation` (singular) for
      // backward compatibility; the multi-result one carries the `cad_N` map.
      const cadAnnotation = data.cadImageAnnotation || null;
      const cadAnnotations = data.cadImageAnnotations || {};
      cadImages.forEach((cadImage, index) => {
        contentItems.push({
          type: 'image_url',
          image_url: { url: cadImage },
          isGenerated: true,
          _annotation: cadImages.length === 1
            ? (cadAnnotation || cadAnnotations.cad_0 || null)
            : (cadAnnotations[`cad_${index}`] || null),
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
