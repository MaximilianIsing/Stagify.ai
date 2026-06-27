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
    function addFurnitureFiles(fileList) {
      var incoming = Array.from(fileList || []).filter(function (f) {
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

    function dataURLToFile(dataUrl, filename) {
      const arr = dataUrl.split(',');
      const mimeMatch = arr[0].match(/:(.*?);/);
      const mime = mimeMatch ? mimeMatch[1] : 'image/png';
      const bstr = atob(arr[1]);
      let n = bstr.length;
      const u8 = new Uint8Array(n);
      while (n--) u8[n] = bstr.charCodeAt(n);
      return new File([u8], filename || 'photo.png', { type: mime });
    }

    function isMobileStagingViewport() {
      return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 768px)').matches;
    }

    // Turn the user's brush strokes into a solid white-on-transparent mask grown
    // outward by `grow` px (the "secret brush size increase" — covers slightly
    // more than the user actually painted so small under-brushing is forgiven).
    function growBinaryMask(drawSrc, w, h, grow) {
      const bin = document.createElement('canvas');
      bin.width = w; bin.height = h;
      const bctx = bin.getContext('2d');
      bctx.drawImage(drawSrc, 0, 0, w, h);
      const id = bctx.getImageData(0, 0, w, h);
      const d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        const on = d[i + 3] > 10;
        d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = on ? 255 : 0;
      }
      bctx.putImageData(id, 0, 0);
      const grown = document.createElement('canvas');
      grown.width = w; grown.height = h;
      const gctx = grown.getContext('2d');
      const steps = 28;
      const ringStep = Math.max(2, grow / 5);
      for (let r = grow; r > 0; r -= ringStep) {
        for (let k = 0; k < steps; k++) {
          const a = (k / steps) * Math.PI * 2;
          gctx.drawImage(bin, Math.cos(a) * r, Math.sin(a) * r);
        }
      }
      gctx.drawImage(bin, 0, 0);
      return grown;
    }

    // White-on-black opaque mask for the model: the grown brushed region the AI is
    // allowed to edit. Sending the grown mask (not the raw brush) is what makes
    // the secret brush increase actually enlarge the edit.
    function buildModelMask(drawSrc, w, h, grow) {
      const grown = growBinaryMask(drawSrc, w, h, grow);
      const out = document.createElement('canvas');
      out.width = w; out.height = h;
      const octx = out.getContext('2d');
      octx.fillStyle = '#000';
      octx.fillRect(0, 0, w, h);
      octx.drawImage(grown, 0, 0);
      return out;
    }

    // Soft "keep" mask for compositing: a solid core grown by coreGrow, then a
    // gradual alpha falloff over featherPx so the edited region fades into the
    // original with no visible seam. The alpha channel is the blend weight
    // (1 = fully edited, 0 = fully original).
    function buildBlendMask(drawSrc, w, h, coreGrow, featherPx) {
      const grown = growBinaryMask(drawSrc, w, h, coreGrow + featherPx);
      const out = document.createElement('canvas');
      out.width = w; out.height = h;
      const octx = out.getContext('2d');
      let blurred = false;
      try {
        if (typeof octx.filter !== 'undefined') {
          octx.filter = 'blur(' + featherPx + 'px)';
          octx.drawImage(grown, 0, 0);
          octx.filter = 'none';
          blurred = true;
        }
      } catch (e) { blurred = false; }
      if (!blurred) {
        // Fallback (no canvas filter): approximate the fade with decreasing-alpha
        // ring stamps around the solid core.
        octx.drawImage(grown, 0, 0);
        const steps = 28;
        const rings = 8;
        for (let i = 1; i <= rings; i++) {
          octx.globalAlpha = 0.5 * (1 - i / (rings + 1));
          const rr = featherPx * (i / rings);
          for (let k = 0; k < steps; k++) {
            const a = (k / steps) * Math.PI * 2;
            octx.drawImage(grown, Math.cos(a) * rr, Math.sin(a) * rr);
          }
        }
        octx.globalAlpha = 1;
      }
      return out;
    }

    // Hard-composite the AI output onto the original: keep the original
    // everywhere, paste the edited pixels only inside the (expanded) mask. This
    // makes it physically impossible for unbrushed areas to change.
    function compositeMaskedEditCanvas(origCanvas, keepMask, editedImg, w, h) {
      const me = document.createElement('canvas');
      me.width = w; me.height = h;
      const mctx = me.getContext('2d');
      mctx.drawImage(editedImg, 0, 0, w, h);
      mctx.globalCompositeOperation = 'destination-in';
      mctx.drawImage(keepMask, 0, 0, w, h);
      const out = document.createElement('canvas');
      out.width = w; out.height = h;
      const octx = out.getContext('2d');
      octx.drawImage(origCanvas, 0, 0);
      octx.drawImage(me, 0, 0);
      return out;
    }
    // Same composite, returned as a PNG data URL (used when committing a version).
    function compositeMaskedEdit(origCanvas, keepMask, editedImg, w, h) {
      return compositeMaskedEditCanvas(origCanvas, keepMask, editedImg, w, h).toDataURL('image/png');
    }

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
      const brushToolBtn = $('#stage-mask-brush-btn');
      const eraseToolBtn = $('#stage-mask-erase-btn');
      const canvasContainer = maskModal.querySelector('.stage-mask-canvas-container');
      const refFileInput = $('#stage-mask-ref-file');
      const refAddBtn = $('#stage-mask-ref-add');
      const refPreview = $('#stage-mask-ref-preview');
      const refImg = $('#stage-mask-ref-img');
      const refRemoveBtn = $('#stage-mask-ref-remove');
      const noteEl = maskModal.querySelector('.stage-mask-note');
      const actionsRow = maskModal.querySelector('.stage-mask-actions');

      let brushSize = 50;
      let drawing = false;
      let lastX = null;
      let lastY = null;
      let scaleX = 1;
      let scaleY = 1;
      let maskReferenceDataUrl = null;
      // 'brush' adds to the selection, 'erase' removes from it.
      let tool = 'brush';
      // Tracks whether anything has been painted this session, so the hot drawing
      // path never has to scan the whole canvas (getImageData) to enable Submit.
      let painted = false;
      // 'after' = refine an already-staged image; 'before' = edit the original
      // photo into a new unstaged variant. Both append to their carousel.
      let editorMode = 'after';

      // ---- In-modal generate → refine flow ---------------------------------
      // "Apply Edit" no longer closes the modal. We blur the canvas while the AI
      // runs, then show the result here so the user can repaint the outline.
      // Repainting only re-crops the already-generated image (instant, free) — it
      // never re-calls the API unless they press "Regenerate".
      let phase = 'draw';        // 'draw' | 'loading' | 'refine'
      let refineState = null;    // { origCanvas, w, h, coreGrow, featherPx, editedImg, isBefore }
      let loadMsgTimer = null;
      let loadingOverlay = null;

      // Refine-phase action buttons, created once and toggled by phase.
      const rerunBtn = document.createElement('button');
      rerunBtn.type = 'button';
      rerunBtn.id = 'stage-mask-rerun';
      rerunBtn.className = 'btn btn-secondary hidden';
      const doneBtn = document.createElement('button');
      doneBtn.type = 'button';
      doneBtn.id = 'stage-mask-done';
      doneBtn.className = 'btn btn-primary hidden';
      if (actionsRow) { actionsRow.appendChild(rerunBtn); actionsRow.appendChild(doneBtn); }

      // "?" help icon shown next to the title during the refine phase.
      const helpIcon = document.createElement('span');
      helpIcon.className = 'smask-help hidden';
      helpIcon.tabIndex = 0;
      helpIcon.setAttribute('role', 'button');
      helpIcon.textContent = '?';
      const helpTip = document.createElement('span');
      helpTip.className = 'smask-help__tip';
      helpIcon.appendChild(helpTip);
      const maskHeader = maskModal.querySelector('.stage-mask-header');
      if (maskHeader) maskHeader.insertBefore(helpIcon, maskHeader.querySelector('.stage-mask-close'));

      // One-time styles for the in-modal blur + spinner overlay (self-contained
      // so the whole feature mirrors cleanly into the AI Designer).
      if (!document.getElementById('smask-refine-styles')) {
        const st = document.createElement('style');
        st.id = 'smask-refine-styles';
        st.textContent =
          '.stage-mask-canvas-container.smask-busy .stage-mask-canvas{filter:blur(6px) brightness(.98);}' +
          '.smask-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:rgba(255,255,255,.4);z-index:6;border-radius:inherit;}' +
          '.smask-overlay__spin{width:46px;height:46px;border-radius:50%;border:4px solid rgba(37,99,235,.25);border-top-color:#2563eb;animation:smask-spin .9s linear infinite;}' +
          '.smask-overlay__msg{font-weight:600;color:#1f2937;font-size:14px;text-align:center;max-width:80%;padding:0 12px;}' +
          '.smask-help{position:relative;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;border:1.5px solid #94a3b8;color:#64748b;font-size:11px;font-weight:700;cursor:help;margin-left:6px;margin-right:auto;line-height:1;user-select:none;flex:0 0 auto;}' +
          '.smask-help.hidden{display:none;}' +
          '.smask-help__tip{position:absolute;top:140%;left:0;width:min(290px,72vw);background:#1f2937;color:#fff;font-size:12px;font-weight:400;line-height:1.45;padding:10px 12px;border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.22);opacity:0;visibility:hidden;transition:opacity .15s ease;z-index:30;text-align:left;pointer-events:none;white-space:normal;}' +
          '.smask-help:hover .smask-help__tip,.smask-help:focus .smask-help__tip,.smask-help:focus-within .smask-help__tip{opacity:1;visibility:visible;}' +
          '@keyframes smask-spin{to{transform:rotate(360deg);}}';
        document.head.appendChild(st);
      }

      const LOAD_MESSAGES = [
        'Applying your edit…',
        'Reworking the masked area…',
        'Blending in the new details…',
        'Refining textures and lighting…',
        'Adding finishing touches…',
      ];

      function ensureOverlay() {
        if (loadingOverlay || !canvasContainer) return;
        if (getComputedStyle(canvasContainer).position === 'static') {
          canvasContainer.style.position = 'relative';
        }
        loadingOverlay = document.createElement('div');
        loadingOverlay.className = 'smask-overlay hidden';
        const spin = document.createElement('div');
        spin.className = 'smask-overlay__spin';
        const msg = document.createElement('div');
        msg.className = 'smask-overlay__msg';
        loadingOverlay.appendChild(spin);
        loadingOverlay.appendChild(msg);
        canvasContainer.appendChild(loadingOverlay);
      }

      function startOverlay() {
        ensureOverlay();
        if (canvasContainer) canvasContainer.classList.add('smask-busy');
        if (!loadingOverlay) return;
        loadingOverlay.classList.remove('hidden');
        const msgEl = loadingOverlay.querySelector('.smask-overlay__msg');
        let i = 0;
        if (msgEl) msgEl.textContent = tx('pdf.maskEditor.loadApplying', LOAD_MESSAGES[0]);
        if (loadMsgTimer) clearInterval(loadMsgTimer);
        loadMsgTimer = setInterval(() => {
          i = (i + 1) % LOAD_MESSAGES.length;
          if (msgEl) msgEl.textContent = LOAD_MESSAGES[i];
        }, 2000);
      }

      function stopOverlay() {
        if (loadMsgTimer) { clearInterval(loadMsgTimer); loadMsgTimer = null; }
        if (canvasContainer) canvasContainer.classList.remove('smask-busy');
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
      }

      function setControlsDisabled(dis) {
        [cancelBtn, clearBtn, submitBtn, rerunBtn, doneBtn, brushToolBtn, eraseToolBtn, brushSlider, promptInput, refAddBtn, refRemoveBtn]
          .forEach((el) => { if (el) el.disabled = dis; });
      }

      // Recolor every painted stroke to `color` (keeps alpha, swaps hue). Used to
      // switch the selection to the refine-phase color. Mask logic reads alpha, so
      // this is purely cosmetic.
      function recolorMask(color) {
        if (!drawCanvas.width || !drawCanvas.height) return;
        const ctx = drawCanvas.getContext('2d');
        ctx.save();
        ctx.globalCompositeOperation = 'source-in';
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, drawCanvas.width, drawCanvas.height);
        ctx.restore();
      }

      // Switch the editor between drawing, loading and refine phases.
      function setPhase(p) {
        phase = p;
        const titleEl = maskModal.querySelector('.stage-mask-title');
        if (p === 'loading') {
          if (canvasContainer) canvasContainer.classList.add('processing');
          setControlsDisabled(true);
          startOverlay();
          drawCanvas.style.pointerEvents = 'none';
          return;
        }
        stopOverlay();
        if (canvasContainer) canvasContainer.classList.remove('processing');
        setControlsDisabled(false);
        drawCanvas.style.pointerEvents = 'auto';
        drawCanvas.style.cursor = 'crosshair';
        if (p === 'refine') {
          if (submitBtn) submitBtn.classList.add('hidden');
          if (clearBtn) clearBtn.classList.add('hidden');
          rerunBtn.classList.remove('hidden');
          doneBtn.classList.remove('hidden');
          rerunBtn.textContent = tx('pdf.maskEditor.rerun', 'Regenerate');
          doneBtn.textContent = tx('pdf.maskEditor.done', 'Looks good');
          if (titleEl) titleEl.textContent = tx('pdf.maskEditor.refineTitle', 'Refine the edit');
          helpIcon.classList.remove('hidden');
          helpIcon.setAttribute('aria-label', tx('pdf.maskEditor.refineHelpAria', 'What the refine step does'));
          helpTip.textContent = tx('pdf.maskEditor.refineHelp', "This step just fine-tunes where the AI's change shows — it doesn't run the AI again. Brush to reveal more of the edit, erase to pull it back. It's a safety net so the edit only touches the area you picked and can't mess up the rest of your photo. The faded preview shown on top is only there so you can see the full edit while refining — it won't be in the final image.");
          recolorMask('#16a34a');
          if (noteEl) { noteEl.style.display = ''; noteEl.textContent = tx('pdf.maskEditor.refineNote', "Brush to reveal more of the edit, erase to hide it — this only re-crops, it won't re-run the AI."); }
          updateSubmitState();
        } else { // draw
          if (submitBtn) submitBtn.classList.remove('hidden');
          if (clearBtn) clearBtn.classList.remove('hidden');
          rerunBtn.classList.add('hidden');
          doneBtn.classList.add('hidden');
          helpIcon.classList.add('hidden');
          applyEditorCopy();
          if (noteEl) { noteEl.style.display = 'none'; noteEl.textContent = ''; }
        }
      }

      function isProcessing() {
        return canvasContainer && canvasContainer.classList.contains('processing');
      }

      function tx(key, def) {
        const v = window.LanguageSystem && window.LanguageSystem.getText(key);
        return v && v !== 'Loading...' ? v : def;
      }

      // Swap the editor's title, prompt label/placeholder and submit label to
      // match the current mode.
      function applyEditorCopy() {
        const titleEl = maskModal.querySelector('.stage-mask-title');
        const labelEl = maskModal.querySelector('.stage-mask-prompt-label');
        const submitStrong = submitBtn && submitBtn.querySelector('strong');
        if (editorMode === 'before') {
          if (titleEl) titleEl.textContent = tx('modal.staging.maskBeforeTitle', 'Mask & edit photo');
          if (labelEl) labelEl.textContent = tx('modal.staging.maskBeforePromptLabel', 'What would you like to change in the painted area?');
          if (promptInput) promptInput.placeholder = tx('modal.staging.maskBeforePromptPlaceholder', 'e.g., remove the old sofa, clear the clutter, repaint the wall white');
          if (submitStrong) submitStrong.textContent = tx('modal.staging.maskBeforeApply', 'Apply edit');
        } else {
          if (titleEl) titleEl.textContent = tx('pdf.maskEditor.title', 'Edit with Mask');
          if (labelEl) labelEl.textContent = tx('pdf.maskEditor.promptLabel', 'What would you like to change in the masked area?');
          if (promptInput) promptInput.placeholder = tx('pdf.maskEditor.promptPlaceholder', '');
          if (submitStrong) submitStrong.textContent = tx('pdf.maskEditor.applyEdit', 'Apply Edit');
        }
      }

      // Tell the user they've hit the per-image mask cap.
      function atVersionLimit(kind) {
        const list = kind === 'before' ? beforeVersions : afterVersions;
        if (list.length < MAX_MASK_VERSIONS) return false;
        alert(tx('modal.staging.maskLimitReached',
          "You've reached the limit of " + MAX_MASK_VERSIONS + ' versions for this image.'));
        return true;
      }

      // Shared: load a source image into the base/draw canvases and open the modal.
      function showInEditor(src) {
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
          painted = false;
          setTool('brush');

          scaleX = dispW / img.width;
          scaleY = dispH / img.height;

          if (canvasContainer) canvasContainer.classList.remove('processing');
          drawCanvas.style.pointerEvents = 'auto';
          drawCanvas.style.cursor = 'crosshair';
          updateSubmitState();
          refineState = null;
          setPhase('draw');
          maskModal.classList.add('active');
          maskModal.setAttribute('aria-hidden', 'false');
        };
        img.src = src;
      }

      // After-mode: refine the currently-shown staged result; append a new version.
      function openEditor() {
        if (!canvas1.width) return;
        if (atVersionLimit('after')) return;
        editorMode = 'after';
        applyEditorCopy();
        clearMaskReference();
        if (promptInput) promptInput.value = '';
        showInEditor(canvas1.toDataURL('image/png'));
      }

      // Before-mode: edit the currently-shown original photo; append a new before variant.
      function openBeforeEditor() {
        const src = stagePreview && stagePreview.src;
        if (!src) return;
        if (atVersionLimit('before')) return;
        editorMode = 'before';
        applyEditorCopy();
        clearMaskReference();
        if (promptInput) promptInput.value = '';
        showInEditor(src);
      }

      function clearMaskReference() {
        maskReferenceDataUrl = null;
        if (refFileInput) refFileInput.value = '';
        if (refPreview) refPreview.classList.add('hidden');
        if (refImg) refImg.removeAttribute('src');
        if (refAddBtn) refAddBtn.classList.remove('hidden');
      }

      function setMaskReference(dataUrl) {
        maskReferenceDataUrl = dataUrl;
        if (refImg) refImg.src = dataUrl;
        if (refPreview) refPreview.classList.remove('hidden');
        if (refAddBtn) refAddBtn.classList.add('hidden');
      }

      // Validate, downscale (max 1536px), and PNG-encode a chosen reference file so
      // the payload is always small, clean, and a format the backend accepts.
      // Resolves to a data URL; rejects with 'type' | 'size' | 'read' | 'decode'.
      function prepareReferenceFile(file) {
        return new Promise((resolve, reject) => {
          if (!file || !/^image\/(jpeg|jpg|png|webp)$/i.test(file.type || '')) { reject(new Error('type')); return; }
          if (file.size > 25 * 1024 * 1024) { reject(new Error('size')); return; }
          const reader = new FileReader();
          reader.onerror = () => reject(new Error('read'));
          reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('decode'));
            img.onload = () => {
              const maxDim = 1536;
              const scale = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
              const w = Math.max(1, Math.round((img.width || 1) * scale));
              const h = Math.max(1, Math.round((img.height || 1) * scale));
              const c = document.createElement('canvas');
              c.width = w; c.height = h;
              c.getContext('2d').drawImage(img, 0, 0, w, h);
              try { resolve(c.toDataURL('image/png')); } catch (e) { reject(new Error('decode')); }
            };
            img.src = reader.result;
          };
          reader.readAsDataURL(file);
        });
      }

      function refErrorMessage(err) {
        const key = err && err.message === 'size' ? 'pdf.maskEditor.referenceTooLarge' : 'pdf.maskEditor.referenceInvalid';
        const fallback = err && err.message === 'size'
          ? 'That image is too large — please choose one under 25 MB.'
          : 'Please choose a valid JPG, PNG, or WebP image.';
        const t = window.LanguageSystem && window.LanguageSystem.getText(key);
        return (t && t !== 'Loading...') ? t : fallback;
      }

      function closeEditor() {
        maskModal.classList.remove('active');
        maskModal.setAttribute('aria-hidden', 'true');
        stopOverlay();
        clearDraw();
        clearMaskReference();
        refineState = null;
        phase = 'draw';
        if (submitBtn) submitBtn.classList.remove('hidden');
        if (clearBtn) clearBtn.classList.remove('hidden');
        rerunBtn.classList.add('hidden');
        doneBtn.classList.add('hidden');
        setControlsDisabled(false);
        if (canvasContainer) canvasContainer.classList.remove('processing', 'smask-busy');
        if (processBtn) processBtn.disabled = false;
        if (typeof updateMaskButtonVisibility === 'function') updateMaskButtonVisibility();
      }

      function clearDraw() {
        const ctx = drawCanvas.getContext('2d');
        ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
        painted = false;
        updateSubmitState();
      }

      function maskHasContent() {
        return painted;
      }

      // Accurate (but expensive) scan — only used on stroke end, never per-move,
      // so erasing the last of the selection correctly disables Submit.
      function scanHasContent() {
        if (!drawCanvas.width || !drawCanvas.height) return false;
        const d = drawCanvas.getContext('2d').getImageData(0, 0, drawCanvas.width, drawCanvas.height).data;
        for (let i = 3; i < d.length; i += 4) {
          if (d[i] > 10) return true;
        }
        return false;
      }

      function updateSubmitState() {
        const hasPrompt = promptInput && promptInput.value.trim().length > 0;
        const ready = painted && hasPrompt;
        if (submitBtn) submitBtn.disabled = !ready;
        if (rerunBtn) rerunBtn.disabled = !ready;
      }

      function setTool(t) {
        tool = t === 'erase' ? 'erase' : 'brush';
        if (brushToolBtn) {
          brushToolBtn.classList.toggle('is-active', tool === 'brush');
          brushToolBtn.setAttribute('aria-pressed', tool === 'brush' ? 'true' : 'false');
        }
        if (eraseToolBtn) {
          eraseToolBtn.classList.toggle('is-active', tool === 'erase');
          eraseToolBtn.setAttribute('aria-pressed', tool === 'erase' ? 'true' : 'false');
        }
      }

      function paint(e) {
        if (!drawing || isProcessing()) return;
        const rect = drawCanvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) / scaleX;
        const y = (e.clientY - rect.top) / scaleY;
        const ctx = drawCanvas.getContext('2d');
        // Paint one continuous, fully-opaque stroke with round caps/joins. Erase
        // mode uses destination-out so the stroke removes from the selection
        // instead of adding to it. Solid pixels keep the shape clean; the
        // translucent look comes from the canvas element's CSS opacity.
        ctx.globalCompositeOperation = tool === 'erase' ? 'destination-out' : 'source-over';
        // Refine phase uses a distinct color so it's clear you're adjusting the
        // crop, not selecting a fresh area.
        const brushColor = phase === 'refine' ? '#16a34a' : '#2563eb';
        ctx.strokeStyle = brushColor;
        ctx.fillStyle = brushColor;
        ctx.lineWidth = brushSize;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (lastX === null || lastY === null) {
          // Single tap/click: lay down a round dot.
          ctx.beginPath();
          ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.moveTo(lastX, lastY);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
        ctx.globalCompositeOperation = 'source-over';
        lastX = x;
        lastY = y;
        if (tool === 'brush' && !painted) {
          // First brush mark: flip the flag and refresh the button once (cheap).
          painted = true;
          updateSubmitState();
        }
      }

      function startDraw(e) {
        if (isProcessing()) return;
        drawing = true;
        lastX = null;
        lastY = null;
        paint(e);
      }

      function stopDraw() {
        if (!drawing) return;
        drawing = false;
        lastX = null;
        lastY = null;
        // Recompute accurately once per stroke (handles erasing the selection away).
        painted = scanHasContent();
        updateSubmitState();
        // In refine mode, re-crop the existing AI output through the new strokes —
        // instant and free, no API call.
        if (phase === 'refine') renderRefinePreview();
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
      if (brushToolBtn) brushToolBtn.addEventListener('click', () => setTool('brush'));
      if (eraseToolBtn) eraseToolBtn.addEventListener('click', () => setTool('erase'));
      // Accept a single reference file from either the picker or a drop: validate
      // + downscale, then show it (or surface the error). Shared so both paths
      // behave identically.
      function acceptReferenceFile(file) {
        if (!file) return;
        prepareReferenceFile(file)
          .then(setMaskReference)
          .catch((err) => { clearMaskReference(); alert(refErrorMessage(err)); });
      }
      if (refAddBtn && refFileInput) {
        refAddBtn.addEventListener('click', () => refFileInput.click());
        refFileInput.addEventListener('change', () => {
          const file = refFileInput.files && refFileInput.files[0];
          refFileInput.value = ''; // allow re-selecting the same file later
          acceptReferenceFile(file);
        });
      }
      if (refRemoveBtn) refRemoveBtn.addEventListener('click', clearMaskReference);

      // Drag-and-drop: drop an image onto the "+ Add photo" button (or, once one
      // is set, onto its preview to replace it) — same path as picking a file.
      // Highlights the button while a valid file-drag hovers a drop zone.
      (function wireMaskRefDrop() {
        const zones = [refAddBtn, refPreview].filter(Boolean);
        if (!zones.length) return;
        let dragDepth = 0;
        const hasFiles = (e) =>
          !!e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1;
        zones.forEach((zone) => {
          zone.addEventListener('dragenter', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            dragDepth++;
            if (refAddBtn) refAddBtn.classList.add('is-drag-over');
          });
          zone.addEventListener('dragover', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
          });
          zone.addEventListener('dragleave', () => {
            dragDepth = Math.max(0, dragDepth - 1);
            if (dragDepth === 0 && refAddBtn) refAddBtn.classList.remove('is-drag-over');
          });
          zone.addEventListener('drop', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            dragDepth = 0;
            if (refAddBtn) refAddBtn.classList.remove('is-drag-over');
            acceptReferenceFile(e.dataTransfer.files && e.dataTransfer.files[0]);
          });
        });
      })();
      // Same paint-brush FAB on both views: edits the staged result on After,
      // or the original photo on Before.
      if (maskEditBtn) maskEditBtn.addEventListener('click', () => {
        if (activeViewIsAfter()) openEditor();
        else openBeforeEditor();
      });
      maskModal.addEventListener('click', (e) => { if (e.target === maskModal && phase !== 'loading') closeEditor(); });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && maskModal.classList.contains('active') && phase !== 'loading') closeEditor();
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

      function loadImage(src) {
        return new Promise((resolve, reject) => {
          const im = new Image();
          im.onload = () => resolve(im);
          im.onerror = () => reject(new Error('Failed to load edited image'));
          im.src = src;
        });
      }

      function snapshotCanvas(src, w, h) {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(src, 0, 0);
        return c;
      }

      // Re-composite the (already generated) AI output through the CURRENT brush
      // strokes onto the pristine original, and show it in the editor. This is the
      // instant, free "refine the crop" step — no API call.
      function renderRefinePreview() {
        if (!refineState) return;
        const { origCanvas, w, h, coreGrow, featherPx, editedImg } = refineState;
        const keep = buildBlendMask(drawCanvas, w, h, coreGrow, featherPx);
        const composed = compositeMaskedEditCanvas(origCanvas, keep, editedImg, w, h);
        const bctx = baseCanvas.getContext('2d');
        bctx.clearRect(0, 0, w, h);
        bctx.drawImage(composed, 0, 0);
        // Ghost the FULL raw AI output on top at 55% so the user can see the entire
        // generated region — including parts outside the current brush — and judge
        // where to extend or trim the mask. Visual only: the committed result is
        // re-composited cleanly from refineState (see commitRefine), never the canvas.
        bctx.save();
        bctx.globalAlpha = 0.55;
        bctx.drawImage(editedImg, 0, 0, w, h);
        bctx.restore();
      }

      // POST the current strokes + prompt (+ optional reference) to the model and
      // resolve to the raw edited Image. Throws on failure.
      async function runGenerate(origCanvas, w, h, prompt, coreGrow) {
        const imageDataUrl = origCanvas.toDataURL('image/png');
        const maskDataUrl = buildModelMask(drawCanvas, w, h, coreGrow).toDataURL('image/png');
        let selectedModel = 'gpt-4o-mini';
        const modelSel = document.getElementById('stagify-model-select');
        if (modelSel && modelSel.value) selectedModel = modelSel.value;
        const referenceImageForRequest = maskReferenceDataUrl;
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
            ...(referenceImageForRequest ? { referenceImage: referenceImageForRequest } : {}),
          }),
        });
        const result = await response.json();
        if (!response.ok || !result.editedImage) {
          throw new Error(result.error || 'Failed to process masked edit');
        }
        return loadImage(result.editedImage);
      }

      // "Apply Edit" (draw phase): generate, then enter refine mode in-modal.
      async function submitEdit() {
        if (phase !== 'draw') return;
        const prompt = promptInput ? promptInput.value.trim() : '';
        if (!prompt || !maskHasContent()) return;
        // Snapshot the pristine source while it's still on the base canvas; in
        // refine mode the base canvas gets overwritten with the composite.
        const w = baseCanvas.width;
        const h = baseCanvas.height;
        const origCanvas = snapshotCanvas(baseCanvas, w, h);
        // Secret brush expansion: grow a little so slight under-brushing is still
        // covered, with a feathered edge so the composite shows no seam. Kept modest
        // (~half what it used to be) now that the refine step lets users extend the
        // mask themselves.
        const maxDim = Math.max(w, h);
        const coreGrow = Math.max(12, Math.round(maxDim * 0.02275));
        const featherPx = Math.max(20, Math.round(maxDim * 0.04));
        const isBefore = editorMode === 'before';
        if (processBtn) processBtn.disabled = true;
        setPhase('loading');
        try {
          const editedImg = await runGenerate(origCanvas, w, h, prompt, coreGrow);
          if (!maskModal.classList.contains('active')) return; // closed mid-flight
          refineState = { origCanvas, w, h, coreGrow, featherPx, editedImg, isBefore };
          setPhase('refine');
          renderRefinePreview();
        } catch (err) {
          console.error('Mask edit failed:', err);
          setPhase('draw');
          if (processBtn) processBtn.disabled = false;
          alert(err.message || 'Mask edit failed. Please try again.');
        }
      }

      // "Regenerate" (refine phase): run the AI again with the refined strokes.
      async function rerunAI() {
        if (phase !== 'refine' || !refineState) return;
        const prompt = promptInput ? promptInput.value.trim() : '';
        if (!prompt || !maskHasContent()) return;
        const { origCanvas, w, h, coreGrow } = refineState;
        if (processBtn) processBtn.disabled = true;
        setPhase('loading');
        try {
          const editedImg = await runGenerate(origCanvas, w, h, prompt, coreGrow);
          if (!maskModal.classList.contains('active')) return;
          refineState.editedImg = editedImg;
          setPhase('refine');
          renderRefinePreview();
        } catch (err) {
          console.error('Mask re-run failed:', err);
          setPhase('refine'); // keep the previous result intact
          renderRefinePreview();
          alert(err.message || 'Mask edit failed. Please try again.');
        }
      }

      // "Looks good" (refine phase): commit the current composite as a new version.
      async function commitRefine() {
        if (!refineState) { closeEditor(); return; }
        const { origCanvas, w, h, coreGrow, featherPx, editedImg, isBefore } = refineState;
        const keep = buildBlendMask(drawCanvas, w, h, coreGrow, featherPx);
        const finalUrl = compositeMaskedEdit(origCanvas, keep, editedImg, w, h);
        closeEditor();
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
      }

      if (submitBtn) submitBtn.addEventListener('click', submitEdit);
      rerunBtn.addEventListener('click', rerunAI);
      doneBtn.addEventListener('click', commitRefine);
    })();
  
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
  
  
  
