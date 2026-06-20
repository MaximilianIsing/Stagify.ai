(() => {
    
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  
    // Background video synchronization across page navigation
    const BACKGROUND_VIDEO_KEY = 'stagify_background_video_time';
    
    // Store video currentTime when navigating away
    const storeVideoTime = () => {
        const video = $('#background-video');
        if (video && !video.paused) {
            localStorage.setItem(BACKGROUND_VIDEO_KEY, video.currentTime.toString());
        }
    };
    
    // Listen for various navigation events
    window.addEventListener('beforeunload', storeVideoTime);
    window.addEventListener('pagehide', storeVideoTime);
    
    // Also store time periodically while video is playing
    let timeStoreInterval;
    document.addEventListener('DOMContentLoaded', () => {
        const video = $('#background-video');
        if (video) {
            video.addEventListener('play', () => {
                // Store time every 2 seconds while playing
                timeStoreInterval = setInterval(storeVideoTime, 2000);
            });
            
            video.addEventListener('pause', () => {
                if (timeStoreInterval) {
                    clearInterval(timeStoreInterval);
                }
            });
        }
    });
    
    // Restore video currentTime when page loads
    document.addEventListener('DOMContentLoaded', () => {
        const video = $('#background-video');
        if (video) {
            const storedTime = localStorage.getItem(BACKGROUND_VIDEO_KEY);
            
            // Handle smooth video loading transition
            video.addEventListener('loadeddata', () => {
                video.classList.add('loaded');
            });
            
            // Ensure video starts playing smoothly
            video.addEventListener('canplay', () => {
                video.play().catch(() => {
                    // Handle autoplay restrictions gracefully - fallback to solid background
                    video.style.display = 'none';
                    document.body.style.background = '#b2c4f6';
                });
            });
  
            // Handle mobile autoplay restrictions
            const attemptPlay = () => {
                if (video.paused) {
                    video.play().catch(() => {
                        // Still failed, keep trying on user interaction
                        // If this is the final attempt, hide video and show solid background
                        if (playAttempts >= maxAttempts - 1) {
                            video.style.display = 'none';
                            document.body.style.background = '#b2c4f6';
                        }
                    });
                }
            };
  
            // Try to play on various user interactions
            document.addEventListener('touchstart', attemptPlay, { once: true });
            document.addEventListener('click', attemptPlay, { once: true });
            document.addEventListener('scroll', attemptPlay, { once: true });
  
            // Also try periodically for mobile
            let playAttempts = 0;
            const maxAttempts = 1;
            const playInterval = setInterval(() => {
                if (video.paused && playAttempts < maxAttempts) {
                    attemptPlay();
                    playAttempts++;
                } else if (!video.paused || playAttempts >= maxAttempts) {
                    clearInterval(playInterval);
                    // If we've exhausted all attempts, hide video and show solid background
                    if (video.paused) {
                        video.style.display = 'none';
                        document.body.style.background = '#b2c4f6';
                    }
                }
            }, 1000);
            
            if (storedTime) {
                const targetTime = parseFloat(storedTime);
                
                const restoreTime = () => {
                    if (video.duration && targetTime < video.duration) {
                        video.currentTime = targetTime;
                    }
                };
                
                // Try to restore time when metadata is loaded
                video.addEventListener('loadedmetadata', restoreTime);
                
                // Fallback if metadata is already loaded
                if (video.readyState >= 1 && video.duration) {
                    restoreTime();
                }
                
                // Additional fallback after a short delay
                setTimeout(restoreTime, 100);
            }
        }
    });
  
    const canvas1 = $('#canvas1');
    const downloadBtn = $('#download-btn');
    const newUploadBtn = $('#new-upload');
    const imageViewerContainer = $('#image-viewer-container');
    const processingPlaceholder = $('#processing-placeholder');
    const toggleBeforeBtn = $('#toggle-before');
    const toggleAfterBtn = $('#toggle-after');
    const maskEditBtn = $('#mask-edit-btn');
  
    const heroUpload = $('#hero-upload');
    const navUpload = $('#nav-upload');
    const pricingUpload = $('#pricing-upload');
    const trySample = $('#try-sample');
    // Carousel is now handled by carousel.js
    
  
    // Stage screen elements (only on home page)
    const stageSection = $('#stage');
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

    if (stagingErrorRetryBtn) {
      stagingErrorRetryBtn.addEventListener('click', () => {
        hideStagingError();
        // Trigger the file picker so the user can upload a new image
        if (stageFileInput) stageFileInput.click();
      });
    }
    const furnitureFileInput = document.getElementById('stagify-furniture-file');
    const furnitureList = document.getElementById('stagify-furniture-list');
    const furnitureAddBtn = document.getElementById('stagify-furniture-add-btn');
    let accumulatedFurnitureFiles = [];
    let furniturePreviewUrls = [];
    let furniturePreviewEl = null;
    const FURNITURE_LIMIT = 5;
    const FURNITURE_NAME_MAX = 40;

    function getFurniturePreviewEl() {
      if (furniturePreviewEl) return furniturePreviewEl;
      furniturePreviewEl = document.createElement('div');
      furniturePreviewEl.id = 'furniture-image-preview';
      furniturePreviewEl.className = 'furniture-image-preview hidden';
      furniturePreviewEl.setAttribute('aria-hidden', 'true');
      var img = document.createElement('img');
      img.alt = '';
      furniturePreviewEl.appendChild(img);
      document.body.appendChild(furniturePreviewEl);
      return furniturePreviewEl;
    }

    function hideFurniturePreview() {
      var pop = getFurniturePreviewEl();
      pop.classList.add('hidden');
      pop.setAttribute('aria-hidden', 'true');
    }

    function showFurniturePreview(previewUrl, anchorEl) {
      if (!previewUrl || !anchorEl) return;
      var pop = getFurniturePreviewEl();
      var img = pop.querySelector('img');
      img.src = previewUrl;
      pop.classList.remove('hidden');
      pop.setAttribute('aria-hidden', 'false');
      var rect = anchorEl.getBoundingClientRect();
      var popW = 280;
      var popH = 280;
      var left = rect.right + 10;
      var top = rect.top + rect.height / 2 - popH / 2;
      if (left + popW > window.innerWidth - 8) {
        left = rect.left - popW - 10;
      }
      if (left < 8) left = 8;
      if (top < 8) top = 8;
      if (top + popH > window.innerHeight - 8) {
        top = window.innerHeight - popH - 8;
      }
      pop.style.left = left + 'px';
      pop.style.top = top + 'px';
    }

    function revokeFurniturePreviewUrls() {
      furniturePreviewUrls.forEach(function (u) {
        if (u) URL.revokeObjectURL(u);
      });
      furniturePreviewUrls = [];
      hideFurniturePreview();
    }

    function syncFurniturePreviewUrls() {
      revokeFurniturePreviewUrls();
      furniturePreviewUrls = accumulatedFurnitureFiles.map(function (f) {
        return URL.createObjectURL(f);
      });
    }

    function abbreviateFileName(name, maxLen) {
      var s = String(name || '');
      if (s.length <= maxLen) return s;
      return s.slice(0, maxLen) + '...';
    }

    function updateFurnitureAddBtn() {
      if (!furnitureAddBtn) return;
      if (accumulatedFurnitureFiles.length >= FURNITURE_LIMIT) {
        furnitureAddBtn.classList.add('hidden');
      } else {
        furnitureAddBtn.classList.remove('hidden');
      }
    }

    function renderFurnitureList() {
      if (!furnitureList) return;
      hideFurniturePreview();
      furnitureList.innerHTML = '';
      syncFurniturePreviewUrls();
      if (!accumulatedFurnitureFiles.length) {
        furnitureList.style.display = 'none';
        updateFurnitureAddBtn();
        return;
      }
      furnitureList.style.display = 'block';
      accumulatedFurnitureFiles.forEach(function (f, idx) {
        var row = document.createElement('div');
        row.className = 'furniture-file-row';
        var name = document.createElement('span');
        var fullName = f.name || '';
        name.textContent = abbreviateFileName(fullName, FURNITURE_NAME_MAX);
        if (fullName.length > FURNITURE_NAME_MAX) name.title = fullName;

        var previewBtn = document.createElement('button');
        previewBtn.type = 'button';
        previewBtn.className = 'furniture-preview-btn';
        previewBtn.setAttribute('aria-label', 'Preview ' + fullName);
        previewBtn.textContent = '?';
        var previewUrl = furniturePreviewUrls[idx];
        previewBtn.addEventListener('mouseenter', function () {
          showFurniturePreview(previewUrl, previewBtn);
        });
        previewBtn.addEventListener('mouseleave', hideFurniturePreview);
        previewBtn.addEventListener('focus', function () {
          showFurniturePreview(previewUrl, previewBtn);
        });
        previewBtn.addEventListener('blur', hideFurniturePreview);

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'furniture-file-remove';
        btn.title = 'Remove';
        btn.textContent = '\u2715';
        btn.addEventListener('click', function () {
          accumulatedFurnitureFiles.splice(idx, 1);
          syncFurnitureInput();
          renderFurnitureList();
        });
        row.appendChild(name);
        row.appendChild(previewBtn);
        row.appendChild(btn);
        furnitureList.appendChild(row);
      });
      updateFurnitureAddBtn();
    }

    function syncFurnitureInput() {
      if (!furnitureFileInput) return;
      var dt = new DataTransfer();
      accumulatedFurnitureFiles.forEach(function (f) { dt.items.add(f); });
      furnitureFileInput.files = dt.files;
    }

    function openFurniturePicker() {
      if (!furnitureFileInput || accumulatedFurnitureFiles.length >= FURNITURE_LIMIT) return;
      furnitureFileInput.click();
    }

    if (furnitureAddBtn) {
      furnitureAddBtn.addEventListener('click', openFurniturePicker);
    }

    if (furnitureFileInput) {
      furnitureFileInput.addEventListener('change', () => {
        var newFiles = Array.from(furnitureFileInput.files);
        newFiles.forEach(function (f) {
          if (accumulatedFurnitureFiles.length < FURNITURE_LIMIT) {
            accumulatedFurnitureFiles.push(f);
          }
        });
        if (accumulatedFurnitureFiles.length > FURNITURE_LIMIT) {
          accumulatedFurnitureFiles = accumulatedFurnitureFiles.slice(0, FURNITURE_LIMIT);
        }
        furnitureFileInput.value = '';
        syncFurnitureInput();
        renderFurnitureList();
      });
    }

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
      const lim = errorData.dailyGenerationLimit != null ? errorData.dailyGenerationLimit : 3;
      const used = errorData.dailyGenerationsUsed != null ? errorData.dailyGenerationsUsed : lim;
      const hasAccount = !!(window.StagifyAuth && window.StagifyAuth.getToken());
      const key = hasAccount ? 'errors.dailyLimitFree' : 'errors.dailyLimitAnonymous';
      const tpl = window.LanguageSystem?.getText(key);
      if (tpl && tpl !== 'Loading...') {
        return tpl.replace(/\{limit\}/g, String(lim)).replace(/\{used\}/g, String(used));
      }
      return errorData.error || `Daily free limit reached (${lim} per day).`;
    }
  
    const yearSpan = $('#year');
    if (yearSpan) yearSpan.textContent = new Date().getFullYear();

    let variationResultUrls = [];

    function isMobileStagingViewport() {
      return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 768px)').matches;
    }

    function openFilePicker() {
      const hasTok = window.StagifyAuth && window.StagifyAuth.getToken();
      if (!hasTok) {
        if (isMobileStagingViewport()) {
          openModal();
          return;
        }
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
      window.StagifyAuth.fetchMe().then(() => window.StagifyAuth.applyUserToUI());
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
          const v = variationSlider.value;
          variationValueEl.textContent = v;
          variationSlider.setAttribute('aria-valuenow', v);
        };
        variationSlider.addEventListener('input', syncVariationLabel);
        syncVariationLabel();
      }
    }
  
    let currentImageFile = null;
    let hasProcessedImage = false;
  
    function handleStageFile(file) {
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
        // Show image viewer, hide upload zone
        stageDropzone.classList.add('hidden');
        imageViewerContainer.classList.remove('hidden');
        // Hide placeholder and show the uploaded image
        processingPlaceholder.style.display = 'none';
        canvas1.classList.add('hidden');
        // Reset to "Before" view
        showBeforeView();
      };
      reader.readAsDataURL(file);
    }
  
    async function processWithAI(imageFile) {
      hideStagingLimitInViewer();

      stagePreview.classList.add('processing');
      showBeforeView();

      const formData = new FormData();
      formData.append('image', imageFile);
      formData.append('roomType', roomSelect?.value || 'Living room');
      formData.append('furnitureStyle', styleSelect?.value || 'standard');
      formData.append('additionalPrompt', additionalPrompt?.value || '');

      const removeFurnitureCheckbox = document.getElementById('remove-furniture');
      formData.append('removeFurniture', removeFurnitureCheckbox?.checked || false);

      const userRole = localStorage.getItem('userRole') || 'unknown';
      const userReferralSource = localStorage.getItem('userReferralSource') || '';
      const userEmail = localStorage.getItem('userEmail') || '';
      formData.append('userRole', userRole);
      formData.append('userReferralSource', userReferralSource);
      formData.append('userEmail', userEmail);

      const tok = window.StagifyAuth && window.StagifyAuth.getToken();
      if (tok) formData.append('authToken', tok);

      const u = window.StagifyAuth && window.StagifyAuth.user;
      const proPanel = document.getElementById('stagify-pro-panel');
      const proPanelUsable =
        proPanel &&
        !proPanel.classList.contains('hidden') &&
        window.getComputedStyle(proPanel).display !== 'none' &&
        window.getComputedStyle(proPanel).visibility !== 'hidden';
      if (isProUser() && proPanelUsable) {
        const modelSel = document.getElementById('stagify-model-select');
        const varSel = document.getElementById('stagify-variation-count');
        if (modelSel) formData.append('model', modelSel.value || 'gpt-4o-mini');
        if (varSel) formData.append('variationCount', varSel.value || '1');
        if (accumulatedFurnitureFiles.length) {
          const n = Math.min(FURNITURE_LIMIT, accumulatedFurnitureFiles.length);
          for (let i = 0; i < n; i++) {
            formData.append('furnitureImage', accumulatedFurnitureFiles[i]);
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
          });
        } catch (e) {
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
          });
        } catch (e) {
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
          const authErr = new Error(errorData.error || 'Please sign in to stage images.');
          authErr.code = 'AUTH_REQUIRED';
          throw authErr;
        }
        if (errorData.code === 'DAILY_LIMIT' || response.status === 429) {
          const limitMsg = messageForDailyLimitResponse(errorData);
          showStagingLimitInViewer(limitMsg);
          const limitErr = new Error(limitMsg);
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
          const noImgErr = new Error(msg);
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

      let finalProgressInterval = setInterval(() => {
        if (currentProgress < 95) {
          currentProgress += Math.random() * 3;
          progressBar.style.width = Math.min(currentProgress, 95) + '%';
        }
      }, 150);

      const result = await response.json();

      if (finalProgressInterval) {
        clearInterval(finalProgressInterval);
        finalProgressInterval = null;
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
  
    function getSelectedPreset() {
      const val = styleSelect?.value || 'standard';
      return val;
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
      if (!canvas1 || !canvas1.offsetHeight) return;
      // Anchor the button to the bottom-right of the rendered image, not the viewer box
      const imageBottom = canvas1.offsetTop + canvas1.offsetHeight;
      const top = imageBottom - maskEditBtn.offsetHeight - 12;
      maskEditBtn.style.top = Math.max(top, 12) + 'px';
      maskEditBtn.style.bottom = 'auto';
    }

    function updateMaskButtonVisibility() {
      if (!maskEditBtn) return;
      const onAfter = toggleAfterBtn && toggleAfterBtn.classList.contains('active');
      if (isProUser() && hasProcessedImage && onAfter) {
        maskEditBtn.classList.remove('hidden');
        positionMaskFab();
        requestAnimationFrame(positionMaskFab);
      } else {
        maskEditBtn.classList.add('hidden');
      }
    }

    window.addEventListener('resize', positionMaskFab);

    function showBeforeView() {
      stagePreview.classList.remove('hidden');
      canvas1.classList.add('hidden');
      toggleBeforeBtn.classList.add('active');
      toggleAfterBtn.classList.remove('active');
      // Hide placeholder when showing the image
      if (stagePreview.src) {
        processingPlaceholder.style.display = 'none';
      }
      updateMaskButtonVisibility();
    }
  
    function showAfterView() {
      stagePreview.classList.add('hidden');
      canvas1.classList.remove('hidden');
      toggleBeforeBtn.classList.remove('active');
      toggleAfterBtn.classList.add('active');
      // Show placeholder if no processing has been done yet
      if (!hasProcessedImage) {
        processingPlaceholder.style.display = 'flex';
      } else {
        processingPlaceholder.style.display = 'none';
      }
      updateMaskButtonVisibility();
    }
  
    // Add toggle event listeners
    if (toggleBeforeBtn) toggleBeforeBtn.addEventListener('click', showBeforeView);
    if (toggleAfterBtn) toggleAfterBtn.addEventListener('click', () => {
      // Always allow switching to "After" view
      showAfterView();
    });
  
    function renderVariationThumbs(urls) {
      const wrap = document.getElementById('variation-thumbs');
      if (!wrap) return;
      wrap.innerHTML = '';
      if (!urls || urls.length <= 1) {
        wrap.classList.add('hidden');
        return;
      }
      wrap.classList.remove('hidden');
      urls.forEach((url, idx) => {
        const t = document.createElement('img');
        t.src = url;
        t.className = 'variation-thumb' + (idx === 0 ? ' active' : '');
        t.alt = 'Variation ' + (idx + 1);
        t.addEventListener('click', () => {
          wrap.querySelectorAll('.variation-thumb').forEach((el) => el.classList.remove('active'));
          t.classList.add('active');
          const im = new Image();
          im.onload = () => {
            const ctx1 = canvas1.getContext('2d');
            ctx1.canvas.width = im.width;
            ctx1.canvas.height = im.height;
            ctx1.drawImage(im, 0, 0, im.width, im.height);
          };
          im.src = url;
        });
        wrap.appendChild(t);
      });
    }

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
        const processed = await processWithAI(currentImageFile);
        const urls = Array.isArray(processed) ? processed : [processed];
        variationResultUrls = urls;
        
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
          
          // Remove blur effect from the before image
          stagePreview.classList.remove('processing');
          
          // Hide placeholder and show result
          processingPlaceholder.style.display = 'none';
          
          // Automatically switch to "After" view to show the result
          showAfterView();
          
          progress.classList.add('hidden');
          processBtn.disabled = false;
          
          // Refresh prompt count after successful processing
          loadPromptCount();
          renderVariationThumbs(urls);
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
      link.download = 'stagify-result.png';
      link.href = canvas1.toDataURL('image/png');
      link.click();
    });

    // ── Mask editor for staged "After" images (pro only) ──
    (function setupStageMaskEditor() {
      const maskModal = $('#stage-mask-modal');
      if (!maskEditBtn || !maskModal) return;

      const baseCanvas = $('#stage-mask-base-canvas');
      const drawCanvas = $('#stage-mask-draw-canvas');
      const brushSlider = $('#stage-mask-brush-slider');
      const brushSizeLabel = $('#stage-mask-brush-size');
      const promptInput = $('#stage-mask-prompt');
      const cancelBtn = $('#stage-mask-cancel');
      const clearBtn = $('#stage-mask-clear');
      const submitBtn = $('#stage-mask-submit');
      const canvasContainer = maskModal.querySelector('.stage-mask-canvas-container');

      let brushSize = 50;
      let drawing = false;
      let lastX = null;
      let lastY = null;
      let scaleX = 1;
      let scaleY = 1;

      function isProcessing() {
        return canvasContainer && canvasContainer.classList.contains('processing');
      }

      function openEditor() {
        if (!canvas1.width) return;
        const src = canvas1.toDataURL('image/png');
        const img = new Image();
        img.onload = () => {
          const maxHeight = window.innerHeight * 0.6;
          const maxWidth = Math.min(window.innerWidth * 0.85, 860);
          let dispW = img.width;
          let dispH = img.height;
          if (dispH > maxHeight) { dispW = (maxHeight / dispH) * dispW; dispH = maxHeight; }
          if (dispW > maxWidth) { dispH = (maxWidth / dispW) * dispH; dispW = maxWidth; }

          baseCanvas.width = img.width;
          baseCanvas.height = img.height;
          baseCanvas.style.width = dispW + 'px';
          baseCanvas.style.height = dispH + 'px';
          baseCanvas.getContext('2d').drawImage(img, 0, 0, img.width, img.height);

          drawCanvas.width = img.width;
          drawCanvas.height = img.height;
          drawCanvas.style.width = dispW + 'px';
          drawCanvas.style.height = dispH + 'px';
          drawCanvas.getContext('2d').clearRect(0, 0, drawCanvas.width, drawCanvas.height);

          scaleX = dispW / img.width;
          scaleY = dispH / img.height;

          if (promptInput) promptInput.value = '';
          if (canvasContainer) canvasContainer.classList.remove('processing');
          drawCanvas.style.pointerEvents = 'auto';
          drawCanvas.style.cursor = 'crosshair';
          updateSubmitState();
          maskModal.classList.add('active');
          maskModal.setAttribute('aria-hidden', 'false');
        };
        img.src = src;
      }

      function closeEditor() {
        maskModal.classList.remove('active');
        maskModal.setAttribute('aria-hidden', 'true');
        clearDraw();
        if (canvasContainer) canvasContainer.classList.remove('processing');
      }

      function clearDraw() {
        const ctx = drawCanvas.getContext('2d');
        ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
        updateSubmitState();
      }

      function maskHasContent() {
        if (!drawCanvas.width || !drawCanvas.height) return false;
        const d = drawCanvas.getContext('2d').getImageData(0, 0, drawCanvas.width, drawCanvas.height).data;
        for (let i = 3; i < d.length; i += 4) {
          if (d[i] > 0) return true;
        }
        return false;
      }

      function updateSubmitState() {
        if (!submitBtn) return;
        const hasPrompt = promptInput && promptInput.value.trim().length > 0;
        submitBtn.disabled = !maskHasContent() || !hasPrompt;
      }

      function paint(e) {
        if (!drawing || isProcessing()) return;
        const rect = drawCanvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) / scaleX;
        const y = (e.clientY - rect.top) / scaleY;
        const ctx = drawCanvas.getContext('2d');
        ctx.globalCompositeOperation = 'lighten';

        function dab(px, py) {
          const g = ctx.createRadialGradient(px, py, 0, px, py, brushSize / 2);
          g.addColorStop(0, 'rgba(37, 99, 235, 0.5)');
          g.addColorStop(0.7, 'rgba(37, 99, 235, 0.3)');
          g.addColorStop(1, 'rgba(37, 99, 235, 0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(px, py, brushSize / 2, 0, Math.PI * 2);
          ctx.fill();
        }

        if (lastX !== null && lastY !== null) {
          const dx = x - lastX;
          const dy = y - lastY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const steps = Math.max(1, Math.floor(dist / (brushSize / 4)));
          for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            dab(lastX + dx * t, lastY + dy * t);
          }
        } else {
          dab(x, y);
        }
        lastX = x;
        lastY = y;
        ctx.globalCompositeOperation = 'source-over';
        updateSubmitState();
      }

      function startDraw(e) {
        if (isProcessing()) return;
        drawing = true;
        lastX = null;
        lastY = null;
        paint(e);
      }

      function stopDraw() {
        drawing = false;
        lastX = null;
        lastY = null;
        updateSubmitState();
      }

      drawCanvas.addEventListener('mousedown', startDraw);
      drawCanvas.addEventListener('mousemove', paint);
      drawCanvas.addEventListener('mouseup', stopDraw);
      drawCanvas.addEventListener('mouseleave', stopDraw);
      drawCanvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const t = e.touches[0];
        startDraw({ clientX: t.clientX, clientY: t.clientY });
      });
      drawCanvas.addEventListener('touchmove', (e) => {
        e.preventDefault();
        const t = e.touches[0];
        paint({ clientX: t.clientX, clientY: t.clientY });
      });
      drawCanvas.addEventListener('touchend', (e) => { e.preventDefault(); stopDraw(); });

      if (brushSlider) brushSlider.addEventListener('input', (e) => {
        brushSize = parseInt(e.target.value, 10);
        if (brushSizeLabel) brushSizeLabel.textContent = brushSize + ' px';
      });
      if (promptInput) promptInput.addEventListener('input', updateSubmitState);
      if (clearBtn) clearBtn.addEventListener('click', clearDraw);
      if (cancelBtn) cancelBtn.addEventListener('click', closeEditor);
      if (maskEditBtn) maskEditBtn.addEventListener('click', openEditor);
      maskModal.addEventListener('click', (e) => { if (e.target === maskModal) closeEditor(); });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && maskModal.classList.contains('active')) closeEditor();
      });

      function runMaskLoadingUI() {
        // Mirror the main generation loading experience
        const messages = [
          'Applying your edit',
          'Reworking the masked area',
          'Blending in the new details',
          'Refining textures and lighting',
          'Adding finishing touches',
        ];
        let prog = 0;
        progress.classList.remove('hidden');
        progressBar.style.width = '0%';
        progressText.textContent =
          (window.LanguageSystem && window.LanguageSystem.getText('modal.staging.progress.staging')) ||
          'AI is editing your room…';
        loadingMessage.classList.remove('hidden');
        loadingMessage.textContent = messages[0];
        const barTimer = setInterval(() => {
          if (prog < 90) {
            prog += Math.random() * 4;
            progressBar.style.width = Math.min(prog, 90) + '%';
          }
        }, 300);
        const msgTimer = setInterval(() => {
          loadingMessage.textContent = messages[Math.floor(Math.random() * messages.length)];
        }, 2000);
        function cleanup() {
          clearInterval(barTimer);
          clearInterval(msgTimer);
        }
        return {
          finish() {
            cleanup();
            progressBar.style.width = '100%';
            setTimeout(() => {
              progress.classList.add('hidden');
              loadingMessage.classList.add('hidden');
              progressBar.style.width = '0%';
            }, 300);
          },
          stop() {
            cleanup();
            progress.classList.add('hidden');
            loadingMessage.classList.add('hidden');
            progressBar.style.width = '0%';
          },
        };
      }

      async function submitEdit() {
        const prompt = promptInput ? promptInput.value.trim() : '';
        if (!prompt || !maskHasContent()) return;

        // Build the white-on-transparent mask + source image while the modal canvases exist
        const w = baseCanvas.width;
        const h = baseCanvas.height;
        const whiteMask = document.createElement('canvas');
        whiteMask.width = w;
        whiteMask.height = h;
        const wmCtx = whiteMask.getContext('2d');
        wmCtx.drawImage(drawCanvas, 0, 0, w, h);
        const md = wmCtx.getImageData(0, 0, w, h);
        const data = md.data;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] > 0) {
            data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
          } else {
            data[i] = 0; data[i + 1] = 0; data[i + 2] = 0;
          }
        }
        wmCtx.putImageData(md, 0, 0);
        const maskDataUrl = whiteMask.toDataURL('image/png');
        const imageDataUrl = baseCanvas.toDataURL('image/png');

        let selectedModel = 'gpt-4o-mini';
        const modelSel = document.getElementById('stagify-model-select');
        if (modelSel && modelSel.value) selectedModel = modelSel.value;

        // Close the editor and show the standard generation loading experience
        closeEditor();
        showAfterView();
        if (maskEditBtn) maskEditBtn.classList.add('hidden');
        canvas1.classList.add('processing');
        const loader = runMaskLoadingUI();

        try {
          const tok = window.StagifyAuth && window.StagifyAuth.getToken();
          const response = await fetch('/api/mask-edit', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(tok ? { Authorization: 'Bearer ' + tok } : {}),
            },
            body: JSON.stringify({
              image: imageDataUrl,
              mask: maskDataUrl,
              prompt: prompt,
              model: selectedModel,
              authToken: tok || undefined,
            }),
          });

          const result = await response.json();
          if (!response.ok || !result.editedImage) {
            throw new Error(result.error || 'Failed to process masked edit');
          }

          // Draw the edited image back onto the staging canvas
          await new Promise((resolve, reject) => {
            const edited = new Image();
            edited.onload = () => {
              const ctx1 = canvas1.getContext('2d');
              ctx1.canvas.width = edited.width;
              ctx1.canvas.height = edited.height;
              ctx1.drawImage(edited, 0, 0, edited.width, edited.height);
              const activeThumb = document.querySelector('#variation-thumbs .variation-thumb.active');
              if (activeThumb) activeThumb.src = result.editedImage;
              hasProcessedImage = true;
              resolve();
            };
            edited.onerror = () => reject(new Error('Failed to load edited image'));
            edited.src = result.editedImage;
          });

          loader.finish();
          canvas1.classList.remove('processing');
          updateMaskButtonVisibility();
        } catch (err) {
          console.error('Mask edit failed:', err);
          loader.stop();
          canvas1.classList.remove('processing');
          updateMaskButtonVisibility();
          alert(err.message || 'Mask edit failed. Please try again.');
        }
      }

      if (submitBtn) submitBtn.addEventListener('click', submitEdit);
    })();
  
    if (newUploadBtn) newUploadBtn.addEventListener('click', () => {
      hideStagingLimitInViewer();
      currentImageFile = null;
      hasProcessedImage = false; // Reset processing state
      stagePreview.src = '';
      variationResultUrls = [];
      const vt = document.getElementById('variation-thumbs');
      if (vt) {
        vt.innerHTML = '';
        vt.classList.add('hidden');
      }
      accumulatedFurnitureFiles = [];
      if (furnitureFileInput) furnitureFileInput.value = '';
      renderFurnitureList();
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
  
    // Custom select component
    function initCustomSelect(rootSelector) {
      const root = document.querySelector(rootSelector);
      if (!root) return { get value() { return ''; } };
      const trigger = root.querySelector('.select-trigger');
      const menu = root.querySelector('.select-menu');
      const valueEl = root.querySelector('.select-value');
      const options = Array.from(root.querySelectorAll('.option'));
      function setValue(val) {
        root.dataset.value = val;
        valueEl.textContent = options.find(o => o.dataset.value === val)?.textContent || val;
        options.forEach(o => o.classList.toggle('selected', o.dataset.value === val));
        menu.classList.add('hidden');
      }
      trigger.addEventListener('click', () => {
        menu.classList.toggle('hidden');
      });
      options.forEach(o => {
        o.addEventListener('click', () => setValue(o.dataset.value));
      });
      document.addEventListener('click', (e) => {
        if (!root.contains(e.target)) menu.classList.add('hidden');
      });
      return {
        get value() { return root.dataset.value; },
        set(value) { setValue(value); }
      };
    }
  })();

  /** Show upgrade nudge only for users signed into a free account. */
  window.__stagifyUpdateHeroFreeGensLine = function () {
    var el = document.getElementById('hero-free-gens-today');
    if (!el) return;
    var auth = window.StagifyAuth;
    var isSignedInFree =
      auth && auth.getToken && auth.getToken() && auth.user && !(auth.isProUser && auth.isProUser());
    if (!isSignedInFree) {
      el.classList.add('hidden');
      return;
    }
    el.innerHTML = window.LanguageSystem?.getText('hero.freeGensUpgrade') ||
      'Try Stagify+ today — <a class="hero-free-gens-upgrade" href="stagify-plus.html">Upgrade</a>';
    el.classList.remove('hidden');
  };
  
  
  // Load hero stat pills from server, then animate to live counts
  function loadHeroStats() {
    if (!document.querySelector('.stat-pill-number[data-stat]')) return;

    Promise.all([
      fetch('/api/prompt-count').then(function (r) {
        return r.json();
      }),
      fetch('/api/contact-count').then(function (r) {
        return r.json();
      }),
    ])
      .then(function (results) {
        var promptData = results[0];
        var contactData = results[1];
        var rooms =
          promptData && promptData.promptCount !== undefined
            ? Number(promptData.promptCount)
            : null;
        var users =
          contactData && contactData.usersServed !== undefined
            ? Number(contactData.usersServed)
            : contactData && contactData.contactCount !== undefined
              ? Number(contactData.contactCount) +
                Number(contactData.userCount || 0)
              : null;

        if (window.StagifyHeroStats && typeof window.StagifyHeroStats.setCounts === 'function') {
          window.StagifyHeroStats.setCounts({
            roomsStaged: rooms,
            usersServed: users,
          });
          return;
        }

        var roomsEl = document.querySelector('.stat-pill-number[data-stat="roomsStaged"]');
        var usersEl = document.querySelector('.stat-pill-number[data-stat="usersServed"]');
        if (roomsEl && rooms != null && !Number.isNaN(rooms)) roomsEl.textContent = String(rooms);
        if (usersEl && users != null && !Number.isNaN(users)) usersEl.textContent = String(users);
      })
      .catch(function (error) {
        console.error('Error loading hero stats:', error);
      });
  }

  // Initialize on page load (all pages)
  document.addEventListener('DOMContentLoaded', function() {
    loadHeroStats();

    
    // Initialize 3D tilt effect for advantages section and contact cards
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
  
  // 3D Tilt Effect for Advantages Section, Contact Cards, and FAQ
  function init3DTiltEffect() {
    // Apply to advantages section
    applyTiltEffect('.advantages');
    
    // Apply to FAQ section
    applyTiltEffect('.faq');
    
    // Apply to all contact cards
    const contactCards = document.querySelectorAll('.contact-card');
    contactCards.forEach((card, index) => {
      applyTiltEffectToElement(card);
    });
  }
  
  function applyTiltEffect(selector) {
    const element = document.querySelector(selector);
    if (!element) return;
    applyTiltEffectToElement(element);
  }
  
  function applyTiltEffectToElement(element) {
    let isHovering = false;
    
    element.addEventListener('mouseenter', function() {
      isHovering = true;
    });
    
    element.addEventListener('mouseleave', function() {
      isHovering = false;
      // Reset to neutral position
      element.style.transform = 'rotateX(0deg) rotateY(0deg)';
    });
    
    element.addEventListener('mousemove', function(e) {
      if (!isHovering) return;
      
      const rect = element.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      
      // Calculate mouse position relative to center
      const mouseX = e.clientX - centerX;
      const mouseY = e.clientY - centerY;
      
      // Calculate rotation values (max 8 degrees)
      const rotateY = (mouseX / (rect.width / 2)) * 8;
      const rotateX = -(mouseY / (rect.height / 2)) * 8;
      
      // Apply 3D transformation
      element.style.transform = `rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
    });
  }
  
  
  
