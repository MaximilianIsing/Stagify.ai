import {
  nextColorIdx,
  createLayer,
  layerColor as _layerColor,
  layerTitle as _layerTitle,
  previewText as _previewText,
  statusChip as _statusChip,
} from './masking-studio/layers.js';
import { requestError as _requestError } from './masking-studio/generation.js';
import { createSessionStore } from './masking-studio/session-store.js';
import { createGeneratePipeline } from './masking-studio/generate-pipeline.js';
import { createDrawTools } from './masking-studio/draw-tools.js';
import { createSegWand } from './masking-studio/seg-wand.js';

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

        const DEFAULT_UNSTAGEABLE_MESSAGE =
          "This doesn't look like a room or property space. Please upload a photo of an interior room or exterior space you'd like to stage.";

        // Cheap server-side pre-check: is this actually a stageable room/property
        // photo (not a selfie, a product shot, a document…)? Downscales the
        // already-decoded image to a small JPEG first (keeps the POST tiny), then
        // asks the server. Always resolves to { valid, reason }; fails OPEN so our
        // own hiccup never blocks a legitimate upload.
        async function validateStageableRoom(img) {
          try {
            const max = 1024;
            const scale = Math.min(1, max / Math.max(img.width, img.height));
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(img.width * scale));
            c.height = Math.max(1, Math.round(img.height * scale));
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            const payload = c.toDataURL('image/jpeg', 0.9);
            const tok = window.StagifyAuth && window.StagifyAuth.getToken();
            const resp = await fetch('/api/validate-image', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(tok ? { Authorization: 'Bearer ' + tok } : {}),
              },
              body: JSON.stringify({ image: payload, authToken: tok || undefined }),
            });
            if (!resp.ok) return { valid: true, reason: '' };
            const r = await resp.json().catch(() => null);
            if (!r || typeof r.valid !== 'boolean') return { valid: true, reason: '' };
            return r;
          } catch (e) {
            return { valid: true, reason: '' };
          }
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
        let busyMsgTimer = null;
        let comparePos = 0.5;     // compare-view divider, 0..1 of photo width

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

        let busyOverlay = null;
        let pendingFurnitureLayerId = null;

        // ---------------------------------------------------------------------
        // Room photo upload
        // ---------------------------------------------------------------------
        const ROOM_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

        async function handleRoomFile(file) {
          if (!file) return;
          try {
            if (window.StagifyHeic && window.StagifyHeic.isHeic(file)) {
              file = await window.StagifyHeic.toDisplayableFile(file);
            }
          } catch (e) {
            showToast(tx('errors.heicConvert', "We couldn't read that HEIC photo. Please try a JPG or PNG."), 'error');
            return;
          }
          if (ROOM_TYPES.indexOf((file.type || '').toLowerCase()) === -1) {
            showToast(tx('errors.fileType', 'Please upload a JPG, PNG, or WebP image.'), 'error');
            return;
          }
          if (file.size > 100 * 1024 * 1024) {
            showToast(tx('errors.fileTooLarge', 'That image is too large — please choose one under 100 MB.'), 'error');
            return;
          }
          const dataUrl = await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onerror = () => reject(new Error('read'));
            r.onload = () => resolve(r.result);
            r.readAsDataURL(file);
          }).catch(() => null);
          if (!dataUrl) {
            showToast(tx('errors.processingFailed', 'Something went wrong. Please try again.'), 'error');
            return;
          }
          let img;
          try {
            img = await loadImage(dataUrl);
          } catch (e) {
            showToast(tx('errors.fileType', 'Please upload a JPG, PNG, or WebP image.'), 'error');
            return;
          }
          // Pre-flight: only stageable room/property photos may enter the studio.
          // A non-room (a selfie, a product shot, a document…) is rejected here
          // with a friendly reason instead of wasting a masking generation.
          const stageable = await validateStageableRoom(img);
          if (stageable && stageable.valid === false) {
            showToast(stageable.reason || DEFAULT_UNSTAGEABLE_MESSAGE, 'error');
            return;
          }
          setBaseImage(img);
        }

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

        // ---------------------------------------------------------------------
        // Area layers
        // ---------------------------------------------------------------------
        function addLayer() {
          if (!state.base || state.layers.length >= MAX_LAYERS) return;
          const colorIdx = nextColorIdx(state.layers, PALETTE.length);
          if (colorIdx === -1) return;
          const c = document.createElement('canvas');
          c.width = state.base.w;
          c.height = state.base.h;
          c.className = 'ms-layer-canvas';
          // Insert below the result canvas so results always cover highlights.
          stack.insertBefore(c, resultCanvas);
          const layer = createLayer({ id: 'L' + (++state.layerSeq), colorIdx: colorIdx, canvasEl: c });
          state.layers.push(layer);
          state.activeId = layer.id;
          renderLayers();
          updateControls();
          scheduleSessionSave();
        }

        function removeLayer(id) {
          const idx = state.layers.findIndex((l) => l.id === id);
          if (idx === -1) return;
          const layer = state.layers[idx];
          if (layer.canvasEl) layer.canvasEl.remove();
          state.layers.splice(idx, 1);
          if (state.activeId === id) state.activeId = state.layers.length ? state.layers[state.layers.length - 1].id : null;
          if (!state.layers.length && state.base) addLayer();
          if (state.phase === 'review') compositeAll();
          // Re-derive the whole phase UI: in refine, removing an area must
          // refresh the ghost backdrop and may retire the Looks Good button
          // (when the last staged area went away).
          setPhase(state.phase);
          scheduleSessionSave();
        }

        function getLayer(id) {
          return state.layers.find((l) => l.id === id) || null;
        }

        function activeLayer() {
          return getLayer(state.activeId);
        }

        // Thin binding wrappers over the pure area-model helpers (scripts/
        // masking-studio/layers.js): bind the live PALETTE / layers array / tx so
        // every call site below stays unchanged. Logic + tests live in the module.
        function layerColor(layer) { return _layerColor(layer, PALETTE); }
        function layerTitle(layer) { return _layerTitle(layer, state.layers, tx); }
        function statusChip(layer) { return _statusChip(layer, tx); }

        // Rebuild the layer cards. Prompt edits mutate state directly (no
        // re-render on keystroke), so rebuilding here never loses typed text.
        // Only the active card shows its full body — inactive areas collapse
        // to their header row so six areas don't make the toolbar a tower.
        function renderLayers() {
          layerList.textContent = '';
          state.layers.forEach((layer) => {
            const isActive = layer.id === state.activeId;
            const card = document.createElement('div');
            card.className = 'ms-layer' + (isActive ? ' is-active' : '');
            card.style.setProperty('--layer-color', layerColor(layer));
            card.setAttribute('role', 'listitem');

            const head = document.createElement('div');
            head.className = 'ms-layer-head';
            const dot = document.createElement('span');
            dot.className = 'ms-layer-dot';
            const name = document.createElement('span');
            name.className = 'ms-layer-name';
            name.textContent = layerTitle(layer);
            const renameBtn = document.createElement('button');
            renameBtn.type = 'button';
            renameBtn.className = 'ms-layer-rename';
            renameBtn.setAttribute('aria-label', tx('maskingStudio.renameAria', 'Rename this area'));
            renameBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
            renameBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              if (state.phase === 'generating') return;
              let settled = false;
              const input = document.createElement('input');
              input.type = 'text';
              input.className = 'ms-layer-name-input';
              input.maxLength = 24;
              input.value = layer.name || layerTitle(layer);
              head.replaceChild(input, name);
              renameBtn.classList.add('hidden');
              input.focus();
              input.select();
              input.addEventListener('click', (ev) => ev.stopPropagation());
              const commit = () => {
                if (settled) return;
                settled = true;
                layer.name = input.value.trim();
                renderLayers();
                scheduleSessionSave();
              };
              input.addEventListener('keydown', (ev) => {
                ev.stopPropagation();
                if (ev.key === 'Enter') commit();
                else if (ev.key === 'Escape') { settled = true; renderLayers(); }
              });
              input.addEventListener('blur', commit);
            });
            const previewFallback = () => _previewText(layer, tx);
            const preview = document.createElement('span');
            preview.className = 'ms-layer-preview';
            preview.textContent = previewFallback();
            preview.title = previewFallback();
            const chip = statusChip(layer);
            const status = document.createElement('span');
            status.className = 'ms-layer-status ' + chip.cls;
            status.textContent = chip.text;
            const caret = document.createElement('span');
            caret.className = 'ms-layer-caret';
            caret.setAttribute('aria-hidden', 'true');
            caret.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'ms-layer-remove';
            removeBtn.setAttribute('aria-label', tx('maskingStudio.removeAreaAria', 'Remove this area'));
            removeBtn.innerHTML = '&times;';
            removeBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              if (state.phase === 'generating') return;
              removeLayer(layer.id);
            });
            head.appendChild(dot);
            head.appendChild(name);
            head.appendChild(renameBtn);
            head.appendChild(preview);
            head.appendChild(status);
            head.appendChild(caret);
            head.appendChild(removeBtn);
            head.addEventListener('click', () => {
              if (state.phase === 'generating') return;
              state.activeId = layer.id;
              renderLayers();
            });

            if (!isActive) {
              // Collapsed: header only. Clicking the head (below) activates
              // and expands it.
              card.appendChild(head);
              layer.el = card;
              layerList.appendChild(card);
              return;
            }

            const body = document.createElement('div');
            body.className = 'ms-layer-body';

            // Stage vs. remove: declutter is a first-class mode, not a prompt trick.
            const modeRow = document.createElement('div');
            modeRow.className = 'ms-mode-row';
            modeRow.setAttribute('role', 'group');
            modeRow.setAttribute('aria-label', tx('maskingStudio.modeAria', 'What happens in this area'));
            [
              ['stage', tx('maskingStudio.modeStage', 'Add furniture')],
              ['remove', tx('maskingStudio.modeRemove', 'Remove object')],
            ].forEach(([val, label]) => {
              const b = document.createElement('button');
              b.type = 'button';
              b.className = 'ms-mode-btn' + (layer.mode === val ? ' is-on' : '');
              b.setAttribute('aria-pressed', layer.mode === val ? 'true' : 'false');
              b.textContent = label;
              b.addEventListener('click', () => {
                if (state.phase === 'generating' || layer.mode === val) return;
                layer.mode = val;
                renderLayers();
                updateControls();
                scheduleSessionSave();
              });
              modeRow.appendChild(b);
            });
            body.appendChild(modeRow);

            const isRemove = layer.mode === 'remove';
            if (isRemove) {
              const hint = document.createElement('p');
              hint.className = 'ms-mode-hint';
              hint.textContent = tx('maskingStudio.removeHint', 'Everything highlighted is removed and the empty room is rebuilt behind it.');
              body.appendChild(hint);
            }

            const promptEl = document.createElement('textarea');
            promptEl.className = 'text-input ms-layer-prompt';
            promptEl.rows = 2;
            promptEl.maxLength = 1000;
            promptEl.placeholder = isRemove
              ? tx('maskingStudio.removePlaceholder', 'Optional: anything to keep or details to match (e.g. keep the rug)…')
              : tx('maskingStudio.promptPlaceholder', 'Describe what to add here (optional if you add a furniture photo)…');
            promptEl.value = layer.prompt;
            promptEl.addEventListener('input', () => {
              layer.prompt = promptEl.value;
              // Refresh this card's status chip in place (a full re-render here
              // would steal focus from the textarea mid-typing).
              const liveChip = statusChip(layer);
              status.className = 'ms-layer-status ' + liveChip.cls;
              status.textContent = liveChip.text;
              preview.textContent = previewFallback();
              preview.title = preview.textContent;
              updateControls();
              scheduleSessionSave();
            });
            promptEl.addEventListener('focus', () => {
              if (state.activeId !== layer.id && state.phase !== 'generating') {
                state.activeId = layer.id;
                // Highlight without a full re-render so the textarea keeps focus.
                layerList.querySelectorAll('.ms-layer').forEach((el) => el.classList.remove('is-active'));
                card.classList.add('is-active');
              }
            });
            body.appendChild(promptEl);

            // One-click prompt ideas while the prompt is empty, tucked behind a
            // little + so the card stays quiet until asked. Each value is
            // "Chip label|Full prompt sentence" in the language files.
            if (!layer.prompt.trim() && !isRemove) {
              if (!layer.presetsOpen) {
                const toggle = document.createElement('button');
                toggle.type = 'button';
                toggle.className = 'ms-preset-toggle';
                toggle.textContent = '+';
                const ideasLabel = tx('maskingStudio.promptIdeas', 'Show prompt ideas');
                toggle.setAttribute('aria-label', ideasLabel);
                toggle.title = ideasLabel;
                toggle.setAttribute('aria-expanded', 'false');
                toggle.addEventListener('click', () => {
                  if (state.phase === 'generating') return;
                  layer.presetsOpen = true;
                  renderLayers();
                });
                body.appendChild(toggle);
              } else {
                const PRESET_DEFAULTS = {
                  presetSofa: "Sofa|Add a comfortable modern sofa that fits the room's style.",
                  presetArmchair: 'Armchair|Add a cozy armchair that matches the room.',
                  presetRug: 'Rug|Add a large area rug under the furniture.',
                  presetPlant: 'Plant|Add a tall potted plant.',
                  presetLamp: 'Floor lamp|Add a stylish floor lamp.',
                  presetArt: 'Wall art|Add framed wall art that suits the room.',
                };
                const presetRow = document.createElement('div');
                presetRow.className = 'ms-preset-row';
                Object.keys(PRESET_DEFAULTS).forEach((key) => {
                  const raw = tx('maskingStudio.' + key, PRESET_DEFAULTS[key]);
                  const bar = raw.indexOf('|');
                  const label = bar === -1 ? raw : raw.slice(0, bar);
                  const sentence = bar === -1 ? raw : raw.slice(bar + 1);
                  const chipBtn = document.createElement('button');
                  chipBtn.type = 'button';
                  chipBtn.className = 'ms-preset';
                  chipBtn.textContent = label;
                  chipBtn.title = sentence;
                  chipBtn.addEventListener('click', () => {
                    if (state.phase === 'generating') return;
                    layer.prompt = sentence;
                    layer.presetsOpen = false; // next time takes a + click again
                    renderLayers();
                    updateControls();
                  });
                  presetRow.appendChild(chipBtn);
                });
                // Trailing "−" tucks the chips back away.
                const closeChip = document.createElement('button');
                closeChip.type = 'button';
                closeChip.className = 'ms-preset';
                closeChip.textContent = '−';
                closeChip.setAttribute('aria-label', tx('common.close', 'Close'));
                closeChip.title = tx('common.close', 'Close');
                closeChip.addEventListener('click', () => {
                  layer.presetsOpen = false;
                  renderLayers();
                });
                presetRow.appendChild(closeChip);
                body.appendChild(presetRow);
              }
            }

            if (isRemove) {
              // No furniture reference in remove mode — nothing is being added.
            } else if (layer.furniture) {
              const prev = document.createElement('div');
              prev.className = 'ms-furniture-preview';
              const img = document.createElement('img');
              img.src = layer.furniture;
              img.alt = tx('pdf.maskEditor.referenceAlt', 'Reference for masked edit');
              const rm = document.createElement('button');
              rm.type = 'button';
              rm.className = 'ms-furniture-remove';
              rm.setAttribute('aria-label', tx('pdf.maskEditor.referenceRemove', 'Remove reference photo'));
              rm.innerHTML = '&times;';
              rm.addEventListener('click', () => {
                if (state.phase === 'generating') return;
                layer.furniture = null;
                layer.furnitureName = '';
                renderLayers();
                updateControls();
                scheduleSessionSave();
              });
              prev.appendChild(img);
              prev.appendChild(rm);
              body.appendChild(prev);
            } else {
              const add = document.createElement('button');
              add.type = 'button';
              add.className = 'ms-furniture-add';
              add.textContent = tx('maskingStudio.addFurniture', '+ Furniture photo');
              add.addEventListener('click', () => {
                if (state.phase === 'generating') return;
                pendingFurnitureLayerId = layer.id;
                furnitureInput.click();
              });
              wireFurnitureDrop(add, layer);
              body.appendChild(add);
            }

            // Quick way to clear one area's strokes (undoable via Ctrl+Z).
            if (layer.painted && state.phase === 'draw') {
              const clearBtn = document.createElement('button');
              clearBtn.type = 'button';
              clearBtn.className = 'ms-clear-btn';
              clearBtn.textContent = tx('maskingStudio.clearHighlight', 'Clear highlight');
              clearBtn.addEventListener('click', () => {
                if (state.phase !== 'draw') return;
                snapshotForUndo();
                state.redoStack = []; // committed clear forks history
                layer.canvasEl.getContext('2d').clearRect(0, 0, state.base.w, state.base.h);
                layer.painted = false;
                // All masks, not just this one: neighbors' halos are clipped
                // against this area's (now vacated) pixels.
                state.layers.forEach((l) => { l.blendMask = null; });
                renderLayers();
                updateControls();
                updateStageBackdrop();
                scheduleSessionSave();
              });
              body.appendChild(clearBtn);
            }

            if (layer.status === 'failed') {
              const err = document.createElement('div');
              err.className = 'ms-layer-error';
              err.textContent = layer.errorMsg || tx('maskingStudio.statusFailed', 'Failed');
              body.appendChild(err);
              const retry = document.createElement('button');
              retry.type = 'button';
              retry.className = 'ms-layer-retry';
              retry.textContent = tx('maskingStudio.retry', 'Retry');
              retry.addEventListener('click', () => retryLayer(layer.id));
              body.appendChild(retry);
            } else if (layer.status === 'done' && state.phase === 'review') {
              // Version picker: flip between every generated result of this area.
              if (layer.candidates.length > 1) {
                const row = document.createElement('div');
                row.className = 'ms-version-row';
                const prev = document.createElement('button');
                prev.type = 'button';
                prev.className = 'ms-version-btn';
                prev.textContent = '‹';
                prev.setAttribute('aria-label', tx('maskingStudio.versionPrev', 'Previous version'));
                prev.addEventListener('click', () => selectCandidate(layer, layer.candIdx - 1));
                const label = document.createElement('span');
                label.className = 'ms-version-label';
                label.textContent = tx('maskingStudio.versionLabel', 'Version {i} of {n}')
                  .replace('{i}', String(layer.candIdx + 1))
                  .replace('{n}', String(layer.candidates.length));
                const next = document.createElement('button');
                next.type = 'button';
                next.className = 'ms-version-btn';
                next.textContent = '›';
                next.setAttribute('aria-label', tx('maskingStudio.versionNext', 'Next version'));
                next.addEventListener('click', () => selectCandidate(layer, layer.candIdx + 1));
                row.appendChild(prev);
                row.appendChild(label);
                row.appendChild(next);
                body.appendChild(row);
              }
              const retry = document.createElement('button');
              retry.type = 'button';
              retry.className = 'ms-layer-retry';
              retry.style.borderColor = '#2563eb';
              retry.style.color = '#2563eb';
              retry.textContent = tx('maskingStudio.tryAnother', 'Try another version');
              retry.addEventListener('click', () => retryLayer(layer.id));
              body.appendChild(retry);
            }

            card.appendChild(head);
            card.appendChild(body);
            layer.el = card;
            layerList.appendChild(card);
          });
          renderChips();
        }

        // Compact quick-switch chips above the canvas mirroring the layer list,
        // so switching colors doesn't require leaving the photo.
        function renderChips() {
          chipbar.textContent = '';
          state.layers.forEach((layer) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'ms-chip' + (layer.id === state.activeId ? ' is-active' : '');
            chip.style.setProperty('--layer-color', layerColor(layer));
            const dot = document.createElement('span');
            dot.className = 'ms-layer-dot';
            dot.style.background = layerColor(layer);
            const label = document.createElement('span');
            label.textContent = layerTitle(layer);
            chip.appendChild(dot);
            chip.appendChild(label);
            chip.addEventListener('click', () => {
              if (state.phase === 'generating') return;
              state.activeId = layer.id;
              renderLayers();
            });
            chipbar.appendChild(chip);
          });
          if (state.base && state.layers.length < MAX_LAYERS) {
            const add = document.createElement('button');
            add.type = 'button';
            add.className = 'ms-chip ms-chip--add';
            add.textContent = tx('maskingStudio.addArea', '+ Add area');
            add.addEventListener('click', () => {
              if (state.phase === 'generating') return;
              addLayer();
            });
            chipbar.appendChild(add);
          }
          updateChipbarVisibility();
        }

        function updateChipbarVisibility() {
          const visible = !!state.base && state.phase !== 'empty' && !(state.phase === 'review' && state.view !== 'before');
          chipbar.classList.toggle('hidden', !visible);
        }

        // ---------------------------------------------------------------------
        // Furniture reference photos (per area)
        // ---------------------------------------------------------------------
        // Validate, downscale (max 1536px) and PNG-encode — identical rules to
        // the single-mask editor so the backend sees the same payloads.
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
          return err && err.message === 'size'
            ? tx('pdf.maskEditor.referenceTooLarge', 'That image is too large — please choose one under 25 MB.')
            : tx('pdf.maskEditor.referenceInvalid', 'Please choose a valid JPG, PNG, or WebP image.');
        }

        function acceptFurnitureFile(layer, file, announce) {
          if (!layer || !file) return;
          const fileName = file.name || '';
          const prep = (window.StagifyHeic && window.StagifyHeic.isHeic(file))
            ? window.StagifyHeic.toDisplayableFile(file)
            : Promise.resolve(file);
          prep
            .then(prepareReferenceFile)
            .then((dataUrl) => {
              layer.furniture = dataUrl;
              layer.furnitureName = fileName;
              renderLayers();
              updateControls();
              scheduleSessionSave();
              if (announce && getLayer(layer.id)) {
                const t = tx('maskingStudio.furniturePasted', 'Furniture photo added to {area}');
                showToast(t.replace('{area}', layerTitle(layer)), 'success');
              }
            })
            .catch((err) => showToast(refErrorMessage(err), 'error'));
        }

        function wireFurnitureDrop(zone, layer) {
          const hasFiles = (e) =>
            !!e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1;
          zone.addEventListener('dragenter', (e) => { if (hasFiles(e)) { e.preventDefault(); zone.classList.add('is-drag-over'); } });
          zone.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; } });
          zone.addEventListener('dragleave', () => zone.classList.remove('is-drag-over'));
          zone.addEventListener('drop', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            zone.classList.remove('is-drag-over');
            acceptFurnitureFile(layer, e.dataTransfer.files && e.dataTransfer.files[0]);
          });
        }

        furnitureInput.addEventListener('change', () => {
          const file = furnitureInput.files && furnitureInput.files[0];
          furnitureInput.value = '';
          acceptFurnitureFile(getLayer(pendingFurnitureLayerId), file);
          pendingFurnitureLayerId = null;
        });

        // Paste an image from the clipboard: before a photo is loaded it becomes
        // the room photo; afterwards it becomes the active area's furniture.
        document.addEventListener('paste', (e) => {
          if (state.phase === 'generating') return;
          const t = e.target;
          if (t && t.closest && t.closest('input, textarea, [contenteditable]')) return;
          const files = (e.clipboardData && e.clipboardData.files) || [];
          const file = Array.prototype.find.call(files, (f) => /^image\//i.test(f.type || ''));
          if (!file) return;
          e.preventDefault();
          if (!state.base) {
            handleRoomFile(file);
            return;
          }
          if (state.phase === 'draw') acceptFurnitureFile(activeLayer(), file, true);
        });

        // Keep Tab focus inside whichever dialog is open (help, resume,
        // discard-confirm, or the pro gate — they share the overlay class).
        document.addEventListener('keydown', (e) => {
          if (e.key !== 'Tab') return;
          const card = document.querySelector('.ms-pro-gate.active .ms-pro-gate__card');
          if (!card) return;
          const focusables = card.querySelectorAll('button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])');
          if (!focusables.length) return;
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
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

        // ---------------------------------------------------------------------
        // Zoom & pan. Zoom works by setting an explicit CSS width on the base
        // canvas (the overlay canvases are inset:0/100%, so they follow), which
        // keeps all pointer math valid: it already reads getBoundingClientRect.
        // ---------------------------------------------------------------------
        const ZOOM_MIN = 1;
        const ZOOM_MAX = 4;

        function setZoom(nz, focal) {
          if (!state.base) return;
          nz = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nz));
          const rect = baseCanvas.getBoundingClientRect();
          if (!rect.width) return;
          const fitW = rect.width / state.zoom; // current width always equals fit × zoom
          const prev = state.zoom;
          state.zoom = nz;
          if (state.zoom === 1) {
            baseCanvas.style.width = '';
            baseCanvas.style.maxWidth = '';
            baseCanvas.style.maxHeight = '';
          } else {
            baseCanvas.style.width = (fitW * state.zoom) + 'px';
            baseCanvas.style.maxWidth = 'none';
            baseCanvas.style.maxHeight = 'none';
          }
          viewerEl.classList.toggle('is-zoomed', state.zoom > 1);
          // Keep the focal point (viewport coords) stationary while scaling.
          if (focal && prev !== state.zoom) {
            const vr = viewerEl.getBoundingClientRect();
            const ratio = state.zoom / prev;
            viewerEl.scrollLeft = (viewerEl.scrollLeft + (focal.x - vr.left)) * ratio - (focal.x - vr.left);
            viewerEl.scrollTop = (viewerEl.scrollTop + (focal.y - vr.top)) * ratio - (focal.y - vr.top);
          }
        }

        function resetZoom() {
          state.zoom = 1;
          baseCanvas.style.width = '';
          baseCanvas.style.maxWidth = '';
          baseCanvas.style.maxHeight = '';
          viewerEl.classList.remove('is-zoomed');
        }

        viewerEl.addEventListener('wheel', (e) => {
          if (!state.base || !e.ctrlKey) return; // plain scroll stays plain scroll
          e.preventDefault();
          setZoom(state.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), { x: e.clientX, y: e.clientY });
        }, { passive: false });

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
          const t = e.target;
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

        // ---------------------------------------------------------------------
        // Phases & viewer
        // ---------------------------------------------------------------------
        function setPhase(p) {
          state.phase = p;
          const inReview = p === 'review';
          // "Edit highlights" must not strand the user away from their results:
          // in the draw phase, existing results stay reachable via "View result".
          const hasResults = state.layers.some((l) => l.status === 'done' && l.editedImg);
          viewToggle.classList.toggle('hidden', !inReview);
          // The header only ever holds the view toggle and the review actions;
          // collapse it entirely when neither shows so the photo sits higher.
          viewerHeader.classList.toggle('hidden', !(inReview || (p === 'draw' && hasResults)));
          viewerActions.classList.toggle('hidden', !(inReview || (p === 'draw' && hasResults)));
          editHighlightsBtn.classList.toggle('hidden', !inReview);
          viewResultBtn.classList.toggle('hidden', !(p === 'draw' && hasResults));
          downloadBtn.classList.toggle('hidden', !inReview);
          stack.classList.toggle('can-draw', p === 'draw');
          stack.classList.toggle('is-busy', p === 'generating');
          if (p !== 'draw') hideCursor();
          if (busyOverlay) busyOverlay.classList.toggle('hidden', p !== 'generating');
          if (p === 'generating') startBusyMessages(); else stopBusyMessages();
          updateStageBackdrop();
          if (inReview) {
            setView(state.view);
          } else {
            resultCanvas.classList.add('hidden');
            resultCanvas.style.clipPath = '';
            state.layers.forEach((l) => l.canvasEl.classList.remove('hidden'));
            compareEl.classList.add('hidden');
            compareLabelBefore.classList.add('hidden');
            compareLabelAfter.classList.add('hidden');
            stack.classList.remove('is-compare');
            state.comparing = false;
          }
          renderLayers();
          updateControls();
        }

        function setView(v) {
          state.view = v === 'before' ? 'before' : v === 'compare' ? 'compare' : 'after';
          toggleBeforeBtn.classList.toggle('active', state.view === 'before');
          toggleCompareBtn.classList.toggle('active', state.view === 'compare');
          toggleAfterBtn.classList.toggle('active', state.view === 'after');
          const inReview = state.phase === 'review';
          const showResult = inReview && state.view !== 'before';
          resultCanvas.classList.toggle('hidden', !showResult);
          state.layers.forEach((l) => l.canvasEl.classList.toggle('hidden', showResult));
          const compareOn = inReview && state.view === 'compare';
          compareEl.classList.toggle('hidden', !compareOn);
          compareLabelBefore.classList.toggle('hidden', !compareOn);
          compareLabelAfter.classList.toggle('hidden', !compareOn);
          stack.classList.toggle('is-compare', compareOn);
          if (compareOn) {
            setComparePos(comparePos);
          } else {
            state.comparing = false;
            resultCanvas.style.clipPath = '';
          }
          updateChipbarVisibility();
        }
        toggleBeforeBtn.addEventListener('click', () => setView('before'));
        toggleCompareBtn.addEventListener('click', () => setView('compare'));
        toggleAfterBtn.addEventListener('click', () => setView('after'));

        // The result canvas sits on top of the original: clipping its left side
        // at the divider shows Before on the left, After on the right.
        function setComparePos(f) {
          comparePos = Math.min(1, Math.max(0, f));
          const pct = (comparePos * 100).toFixed(2) + '%';
          compareEl.style.left = pct;
          resultCanvas.style.clipPath = 'inset(0 0 0 ' + pct + ')';
          compareGrip.setAttribute('aria-valuenow', String(Math.round(comparePos * 100)));
        }

        function moveCompare(e) {
          const rect = baseCanvas.getBoundingClientRect();
          if (!rect.width) return;
          setComparePos((e.clientX - rect.left) / rect.width);
        }

        compareGrip.addEventListener('keydown', (e) => {
          const step = 0.03;
          if (e.key === 'ArrowLeft') { e.preventDefault(); setComparePos(comparePos - step); }
          else if (e.key === 'ArrowRight') { e.preventDefault(); setComparePos(comparePos + step); }
          else if (e.key === 'Home') { e.preventDefault(); setComparePos(0); }
          else if (e.key === 'End') { e.preventDefault(); setComparePos(1); }
        });

        function ensureBusyOverlay() {
          if (busyOverlay) return;
          busyOverlay = document.createElement('div');
          busyOverlay.className = 'ms-busy-overlay hidden';
          const spin = document.createElement('div');
          spin.className = 'ms-busy-spin';
          const dots = document.createElement('div');
          dots.className = 'ms-busy-dots';
          const msg = document.createElement('div');
          msg.className = 'ms-busy-msg';
          busyOverlay.appendChild(spin);
          busyOverlay.appendChild(dots);
          busyOverlay.appendChild(msg);
          stack.appendChild(busyOverlay);
        }

        // One dot per running area, in its highlight color: pulsing while it
        // stages, a check when done, an exclamation mark if it failed.
        function renderBusyDots(participating) {
          ensureBusyOverlay();
          const host = busyOverlay.querySelector('.ms-busy-dots');
          host.textContent = '';
          participating.forEach((l) => {
            const d = document.createElement('span');
            d.className = 'ms-busy-dot' + (l.status === 'generating' ? ' ms-busy-dot--running' : '');
            d.style.background = l.status === 'failed' ? '#b91c1c' : layerColor(l);
            d.textContent = l.status === 'done' ? '✓' : l.status === 'failed' ? '!' : '';
            d.title = layerTitle(l);
            host.appendChild(d);
          });
        }

        function loadingMessages() {
          const fromLang = window.LanguageSystem && window.LanguageSystem.getText('maskingStudio.loadingMessages');
          if (Array.isArray(fromLang) && fromLang.length) return fromLang;
          return [
            'Placing your furniture…',
            'Matching light and shadows…',
            'Blending each area in…',
            'Keeping the rest of the photo untouched…',
            'Adding finishing touches…',
          ];
        }

        function startBusyMessages() {
          ensureBusyOverlay();
          busyOverlay.classList.remove('hidden');
          const msgEl = busyOverlay.querySelector('.ms-busy-msg');
          const msgs = loadingMessages();
          let i = 0;
          msgEl.textContent = msgs[0];
          if (busyMsgTimer) clearInterval(busyMsgTimer);
          busyMsgTimer = setInterval(() => {
            i = (i + 1) % msgs.length;
            msgEl.textContent = msgs[i];
          }, 2200);
        }

        function stopBusyMessages() {
          if (busyMsgTimer) { clearInterval(busyMsgTimer); busyMsgTimer = null; }
          if (busyOverlay) busyOverlay.classList.add('hidden');
        }

        function updateControls() {
          const generating = state.phase === 'generating';
          addLayerBtn.disabled = !state.base || generating || state.layers.length >= MAX_LAYERS;
          replaceBtn.disabled = generating;
          brushSlider.disabled = generating;
          brushBtn.disabled = generating;
          eraseBtn.disabled = generating;
          rectBtn.disabled = generating;
          wandBtn.disabled = generating;
          undoBtn.disabled = generating || state.phase !== 'draw' || !state.undoStack.length;
          redoBtn.disabled = generating || state.phase !== 'draw' || !state.redoStack.length;
          editHighlightsBtn.disabled = generating;
          downloadBtn.disabled = generating || !state.layers.some((l) => l.status === 'done');
          layerList.querySelectorAll('textarea, button').forEach((el) => { el.disabled = generating; });

          const painted = state.layers.filter((l) => l.painted);
          const allDetailed = painted.length > 0 && painted.every((l) => l.mode === 'remove' || l.prompt.trim() || l.furniture);
          generateBtn.disabled = !state.base || generating || !allDetailed;

          // Explain a disabled Apply Edit instead of leaving it a mystery.
          let hint = '';
          if (!generating) {
            if (!state.base) hint = tx('errors.uploadFirst', 'Please upload an image first');
            else if (!painted.length) hint = tx('maskingStudio.needHighlight', 'Paint at least one area on the photo first.');
            else if (!allDetailed) hint = tx('maskingStudio.needPromptOrFurniture', 'Each highlighted area needs a short prompt or a furniture photo.');
          }
          ctaHint.textContent = hint;
          ctaHint.classList.toggle('hidden', !hint);
        }

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


        // ---------------------------------------------------------------------
        // Upload wiring (dropzone click/keyboard/drop + toolbar replace)
        // ---------------------------------------------------------------------
        dropzone.addEventListener('click', () => fileInput.click());
        dropzone.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInput.click();
          }
        });
        replaceBtn.addEventListener('click', () => {
          if (state.phase === 'generating') return;
          requestDiscard(() => fileInput.click());
        });
        fileInput.addEventListener('change', () => {
          const file = fileInput.files && fileInput.files[0];
          fileInput.value = '';
          handleRoomFile(file);
        });
        (function wireRoomDrop() {
          const hasFiles = (e) =>
            !!e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1;
          [dropzone, stack].forEach((zone) => {
            zone.addEventListener('dragover', (e) => {
              if (!hasFiles(e)) return;
              e.preventDefault();
              if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
              if (zone === dropzone) dropzone.classList.add('is-drag-over');
            });
            zone.addEventListener('dragleave', () => dropzone.classList.remove('is-drag-over'));
            zone.addEventListener('drop', (e) => {
              if (!hasFiles(e)) return;
              e.preventDefault();
              dropzone.classList.remove('is-drag-over');
              if (state.phase === 'generating') return;
              const file = e.dataTransfer.files && e.dataTransfer.files[0];
              // Dropping on the photo itself is easy to do by accident when
              // aiming for the furniture button, so also guard unstaged work.
              requestDiscard(() => handleRoomFile(file), zone === stack);
            });
          });
        })();

        helpBtn.addEventListener('click', () => setHelpOpen(true));
        helpCloseBtn.addEventListener('click', () => setHelpOpen(false));
        helpDoneBtn.addEventListener('click', () => setHelpOpen(false));
        helpEl.addEventListener('click', (e) => {
          if (e.target === helpEl) setHelpOpen(false);
        });

        addLayerBtn.addEventListener('click', () => {
          if (state.layers.length >= MAX_LAYERS) {
            const t = tx('maskingStudio.areaLimit', 'You can highlight up to {n} areas.');
            showToast(t.replace('{n}', String(MAX_LAYERS)));
            return;
          }
          addLayer();
        });

        // Re-render translated card copy when the language changes.
        window.addEventListener('languagechange', () => {
          renderLayers();
          updateControls();
        });

        // ---------------------------------------------------------------------
        // Islands (scripts/masking-studio/*): each factory receives the shared
        // state store plus entry glue; APIs are destructured into same-named
        // consts so the call sites above stay unchanged.
        // ---------------------------------------------------------------------
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
