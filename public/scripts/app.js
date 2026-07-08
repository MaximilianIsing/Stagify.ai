import { abbreviateFileName, dataURLToFile } from './app/helpers.js';
import { createStageMaskEditor } from './app/stage-mask-editor.js';

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
    const keepFurnitureInput = $('#keep-furniture');
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

    function getStagingAlt(key, replacements = {}) {
      let text = window.LanguageSystem?.getText('modal.staging.' + key) || '';
      Object.entries(replacements).forEach(([k, v]) => {
        text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), v == null ? '' : String(v));
      });
      return text;
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

    function showFurniturePreview(previewUrl, anchorEl, filename) {
      if (!previewUrl || !anchorEl) return;
      var pop = getFurniturePreviewEl();
      var img = pop.querySelector('img');
      img.src = previewUrl;
      img.alt = getStagingAlt('furnitureReferenceAlt', { filename: filename || 'furniture photo' });
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
          showFurniturePreview(previewUrl, previewBtn, fullName);
        });
        previewBtn.addEventListener('mouseleave', hideFurniturePreview);
        previewBtn.addEventListener('focus', function () {
          showFurniturePreview(previewUrl, previewBtn, fullName);
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

    var FURNITURE_ACCEPT = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

    // Add files from either the file picker or a drag-and-drop, keeping the
    // accept filter (the OS picker honors `accept`, but dropped files don't) and
    // the 5-photo cap in one place.
    async function addFurnitureFiles(fileList) {
      // Convert any HEIC/HEIF picks to JPEG up front so they pass the filter and
      // render like any other reference photo.
      var raw = Array.from(fileList || []);
      if (window.StagifyHeic) {
        try {
          raw = await Promise.all(raw.map(function (f) {
            return window.StagifyHeic.isHeic(f) ? window.StagifyHeic.toDisplayableFile(f) : f;
          }));
        } catch (e) {
          alert(window.LanguageSystem?.getText('errors.heicConvert') || "We couldn't read that HEIC photo. Please try a JPG or PNG.");
          return;
        }
      }
      var incoming = raw.filter(function (f) {
        return f && (FURNITURE_ACCEPT.indexOf(f.type) !== -1 || /\.(jpe?g|png|webp)$/i.test(f.name || ''));
      });
      if (!incoming.length) return;
      incoming.forEach(function (f) {
        if (accumulatedFurnitureFiles.length < FURNITURE_LIMIT) {
          accumulatedFurnitureFiles.push(f);
        }
      });
      if (accumulatedFurnitureFiles.length > FURNITURE_LIMIT) {
        accumulatedFurnitureFiles = accumulatedFurnitureFiles.slice(0, FURNITURE_LIMIT);
      }
      syncFurnitureInput();
      renderFurnitureList();
    }

    if (furnitureAddBtn) {
      furnitureAddBtn.addEventListener('click', openFurniturePicker);
    }

    if (furnitureFileInput) {
      furnitureFileInput.addEventListener('change', () => {
        addFurnitureFiles(furnitureFileInput.files);
      });
    }

    // Drag-and-drop: drop image files onto the "+ Add photos" button (or the
    // list of already-added photos) to add reference photos, same as picking
    // them. Highlights the button while a valid drag is over it.
    (function wireFurnitureDrop() {
      var zones = [furnitureAddBtn, furnitureList].filter(Boolean);
      if (!zones.length) return;
      var dragDepth = 0;
      function atLimit() {
        return accumulatedFurnitureFiles.length >= FURNITURE_LIMIT;
      }
      function hasFiles(e) {
        var dt = e.dataTransfer;
        return !!dt && Array.prototype.indexOf.call(dt.types || [], 'Files') !== -1;
      }
      zones.forEach(function (zone) {
        zone.addEventListener('dragenter', function (e) {
          if (!hasFiles(e) || atLimit()) return;
          e.preventDefault();
          dragDepth++;
          if (furnitureAddBtn) furnitureAddBtn.classList.add('is-drag-over');
        });
        zone.addEventListener('dragover', function (e) {
          if (!hasFiles(e) || atLimit()) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        });
        zone.addEventListener('dragleave', function () {
          dragDepth = Math.max(0, dragDepth - 1);
          if (dragDepth === 0 && furnitureAddBtn) furnitureAddBtn.classList.remove('is-drag-over');
        });
        zone.addEventListener('drop', function (e) {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth = 0;
          if (furnitureAddBtn) furnitureAddBtn.classList.remove('is-drag-over');
          if (e.dataTransfer) addFurnitureFiles(e.dataTransfer.files);
        });
      });
    })();

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

    // Version carousels: the before view holds the uploaded photo plus any
    // masked edits of it; the after view holds the staged result(s) plus any
    // masked refinements. Each is capped so the 6th mask attempt is blocked.
    const MAX_MASK_VERSIONS = 6;
    let beforeVersions = [];
    let beforeIndex = 0;
    let afterVersions = [];
    let afterIndex = 0;

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
      "This doesn't look like a room or property space. Please upload a photo of an interior room or exterior space you'd like to stage.";

    // Downscale a data URL to a small JPEG (keeps the POST body well under the
    // server's 50MB JSON cap and saves tokens), then ask the server whether it is
    // a stageable space. Always resolves to { valid, reason }; never rejects.
    function validateStageableUpload(dataUrl) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = async () => {
          let payload = dataUrl;
          try {
            // 512px matches the server's low-detail vision tile — bigger would
            // only be downsampled away, so this keeps the upload small and fast.
            const max = 512;
            const scale = Math.min(1, max / Math.max(img.width, img.height));
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(img.width * scale));
            c.height = Math.max(1, Math.round(img.height * scale));
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            payload = c.toDataURL('image/jpeg', 0.9);
          } catch (e) { /* fall back to the original data URL */ }
          try {
            const tok = window.StagifyAuth && window.StagifyAuth.getToken();
            const resp = await fetch('/api/validate-image', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(tok ? { Authorization: 'Bearer ' + tok } : {}),
              },
              body: JSON.stringify({ image: payload, authToken: tok || undefined }),
            });
            if (!resp.ok) return resolve({ valid: true, reason: '' });
            const r = await resp.json().catch(() => null);
            if (!r || typeof r.valid !== 'boolean') return resolve({ valid: true, reason: '' });
            resolve(r);
          } catch (e) {
            resolve({ valid: true, reason: '' });
          }
        };
        img.onerror = () => resolve({ valid: true, reason: '' });
        img.src = dataUrl;
      });
    }

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
        beforeVersions = [reader.result];
        beforeIndex = 0;
        afterVersions = [];
        afterIndex = 0;
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

      const removeFurnitureCheckbox = document.getElementById('remove-furniture');
      const removeChecked = removeFurnitureCheckbox?.checked || false;
      formData.append('removeFurniture', removeChecked);
      const keepFurnitureEl = document.getElementById('keep-furniture');
      formData.append('keepFurniture', (removeChecked && keepFurnitureEl?.value) ? keepFurnitureEl.value.trim() : '');

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
        const err = new Error(reason || DEFAULT_UNSTAGEABLE_MESSAGE);
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
    function activeViewIsAfter() {
      return toggleAfterBtn && toggleAfterBtn.classList.contains('active');
    }

    function drawAfter(url, ariaSuffix) {
      return new Promise((resolve) => {
        const im = new Image();
        im.onload = () => {
          const ctx1 = canvas1.getContext('2d');
          ctx1.canvas.width = im.width;
          ctx1.canvas.height = im.height;
          ctx1.drawImage(im, 0, 0, im.width, im.height);
          updateStagedCanvasAria(ariaSuffix || '');
          resolve();
        };
        im.src = url;
      });
    }

    function showAfterVersion(i) {
      if (!afterVersions.length) return;
      afterIndex = Math.max(0, Math.min(i, afterVersions.length - 1));
      drawAfter(afterVersions[afterIndex], afterVersions.length > 1 ? ` (${afterIndex + 1})` : '');
      updateCarouselUI();
    }

    function showBeforeVersion(i) {
      if (!beforeVersions.length) return;
      beforeIndex = Math.max(0, Math.min(i, beforeVersions.length - 1));
      stagePreview.src = beforeVersions[beforeIndex];
      updateCarouselUI();
    }

    function carouselStep(delta) {
      if (activeViewIsAfter()) showAfterVersion(afterIndex + delta);
      else showBeforeVersion(beforeIndex + delta);
    }

    // Anchor the nav arrows + dots to the rendered image (not the viewer box),
    // so dots sit at the photo's bottom edge and arrows are centered on it.
    function positionCarousel() {
      const el = activeViewIsAfter() ? canvas1 : stagePreview;
      if (!el || !el.offsetHeight || !el.offsetWidth) return;
      const top = el.offsetTop;
      const left = el.offsetLeft;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const midY = top + h / 2;
      if (carouselPrev && !carouselPrev.classList.contains('hidden')) {
        carouselPrev.style.top = midY + 'px';
        carouselPrev.style.left = (left + 12) + 'px';
        carouselPrev.style.right = 'auto';
      }
      if (carouselNext && !carouselNext.classList.contains('hidden')) {
        carouselNext.style.top = midY + 'px';
        carouselNext.style.left = (left + w - 12 - carouselNext.offsetWidth) + 'px';
        carouselNext.style.right = 'auto';
      }
      if (carouselDots && !carouselDots.classList.contains('hidden')) {
        carouselDots.style.left = (left + w / 2) + 'px';
        carouselDots.style.bottom = 'auto';
        carouselDots.style.top = (top + h - carouselDots.offsetHeight - 12) + 'px';
      }
    }

    window.addEventListener('resize', positionCarousel);
    if (stagePreview) stagePreview.addEventListener('load', positionCarousel);

    function updateCarouselUI() {
      if (!carouselDots) return;
      const isAfter = activeViewIsAfter();
      const list = isAfter ? afterVersions : beforeVersions;
      const idx = isAfter ? afterIndex : beforeIndex;
      const viewerOpen = imageViewerContainer && !imageViewerContainer.classList.contains('hidden');
      const show = viewerOpen && list.length > 1 && (!isAfter || hasProcessedImage);
      [carouselPrev, carouselNext, carouselDots].forEach((el) => {
        if (el) el.classList.toggle('hidden', !show);
      });
      if (!show) return;
      if (carouselPrev) carouselPrev.disabled = idx <= 0;
      if (carouselNext) carouselNext.disabled = idx >= list.length - 1;
      carouselDots.innerHTML = '';
      list.forEach((_, i) => {
        const d = document.createElement('button');
        d.type = 'button';
        d.className = 'stage-carousel-dot' + (i === idx ? ' active' : '');
        d.setAttribute('role', 'tab');
        d.setAttribute('aria-selected', i === idx ? 'true' : 'false');
        d.setAttribute('aria-label', (getStagingAlt('versionLabel', { index: i + 1 }) || ('Version ' + (i + 1))));
        d.addEventListener('click', () => {
          if (isAfter) showAfterVersion(i);
          else showBeforeVersion(i);
        });
        carouselDots.appendChild(d);
      });
      positionCarousel();
      requestAnimationFrame(positionCarousel);
    }

    if (carouselPrev) carouselPrev.addEventListener('click', () => carouselStep(-1));
    if (carouselNext) carouselNext.addEventListener('click', () => carouselStep(1));

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
      updateEmptyRoomButtonVisibility();
      updateCarouselUI();
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
      updateEmptyRoomButtonVisibility();
      updateCarouselUI();
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
        t.alt = getStagingAlt('variationAlt', { index: idx + 1, total: urls.length });
        t.addEventListener('click', () => {
          wrap.querySelectorAll('.variation-thumb').forEach((el) => el.classList.remove('active'));
          t.classList.add('active');
          const im = new Image();
          im.onload = () => {
            const ctx1 = canvas1.getContext('2d');
            ctx1.canvas.width = im.width;
            ctx1.canvas.height = im.height;
            ctx1.drawImage(im, 0, 0, im.width, im.height);
            updateStagedCanvasAria(urls.length > 1 ? ` (${idx + 1})` : '');
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
        // Stage whichever "before" version is currently showing (original or a masked edit).
        let stageInput = currentImageFile;
        if (beforeIndex > 0 && beforeVersions[beforeIndex]) {
          stageInput = dataURLToFile(beforeVersions[beforeIndex], (currentImageFile && currentImageFile.name) || 'photo.png');
        }
        const processed = await processWithAI(stageInput);
        const urls = Array.isArray(processed) ? processed : [processed];
        variationResultUrls = urls;
        // Reset the after carousel to the fresh staging result(s).
        afterVersions = urls.slice(0, MAX_MASK_VERSIONS);
        afterIndex = 0;

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
      const roomSlug = (roomSelect?.value || 'room').toLowerCase().replace(/\s+/g, '-');
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
      const roomSlug = (roomSelect?.value || 'room').toLowerCase().replace(/\s+/g, '-');
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
      getBeforeVersions: () => beforeVersions,
      getAfterVersions: () => afterVersions,
      maxVersions: MAX_MASK_VERSIONS,
      updateMaskButtonVisibility,
      onMaskCommit: async (finalUrl, isBefore) => {
        if (isBefore) {
          // Append a new unstaged "before" variant; Process stages whichever
          // before version is on screen.
          beforeVersions.push(finalUrl);
          if (beforeVersions.length > MAX_MASK_VERSIONS) beforeVersions = beforeVersions.slice(-MAX_MASK_VERSIONS);
          showBeforeView();
          stagePreview.classList.remove('processing');
          showBeforeVersion(beforeVersions.length - 1);
          updateMaskButtonVisibility();
        } else {
          // Append a refined staged version and show it.
          afterVersions.push(finalUrl);
          if (afterVersions.length > MAX_MASK_VERSIONS) afterVersions = afterVersions.slice(-MAX_MASK_VERSIONS);
          hasProcessedImage = true;
          showAfterView();
          await drawAfter(afterVersions[afterVersions.length - 1],
            afterVersions.length > 1 ? ` (${afterVersions.length})` : '');
          afterIndex = afterVersions.length - 1;
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
      variationResultUrls = [];
      beforeVersions = [];
      beforeIndex = 0;
      afterVersions = [];
      afterIndex = 0;
      updateMaskButtonVisibility();
      updateCarouselUI();
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
  
  
  // Load hero stat pills from server, then reveal and animate to live counts
  function loadHeroStats(options) {
    if (!document.querySelector('.stat-pill-number[data-stat]')) return;

    var opts = options || {};
    var isRefresh = opts.refresh === true;

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
          window.StagifyHeroStats.setCounts(
            { roomsStaged: rooms, usersServed: users },
            { refresh: isRefresh }
          );
          return;
        }

        var wrap = document.getElementById('hero-stats');
        var roomsEl = document.querySelector('.stat-pill-number[data-stat="roomsStaged"]');
        var usersEl = document.querySelector('.stat-pill-number[data-stat="usersServed"]');
        if (roomsEl && rooms != null && !Number.isNaN(rooms)) roomsEl.textContent = String(rooms);
        if (usersEl && users != null && !Number.isNaN(users)) usersEl.textContent = String(users);
        if (wrap) wrap.classList.add('is-ready');
      })
      .catch(function (error) {
        console.error('Error loading hero stats:', error);
        if (
          window.StagifyHeroStats &&
          typeof window.StagifyHeroStats.revealWithoutCounts === 'function'
        ) {
          window.StagifyHeroStats.revealWithoutCounts();
        }
      });
  }

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
  
  // 3D Tilt Effect for the contact cards
  function init3DTiltEffect() {
    // Tilt is only for the contact cards.
    const contactCards = document.querySelectorAll('.contact-card');
    contactCards.forEach((card) => {
      applyTiltEffectToElement(card);
    });
  }

  function applyTiltEffectToElement(element) {
    let isHovering = false;
    let rect = null;        // cached on enter so we don't force a layout read per move
    let rafId = null;
    let lastX = 0, lastY = 0;

    element.addEventListener('mouseenter', function() {
      isHovering = true;
      rect = element.getBoundingClientRect();
    });

    element.addEventListener('mouseleave', function() {
      isHovering = false;
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      // Reset to neutral position
      element.style.transform = 'rotateX(0deg) rotateY(0deg)';
    });

    element.addEventListener('mousemove', function(e) {
      if (!isHovering || !rect) return;
      lastX = e.clientX;
      lastY = e.clientY;
      // Coalesce rapid moves into a single transform write per frame.
      if (rafId) return;
      rafId = requestAnimationFrame(function() {
        rafId = null;
        // Calculate rotation values (max 8 degrees) from the cached rect.
        const rotateY = ((lastX - (rect.left + rect.width / 2)) / (rect.width / 2)) * 8;
        const rotateX = -((lastY - (rect.top + rect.height / 2)) / (rect.height / 2)) * 8;
        element.style.transform = `rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
      });
    });
  }
  
  
  
