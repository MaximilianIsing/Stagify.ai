// Draw-tools island for the Masking Studio (scripts/masking-studio-app.js).
//
// Brush/erase/rect stroke drawing with pixel claiming across areas, the
// snapshot-based undo/redo stacks, the pointer/touch/pinch/pan handlers on the
// canvas stack, the brush-cursor preview, and tool switching. Lifted verbatim
// from the entry; self-wires its own toolbar/slider/undo/redo listeners. The
// magic wand lives in its own island — wandClick/ensureSegCache come in as
// late-bound callbacks so the pointerdown dispatch stays here.
//
// deps: { state, stack, baseCanvas, viewerEl, undoBtn, redoBtn, brushBtn,
//         eraseBtn, rectBtn, wandBtn, brushRow, wandRow, brushSlider,
//         brushSizeLabel, activeLayer, getLayer, layerColor, renderLayers,
//         updateControls, scheduleSessionSave, updateStageBackdrop, setZoom,
//         moveCompare, wandClick, ensureSegCache }
export function createDrawTools(deps) {
  const {
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
    wandClick,
    ensureSegCache,
  } = deps;

        let tool = 'brush';
        let panStart = null;      // { x, y, sl, st } at pan pointerdown

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
          return state.base && state.phase === 'draw' && activeLayer();
        }

        function canvasPoint(e) {
          const rect = baseCanvas.getBoundingClientRect();
          if (!rect.width || !rect.height) return null;
          return {
            x: (e.clientX - rect.left) * (state.base.w / rect.width),
            y: (e.clientY - rect.top) * (state.base.h / rect.height),
          };
        }

        // Apply one stroke segment to a canvas context (dot for taps, line for
        // moves). Solid pixels; the translucent look comes from CSS opacity.
        function strokeSegment(ctx, x, y, composite, color) {
          ctx.globalCompositeOperation = composite;
          ctx.strokeStyle = color;
          ctx.fillStyle = color;
          ctx.lineWidth = state.brushSize;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          if (lastX === null || lastY === null) {
            ctx.beginPath();
            ctx.arc(x, y, state.brushSize / 2, 0, Math.PI * 2);
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
            state.layers.forEach((other) => {
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
          if (!state.base) return;
          const entries = [];
          state.layers.forEach((l) => {
            if (l.painted || l.id === state.activeId) {
              const copy = document.createElement('canvas');
              copy.width = state.base.w;
              copy.height = state.base.h;
              copy.getContext('2d').drawImage(l.canvasEl, 0, 0);
              entries.push({ id: l.id, canvas: copy });
            }
          });
          state.undoStack.push(entries);
          if (state.undoStack.length > UNDO_LIMIT) state.undoStack.shift();
        }

        // Current state of the given layers, in undo-entry form — pushed to the
        // opposite stack so undo and redo are exact inverses of each other.
        function captureLayers(ids) {
          const entries = [];
          ids.forEach((id) => {
            const l = getLayer(id);
            if (!l) return;
            const copy = document.createElement('canvas');
            copy.width = state.base.w;
            copy.height = state.base.h;
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
            ctx.clearRect(0, 0, state.base.w, state.base.h);
            ctx.drawImage(en.canvas, 0, 0);
          });
          state.layers.forEach((l) => {
            l.painted = scanHasContent(l.canvasEl);
            l.blendMask = null;
          });
          renderLayers();
          updateControls();
          updateStageBackdrop();
          scheduleSessionSave();
        }

        function undoStroke() {
          if (!state.undoStack.length || state.phase !== 'draw' || !state.base) return;
          const entries = state.undoStack.pop();
          state.redoStack.push(captureLayers(entries.map((en) => en.id)));
          if (state.redoStack.length > UNDO_LIMIT) state.redoStack.shift();
          restoreEntries(entries);
        }
        undoBtn.addEventListener('click', undoStroke);

        function redoStroke() {
          if (!state.redoStack.length || state.phase !== 'draw' || !state.base) return;
          const entries = state.redoStack.pop();
          state.undoStack.push(captureLayers(entries.map((en) => en.id)));
          if (state.undoStack.length > UNDO_LIMIT) state.undoStack.shift();
          restoreEntries(entries);
        }
        redoBtn.addEventListener('click', redoStroke);

        function startDraw(e) {
          if (!canDraw()) return;
          snapshotForUndo();
          state.redoStack = []; // a new stroke forks history — redo targets are gone
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
          const sx = rect.width / state.base.w;
          const sy = rect.height / state.base.h;
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
            state.undoStack.pop(); // nothing was drawn — drop the pre-stroke snapshot
            updateControls();
            return;
          }
          state.redoStack = []; // committed rectangle forks history
          const ctx = layer.canvasEl.getContext('2d');
          ctx.fillStyle = layerColor(layer);
          ctx.fillRect(x0, y0, w, h);
          // Claim these pixels from every other area, same as brush strokes.
          state.layers.forEach((other) => {
            if (other !== layer) {
              const octx = other.canvasEl.getContext('2d');
              octx.globalCompositeOperation = 'destination-out';
              octx.fillRect(x0, y0, w, h);
              octx.globalCompositeOperation = 'source-over';
            }
          });
          state.layers.forEach((l) => {
            l.painted = scanHasContent(l.canvasEl);
            l.blendMask = null;
          });
          renderLayers();
          updateControls();
          updateStageBackdrop();
          scheduleSessionSave();
        }

        function cancelRect() {
          if (!rectDragging) return false;
          rectDragging = false;
          rectStartPt = null;
          if (rectPreviewEl) rectPreviewEl.style.display = 'none';
          state.undoStack.pop();
          updateControls();
          return true;
        }

        function stopDraw() {
          if (!drawing) return;
          drawing = false;
          lastX = null;
          lastY = null;
          // Accurate once-per-stroke rescan: erasing (or another area claiming
          // pixels) may have emptied any layer.
          state.layers.forEach((l) => {
            l.painted = scanHasContent(l.canvasEl);
            l.blendMask = null; // strokes changed → cached masks are stale
          });
          renderLayers();
          updateControls();
          updateStageBackdrop(); // refine ghost re-crops as strokes change
          scheduleSessionSave();
        }

        // Touch: two-finger pinch zooms (phones have no Ctrl+wheel). A second
        // finger aborts whatever the first one started so a pinch never leaves
        // a half-stroke behind.
        const touchPts = new Map();
        let pinch = null; // { d0, zoom0 }

        stack.addEventListener('pointerdown', (e) => {
          if (e.pointerType === 'touch') {
            touchPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (touchPts.size === 2 && state.base) {
              if (drawing) {
                drawing = false;
                lastX = null;
                lastY = null;
                if (state.undoStack.length) restoreEntries(state.undoStack.pop());
              }
              if (rectDragging) cancelRect();
              state.comparing = false;
              state.panning = false;
              const pts = Array.from(touchPts.values());
              pinch = { d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1, zoom0: state.zoom };
              e.preventDefault();
              return;
            }
          }
          if ((state.spaceDown || e.button === 1) && state.base) {
            // Pan the zoomed view: drag with Space held or the middle button.
            e.preventDefault();
            try { stack.setPointerCapture(e.pointerId); } catch (err) {}
            state.panning = true;
            panStart = { x: e.clientX, y: e.clientY, sl: viewerEl.scrollLeft, st: viewerEl.scrollTop };
            return;
          }
          if (state.phase === 'review' && state.view === 'compare') {
            // Click anywhere in compare view to move the divider, then drag it.
            e.preventDefault();
            try { stack.setPointerCapture(e.pointerId); } catch (err) {}
            state.comparing = true;
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
          if (state.panning) {
            e.preventDefault();
            viewerEl.scrollLeft = panStart.sl - (e.clientX - panStart.x);
            viewerEl.scrollTop = panStart.st - (e.clientY - panStart.y);
            return;
          }
          if (state.comparing) {
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
          state.panning = false;
          state.comparing = false;
          endRect(e);
          stopDraw(e);
        });
        stack.addEventListener('pointercancel', (e) => {
          touchPts.delete(e.pointerId);
          if (touchPts.size < 2) pinch = null;
          state.panning = false;
          state.comparing = false;
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
          if (!canDraw() || !layer || e.pointerType === 'touch' || state.spaceDown || tool === 'rect' || tool === 'wand') {
            cursorEl.style.display = 'none';
            return;
          }
          const rect = baseCanvas.getBoundingClientRect();
          if (!rect.width) return;
          const stackRect = stack.getBoundingClientRect();
          const size = state.brushSize * (rect.width / state.base.w);
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
          if (tool === 'wand' && state.base && state.phase === 'draw' && !state.segCache) {
            ensureSegCache().catch(() => {});
          }
        }
        brushBtn.addEventListener('click', () => setTool('brush'));
        eraseBtn.addEventListener('click', () => setTool('erase'));
        rectBtn.addEventListener('click', () => setTool('rect'));
        wandBtn.addEventListener('click', () => setTool('wand'));

        function setBrushSize(v) {
          state.brushSize = Math.min(150, Math.max(20, v));
          brushSlider.value = String(state.brushSize);
          brushSizeLabel.textContent = state.brushSize + ' px';
        }
        brushSlider.addEventListener('input', () => setBrushSize(parseInt(brushSlider.value, 10)));

        // Entry-facing veil over the island-private cursor element (the phase
        // machine and the Space-pan shortcut both blank it).
        function hideCursor() {
          if (cursorEl) cursorEl.style.display = 'none';
        }

  return {
    setTool,
    setBrushSize,
    snapshotForUndo,
    undoStroke,
    redoStroke,
    cancelRect,
    hideCursor,
    scanHasContent,
    canvasPoint,
  };
}
