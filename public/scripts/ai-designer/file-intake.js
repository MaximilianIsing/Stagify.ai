// File-intake island for the AI Designer chat.
//
// Every path a file enters the chat: the picker, drag-and-drop on the chat
// area, paste-from-clipboard, HEIC conversion, validation (type/size/count
// caps) and the preview chip list. Lifted verbatim from the entry
// (scripts/ai-designer-app.js) as a factory that self-wires its listeners at
// creation. One in-body change vs the entry version: handleFiles calls
// updateSendButtonState() unconditionally (the old `if (!isProcessing)` guard
// was redundant — while processing, updateSendButtonState re-asserts the same
// enabled Stop-button state that setProcessing(true) pinned).
//
// deps: { selectedFiles, chatMessages, chatContainer, chatInput, fileInput,
//         updateSendButtonState }  ->  returns { updateFilePreview }
// selectedFiles is the entry's const array, mutated in place (push/splice).
// Window globals (StagifyHeic) are referenced directly.
import { formatFileSize } from './format.js';
import { getPdfAlt } from './i18n.js';
import { showToast } from './toast.js';

      const MAX_UPLOAD_FILES = 5;
      // Per-file size cap (mirrors the server's 50MB chat-upload limit, kept a
      // bit lower so we reject before a long upload that the server would drop).
      const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB
      const ALLOWED_UPLOAD_EXTS = ['.pdf', '.txt', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.webp', '.gif'];

export function createFileIntake(deps) {
  const {
    selectedFiles,
    chatMessages,
    chatContainer,
    chatInput,
    fileInput,
    updateSendButtonState,
  } = deps;

      let dragCounter = 0; // Track drag enter/leave events to handle nested elements

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
        updateSendButtonState();

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
                                     /** @type {HTMLInputElement} */ (activeElement).type !== 'file';

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

      // Update send button when files are added/removed
      const originalUpdateFilePreview = updateFilePreview;
      updateFilePreview = function() {
        originalUpdateFilePreview();
        updateSendButtonState();
      };

  return { updateFilePreview };
}
