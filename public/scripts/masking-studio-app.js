      (function () {
        'use strict';

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

        // Shared mask math (growBinaryMask/buildModelMask/buildBlendMask/
        // compositeMaskedEditCanvas) — same module the main tool and the AI
        // Designer use, so the pixel-preservation guarantee is identical.
        let growBinaryMask, buildModelMask, buildBlendMask, compositeMaskedEditCanvas;
        const maskCoreReady = import('/scripts/mask-core.js').then((m) => {
          growBinaryMask = m.growBinaryMask;
          buildModelMask = m.buildModelMask;
          buildBlendMask = m.buildBlendMask;
          compositeMaskedEditCanvas = m.compositeMaskedEditCanvas;
        });

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

        let base = null;          // { w, h, canvas } — working-resolution room photo
        let layers = [];          // area objects, in z-order
        let activeId = null;      // selected area (receives brush strokes)
        let phase = 'empty';      // 'empty' | 'draw' | 'generating' | 'review'
        let view = 'after';       // review-phase viewer toggle
        let tool = 'brush';
        let brushSize = 50;
        let layerSeq = 0;
        let genRun = 0;           // ignore async completions from stale runs
        let genMeta = null;       // { coreGrow, featherPx } of the last run
        let busyMsgTimer = null;
        let undoStack = [];       // pre-stroke canvas snapshots (LIFO, capped)
        let redoStack = [];       // undone states, restored by Ctrl+Y (same cap)
        let segCache = null;      // decoded all-object masks for wand hit-testing
        let segToken = 0;         // bumped on photo change → drops in-flight results
        let segBusy = false;      // one segmentation request at a time
        let comparePos = 0.5;     // compare-view divider, 0..1 of photo width
        let comparing = false;    // dragging the compare divider
        let zoom = 1;             // 1 = fit to view, up to 4x
        let spaceDown = false;    // Space held → pan mode
        let panning = false;
        let panStart = null;      // { x, y, sl, st } at pan pointerdown

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
          base = { w: w, h: h, canvas: c };

          baseCanvas.width = w;
          baseCanvas.height = h;
          baseCanvas.getContext('2d').drawImage(c, 0, 0);
          resultCanvas.width = w;
          resultCanvas.height = h;

          // Fresh session for the new photo.
          layers.forEach((l) => l.el && l.canvasEl && l.canvasEl.remove());
          layers = [];
          layerSeq = 0;
          genRun++;
          genMeta = null;
          undoStack = [];
          redoStack = [];
          segCache = null;
          segToken++;
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
        function nextColorIdx() {
          for (let i = 0; i < PALETTE.length; i++) {
            if (!layers.some((l) => l.colorIdx === i)) return i;
          }
          return -1;
        }

        function addLayer() {
          if (!base || layers.length >= MAX_LAYERS) return;
          const colorIdx = nextColorIdx();
          if (colorIdx === -1) return;
          const c = document.createElement('canvas');
          c.width = base.w;
          c.height = base.h;
          c.className = 'ms-layer-canvas';
          // Insert below the result canvas so results always cover highlights.
          stack.insertBefore(c, resultCanvas);
          const layer = {
            id: 'L' + (++layerSeq),
            colorIdx: colorIdx,
            canvasEl: c,
            painted: false,
            name: '',            // user-given name; empty → "Area {n}"
            prompt: '',
            mode: 'stage',       // 'stage' adds furniture; 'remove' clears the area
            presetsOpen: false,  // prompt-idea chips revealed via the + button
            furniture: null,
            furnitureName: '',   // original file name, shown in the header peek
            status: 'idle',      // idle | generating | done | failed
            editedImg: null,     // the selected candidate (what compositeAll uses)
            candidates: [],      // every generated version of this area (capped)
            candIdx: 0,
            blendMask: null,
            errorMsg: '',
            el: null,
          };
          layers.push(layer);
          activeId = layer.id;
          renderLayers();
          updateControls();
          scheduleSessionSave();
        }

        function removeLayer(id) {
          const idx = layers.findIndex((l) => l.id === id);
          if (idx === -1) return;
          const layer = layers[idx];
          if (layer.canvasEl) layer.canvasEl.remove();
          layers.splice(idx, 1);
          if (activeId === id) activeId = layers.length ? layers[layers.length - 1].id : null;
          if (!layers.length && base) addLayer();
          if (phase === 'review') compositeAll();
          // Re-derive the whole phase UI: in refine, removing an area must
          // refresh the ghost backdrop and may retire the Looks Good button
          // (when the last staged area went away).
          setPhase(phase);
          scheduleSessionSave();
        }

        function getLayer(id) {
          return layers.find((l) => l.id === id) || null;
        }

        function activeLayer() {
          return getLayer(activeId);
        }

        function layerColor(layer) {
          return PALETTE[layer.colorIdx].hex;
        }

        function layerTitle(layer) {
          if (layer.name) return layer.name;
          const template = tx('maskingStudio.areaName', 'Area {n}');
          const n = layers.indexOf(layer) + 1;
          return template.replace('{n}', String(n));
        }

        function statusChip(layer) {
          if (layer.status === 'generating') return { cls: 'ms-layer-status--generating', text: tx('maskingStudio.statusGenerating', 'Staging…') };
          if (layer.status === 'done') return { cls: 'ms-layer-status--done', text: tx('maskingStudio.statusDone', 'Done') };
          if (layer.status === 'failed') return { cls: 'ms-layer-status--failed', text: tx('maskingStudio.statusFailed', 'Failed') };
          if (!layer.painted) return { cls: '', text: tx('maskingStudio.statusEmpty', 'Not highlighted yet') };
          if (layer.mode === 'remove' || layer.prompt.trim() || layer.furniture) return { cls: 'ms-layer-status--ready', text: tx('maskingStudio.statusReady', 'Ready') };
          return { cls: '', text: tx('maskingStudio.statusNeedsDetails', 'Needs a prompt or photo') };
        }

        // Rebuild the layer cards. Prompt edits mutate state directly (no
        // re-render on keystroke), so rebuilding here never loses typed text.
        // Only the active card shows its full body — inactive areas collapse
        // to their header row so six areas don't make the toolbar a tower.
        function renderLayers() {
          layerList.textContent = '';
          layers.forEach((layer) => {
            const isActive = layer.id === activeId;
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
              if (phase === 'generating') return;
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
            const previewFallback = () => {
              if (layer.prompt.trim()) return layer.prompt.trim();
              if (layer.mode === 'remove') return tx('maskingStudio.modeRemove', 'Remove object');
              return layer.furniture ? (layer.furnitureName || '') : '';
            };
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
              if (phase === 'generating') return;
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
              if (phase === 'generating') return;
              activeId = layer.id;
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
                if (phase === 'generating' || layer.mode === val) return;
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
              if (activeId !== layer.id && phase !== 'generating') {
                activeId = layer.id;
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
                  if (phase === 'generating') return;
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
                    if (phase === 'generating') return;
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
                if (phase === 'generating') return;
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
                if (phase === 'generating') return;
                pendingFurnitureLayerId = layer.id;
                furnitureInput.click();
              });
              wireFurnitureDrop(add, layer);
              body.appendChild(add);
            }

            // Quick way to clear one area's strokes (undoable via Ctrl+Z).
            if (layer.painted && phase === 'draw') {
              const clearBtn = document.createElement('button');
              clearBtn.type = 'button';
              clearBtn.className = 'ms-clear-btn';
              clearBtn.textContent = tx('maskingStudio.clearHighlight', 'Clear highlight');
              clearBtn.addEventListener('click', () => {
                if (phase !== 'draw') return;
                snapshotForUndo();
                redoStack = []; // committed clear forks history
                layer.canvasEl.getContext('2d').clearRect(0, 0, base.w, base.h);
                layer.painted = false;
                // All masks, not just this one: neighbors' halos are clipped
                // against this area's (now vacated) pixels.
                layers.forEach((l) => { l.blendMask = null; });
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
            } else if (layer.status === 'done' && phase === 'review') {
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
          layers.forEach((layer) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'ms-chip' + (layer.id === activeId ? ' is-active' : '');
            chip.style.setProperty('--layer-color', layerColor(layer));
            const dot = document.createElement('span');
            dot.className = 'ms-layer-dot';
            dot.style.background = layerColor(layer);
            const label = document.createElement('span');
            label.textContent = layerTitle(layer);
            chip.appendChild(dot);
            chip.appendChild(label);
            chip.addEventListener('click', () => {
              if (phase === 'generating') return;
              activeId = layer.id;
              renderLayers();
            });
            chipbar.appendChild(chip);
          });
          if (base && layers.length < MAX_LAYERS) {
            const add = document.createElement('button');
            add.type = 'button';
            add.className = 'ms-chip ms-chip--add';
            add.textContent = tx('maskingStudio.addArea', '+ Add area');
            add.addEventListener('click', () => {
              if (phase === 'generating') return;
              addLayer();
            });
            chipbar.appendChild(add);
          }
          updateChipbarVisibility();
        }

        function updateChipbarVisibility() {
          const visible = !!base && phase !== 'empty' && !(phase === 'review' && view !== 'before');
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
          if (phase === 'generating') return;
          const t = e.target;
          if (t && t.closest && t.closest('input, textarea, [contenteditable]')) return;
          const files = (e.clipboardData && e.clipboardData.files) || [];
          const file = Array.prototype.find.call(files, (f) => /^image\//i.test(f.type || ''));
          if (!file) return;
          e.preventDefault();
          if (!base) {
            handleRoomFile(file);
            return;
          }
          if (phase === 'draw') acceptFurnitureFile(activeLayer(), file, true);
        });

        // ---------------------------------------------------------------------
        // Session persistence: the photo, strokes, prompts, and furniture refs
        // are saved to IndexedDB (debounced) so a crash or closed tab doesn't
        // lose the work. Generated results are deliberately not persisted —
        // restore returns to the draw phase with everything ready to re-run.
        // All storage calls fail silently (private mode, quota, old browsers).
        // ---------------------------------------------------------------------
        let idbPromise = null;
        let saveTimer = null;
        let restoring = false; // block saves while a restore is rebuilding state
        let saveSeq = 0;       // bumped on clear so in-flight saves abort

        function idb() {
          if (!idbPromise) {
            idbPromise = new Promise((resolve) => {
              try {
                const req = indexedDB.open('stagify-masking-studio', 1);
                req.onupgradeneeded = () => { req.result.createObjectStore('session'); };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => resolve(null);
              } catch (e) { resolve(null); }
            });
          }
          return idbPromise;
        }

        function idbOp(mode, fn) {
          return idb().then((db) => new Promise((resolve) => {
            if (!db) { resolve(null); return; }
            try {
              const tr = db.transaction('session', mode);
              const out = fn(tr.objectStore('session'));
              tr.oncomplete = () => resolve(out && 'result' in out ? out.result : null);
              tr.onerror = () => resolve(null);
            } catch (e) { resolve(null); }
          }));
        }

        const sessionSave = (value) => idbOp('readwrite', (s) => s.put(value, 'current'));
        const sessionLoad = () => idbOp('readonly', (s) => s.get('current'));
        const sessionClear = () => idbOp('readwrite', (s) => s.delete('current'));

        function toBlob(canvas, type, q) {
          return new Promise((resolve) => {
            try { canvas.toBlob(resolve, type, q); } catch (e) { resolve(null); }
          });
        }

        function scheduleSessionSave() {
          if (!base || restoring) return;
          if (saveTimer) clearTimeout(saveTimer);
          saveTimer = setTimeout(saveSessionNow, 1500);
        }

        async function saveSessionNow() {
          if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
          if (!base || restoring) return;
          if (phase === 'generating') {
            // Don't drop edits made just before Apply Edit — retry after the run.
            scheduleSessionSave();
            return;
          }
          const seq = saveSeq;
          try {
            const baseBlob = await toBlob(base.canvas, 'image/jpeg', 0.9);
            if (!baseBlob) return;
            const layerData = [];
            for (const l of layers) {
              layerData.push({
                colorIdx: l.colorIdx,
                name: l.name,
                prompt: l.prompt,
                mode: l.mode,
                furniture: l.furniture,
                furnitureName: l.furnitureName,
                painted: l.painted,
                mask: l.painted ? await toBlob(l.canvasEl, 'image/png') : null,
              });
            }
            // A clear/reset while we were encoding wins — never resurrect a
            // session the user just discarded.
            if (seq !== saveSeq) return;
            await sessionSave({ savedAt: Date.now(), baseBlob: baseBlob, layers: layerData });
          } catch (e) {}
        }

        function clearStoredSession() {
          saveSeq++;
          if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
          sessionClear();
        }

        function blobToImage(blob) {
          return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(blob);
            const im = new Image();
            im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
            im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
            im.src = url;
          });
        }

        async function restoreSession(saved) {
          // A half-finished restore must never overwrite the stored session
          // (the debounced save could fire while masks are still decoding).
          restoring = true;
          try {
            await restoreSessionInner(saved);
          } finally {
            restoring = false;
          }
          scheduleSessionSave();
        }

        async function restoreSessionInner(saved) {
          const img = await blobToImage(saved.baseBlob);
          setBaseImage(img, { noLayer: true });
          for (const ld of saved.layers || []) {
            if (layers.length >= MAX_LAYERS) break;
            const c = document.createElement('canvas');
            c.width = base.w;
            c.height = base.h;
            c.className = 'ms-layer-canvas';
            stack.insertBefore(c, resultCanvas);
            let painted = false;
            if (ld.mask) {
              try {
                const maskImg = await blobToImage(ld.mask);
                c.getContext('2d').drawImage(maskImg, 0, 0, base.w, base.h);
                painted = true;
              } catch (e) {}
            }
            layers.push({
              id: 'L' + (++layerSeq),
              colorIdx: Math.min(PALETTE.length - 1, Math.max(0, ld.colorIdx || 0)),
              canvasEl: c,
              painted: painted,
              name: ld.name || '',
              prompt: ld.prompt || '',
              mode: ld.mode === 'remove' ? 'remove' : 'stage',
              presetsOpen: false,
              furniture: ld.furniture || null,
              furnitureName: ld.furnitureName || '',
              status: 'idle',
              editedImg: null,
              candidates: [],
              candIdx: 0,
              blendMask: null,
              errorMsg: '',
              el: null,
            });
          }
          if (!layers.length) addLayer();
          activeId = layers[0].id;
          renderLayers();
          updateControls();
        }

        // Returns true if the resume dialog was shown (suppresses first-visit help).
        async function maybeOfferResume() {
          let saved = null;
          try { saved = await sessionLoad(); } catch (e) {}
          if (!saved || !saved.baseBlob || base) return false;
          resumeEl.classList.add('active');
          resumeYesBtn.focus();
          resumeYesBtn.addEventListener('click', async () => {
            resumeEl.classList.remove('active');
            try {
              await restoreSession(saved);
            } catch (e) {
              showToast(tx('errors.processingFailed', 'Something went wrong. Please try again.'), 'error');
              sessionClear();
            }
          }, { once: true });
          resumeNoBtn.addEventListener('click', () => {
            resumeEl.classList.remove('active');
            clearStoredSession();
          }, { once: true });
          return true;
        }

        // Flush the pending save when the tab goes to the background.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'hidden' && saveTimer) saveSessionNow();
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
          if (!base) return;
          nz = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nz));
          const rect = baseCanvas.getBoundingClientRect();
          if (!rect.width) return;
          const fitW = rect.width / zoom; // current width always equals fit × zoom
          const prev = zoom;
          zoom = nz;
          if (zoom === 1) {
            baseCanvas.style.width = '';
            baseCanvas.style.maxWidth = '';
            baseCanvas.style.maxHeight = '';
          } else {
            baseCanvas.style.width = (fitW * zoom) + 'px';
            baseCanvas.style.maxWidth = 'none';
            baseCanvas.style.maxHeight = 'none';
          }
          viewerEl.classList.toggle('is-zoomed', zoom > 1);
          // Keep the focal point (viewport coords) stationary while scaling.
          if (focal && prev !== zoom) {
            const vr = viewerEl.getBoundingClientRect();
            const ratio = zoom / prev;
            viewerEl.scrollLeft = (viewerEl.scrollLeft + (focal.x - vr.left)) * ratio - (focal.x - vr.left);
            viewerEl.scrollTop = (viewerEl.scrollTop + (focal.y - vr.top)) * ratio - (focal.y - vr.top);
          }
        }

        function resetZoom() {
          zoom = 1;
          baseCanvas.style.width = '';
          baseCanvas.style.maxWidth = '';
          baseCanvas.style.maxHeight = '';
          viewerEl.classList.remove('is-zoomed');
        }

        viewerEl.addEventListener('wheel', (e) => {
          if (!base || !e.ctrlKey) return; // plain scroll stays plain scroll
          e.preventDefault();
          setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), { x: e.clientX, y: e.clientY });
        }, { passive: false });

        // ---------------------------------------------------------------------
        // Discard confirmation: replacing the photo (or starting over) wipes
        // highlights and staged results, so ask first when results exist.
        // ---------------------------------------------------------------------
        let pendingConfirmAction = null;

        function hasAnyResults() {
          return layers.some((l) => l.status === 'done' && l.editedImg);
        }

        // strict also protects unstaged work (strokes/prompts/furniture) — used
        // for accident-prone paths like dropping a file onto the photo itself.
        function requestDiscard(action, strict) {
          const hasWork = strict && layers.some((l) => l.painted || l.prompt.trim() || l.furniture);
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

        // ---------------------------------------------------------------------
        // Drawing
        // ---------------------------------------------------------------------
        let drawing = false;
        let lastX = null;
        let lastY = null;

        // Drawing is only allowed in the draw phase: review keeps the strokes
        // frozen so they still match the composited results ("Edit highlights"
        // returns to the draw phase).
        function canDraw() {
          return base && phase === 'draw' && activeLayer();
        }

        function canvasPoint(e) {
          const rect = baseCanvas.getBoundingClientRect();
          if (!rect.width || !rect.height) return null;
          return {
            x: (e.clientX - rect.left) * (base.w / rect.width),
            y: (e.clientY - rect.top) * (base.h / rect.height),
          };
        }

        // Apply one stroke segment to a canvas context (dot for taps, line for
        // moves). Solid pixels; the translucent look comes from CSS opacity.
        function strokeSegment(ctx, x, y, composite, color) {
          ctx.globalCompositeOperation = composite;
          ctx.strokeStyle = color;
          ctx.fillStyle = color;
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
        }

        function paint(e) {
          if (!drawing || !canDraw()) return;
          const p = canvasPoint(e);
          if (!p) return;
          const layer = activeLayer();
          const color = layerColor(layer);
          if (tool === 'erase') {
            strokeSegment(layer.canvasEl.getContext('2d'), p.x, p.y, 'destination-out', color);
          } else {
            strokeSegment(layer.canvasEl.getContext('2d'), p.x, p.y, 'source-over', color);
            // Claim these pixels: erase the same stroke from every other area so
            // masks never overlap — each spot belongs to exactly one area.
            layers.forEach((other) => {
              if (other !== layer) {
                strokeSegment(other.canvasEl.getContext('2d'), p.x, p.y, 'destination-out', color);
              }
            });
            if (!layer.painted) {
              layer.painted = true;
              updateControls();
            }
          }
          lastX = p.x;
          lastY = p.y;
        }

        // Downsampled alpha scan: reading a 256px-wide sample instead of the
        // full canvas is ~50x less data per stroke-end. drawImage's area
        // averaging keeps even a minimum-size brush dot well above threshold.
        const scanScratch = document.createElement('canvas');
        function scanHasContent(canvas) {
          const sw = Math.min(256, canvas.width);
          const sh = Math.max(1, Math.round(canvas.height * (sw / canvas.width)));
          scanScratch.width = sw;  // resizing also clears the scratch canvas
          scanScratch.height = sh;
          const sctx = scanScratch.getContext('2d', { willReadFrequently: true });
          sctx.drawImage(canvas, 0, 0, sw, sh);
          const d = sctx.getImageData(0, 0, sw, sh).data;
          for (let i = 3; i < d.length; i += 4) {
            if (d[i] > 8) return true;
          }
          return false;
        }

        // One snapshot per stroke, taken at pointerdown. A brush stroke can only
        // touch the active layer and layers that already have paint (pixel
        // claiming is a no-op on empty canvases), so that's all we store.
        // Snapshots are canvas-to-canvas copies: unlike getImageData they don't
        // force a GPU readback, so starting a stroke stays stutter-free.
        const UNDO_LIMIT = 5;
        function snapshotForUndo() {
          if (!base) return;
          const entries = [];
          layers.forEach((l) => {
            if (l.painted || l.id === activeId) {
              const copy = document.createElement('canvas');
              copy.width = base.w;
              copy.height = base.h;
              copy.getContext('2d').drawImage(l.canvasEl, 0, 0);
              entries.push({ id: l.id, canvas: copy });
            }
          });
          undoStack.push(entries);
          if (undoStack.length > UNDO_LIMIT) undoStack.shift();
        }

        // Current state of the given layers, in undo-entry form — pushed to the
        // opposite stack so undo and redo are exact inverses of each other.
        function captureLayers(ids) {
          const entries = [];
          ids.forEach((id) => {
            const l = getLayer(id);
            if (!l) return;
            const copy = document.createElement('canvas');
            copy.width = base.w;
            copy.height = base.h;
            copy.getContext('2d').drawImage(l.canvasEl, 0, 0);
            entries.push({ id: id, canvas: copy });
          });
          return entries;
        }

        function restoreEntries(entries) {
          entries.forEach((en) => {
            const l = getLayer(en.id);
            if (!l) return; // area was removed since this stroke
            const ctx = l.canvasEl.getContext('2d');
            ctx.clearRect(0, 0, base.w, base.h);
            ctx.drawImage(en.canvas, 0, 0);
          });
          layers.forEach((l) => {
            l.painted = scanHasContent(l.canvasEl);
            l.blendMask = null;
          });
          renderLayers();
          updateControls();
          updateStageBackdrop();
          scheduleSessionSave();
        }

        function undoStroke() {
          if (!undoStack.length || phase !== 'draw' || !base) return;
          const entries = undoStack.pop();
          redoStack.push(captureLayers(entries.map((en) => en.id)));
          if (redoStack.length > UNDO_LIMIT) redoStack.shift();
          restoreEntries(entries);
        }
        undoBtn.addEventListener('click', undoStroke);

        function redoStroke() {
          if (!redoStack.length || phase !== 'draw' || !base) return;
          const entries = redoStack.pop();
          undoStack.push(captureLayers(entries.map((en) => en.id)));
          if (undoStack.length > UNDO_LIMIT) undoStack.shift();
          restoreEntries(entries);
        }
        redoBtn.addEventListener('click', redoStroke);

        function startDraw(e) {
          if (!canDraw()) return;
          snapshotForUndo();
          redoStack = []; // a new stroke forks history — redo targets are gone
          drawing = true;
          lastX = null;
          lastY = null;
          paint(e);
        }

        // --- Rectangle tool: drag out a marquee, fill it on release ------------
        let rectDragging = false;
        let rectStartPt = null;
        let rectPreviewEl = null;

        function beginRect(e) {
          const p = canvasPoint(e);
          if (!p) return;
          snapshotForUndo();
          rectDragging = true;
          rectStartPt = p;
          if (!rectPreviewEl) {
            rectPreviewEl = document.createElement('div');
            rectPreviewEl.className = 'ms-rect-preview';
            rectPreviewEl.setAttribute('aria-hidden', 'true');
            stack.appendChild(rectPreviewEl);
          }
          updateRectPreview(p);
        }

        function updateRectPreview(p) {
          const rect = baseCanvas.getBoundingClientRect();
          if (!rect.width) return;
          const sx = rect.width / base.w;
          const sy = rect.height / base.h;
          rectPreviewEl.style.display = 'block';
          rectPreviewEl.style.left = (Math.min(rectStartPt.x, p.x) * sx) + 'px';
          rectPreviewEl.style.top = (Math.min(rectStartPt.y, p.y) * sy) + 'px';
          rectPreviewEl.style.width = (Math.abs(p.x - rectStartPt.x) * sx) + 'px';
          rectPreviewEl.style.height = (Math.abs(p.y - rectStartPt.y) * sy) + 'px';
          const layer = activeLayer();
          if (layer) rectPreviewEl.style.setProperty('--cursor-color', layerColor(layer));
        }

        function endRect(e) {
          if (!rectDragging) return;
          rectDragging = false;
          if (rectPreviewEl) rectPreviewEl.style.display = 'none';
          const p = canvasPoint(e);
          const layer = activeLayer();
          const start = rectStartPt;
          rectStartPt = null;
          if (!p || !layer || !start) return;
          const x0 = Math.min(start.x, p.x);
          const y0 = Math.min(start.y, p.y);
          const w = Math.abs(p.x - start.x);
          const h = Math.abs(p.y - start.y);
          if (w < 3 || h < 3) {
            undoStack.pop(); // nothing was drawn — drop the pre-stroke snapshot
            updateControls();
            return;
          }
          redoStack = []; // committed rectangle forks history
          const ctx = layer.canvasEl.getContext('2d');
          ctx.fillStyle = layerColor(layer);
          ctx.fillRect(x0, y0, w, h);
          // Claim these pixels from every other area, same as brush strokes.
          layers.forEach((other) => {
            if (other !== layer) {
              const octx = other.canvasEl.getContext('2d');
              octx.globalCompositeOperation = 'destination-out';
              octx.fillRect(x0, y0, w, h);
              octx.globalCompositeOperation = 'source-over';
            }
          });
          layers.forEach((l) => {
            l.painted = scanHasContent(l.canvasEl);
            l.blendMask = null;
          });
          renderLayers();
          updateControls();
          updateStageBackdrop();
          scheduleSessionSave();
        }

        function cancelRect() {
          if (!rectDragging) return;
          rectDragging = false;
          rectStartPt = null;
          if (rectPreviewEl) rectPreviewEl.style.display = 'none';
          undoStack.pop();
          updateControls();
        }

        function stopDraw() {
          if (!drawing) return;
          drawing = false;
          lastX = null;
          lastY = null;
          // Accurate once-per-stroke rescan: erasing (or another area claiming
          // pixels) may have emptied any layer.
          layers.forEach((l) => {
            l.painted = scanHasContent(l.canvasEl);
            l.blendMask = null; // strokes changed → cached masks are stale
          });
          renderLayers();
          updateControls();
          updateStageBackdrop(); // refine ghost re-crops as strokes change
          scheduleSessionSave();
        }

        // ---------------------------------------------------------------------
        // Magic select: Gemini segmentation. The first wand click fetches masks
        // for every object in the photo and caches them, so every later click
        // resolves instantly by hit-testing the cache. Typed queries ("the
        // empty floor") fetch a targeted mask. Either way the result is painted
        // into the active area exactly like brush strokes — the wand is just a
        // faster brush, and undo/pixel-claiming behave identically.
        // ---------------------------------------------------------------------
        function segPayload() {
          // ~1024px is what Google's own segmentation samples send; coordinates
          // come back normalized, so full resolution would only cost tokens.
          const scale = Math.min(1, 1024 / Math.max(base.w, base.h));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(base.w * scale));
          c.height = Math.max(1, Math.round(base.h * scale));
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(base.canvas, 0, 0, c.width, c.height);
          return c.toDataURL('image/jpeg', 0.9);
        }

        async function fetchSegmentation(query) {
          const tok = window.StagifyAuth && window.StagifyAuth.getToken();
          const response = await fetch('/api/segment', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(tok ? { Authorization: 'Bearer ' + tok } : {}),
            },
            body: JSON.stringify({ image: segPayload(), query: query || '', authToken: tok || undefined }),
          });
          let result = null;
          try { result = await response.json(); } catch (e) {}
          if (!response.ok || !result || !result.success) {
            throw new Error(requestError(response.status, result));
          }
          return decodeSegItems(result.items || []);
        }

        // box_2d is [y0, x0, y1, x1] normalized to 0-1000; the mask PNG is a
        // probability map covering just that box, binarized at the documented
        // midpoint (>127 keeps). The API frequently omits usable pixel masks
        // (the server nulls them out) — then the box itself becomes the
        // selection, which the brush/eraser can refine.
        async function decodeSegItems(items) {
          const out = [];
          for (const it of items) {
            try {
              const y0 = it.box_2d[0], x0 = it.box_2d[1], y1 = it.box_2d[2], x1 = it.box_2d[3];
              if (y1 <= y0 || x1 <= x0) continue;
              const bx = Math.round((x0 / 1000) * base.w);
              const by = Math.round((y0 / 1000) * base.h);
              const bw = Math.max(1, Math.round(((x1 - x0) / 1000) * base.w));
              const bh = Math.max(1, Math.round(((y1 - y0) / 1000) * base.h));
              const c = document.createElement('canvas');
              c.width = base.w;
              c.height = base.h;
              const ctx = c.getContext('2d');
              let area = 0;
              if (it.mask) {
                const img = await loadImage(it.mask);
                ctx.drawImage(img, bx, by, bw, bh);
                const id = ctx.getImageData(bx, by, bw, bh);
                const d = id.data;
                for (let i = 0; i < d.length; i += 4) {
                  if (d[i] > 127) { d[i + 3] = 255; area++; }
                  else d[i + 3] = 0;
                }
                if (!area) continue;
                ctx.putImageData(id, bx, by);
              } else {
                const r = Math.min(24, Math.min(bw, bh) * 0.12);
                ctx.beginPath();
                if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, r);
                else ctx.rect(bx, by, bw, bh);
                ctx.fill();
                area = bw * bh;
              }
              out.push({ canvas: c, area: area, label: it.label || '' });
            } catch (e) { /* one undecodable mask never sinks the batch */ }
          }
          return out;
        }

        let wandMsgTimer = null;
        function setSegBusy(b) {
          segBusy = b;
          wandBusyEl.classList.toggle('hidden', !b);
          stack.classList.toggle('is-analyzing', b);
          if (wandMsgTimer) { clearInterval(wandMsgTimer); wandMsgTimer = null; }
          if (b) {
            // Cycle through progress lines while Gemini works; hold the last
            // one rather than looping back to "Analyzing…".
            const raw = window.LanguageSystem && window.LanguageSystem.getText('maskingStudio.wandBusyMessages');
            const msgs = Array.isArray(raw) && raw.length ? raw : [
              'Analyzing your photo…',
              'Finding the objects in the room…',
              'Outlining what it found…',
              'Almost there…',
            ];
            let i = 0;
            wandBusyEl.textContent = msgs[0];
            wandMsgTimer = setInterval(() => {
              i++;
              if (i >= msgs.length) { clearInterval(wandMsgTimer); wandMsgTimer = null; return; }
              wandBusyEl.textContent = msgs[i];
            }, 2200);
          }
        }

        // Paint a decoded mask into the active area exactly as if it had been
        // brushed: undo snapshot, tint in the layer color, claim the pixels
        // from every other area, rescan painted flags.
        function paintMaskIntoLayer(layer, maskCanvas) {
          snapshotForUndo();
          redoStack = []; // committed selection forks history
          const tint = document.createElement('canvas');
          tint.width = base.w;
          tint.height = base.h;
          const tctx = tint.getContext('2d');
          tctx.drawImage(maskCanvas, 0, 0);
          tctx.globalCompositeOperation = 'source-in';
          tctx.fillStyle = layerColor(layer);
          tctx.fillRect(0, 0, base.w, base.h);
          layer.canvasEl.getContext('2d').drawImage(tint, 0, 0);
          layers.forEach((other) => {
            if (other === layer) return;
            const octx = other.canvasEl.getContext('2d');
            octx.globalCompositeOperation = 'destination-out';
            octx.drawImage(maskCanvas, 0, 0);
            octx.globalCompositeOperation = 'source-over';
          });
          layers.forEach((l) => {
            l.painted = scanHasContent(l.canvasEl);
            l.blendMask = null;
          });
          renderLayers();
          updateControls();
          updateStageBackdrop();
          scheduleSessionSave();
        }

        // One shared in-flight request: clicks made while the analysis runs
        // await the same promise and land as soon as it resolves, instead of
        // being dropped. Prefetch (on tool select) uses the same path.
        let segPromise = null;
        function ensureSegCache() {
          if (segCache) return Promise.resolve(segCache);
          if (segPromise) return segPromise;
          const token = segToken;
          setSegBusy(true);
          segPromise = (async () => {
            try {
              const items = await fetchSegmentation('');
              if (token !== segToken) return null; // photo changed mid-flight
              // Never cache an empty list: Gemini occasionally returns zero
              // items for a full room, and caching that would make every
              // later click insta-miss until the photo changes.
              segCache = items.length ? items : null;
              return items;
            } finally {
              segPromise = null;
              setSegBusy(false);
            }
          })();
          return segPromise;
        }

        async function wandClick(e) {
          const p = canvasPoint(e);
          const layer = activeLayer();
          if (!p || !layer) return;
          let cache;
          try {
            cache = await ensureSegCache();
          } catch (err) {
            showToast(err && err.message ? err.message : tx('errors.processingFailed', 'Something went wrong. Please try again.'), 'error');
            return;
          }
          if (!cache || phase !== 'draw') return; // superseded while analyzing
          const px = Math.max(0, Math.min(base.w - 1, Math.round(p.x)));
          const py = Math.max(0, Math.min(base.h - 1, Math.round(p.y)));
          let hit = null;
          cache.forEach((it) => {
            const a = it.canvas.getContext('2d').getImageData(px, py, 1, 1).data[3];
            if (a > 0 && (!hit || it.area < hit.area)) hit = it; // smallest = most specific
          });
          if (!hit) {
            showToast(tx('maskingStudio.wandMiss', 'No object found there. Try clicking the middle of the object, or highlight it with the brush.'), 'error');
            return;
          }
          paintMaskIntoLayer(layer, hit.canvas);
        }

        // Touch: two-finger pinch zooms (phones have no Ctrl+wheel). A second
        // finger aborts whatever the first one started so a pinch never leaves
        // a half-stroke behind.
        const touchPts = new Map();
        let pinch = null; // { d0, zoom0 }

        stack.addEventListener('pointerdown', (e) => {
          if (e.pointerType === 'touch') {
            touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (touchPts.size === 2 && base) {
              if (drawing) {
                drawing = false;
                lastX = null;
                lastY = null;
                if (undoStack.length) restoreEntries(undoStack.pop());
              }
              if (rectDragging) cancelRect();
              comparing = false;
              panning = false;
              const pts = Array.from(touchPts.values());
              pinch = { d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1, zoom0: zoom };
              e.preventDefault();
              return;
            }
          }
          if ((spaceDown || e.button === 1) && base) {
            // Pan the zoomed view: drag with Space held or the middle button.
            e.preventDefault();
            try { stack.setPointerCapture(e.pointerId); } catch (err) {}
            panning = true;
            panStart = { x: e.clientX, y: e.clientY, sl: viewerEl.scrollLeft, st: viewerEl.scrollTop };
            return;
          }
          if (phase === 'review' && view === 'compare') {
            // Click anywhere in compare view to move the divider, then drag it.
            e.preventDefault();
            try { stack.setPointerCapture(e.pointerId); } catch (err) {}
            comparing = true;
            moveCompare(e);
            return;
          }
          if (!canDraw()) return;
          e.preventDefault();
          if (tool === 'wand') { wandClick(e); return; }
          try { stack.setPointerCapture(e.pointerId); } catch (err) {}
          if (tool === 'rect') { beginRect(e); return; }
          startDraw(e);
        });
        stack.addEventListener('pointermove', (e) => {
          if (e.pointerType === 'touch' && touchPts.has(e.pointerId)) {
            touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pinch && touchPts.size >= 2) {
              e.preventDefault();
              const pts = Array.from(touchPts.values());
              const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
              setZoom(pinch.zoom0 * (d / pinch.d0), {
                x: (pts[0].x + pts[1].x) / 2,
                y: (pts[0].y + pts[1].y) / 2,
              });
              return;
            }
          }
          if (panning) {
            e.preventDefault();
            viewerEl.scrollLeft = panStart.sl - (e.clientX - panStart.x);
            viewerEl.scrollTop = panStart.st - (e.clientY - panStart.y);
            return;
          }
          if (comparing) {
            e.preventDefault();
            moveCompare(e);
            return;
          }
          if (rectDragging) {
            e.preventDefault();
            const p = canvasPoint(e);
            if (p) updateRectPreview(p);
            return;
          }
          updateCursorPreview(e);
          if (!drawing) return;
          e.preventDefault();
          paint(e);
        });
        stack.addEventListener('pointerup', (e) => {
          touchPts.delete(e.pointerId);
          if (touchPts.size < 2) pinch = null;
          panning = false;
          comparing = false;
          endRect(e);
          stopDraw(e);
        });
        stack.addEventListener('pointercancel', (e) => {
          touchPts.delete(e.pointerId);
          if (touchPts.size < 2) pinch = null;
          panning = false;
          comparing = false;
          cancelRect();
          stopDraw(e);
        });
        stack.addEventListener('pointerleave', () => { if (cursorEl) cursorEl.style.display = 'none'; });

        // Brush-size circle that follows the pointer over the photo, tinted with
        // the active area's color (dashed gray while erasing).
        let cursorEl = null;
        function ensureCursor() {
          if (cursorEl) return;
          cursorEl = document.createElement('div');
          cursorEl.className = 'ms-cursor';
          cursorEl.setAttribute('aria-hidden', 'true');
          stack.appendChild(cursorEl);
        }
        function updateCursorPreview(e) {
          ensureCursor();
          const layer = activeLayer();
          if (!canDraw() || !layer || e.pointerType === 'touch' || spaceDown || tool === 'rect' || tool === 'wand') {
            cursorEl.style.display = 'none';
            return;
          }
          const rect = baseCanvas.getBoundingClientRect();
          if (!rect.width) return;
          const stackRect = stack.getBoundingClientRect();
          const size = brushSize * (rect.width / base.w);
          cursorEl.style.display = 'block';
          cursorEl.style.width = size + 'px';
          cursorEl.style.height = size + 'px';
          cursorEl.style.left = (e.clientX - stackRect.left) + 'px';
          cursorEl.style.top = (e.clientY - stackRect.top) + 'px';
          cursorEl.style.setProperty('--cursor-color', layerColor(layer));
          cursorEl.classList.toggle('is-erase', tool === 'erase');
        }

        function setTool(t) {
          tool = t === 'erase' ? 'erase' : t === 'rect' ? 'rect' : t === 'wand' ? 'wand' : 'brush';
          [[brushBtn, 'brush'], [eraseBtn, 'erase'], [rectBtn, 'rect'], [wandBtn, 'wand']].forEach(([btn, name]) => {
            btn.classList.toggle('is-active', tool === name);
            btn.setAttribute('aria-pressed', tool === name ? 'true' : 'false');
          });
          brushRow.classList.toggle('hidden', tool === 'wand');
          wandRow.classList.toggle('hidden', tool !== 'wand');
          if (cursorEl) {
            cursorEl.classList.toggle('is-erase', tool === 'erase');
            if (tool === 'rect' || tool === 'wand') cursorEl.style.display = 'none';
          }
          // Start analyzing the moment the wand is picked, so the photo is
          // usually mapped before the first click lands. Errors stay silent
          // here — the click path retries and surfaces them.
          if (tool === 'wand' && base && phase === 'draw' && !segCache) {
            ensureSegCache().catch(() => {});
          }
        }
        brushBtn.addEventListener('click', () => setTool('brush'));
        eraseBtn.addEventListener('click', () => setTool('erase'));
        rectBtn.addEventListener('click', () => setTool('rect'));
        wandBtn.addEventListener('click', () => setTool('wand'));

        function setBrushSize(v) {
          brushSize = Math.min(150, Math.max(20, v));
          brushSlider.value = String(brushSize);
          brushSizeLabel.textContent = brushSize + ' px';
        }
        brushSlider.addEventListener('input', () => setBrushSize(parseInt(brushSlider.value, 10)));

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
            if (rectDragging) { e.preventDefault(); cancelRect(); return; }
          }
          const t = e.target;
          const typing = t && t.closest && t.closest('input, textarea, select, [contenteditable]');
          if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z') {
            if (!typing && phase === 'draw') {
              e.preventDefault();
              if (e.shiftKey) redoStroke();
              else undoStroke();
            }
            return;
          }
          if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'y') {
            if (!typing && phase === 'draw' && redoStack.length) {
              e.preventDefault();
              redoStroke();
            }
            return;
          }
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          if (typing) return;
          if (!base || phase === 'generating') return;
          if (e.code === 'Space') {
            // Don't hijack Space when a button/link has focus (it activates it).
            if (t && t.closest && t.closest('button, a, [role="button"]')) return;
            e.preventDefault();
            if (!e.repeat) {
              spaceDown = true;
              stack.classList.add('is-pan');
              if (cursorEl) cursorEl.style.display = 'none';
            }
            return;
          }
          const k = e.key.toLowerCase();
          if (k === 'b') { setTool('brush'); }
          else if (k === 'e') { setTool('erase'); }
          else if (k === 'r') { setTool('rect'); }
          else if (k === 'w') { setTool('wand'); }
          else if (k === 'h') { if (!e.repeat && phase === 'draw') stack.classList.add('is-peek'); }
          else if (e.key === '[') { setBrushSize(brushSize - 10); }
          else if (e.key === ']') { setBrushSize(brushSize + 10); }
          else if (/^[1-6]$/.test(e.key)) {
            const layer = layers[parseInt(e.key, 10) - 1];
            if (layer) {
              activeId = layer.id;
              renderLayers();
            }
          }
        });
        document.addEventListener('keyup', (e) => {
          if (e.key.toLowerCase() === 'h') stack.classList.remove('is-peek');
          if (e.code === 'Space') {
            spaceDown = false;
            panning = false;
            stack.classList.remove('is-pan');
          }
        });
        window.addEventListener('blur', () => {
          stack.classList.remove('is-peek');
          spaceDown = false;
          panning = false;
          stack.classList.remove('is-pan');
        });

        // ---------------------------------------------------------------------
        // Phases & viewer
        // ---------------------------------------------------------------------
        function setPhase(p) {
          phase = p;
          const inReview = p === 'review';
          // "Edit highlights" must not strand the user away from their results:
          // in the draw phase, existing results stay reachable via "View result".
          const hasResults = layers.some((l) => l.status === 'done' && l.editedImg);
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
          if (cursorEl && p !== 'draw') cursorEl.style.display = 'none';
          if (busyOverlay) busyOverlay.classList.toggle('hidden', p !== 'generating');
          if (p === 'generating') startBusyMessages(); else stopBusyMessages();
          updateStageBackdrop();
          if (inReview) {
            setView(view);
          } else {
            resultCanvas.classList.add('hidden');
            resultCanvas.style.clipPath = '';
            layers.forEach((l) => l.canvasEl.classList.remove('hidden'));
            compareEl.classList.add('hidden');
            compareLabelBefore.classList.add('hidden');
            compareLabelAfter.classList.add('hidden');
            stack.classList.remove('is-compare');
            comparing = false;
          }
          renderLayers();
          updateControls();
        }

        function setView(v) {
          view = v === 'before' ? 'before' : v === 'compare' ? 'compare' : 'after';
          toggleBeforeBtn.classList.toggle('active', view === 'before');
          toggleCompareBtn.classList.toggle('active', view === 'compare');
          toggleAfterBtn.classList.toggle('active', view === 'after');
          const inReview = phase === 'review';
          const showResult = inReview && view !== 'before';
          resultCanvas.classList.toggle('hidden', !showResult);
          layers.forEach((l) => l.canvasEl.classList.toggle('hidden', showResult));
          const compareOn = inReview && view === 'compare';
          compareEl.classList.toggle('hidden', !compareOn);
          compareLabelBefore.classList.toggle('hidden', !compareOn);
          compareLabelAfter.classList.toggle('hidden', !compareOn);
          stack.classList.toggle('is-compare', compareOn);
          if (compareOn) {
            setComparePos(comparePos);
          } else {
            comparing = false;
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
          const generating = phase === 'generating';
          addLayerBtn.disabled = !base || generating || layers.length >= MAX_LAYERS;
          replaceBtn.disabled = generating;
          brushSlider.disabled = generating;
          brushBtn.disabled = generating;
          eraseBtn.disabled = generating;
          rectBtn.disabled = generating;
          wandBtn.disabled = generating;
          undoBtn.disabled = generating || phase !== 'draw' || !undoStack.length;
          redoBtn.disabled = generating || phase !== 'draw' || !redoStack.length;
          editHighlightsBtn.disabled = generating;
          downloadBtn.disabled = generating || !layers.some((l) => l.status === 'done');
          layerList.querySelectorAll('textarea, button').forEach((el) => { el.disabled = generating; });

          const painted = layers.filter((l) => l.painted);
          const allDetailed = painted.length > 0 && painted.every((l) => l.mode === 'remove' || l.prompt.trim() || l.furniture);
          generateBtn.disabled = !base || generating || !allDetailed;

          // Explain a disabled Apply Edit instead of leaving it a mystery.
          let hint = '';
          if (!generating) {
            if (!base) hint = tx('errors.uploadFirst', 'Please upload an image first');
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
          if (status === 401 || status === 403) {
            showProGate();
            return tx('maskingStudio.gateTitle', 'Masking Studio is a Stagify+ feature');
          }
          if (status === 429) return tx('maskingStudio.rateLimited', "You're generating too quickly — wait a minute and try again.");
          if (status === 413) return tx('errors.fileTooLarge', 'That image is too large.');
          return (result && result.error) || tx('errors.processingFailed', 'Something went wrong. Please try again.');
        }

        // Rough position of a mask inside the photo ("lower left", "center"…)
        // from its bounding box on a small alpha scan — feeds the cross-area
        // context so parallel generations know what lands where.
        function maskRegionName(canvasEl) {
          const s = 48;
          const c = document.createElement('canvas');
          c.width = s; c.height = s;
          const sctx = c.getContext('2d');
          sctx.drawImage(canvasEl, 0, 0, s, s);
          const d = sctx.getImageData(0, 0, s, s).data;
          let minX = s, minY = s, maxX = -1, maxY = -1;
          for (let y = 0; y < s; y++) {
            for (let x = 0; x < s; x++) {
              if (d[(y * s + x) * 4 + 3] > 8) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
              }
            }
          }
          if (maxX < 0) return '';
          const cx = (minX + maxX) / 2 / s;
          const cy = (minY + maxY) / 2 / s;
          const col = cx < 1 / 3 ? 'left' : (cx > 2 / 3 ? 'right' : 'center');
          const row = cy < 1 / 3 ? 'upper' : (cy > 2 / 3 ? 'lower' : 'middle');
          if (row === 'middle' && col === 'center') return 'center';
          if (row === 'middle') return 'center ' + col;
          if (col === 'center') return row + ' middle';
          return row + ' ' + col;
        }

        // Areas generate in parallel and never see each other's output, so each
        // prompt carries a sketch of the neighbors' plans — enough for the model
        // to keep lighting, perspective, and style coherent across areas.
        function buildAreaContext(layer, participants) {
          const others = participants.filter((l) => l !== layer && l.painted);
          if (!others.length) return '';
          const plans = others.map((l) => {
            let plan;
            if (l.mode === 'remove') plan = 'the existing contents are being removed';
            else if (l.prompt.trim()) plan = l.prompt.trim();
            else plan = 'furniture from a reference photo is being added';
            if (plan.length > 90) plan = plan.slice(0, 87) + '…';
            const region = maskRegionName(l.canvasEl);
            return (region ? 'in the ' + region + ' of the photo: ' : '') + plan;
          });
          return ' For context, other parts of this photo are being edited separately (' +
            plans.join('; ') +
            '). Only edit the masked area, but keep lighting, shadows, perspective, and furnishing style consistent with those planned changes.';
        }

        // At most 3 mask edits in flight at once: smoother on the server's rate
        // limiter and Gemini quotas than firing all 6 areas simultaneously,
        // while progressive compositing keeps the wait feeling short.
        function createPool(size) {
          let active = 0;
          const queue = [];
          const next = () => {
            if (!queue.length || active >= size) return;
            active++;
            const job = queue.shift();
            job.fn().then(job.resolve, job.reject).then(() => { active--; next(); });
          };
          return (fn) => new Promise((resolve, reject) => {
            queue.push({ fn: fn, resolve: resolve, reject: reject });
            next();
          });
        }
        const enqueueRun = createPool(3);

        // Union of every OTHER area's painted pixels, binarized. The grow +
        // feather halo may spill into unpainted photo (that forgiveness is the
        // point), but it must never cross into pixels the user assigned to a
        // different area — those are that area's exclusive territory.
        function othersStamp(layer, fillColor) {
          const others = layers.filter((l) => l !== layer && l.painted);
          if (!others.length) return null;
          const u = document.createElement('canvas');
          u.width = base.w;
          u.height = base.h;
          const uctx = u.getContext('2d');
          others.forEach((l) => uctx.drawImage(l.canvasEl, 0, 0));
          const stamp = growBinaryMask(u, base.w, base.h, 0); // grow 0 = binarize
          if (fillColor) {
            const sctx = stamp.getContext('2d');
            sctx.globalCompositeOperation = 'source-in';
            sctx.fillStyle = fillColor;
            sctx.fillRect(0, 0, base.w, base.h);
          }
          return stamp;
        }

        // buildModelMask / buildBlendMask with the halo clipped at neighboring
        // areas: black out (editable-region mask) or erase (compositing mask)
        // every pixel another area has painted.
        function layerModelMask(layer, coreGrow) {
          const mask = buildModelMask(layer.canvasEl, base.w, base.h, coreGrow);
          const stamp = othersStamp(layer, '#000');
          if (stamp) mask.getContext('2d').drawImage(stamp, 0, 0);
          return mask;
        }

        function layerBlendMask(layer, coreGrow, featherPx) {
          const mask = buildBlendMask(layer.canvasEl, base.w, base.h, coreGrow, featherPx);
          const stamp = othersStamp(layer);
          if (stamp) {
            const mctx = mask.getContext('2d');
            mctx.globalCompositeOperation = 'destination-out';
            mctx.drawImage(stamp, 0, 0);
            mctx.globalCompositeOperation = 'source-over';
          }
          return mask;
        }

        async function runLayer(layer, imageDataUrl, coreGrow, run, context, batchSize) {
          await maskCoreReady;
          const maskDataUrl = layerModelMask(layer, coreGrow).toDataURL('image/png');
          let prompt;
          if (layer.mode === 'remove') {
            prompt = tx(
              'maskingStudio.removePrompt',
              'Remove everything inside the highlighted area. Reconstruct what belongs behind it — floor, walls, baseboards, and trim — continuing the room’s existing surfaces, textures, and lighting seamlessly. Do not add any new furniture or objects.'
            );
            if (layer.prompt.trim()) prompt = (prompt + ' ' + layer.prompt.trim()).slice(0, 1000);
          } else {
            prompt = layer.prompt.trim() || tx(
              'maskingStudio.defaultFurniturePrompt',
              'Add the furniture from the reference photo into the highlighted area. Place it naturally on the floor with correct perspective, scale, and lighting for the room.'
            );
          }
          // Server caps prompts at 1000 chars — own prompt wins, context yields.
          if (context) prompt = (prompt + context).slice(0, 1000);
          const tok = window.StagifyAuth && window.StagifyAuth.getToken();
          const body = JSON.stringify({
            image: imageDataUrl,
            mask: maskDataUrl,
            prompt: prompt,
            authToken: tok || undefined,
            // Best-effort reproducibility passthrough + retry-budget hint for
            // multi-area batches (the server trims its quality retries).
            seed: (Math.random() * 0x7fffffff) | 0,
            batch: batchSize || 1,
            ...(layer.furniture && layer.mode !== 'remove' ? { referenceImage: layer.furniture } : {}),
          });
          let response = null;
          let result = null;
          // Rate-limit pressure (429) and transient overload (503) get two
          // jittered retries before the area is declared failed.
          for (let attempt = 0; ; attempt++) {
            response = await fetch('/api/mask-edit', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(tok ? { Authorization: 'Bearer ' + tok } : {}),
              },
              body: body,
            });
            result = null;
            try { result = await response.json(); } catch (e) {}
            if (run !== genRun) return; // a newer run/reset superseded this one
            if ((response.status !== 429 && response.status !== 503) || attempt >= 2) break;
            const retryAfter = Number(response.headers.get('retry-after'));
            const waitMs = retryAfter > 0 && retryAfter <= 120
              ? retryAfter * 1000
              : 1500 * Math.pow(2, attempt) + Math.random() * 1000;
            await new Promise((r) => setTimeout(r, waitMs));
            if (run !== genRun) return;
          }
          if (!response.ok || !result || !result.editedImage) {
            throw new Error(requestError(response.status, result));
          }
          const img = await loadImage(result.editedImage);
          if (run !== genRun) return;
          // Keep every version so the user can flip between them (capped to
          // bound memory: each is a full-resolution image).
          layer.candidates.push(img);
          if (layer.candidates.length > 4) layer.candidates.shift();
          layer.candIdx = layer.candidates.length - 1;
          layer.editedImg = img;
        }

        // The room payload goes up as JPEG (~10x smaller than PNG across N
        // parallel requests). This never touches the pixel-preservation
        // guarantee: compositing happens client-side from the pristine canvas,
        // so the upload encoding only affects what the model sees inside the
        // masked areas. Flattened onto white in case the source had alpha.
        function roomPayload() {
          const c = document.createElement('canvas');
          c.width = base.w;
          c.height = base.h;
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, base.w, base.h);
          ctx.drawImage(base.canvas, 0, 0);
          return c.toDataURL('image/jpeg', 0.92);
        }

        function updateRunProgress(doneCount, total) {
          progressBar.style.width = Math.round((doneCount / total) * 100) + '%';
          const template = tx('maskingStudio.progressCount', '{done} of {total} areas staged');
          progressText.textContent = template.replace('{done}', String(doneCount)).replace('{total}', String(total));
        }

        async function generate() {
          if (generateBtn.disabled || !base) return;
          const participating = layers.filter((l) => l.painted);
          if (!participating.length) {
            showToast(tx('maskingStudio.needHighlight', 'Paint at least one area on the photo first.'), 'error');
            return;
          }
          const missing = participating.find((l) => l.mode !== 'remove' && !l.prompt.trim() && !l.furniture);
          if (missing) {
            activeId = missing.id;
            renderLayers();
            showToast(tx('maskingStudio.needPromptOrFurniture', 'Each highlighted area needs a short prompt or a furniture photo.'), 'error');
            return;
          }

          const run = ++genRun;
          const maxDim = Math.max(base.w, base.h);
          // ~10% of the single-mask editor's expansion: the studio promises
          // precise containment, so edits hug the highlight with only a thin
          // softening edge instead of the main tool's generous outward fade.
          const coreGrow = Math.max(2, Math.round(maxDim * 0.0023));
          const featherPx = Math.max(2, Math.round(maxDim * 0.004));
          genMeta = { coreGrow: coreGrow, featherPx: featherPx };
          const imageDataUrl = roomPayload();

          await maskCoreReady;
          participating.forEach((l) => {
            l.status = 'generating';
            l.editedImg = null;
            l.candidates = [];
            l.candIdx = 0;
            l.errorMsg = '';
            l.canvasEl.classList.remove('is-landed');
            // Freeze the compositing mask now — strokes can't change mid-run.
            l.blendMask = layerBlendMask(l, coreGrow, featherPx);
          });
          setPhase('generating');
          renderBusyDots(participating);
          progressEl.classList.remove('hidden');
          progressText.classList.remove('hidden');
          updateRunProgress(0, participating.length);

          let settled = 0;
          await Promise.all(participating.map((layer) =>
            enqueueRun(() => runLayer(layer, imageDataUrl, coreGrow, run, buildAreaContext(layer, participating), participating.length))
              .then(() => { if (run === genRun) layer.status = 'done'; })
              .catch((err) => {
                if (run !== genRun) return;
                layer.status = 'failed';
                layer.errorMsg = err && err.message ? err.message : '';
              })
              .then(() => {
                if (run !== genRun) return;
                settled++;
                updateRunProgress(settled, participating.length);
                renderBusyDots(participating);
                renderLayers();
                updateControls(); // keep layer controls disabled through the run
                if (layer.status === 'done') {
                  layer.canvasEl.classList.add('is-landed');
                  updateStageBackdrop();
                }
              })
          ));
          if (run !== genRun) return;

          layers.forEach((l) => l.canvasEl && l.canvasEl.classList.remove('is-landed'));
          progressEl.classList.add('hidden');
          progressText.classList.add('hidden');
          compositeAll();
          const done = participating.filter((l) => l.status === 'done').length;
          if (done > 0) {
            // Land in Refine Edit: highlights over the pure After (raw output
            // ghosted outside them), and Looks Good waiting in the header.
            setPhase('draw');
          } else {
            setPhase('review');
            setView('before');
          }
          if (done === participating.length) {
            showToast(tx('maskingStudio.doneToast', 'All areas staged!'), 'success');
          } else if (done > 0) {
            const t = tx('maskingStudio.partialToast', '{done} of {total} areas staged — retry the failed ones.');
            showToast(t.replace('{done}', String(done)).replace('{total}', String(participating.length)), 'error');
          } else {
            showToast(tx('maskingStudio.failedToast', 'Staging failed. Please try again.'), 'error');
          }
        }
        generateBtn.addEventListener('click', generate);

        // Pick a different generated version of an area and recomposite.
        function selectCandidate(layer, idx) {
          if (!layer.candidates.length || phase === 'generating') return;
          layer.candIdx = ((idx % layer.candidates.length) + layer.candidates.length) % layer.candidates.length;
          layer.editedImg = layer.candidates[layer.candIdx];
          compositeAll();
          setView(view);
          renderLayers();
        }

        // Re-run a single failed/done area, then rebuild the composite.
        async function retryLayer(id) {
          const layer = getLayer(id);
          if (!layer || !base || phase === 'generating' || !genMeta) return;
          if (!layer.painted) return;
          const run = genRun;
          layer.status = 'generating';
          layer.errorMsg = '';
          if (!layer.blendMask) {
            await maskCoreReady;
            layer.blendMask = layerBlendMask(layer, genMeta.coreGrow, genMeta.featherPx);
          }
          renderLayers();
          updateControls();
          try {
            await enqueueRun(() => runLayer(layer, roomPayload(), genMeta.coreGrow, run, buildAreaContext(layer, layers.filter((l) => l.painted)), 1));
            if (run !== genRun) return;
            layer.status = 'done';
          } catch (err) {
            if (run !== genRun) return;
            if (layer.candidates.length) {
              // "Try another version" failed but earlier versions survive.
              layer.status = 'done';
              layer.editedImg = layer.candidates[layer.candIdx];
              showToast(err && err.message ? err.message : tx('errors.processingFailed', 'Something went wrong. Please try again.'), 'error');
            } else {
              layer.status = 'failed';
              layer.errorMsg = err && err.message ? err.message : '';
            }
          }
          compositeAll();
          setView(view);
          renderLayers();
          updateControls();
          updateStageBackdrop(); // retries can happen from the refine phase too
        }

        // Chain the per-area composites over the pristine original, in layer
        // order. compositeMaskedEditCanvas keeps its input untouched outside
        // each area's feathered mask, so anything never highlighted is the
        // original image, pixel for pixel.
        function compositeAll() {
          if (!base) return;
          let acc = document.createElement('canvas');
          acc.width = base.w;
          acc.height = base.h;
          acc.getContext('2d').drawImage(base.canvas, 0, 0);
          layers.forEach((layer) => {
            if (layer.status !== 'done' || !layer.editedImg) return;
            // Strokes edited since the run invalidate the cached mask; rebuild
            // from the current strokes — same "re-crop, don't re-generate"
            // semantics as the single-mask editor's refine step.
            if (!layer.blendMask && genMeta && buildBlendMask) {
              layer.blendMask = layerBlendMask(layer, genMeta.coreGrow, genMeta.featherPx);
            }
            if (layer.blendMask) {
              acc = compositeMaskedEditCanvas(acc, layer.blendMask, layer.editedImg, base.w, base.h);
            }
          });
          const ctx = resultCanvas.getContext('2d');
          ctx.clearRect(0, 0, base.w, base.h);
          ctx.drawImage(acc, 0, 0);
        }

        // What the display canvas shows underneath the highlights. Normally the
        // original photo; while refining after a run it mirrors the main tool's
        // renderRefinePreview: highlighted areas show exactly the composited
        // After, and each area's raw AI output is ghosted on top so content the
        // model painted just past the strokes stays visible and brushable-in.
        function updateStageBackdrop() {
          if (!base) return;
          const ctx = baseCanvas.getContext('2d');
          ctx.clearRect(0, 0, base.w, base.h);
          if (phase === 'generating' && hasAnyResults()) {
            // Progressive composite: each finished area lands in the backdrop
            // while the rest of the run is still generating.
            compositeAll();
            ctx.drawImage(resultCanvas, 0, 0);
          } else if (phase === 'draw' && hasAnyResults()) {
            compositeAll();
            ctx.drawImage(resultCanvas, 0, 0);
            // Ghost each area's raw output only OUTSIDE the highlights. A raw
            // frame holds original-looking pixels where OTHER areas' edits sit,
            // so an unclipped ghost would wash a neighbor's pure After back
            // toward the Before — clip it out per layer.
            ctx.globalAlpha = 0.55;
            layers.forEach((layer) => {
              if (layer.status !== 'done' || !layer.editedImg) return;
              const g = document.createElement('canvas');
              g.width = base.w;
              g.height = base.h;
              const gctx = g.getContext('2d');
              gctx.drawImage(layer.editedImg, 0, 0, base.w, base.h);
              const stamp = othersStamp(layer);
              if (stamp) {
                gctx.globalCompositeOperation = 'destination-out';
                gctx.drawImage(stamp, 0, 0);
                gctx.globalCompositeOperation = 'source-over';
              }
              ctx.drawImage(g, 0, 0);
            });
            ctx.globalAlpha = 1;
          } else {
            ctx.drawImage(base.canvas, 0, 0);
          }
        }

        // ---------------------------------------------------------------------
        // Review actions
        // ---------------------------------------------------------------------
        editHighlightsBtn.addEventListener('click', () => {
          if (phase !== 'review') return;
          setPhase('draw');
        });

        viewResultBtn.addEventListener('click', () => {
          if (phase !== 'draw' || !layers.some((l) => l.status === 'done' && l.editedImg)) return;
          compositeAll();
          setPhase('review');
          setView('after');
        });

        downloadBtn.addEventListener('click', () => {
          if (!layers.some((l) => l.status === 'done')) return;
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
          if (phase === 'generating') return;
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
              if (phase === 'generating') return;
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
          if (layers.length >= MAX_LAYERS) {
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
      })();
