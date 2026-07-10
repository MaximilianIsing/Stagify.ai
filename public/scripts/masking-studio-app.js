import { requestError as _requestError } from './masking-studio/generation.js';
import { createSessionStore } from './masking-studio/session-store.js';
import { createGeneratePipeline } from './masking-studio/generate-pipeline.js';
import { createDrawTools } from './masking-studio/draw-tools.js';
import { createSegWand } from './masking-studio/seg-wand.js';
import { createLayersUi } from './masking-studio/layers-ui.js';
import { createViewer } from './masking-studio/viewer.js';
import { createUpload } from './masking-studio/upload.js';

        // ---------------------------------------------------------------------
        // Access gate: Masking Studio is Stagify+ only. Anonymous visitors were
        // already redirected by the pre-paint head script; here we verify the
        // plan. Pro users get the page revealed; signed-in free users get the
        // page revealed *behind* the upgrade dialog.
        // ---------------------------------------------------------------------
        async function ensureStudioProAccess() {
          // auth.js loads with `defer`, so wait for it before deciding.
          let waited = 0;
          while (!window.StagifyAuth && waited < 5000) {
            await new Promise((r) => setTimeout(r, 50));
            waited += 50;
          }
          if (!window.StagifyAuth) {
            window.location.replace('stagify-plus.html');
            return false;
          }
          try {
            await window.StagifyAuth.fetchMe();
          } catch (e) {
            // Network failure verifying the plan — same treatment as no user.
            window.location.replace('stagify-plus.html');
            return false;
          }
          const u = window.StagifyAuth.user;
          if (!u) {
            // Token was present but invalid/expired.
            window.location.replace('stagify-plus.html');
            return false;
          }
          document.documentElement.classList.remove('ms-gate-pending');
          if (u.plan !== 'pro') {
            showProGate();
            return false;
          }
          return true;
        }

        function showProGate() {
          const gate = document.getElementById('ms-pro-gate');
          if (gate) gate.classList.add('active');
        }

        // ---------------------------------------------------------------------
        // "How it works" dialog
        // ---------------------------------------------------------------------
        function setHelpOpen(open, opts) {
          helpEl.classList.toggle('active', open);
          if (open) {
            helpShortcutsEl.classList.toggle('hidden', !!(opts && opts.hideShortcuts));
            helpCloseBtn.focus();
          } else {
            helpBtn.focus();
          }
        }

        // ---------------------------------------------------------------------
        // Small helpers
        // ---------------------------------------------------------------------
        const $ = (sel) => document.querySelector(sel);

        function tx(key, def) {
          const v = window.LanguageSystem && window.LanguageSystem.getText(key);
          return v && v !== 'Loading...' ? v : def;
        }

        function showToast(message, type) {
          const host = document.getElementById('toast-host');
          if (!host) return;
          const el = document.createElement('div');
          el.className = 'toast' + (type === 'error' ? ' toast--error' : type === 'success' ? ' toast--success' : '');
          el.setAttribute('role', type === 'error' ? 'alert' : 'status');
          el.textContent = message;
          host.appendChild(el);
          requestAnimationFrame(() => el.classList.add('toast--show'));
          setTimeout(() => {
            el.classList.remove('toast--show');
            setTimeout(() => el.remove(), 300);
          }, 4200);
        }

        function loadImage(src) {
          return new Promise((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = () => reject(new Error('Failed to load image'));
            im.src = src;
          });
        }

        // ---------------------------------------------------------------------
        // State
        // ---------------------------------------------------------------------
        // Distinct, high-contrast highlight colors. Purely cosmetic: the mask
        // sent to the server is always white-on-black; only stroke alpha counts.
        const PALETTE = [
          { hex: '#2563eb', name: 'Blue' },
          { hex: '#16a34a', name: 'Green' },
          { hex: '#f59e0b', name: 'Orange' },
          { hex: '#8b5cf6', name: 'Purple' },
          { hex: '#ef4444', name: 'Red' },
          { hex: '#0d9488', name: 'Teal' },
        ];
        const MAX_LAYERS = PALETTE.length;

        // One shared mutable store: every field is touched by the entry and at
        // least one extracted island (see scripts/masking-studio/*.js).
        const state = {
          base: null,        // { w, h, canvas } — working-resolution room photo
          layers: [],        // area objects, in z-order
          activeId: null,    // selected area (receives brush strokes)
          phase: 'empty',    // 'empty' | 'draw' | 'generating' | 'review'
          view: 'after',     // review-phase viewer toggle
          brushSize: 50,
          layerSeq: 0,
          genRun: 0,         // ignore async completions from stale runs
          genMeta: null,     // { coreGrow, featherPx } of the last run
          undoStack: [],     // pre-stroke canvas snapshots (LIFO, capped)
          redoStack: [],     // undone states, restored by Ctrl+Y (same cap)
          segCache: null,    // decoded all-object masks for wand hit-testing
          segToken: 0,       // bumped on photo change → drops in-flight results
          comparing: false,  // dragging the compare divider
          zoom: 1,           // 1 = fit to view, up to 4x
          spaceDown: false,  // Space held → pan mode
          panning: false,
        };

        // ---------------------------------------------------------------------
        // DOM refs
        // ---------------------------------------------------------------------
        const dropzone = $('#ms-dropzone');
        const fileInput = $('#ms-file-input');
        const furnitureInput = $('#ms-furniture-input');
        const stack = $('#ms-stack');
        const baseCanvas = $('#ms-base-canvas');
        const resultCanvas = $('#ms-result-canvas');
        const photoEmptyHint = $('#ms-photo-empty-hint');
        const photoThumb = $('#ms-photo-thumb');
        const replaceBtn = $('#ms-replace-btn');
        const helpBtn = $('#ms-help-btn');
        const helpEl = $('#ms-help');
        const helpCloseBtn = $('#ms-help-close');
        const helpDoneBtn = $('#ms-help-done');
        const helpShortcutsEl = $('#ms-help-shortcuts');
        const confirmEl = $('#ms-confirm');
        const confirmDiscardBtn = $('#ms-confirm-discard');
        const confirmKeepBtn = $('#ms-confirm-keep');
        const resumeEl = $('#ms-resume');
        const resumeYesBtn = $('#ms-resume-yes');
        const resumeNoBtn = $('#ms-resume-no');
        const ctaHint = $('#ms-cta-hint');
        const viewerEl = $('#ms-viewer');
        const layerList = $('#ms-layer-list');
        const addLayerBtn = $('#ms-add-layer');
        const brushBtn = $('#ms-brush-btn');
        const eraseBtn = $('#ms-erase-btn');
        const rectBtn = $('#ms-rect-btn');
        const wandBtn = $('#ms-wand-btn');
        const wandRow = $('#ms-wand-row');
        const wandBusyEl = $('#ms-wand-busy');
        const brushRow = $('#ms-brush-row');
        const undoBtn = $('#ms-undo-btn');
        const redoBtn = $('#ms-redo-btn');
        const brushSlider = $('#ms-brush-slider');
        const brushSizeLabel = $('#ms-brush-size');
        const generateBtn = $('#ms-generate');
        const progressEl = $('#ms-progress');
        const progressBar = $('#ms-progress-bar');
        const progressText = $('#ms-progress-text');
        const chipbar = $('#ms-chipbar');
        const viewerHeader = $('#ms-viewer-header');
        const viewToggle = $('#ms-view-toggle');
        const toggleBeforeBtn = $('#ms-toggle-before');
        const toggleCompareBtn = $('#ms-toggle-compare');
        const toggleAfterBtn = $('#ms-toggle-after');
        const compareEl = $('#ms-compare');
        const compareGrip = $('#ms-compare-grip');
        const compareLabelBefore = $('#ms-compare-label-before');
        const compareLabelAfter = $('#ms-compare-label-after');
        const viewerActions = $('#ms-viewer-actions');
        const editHighlightsBtn = $('#ms-edit-highlights');
        const viewResultBtn = $('#ms-view-result');
        const downloadBtn = $('#ms-download');

        // ---------------------------------------------------------------------
        // Room photo → base canvas (upload intake lives in masking-studio/upload.js)
        // ---------------------------------------------------------------------
        // Work at the same resolution the server generates at (fits inside
        // 1920×1080, mirroring its downscale step) so every returned edit maps
        // 1:1 onto our canvases and huge photos don't exhaust canvas memory
        // across up to 6 stacked area layers.
        function setBaseImage(img, opts) {
          const scale = Math.min(1, 1920 / img.width, 1080 / img.height);
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          state.base = { w: w, h: h, canvas: c };

          baseCanvas.width = w;
          baseCanvas.height = h;
          baseCanvas.getContext('2d').drawImage(c, 0, 0);
          resultCanvas.width = w;
          resultCanvas.height = h;

          // Fresh session for the new photo.
          state.layers.forEach((l) => l.el && l.canvasEl && l.canvasEl.remove());
          state.layers = [];
          state.layerSeq = 0;
          state.genRun++;
          state.genMeta = null;
          state.undoStack = [];
          state.redoStack = [];
          state.segCache = null;
          state.segToken++;
          resetZoom();
          if (!(opts && opts.noLayer)) addLayer();

          photoThumb.src = baseCanvas.toDataURL('image/jpeg', 0.7);
          photoEmptyHint.classList.add('hidden');
          replaceBtn.classList.remove('hidden');
          dropzone.classList.add('hidden');
          stack.classList.remove('hidden');
          setPhase('draw');
          scheduleSessionSave();
        }

        // Inverse of setBaseImage: tear the studio back down to the empty
        // dropzone. Used when the async stageability pre-check comes back
        // negative for a photo we already showed (see masking-studio/upload.js)
        // — the non-room is pulled out of the studio instead of lingering.
        function clearBaseImage() {
          state.layers.forEach((l) => l.el && l.canvasEl && l.canvasEl.remove());
          state.layers = [];
          state.activeId = null;
          state.base = null;
          state.layerSeq = 0;
          state.genRun++;
          state.genMeta = null;
          state.undoStack = [];
          state.redoStack = [];
          state.segCache = null;
          state.segToken++;
          resetZoom();

          baseCanvas.getContext('2d').clearRect(0, 0, baseCanvas.width, baseCanvas.height);
          resultCanvas.getContext('2d').clearRect(0, 0, resultCanvas.width, resultCanvas.height);

          photoThumb.removeAttribute('src');
          photoEmptyHint.classList.remove('hidden');
          replaceBtn.classList.add('hidden');
          dropzone.classList.remove('hidden');
          stack.classList.add('hidden');
          setPhase('empty');
          scheduleSessionSave();
        }

        // Area layers + all layer/chip rendering → masking-studio/layers-ui.js
        // (addLayer/removeLayer/getLayer/activeLayer/layerColor/layerTitle/
        //  statusChip/renderLayers/renderChips/updateChipbarVisibility).

        // Furniture-reference intake (prepare/accept/drop + paste) → masking-studio/upload.js

        // Keep Tab focus inside whichever dialog is open (help, resume,
        // discard-confirm, or the pro gate — they share the overlay class).
        document.addEventListener('keydown', (e) => {
          if (e.key !== 'Tab') return;
          const card = document.querySelector('.ms-pro-gate.active .ms-pro-gate__card');
          if (!card) return;
          const focusables = card.querySelectorAll('button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])');
          if (!focusables.length) return;
          const first = /** @type {HTMLElement} */ (focusables[0]);
          const last = /** @type {HTMLElement} */ (focusables[focusables.length - 1]);
          if (!card.contains(document.activeElement)) {
            e.preventDefault();
            first.focus();
          } else if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        });

        // Zoom & pan → masking-studio/viewer.js (setZoom/resetZoom).

        // ---------------------------------------------------------------------
        // Discard confirmation: replacing the photo (or starting over) wipes
        // highlights and staged results, so ask first when results exist.
        // ---------------------------------------------------------------------
        let pendingConfirmAction = null;

        function hasAnyResults() {
          return state.layers.some((l) => l.status === 'done' && l.editedImg);
        }

        // strict also protects unstaged work (strokes/prompts/furniture) — used
        // for accident-prone paths like dropping a file onto the photo itself.
        function requestDiscard(action, strict) {
          const hasWork = strict && state.layers.some((l) => l.painted || l.prompt.trim() || l.furniture);
          if (!hasAnyResults() && !hasWork) { action(); return; }
          pendingConfirmAction = action;
          confirmEl.classList.add('active');
          confirmKeepBtn.focus();
        }

        function closeConfirm() {
          confirmEl.classList.remove('active');
          pendingConfirmAction = null;
        }

        confirmDiscardBtn.addEventListener('click', () => {
          const action = pendingConfirmAction;
          closeConfirm();
          if (action) action();
        });
        confirmKeepBtn.addEventListener('click', closeConfirm);
        confirmEl.addEventListener('click', (e) => {
          if (e.target === confirmEl) closeConfirm();
        });

        // Leaving the page loses staged results — let the browser warn.
        window.addEventListener('beforeunload', (e) => {
          if (hasAnyResults()) {
            e.preventDefault();
            e.returnValue = '';
          }
        });

        // Desktop shortcuts: B brush, E erase, [ / ] brush size, 1-6 pick area,
        // Ctrl+Z undo stroke.
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            if (confirmEl.classList.contains('active')) { e.preventDefault(); closeConfirm(); return; }
            if (helpEl.classList.contains('active')) { e.preventDefault(); setHelpOpen(false); return; }
            if (resumeEl.classList.contains('active')) {
              // Dismiss without deciding: the stored session stays for later.
              e.preventDefault();
              resumeEl.classList.remove('active');
              return;
            }
            if (cancelRect()) { e.preventDefault(); return; }
          }
          const t = /** @type {HTMLElement} */ (e.target);
          const typing = t && t.closest && t.closest('input, textarea, select, [contenteditable]');
          if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z') {
            if (!typing && state.phase === 'draw') {
              e.preventDefault();
              if (e.shiftKey) redoStroke();
              else undoStroke();
            }
            return;
          }
          if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'y') {
            if (!typing && state.phase === 'draw' && state.redoStack.length) {
              e.preventDefault();
              redoStroke();
            }
            return;
          }
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          if (typing) return;
          if (!state.base || state.phase === 'generating') return;
          if (e.code === 'Space') {
            // Don't hijack Space when a button/link has focus (it activates it).
            if (t && t.closest && t.closest('button, a, [role="button"]')) return;
            e.preventDefault();
            if (!e.repeat) {
              state.spaceDown = true;
              stack.classList.add('is-pan');
              hideCursor();
            }
            return;
          }
          const k = e.key.toLowerCase();
          if (k === 'b') { setTool('brush'); }
          else if (k === 'e') { setTool('erase'); }
          else if (k === 'r') { setTool('rect'); }
          else if (k === 'w') { setTool('wand'); }
          else if (k === 'h') { if (!e.repeat && state.phase === 'draw') stack.classList.add('is-peek'); }
          else if (e.key === '[') { setBrushSize(state.brushSize - 10); }
          else if (e.key === ']') { setBrushSize(state.brushSize + 10); }
          else if (/^[1-6]$/.test(e.key)) {
            const layer = state.layers[parseInt(e.key, 10) - 1];
            if (layer) {
              state.activeId = layer.id;
              renderLayers();
            }
          }
        });
        document.addEventListener('keyup', (e) => {
          if (e.key.toLowerCase() === 'h') stack.classList.remove('is-peek');
          if (e.code === 'Space') {
            state.spaceDown = false;
            state.panning = false;
            stack.classList.remove('is-pan');
          }
        });
        window.addEventListener('blur', () => {
          stack.classList.remove('is-peek');
          state.spaceDown = false;
          state.panning = false;
          stack.classList.remove('is-pan');
        });

        // Phase state machine, before/compare/after view, compare divider, busy
        // overlay, and control-enablement → masking-studio/viewer.js (setPhase/
        // setView/setComparePos/moveCompare/renderBusyDots/updateControls).

        // ---------------------------------------------------------------------
        // Generation: every painted area runs as its own parallel mask edit.
        // ---------------------------------------------------------------------
        function requestError(status, result) {
          return _requestError(status, result, tx, showProGate);
        }

        // ---------------------------------------------------------------------
        // Review actions
        // ---------------------------------------------------------------------
        editHighlightsBtn.addEventListener('click', () => {
          if (state.phase !== 'review') return;
          setPhase('draw');
        });

        viewResultBtn.addEventListener('click', () => {
          if (state.phase !== 'draw' || !state.layers.some((l) => l.status === 'done' && l.editedImg)) return;
          compositeAll();
          setPhase('review');
          setView('after');
        });

        downloadBtn.addEventListener('click', () => {
          if (!state.layers.some((l) => l.status === 'done')) return;
          compositeAll(); // strokes may have changed since the last composite
          const link = document.createElement('a');
          link.download = 'stagify-masking-studio-' + Date.now() + '.jpg';
          link.href = resultCanvas.toDataURL('image/jpeg', 0.92);
          link.click();
        });


        // Dropzone / replace / file-input / room-drop wiring → masking-studio/upload.js

        helpBtn.addEventListener('click', () => setHelpOpen(true));
        helpCloseBtn.addEventListener('click', () => setHelpOpen(false));
        helpDoneBtn.addEventListener('click', () => setHelpOpen(false));
        helpEl.addEventListener('click', (e) => {
          if (e.target === helpEl) setHelpOpen(false);
        });

        // Add-area button + languagechange re-render → masking-studio/layers-ui.js

        // ---------------------------------------------------------------------
        // Islands (scripts/masking-studio/*): each factory receives the shared
        // state store plus entry glue; APIs are destructured into same-named
        // consts so the call sites above stay unchanged.
        // ---------------------------------------------------------------------
        // Area layers + card/chip rendering. Its cross-island collaborators
        // (updateControls/setPhase/scheduleSessionSave/… from islands created
        // below) are late-bound arrows — every one fires only on a user event or
        // during boot AFTER this whole block runs, so the consts are assigned.
        const {
          addLayer,
          getLayer,
          activeLayer,
          layerColor,
          layerTitle,
          renderLayers,
          updateChipbarVisibility,
        } = createLayersUi({
          state,
          MAX_LAYERS,
          PALETTE,
          layerList,
          chipbar,
          stack,
          resultCanvas,
          addLayerBtn,
          tx,
          showToast,
          updateControls: () => updateControls(),
          scheduleSessionSave: () => scheduleSessionSave(),
          updateStageBackdrop: () => updateStageBackdrop(),
          compositeAll: () => compositeAll(),
          setPhase: (p) => setPhase(p),
          snapshotForUndo: () => snapshotForUndo(),
          retryLayer: (id) => retryLayer(id),
          selectCandidate: (l, i) => selectCandidate(l, i),
          wireFurnitureDrop: (z, l) => wireFurnitureDrop(z, l),
          beginFurniturePick: (id) => beginFurniturePick(id),
        });

        // Phases/view/compare, zoom & pan, busy overlay, control enablement.
        const { setPhase, setView, moveCompare, renderBusyDots, updateControls, setZoom, resetZoom } = createViewer({
          state,
          MAX_LAYERS,
          stack,
          baseCanvas,
          resultCanvas,
          viewerEl,
          viewToggle,
          viewerHeader,
          viewerActions,
          editHighlightsBtn,
          viewResultBtn,
          downloadBtn,
          toggleBeforeBtn,
          toggleCompareBtn,
          toggleAfterBtn,
          compareEl,
          compareGrip,
          compareLabelBefore,
          compareLabelAfter,
          addLayerBtn,
          replaceBtn,
          brushSlider,
          brushBtn,
          eraseBtn,
          rectBtn,
          wandBtn,
          undoBtn,
          redoBtn,
          layerList,
          generateBtn,
          ctaHint,
          tx,
          renderLayers,
          updateChipbarVisibility,
          layerColor,
          layerTitle,
          updateStageBackdrop: () => updateStageBackdrop(),
          hideCursor: () => hideCursor(),
        });

        // Session persistence: IndexedDB transport, debounced saves, resume dialog.
        const { scheduleSessionSave, maybeOfferResume } = createSessionStore({
          state,
          MAX_LAYERS,
          PALETTE,
          stack,
          resultCanvas,
          resumeEl,
          resumeYesBtn,
          resumeNoBtn,
          setBaseImage,
          addLayer,
          renderLayers,
          updateControls,
          showToast,
          tx,
        });

        // Generation pipeline: parallel per-area mask edits, compositing, and
        // the refine-phase ghost backdrop.
        const { compositeAll, updateStageBackdrop, selectCandidate, retryLayer } =
          createGeneratePipeline({
            state,
            generateBtn,
            progressEl,
            progressBar,
            progressText,
            baseCanvas,
            resultCanvas,
            setPhase,
            setView,
            renderLayers,
            updateControls,
            renderBusyDots,
            hasAnyResults,
            getLayer,
            requestError,
            showToast,
            tx,
            loadImage,
          });

        // Draw tools: brush/erase/rect strokes, undo/redo, pointer + pinch
        // handling, cursor preview, tool switching.
        const {
          setTool,
          setBrushSize,
          snapshotForUndo,
          undoStroke,
          redoStroke,
          cancelRect,
          hideCursor,
          scanHasContent,
          canvasPoint,
        } = createDrawTools({
          state,
          stack,
          baseCanvas,
          viewerEl,
          undoBtn,
          redoBtn,
          brushBtn,
          eraseBtn,
          rectBtn,
          wandBtn,
          brushRow,
          wandRow,
          brushSlider,
          brushSizeLabel,
          activeLayer,
          getLayer,
          layerColor,
          renderLayers,
          updateControls,
          scheduleSessionSave,
          updateStageBackdrop,
          setZoom,
          moveCompare,
          // Late-bound: segWand is created just below, and these only fire on
          // user input long after boot.
          wandClick: (e) => segWand.wandClick(e),
          ensureSegCache: () => segWand.ensureSegCache(),
        });

        // Magic select: Gemini segmentation wand (paints like a faster brush,
        // via the draw-tools callbacks).
        const segWand = createSegWand({
          state,
          stack,
          wandBusyEl,
          activeLayer,
          layerColor,
          renderLayers,
          updateControls,
          scheduleSessionSave,
          updateStageBackdrop,
          snapshotForUndo,
          scanHasContent,
          canvasPoint,
          requestError,
          showToast,
          tx,
          loadImage,
        });

        // Room-photo + furniture intake, drop/paste, and dropzone/replace wiring.
        // Created last: layers-ui's furniture-add button late-binds to
        // wireFurnitureDrop/beginFurniturePick, and both only fire post-upload.
        const { wireFurnitureDrop, beginFurniturePick } = createUpload({
          state,
          dropzone,
          fileInput,
          furnitureInput,
          stack,
          replaceBtn,
          showToast,
          tx,
          loadImage,
          setBaseImage,
          clearBaseImage,
          requestDiscard,
          activeLayer,
          getLayer,
          renderLayers,
          updateControls,
          layerTitle,
          scheduleSessionSave,
        });

        // ---------------------------------------------------------------------
        // Boot
        // ---------------------------------------------------------------------
        setPhase('empty');
        ensureStudioProAccess().then(async (isPro) => {
          if (!isPro) return;
          // A saved session takes priority over the first-visit walkthrough.
          const offeredResume = await maybeOfferResume();
          if (offeredResume) return;
          let seen = null;
          try { seen = localStorage.getItem('msHelpSeen'); } catch (e) {}
          if (!seen) {
            try { localStorage.setItem('msHelpSeen', '1'); } catch (e) {}
            setHelpOpen(true, { hideShortcuts: true });
          }
        });
