// Mask editor island for the AI Designer chat.
//
// The brush-mask "edit with AI" subsystem: its own modal DOM, canvas drawing,
// phase state machine (draw -> loading -> refine), reference photo, the
// /api/mask-edit call, and commit-back-to-carousel. Lifted verbatim from the
// entry as a factory that closes over its own state and receives what it needs
// from the entry via deps (so the entry sheds ~1000 lines of mask glue).
//
// deps: { lang, showToast, createOrUpdateMaskedImageCarousel, addMessage,
//         syncImageThumbnailStrip, collectImagesFromConversationHistory,
//         pushHistoryEntry }  ->  returns { openMaskEditor }
// Window globals (visualViewport, matchMedia, LanguageSystem, StagifyHeic,
// StagifyAuth, getSelectedModelApiName) are referenced directly.
import { getRootBaseNameForImage } from './image-history.js';
import { updateMaskEditorTranslations } from './mask-editor-i18n.js';
import { createMaskViewport } from './mask-viewport.js';
import { createMaskOverlay } from './mask-overlay.js';
import { createMaskReference } from './mask-reference.js';

export function createMaskEditor(deps) {
  const {
    lang,
    showToast,
    createOrUpdateMaskedImageCarousel,
    addMessage,
    syncImageThumbnailStrip,
    collectImagesFromConversationHistory,
    pushHistoryEntry,
  } = deps;

  // Extracted mask-editor slices (self-contained; each owns its own DOM/state).
  const viewport = createMaskViewport();
  const overlay = createMaskOverlay({ lang });
  const reference = createMaskReference({ lang, showToast });

      // Mask editor functionality
      // Track original image containers and their masked versions
      const maskedImageData = new Map(); // Map<originalImageSrc, {container, originalSrc, maskedVersions: []}>
      
      function openMaskEditor(imageSrc, imageType) {
        const modal = document.getElementById('mask-editor-modal');
        if (!modal) {
          createMaskEditorModal();
        }
        
        // Find the original image container
        let originalContainer = null;
        const allContainers = document.querySelectorAll('.ai-image-container');
        for (const container of allContainers) {
          const img = /** @type {HTMLImageElement} */ (container.querySelector('.ai-generated-image'));
          if (img && img.src === imageSrc) {
            originalContainer = container;
            break;
          }
        }
        
        // Check if this image is already in a carousel
        const carouselItem = document.querySelector(`.masked-image-carousel-item img[src="${imageSrc}"]`);
        if (carouselItem) {
          originalContainer = carouselItem.closest('.masked-image-carousel');
        }
        
        // Determine the original image source
        // If this image is in a carousel, find the original (first image in carousel)
        let originalImageSrc = imageSrc;
        if (carouselItem) {
          const carousel = carouselItem.closest('.masked-image-carousel');
          if (carousel) {
            const firstItem = /** @type {HTMLImageElement} */ (carousel.querySelector('.masked-image-carousel-item:first-child img'));
            if (firstItem) {
              originalImageSrc = firstItem.src;
            }
          }
        }
        
        // Store reference to original container and image source
        if (!maskedImageData.has(originalImageSrc)) {
          maskedImageData.set(originalImageSrc, {
            container: originalContainer,
            originalSrc: originalImageSrc,
            maskedVersions: []
          });
        }
        
        const existingModal = document.getElementById('mask-editor-modal');
        const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('mask-editor-canvas'));
        const promptInput = /** @type {HTMLInputElement} */ (document.getElementById('mask-editor-prompt'));
        
        // Load image onto canvas
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          // Calculate display size (maintain aspect ratio). On mobile, use the
          // visual viewport height and a smaller fraction so the image leaves room
          // for the header + controls + action buttons without excessive scrolling.
          const isMobileViewport = window.matchMedia('(max-width: 768px)').matches;
          const viewportH = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
          const viewportW = (window.visualViewport && window.visualViewport.width) || window.innerWidth;
          const maxHeight = viewportH * (isMobileViewport ? 0.5 : 0.7);
          const maxWidth = viewportW * 0.9;
          let displayWidth = img.width;
          let displayHeight = img.height;
          
          if (displayHeight > maxHeight) {
            displayWidth = (maxHeight / displayHeight) * displayWidth;
            displayHeight = maxHeight;
          }
          if (displayWidth > maxWidth) {
            displayHeight = (maxWidth / displayWidth) * displayHeight;
            displayWidth = maxWidth;
          }
          
          // Set canvas display size
          canvas.style.width = displayWidth + 'px';
          canvas.style.height = displayHeight + 'px';
          
          // Set canvas actual size (for drawing)
          canvas.width = img.width;
          canvas.height = img.height;
          
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, img.width, img.height);
          
          // Initialize mask canvas (transparent overlay)
          const maskCanvas = /** @type {HTMLCanvasElement} */ (document.getElementById('mask-editor-mask-canvas'));
          maskCanvas.width = img.width;
          maskCanvas.height = img.height;
          maskCanvas.style.width = displayWidth + 'px';
          maskCanvas.style.height = displayHeight + 'px';
          const maskCtx = maskCanvas.getContext('2d');
          maskCtx.fillStyle = 'rgba(37, 99, 235, 0.4)'; // Blue overlay for mask (Stagify blue)
          
          // Store image source and scale for later use
          canvas.dataset.imageSrc = imageSrc;
          canvas.dataset.imageType = imageType;
          canvas.dataset.originalWidth = String(img.width);
          canvas.dataset.originalHeight = String(img.height);
          
          existingModal.classList.add('active');
          viewport.bind();
          viewport.sync();
          maskPainted = false;
          setMaskTool('brush');
          initMaskDrawing(maskCanvas);
          
          // Clear prompt input and disable button initially
          if (promptInput) {
            promptInput.value = '';
          }
          reference.clear();
          
          // Remove blur effect if it exists (from previous session)
          const canvasContainer = document.querySelector('.mask-editor-canvas-container');
          if (canvasContainer) {
            canvasContainer.classList.remove('processing');
          }
          
          // Update translations when modal opens
          updateMaskEditorTranslations();

          updateApplyButtonState();
          maskRefineState = null;
          maskSetPhase('draw');
        };
        img.src = imageSrc;
      }
      
      function createMaskEditorModal() {
        const modal = document.createElement('div');
        modal.id = 'mask-editor-modal';
        modal.className = 'mask-editor-modal';
        
        modal.innerHTML = `
          <div class="mask-editor-content">
            <div class="mask-editor-header">
              <h2 class="mask-editor-title" data-i18n="pdf.maskEditor.title">Edit with Mask</h2>
              <button class="mask-editor-close" id="mask-editor-close">&times;</button>
            </div>
            <div class="mask-editor-canvas-container">
              <canvas id="mask-editor-canvas" class="mask-editor-canvas"></canvas>
              <canvas id="mask-editor-mask-canvas" class="mask-editor-canvas" style="position: absolute; top: 0; left: 0; pointer-events: auto; mix-blend-mode: multiply; opacity: 0.5; cursor: crosshair;"></canvas>
            </div>
            <div class="mask-editor-controls">
              <div class="mask-editor-toolrow">
              <div class="mask-editor-tools" role="group" aria-label="Mask tool">
                <button type="button" id="mask-editor-brush-btn" class="mask-editor-tool-btn is-active" aria-pressed="true">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/></svg>
                  <span data-i18n="pdf.maskEditor.brush">Brush</span>
                </button>
                <button type="button" id="mask-editor-erase-btn" class="mask-editor-tool-btn" aria-pressed="false">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20H7L3 16a2 2 0 0 1 0-3l9-9a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3l-7 8"/><path d="M6 11l7 7"/></svg>
                  <span data-i18n="pdf.maskEditor.erase">Erase</span>
                </button>
              </div>
                <p class="mask-editor-note" style="display:none"></p>
              </div>
              <div class="mask-editor-brush-controls">
                <label class="mask-editor-brush-label" data-i18n="pdf.maskEditor.brushSize">Brush Size:</label>
                <input type="range" id="mask-editor-brush-slider" class="mask-editor-brush-slider" min="20" max="150" value="50">
                <span id="mask-editor-brush-size" class="mask-editor-brush-size-display">50 px</span>
              </div>
              <div class="mask-editor-prompt-container">
                <label class="mask-editor-prompt-label" data-i18n="pdf.maskEditor.promptLabel">What would you like to change in the masked area?</label>
                <input type="text" id="mask-editor-prompt" class="mask-editor-prompt-input" maxlength="1000" data-i18n-placeholder="pdf.maskEditor.promptPlaceholder" placeholder="e.g., change the wall color to blue, replace the sofa with a modern chair...">
                <p class="mask-editor-prompt-hint" data-i18n="pdf.maskEditor.promptHint" style="margin:6px 0 0;font-size:12px;font-style:italic;opacity:0.7;line-height:1.4;">Be very specific about location and placement — for example: “put the sofa flush against the middle of the back wall.”</p>
              </div>
              <div class="mask-editor-ref-container">
                <label class="mask-editor-ref-label" for="mask-editor-ref-file" data-i18n="pdf.maskEditor.referenceLabel">Reference photo (optional)</label>
                <input type="file" id="mask-editor-ref-file" accept="image/jpeg,image/png,image/webp,image/jpg,image/heic,image/heif,.heic,.heif">
                <div class="mask-editor-ref-row">
                  <button type="button" id="mask-editor-ref-add" class="mask-editor-ref-add" data-i18n="pdf.maskEditor.referenceAdd">+ Add photo</button>
                  <div id="mask-editor-ref-preview" class="mask-editor-ref-preview hidden">
                    <img id="mask-editor-ref-img" alt="Reference for masked edit">
                    <button type="button" id="mask-editor-ref-remove" class="mask-editor-ref-remove" aria-label="Remove reference photo">&times;</button>
                  </div>
                </div>
                <span class="mask-editor-ref-hint" data-i18n="pdf.maskEditor.referenceHint">Optional: a photo of furniture or decor to place in the masked area</span>
              </div>
              <div class="mask-editor-actions">
                <button class="mask-editor-btn mask-editor-btn-secondary" id="mask-editor-cancel" data-i18n="pdf.maskEditor.cancel">Cancel</button>
                <button class="mask-editor-btn mask-editor-btn-secondary" id="mask-editor-clear"><span data-i18n="pdf.maskEditor.clearMask">Clear Mask</span><svg class="mask-editor-clear-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>
                <button class="mask-editor-btn mask-editor-btn-primary" id="mask-editor-submit">
                  <span data-i18n="pdf.maskEditor.applyEdit">Apply Edit</span>
                  <img src="media-webp/Mask.webp" alt="" aria-hidden="true">
                </button>
              </div>
            </div>
          </div>
        `;
        
        document.body.appendChild(modal);
        
        // Apply translations to mask editor
        updateMaskEditorTranslations();
        
        // Event listeners
        document.getElementById('mask-editor-close').addEventListener('click', closeMaskEditor);
        document.getElementById('mask-editor-cancel').addEventListener('click', closeMaskEditor);
        document.getElementById('mask-editor-clear').addEventListener('click', clearMask);
        document.getElementById('mask-editor-submit').addEventListener('click', submitMaskEdit);
        // Refine-phase buttons (created once, toggled by phase).
        const maskActionsRow = modal.querySelector('.mask-editor-actions');
        if (maskActionsRow && !document.getElementById('mask-editor-rerun')) {
          const rerunBtn = document.createElement('button');
          rerunBtn.type = 'button';
          rerunBtn.id = 'mask-editor-rerun';
          rerunBtn.className = 'mask-editor-btn mask-editor-btn-secondary hidden';
          const doneBtn = document.createElement('button');
          doneBtn.type = 'button';
          doneBtn.id = 'mask-editor-done';
          doneBtn.className = 'mask-editor-btn mask-editor-btn-primary hidden';
          maskActionsRow.appendChild(rerunBtn);
          maskActionsRow.appendChild(doneBtn);
          rerunBtn.addEventListener('click', rerunMaskAI);
          doneBtn.addEventListener('click', commitMaskEdit);
          // "?" help icon next to the title (shown only in the refine phase).
          const maskHeader = modal.querySelector('.mask-editor-header');
          if (maskHeader && !document.getElementById('mask-editor-help')) {
            const helpIcon = document.createElement('span');
            helpIcon.id = 'mask-editor-help';
            helpIcon.className = 'smask-help hidden';
            helpIcon.tabIndex = 0;
            helpIcon.setAttribute('role', 'button');
            helpIcon.textContent = '?';
            const helpTip = document.createElement('span');
            helpTip.className = 'smask-help__tip';
            helpIcon.appendChild(helpTip);
            maskHeader.insertBefore(helpIcon, maskHeader.querySelector('.mask-editor-close'));
          }
        }
        document.getElementById('mask-editor-brush-btn').addEventListener('click', () => setMaskTool('brush'));
        document.getElementById('mask-editor-erase-btn').addEventListener('click', () => setMaskTool('erase'));
        document.getElementById('mask-editor-brush-slider').addEventListener('input', (e) => {
          const slider = /** @type {HTMLInputElement} */ (e.target);
          brushSize = parseInt(slider.value, 10);
          document.getElementById('mask-editor-brush-size').textContent = slider.value + ' px';
        });

        reference.wire(
          document.getElementById('mask-editor-ref-file'),
          document.getElementById('mask-editor-ref-add'),
          document.getElementById('mask-editor-ref-remove')
        );

        // Add event listener for prompt input changes
        const promptInput = document.getElementById('mask-editor-prompt');
        if (promptInput) {
          promptInput.addEventListener('input', updateApplyButtonState);
          promptInput.addEventListener('keyup', updateApplyButtonState);
        }
        
        // Initially disable the button
        const submitBtn = /** @type {HTMLButtonElement} */ (document.getElementById('mask-editor-submit'));
        if (submitBtn) {
          submitBtn.disabled = true;
        }
        
        // Close on background click
        modal.addEventListener('click', (e) => {
          if (e.target === modal && maskPhase !== 'loading') {
            closeMaskEditor();
          }
        });

        // Close on Escape key
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && modal.classList.contains('active') && maskPhase !== 'loading') {
            closeMaskEditor();
          }
        });
      }
      
      let brushSize = 50;
      let maskTool = 'brush';     // 'brush' adds to the selection, 'erase' removes
      let maskPainted = false;    // any selection present? (hot path avoids scanning)
      let maskDrawingInited = false;

      function setMaskTool(t) {
        maskTool = t === 'erase' ? 'erase' : 'brush';
        const b = document.getElementById('mask-editor-brush-btn');
        const e = document.getElementById('mask-editor-erase-btn');
        if (b) { b.classList.toggle('is-active', maskTool === 'brush'); b.setAttribute('aria-pressed', maskTool === 'brush' ? 'true' : 'false'); }
        if (e) { e.classList.toggle('is-active', maskTool === 'erase'); e.setAttribute('aria-pressed', maskTool === 'erase' ? 'true' : 'false'); }
      }

      // ── Mask image-processing core (shared) ──────────────────────────────────
      // The canvas math lives once in the ES module /scripts/mask-core.js and is
      // shared with the main Stagify tool. These thin wrappers keep the call sites
      // below unchanged; the module loads eagerly and is awaited in
      // runMaskGenerate before its first use.
      let _maskCore = null;
      const _maskCoreReady = import('/scripts/mask-core.js').then((m) => (_maskCore = m, m));
      _maskCoreReady.catch((e) => console.error('[mask] failed to load mask-core.js', e));
      function maskBuildModelMask(drawSrc, w, h, grow) {
        return _maskCore.buildModelMask(drawSrc, w, h, grow);
      }
      function maskBuildBlendMask(drawSrc, w, h, coreGrow, featherPx) {
        return _maskCore.buildBlendMask(drawSrc, w, h, coreGrow, featherPx);
      }
      function maskCompositeEditCanvas(origCanvas, keepMask, editedImg, w, h) {
        return _maskCore.compositeMaskedEditCanvas(origCanvas, keepMask, editedImg, w, h);
      }
      function maskCompositeEdit(origCanvas, keepMask, editedImg, w, h) {
        return _maskCore.compositeMaskedEdit(origCanvas, keepMask, editedImg, w, h);
      }

      // ---- In-modal generate → refine flow (mirrors main Stagify) ----------
      // "Apply Edit" no longer closes the modal: it blurs the canvas while the AI
      // runs, then shows the result here so the user can repaint the outline.
      // Repainting only re-crops the already-generated image (instant, free).
      let maskPhase = 'draw';          // 'draw' | 'loading' | 'refine'
      let maskRefineState = null;      // { originCanvas, imageSrc, w, h, coreGrow, featherPx, editedImg }

      function maskSetControlsDisabled(dis) {
        ['mask-editor-cancel','mask-editor-clear','mask-editor-submit','mask-editor-rerun','mask-editor-done','mask-editor-brush-btn','mask-editor-erase-btn','mask-editor-brush-slider','mask-editor-prompt','mask-editor-ref-add','mask-editor-ref-remove']
          .forEach((id) => { const el = /** @type {HTMLButtonElement} */ (document.getElementById(id)); if (el) el.disabled = dis; });
      }
      function maskSetPhase(p) {
        maskPhase = p;
        const maskCanvas = document.getElementById('mask-editor-mask-canvas');
        const submitBtn = document.getElementById('mask-editor-submit');
        const clearBtn = document.getElementById('mask-editor-clear');
        const rerunBtn = document.getElementById('mask-editor-rerun');
        const doneBtn = document.getElementById('mask-editor-done');
        const title = document.querySelector('.mask-editor-title');
        const note = /** @type {HTMLElement} */ (document.querySelector('.mask-editor-note'));
        if (p === 'loading') {
          maskSetControlsDisabled(true);
          overlay.start();
          if (maskCanvas) { maskCanvas.style.pointerEvents = 'none'; maskCanvas.style.cursor = 'not-allowed'; }
          return;
        }
        overlay.stop();
        maskSetControlsDisabled(false);
        if (maskCanvas) { maskCanvas.style.pointerEvents = 'auto'; maskCanvas.style.cursor = 'crosshair'; }
        if (p === 'refine') {
          if (submitBtn) submitBtn.classList.add('hidden');
          if (clearBtn) clearBtn.classList.add('hidden');
          if (rerunBtn) { rerunBtn.classList.remove('hidden'); rerunBtn.textContent = lang('pdf.maskEditor.rerun', 'Regenerate'); }
          if (doneBtn) { doneBtn.classList.remove('hidden'); doneBtn.textContent = lang('pdf.maskEditor.done', 'Looks good'); }
          if (title) title.textContent = lang('pdf.maskEditor.refineTitle', 'Refine the edit');
          const help = document.getElementById('mask-editor-help');
          if (help) {
            help.classList.remove('hidden');
            help.setAttribute('aria-label', lang('pdf.maskEditor.refineHelpAria', 'What the refine step does'));
            const tip = help.querySelector('.smask-help__tip');
            if (tip) tip.textContent = lang('pdf.maskEditor.refineHelp', "This step just fine-tunes where the AI's change shows — it doesn't run the AI again. Brush to reveal more of the edit, erase to pull it back. It's a safety net so the edit only touches the area you picked and can't mess up the rest of your photo. The faded preview shown on top is only there so you can see the full edit while refining — it won't be in the final image.");
          }
          maskRecolor('#16a34a');
          if (note) { note.style.display = ''; note.textContent = lang('pdf.maskEditor.refineNote', "Brush to reveal more of the edit, erase to hide it — this only re-crops, it won't re-run the AI."); }
          updateApplyButtonState();
        } else {
          if (submitBtn) submitBtn.classList.remove('hidden');
          if (clearBtn) clearBtn.classList.remove('hidden');
          if (rerunBtn) rerunBtn.classList.add('hidden');
          if (doneBtn) doneBtn.classList.add('hidden');
          const help = document.getElementById('mask-editor-help');
          if (help) help.classList.add('hidden');
          if (title) title.textContent = lang('pdf.maskEditor.title', 'Edit with Mask');
          if (note) { note.style.display = 'none'; note.textContent = ''; }
        }
      }
      // Re-composite the already-generated AI output through the CURRENT strokes —
      // instant, free, no API call.
      function maskRenderRefinePreview() {
        if (!maskRefineState) return;
        const { originCanvas, w, h, coreGrow, featherPx, editedImg } = maskRefineState;
        const maskCanvas = document.getElementById('mask-editor-mask-canvas');
        const baseCanvas = /** @type {HTMLCanvasElement} */ (document.getElementById('mask-editor-canvas'));
        if (!maskCanvas || !baseCanvas) return;
        const keep = maskBuildBlendMask(maskCanvas, w, h, coreGrow, featherPx);
        const composed = maskCompositeEditCanvas(originCanvas, keep, editedImg, w, h);
        const bctx = baseCanvas.getContext('2d');
        bctx.clearRect(0, 0, w, h);
        bctx.drawImage(composed, 0, 0);
        // Ghost the FULL raw AI output on top at 55% so the user can see the entire
        // generated region — including parts outside the current brush — and judge
        // where to extend or trim the mask. Visual only: the committed result is
        // re-composited cleanly from maskRefineState (see commitMaskEdit).
        bctx.save();
        bctx.globalAlpha = 0.55;
        bctx.drawImage(editedImg, 0, 0, w, h);
        bctx.restore();
      }

      // Recolor every painted stroke to `color` (keeps alpha) — purely cosmetic,
      // used to switch the selection to the refine-phase color.
      function maskRecolor(color) {
        const maskCanvas = /** @type {HTMLCanvasElement} */ (document.getElementById('mask-editor-mask-canvas'));
        if (!maskCanvas || !maskCanvas.width || !maskCanvas.height) return;
        const ctx = maskCanvas.getContext('2d');
        ctx.save();
        ctx.globalCompositeOperation = 'source-in';
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
        ctx.restore();
      }

      // Accurate (expensive) scan — only on stroke end, never per-move.
      function maskScanHasContent() {
        const maskCanvas = /** @type {HTMLCanvasElement} */ (document.getElementById('mask-editor-mask-canvas'));
        if (!maskCanvas || !maskCanvas.width || !maskCanvas.height) return false;
        const d = maskCanvas.getContext('2d').getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
        for (let i = 3; i < d.length; i += 4) { if (d[i] > 10) return true; }
        return false;
      }

      function initMaskDrawing(maskCanvas) {
        if (maskDrawingInited) return; // attach listeners once
        maskDrawingInited = true;
        const ctx = maskCanvas.getContext('2d');
        let drawing = false;
        let lastX = null;
        let lastY = null;

        function isProcessing() {
          const canvasContainer = document.querySelector('.mask-editor-canvas-container');
          return canvasContainer && canvasContainer.classList.contains('processing');
        }
        function pointFrom(e) {
          // Derive the scale from the LIVE rendered size every time. The canvas's
          // on-screen size is set by CSS and can differ from the display size we
          // computed at load (e.g. a tall image gets width-clamped by the
          // container). Using a stale stored scale shifts drawing sideways —
          // reading getBoundingClientRect here keeps the brush under the cursor.
          const rect = maskCanvas.getBoundingClientRect();
          if (!rect.width || !rect.height) return { x: 0, y: 0 };
          return {
            x: (e.clientX - rect.left) * (maskCanvas.width / rect.width),
            y: (e.clientY - rect.top) * (maskCanvas.height / rect.height)
          };
        }
        function startDrawing(e) {
          if (isProcessing()) return;
          drawing = true;
          lastX = null;
          lastY = null;
          draw(e);
        }
        function stopDrawing() {
          if (!drawing) return;
          drawing = false;
          lastX = null;
          lastY = null;
          maskPainted = maskScanHasContent(); // recompute once (handles erasing it away)
          updateApplyButtonState();
          // In refine mode, re-crop the existing AI output through the new strokes —
          // instant and free, no API call.
          if (maskPhase === 'refine') maskRenderRefinePreview();
        }
        function draw(e) {
          if (!drawing || isProcessing()) return;
          const { x, y } = pointFrom(e);
          // One continuous, fully-opaque stroke; erase mode removes via
          // destination-out. Translucency comes from the canvas CSS opacity.
          ctx.globalCompositeOperation = maskTool === 'erase' ? 'destination-out' : 'source-over';
          // Refine phase uses a distinct color so it's clear you're adjusting the crop.
          const brushColor = maskPhase === 'refine' ? '#16a34a' : '#2563eb';
          ctx.strokeStyle = brushColor;
          ctx.fillStyle = brushColor;
          ctx.lineWidth = brushSize;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          if (lastX === null || lastY === null) {
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
          if (maskTool === 'brush' && !maskPainted) {
            maskPainted = true;
            updateApplyButtonState();
          }
        }

        maskCanvas.addEventListener('mousedown', startDrawing);
        maskCanvas.addEventListener('mousemove', draw);
        maskCanvas.addEventListener('mouseup', stopDrawing);
        maskCanvas.addEventListener('mouseleave', stopDrawing);
        maskCanvas.addEventListener('touchstart', (e) => {
          e.preventDefault();
          const t = e.touches[0];
          startDrawing({ clientX: t.clientX, clientY: t.clientY });
        });
        maskCanvas.addEventListener('touchmove', (e) => {
          e.preventDefault();
          const t = e.touches[0];
          draw({ clientX: t.clientX, clientY: t.clientY });
        });
        maskCanvas.addEventListener('touchend', (e) => { e.preventDefault(); stopDrawing(); });

        maskCanvas.style.pointerEvents = 'auto';
        maskCanvas.style.cursor = 'crosshair';
      }
      
      function clearMask() {
        const maskCanvas = /** @type {HTMLCanvasElement} */ (document.getElementById('mask-editor-mask-canvas'));
        const ctx = maskCanvas.getContext('2d');
        ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
        maskPainted = false;
        updateApplyButtonState();
      }
      
      function checkMaskHasContent() {
        const maskCanvas = /** @type {HTMLCanvasElement} */ (document.getElementById('mask-editor-mask-canvas'));
        if (!maskCanvas || maskCanvas.width === 0 || maskCanvas.height === 0) {
          return false;
        }
        const maskCtx = maskCanvas.getContext('2d');
        const imageData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
        return imageData.data.some((val, idx) => idx % 4 === 3 && val > 0); // Check alpha channel
      }
      
      function checkPromptHasContent() {
        const promptInput = /** @type {HTMLInputElement} */ (document.getElementById('mask-editor-prompt'));
        return promptInput && promptInput.value.trim().length > 0;
      }
      
      function updateApplyButtonState() {
        const submitBtn = /** @type {HTMLButtonElement} */ (document.getElementById('mask-editor-submit'));
        const rerunBtn = /** @type {HTMLButtonElement} */ (document.getElementById('mask-editor-rerun'));
        // Use the cheap flag (set while drawing, recomputed on stroke end) so this
        // never scans the whole canvas in the hot path.
        const ready = maskPainted && checkPromptHasContent();
        if (submitBtn) submitBtn.disabled = !ready;
        if (rerunBtn) rerunBtn.disabled = !ready;
      }
      
      function closeMaskEditor() {
        const modal = document.getElementById('mask-editor-modal');
        if (modal) {
          modal.classList.remove('active');
          viewport.unbind();
          overlay.stop();
          clearMask();
          reference.clear();
          maskRefineState = null;
          maskPhase = 'draw';
          const submitBtn = document.getElementById('mask-editor-submit');
          const clearBtn = document.getElementById('mask-editor-clear');
          const rerunBtn = document.getElementById('mask-editor-rerun');
          const doneBtn = document.getElementById('mask-editor-done');
          if (submitBtn) submitBtn.classList.remove('hidden');
          if (clearBtn) clearBtn.classList.remove('hidden');
          if (rerunBtn) rerunBtn.classList.add('hidden');
          if (doneBtn) doneBtn.classList.add('hidden');
          maskSetControlsDisabled(false);

          // Remove blur effect if it exists
          const canvasContainer = document.querySelector('.mask-editor-canvas-container');
          if (canvasContainer) {
            canvasContainer.classList.remove('processing');
          }
          // Restore the draw-phase title/note for next time.
          const title = document.querySelector('.mask-editor-title');
          const note = /** @type {HTMLElement} */ (document.querySelector('.mask-editor-note'));
          if (title) title.textContent = lang('pdf.maskEditor.title', 'Edit with Mask');
          if (note) { note.style.display = 'none'; note.textContent = ''; }
        }
      }
      
      // POST the current strokes + prompt (+ optional reference) to the model and
      // resolve to the raw edited Image. Throws on failure.
      async function runMaskGenerate(imageSrc, w, h, prompt, coreGrow) {
        await _maskCoreReady; // ensure the shared mask-core module is loaded before use
        const maskCanvas = document.getElementById('mask-editor-mask-canvas');
        const maskDataUrl = maskBuildModelMask(maskCanvas, w, h, coreGrow).toDataURL('image/png');
        const selectedModel = window.getSelectedModelApiName ? window.getSelectedModelApiName() : 'gpt-4o-mini';
        const maskAuthTok = window.StagifyAuth && window.StagifyAuth.getToken();
        const response = await fetch('/api/mask-edit', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(maskAuthTok ? { Authorization: 'Bearer ' + maskAuthTok } : {}),
          },
          body: JSON.stringify({
            image: imageSrc,
            mask: maskDataUrl,
            prompt: prompt,
            model: selectedModel,
            authToken: maskAuthTok || undefined,
            ...(reference.getDataUrl() ? { referenceImage: reference.getDataUrl() } : {}),
          })
        });
        const data = await response.json();
        if (!response.ok || !data.editedImage) {
          throw new Error(data.error || 'Failed to process masked edit');
        }
        return await new Promise((resolve, reject) => {
          const im = new Image();
          im.crossOrigin = 'anonymous';
          im.onload = () => resolve(im);
          im.onerror = () => reject(new Error('Failed to load edited image'));
          im.src = data.editedImage;
        });
      }

      // "Apply Edit" (draw phase): generate, then enter refine mode in-modal.
      async function submitMaskEdit() {
        if (maskPhase !== 'draw') return;
        const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('mask-editor-canvas'));
        const promptInput = /** @type {HTMLInputElement} */ (document.getElementById('mask-editor-prompt'));
        const prompt = promptInput.value.trim();
        if (!prompt) {
          showToast(lang('pdf.mask.needPrompt', 'Please describe what you want to change in the masked area.'), 'error');
          return;
        }
        if (!checkMaskHasContent()) {
          showToast(lang('pdf.mask.needMask', 'Please draw a mask over the area you want to edit.'), 'error');
          return;
        }
        const w = parseInt(canvas.dataset.originalWidth);
        const h = parseInt(canvas.dataset.originalHeight);
        const imageSrc = canvas.dataset.imageSrc;
        const maxDim = Math.max(w, h);
        // Secret brush expansion kept modest (~half what it used to be) now that the
        // refine step lets users extend the mask themselves.
        const coreGrow = Math.max(12, Math.round(maxDim * 0.02275));
        const featherPx = Math.max(20, Math.round(maxDim * 0.04));
        // Snapshot the pristine source before refine overwrites the base canvas.
        const originCanvas = document.createElement('canvas');
        originCanvas.width = w; originCanvas.height = h;
        originCanvas.getContext('2d').drawImage(canvas, 0, 0);
        maskSetPhase('loading');
        try {
          const editedImg = await runMaskGenerate(imageSrc, w, h, prompt, coreGrow);
          const modal = document.getElementById('mask-editor-modal');
          if (!modal || !modal.classList.contains('active')) return; // closed mid-flight
          maskRefineState = { originCanvas, imageSrc, w, h, coreGrow, featherPx, editedImg };
          maskSetPhase('refine');
          maskRenderRefinePreview();
        } catch (error) {
          console.error('Error submitting mask edit:', error);
          showToast(lang('pdf.mask.failed', 'Failed to process masked edit. Please try again.'), 'error');
          maskSetPhase('draw');
        }
      }

      // "Regenerate" (refine phase): run the AI again with the refined strokes.
      async function rerunMaskAI() {
        if (maskPhase !== 'refine' || !maskRefineState) return;
        const promptInput = /** @type {HTMLInputElement} */ (document.getElementById('mask-editor-prompt'));
        const prompt = promptInput.value.trim();
        if (!prompt || !checkMaskHasContent()) return;
        const { imageSrc, w, h, coreGrow } = maskRefineState;
        maskSetPhase('loading');
        try {
          const editedImg = await runMaskGenerate(imageSrc, w, h, prompt, coreGrow);
          const modal = document.getElementById('mask-editor-modal');
          if (!modal || !modal.classList.contains('active')) return;
          maskRefineState.editedImg = editedImg;
          maskSetPhase('refine');
          maskRenderRefinePreview();
        } catch (error) {
          console.error('Mask re-run failed:', error);
          showToast(lang('pdf.mask.failed', 'Failed to process masked edit. Please try again.'), 'error');
          maskSetPhase('refine');
          maskRenderRefinePreview();
        }
      }

      // "Looks good" (refine phase): commit the current composite as a new version.
      async function commitMaskEdit() {
        if (!maskRefineState) { closeMaskEditor(); return; }
        const { originCanvas, imageSrc, w, h, coreGrow, featherPx, editedImg } = maskRefineState;
        const maskCanvas = document.getElementById('mask-editor-mask-canvas');
        const keepMask = maskBuildBlendMask(maskCanvas, w, h, coreGrow, featherPx);
        const finalEdited = maskCompositeEdit(originCanvas, keepMask, editedImg, w, h);

        // Resolve which carousel/container this image belongs to.
        const maskedImageSrc = imageSrc;
        let originalImageSrc = maskedImageSrc;
        let originalContainer = null;
        let imageData = null;

        const carouselItem = document.querySelector(`.masked-image-carousel-item img[src="${maskedImageSrc}"]`);
        if (carouselItem) {
          const carousel = carouselItem.closest('.masked-image-carousel');
          if (carousel) {
            const firstItem = /** @type {HTMLImageElement} */ (carousel.querySelector('.masked-image-carousel-item:first-child img'));
            if (firstItem) {
              originalImageSrc = firstItem.src;
              originalContainer = carousel;
              imageData = maskedImageData.get(originalImageSrc);
            }
          }
        }

        if (!imageData) {
          const allContainers = document.querySelectorAll('.ai-image-container');
          for (const container of allContainers) {
            const img = /** @type {HTMLImageElement} */ (container.querySelector('.ai-generated-image'));
            if (img && img.src === maskedImageSrc) {
              originalImageSrc = maskedImageSrc;
              originalContainer = container;
              break;
            }
          }
        }

        if (!imageData) {
          imageData = maskedImageData.get(originalImageSrc);
          if (!imageData) {
            imageData = { container: originalContainer, originalSrc: originalImageSrc, maskedVersions: [] };
            maskedImageData.set(originalImageSrc, imageData);
          }
        }

        if (originalContainer && imageData.container !== originalContainer) {
          imageData.container = originalContainer;
        }

        imageData.maskedVersions.push(finalEdited);

        const carousel = createOrUpdateMaskedImageCarousel(imageData.originalSrc, imageData.maskedVersions, imageData.container);

        if (imageData.maskedVersions.length === 1 && imageData.container && imageData.container.parentElement && !imageData.container.classList.contains('masked-image-carousel')) {
          const parent = imageData.container.parentElement;
          parent.replaceChild(carousel, imageData.container);
          imageData.container = carousel;
        } else if (imageData.container && imageData.container.classList.contains('masked-image-carousel')) {
          imageData.container = carousel;
        } else {
          const lastMessage = document.querySelector('.message.assistant:last-child .message-content');
          if (lastMessage) {
            const editedImageDiv = document.createElement('div');
            editedImageDiv.style.cssText = 'margin-top: 12px; text-align: left;';
            editedImageDiv.appendChild(carousel);
            lastMessage.appendChild(editedImageDiv);
          } else {
            addMessage('assistant', '');
            const newLastMessage = document.querySelector('.message.assistant:last-child .message-content');
            if (newLastMessage) {
              const editedImageDiv = document.createElement('div');
              editedImageDiv.style.cssText = 'margin-top: 12px; text-align: left;';
              editedImageDiv.appendChild(carousel);
              newLastMessage.appendChild(editedImageDiv);
            }
          }
          imageData.container = carousel;
        }

        // Update conversation history (just the image, no text).
        const sourceImg = collectImagesFromConversationHistory().find((img) => img.url === maskedImageSrc);
        const rootBaseName = sourceImg ? getRootBaseNameForImage(sourceImg) : 'Upload';
        const priorMaskCount = collectImagesFromConversationHistory()
          .filter((img) => img.isMasked && img.rootBaseName === rootBaseName).length;
        const maskNumber = priorMaskCount + 1;

        pushHistoryEntry({
          role: 'assistant',
          content: [
            {
              type: 'image_url',
              image_url: { url: finalEdited },
              isMasked: true,
              rootBaseName,
              maskNumber,
            },
          ],
        });
        syncImageThumbnailStrip({ preferNewest: true });

        closeMaskEditor();
      }

  return { openMaskEditor };
}
