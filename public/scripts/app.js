import { dataURLToFile, fillTemplate, dailyLimitMessage, roomDownloadSlug } from './app/helpers.js';
import { showErrorToast } from './toast.js';
import { createStageMaskEditor } from './app/stage-mask-editor.js';
import { initCustomSelect } from './app/custom-select.js';
import { syncRemoveFurnitureRow } from './app/remove-furniture-gate.js';
import { initStampStyleRow } from './app/stamp-style-row.js';
import { initMaskStampPlacement } from './app/mask-stamp.js';
import { initBackgroundVideoSync } from './app/background-video.js';
import { init3DTiltEffect } from './app/tilt-effect.js';
import { loadHeroStats, updateHeroFreeGensLine } from './app/hero-stats.js';
import { validateStageableUpload } from './app/stage-validation.js';
import { unstageableMessage } from './unstageable-message.js';
import { syncStagingErrorCta } from './app/staging-error-cta.js';
import { createFurnitureRefs, FURNITURE_LIMIT } from './app/furniture-refs.js';
import { createVersionCarousel } from './app/version-carousel.js';
import { createDownloadMenu } from './app/download-menu.js';
import { createStagingPipeline } from './app/staging-pipeline.js';
import { createStagingFailure } from './app/staging-failure.js';
import { createEmptyRoomViewer } from './app/empty-room-viewer.js';
import { readImageFile } from './app/image-file.js';
import { initStagingEntry } from './app/staging-entry.js';
import { initPlusRail } from './app/plus-rail.js';

    const $ = (sel) => document.querySelector(sel);

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

    // The badge style/size strip owns its own reveal (the checkbox above it is its only
    // gate), so unlike syncRemoveFurnitureUI there is nothing for app.js to re-run.
    initStampStyleRow();
    // The same control again, in the Basic Mask dialog — same module, different container.
    // Its options float over the canvas instead of sitting in a row (the dialog's height is
    // spoken for), but the behaviour is identical, so there is nothing extra to wire.
    initStampStyleRow({ optsId: 'mask-stamp-opts', checkboxId: 'mask-label-virtually-staged' });
    // …and it sits in a different PARENT on a phone — see mask-stamp.js.
    initMaskStampPlacement();

    // The Stagify+ rail's disclosure button. Only the open/shut state — whether the
    // rail is on screen at all belongs to the plan, and auth.js owns that half.
    initPlusRail();

    // The two controls that open the staging flow: the hero CTA, and the closing
    // row's button at the foot of the page. This looked up THREE ids until 2026-08-18
    // — `#nav-upload` and `#pricing-upload` existed in no HTML file on the site, so
    // the array had been binding two nulls for as long as anyone can tell. Add a
    // third entry point here; do not revive a dead id. Guard: home-outro.test.js.
    const heroUpload = $('#hero-upload');
    const outroUpload = $('#outro-upload');

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
    // Picking a room type can withdraw the remove-existing-furniture option (a dorm's
    // issued furniture is fixed), so re-run the shared gate on every change.
    const roomSelect = initCustomSelect('#room-type-select', { onChange: syncRemoveFurnitureRow });
    const styleSelect = initCustomSelect('#furniture-style-select');
    const progress = $('#progress');
    const progressBar = $('#progress-bar');
    const progressText = $('#progress-text');
    const loadingMessage = $('#loading-message');
    const stagingLimitViewer = $('#staging-limit-viewer');
    const stagingLimitViewerText = $('#staging-limit-viewer-text');
    const stagingErrorViewer = $('#staging-error-viewer');
    const stagingErrorViewerText = $('#staging-error-viewer-text');

    function showStagingError(message, verdict) {
      if (stagingErrorViewerText) stagingErrorViewerText.textContent = message || '';
      syncStagingErrorCta(verdict);
      if (stagingErrorViewer) stagingErrorViewer.classList.remove('hidden');
    }
    function hideStagingError() {
      syncStagingErrorCta(null);
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

    // No retry button on the rejection panel: "Upload Another" (#new-upload) is in the
    // viewer header above it and stays live behind the panel, so one was the other twice.
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

    // Version carousels: the before view holds the uploaded photo plus any
    // masked edits of it; the after view holds the staged result(s) plus any
    // masked refinements. Each is capped so the 6th mask attempt is blocked.
    const MAX_MASK_VERSIONS = 6;

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
      [heroUpload, outroUpload].forEach((btn) => {
        if (btn) btn.addEventListener('click', openFilePicker);
      });
  
      // Drag and drop on stage screen. The state is a CLASS, not an inline
      // style: this used to write style.borderColor, which outranks every rule
      // in styles.css, so after one drag the element kept a hard-coded grey and
      // the :hover feedback was dead for the rest of the session. Same
      // .is-drag-over name the two studio dropzones already use.
      ;['dragenter','dragover'].forEach(evt => {
        stageDropzone.addEventListener(evt, (e) => { e.preventDefault(); stageDropzone.classList.add('is-drag-over'); });
      });
      ;['dragleave','drop'].forEach(evt => {
        stageDropzone.addEventListener(evt, (e) => { e.preventDefault(); stageDropzone.classList.remove('is-drag-over'); });
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

    async function handleStageFile(file) {
      // HEIC conversion, the type allowlist and the 100MB ceiling live in
      // app/image-file.js — the Basic Mask uploader applies the same three.
      const read = await readImageFile(file, { showError: showErrorToast });
      if (!read) return;
      const { dataUrl } = read;

      currentImageFile = read.file; // Store the file for processing
      hasProcessedImage = false; // Reset processing state for new image
      hideStagingLimitInViewer();
      stagePreview.src = dataUrl;
      // Seed the before carousel with the original photo; reset the after carousel.
      setBeforeVersions([dataUrl]);
      setAfterVersions([]);
      stagePreview.alt = getStagingAlt('uploadedRoomAlt', {
        filenameSuffix: read.file.name ? ': ' + read.file.name : '',
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
      const checkForFile = read.file;
      stageValidationResult = null;
      stageValidation = validateStageableUpload(dataUrl);
      stageValidation.then((r) => {
        const result = r || { valid: true, reason: '' };
        if (currentImageFile === checkForFile) {
          stageValidationResult = result;
          if (result.valid === false) {
            showStagingError(unstageableMessage(result), result);
          }
        }
      });
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
      getAfterIndex,
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

    // Staging generation + progress UI live in their own island
    // (scripts/app/staging-pipeline.js); the entry injects the DOM refs, the
    // shared upload/validation state (as getters) and the messaging helpers.
    // What happens when staging throws (scripts/app/staging-failure.js): the sign-in
    // prompt on an expired session, and a message for every failure the pipeline threw
    // without painting one itself.
    const { handleStagingFailure } = createStagingFailure({
      showStagingError,
      getProfileMenu: () => window.StagifyProfileMenu,
      openAuthForStaging: () => window.__stagifyOpenAuthForStaging?.(),
      getText: (key) => window.LanguageSystem?.getText(key),
    });

    const { processWithAI } = createStagingPipeline({
      stagePreview, progress, progressBar, progressText, loadingMessage, processingPlaceholder,
      roomSelect, styleSelect, additionalPrompt, furnitureRefs, FURNITURE_LIMIT,
      getStageValidation: () => stageValidation,
      getStageValidationResult: () => stageValidationResult,
      getHasProcessedImage: () => hasProcessedImage,
      setLastEmptyRoomUrl: (v) => { lastEmptyRoomUrl = v; },
      hideStagingLimitInViewer, hideStagingError, showBeforeView, isProUser,
      showStagingError, messageForDailyLimitResponse, showStagingLimitInViewer,
    });

  
    async function stageImage() {
      if (!currentImageFile) {
        showErrorToast(window.LanguageSystem?.getText('errors.uploadFirst') || 'Please upload an image first');
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
         handleStagingFailure(error);
       }
    }
  
    // Only add modal event listeners if elements exist
    if (processBtn) processBtn.addEventListener('click', stageImage);
    if (modalBackdrop) modalBackdrop.addEventListener('click', closeModal);
    if (modalClose) modalClose.addEventListener('click', closeModal);
  
    // Download affordances for the staged result (scripts/app/download-menu.js): the
    // plain full-size button plus the caret's resolution menu. "Original" reads the
    // FIRST before-version (the untouched upload) rather than stagePreview, whose
    // src follows the before carousel.
    createDownloadMenu({
      downloadBtn, canvas: canvas1,
      split: $('#download-split'), toggle: $('#download-size-toggle'), menu: $('#download-size-menu'),
      getOriginalSrc: () => getBeforeVersions()[0] || stagePreview?.src || '',
      // Whatever after-version is CURRENTLY painted on canvas1 — server-side resize needs
      // the source bytes, not just the pixels canvas.toDataURL() can already read back.
      getCurrentAfterSrc: () => getAfterVersions()[getAfterIndex()] || '',
      buildFilename: (w, h) =>
        `stagify-${roomDownloadSlug(roomSelect?.value)}-${Date.now()}${w ? `-${w}x${h}` : ''}.jpg`,
    });

    // Empty-room viewer island (scripts/app/empty-room-viewer.js).
    createEmptyRoomViewer({
      emptyRoomModal, emptyRoomImage, emptyRoomClose, emptyRoomDownload, emptyRoomBtn,
      roomSelect, getLastEmptyRoomUrl: () => lastEmptyRoomUrl,
    });

    // ── Mask editor for staged "After" images (pro only) ──
    // Extracted island (scripts/app/stage-mask-editor.js): owns the modal + its
    // state machine; the entry injects the DOM/state glue plus a commit callback
    // that applies the new version to the shared before/after arrays + display.
    const maskEditor = createStageMaskEditor({
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

    // The top nav's "Staging" dropdown lives on nine pages; these two screens
    // live only on this one. app/staging-entry.js publishes the hooks it calls
    // when the visitor is already here, and consumes the #stage / #basic-mask
    // fragment it navigates to when they aren't.
    if (modal) {
      initStagingEntry({
        openStaging: openFilePicker,
        openBasicMask: () => maskEditor.openStandalone(),
        isPro: isProUser,
      });
    }

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
  
  
  
  
