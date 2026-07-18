import {
  getFileStem,
  messageTypeFromTag,
} from './ai-designer/format.js';
import {
  pickPreferredRoomImageIndex,
  collectImagesFromConversationHistory as _collectImagesFromConversationHistory,
  getBaseImageIndexForRequest as _getBaseImageIndexForRequest,
  resolveStagingRootBaseName as _resolveStagingRootBaseName,
} from './ai-designer/image-history.js';
import { lang } from './ai-designer/i18n.js';
import { localizedTarget } from './i18n-routing.js';
import { showToast } from './ai-designer/toast.js';
import { createMaskEditor } from './ai-designer/mask-editor.js';
import { createImageViewer } from './ai-designer/image-viewer.js';
import { createChatMessages } from './ai-designer/chat-messages.js';
import { createThumbnailStrip } from './ai-designer/thumbnail-strip.js';
import { createFileIntake } from './ai-designer/file-intake.js';
import { createChatResponse } from './ai-designer/chat-response.js';

      const chatMessages = document.getElementById('chat-messages');
      const chatInput = /** @type {HTMLTextAreaElement} */ (document.getElementById('chat-input'));
      const sendBtn = /** @type {HTMLButtonElement} */ (document.getElementById('send-btn'));
      const fileInput = document.getElementById('file-input');
      const chatContainer = document.querySelector('.chat-container');
      
      let conversationHistory = [];
      const selectedFiles = []; // File-intake island mutates this in place
      let isProcessing = false; // Track if we're currently processing a message
      let currentAbortController = null; // Lets the user stop an in-flight generation
      let pendingStagingRootBaseName = null;

      // Thin wrappers over the pure image-history module (scripts/ai-designer/
      // image-history.js): bind the live conversationHistory (and the thumbnail
      // strip's selection via its getter — called at use time, so declaring the
      // strip below is safe) so the call sites stay unchanged. Logic + tests
      // live in that module.
      const collectImagesFromConversationHistory = () =>
        _collectImagesFromConversationHistory(conversationHistory);
      const getBaseImageIndexForRequest = () =>
        _getBaseImageIndexForRequest(conversationHistory, getSelectedImageIndex());
      const resolveStagingRootBaseName = (filesToSend) =>
        _resolveStagingRootBaseName(filesToSend, conversationHistory, getSelectedImageIndex());

      // Image-viewer island (scripts/ai-designer/image-viewer.js): the enlarge
      // modal, downloads, AI-image containers and the masked-image carousel.
      // openMaskEditor is late-bound (arrow) — the mask-editor island is only
      // created below, and the dep fires on click, never at load.
      const {
        openImageModal,
        closeImageModal,
        createAIImageWithDownload,
        createOrUpdateMaskedImageCarousel,
      } = createImageViewer({
        openMaskEditor: (imageSrc, imageType) => openMaskEditor(imageSrc, imageType),
      });
      // The image modal's close handlers live in the classic (non-module)
      // ai-designer-model-selector.js, which can't reach this module's scope,
      // so expose the closer on window.
      window.closeImageModal = closeImageModal;

      // Chat-message island (scripts/ai-designer/chat-messages.js): message
      // bubbles, error bubbles with Retry, typing + image-loading indicators.
      const {
        addMessage,
        addErrorMessage,
        showTypingIndicator,
        removeTypingIndicator,
        showMessageImageLoading,
        removeMessageImageLoading,
        getLastAssistantContentEl,
        updateLastAssistantText,
      } = createChatMessages({ chatMessages, openImageModal });

      // Thumbnail-strip island (scripts/ai-designer/thumbnail-strip.js): the
      // base-image picker; owns selectedImageIndex behind the getter/setter.
      const { syncImageThumbnailStrip, getSelectedImageIndex, setSelectedImageIndex } =
        createThumbnailStrip({ collectImagesFromConversationHistory });

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

      // File-intake island (scripts/ai-designer/file-intake.js): picker, drag-
      // and-drop, paste, HEIC conversion and the preview chip list; self-wires
      // its listeners and mutates selectedFiles in place.
      const { updateFilePreview } = createFileIntake({
        selectedFiles,
        chatMessages,
        chatContainer,
        chatInput,
        fileInput,
        updateSendButtonState,
      });

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
          window.location.replace(localizedTarget('index.html#ai-designer-demo'));
          return false;
        }
        await window.StagifyAuth.fetchMe();
        const u = window.StagifyAuth.user;
        if (!u || u.plan !== 'pro') {
          window.location.replace(localizedTarget('index.html#ai-designer-demo'));
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
        setSelectedImageIndex(null);
        syncImageThumbnailStrip();
        
        // Clear chat messages
        chatMessages.innerHTML = '';
        
        // Clear file selection
        selectedFiles.length = 0;
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
        const focusables = /** @type {HTMLElement[]} */ (Array.from(
          modal.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')
        )).filter((el) => el.offsetParent !== null || el === document.activeElement);
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

      // Initialize send button state
      updateSendButtonState();

      // Chat-response island (scripts/ai-designer/chat-response.js): turns the
      // server's SSE/JSON reply into messages, history entries and image cards.
      // handleChatFetchResponse keeps its name so sendMessage's call is unchanged.
      const { handleChatFetchResponse } = createChatResponse({
        addMessage, addErrorMessage, updateLastAssistantText, getLastAssistantContentEl,
        showMessageImageLoading, removeMessageImageLoading, removeTypingIndicator,
        createAIImageWithDownload, syncImageThumbnailStrip, collectImagesFromConversationHistory,
        getConversationHistory: () => conversationHistory,
        getPendingStagingRootBaseName: () => pendingStagingRootBaseName,
        setPendingStagingRootBaseName: (v) => { pendingStagingRootBaseName = v; },
      });

      
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
        selectedFiles.length = 0;
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
            setSelectedImageIndex(pickPreferredRoomImageIndex(imagesForPick));
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
                  const err = /** @type {Error & { response?: Response }} */ (new Error('HTTP ' + response.status));
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
      
      // Initialize send button state
      updateSendButtonState();
      
