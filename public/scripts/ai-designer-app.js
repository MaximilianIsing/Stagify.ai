import {
  formatFileSize,
  imageCountSuffix,
  formatMarkdown,
  getFileStem,
  slugifyName,
  messageTypeFromTag,
} from './ai-designer/format.js';
import {
  getThumbnailLabel,
  pickPreferredRoomImageIndex,
  collectImagesFromConversationHistory as _collectImagesFromConversationHistory,
  getBaseImageIndexForRequest as _getBaseImageIndexForRequest,
  resolveStagingRootBaseName as _resolveStagingRootBaseName,
} from './ai-designer/image-history.js';
import { consumeChatSse } from './ai-designer/chat-sse-client.js';
import { createMaskEditor } from './ai-designer/mask-editor.js';

      const chatMessages = document.getElementById('chat-messages');
      const chatInput = document.getElementById('chat-input');
      const sendBtn = document.getElementById('send-btn');
      const fileInput = document.getElementById('file-input');
      const chatContainer = document.querySelector('.chat-container');
      
      let conversationHistory = [];
      let selectedFiles = [];
      let selectedImageIndex = null;
      let isProcessing = false; // Track if we're currently processing a message
      let currentAbortController = null; // Lets the user stop an in-flight generation
      let dragCounter = 0; // Track drag enter/leave events to handle nested elements
      const MAX_UPLOAD_FILES = 5;
      let pendingStagingRootBaseName = null;

      // Thin wrappers over the pure image-history module (scripts/ai-designer/
      // image-history.js): bind the live conversationHistory / selectedImageIndex
      // so the call sites below stay unchanged. Logic + tests live in that module.
      const collectImagesFromConversationHistory = () =>
        _collectImagesFromConversationHistory(conversationHistory);
      const getBaseImageIndexForRequest = () =>
        _getBaseImageIndexForRequest(conversationHistory, selectedImageIndex);
      const resolveStagingRootBaseName = (filesToSend) =>
        _resolveStagingRootBaseName(filesToSend, conversationHistory, selectedImageIndex);

      // Mask-editor island (scripts/ai-designer/mask-editor.js): owns the brush-
      // mask modal + its state machine; the entry injects the glue it needs to
      // commit results back into the chat history and the image carousel.
      const { openMaskEditor } = createMaskEditor({
        lang,
        showToast,
        createOrUpdateMaskedImageCarousel,
        addMessage,
        syncImageThumbnailStrip,
        collectImagesFromConversationHistory,
        pushHistoryEntry: (entry) => conversationHistory.push(entry),
      });

      function getPdfAlt(key, replacements = {}) {
        let text = (window.LanguageSystem && window.LanguageSystem.isLoaded())
          ? window.LanguageSystem.getText('pdf.alt.' + key)
          : '';
        if (!text) {
          const fallbacks = {
            uploadFile: 'Attach a file to your message',
            reloadChat: 'Start a new chat conversation',
            sendMessage: 'Send message',
            reportBug: 'Report a bug',
            userAvatar: 'Your avatar',
            assistantAvatar: 'Stagify AI Designer',
            uploadPreview: 'Preview of uploaded file: {filename}',
            stagedRoom: 'AI-staged room{suffix}',
            generatedImage: 'AI-generated design image{suffix}',
            cadRender: '3D render from floor plan{suffix}',
            recalledImage: 'Previously shared image from this conversation',
            requestedImage: 'Image requested from conversation history',
            editedImage: 'Mask-edited design image{suffix}',
            originalCarouselImage: 'Original image before mask edits',
            enlargedImage: 'Full-size view of design image',
            thumbnailSelected: '{label} — selected as base image for your next message',
            thumbnailOption: '{label} — image {index} in conversation',
          };
          text = fallbacks[key] || '';
        }
        Object.entries(replacements).forEach(([k, v]) => {
          text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), v == null ? '' : String(v));
        });
        return text;
      }

      function isDesignerProOk() {
        return window.StagifyAuth && window.StagifyAuth.user && window.StagifyAuth.user.plan === 'pro';
      }

      async function ensureDesignerProAccess() {
        // auth.js is loaded with `defer`, so window.StagifyAuth may not exist yet
        // when this inline script first runs during parsing. Wait for it before
        // deciding — otherwise we'd wrongly bounce signed-in (incl. Pro) users to
        // the demo row. Non-Pro and anonymous users still get sent there.
        let waited = 0;
        while (!window.StagifyAuth && waited < 5000) {
          await new Promise((r) => setTimeout(r, 50));
          waited += 50;
        }
        if (!window.StagifyAuth) {
          window.location.replace('index.html#ai-designer-demo');
          return false;
        }
        await window.StagifyAuth.fetchMe();
        const u = window.StagifyAuth.user;
        if (!u || u.plan !== 'pro') {
          window.location.replace('index.html#ai-designer-demo');
          return false;
        }
        // Verified Pro — reveal the page (the head gate hid it until now).
        document.documentElement.classList.remove('ai-gate-pending');
        return true;
      }
      
      function defaultWelcomeMessage() {
        const fallback =
          "Hi! I'm your Stagify AI Designer. Tell me what you're picturing, or upload a room photo, and we'll design it together. A few things I can do:\n" +
          "• **Stage empty rooms**: furnish a bare space in any style\n" +
          "• **Redesign existing rooms**: restyle, swap furniture, or change the whole mood\n" +
          "• **Floor plan → room**: turn a floor plan into a photorealistic, furnished render\n" +
          "• **Refine as we chat**: adjust the colors, pieces, and layout until it feels right\n" +
          "Where would you like to start?";
        if (window.LanguageSystem && typeof LanguageSystem.getText === 'function') {
          return LanguageSystem.getText('pdf.welcomeFallback', fallback);
        }
        return fallback;
      }

      // Load welcome message on page load
      async function loadWelcomeMessage() {
        try {
          // Remove empty state immediately
          const emptyState = chatMessages.querySelector('.empty-state');
          if (emptyState) {
            emptyState.remove();
          }

          // Show typing indicator while loading welcome message
          const typingId = showTypingIndicator('welcome');
          
          // Generate a simple user ID (you can enhance this with actual user identification)
          const userId = localStorage.getItem('userId') || `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          localStorage.setItem('userId', userId);
          
          const tok = window.StagifyAuth && window.StagifyAuth.getToken();
          const q = new URLSearchParams({ userId: userId });
          if (tok) q.set('authToken', tok);
          const response = await fetch(`/api/welcome-message?${q}`);
          const data = await response.json();
          
          // Remove typing indicator
          removeTypingIndicator(typingId);
          
          {
            // Always greet; fall back to a built-in message if the API is empty
            addMessage('assistant', data.message || defaultWelcomeMessage());
            
            // Add to conversation history
            conversationHistory.push({ role: 'assistant', content: data.message || defaultWelcomeMessage() });
          }
        } catch (error) {
          console.error('Error loading welcome message:', error);
          // Remove typing indicator if it exists
          const typingIndicator = document.getElementById('typing-indicator');
          if (typingIndicator) {
            typingIndicator.remove();
          }
          // Still greet the user with the default message even if the request failed.
          const message = defaultWelcomeMessage();
          addMessage('assistant', message);
          conversationHistory.push({ role: 'assistant', content: message });
        }
      }
      
      // On open: just gate access and reveal the page. The chat shows only the
      // "AI Designer / Start a conversation" background — the starting message is
      // sent on demand by the refresh button, not on load.
      ensureDesignerProAccess();
      
      // Reload button functionality
      const reloadBtn = document.getElementById('reload-btn');
      reloadBtn.addEventListener('click', function() {
        // Reset conversation history
        conversationHistory = [];
        selectedImageIndex = null;
        syncImageThumbnailStrip();
        
        // Clear chat messages
        chatMessages.innerHTML = '';
        
        // Clear file selection
        selectedFiles = [];
        updateFilePreview();
        
        // Clear input
        chatInput.value = '';
        
        // Reset processing state
        isProcessing = false;
        updateSendButtonState();
        
        // Refresh sends the Designer's starting message (open does not).
        ensureDesignerProAccess().then((ok) => {
          if (ok) loadWelcomeMessage();
        });
      });

      // Append the hotkey to the reload button's hover text. The language loader
      // resets the title from the JSON on every language change, so re-apply the
      // suffix after each change (and once now in case it already fired).
      function decorateReloadTitle() {
        if (!reloadBtn) return;
        const t = reloadBtn.getAttribute('title') || '';
        if (!t.includes('Control + Shift + Q')) {
          reloadBtn.setAttribute('title', (t ? t + ' ' : '') + '(Control + Shift + Q)');
        }
      }
      window.addEventListener('languagechange', decorateReloadTitle);
      decorateReloadTitle();

      // Update file preview
      // A `let` (not a function declaration) so the wrapper installed later that
      // also refreshes the send button can reassign it (see below). The recursive
      // call inside resolves the outer binding, so it hits the wrapped version too.
      let updateFilePreview = function () {
        const container = document.getElementById('file-preview-container');
        const list = document.getElementById('file-preview-list');
        
        if (selectedFiles.length === 0) {
          container.classList.remove('has-files');
          list.innerHTML = '';
          return;
        }
        
        container.classList.add('has-files');
        list.innerHTML = '';
        
        selectedFiles.forEach((file, index) => {
          const item = document.createElement('div');
          item.className = 'file-preview-item';
          
          if (file.type.startsWith('image/')) {
            const img = document.createElement('img');
            img.src = URL.createObjectURL(file);
            img.alt = getPdfAlt('uploadPreview', { filename: file.name });
            item.appendChild(img);
          } else {
            const icon = document.createElement('div');
            icon.style.cssText = 'width: 40px; height: 40px; background: #2563eb; border-radius: 4px; display: flex; align-items: center; justify-content: center; color: white; font-weight: bold;';
            icon.textContent = file.name.split('.').pop().toUpperCase().substring(0, 3);
            item.appendChild(icon);
          }
          
          const fileInfo = document.createElement('div');
          fileInfo.className = 'file-info';
          
          const fileName = document.createElement('div');
          fileName.className = 'file-name';
          fileName.textContent = file.name;
          
          const fileSize = document.createElement('div');
          fileSize.className = 'file-size';
          fileSize.textContent = formatFileSize(file.size);
          
          fileInfo.appendChild(fileName);
          fileInfo.appendChild(fileSize);
          item.appendChild(fileInfo);
          
          const removeBtn = document.createElement('button');
          removeBtn.className = 'file-remove';
          removeBtn.innerHTML = '×';
          removeBtn.onclick = () => {
            selectedFiles.splice(index, 1);
            updateFilePreview();
          };
          item.appendChild(removeBtn);
          
          list.appendChild(item);
        });
      }
      
      // Small translation helper with a safe fallback. getText() returns the
      // placeholder "Loading..." (or echoes the key) for keys that aren't in the
      // language files yet, so we ignore those and use the English fallback.
      function lang(key, fallback) {
        try {
          if (window.LanguageSystem && window.LanguageSystem.isLoaded && window.LanguageSystem.isLoaded()) {
            const v = window.LanguageSystem.getText(key);
            if (v && v !== key && v !== 'Loading...') return v;
          }
        } catch (e) {}
        return fallback;
      }

      // Non-blocking toast notification (replaces native alert()).
      function showToast(message, type) {
        let host = document.getElementById('toast-host');
        if (!host) {
          host = document.createElement('div');
          host.id = 'toast-host';
          host.setAttribute('aria-live', 'polite');
          document.body.appendChild(host);
        }
        const toast = document.createElement('div');
        toast.className = 'toast' + (type ? ' toast--' + type : '');
        toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
        toast.textContent = message;
        host.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('toast--show'));
        setTimeout(() => {
          toast.classList.remove('toast--show');
          setTimeout(() => toast.remove(), 320);
        }, 4200);
      }

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

      // Classify a failed chat request into a helpful, actionable message.
      function describeSendError(error, response) {
        if (response && (response.status === 401 || response.status === 403)) {
          return lang('pdf.error.proRequired', 'The AI Designer is available to Stagify+ members. Please sign in with a Stagify+ account.');
        }
        if (response && response.status === 429) {
          return lang('pdf.error.rateLimited', "You've hit the generation limit for now. Please wait a moment and try again.");
        }
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          return lang('pdf.error.offline', 'You appear to be offline. Check your connection and try again.');
        }
        if (error && error.name === 'TypeError') {
          return lang('pdf.error.network', "Couldn't reach the server. Check your connection and try again.");
        }
        if (response && response.status >= 500) {
          return lang('pdf.error.server', 'The server had a problem handling that. Please try again in a moment.');
        }
        return lang('pdf.error.generic', 'Sorry, I encountered an error. Please try again.');
      }

      // Handle input (fixed height, no auto-resize)
      chatInput.addEventListener('input', function() {
        // Enforce character limit (maxlength should handle this, but just in case)
        if (this.value.length > 5000) {
          this.value = this.value.substring(0, 5000);
        }
        
        // Show scrollbar only if content exceeds one line
        if (this.scrollHeight > 48) {
          this.classList.add('multi-line');
        } else {
          this.classList.remove('multi-line');
        }
        
        if (!isProcessing) {
          updateSendButtonState();
        }
      });
      
      // Check on focus to show scrollbar if needed
      chatInput.addEventListener('focus', function() {
        if (this.scrollHeight > 48) {
          this.classList.add('multi-line');
        }
      });
      
      // Hide scrollbar when not focused if content fits in one line
      chatInput.addEventListener('blur', function() {
        if (this.scrollHeight <= 48) {
          this.classList.remove('multi-line');
        }
      });
      
      // Send message on Enter (Shift+Enter for new line)
      chatInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          // Only send if not currently processing and send button is enabled
          if (!isProcessing && !sendBtn.disabled) {
            sendMessage();
          }
        }
      });
      
      // Send button click
      sendBtn.addEventListener('click', function() {
        if (isProcessing) {
          abortCurrentGeneration();
        } else {
          sendMessage();
        }
      });

      // Keyboard shortcuts on the Q key:
      //   Ctrl+Q        → abort an in-flight generation (only while generating)
      //   Ctrl+Shift+Q  → reset / start a new chat (same as the reload button)
      document.addEventListener('keydown', function(e) {
        if (!e.ctrlKey || (e.key !== 'q' && e.key !== 'Q')) return;
        if (e.shiftKey) {
          e.preventDefault();
          const rb = document.getElementById('reload-btn');
          if (rb) rb.click();
        } else if (isProcessing) {
          e.preventDefault();
          abortCurrentGeneration();
        }
      });

      // Focus trap for open modals — Escape/click-outside already close them, but
      // without this, Tab can walk focus to controls hidden behind the overlay.
      function getOpenModal() {
        // Topmost first (mask editor sits above bug report sits above image modal).
        const ids = ['mask-editor-modal', 'bug-report-popup', 'image-modal'];
        for (const id of ids) {
          const m = document.getElementById(id);
          if (m && m.classList.contains('active')) return m;
        }
        return null;
      }
      document.addEventListener('keydown', function(e) {
        if (e.key !== 'Tab') return;
        const modal = getOpenModal();
        if (!modal) return;
        const focusables = Array.from(
          modal.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')
        ).filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        // If focus has drifted outside the modal, pull it back in.
        if (!modal.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
          return;
        }
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      });

      // Per-file size cap (mirrors the server's 50MB chat-upload limit, kept a
      // bit lower so we reject before a long upload that the server would drop).
      const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB
      const ALLOWED_UPLOAD_EXTS = ['.pdf', '.txt', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.webp', '.gif'];

      // Helper function to handle files (used by file input, drag & drop, paste)
      async function handleFiles(files) {
        // iPhone HEIC/HEIF photos can't be decoded/previewed by most browsers;
        // convert them to JPEG before they enter the upload list.
        let incoming = Array.from(files);
        if (window.StagifyHeic) {
          try {
            incoming = await Promise.all(incoming.map(f =>
              (f && window.StagifyHeic.isHeic(f)) ? window.StagifyHeic.toDisplayableFile(f) : f
            ));
          } catch (e) {
            showToast("We couldn't read that HEIC photo. Please try a JPG or PNG.", 'error');
            return;
          }
        }

        const accepted = [];
        const rejected = [];

        incoming.forEach(file => {
          if (!file || !file.name) return;
          const name = file.name.toLowerCase();
          const isImage = file.type && file.type.startsWith('image/');
          const extOk = ALLOWED_UPLOAD_EXTS.some(ext => name.endsWith(ext));
          if (!isImage && !extOk) {
            rejected.push(`${file.name} (unsupported type)`);
            return;
          }
          if (file.size > MAX_UPLOAD_BYTES) {
            rejected.push(`${file.name} (over 25MB)`);
            return;
          }
          accepted.push(file);
        });

        if (rejected.length) {
          showToast(`Skipped: ${rejected.join(', ')}`, 'error');
        }
        if (!accepted.length) return;

        const remainingSlots = MAX_UPLOAD_FILES - selectedFiles.length;
        if (remainingSlots <= 0) {
          showToast(`Maximum of ${MAX_UPLOAD_FILES} files allowed. Remove some before adding more.`, 'error');
          return;
        }

        const filesToAdd = accepted.slice(0, remainingSlots);
        selectedFiles.push(...filesToAdd);
        updateFilePreview();
        if (!isProcessing) {
          updateSendButtonState();
        }

        if (accepted.length > remainingSlots) {
          const excessCount = accepted.length - remainingSlots;
          showToast(`Maximum of ${MAX_UPLOAD_FILES} files. Added ${remainingSlots}; ${excessCount} not added.`, 'error');
        }
      }
      
      // File upload - add to preview instead of uploading immediately
      fileInput.addEventListener('change', function(e) {
        const files = Array.from(e.target.files);
        handleFiles(files);
        e.target.value = ''; // Reset input
      });

      // Drag and drop functionality
      chatMessages.addEventListener('dragenter', function(e) {
        e.preventDefault();
        e.stopPropagation();
        dragCounter++;
        if (e.dataTransfer.types.includes('Files')) {
          chatMessages.classList.add('drag-over');
          chatContainer.classList.add('drag-over');
        }
      });
      
      chatMessages.addEventListener('dragover', function(e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer.types.includes('Files')) {
          e.dataTransfer.dropEffect = 'copy';
        }
      });
      
      chatMessages.addEventListener('dragleave', function(e) {
        e.preventDefault();
        e.stopPropagation();
        dragCounter--;
        if (dragCounter === 0) {
          chatMessages.classList.remove('drag-over');
          chatContainer.classList.remove('drag-over');
        }
      });
      
      chatMessages.addEventListener('drop', function(e) {
        e.preventDefault();
        e.stopPropagation();
        dragCounter = 0;
        chatMessages.classList.remove('drag-over');
        chatContainer.classList.remove('drag-over');
        
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
          handleFiles(files);
        }
      });
      
      // Also handle drag and drop on the chat container for better coverage
      chatContainer.addEventListener('dragenter', function(e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer.types.includes('Files')) {
          dragCounter++;
          chatMessages.classList.add('drag-over');
          chatContainer.classList.add('drag-over');
        }
      });
      
      chatContainer.addEventListener('dragover', function(e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer.types.includes('Files')) {
          e.dataTransfer.dropEffect = 'copy';
        }
      });
      
      chatContainer.addEventListener('dragleave', function(e) {
        e.preventDefault();
        e.stopPropagation();
        // Only remove if we're leaving the container entirely
        if (!chatContainer.contains(e.relatedTarget)) {
          dragCounter = 0;
          chatMessages.classList.remove('drag-over');
          chatContainer.classList.remove('drag-over');
        }
      });
      
      chatContainer.addEventListener('drop', function(e) {
        e.preventDefault();
        e.stopPropagation();
        dragCounter = 0;
        chatMessages.classList.remove('drag-over');
        chatContainer.classList.remove('drag-over');
        
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
          handleFiles(files);
        }
      });
      
      // Handle paste events for images
      document.addEventListener('paste', function(e) {
        // Only handle paste if the chat container is visible and user isn't typing in another input
        const activeElement = document.activeElement;
        const isTypingInOtherInput = activeElement && 
                                     activeElement.tagName === 'INPUT' && 
                                     activeElement !== chatInput &&
                                     activeElement.type !== 'file';
        
        // Don't intercept paste if user is typing in another input field
        if (isTypingInOtherInput) return;
        
        // Check if chat container is visible
        if (!chatContainer || chatContainer.offsetParent === null) return;
        
        const items = e.clipboardData?.items;
        if (!items) return;
        
        // Look for image items in the clipboard
        const imageItems = Array.from(items).filter(item => item.type.indexOf('image') !== -1);
        
        if (imageItems.length > 0) {
          e.preventDefault();
          
          // Process each image
          imageItems.forEach((item, index) => {
            if (index === 0) { // Only process the first image to avoid multiple alerts
              const blob = item.getAsFile();
              if (blob) {
                // Convert blob to File object with a proper name
                const fileName = `pasted-image-${Date.now()}.png`;
                const file = new File([blob], fileName, { type: blob.type || 'image/png' });
                
                // Use the existing handleFiles function
                handleFiles([file]);
              }
            }
          });
        }
      });
      
      // Initialize send button state
      updateSendButtonState();

      function syncImageThumbnailStrip(options) {
        const preferNewest = options && options.preferNewest === true;
        const strip = document.getElementById('image-thumbnail-strip');
        const scroll = document.getElementById('image-thumbnail-strip-scroll');
        if (!strip || !scroll) return;

        const images = collectImagesFromConversationHistory();
        if (images.length === 0) {
          strip.classList.remove('visible');
          scroll.innerHTML = '';
          selectedImageIndex = null;
          return;
        }

        strip.classList.add('visible');
        if (preferNewest || selectedImageIndex === null || selectedImageIndex >= images.length) {
          selectedImageIndex = 0;
        }

        scroll.innerHTML = '';
        images.forEach((img, index) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'image-thumbnail-item' + (index === selectedImageIndex ? ' selected' : '');
          const label = getThumbnailLabel(img);
          btn.setAttribute('aria-label', getPdfAlt('thumbnailOption', { label, index: index + 1 }));
          btn.dataset.index = String(index);

          const preview = document.createElement('img');
          preview.className = 'image-thumbnail-preview';
          preview.src = img.url;
          preview.alt = index === selectedImageIndex
            ? getPdfAlt('thumbnailSelected', { label })
            : getPdfAlt('thumbnailOption', { label, index: index + 1 });
          preview.loading = 'lazy';

          const caption = document.createElement('span');
          caption.className = 'image-thumbnail-caption';
          caption.textContent = getThumbnailLabel(img);

          btn.appendChild(preview);
          btn.appendChild(caption);
          btn.addEventListener('click', () => {
            selectedImageIndex = index;
            syncImageThumbnailStrip();
          });

          scroll.appendChild(btn);
        });
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
          for (let i = conversationHistory.length - 1; i >= 0; i--) {
            const msg = conversationHistory[i];
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
          const rootBaseName = pendingStagingRootBaseName || 'Upload';
          pendingStagingRootBaseName = null;
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
          const lastMsg = conversationHistory[conversationHistory.length - 1];
          const isDuplicate = lastMsg &&
            lastMsg.role === 'assistant' &&
            JSON.stringify(lastMsg.content) === JSON.stringify(assistantMessage.content);
          if (!isDuplicate) {
            conversationHistory.push(assistantMessage);
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
          const lastMsg = conversationHistory[conversationHistory.length - 1];
          const isDuplicate = lastMsg &&
            lastMsg.role === 'assistant' &&
            JSON.stringify(lastMsg.content) === JSON.stringify(assistantMessage.content);
          if (!isDuplicate) {
            conversationHistory.push(assistantMessage);
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
            const lastMsg2 = conversationHistory[conversationHistory.length - 1];
            const isDuplicate2 = lastMsg2 &&
              lastMsg2.role === 'assistant' &&
              JSON.stringify(lastMsg2.content) === JSON.stringify(cadAssistantMessage.content);
            if (!isDuplicate2) {
              conversationHistory.push(cadAssistantMessage);
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
          const lastMsg = conversationHistory[conversationHistory.length - 1];
          const isDuplicate = lastMsg &&
            lastMsg.role === 'assistant' &&
            JSON.stringify(lastMsg.content) === JSON.stringify(assistantMessage.content);
          if (!isDuplicate) {
            conversationHistory.push(assistantMessage);
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
          const lastMsg = conversationHistory[conversationHistory.length - 1];
          const isDuplicate = lastMsg &&
            lastMsg.role === 'assistant' &&
            JSON.stringify(lastMsg.content) === JSON.stringify(assistantMessage.content);
          if (!isDuplicate) {
            conversationHistory.push(assistantMessage);
          }
        } else if (!imagesOnly) {
          addMessage('assistant', data.response);
          const assistantMessage = { role: 'assistant', content: data.response };
          const lastMsg = conversationHistory[conversationHistory.length - 1];
          const isDuplicate = lastMsg &&
            lastMsg.role === 'assistant' &&
            JSON.stringify(lastMsg.content) === JSON.stringify(assistantMessage.content);
          if (!isDuplicate) {
            conversationHistory.push(assistantMessage);
          }
        }

        syncImageThumbnailStrip({ preferNewest: addedAssistantImages });
        pendingStagingRootBaseName = null;
      }
      
      function sendMessage() {
        if (!isDesignerProOk()) return;
        const message = chatInput.value.trim();
        if (!message && selectedFiles.length === 0) return;
        
        // Get message tag
        const messageTagBtn = document.getElementById('message-tag-btn');
        const messageTagValue = messageTagBtn ? messageTagBtn.getAttribute('data-tag') || 'auto' : 'auto';
        
        // Show user message in chat
        const userMessageText = message || (selectedFiles.length > 0 ? `Uploaded ${selectedFiles.length} file(s)` : '');
        if (userMessageText) {
          addMessage('user', userMessageText, selectedFiles);
        }
        
        // Clear input and files
        chatInput.value = '';
        const filesToSend = [...selectedFiles];
        selectedFiles = [];
        updateFilePreview();
        
        // Mark processing — the send button turns into a Stop button.
        setProcessing(true);

        // Initial status from the chosen tag (works in any language). When the
        // tag is "auto" we start generic; the server then sends a `status` event
        // with the real intent once it decides, which we honor during the slow
        // image phase — far more reliable than guessing from English keywords.
        let messageType = messageTypeFromTag(messageTagValue);

        // Store images in conversation history and send
        const userMessageContent = [];
        if (message && message.trim()) {
          userMessageContent.push({ type: 'text', text: message });
        }
        
        // Convert files to base64 and store in conversation history
        const filePromises = filesToSend.map(file => {
          return new Promise((resolve) => {
            if (file.type.startsWith('image/')) {
              const reader = new FileReader();
              reader.onload = (e) => {
                userMessageContent.push({
                  type: 'image_url',
                  image_url: { url: e.target.result },
                  filename: file.name,
                  rootBaseName: getFileStem(file.name) || 'Upload',
                });
                resolve();
              };
              reader.readAsDataURL(file);
            } else {
              // For non-image files, just store the filename
              userMessageContent.push({
                type: 'text',
                text: `[File: ${file.name}]`
              });
              resolve();
            }
          });
        });
        
        // Wait for all files to be read, then send
        Promise.all(filePromises).then(() => {
          // Add user message to conversation history (avoid duplicates)
          const userMessage = { 
            role: 'user', 
            content: userMessageContent.length > 0 ? userMessageContent : userMessageText
          };
          
          // Check if the last message is the same (avoid duplicates)
          const lastMessage = conversationHistory[conversationHistory.length - 1];
          const isDuplicate = lastMessage && 
            lastMessage.role === 'user' && 
            JSON.stringify(lastMessage.content) === JSON.stringify(userMessage.content);
          
          // History for the API must NOT include this message — the server builds the
          // current turn from multipart files. Including it here duplicates images.
          const historyForRequest = [...conversationHistory];
          
          if (!isDuplicate) {
            conversationHistory.push(userMessage);
          }
          syncImageThumbnailStrip();
          if (filesToSend.length >= 2) {
            const imagesForPick = collectImagesFromConversationHistory();
            selectedImageIndex = pickPreferredRoomImageIndex(imagesForPick);
            syncImageThumbnailStrip();
          }
          
          // Snapshot of the full history (incl. this turn) so a Retry re-sends
          // exactly the same text-only request.
          const messagesSnapshot = [...conversationHistory];

          // The actual network request, wrapped in a function so the Retry
          // button can re-run the identical request after a failure.
          function doSend() {
            setProcessing(true);
            const typingId = showTypingIndicator(messageType);
            currentAbortController = new AbortController();
            const signal = currentAbortController.signal;

            let request;
            if (filesToSend.length > 0) {
              // Send with files
              const formData = new FormData();
              filesToSend.forEach(file => {
                formData.append('files', file);
              });
              if (message) {
                formData.append('message', message);
              }
              // Prior messages only (current upload is sent as files above)
              formData.append('conversationHistory', JSON.stringify(historyForRequest));

              const userId = localStorage.getItem('userId');
              if (userId) {
                formData.append('userId', userId);
              }
              const authTok = window.StagifyAuth && window.StagifyAuth.getToken();
              if (authTok) formData.append('authToken', authTok);

              const selectedModel = window.getSelectedModelApiName ? window.getSelectedModelApiName() : 'gpt-4o-mini';
              formData.append('model', selectedModel);

              if (messageTagValue && messageTagValue !== 'auto') {
                formData.append('messageTag', messageTagValue);
              }

              formData.append('streamResponse', 'true');
              pendingStagingRootBaseName = resolveStagingRootBaseName(filesToSend);
              const baseImageIndex = getBaseImageIndexForRequest();
              if (baseImageIndex !== undefined) {
                formData.append('baseImageIndex', String(baseImageIndex));
              }

              request = fetch('/api/chat-upload', {
                method: 'POST',
                headers: { 'X-Stream-Response': '1' },
                body: formData,
                signal,
              });
            } else {
              // Send text only — uses the snapshot taken above for context.
              const userId = localStorage.getItem('userId');
              const chatAuthTok = window.StagifyAuth && window.StagifyAuth.getToken();
              const baseImageIndexChat = getBaseImageIndexForRequest();
              pendingStagingRootBaseName = resolveStagingRootBaseName([]);
              request = fetch('/api/chat', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-Stream-Response': '1',
                  ...(chatAuthTok ? { Authorization: 'Bearer ' + chatAuthTok } : {}),
                },
                body: JSON.stringify({
                  messages: messagesSnapshot,
                  userId: userId,
                  model: window.getSelectedModelApiName ? window.getSelectedModelApiName() : 'gpt-4o-mini',
                  messageTag: messageTagValue && messageTagValue !== 'auto' ? messageTagValue : undefined,
                  authToken: chatAuthTok || undefined,
                  streamResponse: true,
                  ...(baseImageIndexChat !== undefined ? { baseImageIndex: baseImageIndexChat } : {}),
                }),
                signal,
              });
            }

            request
              .then(response => {
                if (!response.ok) {
                  const err = new Error('HTTP ' + response.status);
                  err.response = response;
                  throw err;
                }
                return handleChatFetchResponse(response, typingId, messageType, doSend);
              })
              .catch(error => {
                pendingStagingRootBaseName = null;
                removeTypingIndicator(typingId);
                removeMessageImageLoading();
                if (error && error.name === 'AbortError') {
                  // User pressed Stop — quiet acknowledgement, no Retry.
                  addMessage('assistant', lang('pdf.stopped', 'Generation stopped.'));
                } else {
                  console.error('Error:', error);
                  const status = error && error.response && error.response.status;
                  // Retrying an auth failure (signed out / not Stagify+) won't help.
                  const allowRetry = status !== 401 && status !== 403;
                  addErrorMessage(describeSendError(error, error && error.response), allowRetry ? doSend : null);
                }
              })
              .finally(() => {
                endProcessing();
              });
          }

          doSend();
        });
      }
      
      // Update send button state based on input. While processing, the button is
      // a Stop control and must stay clickable (so this leaves it enabled).
      function updateSendButtonState() {
        if (isProcessing) {
          sendBtn.disabled = false;
          return;
        }
        const hasContent = chatInput.value.trim() || selectedFiles.length > 0;
        sendBtn.disabled = !hasContent;
      }

      // Toggle the processing state and swap the send button between Send/Stop.
      function setProcessing(state) {
        isProcessing = state;
        if (state) {
          sendBtn.classList.add('send-btn--stop');
          sendBtn.disabled = false;
          const stopLabel = lang('pdf.stop', 'Stop generating') + ' (Control + Q)';
          sendBtn.title = stopLabel;
          sendBtn.setAttribute('aria-label', stopLabel);
        } else {
          sendBtn.classList.remove('send-btn--stop');
          sendBtn.title = lang('pdf.alt.sendMessage', 'Send message');
          sendBtn.setAttribute('aria-label', lang('pdf.alt.sendMessage', 'Send message'));
          updateSendButtonState();
        }
      }

      // Called when a request settles (success, error, or abort).
      function endProcessing() {
        currentAbortController = null;
        setProcessing(false);
        chatInput.focus();
      }

      // Abort the in-flight generation, if any (drives the Stop button).
      function abortCurrentGeneration() {
        if (currentAbortController) {
          try { currentAbortController.abort(); } catch (e) {}
        }
      }
      
      // Update send button when input changes
      chatInput.addEventListener('input', function() {
        updateSendButtonState();
      });
      
      // Update send button when files are added/removed
      const originalUpdateFilePreview = updateFilePreview;
      updateFilePreview = function() {
        originalUpdateFilePreview();
        updateSendButtonState();
      };
      
      // Initialize send button state
      updateSendButtonState();
      
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
      
      // Image modal functions
      function openImageModal(imageSrc, altText) {
        const modal = document.getElementById('image-modal');
        const modalImg = document.getElementById('image-modal-img');
        if (modal && modalImg) {
          modalImg.src = imageSrc;
          modalImg.alt = altText || getPdfAlt('enlargedImage');
          modal.classList.add('active');
          document.body.style.overflow = 'hidden'; // Prevent background scrolling
        }
      }
      
      function closeImageModal() {
        const modal = document.getElementById('image-modal');
        if (modal) {
          modal.classList.remove('active');
          document.body.style.overflow = ''; // Restore scrolling
        }
      }
      // The image modal's close handlers live in the classic (non-module)
      // ai-designer-model-selector.js, which can't reach this module's scope,
      // so expose the closer on window.
      window.closeImageModal = closeImageModal;
      
      // Download image function
      function downloadImage(imageSrc, filename = 'image') {
        // Convert base64 data URL to blob
        fetch(imageSrc)
          .then(res => res.blob())
          .then(blob => {
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename || 'image.png';
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
          })
          .catch(error => {
            console.error('Error downloading image:', error);
            // Fallback: try direct download for data URLs
            try {
              const a = document.createElement('a');
              a.href = imageSrc;
              a.download = filename || 'image.png';
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
            } catch (e) {
              console.error('Fallback download also failed:', e);
            }
          });
      }
      
      // Turn an arbitrary label (e.g. a room/source name) into a safe filename part.
      // Helper function to create AI image with download button. `baseName` is an
      // optional room/source label so downloads are named e.g.
      // "123-main-living-staged-room-1.png" instead of "image.png".
      function createAIImageWithDownload(imageSrc, altText, imageType = 'image', baseName) {
        const container = document.createElement('div');
        container.className = 'ai-image-container';

        const img = document.createElement('img');
        img.src = imageSrc;
        img.alt = altText;
        img.className = 'ai-generated-image';
        img.addEventListener('click', () => openImageModal(imageSrc, altText));

        // Compute a stable, descriptive filename once and reuse it for both the
        // per-image download button and the "Download all" action.
        const extension = imageSrc.includes('data:image/png') ? 'png' :
                        imageSrc.includes('data:image/jpeg') || imageSrc.includes('data:image/jpg') ? 'jpg' :
                        imageSrc.includes('data:image/webp') ? 'webp' : 'png';
        const stem = baseName
          ? `${slugifyName(baseName)}-${imageType}`
          : `${imageType}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)}`;
        const filename = `${stem}.${extension}`;

        const downloadBtn = document.createElement('button');
        downloadBtn.className = 'ai-image-download-btn';
        const downloadLabel = (window.LanguageSystem && window.LanguageSystem.isLoaded())
          ? window.LanguageSystem.getText('modal.staging.downloadIcon')
          : 'Download image';
        downloadBtn.title = downloadLabel;
        downloadBtn.setAttribute('aria-label', downloadLabel);

        const downloadIcon = document.createElement('img');
        downloadIcon.src = 'media-webp/download.webp';
        downloadIcon.alt = '';
        downloadIcon.setAttribute('aria-hidden', 'true');
        downloadBtn.appendChild(downloadIcon);
        downloadBtn.addEventListener('click', (e) => {
          e.stopPropagation(); // Prevent opening modal when clicking download
          downloadImage(imageSrc, filename);
        });

        container.appendChild(img);
        container.appendChild(downloadBtn);
        
        if (window.StagifyAuth && window.StagifyAuth.user && window.StagifyAuth.user.plan === 'pro') {
          const maskBtn = document.createElement('button');
          maskBtn.className = 'ai-image-mask-btn';
          const maskLabel = (window.LanguageSystem && window.LanguageSystem.isLoaded())
            ? window.LanguageSystem.getText('modal.staging.editWithMask')
            : 'Edit selected area with mask tool';
          maskBtn.title = maskLabel;
          maskBtn.setAttribute('aria-label', maskLabel);
          
          const maskIcon = document.createElement('img');
          maskIcon.src = 'media-webp/Mask.webp';
          maskIcon.alt = '';
          maskIcon.setAttribute('aria-hidden', 'true');
          maskBtn.appendChild(maskIcon);
          
          maskBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openMaskEditor(imageSrc, imageType);
          });
          container.appendChild(maskBtn);
        }
        
        return container;
      }
      
      // Create or update masked image carousel - Simple, clean implementation
      function createOrUpdateMaskedImageCarousel(originalSrc, maskedVersions, originalContainer) {
        // Check if carousel already exists
        let carousel = originalContainer && originalContainer.classList.contains('masked-image-carousel') 
          ? originalContainer 
          : null;
        
        // If carousel exists, append new items instead of recreating
        if (carousel) {
          const track = carousel.querySelector('.masked-image-carousel-track');
          
          if (track) {
            // Get current number of items (original + existing masked versions)
            const currentItemCount = track.querySelectorAll('.masked-image-carousel-item').length;
            const newMaskedVersions = maskedVersions.slice(currentItemCount - 1); // Get only new versions
            
            // Add new masked versions
            newMaskedVersions.forEach((maskedImage, index) => {
              // Ensure maskedImage is actually a URL string, not undefined or the original
              if (!maskedImage) {
                console.error('Invalid masked image URL:', maskedImage, 'for index', index);
                return; // Skip invalid entries
              }
              const maskedItem = document.createElement('div');
              maskedItem.className = 'masked-image-carousel-item';
              const maskedImageContainer = createAIImageWithDownload(
                maskedImage,
                getPdfAlt('editedImage', { suffix: imageCountSuffix(currentItemCount + index, maskedVersions.length) }),
                'masked-edit'
              );
              maskedItem.appendChild(maskedImageContainer);
              track.appendChild(maskedItem);
              
              // Add next button to the new image container
              const nextBtn = document.createElement('button');
              nextBtn.className = 'masked-image-carousel-nav next';
              nextBtn.innerHTML = '›';
              nextBtn.setAttribute('aria-label', 'Next image');
              maskedImageContainer.appendChild(nextBtn);
              
              // Add click handler - use carousel's updateCarousel function
              nextBtn.addEventListener('click', () => {
                if (carousel._updateCarousel && carousel._getCurrentIndex && carousel._setCurrentIndex) {
                  let currentIdx = carousel._getCurrentIndex();
                  const items = track.querySelectorAll('.masked-image-carousel-item');
                  const totalItemsCount = items.length;
                  
                  if (currentIdx < totalItemsCount - 1) {
                    currentIdx++;
                    carousel._setCurrentIndex(currentIdx);
                    carousel._updateCarousel();
                  }
                }
              });
            });
            
            // Update dots in all image containers to include new items
            const totalItems = 1 + maskedVersions.length;
            const allImageContainers = track.querySelectorAll('.ai-image-container');
            allImageContainers.forEach((container) => {
              let containerDots = container.querySelector('.masked-image-carousel-dots');
              if (!containerDots) {
                containerDots = document.createElement('div');
                containerDots.className = 'masked-image-carousel-dots';
                container.appendChild(containerDots);
              }
              
              const currentDotCount = containerDots.querySelectorAll('.masked-image-carousel-dot').length;
              for (let i = currentDotCount; i < totalItems; i++) {
                const dot = document.createElement('button');
                dot.className = 'masked-image-carousel-dot';
                dot.setAttribute('aria-label', `Go to image ${i + 1}`);
                containerDots.appendChild(dot);
                
                // Add click handler - use carousel's updateCarousel function
                dot.addEventListener('click', () => {
                  if (carousel._setCurrentIndex && carousel._updateCarousel) {
                    carousel._setCurrentIndex(i);
                    carousel._updateCarousel();
                  }
                });
              }
            });
            
            // Move to the most recent image (last item) and update arrow states
            const newTotalItems = track.querySelectorAll('.masked-image-carousel-item').length;
            const newCurrentIndex = newTotalItems - 1;
            
            // Update carousel state and move to new item
            if (carousel._setCurrentIndex && carousel._updateCarousel) {
              carousel._setCurrentIndex(newCurrentIndex);
            } else {
              // Fallback: directly update if functions not available
              if (track) {
                track.style.transform = `translateX(-${newCurrentIndex * 100}%)`;
                
                // Update dots in all containers
                const allItems = track.querySelectorAll('.masked-image-carousel-item');
                allItems.forEach((item) => {
                  const itemDots = item.querySelector('.masked-image-carousel-dots');
                  if (itemDots) {
                    itemDots.querySelectorAll('.masked-image-carousel-dot').forEach((dot, idx) => {
                      dot.classList.toggle('active', idx === newCurrentIndex);
                    });
                  }
                });
                
                // Update nav buttons
                const prevBtn = carousel.querySelector('.masked-image-carousel-nav.prev');
                if (prevBtn) prevBtn.disabled = newCurrentIndex === 0;
                track.querySelectorAll('.masked-image-carousel-nav.next').forEach((btn) => {
                  btn.disabled = newCurrentIndex === newTotalItems - 1;
                });
              }
            }
            
            return carousel; // Return existing carousel with new items added
          }
        }
        
        // Create new carousel if it doesn't exist
        if (!carousel) {
          carousel = document.createElement('div');
          carousel.className = 'masked-image-carousel';
        } else {
          carousel.innerHTML = '';
        }
        
        // Create viewport (only as wide as image)
        const viewport = document.createElement('div');
        viewport.className = 'masked-image-carousel-viewport';
        
        const track = document.createElement('div');
        track.className = 'masked-image-carousel-track';
        
        // Add navigation arrows (will be positioned relative to visible image)
        const prevBtn = document.createElement('button');
        prevBtn.className = 'masked-image-carousel-nav prev';
        prevBtn.innerHTML = '‹';
        prevBtn.setAttribute('aria-label', 'Previous image');
        
        const nextBtn = document.createElement('button');
        nextBtn.className = 'masked-image-carousel-nav next';
        nextBtn.innerHTML = '›';
        nextBtn.setAttribute('aria-label', 'Next image');
        
        // Add original image as first item
        const originalItem = document.createElement('div');
        originalItem.className = 'masked-image-carousel-item';
        const originalImageContainer = createAIImageWithDownload(originalSrc, getPdfAlt('originalCarouselImage'), 'original');
        originalItem.appendChild(originalImageContainer);
        track.appendChild(originalItem);
        
        // Add all masked versions
        maskedVersions.forEach((maskedImage, index) => {
          const maskedItem = document.createElement('div');
          maskedItem.className = 'masked-image-carousel-item';
          // Ensure maskedImage is actually a URL string
          if (!maskedImage) {
            console.error('Invalid masked image URL (undefined) for index', index);
            return; // Skip invalid entries
          }
          if (maskedImage === originalSrc) {
            console.warn('Masked image is same as original for index', index, '- this might be an issue');
          }
          console.log('Adding masked version', index + 1, ':', maskedImage.substring(0, 50) + '...');
          const maskedImageContainer = createAIImageWithDownload(
            maskedImage,
            getPdfAlt('editedImage', { suffix: imageCountSuffix(index, maskedVersions.length) }),
            'masked-edit'
          );
          maskedItem.appendChild(maskedImageContainer);
          track.appendChild(maskedItem);
        });
        
        viewport.appendChild(track);
        viewport.appendChild(prevBtn);
        carousel.appendChild(viewport);
        
        // Add next button and dots to each image container (positioned inside the image)
        const allImageContainers = track.querySelectorAll('.ai-image-container');
        const totalItems = 1 + maskedVersions.length; // Original + masked versions
        
        allImageContainers.forEach((container) => {
          // Add next button
          const nextBtnClone = nextBtn.cloneNode(true);
          container.appendChild(nextBtnClone);
          
          // Add click handler to each clone
          nextBtnClone.addEventListener('click', () => {
            if (currentIndex < totalItemsCount - 1) {
              currentIndex++;
              updateCarousel();
            }
          });
          
          // Add dots indicator
          const dots = document.createElement('div');
          dots.className = 'masked-image-carousel-dots';
          
          for (let i = 0; i < totalItems; i++) {
            const dot = document.createElement('button');
            dot.className = 'masked-image-carousel-dot';
            if (i === 0) dot.classList.add('active');
            dot.setAttribute('aria-label', `Go to image ${i + 1}`);
            dots.appendChild(dot);
          }
          
          container.appendChild(dots);
        });
        
        // Carousel functionality
        let currentIndex = 0;
        let items = track.querySelectorAll('.masked-image-carousel-item');
        let totalItemsCount = items.length;
        
        function updateCarousel() {
          // Refresh items count in case new items were added
          items = track.querySelectorAll('.masked-image-carousel-item');
          totalItemsCount = items.length;
          
          // Move track to show current item
          track.style.transform = `translateX(-${currentIndex * 100}%)`;
          
          // Update dots in all image containers
          items.forEach((item) => {
            const itemDots = item.querySelector('.masked-image-carousel-dots');
            if (itemDots) {
              itemDots.querySelectorAll('.masked-image-carousel-dot').forEach((dot, index) => {
                dot.classList.toggle('active', index === currentIndex);
              });
            }
          });
          
          // Update nav buttons
          prevBtn.disabled = currentIndex === 0;
          
          // Update all next buttons (they're inside each image container)
          const allNextButtons = track.querySelectorAll('.masked-image-carousel-nav.next');
          allNextButtons.forEach((btn) => {
            btn.disabled = currentIndex === totalItemsCount - 1;
          });
        }
        
        // Store updateCarousel function on carousel for access when appending
        carousel._updateCarousel = updateCarousel;
        carousel._getCurrentIndex = () => currentIndex;
        carousel._setCurrentIndex = (idx) => { 
          currentIndex = idx;
          updateCarousel();
        };
        
        // Navigation handlers
        prevBtn.addEventListener('click', () => {
          if (currentIndex > 0) {
            currentIndex--;
            updateCarousel();
          }
        });
        
        // Next button click is handled by the clones inside image containers
        
        // Dot navigation - attach to dots in all image containers
        items.forEach((item) => {
          const itemDots = item.querySelector('.masked-image-carousel-dots');
          if (itemDots) {
            itemDots.querySelectorAll('.masked-image-carousel-dot').forEach((dot, index) => {
              dot.addEventListener('click', () => {
                currentIndex = index;
                updateCarousel();
              });
            });
          }
        });
        
        // Touch/swipe support
        let touchStartX = 0;
        let touchEndX = 0;
        
        viewport.addEventListener('touchstart', (e) => {
          touchStartX = e.changedTouches[0].screenX;
        });
        
        viewport.addEventListener('touchend', (e) => {
          touchEndX = e.changedTouches[0].screenX;
          const diff = touchStartX - touchEndX;
          const swipeThreshold = 50;
          
          if (Math.abs(diff) > swipeThreshold) {
            if (diff > 0 && currentIndex < totalItemsCount - 1) {
              currentIndex++;
              updateCarousel();
            } else if (diff < 0 && currentIndex > 0) {
              currentIndex--;
              updateCarousel();
            }
          }
        });
        
        // Initialize - if there are masked versions, start at the most recent (last) one
        if (maskedVersions.length > 0) {
          currentIndex = maskedVersions.length; // Last item (original is index 0, so last masked version is at length)
        }
        updateCarousel();
        
        return carousel;
      }
      
