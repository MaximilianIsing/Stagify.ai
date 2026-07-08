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
import { buildModelMask, buildBlendMask, compositeMaskedEditCanvas, compositeMaskedEdit } from '../mask-core.js';

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
        const list = kind === 'before' ? getBeforeVersions() : getAfterVersions();
        if (list.length < maxVersions) return false;
        alert(tx('modal.staging.maskLimitReached',
          "You've reached the limit of " + maxVersions + ' versions for this image.'));
        return true;
      }

      // Pin the editor to the VISUAL viewport on mobile so its top/bottom never
      // hide behind the browser's URL bar / toolbar (and it stays above the
      // on-screen keyboard). Mirrors the AI Designer mask editor. Desktop untouched.
      let viewportSyncHandler = null;
      function syncEditorToViewport() {
        if (!maskModal.classList.contains('active')) return;
        const vv = window.visualViewport;
        const isMobile = window.matchMedia('(max-width: 768px)').matches;
        if (!vv || !isMobile) {
          maskModal.style.top = '';
          maskModal.style.left = '';
          maskModal.style.width = '';
          maskModal.style.height = '';
          return;
        }
        maskModal.style.top = vv.offsetTop + 'px';
        maskModal.style.left = vv.offsetLeft + 'px';
        maskModal.style.width = vv.width + 'px';
        maskModal.style.height = vv.height + 'px';
      }
      function bindViewportSync() {
        if (viewportSyncHandler || !window.visualViewport) return;
        viewportSyncHandler = () => syncEditorToViewport();
        window.visualViewport.addEventListener('resize', viewportSyncHandler);
        window.visualViewport.addEventListener('scroll', viewportSyncHandler);
      }
      function unbindViewportSync() {
        if (viewportSyncHandler && window.visualViewport) {
          window.visualViewport.removeEventListener('resize', viewportSyncHandler);
          window.visualViewport.removeEventListener('scroll', viewportSyncHandler);
        }
        viewportSyncHandler = null;
        maskModal.style.top = '';
        maskModal.style.left = '';
        maskModal.style.width = '';
        maskModal.style.height = '';
      }

      // Shared: load a source image into the base/draw canvases and open the modal.
      function showInEditor(src) {
        const img = new Image();
        img.onload = () => {
          // On mobile use the visual viewport height and a smaller fraction so the
          // image leaves room for the header + controls + buttons without clipping.
          const isMobileViewport = window.matchMedia('(max-width: 768px)').matches;
          const viewportH = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
          const viewportW = (window.visualViewport && window.visualViewport.width) || window.innerWidth;
          const maxHeight = viewportH * (isMobileViewport ? 0.5 : 0.6);
          const maxWidth = Math.min(viewportW * 0.85, 860);
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

          if (canvasContainer) canvasContainer.classList.remove('processing');
          drawCanvas.style.pointerEvents = 'auto';
          drawCanvas.style.cursor = 'crosshair';
          updateSubmitState();
          refineState = null;
          setPhase('draw');
          maskModal.classList.add('active');
          maskModal.setAttribute('aria-hidden', 'false');
          bindViewportSync();
          syncEditorToViewport();
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
        unbindViewportSync();
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
        // Map the pointer into canvas (image-pixel) space using the LIVE rendered
        // size. The canvas's on-screen size is governed by CSS, which can differ
        // from the dispW/dispH we requested (e.g. a tall image gets width-clamped
        // by the container). Deriving the scale from getBoundingClientRect every
        // stroke keeps drawing aligned no matter how the layout sized the canvas.
        const rect = drawCanvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const x = (e.clientX - rect.left) * (drawCanvas.width / rect.width);
        const y = (e.clientY - rect.top) * (drawCanvas.height / rect.height);
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
        // Convert HEIC/HEIF to JPEG first so it decodes and passes validation.
        const prep = (window.StagifyHeic && window.StagifyHeic.isHeic(file))
          ? window.StagifyHeic.toDisplayableFile(file)
          : Promise.resolve(file);
        prep
          .then(prepareReferenceFile)
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
        // Commit the new version into the entry's shared before/after state +
        // display. That state lives in app.js and is read/written in many other
        // places, so the entry owns the mutation via this injected callback.
        await onMaskCommit(finalUrl, isBefore);
      }

      if (submitBtn) submitBtn.addEventListener('click', submitEdit);
      rerunBtn.addEventListener('click', rerunAI);
      doneBtn.addEventListener('click', commitRefine);
}
