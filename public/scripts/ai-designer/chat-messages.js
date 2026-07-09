// Chat-message rendering island for the AI Designer chat.
//
// Message bubbles (user/assistant, attached-file previews), assistant-styled
// error bubbles with Retry, the typing indicator with rotating status text,
// and the in-message image-loading indicator. Lifted verbatim from the entry
// (scripts/ai-designer-app.js) as a factory. The rotating-status helpers
// (getTypingStatusMessages / attachRotatingStatusText / clearRotatingStatusText)
// stay internal — no external callers.
//
// deps: { chatMessages, openImageModal }  ->  returns { addMessage,
//         addErrorMessage, showTypingIndicator, removeTypingIndicator,
//         showMessageImageLoading, removeMessageImageLoading,
//         getLastAssistantContentEl, updateLastAssistantText }
// Window globals (LanguageSystem) are referenced directly.
import { formatMarkdown } from './format.js';
import { lang, getPdfAlt } from './i18n.js';

export function createChatMessages(deps) {
  const {
    chatMessages,
    openImageModal,
  } = deps;

      // Render an assistant-styled error bubble with an optional Retry button.
      function addErrorMessage(text, onRetry) {
        const emptyState = chatMessages.querySelector('.empty-state');
        if (emptyState) emptyState.remove();

        const messageDiv = document.createElement('div');
        messageDiv.className = 'message assistant';

        const avatar = document.createElement('div');
        avatar.className = 'message-avatar';
        const logoImg = document.createElement('img');
        logoImg.src = 'media-webp/logo/Logo64x64.webp';
        logoImg.alt = getPdfAlt('assistantAvatar');
        avatar.appendChild(logoImg);

        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        const textDiv = document.createElement('div');
        textDiv.textContent = text;
        contentDiv.appendChild(textDiv);

        if (typeof onRetry === 'function') {
          const retryBtn = document.createElement('button');
          retryBtn.type = 'button';
          retryBtn.className = 'chat-retry-btn';
          retryBtn.textContent = lang('pdf.retry', 'Retry');
          retryBtn.addEventListener('click', () => {
            messageDiv.remove();
            onRetry();
          });
          contentDiv.appendChild(retryBtn);
        }

        messageDiv.appendChild(avatar);
        messageDiv.appendChild(contentDiv);
        chatMessages.appendChild(messageDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }

      function getLastAssistantContentEl() {
        return document.querySelector('.message.assistant:last-child .message-content');
      }

      function updateLastAssistantText(text) {
        const content = getLastAssistantContentEl();
        if (!content || !text) return;
        const textDiv = content.querySelector(':scope > div:first-child');
        if (textDiv) {
          textDiv.innerHTML = formatMarkdown(text);
        }
      }

      function getTypingStatusMessages(messageType) {
        // Prefer the localized list for the current language; fall back to the
        // English defaults below if the key is missing or not yet loaded.
        const category = ['generating', 'staging', 'analyzing', 'welcome'].includes(messageType)
          ? messageType
          : 'general';
        if (window.LanguageSystem && window.LanguageSystem.isLoaded && window.LanguageSystem.isLoaded()) {
          const localized = window.LanguageSystem.getText('pdf.statusMessages.' + category, null);
          if (Array.isArray(localized) && localized.length) return localized;
        }
        if (messageType === 'generating') {
          return [
            'generating image...',
            'creating your image...',
            'bringing your vision to life...',
            'crafting the details...',
            'rendering...',
            'almost there...',
            'finalizing details...',
            'polishing the result...',
            'just a moment...',
          ];
        }
        if (messageType === 'staging') {
          return [
            'staging your room...',
            'adding furniture...',
            'selecting decor...',
            'arranging elements...',
            'applying styles...',
            'creating the design...',
            'generating the layout...',
            'refining details...',
            'almost ready...',
          ];
        }
        if (messageType === 'analyzing') {
          return [
            'analyzing image...',
            'examining details...',
            'identifying elements...',
            'processing visual data...',
            'understanding the space...',
            'reviewing composition...',
            'studying the layout...',
            'almost done...',
          ];
        }
        if (messageType === 'welcome') {
          return [
            'preparing your welcome...',
            'getting ready for you...',
            'setting things up...',
            'preparing a warm welcome...',
            'getting everything ready for you...',
            'almost ready to greet you...',
            'setting up your space...',
            'preparing something special...',
          ];
        }
        return [
          'thinking...',
          'processing your request...',
          'analyzing...',
          'considering options...',
          'working on it...',
          'almost there...',
          'just a moment...',
          'preparing response...',
        ];
      }

      function attachRotatingStatusText(element, messageType) {
        const messages = getTypingStatusMessages(messageType);
        let currentIndex = Math.floor(Math.random() * messages.length);
        element.textContent = messages[currentIndex];
        const messageInterval = setInterval(() => {
          let nextIndex;
          do {
            nextIndex = Math.floor(Math.random() * messages.length);
          } while (nextIndex === currentIndex && messages.length > 1);
          currentIndex = nextIndex;
          element.textContent = messages[currentIndex];
        }, 1500);
        element.dataset.intervalId = messageInterval;
        return messageInterval;
      }

      function clearRotatingStatusText(element) {
        if (element && element.dataset.intervalId) {
          clearInterval(parseInt(element.dataset.intervalId, 10));
          delete element.dataset.intervalId;
        }
      }

      function showMessageImageLoading(messageType) {
        removeMessageImageLoading();
        const content = getLastAssistantContentEl();
        if (!content) return;
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'message-image-loading typing-indicator';
        loadingDiv.id = 'message-image-loading';
        attachRotatingStatusText(loadingDiv, messageType);
        content.appendChild(loadingDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }

      function removeMessageImageLoading() {
        const el = document.getElementById('message-image-loading');
        if (el) {
          clearRotatingStatusText(el);
          el.remove();
        }
      }

      function addMessage(role, content, files = null) {
        // Remove empty state if present
        const emptyState = chatMessages.querySelector('.empty-state');
        if (emptyState) {
          emptyState.remove();
        }

        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${role}`;

        const avatar = document.createElement('div');
        avatar.className = 'message-avatar';
        if (role === 'user') {
          const userImg = document.createElement('img');
          userImg.src = 'media-webp/User.webp';
          userImg.alt = getPdfAlt('userAvatar');
          avatar.appendChild(userImg);
        } else {
          const logoImg = document.createElement('img');
          logoImg.src = 'media-webp/logo/Logo64x64.webp';
          logoImg.alt = getPdfAlt('assistantAvatar');
          avatar.appendChild(logoImg);
        }

        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';

        // Add text content with formatting
        const textDiv = document.createElement('div');
        if (role === 'assistant') {
          // Format markdown for AI messages
          textDiv.innerHTML = formatMarkdown(content);
        } else {
          textDiv.textContent = content;
        }
        contentDiv.appendChild(textDiv);

        // Add files if present
        if (files) {
          const filesArray = Array.isArray(files) ? files : [files];
          const imageFiles = filesArray.filter(f => f && f.name && f.type && f.type.startsWith('image/'));
          const nonImageFiles = filesArray.filter(f => f && f.name && (!f.type || !f.type.startsWith('image/')));

          // Create container for all files
          if (imageFiles.length > 0 || nonImageFiles.length > 0) {
            const filesContainer = document.createElement('div');
            filesContainer.className = 'message-files-container';
            // Add class for single image styling
            if (imageFiles.length === 1 && nonImageFiles.length === 0) {
              filesContainer.classList.add('single-image');
            }

            // Add image files in organized grid
            imageFiles.forEach(file => {
              const fileDiv = document.createElement('div');
              fileDiv.className = 'message-file';

              const img = document.createElement('img');
              const imageSrc = URL.createObjectURL(file);
              img.src = imageSrc;
              img.alt = getPdfAlt('uploadPreview', { filename: file.name });
              img.addEventListener('click', () => openImageModal(imageSrc, getPdfAlt('uploadPreview', { filename: file.name })));
              fileDiv.appendChild(img);

              filesContainer.appendChild(fileDiv);
            });

            // Add non-image files
            nonImageFiles.forEach(file => {
              const fileDiv = document.createElement('div');
              fileDiv.className = 'message-file';
              const fileInfo = document.createElement('div');
              fileInfo.textContent = `📄 ${file.name}`;
              fileDiv.appendChild(fileInfo);
              filesContainer.appendChild(fileDiv);
            });

            contentDiv.appendChild(filesContainer);
          }
        }

        messageDiv.appendChild(avatar);
        messageDiv.appendChild(contentDiv);
        chatMessages.appendChild(messageDiv);

        // Scroll to bottom
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }

      function showTypingIndicator(messageType = 'general') {
        // Remove any existing typing indicator first
        const existingIndicator = document.getElementById('typing-indicator');
        if (existingIndicator) {
          removeTypingIndicator('typing-indicator');
        }

        const typingDiv = document.createElement('div');
        typingDiv.className = 'message assistant';
        typingDiv.id = 'typing-indicator';

        const avatar = document.createElement('div');
        avatar.className = 'message-avatar';
        const logoImg = document.createElement('img');
        logoImg.src = 'media-webp/logo/Logo64x64.webp';
        logoImg.alt = getPdfAlt('assistantAvatar');
        avatar.appendChild(logoImg);

        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';

        const typing = document.createElement('div');
        typing.className = 'typing-indicator';
        attachRotatingStatusText(typing, messageType);

        contentDiv.appendChild(typing);
        typingDiv.appendChild(avatar);
        typingDiv.appendChild(contentDiv);
        chatMessages.appendChild(typingDiv);

        chatMessages.scrollTop = chatMessages.scrollHeight;

        return 'typing-indicator';
      }

      function removeTypingIndicator(id) {
        const indicator = document.getElementById(id);
        if (indicator) {
          const typingEl = indicator.querySelector('.typing-indicator');
          if (typingEl) clearRotatingStatusText(typingEl);
          indicator.remove();
        }
      }

  return {
    addMessage,
    addErrorMessage,
    showTypingIndicator,
    removeTypingIndicator,
    showMessageImageLoading,
    removeMessageImageLoading,
    getLastAssistantContentEl,
    updateLastAssistantText,
  };
}
