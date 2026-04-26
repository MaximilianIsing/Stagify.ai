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

    const furnitureFileInput = document.getElementById('stagify-furniture-file');
    if (furnitureFileInput) {
      furnitureFileInput.addEventListener('change', () => {
        if (furnitureFileInput.files.length > 3) {
          const dt = new DataTransfer();
          for (let i = 0; i < 3; i++) dt.items.add(furnitureFileInput.files[i]);
          furnitureFileInput.files = dt.files;
        }
      });
    }

    function hideStagingLimitInViewer() {
      if (stagingLimitViewer) stagingLimitViewer.classList.add('hidden');
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
  
      // Stagify+ (pro): full progress bar + rotating loading lines. Free: fetch immediately for fast daily-limit feedback.
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
      if (u && u.plan === 'pro' && proPanelUsable) {
        const modelSel = document.getElementById('stagify-model-select');
        const varSel = document.getElementById('stagify-variation-count');
        const furn = document.getElementById('stagify-furniture-file');
        if (modelSel) formData.append('model', modelSel.value || 'gpt-4o-mini');
        if (varSel) formData.append('variationCount', varSel.value || '1');
        if (furn && furn.files && furn.files.length) {
          const n = Math.min(3, furn.files.length);
          for (let i = 0; i < n; i++) {
            formData.append('furnitureImage', furn.files[i]);
          }
        }
      }

      const useRichGenerationUI = !!(u && u.plan === 'pro');

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
      if (useRichGenerationUI) {
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
        loadingMessage.classList.remove('hidden');
        loadingMessage.textContent =
          window.LanguageSystem?.getText('modal.staging.progress.staging') || 'AI is staging your room…';

        try {
          response = await fetch('/api/process-image', {
            method: 'POST',
            body: formData,
          });
        } catch (e) {
          stagePreview.classList.remove('processing');
          loadingMessage.classList.add('hidden');
          throw e;
        }
      }

      if (!response.ok) {
        clearStagingUiTimers();
        stagePreview.classList.remove('processing');
        loadingMessage.classList.add('hidden');
        if (useRichGenerationUI) {
          progress.classList.add('hidden');
          progressBar.style.width = '0%';
        }
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

      let finalProgressInterval = null;
      if (useRichGenerationUI) {
        finalProgressInterval = setInterval(() => {
          if (currentProgress < 95) {
            currentProgress += Math.random() * 3;
            progressBar.style.width = Math.min(currentProgress, 95) + '%';
          }
        }, 150);
      }

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
    function showBeforeView() {
      stagePreview.classList.remove('hidden');
      canvas1.classList.add('hidden');
      toggleBeforeBtn.classList.add('active');
      toggleAfterBtn.classList.remove('active');
      // Hide placeholder when showing the image
      if (stagePreview.src) {
        processingPlaceholder.style.display = 'none';
      }
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

      const uEarly = window.StagifyAuth && window.StagifyAuth.user;
      const tokEarly = window.StagifyAuth && window.StagifyAuth.getToken();
      if (tokEarly && uEarly && uEarly.plan === 'free') {
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
      const ff = document.getElementById('stagify-furniture-file');
      if (ff) ff.value = '';
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

  /** Home hero: “{n} free generations left today” + Upgrade link for signed-in free users. */
  window.__stagifyUpdateHeroFreeGensLine = function () {
    var el = document.getElementById('hero-free-gens-today');
    if (!el) return;
    var auth = window.StagifyAuth;
    if (!auth || !auth.getToken || !auth.getToken() || !auth.user) {
      el.classList.add('hidden');
      return;
    }
    var u = auth.user;
    if (u.plan === 'pro') {
      el.classList.add('hidden');
      return;
    }
    var lim = u.dailyGenerationLimit != null ? u.dailyGenerationLimit : 3;
    var used = u.dailyGenerationsUsed != null ? u.dailyGenerationsUsed : 0;
    var n = Math.max(0, lim - used);
    function escHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
    var tpl = window.LanguageSystem && window.LanguageSystem.getText('hero.freeGensLeft');
    var upLabel =
      window.LanguageSystem && window.LanguageSystem.getText('hero.freeGensLeftUpgrade');
    if (upLabel === 'Loading...' || !upLabel) upLabel = 'Upgrade';
    if (tpl && tpl !== 'Loading...' && tpl.indexOf('{n}') !== -1) {
      var before = escHtml(tpl.replace(/\{n\}/g, String(n)));
      el.innerHTML =
        before +
        '<a class="hero-free-gens-upgrade" href="stagify-plus.html">' +
        escHtml(upLabel) +
        '</a>';
    } else {
      el.innerHTML =
        escHtml(n + ' free generations left today, ') +
        '<a class="hero-free-gens-upgrade" href="stagify-plus.html">Upgrade</a>';
    }
    el.classList.remove('hidden');
  };
  
  
  // Initialize on page load (all pages)
  document.addEventListener('DOMContentLoaded', function() {
    loadPromptCount();
    
    // Load and display contact count
    loadContactCount();
    
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
  
  // Load and display prompt count from server
  function loadPromptCount() {
    fetch('/api/prompt-count')
      .then(response => response.json())
      .then(data => {
        // Find the specific stat pill for "Rooms Staged" by looking for the one with the roomsStaged data-lang attribute
        const roomsStagedPill = document.querySelector('.stat-pill-text[data-lang="hero.stats.roomsStaged"]');
        const statPillNumber = roomsStagedPill ? roomsStagedPill.parentElement.querySelector('.stat-pill-number') : null;
        
        if (statPillNumber && data.promptCount !== undefined) {
          // Format the number nicely
          const count = data.promptCount;
          statPillNumber.textContent = count.toString();

        }
      })
      .catch(error => {
        console.error('Error loading prompt count:', error);
        // Keep the default "1000+" if there's an error
      });
  }

  // Load and display contact count from server
  function loadContactCount() {
    fetch('/api/contact-count')
      .then(response => response.json())
      .then(data => {
        // Find the specific stat pill for "Users Served" by looking for the one with the usersServed data-lang attribute
        const usersServedPill = document.querySelector('.stat-pill-text[data-lang="hero.stats.usersServed"]');
        const statPillNumber = usersServedPill ? usersServedPill.parentElement.querySelector('.stat-pill-number') : null;
        
        if (statPillNumber && data.contactCount !== undefined) {
          // Format the number nicely
          const count = data.contactCount;
          statPillNumber.textContent = count.toString();
        }
      })
      .catch(error => {
        console.error('Error loading contact count:', error);
        // Keep the default "200+" if there's an error
      });
  }

  
  
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
  
  
  