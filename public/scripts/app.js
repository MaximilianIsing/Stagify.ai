import { dataURLToFile, fillTemplate, dailyLimitMessage, roomDownloadSlug } from './app/helpers.js';
import { createStageMaskEditor } from './app/stage-mask-editor.js';
import { initCustomSelect } from './app/custom-select.js';
import { initBackgroundVideoSync } from './app/background-video.js';
import { init3DTiltEffect } from './app/tilt-effect.js';
import { loadHeroStats, updateHeroFreeGensLine } from './app/hero-stats.js';
import { validateStageableUpload } from './app/stage-validation.js';
import { createFurnitureRefs, FURNITURE_LIMIT } from './app/furniture-refs.js';
import { createVersionCarousel } from './app/version-carousel.js';

    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  
    initBackgroundVideoSync();
  
    const canvas1 = $('#canvas1');
    const downloadBtn = $('#download-btn');
    const newUploadBtn = $('#new-upload');
    const imageViewerContainer = $('#image-viewer-container');
    const processingPlaceholder = $('#processing-placeholder');
    const toggleBeforeBtn = $('#toggle-before');
    const toggleAfterBtn = $('#toggle-after');
    const maskEditBtn = $('#mask-edit-btn');
    const carouselPrev = $('#carousel-prev');
    const carouselNext = $('#carousel-next');
    const carouselDots = $('#carousel-dots');
    const emptyRoomBtn = $('#empty-room-btn');
    const emptyRoomModal = $('#empty-room-modal');
    const emptyRoomImage = $('#empty-room-image');
    const emptyRoomClose = $('#empty-room-close');
    const emptyRoomDownload = $('#empty-room-download');
    // Set when a staging job used "remove existing furniture" and the server
    // returned the intermediate emptied room. Null otherwise.
    let lastEmptyRoomUrl = null;

    // "Keep furniture" box only appears while remove-existing-furniture is checked.
    const removeFurnitureCheckbox = $('#remove-furniture');
    const keepFurnitureRow = $('#keep-furniture-row');
    function syncRemoveFurnitureUI() {
      const on = !!(removeFurnitureCheckbox && removeFurnitureCheckbox.checked);
      if (keepFurnitureRow) keepFurnitureRow.classList.toggle('hidden', !on);
      // Two-stage removal can't produce variations from a single empty room, so
      // when it's on we hide the Image Generations slider and pin it to 1.
      const variationRow = $('#variation-row');
      const variationSlider = $('#stagify-variation-count');
      if (variationRow) variationRow.classList.toggle('hidden', on);
      if (on && variationSlider && variationSlider.value !== '1') {
        variationSlider.value = '1';
        variationSlider.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    if (removeFurnitureCheckbox) removeFurnitureCheckbox.addEventListener('change', syncRemoveFurnitureUI);
    syncRemoveFurnitureUI();

    const heroUpload = $('#hero-upload');
    const navUpload = $('#nav-upload');
    const pricingUpload = $('#pricing-upload');
    // Carousel is now handled by carousel.js
    
  
    // Stage screen elements (only on home page)
    const modal = $('#stage-modal');
    const modalBackdrop = $('#modal-backdrop');
    const modalClose = $('#modal-close');
    const stageDropzone = $('#stage-dropzone');
    const stageFileInput = $('#stage-file-input');
    const stagePreview = $('#stage-preview');
    const processBtn = $('#process-btn');
    const additionalPrompt = $('#additional-prompt');
    // Custom selects
    const roomSelect = initCustomSelect('#room-type-select');
    const styleSelect = initCustomSelect('#furniture-style-select');
    const progress = $('#progress');
    const progressBar = $('#progress-bar');
    const progressText = $('#progress-text');
    const loadingMessage = $('#loading-message');
    const stagingLimitViewer = $('#staging-limit-viewer');
    const stagingLimitViewerText = $('#staging-limit-viewer-text');
    const stagingErrorViewer = $('#staging-error-viewer');
    const stagingErrorViewerText = $('#staging-error-viewer-text');
    const stagingErrorRetryBtn = $('#staging-error-retry-btn');

    function showStagingError(message) {
      if (stagingErrorViewerText) stagingErrorViewerText.textContent = message || '';
      if (stagingErrorViewer) stagingErrorViewer.classList.remove('hidden');
    }
    function hideStagingError() {
      if (stagingErrorViewer) stagingErrorViewer.classList.add('hidden');
    }

    function getStagingAlt(key, replacements = {}) {
      const text = window.LanguageSystem?.getText('modal.staging.' + key) || '';
      return fillTemplate(text, replacements);
    }

    function updateStagedCanvasAria(suffix = '') {
      if (!canvas1) return;
      canvas1.setAttribute('role', 'img');
      canvas1.setAttribute('aria-label', getStagingAlt('stagedResultAlt', { suffix }));
    }

    if (stagingErrorRetryBtn) {
      stagingErrorRetryBtn.addEventListener('click', () => {
        hideStagingError();
        // Trigger the file picker so the user can upload a new image
        if (stageFileInput) stageFileInput.click();
      });
    }
    // Furniture reference photos live in their own island (scripts/app/furniture-refs.js);
    // the entry reads the accumulated files via getFiles() and resets them on new upload.
    const furnitureRefs = createFurnitureRefs({ getStagingAlt });

    function hideStagingLimitInViewer() {
      if (stagingLimitViewer) stagingLimitViewer.classList.add('hidden');
      hideStagingError();
    }

    function showStagingLimitInViewer(message) {
      if (stagingLimitViewerText) stagingLimitViewerText.textContent = message || '';
      if (stagingLimitViewer) stagingLimitViewer.classList.remove('hidden');
      if (window.LanguageSystem && typeof window.LanguageSystem.applyLanguageToElements === 'function') {
        window.LanguageSystem.applyLanguageToElements();
      }
    }

    function messageForDailyLimitResponse(errorData) {
      const hasAccount = !!(window.StagifyAuth && window.StagifyAuth.getToken());
      const key = hasAccount ? 'errors.dailyLimitFree' : 'errors.dailyLimitAnonymous';
      const template = window.LanguageSystem?.getText(key);
      return dailyLimitMessage(errorData, { template });
    }
  
    const yearSpan = $('#year');
    if (yearSpan) yearSpan.textContent = new Date().getFullYear();

    // Version carousels: the before view holds the uploaded photo plus any
    // masked edits of it; the after view holds the staged result(s) plus any
    // masked refinements. Each is capped so the 6th mask attempt is blocked.
    const MAX_MASK_VERSIONS = 6;

    function isMobileStagingViewport() {
      return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 768px)').matches;
    }

    // ── Mask image-processing core (shared) ───────────────────────────────────
    // The mask canvas math (brush-grow, model mask, feathered blend mask,
    // composite) lives once in scripts/mask-core.js and is imported directly by
    // the stage mask editor island (scripts/app/stage-mask-editor.js).

    function openFilePicker() {
      const hasTok = window.StagifyAuth && window.StagifyAuth.getToken();
      if (!hasTok) {
        // Not signed in: prompt sign-in immediately on every device. (Previously
        // mobile fell through to openModal(), letting anonymous users upload and
        // stage for free without ever being asked to create an account.)
        if (window.StagifyProfileMenu && window.StagifyProfileMenu.setAuthModeRegister) {
          window.StagifyProfileMenu.setAuthModeRegister(true);
        }
        if (window.StagifyProfileMenu && window.StagifyProfileMenu.openAuthModal) {
          window.StagifyProfileMenu.openAuthModal(true);
        } else if (typeof window.__stagifyOpenAuthForStaging === 'function') {
          window.__stagifyOpenAuthForStaging();
        }
        return;
      }
      window.StagifyAuth.fetchMe().then(() => {
        window.StagifyAuth.applyUserToUI();
        updateMaskButtonVisibility();
      });
      openModal();
    }
  
    // Only run modal functionality if we're on the home page (elements exist)
    if (modal && stageDropzone && stageFileInput) {
      [heroUpload, navUpload, pricingUpload].forEach((btn) => {
        if (btn) btn.addEventListener('click', openFilePicker);
      });
  
      // Example thumbnails to load sample images
      $$('.thumb').forEach((btn) => {
        btn.addEventListener('click', () => {
          openModal();
          const src = btn.getAttribute('data-src');
          stagePreview.src = src;
          stagePreview.alt = getStagingAlt('sampleRoomAlt');
          stagePreview.classList.remove('hidden');
          $('.stage-dz-inner').classList.add('hidden');
        });
      });
  
      // Drag and drop on stage screen
      ;['dragenter','dragover'].forEach(evt => {
        stageDropzone.addEventListener(evt, (e) => { e.preventDefault(); stageDropzone.style.borderColor = '#000'; });
      });
      ;['dragleave','drop'].forEach(evt => {
        stageDropzone.addEventListener(evt, (e) => { e.preventDefault(); stageDropzone.style.borderColor = '#e8e8e8'; });
      });
      stageDropzone.addEventListener('click', () => { stageFileInput.click(); });
      stageDropzone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); stageFileInput.click(); }
      });
      stageDropzone.addEventListener('drop', (e) => {
        const file = e.dataTransfer.files?.[0];
        if (file) handleStageFile(file);
      });
      stageFileInput.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (file) handleStageFile(file);
      });

      const variationSlider = document.getElementById('stagify-variation-count');
      const variationValueEl = document.getElementById('stagify-variation-value');
      if (variationSlider && variationValueEl) {
        const syncVariationLabel = () => {
          const v = /** @type {HTMLInputElement} */ (variationSlider).value;
          variationValueEl.textContent = v;
          variationSlider.setAttribute('aria-valuenow', v);
        };
        variationSlider.addEventListener('input', syncVariationLabel);
        syncVariationLabel();
      }
    }
  
    let currentImageFile = null;
    let hasProcessedImage = false;

    // Stageability pre-check: the moment a room photo is chosen we ask the server
    // (a cheap GPT-vision pass) whether it's actually a stageable room/property.
    // The in-flight promise is stored so stageImage() can hard-block on a
    // rejection, and a rejection is also surfaced immediately over the preview.
    // Fails OPEN so our own hiccup never blocks a legitimate upload.
    let stageValidation = null;
    // Synchronously-readable result once the pre-check resolves (null while it is
    // still in flight). Lets processWithAI() gate WITHOUT awaiting in the common
    // case — the check starts at upload, so it is almost always done by click.
    let stageValidationResult = null;
    const DEFAULT_UNSTAGEABLE_MESSAGE =
      "This doesn't look like a room, space, or piece of furniture. Please upload a photo of an interior room, exterior space, or furniture you'd like to stage.";

    async function handleStageFile(file) {
      // iPhone HEIC/HEIF photos aren't decodable by most browsers; convert to
      // JPEG first so the preview and on-canvas editing work everywhere.
      if (window.StagifyHeic && window.StagifyHeic.isHeic(file)) {
        try {
          file = await window.StagifyHeic.toDisplayableFile(file);
        } catch (e) {
          alert(window.LanguageSystem?.getText('errors.heicConvert') || "We couldn't read that HEIC photo. Please try a JPG or PNG.");
          return;
        }
      }
      const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
      if (!allowedTypes.includes(file.type)) {
        alert(window.LanguageSystem?.getText('errors.fileType') || 'Please upload a PNG, JPG, JPEG, WebP, or GIF image file.');
        return;
      }
      
      // Check file size (100MB limit)
      const maxSize = 100 * 1024 * 1024; // 100MB in bytes
      if (file.size > maxSize) {
        alert(window.LanguageSystem?.getText('errors.fileTooLarge') || 'File is too large. Please upload an image smaller than 100MB.');
        return;
      }
      
      currentImageFile = file; // Store the file for processing
      hasProcessedImage = false; // Reset processing state for new image
      hideStagingLimitInViewer();
      const reader = new FileReader();
      reader.onload = () => {
        stagePreview.src = reader.result;
        // Seed the before carousel with the original photo; reset the after carousel.
        setBeforeVersions([reader.result]);
        setAfterVersions([]);
        stagePreview.alt = getStagingAlt('uploadedRoomAlt', {
          filenameSuffix: file.name ? ': ' + file.name : '',
        });
        // Show image viewer, hide upload zone
        stageDropzone.classList.add('hidden');
        imageViewerContainer.classList.remove('hidden');
        // Hide placeholder and show the uploaded image
        processingPlaceholder.style.display = 'none';
        canvas1.classList.add('hidden');
        // Reset to "Before" view
        showBeforeView();

        // Kick off the stageability pre-check for this upload. It runs while the
        // user reviews the photo and picks options, so it's normally done long
        // before Process — and it runs concurrently with the generation anyway
        // (see processWithAI), so it adds no wait. If it comes back invalid,
        // surface the reason over the preview right away. Guard on the captured
        // file so a fast re-upload can't show a stale rejection.
        hideStagingError();
        const checkForFile = file;
        stageValidationResult = null;
        stageValidation = validateStageableUpload(reader.result);
        stageValidation.then((r) => {
          const result = r || { valid: true, reason: '' };
          if (currentImageFile === checkForFile) {
            stageValidationResult = result;
            if (result.valid === false) {
              showStagingError(result.reason || DEFAULT_UNSTAGEABLE_MESSAGE);
            }
          }
        });
      };
      reader.readAsDataURL(file);
    }
  
    async function processWithAI(imageFile) {
      hideStagingLimitInViewer();
      hideStagingError();

      stagePreview.classList.add('processing');
      showBeforeView();

      const formData = new FormData();
      formData.append('image', imageFile);
      formData.append('roomType', roomSelect?.value || 'Living room');
      formData.append('furnitureStyle', styleSelect?.value || 'standard');
      formData.append('additionalPrompt', additionalPrompt?.value || '');

      const removeFurnitureCheckbox = /** @type {HTMLInputElement} */ (document.getElementById('remove-furniture'));
      const removeChecked = removeFurnitureCheckbox?.checked || false;
      formData.append('removeFurniture', String(removeChecked));
      const keepFurnitureEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('keep-furniture'));
      formData.append('keepFurniture', (removeChecked && keepFurnitureEl?.value) ? keepFurnitureEl.value.trim() : '');

      const userRole = localStorage.getItem('userRole') || 'unknown';
      const userReferralSource = localStorage.getItem('userReferralSource') || '';
      const userEmail = localStorage.getItem('userEmail') || '';
      formData.append('userRole', userRole);
      formData.append('userReferralSource', userReferralSource);
      formData.append('userEmail', userEmail);

      const tok = window.StagifyAuth && window.StagifyAuth.getToken();
      if (tok) formData.append('authToken', tok);

      const proPanel = document.getElementById('stagify-pro-panel');
      const proPanelUsable =
        proPanel &&
        !proPanel.classList.contains('hidden') &&
        window.getComputedStyle(proPanel).display !== 'none' &&
        window.getComputedStyle(proPanel).visibility !== 'hidden';
      if (isProUser() && proPanelUsable) {
        const modelSel = /** @type {HTMLSelectElement} */ (document.getElementById('stagify-model-select'));
        const varSel = /** @type {HTMLInputElement} */ (document.getElementById('stagify-variation-count'));
        if (modelSel) formData.append('model', modelSel.value || 'gpt-4o-mini');
        if (varSel) formData.append('variationCount', varSel.value || '1');
        const furnitureFiles = furnitureRefs.getFiles();
        if (furnitureFiles.length) {
          const n = Math.min(FURNITURE_LIMIT, furnitureFiles.length);
          for (let i = 0; i < n; i++) {
            formData.append('furnitureImage', furnitureFiles[i]);
          }
        }
      }

      // Pro: upload/prepare animation before fetch. Free: progress bar during fetch (no delay) for fast limit errors.
      const isProPlan = isProUser();

      const defaultLoadingLines = [
        'Finding the perfect furniture for you',
        'Staging your ideal room',
        'Selecting beautiful decor pieces',
        'Arranging furniture for maximum appeal',
        'Creating the perfect ambiance',
        'Enhancing your space with style',
        'Designing your dream interior',
        'Optimizing room layout and flow',
        'Adding finishing touches',
        'Bringing your vision to life',
      ];
      const loadingMessagesRaw = window.LanguageSystem?.getText('modal.staging.progress.loadingMessages');
      const messagesArray = Array.isArray(loadingMessagesRaw) ? loadingMessagesRaw : defaultLoadingLines;

      let progressInterval = null;
      let aiProgressInterval = null;
      let messageInterval = null;
      let phaseTimer = null;
      let isProcessingPhase = false;
      let currentProgress = 0;

      function clearStagingUiTimers() {
        if (progressInterval) clearInterval(progressInterval);
        if (aiProgressInterval) clearInterval(aiProgressInterval);
        if (messageInterval) clearInterval(messageInterval);
        if (phaseTimer) clearTimeout(phaseTimer);
        progressInterval = null;
        aiProgressInterval = null;
        messageInterval = null;
        phaseTimer = null;
        isProcessingPhase = false;
      }

      // Stageability pre-check came back invalid → tear the loading UI back down
      // and surface the reason. Thrown so stageImage()'s catch re-enables the
      // button; the message is already on screen via showStagingError.
      function rejectUnstageable(reason) {
        clearStagingUiTimers();
        stagePreview.classList.remove('processing');
        loadingMessage.classList.add('hidden');
        progress.classList.add('hidden');
        progressBar.style.width = '0%';
        showStagingError(reason || DEFAULT_UNSTAGEABLE_MESSAGE);
        const err = /** @type {Error & { code?: string }} */ (new Error(reason || DEFAULT_UNSTAGEABLE_MESSAGE));
        err.code = 'NOT_STAGEABLE';
        throw err;
      }

      // Fast path: if the pre-check already finished (the usual case — it starts
      // at upload), honor a rejection NOW, before spending a generation. If it's
      // still in flight we don't wait: staging runs below while the check finishes
      // concurrently. Net cost of the check on a valid photo: zero added wait.
      if (stageValidationResult && stageValidationResult.valid === false) {
        rejectUnstageable(stageValidationResult.reason);
      }

      // If the check is still running, watch it: the moment it rejects the photo,
      // ABORT the in-flight generation and stop the loading bar — don't wait for
      // the generation to finish. The fetch below is wired to this signal, and its
      // catch turns the abort into the friendly "not stageable" rejection.
      const genAbort = new AbortController();
      /** @type {{ valid?: boolean, reason?: string } | null} */
      let validationRejection = null;
      if (stageValidation && !stageValidationResult) {
        stageValidation.then((r) => {
          if (r && r.valid === false) {
            validationRejection = r;
            genAbort.abort();
          }
        });
      }

      let response;
      if (isProPlan) {
        progress.classList.remove('hidden');
        progressBar.style.width = '0%';
        progressText.textContent =
          window.LanguageSystem?.getText('modal.staging.progress.uploading') || 'Uploading image…';

        loadingMessage.classList.remove('hidden');
        loadingMessage.textContent =
          window.LanguageSystem?.getText('modal.staging.progress.preparingAI') || 'Preparing AI model';

        currentProgress = 0;
        progressInterval = setInterval(() => {
          if (currentProgress < 15) {
            currentProgress += Math.random() * 3;
            progressBar.style.width = Math.min(currentProgress, 15) + '%';
          }
        }, 200);

        try {
          await new Promise((resolve) => setTimeout(resolve, 800));
        } catch (e) {
          clearStagingUiTimers();
          stagePreview.classList.remove('processing');
          loadingMessage.classList.add('hidden');
          progress.classList.add('hidden');
          throw e;
        }

        clearInterval(progressInterval);
        progressInterval = null;
        currentProgress = 25;
        progressBar.style.width = '25%';
        progressText.textContent =
          window.LanguageSystem?.getText('modal.staging.progress.preparingAI') || 'Preparing AI model…';

        phaseTimer = setTimeout(() => {
          isProcessingPhase = true;
          progressText.textContent =
            window.LanguageSystem?.getText('modal.staging.progress.staging') || 'AI is staging your room…';
          messageInterval = setInterval(() => {
            if (isProcessingPhase) {
              loadingMessage.textContent =
                messagesArray[Math.floor(Math.random() * messagesArray.length)];
            }
          }, 2000);
          loadingMessage.textContent = messagesArray[Math.floor(Math.random() * messagesArray.length)];
        }, 1000);

        aiProgressInterval = setInterval(() => {
          if (currentProgress < 70) {
            currentProgress += Math.random() * 2;
            progressBar.style.width = Math.min(currentProgress, 70) + '%';
          }
        }, 300);

        try {
          response = await fetch('/api/process-image', {
            method: 'POST',
            body: formData,
            signal: genAbort.signal,
          });
        } catch (e) {
          // Aborted because the pre-check rejected the photo mid-generation →
          // stop the bar and show the reason instead of a generic network error.
          if (validationRejection) rejectUnstageable(validationRejection.reason);
          clearStagingUiTimers();
          stagePreview.classList.remove('processing');
          loadingMessage.classList.add('hidden');
          progress.classList.add('hidden');
          throw e;
        }

        if (aiProgressInterval) {
          clearInterval(aiProgressInterval);
          aiProgressInterval = null;
        }
        currentProgress = Math.max(currentProgress, 75);
        progressBar.style.width = '75%';
        progressText.textContent =
          window.LanguageSystem?.getText('modal.staging.progress.staging') || 'AI is staging your room…';
      } else {
        progress.classList.remove('hidden');
        progressBar.style.width = '0%';
        progressText.textContent =
          window.LanguageSystem?.getText('modal.staging.progress.staging') || 'AI is staging your room…';

        loadingMessage.classList.remove('hidden');
        loadingMessage.textContent =
          window.LanguageSystem?.getText('modal.staging.progress.staging') || 'AI is staging your room…';

        currentProgress = 5;
        progressBar.style.width = '5%';
        isProcessingPhase = true;
        messageInterval = setInterval(() => {
          if (isProcessingPhase) {
            loadingMessage.textContent =
              messagesArray[Math.floor(Math.random() * messagesArray.length)];
          }
        }, 2000);

        aiProgressInterval = setInterval(() => {
          if (currentProgress < 70) {
            currentProgress += Math.random() * 2;
            progressBar.style.width = Math.min(currentProgress, 70) + '%';
          }
        }, 300);

        try {
          response = await fetch('/api/process-image', {
            method: 'POST',
            body: formData,
            signal: genAbort.signal,
          });
        } catch (e) {
          // Aborted because the pre-check rejected the photo mid-generation →
          // stop the bar and show the reason instead of a generic network error.
          if (validationRejection) rejectUnstageable(validationRejection.reason);
          clearStagingUiTimers();
          stagePreview.classList.remove('processing');
          loadingMessage.classList.add('hidden');
          progress.classList.add('hidden');
          throw e;
        }

        if (aiProgressInterval) {
          clearInterval(aiProgressInterval);
          aiProgressInterval = null;
        }
        currentProgress = Math.max(currentProgress, 75);
        progressBar.style.width = '75%';
      }

      if (!response.ok) {
        clearStagingUiTimers();
        stagePreview.classList.remove('processing');
        loadingMessage.classList.add('hidden');
        progress.classList.add('hidden');
        progressBar.style.width = '0%';
        const errorData = await response.json().catch(() => ({}));
        if (errorData.code === 'AUTH_REQUIRED') {
          const authErr = /** @type {Error & { code?: string }} */ (new Error(errorData.error || 'Please sign in to stage images.'));
          authErr.code = 'AUTH_REQUIRED';
          throw authErr;
        }
        if (errorData.code === 'DAILY_LIMIT' || response.status === 429) {
          const limitMsg = messageForDailyLimitResponse(errorData);
          showStagingLimitInViewer(limitMsg);
          const limitErr = /** @type {Error & { code?: string }} */ (new Error(limitMsg));
          limitErr.code = 'DAILY_LIMIT';
          throw limitErr;
        }
        if (errorData.code === 'FILE_TOO_LARGE') {
          throw new Error(
            window.LanguageSystem?.getText('errors.fileTooLarge') ||
              'File is too large. Please upload an image smaller than 100MB.'
          );
        }
        if (errorData.code === 'NO_IMAGE_GENERATED' || response.status === 422) {
          const msg = errorData.error || 'This image couldn\'t be staged. Please try a different photo of an interior room.';
          showStagingError(msg);
          const noImgErr = /** @type {Error & { code?: string }} */ (new Error(msg));
          noImgErr.code = 'NO_IMAGE_GENERATED';
          throw noImgErr;
        }
        const errMsg =
          response.status === 500
            ? window.LanguageSystem?.getText('errors.badPrompt') || 'Bad prompt inputted'
            : errorData.message ||
              errorData.error ||
              window.LanguageSystem?.getText('errors.processingFailed') ||
              'Processing failed';
        progress.classList.remove('hidden');
        progressBar.style.width = '0%';
        progressText.textContent =
          (window.LanguageSystem?.getText('modal.staging.progress.error') || 'Error: ') + errMsg;
        setTimeout(() => progress.classList.add('hidden'), 3000);
        throw new Error(errMsg);
      }

      // Result gate: the pre-check ran concurrently with the (much longer)
      // generation, so it has finished by the time the image comes back. If it
      // rejected the photo, discard the freshly-staged image instead of showing
      // it. Normally stageValidationResult is already set, so the await is just a
      // safety net for a sub-second click and adds no real time.
      if (stageValidation) {
        const finalCheck = stageValidationResult || (await stageValidation.catch(() => null));
        if (finalCheck && finalCheck.valid === false) {
          rejectUnstageable(finalCheck.reason);
        }
      }

      let finalProgressInterval = setInterval(() => {
        if (currentProgress < 95) {
          currentProgress += Math.random() * 3;
          progressBar.style.width = Math.min(currentProgress, 95) + '%';
        }
      }, 150);

      const result = await response.json();
      lastEmptyRoomUrl = (result && typeof result.emptyRoom === 'string' && result.emptyRoom) ? result.emptyRoom : null;

      if (finalProgressInterval) {
        clearInterval(finalProgressInterval);
      }
      clearStagingUiTimers();

      if (result.user && window.StagifyAuth) {
        window.StagifyAuth.user = result.user;
        window.StagifyAuth.applyUserToUI();
      }

      const urls =
        result.images && result.images.length > 0
          ? result.images
          : result.image
            ? [result.image]
            : [];

      loadingMessage.classList.add('hidden');
      stagePreview.classList.remove('processing');

      progress.classList.remove('hidden');
      progressBar.style.width = '100%';
      progressText.textContent =
        window.LanguageSystem?.getText('modal.staging.progress.complete') || 'Complete!';

      if (result.success && urls.length > 0) {
        hideStagingLimitInViewer();
        setTimeout(() => progress.classList.add('hidden'), 800);
        return urls;
      }

      if (processingPlaceholder && !hasProcessedImage) {
        processingPlaceholder.style.display = 'flex';
      }
      throw new Error(window.LanguageSystem?.getText('errors.noImageData') || 'No image data received');
    }
  
    // Toggle between Before and After views
    function isProUser() {
      if (window.StagifyAuth && typeof window.StagifyAuth.isProUser === 'function') {
        return window.StagifyAuth.isProUser();
      }
      const u = window.StagifyAuth && window.StagifyAuth.user;
      return !!(u && u.plan === 'pro');
    }

    function positionMaskFab() {
      if (!maskEditBtn || maskEditBtn.classList.contains('hidden')) return;
      // Anchor to whichever image is showing (canvas on After, photo on Before)
      const el = activeViewIsAfter() ? canvas1 : stagePreview;
      if (!el || !el.offsetHeight) return;
      const imageBottom = el.offsetTop + el.offsetHeight;
      const top = imageBottom - maskEditBtn.offsetHeight - 12;
      maskEditBtn.style.top = Math.max(top, 12) + 'px';
      maskEditBtn.style.bottom = 'auto';
    }

    function updateMaskButtonVisibility() {
      if (!maskEditBtn) return;
      const onAfter = activeViewIsAfter();
      const hasImage = !!(currentImageFile || (stagePreview && stagePreview.src));
      // The paint-brush FAB edits the staged result (After) or the original
      // photo (Before). Pro only.
      const show = isProUser() && (onAfter ? hasProcessedImage : hasImage);
      if (show) {
        maskEditBtn.classList.remove('hidden');
        positionMaskFab();
        requestAnimationFrame(positionMaskFab);
      } else {
        maskEditBtn.classList.add('hidden');
      }
    }

    function positionEmptyRoomFab() {
      if (!emptyRoomBtn || emptyRoomBtn.classList.contains('hidden')) return;
      if (!canvas1 || !canvas1.offsetHeight) return;
      const imageBottom = canvas1.offsetTop + canvas1.offsetHeight;
      const top = imageBottom - emptyRoomBtn.offsetHeight - 12;
      emptyRoomBtn.style.top = Math.max(top, 12) + 'px';
      emptyRoomBtn.style.bottom = 'auto';
      // Sit to the left of the mask FAB when both are showing so they don't overlap.
      const maskShowing = maskEditBtn && !maskEditBtn.classList.contains('hidden');
      emptyRoomBtn.style.right = (maskShowing ? 12 + 44 + 10 : 12) + 'px';
    }

    function updateEmptyRoomButtonVisibility() {
      if (!emptyRoomBtn) return;
      const onAfter = toggleAfterBtn && toggleAfterBtn.classList.contains('active');
      if (lastEmptyRoomUrl && hasProcessedImage && onAfter) {
        emptyRoomBtn.classList.remove('hidden');
        positionEmptyRoomFab();
        requestAnimationFrame(positionEmptyRoomFab);
      } else {
        emptyRoomBtn.classList.add('hidden');
      }
    }

    window.addEventListener('resize', positionMaskFab);
    window.addEventListener('resize', positionEmptyRoomFab);

    // ── Version carousel (before/after) ──
    // Extracted island (scripts/app/version-carousel.js): owns the version
    // arrays and the Before/After toggle; the entry mutates them only through
    // this API and injects the FAB/aria glue it calls back into.
    const {
      activeViewIsAfter,
      drawAfter,
      showBeforeVersion,
      showBeforeView,
      showAfterView,
      updateCarouselUI,
      getBeforeVersions,
      setBeforeVersions,
      pushBeforeVersion,
      getBeforeIndex,
      getAfterVersions,
      setAfterVersions,
      pushAfterVersion,
      setAfterIndex,
    } = createVersionCarousel({
      canvas1,
      stagePreview,
      toggleBeforeBtn,
      toggleAfterBtn,
      processingPlaceholder,
      imageViewerContainer,
      carouselPrev,
      carouselNext,
      carouselDots,
      maxVersions: MAX_MASK_VERSIONS,
      getHasProcessedImage: () => hasProcessedImage,
      updateMaskButtonVisibility,
      updateEmptyRoomButtonVisibility,
      updateStagedCanvasAria,
      getStagingAlt,
    });
  
    async function stageImage() {
      if (!currentImageFile) {
        alert(window.LanguageSystem?.getText('errors.uploadFirst') || 'Please upload an image first');
        return;
      }

      processBtn.disabled = true;

      const tokEarly = window.StagifyAuth && window.StagifyAuth.getToken();
      if (tokEarly && window.StagifyAuth && typeof window.StagifyAuth.fetchMe === 'function') {
        await window.StagifyAuth.fetchMe();
        if (window.StagifyAuth.applyUserToUI) window.StagifyAuth.applyUserToUI();
      }

      const uEarly = window.StagifyAuth && window.StagifyAuth.user;
      if (tokEarly && uEarly && !isProUser()) {
        const limEarly = uEarly.dailyGenerationLimit != null ? uEarly.dailyGenerationLimit : 3;
        const usedEarly = uEarly.dailyGenerationsUsed != null ? uEarly.dailyGenerationsUsed : 0;
        if (typeof limEarly === 'number' && usedEarly >= limEarly) {
          const msgEarly = messageForDailyLimitResponse({
            dailyGenerationLimit: limEarly,
            dailyGenerationsUsed: usedEarly,
            error: '',
          });
          showStagingLimitInViewer(msgEarly);
          processBtn.disabled = false;
          return;
        }
      }
      
      try {
        // Stage whichever "before" version is currently showing (original or a masked edit).
        let stageInput = currentImageFile;
        const bi = getBeforeIndex();
        const bv = getBeforeVersions();
        if (bi > 0 && bv[bi]) {
          stageInput = dataURLToFile(bv[bi], (currentImageFile && currentImageFile.name) || 'photo.png');
        }
        const processed = await processWithAI(stageInput);
        const urls = Array.isArray(processed) ? processed : [processed];
        // Reset the after carousel to the fresh staging result(s).
        setAfterVersions(urls.slice(0, MAX_MASK_VERSIONS));

        // Display the processed image
        const img = new Image();
        img.onload = () => {
          const ctx1 = canvas1.getContext('2d');
          const w = img.width, h = img.height;
          ctx1.canvas.width = w;
          ctx1.canvas.height = h;
          ctx1.drawImage(img, 0, 0, w, h);
          
          // Mark that we have a processed image
          hasProcessedImage = true;
          updateStagedCanvasAria(urls.length > 1 ? ' (1)' : '');
          
          // Remove blur effect from the before image
          stagePreview.classList.remove('processing');
          
          // Hide placeholder and show result
          processingPlaceholder.style.display = 'none';
          
          // Automatically switch to "After" view to show the result
          showAfterView();
          
          progress.classList.add('hidden');
          processBtn.disabled = false;
          
          // Refresh hero stat counts after successful processing
          loadHeroStats({ refresh: true });
          // The version carousel replaces the old variation thumbnails.
          updateCarouselUI();
        };
        img.src = urls[0];
        
       } catch (error) {
         processBtn.disabled = false;
         if (error && error.code === 'AUTH_REQUIRED' && isMobileStagingViewport()) {
           if (window.StagifyProfileMenu && window.StagifyProfileMenu.setAuthModeRegister) {
             window.StagifyProfileMenu.setAuthModeRegister(true);
           }
           if (window.StagifyProfileMenu && window.StagifyProfileMenu.openAuthModal) {
             window.StagifyProfileMenu.openAuthModal(true);
           } else if (typeof window.__stagifyOpenAuthForStaging === 'function') {
             window.__stagifyOpenAuthForStaging();
           }
           return;
         }
       }
    }
  
    // Only add modal event listeners if elements exist
    if (processBtn) processBtn.addEventListener('click', stageImage);
    if (modalBackdrop) modalBackdrop.addEventListener('click', closeModal);
    if (modalClose) modalClose.addEventListener('click', closeModal);
  
    if (downloadBtn) downloadBtn.addEventListener('click', () => {
      if (!canvas1.width) return;
      const link = document.createElement('a');
      const roomSlug = roomDownloadSlug(roomSelect?.value);
      link.download = `stagify-${roomSlug}-${Date.now()}.jpg`;
      link.href = canvas1.toDataURL('image/jpeg', 0.92);
      link.click();
    });

    // ── Empty-room viewer (intermediate result of two-stage furniture removal) ──
    function openEmptyRoomModal() {
      if (!emptyRoomModal || !lastEmptyRoomUrl) return;
      if (emptyRoomImage) emptyRoomImage.src = lastEmptyRoomUrl;
      emptyRoomModal.classList.add('active');
      emptyRoomModal.setAttribute('aria-hidden', 'false');
    }
    function closeEmptyRoomModal() {
      if (!emptyRoomModal) return;
      emptyRoomModal.classList.remove('active');
      emptyRoomModal.setAttribute('aria-hidden', 'true');
    }
    if (emptyRoomBtn) emptyRoomBtn.addEventListener('click', openEmptyRoomModal);
    if (emptyRoomClose) emptyRoomClose.addEventListener('click', closeEmptyRoomModal);
    if (emptyRoomModal) emptyRoomModal.addEventListener('click', (e) => {
      if (e.target === emptyRoomModal) closeEmptyRoomModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && emptyRoomModal && emptyRoomModal.classList.contains('active')) {
        closeEmptyRoomModal();
      }
    });
    if (emptyRoomDownload) emptyRoomDownload.addEventListener('click', () => {
      if (!lastEmptyRoomUrl) return;
      const link = document.createElement('a');
      const roomSlug = roomDownloadSlug(roomSelect?.value);
      link.download = `stagify-${roomSlug}-empty-${Date.now()}.jpg`;
      link.href = lastEmptyRoomUrl;
      link.click();
    });

    // ── Mask editor for staged "After" images (pro only) ──
    // Extracted island (scripts/app/stage-mask-editor.js): owns the modal + its
    // state machine; the entry injects the DOM/state glue plus a commit callback
    // that applies the new version to the shared before/after arrays + display.
    createStageMaskEditor({
      maskEditBtn,
      canvas1,
      stagePreview,
      processBtn,
      activeViewIsAfter,
      getBeforeVersions,
      getAfterVersions,
      maxVersions: MAX_MASK_VERSIONS,
      updateMaskButtonVisibility,
      onMaskCommit: async (finalUrl, isBefore) => {
        if (isBefore) {
          // Append a new unstaged "before" variant; Process stages whichever
          // before version is on screen.
          const bv = pushBeforeVersion(finalUrl);
          showBeforeView();
          stagePreview.classList.remove('processing');
          showBeforeVersion(bv.length - 1);
          updateMaskButtonVisibility();
        } else {
          // Append a refined staged version and show it.
          const av = pushAfterVersion(finalUrl);
          hasProcessedImage = true;
          showAfterView();
          await drawAfter(av[av.length - 1], av.length > 1 ? ` (${av.length})` : '');
          setAfterIndex(av.length - 1);
          canvas1.classList.remove('processing');
          updateCarouselUI();
          updateMaskButtonVisibility();
        }
        if (processBtn) processBtn.disabled = false;
        loadHeroStats({ refresh: true });
      },
    });

    if (newUploadBtn) newUploadBtn.addEventListener('click', () => {
      hideStagingLimitInViewer();
      currentImageFile = null;
      hasProcessedImage = false; // Reset processing state
      stagePreview.src = '';
      setBeforeVersions([]);
      setAfterVersions([]);
      updateMaskButtonVisibility();
      updateCarouselUI();
      const vt = document.getElementById('variation-thumbs');
      if (vt) {
        vt.innerHTML = '';
        vt.classList.add('hidden');
      }
      furnitureRefs.reset();
      // Show upload zone, hide viewer
      stageDropzone.classList.remove('hidden');
      imageViewerContainer.classList.add('hidden');
      stageFileInput.value = '';
      progress.classList.add('hidden');
      // Reset placeholder to show state
      processingPlaceholder.style.display = 'flex';
      // Reset canvas
      if (canvas1) {
        const ctx = canvas1.getContext('2d');
        ctx.clearRect(0, 0, canvas1.width, canvas1.height);
        canvas1.width = 0;
        canvas1.height = 0;
      }
    });
  
    // Sample button removed from UI
  
    function openModal() {
      modal.classList.remove('hidden');
    }
    function closeModal() {
      modal.classList.add('hidden');
    }
  
  // auth.js (loaded before this module) calls this via window
  // after sign-in/out; keep the exposure at top-level module eval.
  window.__stagifyUpdateHeroFreeGensLine = updateHeroFreeGensLine;
  
  
  // Initialize on page load (all pages)
  document.addEventListener('DOMContentLoaded', function() {
    loadHeroStats();

    
    // Initialize 3D tilt effect for the contact cards
    init3DTiltEffect();

    if (window.LanguageSystem && typeof window.LanguageSystem.applyLanguageToElements === 'function') {
      var _origStagifyApplyLang = window.LanguageSystem.applyLanguageToElements;
      window.LanguageSystem.applyLanguageToElements = function () {
        _origStagifyApplyLang.call(window.LanguageSystem);
        if (typeof window.__stagifyUpdateHeroFreeGensLine === 'function') {
          window.__stagifyUpdateHeroFreeGensLine();
        }
      };
    }
    if (typeof window.__stagifyUpdateHeroFreeGensLine === 'function') {
      window.__stagifyUpdateHeroFreeGensLine();
    }
  });
  
  
  
  
