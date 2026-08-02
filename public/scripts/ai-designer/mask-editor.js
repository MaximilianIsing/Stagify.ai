// Mask editor island for the AI Designer chat.
//
// The brush-mask "edit with AI" subsystem. A factory that closes over its own
// state and receives what it needs from the entry via deps (so the entry sheds
// ~1000 lines of mask glue).
//
// What lives HERE is what differs from the main tool's stage mask editor:
// building its own modal DOM at runtime, the draw/loading/refine phase machine,
// and committing back into the image carousel + conversation history. The brush,
// viewport pinning, processing overlay, reference photo, sizing, refine maths,
// the /api/mask-edit request and the phase copy are all shared — see
// scripts/mask/.
//
// Window globals used directly: visualViewport / matchMedia (via the shared
// viewport slice), LanguageSystem, and getSelectedModelApiName. StagifyHeic and
// StagifyAuth are reached by scripts/mask/{reference,generate}.js, not here.
import { getRootBaseNameForImage } from './image-history.js';
import { updateMaskEditorTranslations } from './mask-editor-i18n.js';
import { createMaskFit } from '../mask/fit.js';
// Viewport pinning, the processing overlay and the reference photo are shared
// with the main tool's stage mask editor (scripts/mask/). They used to live here
// as ai-designer-only slices while stage-mask-editor.js kept its own inline copy
// of each.
import { createMaskViewport } from '../mask/viewport.js';
import { createMaskOverlay } from '../mask/overlay.js';
import { createMaskReference } from '../mask/reference.js';
import { createMaskBrush } from '../mask/brush.js';
import { BRUSH_STEP_MIN, BRUSH_STEP_MAX, BRUSH_STEP_DEFAULT } from '../mask/brush-scale.js';
import { maskGrowths, snapshotCanvas, renderRefinePreview } from '../mask/refine.js';
import { requestMaskEdit } from '../mask/generate.js';
import { maskCopy } from '../mask/copy.js';
import { buildBlendMask, compositeMaskedEdit } from '../mask-core.js';

/**
 * @typedef {import('./types.js').AdImage} AdImage
 * @typedef {import('./types.js').AdHistoryEntry} AdHistoryEntry
 */
/**
 * @param {{
 *   lang: (key: string, fallback?: string) => string,
 *   showToast: (message: string, type?: string) => void,
 *   createOrUpdateMaskedImageCarousel: (originalSrc: string, maskedVersions: string[], originalContainer: HTMLElement) => HTMLElement,
 *   addMessage: (role: string, content: string, files?: File[] | null) => void,
 *   syncImageThumbnailStrip: (options?: { preferNewest?: boolean }) => void,
 *   collectImagesFromConversationHistory: () => AdImage[],
 *   pushHistoryEntry: (entry: AdHistoryEntry) => void,
 * }} deps - Localized copy and the toast channel, plus the glue for committing
 *   a finished edit back into the chat: the carousel that shows mask versions,
 *   a chat bubble, the thumbnail strip, and an append onto the entry's live
 *   conversation history.
 * @returns {{ openMaskEditor: (imageSrc: string, imageType?: string) => void }}
 */
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
  // The dialog is built lazily on first open, so the shared slices are handed
  // thunks rather than elements.
  const viewport = createMaskViewport({ getModal: () => document.getElementById('mask-editor-modal') });
  // 20px modal padding, content capped at 90vw/90vh — see ai-designer.css.
  const fit = createMaskFit({
    getModal: () => document.getElementById('mask-editor-modal'),
    contentSelector: '.mask-editor-content',
    containerSelector: '.mask-editor-canvas-container',
    canvasSelector: 'canvas.mask-editor-canvas',
    modalPadding: 20,
    widthShare: 0.9,
    heightShare: 0.9,
  });
  const overlay = createMaskOverlay({
    lang,
    getContainer: () => /** @type {HTMLElement} */ (document.querySelector('.mask-editor-canvas-container')),
  });
  // The reference thumbnail replaces the "+ Add photo" button, so showing or
  // hiding it changes the chrome height the image was sized against.
  const reference = createMaskReference({
    lang,
    showError: (message) => showToast(message, 'error'),
    onChange: () => fit.fit(),
  });

      // Mask editor functionality
      // Track original image containers and their masked versions
      const maskedImageData = new Map(); // Map<originalImageSrc, {container, originalSrc, maskedVersions: []}>
      
      // Where focus was when the dialog opened, so closing can put it back. The
      // opener is a per-image button rather than one fixed control (unlike the
      // Masking Studio's help dialog), so it has to be captured, not looked up.
      let maskEditorOpener = null;

      function openMaskEditor(imageSrc, imageType) {
        maskEditorOpener = /** @type {HTMLElement|null} */ (document.activeElement);
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
          // Display size is measured against the live dialog once it is visible
          // (see fit.fit() below) — never guessed from a fraction of the
          // viewport, which overflowed and clipped the image on short screens.
          // Set canvas actual size (for drawing)
          canvas.width = img.width;
          canvas.height = img.height;

          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, img.width, img.height);
          
          // Initialize mask canvas (transparent overlay)
          const maskCanvas = /** @type {HTMLCanvasElement} */ (document.getElementById('mask-editor-mask-canvas'));
          maskCanvas.width = img.width;
          maskCanvas.height = img.height;
          const maskCtx = maskCanvas.getContext('2d');
          maskCtx.fillStyle = 'rgba(37, 99, 235, 0.4)'; // Blue overlay for mask (Stagify blue)
          
          // Store image source and scale for later use
          canvas.dataset.imageSrc = imageSrc;
          canvas.dataset.imageType = imageType;
          canvas.dataset.originalWidth = String(img.width);
          canvas.dataset.originalHeight = String(img.height);
          
          fit.setImage(img.width, img.height);
          existingModal.classList.add('active');
          // Move focus into the dialog, same as the Masking Studio's help dialog:
          // without this, focus stays on the button behind the overlay, so a screen
          // reader never announces the dialog and Escape/Tab act on the page under it.
          // (The Tab trap in ai-designer-app.js only pulls focus back once Tab is
          // pressed — it cannot start it here.)
          const closeBtn = /** @type {HTMLElement|null} */ (document.getElementById('mask-editor-close'));
          if (closeBtn) closeBtn.focus();
          viewport.bind();
          viewport.sync();
          brush.clear();
          setMaskTool('brush');
          brush.attach();
          
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
          // Last, once every row that shares the dialog's height budget is in
          // its final state (translated, reference cleared, draw-phase buttons).
          fit.fit();
          fit.bind();
        };
        img.src = imageSrc;
      }
      
      function createMaskEditorModal() {
        const modal = document.createElement('div');
        modal.id = 'mask-editor-modal';
        modal.className = 'mask-editor-modal';
        // Announce as a modal dialog named by its heading. This element is built in
        // JS rather than markup, which is exactly how it missed the roles every
        // hand-written dialog in the app carries. `.mask-editor-modal` is
        // `display:none` until `.active`, so it leaves the a11y tree on its own —
        // no aria-hidden toggling needed here.
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'mask-editor-title');

        modal.innerHTML = `
          <div class="mask-editor-content">
            <div class="mask-editor-header">
              <h2 class="mask-editor-title" id="mask-editor-title" data-i18n="pdf.maskEditor.title">Edit with Mask</h2>
              <button type="button" class="mask-editor-close" id="mask-editor-close" aria-label="Close"><span aria-hidden="true">&times;</span></button>
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
              <!-- A relative scale, not a pixel count — see scripts/mask/brush-scale.js.
                   The bounds here are a pre-hydration placeholder; the module assigns
                   the real ones when the slider is wired. -->
              <div class="mask-editor-brush-controls">
                <label class="mask-editor-brush-label" data-i18n="pdf.maskEditor.brushSize">Brush Size:</label>
                <span class="mask-editor-brush-end" data-i18n="pdf.maskEditor.brushSmall">Small</span>
                <input type="range" id="mask-editor-brush-slider" class="mask-editor-brush-slider" min="1" max="16" value="6">
                <span class="mask-editor-brush-end" data-i18n="pdf.maskEditor.brushLarge">Large</span>
              </div>
              <div class="mask-editor-prompt-container">
                <label class="mask-editor-prompt-label" data-i18n="pdf.maskEditor.promptLabel">What would you like to change in the masked area?</label>
                <input type="text" id="mask-editor-prompt" class="mask-editor-prompt-input" maxlength="1000" data-i18n-placeholder="pdf.maskEditor.promptPlaceholder" placeholder="e.g., change the wall color to blue, replace the sofa with a modern chair...">
                <p class="mask-editor-prompt-hint" data-i18n="pdf.maskEditor.promptHint">Be very specific about location and placement — for example: “put the sofa flush against the middle of the back wall.”</p>
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
        // The scale, not the markup, owns these bounds — so the slider cannot drift
        // out of step with brush-scale.js.
        const brushSlider = /** @type {HTMLInputElement} */ (document.getElementById('mask-editor-brush-slider'));
        brushSlider.min = String(BRUSH_STEP_MIN);
        brushSlider.max = String(BRUSH_STEP_MAX);
        brushSlider.value = String(BRUSH_STEP_DEFAULT);
        brushSlider.addEventListener('input', () => {
          brush.setSizeStep(parseInt(brushSlider.value, 10));
        });

        const refAddBtn = document.getElementById('mask-editor-ref-add');
        const refPreview = document.getElementById('mask-editor-ref-preview');
        reference.wire({
          fileInput: document.getElementById('mask-editor-ref-file'),
          addBtn: refAddBtn,
          removeBtn: document.getElementById('mask-editor-ref-remove'),
          preview: refPreview,
          img: document.getElementById('mask-editor-ref-img'),
          // Drop a photo on "+ Add photo", or on the thumbnail to replace it —
          // the same zones the stage editor has always offered. This editor could
          // not accept a dragged file until the two shared one implementation.
          dropZones: [refAddBtn, refPreview],
        });

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
      
      // Shared brush. The dialog is built on first open, so the canvas is resolved
      // lazily and attach() runs from openMaskEditor rather than here.
      const brush = createMaskBrush({
        getCanvas: () => /** @type {HTMLCanvasElement} */ (document.getElementById('mask-editor-mask-canvas')),
        getPhase: () => maskPhase,
        isBusy: () => {
          const container = document.querySelector('.mask-editor-canvas-container');
          return !!container && container.classList.contains('processing');
        },
        onReadyChange: () => updateApplyButtonState(),
        onRefineStroke: () => renderPreview(),
        getCursorHost: () => document.querySelector('.mask-editor-canvas-container'),
      });

      // The brush owns the tool; this only mirrors it onto the two buttons.
      function setMaskTool(t) {
        brush.setTool(t);
        const isBrush = brush.getTool() === 'brush';
        const b = document.getElementById('mask-editor-brush-btn');
        const e = document.getElementById('mask-editor-erase-btn');
        if (b) { b.classList.toggle('is-active', isBrush); b.setAttribute('aria-pressed', isBrush ? 'true' : 'false'); }
        if (e) { e.classList.toggle('is-active', !isBrush); e.setAttribute('aria-pressed', !isBrush ? 'true' : 'false'); }
      }

      // The canvas maths lives once in /scripts/mask-core.js. It used to be
      // reached here through a dynamic import plus four forwarding wrappers, which
      // runMaskGenerate then had to await before first use; the shared refine and
      // generate modules import it statically, so the wrappers and the await are
      // gone and the module graph resolves before any of this runs.

      // ---- In-modal generate → refine flow (mirrors main Stagify) ----------
      // "Apply Edit" no longer closes the modal: it blurs the canvas while the AI
      // runs, then shows the result here so the user can repaint the outline.
      // Repainting only re-crops the already-generated image (instant, free).
      let maskPhase = 'draw';          // 'draw' | 'loading' | 'refine'
      // Shape is shared with the stage editor and read by mask/refine.js — the
      // snapshot key must stay `origCanvas` (it was `originCanvas` here, which
      // silently handed the shared renderer an undefined image).
      let maskRefineState = null;      // { origCanvas, imageSrc, w, h, coreGrow, featherPx, editedImg }

      function maskSetControlsDisabled(dis) {
        ['mask-editor-cancel','mask-editor-clear','mask-editor-submit','mask-editor-rerun','mask-editor-done','mask-editor-brush-btn','mask-editor-erase-btn','mask-editor-brush-slider','mask-editor-prompt','mask-editor-ref-add','mask-editor-ref-remove']
          .forEach((id) => { const el = /** @type {HTMLButtonElement} */ (document.getElementById(id)); if (el) el.disabled = dis; });
      }
      function maskSetPhase(p) {
        maskPhase = p;
        const copy = maskCopy(lang);
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
          if (rerunBtn) { rerunBtn.classList.remove('hidden'); rerunBtn.textContent = copy.rerun; }
          if (doneBtn) { doneBtn.classList.remove('hidden'); doneBtn.textContent = copy.done; }
          if (title) title.textContent = copy.refineTitle;
          const help = document.getElementById('mask-editor-help');
          if (help) {
            help.classList.remove('hidden');
            help.setAttribute('aria-label', copy.refineHelpAria);
            const tip = help.querySelector('.smask-help__tip');
            if (tip) tip.textContent = copy.refineHelp;
          }
          brush.recolor(brush.REFINE_COLOR);
          if (note) { note.style.display = ''; note.textContent = copy.refineNote; }
          updateApplyButtonState();
        } else {
          if (submitBtn) submitBtn.classList.remove('hidden');
          if (clearBtn) clearBtn.classList.remove('hidden');
          if (rerunBtn) rerunBtn.classList.add('hidden');
          if (doneBtn) doneBtn.classList.add('hidden');
          const help = document.getElementById('mask-editor-help');
          if (help) help.classList.add('hidden');
          if (title) title.textContent = copy.title;
          if (note) { note.style.display = 'none'; note.textContent = ''; }
          // maskSetControlsDisabled(false) above re-enables Apply Edit
          // unconditionally — re-apply the readiness gate, or a freshly-opened
          // editor shows it as clickable with no strokes and no prompt.
          updateApplyButtonState();
        }
        // The refine phase adds a note row and swaps the buttons — re-measure so
        // the image gives back (or takes) the height that costs.
        fit.fit();
      }
      const renderPreview = () => renderRefinePreview({
        baseCanvas: /** @type {HTMLCanvasElement} */ (document.getElementById('mask-editor-canvas')),
        drawCanvas: /** @type {HTMLCanvasElement} */ (document.getElementById('mask-editor-mask-canvas')),
        state: maskRefineState,
      });

      const clearMask = () => brush.clear();

      // Was an independent full-canvas scan with a slightly different alpha
      // threshold (>0) than the one the stroke-end check used (>10); both now go
      // through the brush, so the submit gate and the button state can no longer
      // disagree about whether anything is painted.
      const checkMaskHasContent = () => brush.rescan();
      
      function checkPromptHasContent() {
        const promptInput = /** @type {HTMLInputElement} */ (document.getElementById('mask-editor-prompt'));
        return promptInput && promptInput.value.trim().length > 0;
      }
      
      function updateApplyButtonState() {
        const submitBtn = /** @type {HTMLButtonElement} */ (document.getElementById('mask-editor-submit'));
        const rerunBtn = /** @type {HTMLButtonElement} */ (document.getElementById('mask-editor-rerun'));
        // Use the cheap flag (set while drawing, recomputed on stroke end) so this
        // never scans the whole canvas in the hot path.
        const ready = brush.hasContent() && checkPromptHasContent();
        if (submitBtn) submitBtn.disabled = !ready;
        if (rerunBtn) rerunBtn.disabled = !ready;
      }
      
      function closeMaskEditor() {
        const modal = document.getElementById('mask-editor-modal');
        if (modal) {
          modal.classList.remove('active');
          viewport.unbind();
          fit.unbind();
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
          if (title) title.textContent = maskCopy(lang).title;
          if (note) { note.style.display = 'none'; note.textContent = ''; }
        }
        // Put focus back where it came from. Guarded on isConnected because
        // committing an edit replaces the image container the opener lived in —
        // focusing a detached node silently drops focus to <body>.
        const opener = maskEditorOpener;
        maskEditorOpener = null;
        if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
      }
      
      // POST the current strokes + prompt (+ optional reference) to the model.
      // Model choice is this page's own control; everything else is shared.
      function runMaskGenerate(imageSrc, w, h, prompt, coreGrow) {
        return requestMaskEdit({
          image: imageSrc,
          drawCanvas: /** @type {HTMLCanvasElement} */ (document.getElementById('mask-editor-mask-canvas')),
          w, h, prompt, coreGrow,
          model: window.getSelectedModelApiName ? window.getSelectedModelApiName() : 'gpt-4o-mini',
          referenceImage: reference.getDataUrl(),
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
        const { coreGrow, featherPx } = maskGrowths(w, h);
        // Snapshot the pristine source before refine overwrites the base canvas.
        const origCanvas = snapshotCanvas(canvas, w, h);
        maskSetPhase('loading');
        try {
          const editedImg = await runMaskGenerate(imageSrc, w, h, prompt, coreGrow);
          const modal = document.getElementById('mask-editor-modal');
          if (!modal || !modal.classList.contains('active')) return; // closed mid-flight
          maskRefineState = { origCanvas, imageSrc, w, h, coreGrow, featherPx, editedImg };
          maskSetPhase('refine');
          renderPreview();
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
          renderPreview();
        } catch (error) {
          console.error('Mask re-run failed:', error);
          showToast(lang('pdf.mask.failed', 'Failed to process masked edit. Please try again.'), 'error');
          maskSetPhase('refine');
          renderPreview();
        }
      }

      // "Looks good" (refine phase): commit the current composite as a new version.
      async function commitMaskEdit() {
        if (!maskRefineState) { closeMaskEditor(); return; }
        const { origCanvas, imageSrc, w, h, coreGrow, featherPx, editedImg } = maskRefineState;
        const maskCanvas = document.getElementById('mask-editor-mask-canvas');
        const keepMask = buildBlendMask(maskCanvas, w, h, coreGrow, featherPx);
        const finalEdited = compositeMaskedEdit(origCanvas, keepMask, editedImg, w, h);

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
