// Stage mask editor island for the main Stagify tool (scripts/app.js).
//
// The brush-mask "edit with AI" subsystem for the staging tool's Before/After
// canvases: its own modal, canvas drawing, draw/loading/refine phase machine,
// reference photo, /api/mask-edit call. Lifted verbatim from the former
// setupStageMaskEditor IIFE into a factory that owns its state and receives the
// glue it needs from the entry via deps. Self-wires its own trigger button.
//
// deps: { maskEditBtn, canvas1, stagePreview, processBtn, activeViewIsAfter,
//         getBeforeVersions, getAfterVersions, maxVersions, onMaskCommit }
// (onMaskCommit(finalUrl, isBefore) applies the committed version to the entry's
// shared before/after version state + display.)
import { buildBlendMask, compositeMaskedEdit } from '../mask-core.js';
import { showErrorToast } from '../toast.js';
// Everything under scripts/mask/ is shared with the AI Designer's mask editor.
// All of it used to exist twice: some inline here and extracted there, the rest
// duplicated on both sides.
import { createMaskViewport } from '../mask/viewport.js';
import { createMaskOverlay } from '../mask/overlay.js';
import { createMaskReference } from '../mask/reference.js';
import { createMaskBrush } from '../mask/brush.js';
import { createMaskFit } from '../mask/fit.js';
import { maskGrowths, snapshotCanvas, renderRefinePreview } from '../mask/refine.js';
import { requestMaskEdit } from '../mask/generate.js';

export function createStageMaskEditor(deps) {
  const {
    maskEditBtn,
    canvas1,
    stagePreview,
    processBtn,
    activeViewIsAfter,
    getBeforeVersions,
    getAfterVersions,
    maxVersions,
    onMaskCommit,
    updateMaskButtonVisibility,
  } = deps;
  const $ = (sel) => document.querySelector(sel);

      const maskModal = $('#stage-mask-modal');
      if (!maskEditBtn || !maskModal) return;

      const baseCanvas = $('#stage-mask-base-canvas');
      const drawCanvas = $('#stage-mask-draw-canvas');
      const brushSlider = $('#stage-mask-brush-slider');
      const brushSizeLabel = $('#stage-mask-brush-size');
      const promptInput = $('#stage-mask-prompt');
      const cancelBtn = $('#stage-mask-cancel');
      const closeBtn = $('#stage-mask-close');
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

      // Shared overlay, with the two things that differ from the AI Designer's
      // use of it: this editor marks the container `smask-busy` (it toggles
      // `processing` separately, from setPhase), and it needs one extra rule to
      // blur its own canvas class. `ensure()` runs now rather than on first use
      // so the stylesheet lands at construction time, as it always has.
      const overlay = createMaskOverlay({
        lang: tx,
        getContainer: () => /** @type {HTMLElement} */ (canvasContainer),
        busyClass: 'smask-busy',
        extraCss: '.stage-mask-canvas-container.smask-busy .stage-mask-canvas{filter:blur(6px) brightness(.98);}',
        extraCssId: 'stage-smask-styles',
      });
      overlay.ensure();
      const startOverlay = () => overlay.start();
      const stopOverlay = () => overlay.stop();

      // Shared reference-photo slice. dropZones keeps this editor's drag-and-drop
      // onto the "+ Add photo" button (and, once one is set, its thumbnail).
      const reference = createMaskReference({ lang: tx, showError: showErrorToast });
      reference.wire({
        fileInput: refFileInput,
        addBtn: refAddBtn,
        removeBtn: refRemoveBtn,
        preview: refPreview,
        img: refImg,
        dropZones: [refAddBtn, refPreview],
      });

      const viewport = createMaskViewport({ getModal: () => maskModal });

      // Sizes the canvases to the room the dialog actually has. This editor used
      // to hand the image a flat 60% of the viewport height (50% on mobile) and
      // let the rest overflow, which pushed the prompt and the Apply button below
      // the fold on a short window. Caps come from .stage-mask-modal /
      // .stage-mask-content in styles.css: 16px padding, max-width 920px,
      // max-height calc(100vh - 32px) — hence heightShare 1 rather than 0.9.
      const fit = createMaskFit({
        getModal: () => maskModal,
        contentSelector: '.stage-mask-content',
        containerSelector: '.stage-mask-canvas-container',
        canvasSelector: 'canvas.stage-mask-canvas',
        modalPadding: 16,
        widthShare: 1,
        heightShare: 1,
        maxContentWidth: 920,
      });

      // Shared brush. It owns the stroke state (tool, size, whether anything is
      // painted); this file keeps only the button chrome that reflects it.
      const brush = createMaskBrush({
        getCanvas: () => drawCanvas,
        getPhase: () => phase,
        isBusy: isProcessing,
        onReadyChange: () => updateSubmitState(),
        onRefineStroke: () => renderPreview(),
      });
      brush.attach();

      function setControlsDisabled(dis) {
        [cancelBtn, clearBtn, submitBtn, rerunBtn, doneBtn, brushToolBtn, eraseToolBtn, brushSlider, promptInput, refAddBtn, refRemoveBtn]
          .forEach((el) => { if (el) el.disabled = dis; });
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
          brush.recolor(brush.REFINE_COLOR);
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
          // setControlsDisabled(false) above re-enables Submit unconditionally —
          // re-apply the readiness gate, or a freshly-opened editor shows "Apply
          // Edit" as clickable with no strokes and no prompt.
          updateSubmitState();
        }
        // The refine phase adds a note row and swaps the buttons — re-measure so
        // the image gives back (or takes) the height that costs.
        fit.fit();
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
        const list = kind === 'before' ? getBeforeVersions() : getAfterVersions();
        if (list.length < maxVersions) return false;
        showErrorToast(tx('modal.staging.maskLimitReached',
          "You've reached the limit of " + maxVersions + ' versions for this image.'));
        return true;
      }

      // Shared: load a source image into the base/draw canvases and open the modal.
      function showInEditor(src) {
        const img = new Image();
        img.onload = () => {
          // Display size is measured against the live dialog once it is visible
          // (fit.fit() below) — never guessed from a fraction of the viewport,
          // which pushed the prompt and Apply button off-screen on short windows.
          baseCanvas.width = img.width;
          baseCanvas.height = img.height;
          baseCanvas.getContext('2d').drawImage(img, 0, 0, img.width, img.height);

          drawCanvas.width = img.width;
          drawCanvas.height = img.height;
          brush.clear();
          setTool('brush');

          if (canvasContainer) canvasContainer.classList.remove('processing');
          drawCanvas.style.pointerEvents = 'auto';
          drawCanvas.style.cursor = 'crosshair';
          updateSubmitState();
          refineState = null;
          fit.setImage(img.width, img.height);
          setPhase('draw');
          maskModal.classList.add('active');
          maskModal.setAttribute('aria-hidden', 'false');
          viewport.bind();
          viewport.sync();
          // Last, once every row sharing the dialog's height budget is in its
          // final state — fit() measures nothing until the modal is active.
          fit.fit();
          fit.bind();
        };
        img.src = src;
      }

      // After-mode: refine the currently-shown staged result; append a new version.
      function openEditor() {
        if (!canvas1.width) return;
        if (atVersionLimit('after')) return;
        editorMode = 'after';
        applyEditorCopy();
        reference.clear();
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
        reference.clear();
        if (promptInput) promptInput.value = '';
        showInEditor(src);
      }

      function closeEditor() {
        maskModal.classList.remove('active');
        maskModal.setAttribute('aria-hidden', 'true');
        viewport.unbind();
        fit.unbind();
        stopOverlay();
        clearDraw();
        reference.clear();
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

      const clearDraw = () => brush.clear();

      function updateSubmitState() {
        const hasPrompt = promptInput && promptInput.value.trim().length > 0;
        const ready = brush.hasContent() && hasPrompt;
        if (submitBtn) submitBtn.disabled = !ready;
        if (rerunBtn) rerunBtn.disabled = !ready;
      }

      // The brush owns the tool; this only mirrors it onto the two buttons.
      function setTool(t) {
        brush.setTool(t);
        const isBrush = brush.getTool() === 'brush';
        if (brushToolBtn) {
          brushToolBtn.classList.toggle('is-active', isBrush);
          brushToolBtn.setAttribute('aria-pressed', isBrush ? 'true' : 'false');
        }
        if (eraseToolBtn) {
          eraseToolBtn.classList.toggle('is-active', !isBrush);
          eraseToolBtn.setAttribute('aria-pressed', !isBrush ? 'true' : 'false');
        }
      }

      if (brushSlider) brushSlider.addEventListener('input', (e) => {
        brush.setSize(parseInt(e.target.value, 10));
        if (brushSizeLabel) brushSizeLabel.textContent = brush.getSize() + ' px';
      });
      if (promptInput) promptInput.addEventListener('input', updateSubmitState);
      if (clearBtn) clearBtn.addEventListener('click', clearDraw);
      if (cancelBtn) cancelBtn.addEventListener('click', closeEditor);
      // The header X. Not part of setControlsDisabled(), so it stays live during a
      // run — guard it the way the backdrop and Escape are, and never leave it
      // unwired: it is the control most people reach for first.
      if (closeBtn) closeBtn.addEventListener('click', () => { if (phase !== 'loading') closeEditor(); });
      if (brushToolBtn) brushToolBtn.addEventListener('click', () => setTool('brush'));
      if (eraseToolBtn) eraseToolBtn.addEventListener('click', () => setTool('erase'));
      // Same paint-brush FAB on both views: edits the staged result on After,
      // or the original photo on Before.
      if (maskEditBtn) maskEditBtn.addEventListener('click', () => {
        // Staging in flight: the FAB is blurred and pointer-inert in CSS (see
        // `#stage-preview.processing ~ .stage-mask-fab`), but a keyboard Enter
        // still lands here — don't open the editor on a half-generated image.
        if (stagePreview && stagePreview.classList.contains('processing')) return;
        if (activeViewIsAfter()) openEditor();
        else openBeforeEditor();
      });
      maskModal.addEventListener('click', (e) => { if (e.target === maskModal && phase !== 'loading') closeEditor(); });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && maskModal.classList.contains('active') && phase !== 'loading') closeEditor();
      });

      const renderPreview = () => renderRefinePreview({ baseCanvas, drawCanvas, state: refineState });

      // POST the current strokes + prompt (+ optional reference) to the model.
      // Model choice is this page's own control; everything else is shared.
      function runGenerate(origCanvas, w, h, prompt, coreGrow) {
        const modelSel = /** @type {HTMLSelectElement} */ (document.getElementById('stagify-model-select'));
        return requestMaskEdit({
          image: origCanvas.toDataURL('image/png'),
          drawCanvas, w, h, prompt, coreGrow,
          model: (modelSel && modelSel.value) || 'gpt-4o-mini',
          referenceImage: reference.getDataUrl(),
        });
      }

      // "Apply Edit" (draw phase): generate, then enter refine mode in-modal.
      async function submitEdit() {
        if (phase !== 'draw') return;
        const prompt = promptInput ? promptInput.value.trim() : '';
        if (!prompt || !brush.hasContent()) return;
        // Snapshot the pristine source while it's still on the base canvas; in
        // refine mode the base canvas gets overwritten with the composite.
        const w = baseCanvas.width;
        const h = baseCanvas.height;
        const origCanvas = snapshotCanvas(baseCanvas, w, h);
        const { coreGrow, featherPx } = maskGrowths(w, h);
        const isBefore = editorMode === 'before';
        if (processBtn) processBtn.disabled = true;
        setPhase('loading');
        try {
          const editedImg = await runGenerate(origCanvas, w, h, prompt, coreGrow);
          if (!maskModal.classList.contains('active')) return; // closed mid-flight
          refineState = { origCanvas, w, h, coreGrow, featherPx, editedImg, isBefore };
          setPhase('refine');
          renderPreview();
        } catch (err) {
          console.error('Mask edit failed:', err);
          setPhase('draw');
          if (processBtn) processBtn.disabled = false;
          showErrorToast(err.message || 'Mask edit failed. Please try again.');
        }
      }

      // "Regenerate" (refine phase): run the AI again with the refined strokes.
      async function rerunAI() {
        if (phase !== 'refine' || !refineState) return;
        const prompt = promptInput ? promptInput.value.trim() : '';
        if (!prompt || !brush.hasContent()) return;
        const { origCanvas, w, h, coreGrow } = refineState;
        if (processBtn) processBtn.disabled = true;
        setPhase('loading');
        try {
          const editedImg = await runGenerate(origCanvas, w, h, prompt, coreGrow);
          if (!maskModal.classList.contains('active')) return;
          refineState.editedImg = editedImg;
          setPhase('refine');
          renderPreview();
        } catch (err) {
          console.error('Mask re-run failed:', err);
          setPhase('refine'); // keep the previous result intact
          renderPreview();
          showErrorToast(err.message || 'Mask edit failed. Please try again.');
        }
      }

      // "Looks good" (refine phase): commit the current composite as a new version.
      async function commitRefine() {
        if (!refineState) { closeEditor(); return; }
        const { origCanvas, w, h, coreGrow, featherPx, editedImg, isBefore } = refineState;
        const keep = buildBlendMask(drawCanvas, w, h, coreGrow, featherPx);
        const finalUrl = compositeMaskedEdit(origCanvas, keep, editedImg, w, h);
        closeEditor();
        // Commit the new version into the entry's shared before/after state +
        // display. That state lives in app.js and is read/written in many other
        // places, so the entry owns the mutation via this injected callback.
        await onMaskCommit(finalUrl, isBefore);
      }

      if (submitBtn) submitBtn.addEventListener('click', submitEdit);
      rerunBtn.addEventListener('click', rerunAI);
      doneBtn.addEventListener('click', commitRefine);
}
