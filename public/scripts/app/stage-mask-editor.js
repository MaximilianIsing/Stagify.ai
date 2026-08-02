// Stage mask editor island for the main Stagify tool (scripts/app.js).
//
// The brush-mask "edit with AI" subsystem for the staging tool's Before/After
// canvases. A factory that owns its state and receives the glue it needs from
// the entry via deps; self-wires its own trigger button.
//
// What lives HERE is what differs from the AI Designer's editor: binding to the
// static #stage-mask-* markup in index.html, the before/after editor modes and
// their version caps, the draw/loading/refine phase machine, and committing back
// through onMaskCommit. The brush, viewport pinning, processing overlay,
// reference photo, sizing, refine maths, the /api/mask-edit request and the
// phase copy are all shared — see scripts/mask/.
//
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
import { maskCopy } from '../mask/copy.js';
import { maskGrowths, snapshotCanvas, renderRefinePreview } from '../mask/refine.js';
import { requestMaskEdit } from '../mask/generate.js';
import { readImageFile } from './image-file.js';

/**
 * @param {{
 *   maskEditBtn: HTMLElement | null,
 *   canvas1: HTMLCanvasElement,
 *   stagePreview: HTMLImageElement | null,
 *   processBtn: HTMLButtonElement | null,
 *   activeViewIsAfter: () => boolean,
 *   getBeforeVersions: () => string[],
 *   getAfterVersions: () => string[],
 *   maxVersions: number,
 *   onMaskCommit: (finalUrl: string, isBefore: boolean) => Promise<void>,
 *   updateMaskButtonVisibility: () => void,
 * }} deps - The trigger FAB, the two canvases the editor binds to, the entry's
 *   view/version accessors, and the commit callback. `onMaskCommit(finalUrl,
 *   isBefore)` applies the committed version to the entry's shared before/after
 *   version state + display.
 * @returns {{ openStandalone: () => void }} `openStandalone` is the nav's
 *   "Basic Mask" entry: the same editor with no staging job behind it.
 */
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
      // The FAB is optional now: Basic Mask opens this editor from the nav, with
      // no staging job and therefore no FAB in play. Only the modal is required.
      if (!maskModal) return { openStandalone() {} };

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
      const content = maskModal.querySelector('.stage-mask-content');
      const uploadZone = $('#stage-mask-upload');
      const uploadInput = /** @type {HTMLInputElement} */ ($('#stage-mask-upload-input'));

      // 'after' = refine an already-staged image; 'before' = edit the original
      // photo into a new unstaged variant. Both append to their carousel.
      // 'standalone' = Basic Mask, opened from the nav with its own upload and
      // no carousel to append to — its result is kept here instead.
      let editorMode = 'after';

      // Standalone only: the most recently committed composite, offered as a
      // download and used as the base for the next mask.
      let standaloneUrl = null;

      // ---- In-modal generate → refine flow ---------------------------------
      // "Apply Edit" no longer closes the modal. We blur the canvas while the AI
      // runs, then show the result here so the user can repaint the outline.
      // Repainting only re-crops the already-generated image (instant, free) — it
      // never re-calls the API unless they press "Regenerate".
      let phase = 'draw';        // 'draw' | 'loading' | 'refine'
      let refineState = null;    // { origCanvas, w, h, coreGrow, featherPx, editedImg, isBefore }
      /** @type {HTMLElement|null} */
      let maskDialogOpener = null; // whatever had focus when the dialog opened

      // Refine-phase action buttons, created once and toggled by phase.
      const rerunBtn = document.createElement('button');
      rerunBtn.type = 'button';
      rerunBtn.id = 'stage-mask-rerun';
      rerunBtn.className = 'btn btn-secondary hidden';
      const doneBtn = document.createElement('button');
      doneBtn.type = 'button';
      doneBtn.id = 'stage-mask-done';
      doneBtn.className = 'btn btn-primary hidden';
      // Standalone-only action buttons, same treatment: built once, shown by phase.
      const anotherBtn = document.createElement('button');
      anotherBtn.type = 'button';
      anotherBtn.id = 'stage-mask-another';
      anotherBtn.className = 'btn btn-ghost hidden';
      const downloadBtn = document.createElement('button');
      downloadBtn.type = 'button';
      downloadBtn.id = 'stage-mask-download';
      downloadBtn.className = 'btn btn-primary hidden';
      if (actionsRow) {
        actionsRow.appendChild(rerunBtn);
        actionsRow.appendChild(doneBtn);
        actionsRow.appendChild(anotherBtn);
        actionsRow.appendChild(downloadBtn);
      }

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

      // Shared overlay. It marks the container `processing` — the same class the
      // stylesheet blurs, isProcessing() reads and the brush treats as busy — so
      // there is now one busy state rather than this editor's old pair of
      // `processing` (set by the phase machine) and `smask-busy` (set here).
      // ensure() runs now rather than on first use so the stylesheet lands at
      // construction time, as it always has.
      const overlay = createMaskOverlay({
        lang: tx,
        getContainer: () => /** @type {HTMLElement} */ (canvasContainer),
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
        [cancelBtn, clearBtn, submitBtn, rerunBtn, doneBtn, anotherBtn, downloadBtn, brushToolBtn, eraseToolBtn, brushSlider, promptInput, refAddBtn, refRemoveBtn]
          .forEach((el) => { if (el) el.disabled = dis; });
      }

      // Basic Mask's two extra buttons. Derived from the phase rather than
      // toggled at each call site, because the result that reveals Download
      // arrives through showInEditor()'s async image load — there is no single
      // moment after the commit at which to switch them on.
      function syncStandaloneActions() {
        const standaloneDraw = editorMode === 'standalone' && phase === 'draw';
        anotherBtn.classList.toggle('hidden', !standaloneDraw);
        downloadBtn.classList.toggle('hidden', !(standaloneDraw && standaloneUrl));
        if (standaloneDraw) {
          // The staging screen already says both of these, in all 11 packs —
          // reuse its keys rather than adding two more that must be translated
          // to the same words. (Not mask/copy.js: that is shared with the AI
          // Designer's editor, which has no standalone mode to describe.)
          anotherBtn.textContent = tx('modal.staging.uploadAnother', 'Upload Another');
          downloadBtn.textContent = tx('modal.staging.downloadResultShort', 'Download');
        }
      }

      // Switch the editor between drawing, loading and refine phases.
      function setPhase(p) {
        phase = p;
        const titleEl = maskModal.querySelector('.stage-mask-title');
        const copy = maskCopy(tx);
        if (p === 'loading') {
          setControlsDisabled(true);
          syncStandaloneActions();
          // The overlay marks the container `processing` (its busy class), which
          // is also what isProcessing() and the CSS blur key off — so the phase
          // machine no longer toggles that class itself.
          startOverlay();
          drawCanvas.style.pointerEvents = 'none';
          drawCanvas.style.cursor = 'not-allowed';
          return;
        }
        stopOverlay();
        setControlsDisabled(false);
        drawCanvas.style.pointerEvents = 'auto';
        drawCanvas.style.cursor = 'crosshair';
        if (p === 'refine') {
          if (submitBtn) submitBtn.classList.add('hidden');
          if (clearBtn) clearBtn.classList.add('hidden');
          rerunBtn.classList.remove('hidden');
          doneBtn.classList.remove('hidden');
          rerunBtn.textContent = copy.rerun;
          doneBtn.textContent = copy.done;
          if (titleEl) titleEl.textContent = copy.refineTitle;
          helpIcon.classList.remove('hidden');
          helpIcon.setAttribute('aria-label', copy.refineHelpAria);
          helpTip.textContent = copy.refineHelp;
          brush.recolor(brush.REFINE_COLOR);
          if (noteEl) { noteEl.style.display = ''; noteEl.textContent = copy.refineNote; }
          syncStandaloneActions();
          updateSubmitState();
        } else { // draw
          if (submitBtn) submitBtn.classList.remove('hidden');
          if (clearBtn) clearBtn.classList.remove('hidden');
          rerunBtn.classList.add('hidden');
          doneBtn.classList.add('hidden');
          helpIcon.classList.add('hidden');
          applyEditorCopy();
          syncStandaloneActions();
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
        return v || def;
      }

      // Swap the editor's title, prompt label/placeholder and submit label to
      // match the current mode.
      function applyEditorCopy() {
        const titleEl = maskModal.querySelector('.stage-mask-title');
        const labelEl = maskModal.querySelector('.stage-mask-prompt-label');
        const submitStrong = submitBtn && submitBtn.querySelector('strong');
        if (editorMode === 'standalone') {
          if (titleEl) titleEl.textContent = tx('modal.staging.basicMaskTitle', 'Basic Mask');
          if (labelEl) labelEl.textContent = tx('modal.staging.maskBeforePromptLabel', 'What would you like to change in the painted area?');
          if (promptInput) promptInput.placeholder = tx('modal.staging.maskBeforePromptPlaceholder', 'e.g., remove the old sofa, clear the clutter, repaint the wall white');
          if (submitStrong) submitStrong.textContent = tx('modal.staging.maskBeforeApply', 'Apply edit');
        } else if (editorMode === 'before') {
          if (titleEl) titleEl.textContent = tx('modal.staging.maskBeforeTitle', 'Mask & edit photo');
          if (labelEl) labelEl.textContent = tx('modal.staging.maskBeforePromptLabel', 'What would you like to change in the painted area?');
          if (promptInput) promptInput.placeholder = tx('modal.staging.maskBeforePromptPlaceholder', 'e.g., remove the old sofa, clear the clutter, repaint the wall white');
          if (submitStrong) submitStrong.textContent = tx('modal.staging.maskBeforeApply', 'Apply edit');
        } else {
          if (titleEl) titleEl.textContent = maskCopy(tx).title;
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
          focusMaskDialog();
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

      // ---- Basic Mask (standalone) -----------------------------------------
      // Same editor, opened from the nav with no staging job behind it, so it
      // brings its own uploader and keeps its own result. Everything below the
      // image — brush, prompt, reference photo, generate, refine — is unchanged.

      function setUploadState(on) {
        if (content) content.classList.toggle('is-uploading', on);
        if (on && uploadInput) uploadInput.value = '';
      }

      /** Open with nothing loaded: the uploader is the first thing they see. */
      function openStandalone() {
        editorMode = 'standalone';
        standaloneUrl = null;
        refineState = null;
        reference.clear();
        if (promptInput) promptInput.value = '';
        brush.clear();
        // Through setPhase rather than by assigning `phase`: the draw phase is
        // also what re-applies the Apply-Edit readiness gate, and the shared
        // closeEditor() before it left every control enabled. Skipping it showed
        // "Apply edit" as clickable on an empty dialog — the same regression
        // stage-mask-apply-gate.spec.js exists for on the staging path.
        setPhase('draw');
        setUploadState(true);
        maskModal.classList.add('active');
        maskModal.setAttribute('aria-hidden', 'false');
        focusMaskDialog();
        viewport.bind();
        viewport.sync();
      }

      /** A file from the uploader's picker or a drop. */
      async function acceptStandaloneFile(file) {
        const read = await readImageFile(file, { showError: showErrorToast });
        if (!read) return;
        // No /api/validate-image here on purpose: Basic Mask edits any photo,
        // not just a stageable room, and that check spends a paid vision call.
        setUploadState(false);
        showInEditor(read.dataUrl);
      }

      /**
       * Move focus into the dialog on open, remembering where it came from.
       *
       * Both open paths (showInEditor and openStandalone) only toggled the class and
       * aria-hidden, so focus stayed on the trigger BEHIND the overlay: activating
       * the paint-brush FAB with Enter left the dialog unannounced and sent the next
       * Tab into the page underneath. ai-designer/mask-editor.js focuses its close
       * button for exactly this reason and says so; this is the same move.
       * @returns {void}
       */
      function focusMaskDialog() {
        maskDialogOpener = /** @type {HTMLElement|null} */ (document.activeElement);
        const closeBtn = /** @type {HTMLElement|null} */ (document.getElementById('stage-mask-close'));
        if (closeBtn && typeof closeBtn.focus === 'function') closeBtn.focus();
      }

      function closeEditor() {
        maskModal.classList.remove('active');
        maskModal.setAttribute('aria-hidden', 'true');
        // Hand focus back, guarded on isConnected — applying an edit can replace the
        // element the opener lived in, and focusing a detached node drops focus to
        // <body> silently.
        const opener = maskDialogOpener;
        maskDialogOpener = null;
        if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
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
        anotherBtn.classList.add('hidden');
        downloadBtn.classList.add('hidden');
        standaloneUrl = null;
        setUploadState(false);
        setControlsDisabled(false);
        if (canvasContainer) canvasContainer.classList.remove('processing');
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
        if (editorMode === 'standalone') {
          // Basic Mask has no carousel to commit into. The result becomes the
          // new base image so the next mask stacks on top of it, and Download
          // appears alongside — see syncStandaloneActions(), which showInEditor's
          // setPhase('draw') reaches on its own once the image has loaded.
          standaloneUrl = finalUrl;
          if (promptInput) promptInput.value = '';
          reference.clear();
          showInEditor(finalUrl);
          if (processBtn) processBtn.disabled = false;
          return;
        }
        closeEditor();
        // Commit the new version into the entry's shared before/after state +
        // display. That state lives in app.js and is read/written in many other
        // places, so the entry owns the mutation via this injected callback.
        await onMaskCommit(finalUrl, isBefore);
      }

      if (submitBtn) submitBtn.addEventListener('click', submitEdit);
      rerunBtn.addEventListener('click', rerunAI);
      doneBtn.addEventListener('click', commitRefine);

      // ---- Basic Mask wiring ------------------------------------------------
      anotherBtn.addEventListener('click', () => {
        standaloneUrl = null;
        refineState = null;
        reference.clear();
        if (promptInput) promptInput.value = '';
        brush.clear();
        setPhase('draw');
        setUploadState(true);
      });

      downloadBtn.addEventListener('click', () => {
        if (!standaloneUrl) return;
        const a = document.createElement('a');
        a.href = standaloneUrl;
        a.download = `stagify-basic-mask-${Date.now()}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      });

      if (uploadZone && uploadInput) {
        uploadZone.addEventListener('click', () => uploadInput.click());
        uploadZone.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); uploadInput.click(); }
        });
        uploadInput.addEventListener('change', (e) => {
          const file = /** @type {HTMLInputElement} */ (e.target).files?.[0];
          if (file) acceptStandaloneFile(file);
        });
        ['dragenter', 'dragover'].forEach((evt) => uploadZone.addEventListener(evt, (e) => {
          e.preventDefault();
          uploadZone.classList.add('is-dragging');
        }));
        ['dragleave', 'drop'].forEach((evt) => uploadZone.addEventListener(evt, (e) => {
          e.preventDefault();
          uploadZone.classList.remove('is-dragging');
        }));
        uploadZone.addEventListener('drop', (e) => {
          const file = /** @type {DragEvent} */ (e).dataTransfer?.files?.[0];
          if (file) acceptStandaloneFile(file);
        });
      }

      return { openStandalone };
}
