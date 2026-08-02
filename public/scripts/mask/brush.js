// The mask editor's brush: pointer→canvas mapping, brush/erase strokes, and the
// "has anything been painted" flag that gates the Apply button.
//
// Shared by both mask editors, which carried near-identical copies. The only
// real parameters are which canvas to paint on and how to ask the editor what
// phase it is in; everything else — the compositing modes, the stroke geometry,
// the two-tier content check — was already the same on both sides.
//
//   createMaskBrush({ getCanvas, getPhase, isBusy, onReadyChange, onRefineStroke, getCursorHost })
//     -> { attach, setTool, getTool, setSizeStep, getSizeStep, clear, recolor, hasContent, rescan }

import { BRUSH_STEP_DEFAULT, brushPx } from './brush-scale.js';

// Draw-phase blue and refine-phase green. The refine colour is a signal that the
// strokes are now adjusting the crop of an existing result, not selecting a new area.
const DRAW_COLOR = '#2563eb';
const REFINE_COLOR = '#16a34a';

// Alpha above which a pixel counts as painted. Not zero: an antialiased stroke
// edge leaves a fringe of near-transparent pixels, and a mask that is nothing
// but fringe should not enable Apply.
const ALPHA_THRESHOLD = 10;

/**
 * @param {{
 *   getCanvas: () => HTMLCanvasElement | null,
 *   getPhase: () => string,
 *   isBusy: () => boolean,
 *   onReadyChange?: () => void,
 *   onRefineStroke?: () => void,
 *   getCursorHost?: () => HTMLElement | null,
 * }} deps - The draw canvas, the editor's phase, whether a run is in flight, and
 *   two notifications: readiness changed (refresh the Apply button) and a stroke
 *   finished while refining (re-crop the preview). getCursorHost is the
 *   positioned element the brush-size ring hangs off; omit it for no ring.
 */
export function createMaskBrush({ getCanvas, getPhase, isBusy, onReadyChange, onRefineStroke, getCursorHost }) {
  let sizeStep = BRUSH_STEP_DEFAULT;
  let tool = 'brush'; // 'brush' adds to the selection, 'erase' removes from it
  let painted = false; // hot-path flag; the expensive scan runs only on stroke end
  let drawing = false;
  let lastX = null;
  let lastY = null;
  let attached = false;

  const notifyReady = () => { if (onReadyChange) onReadyChange(); };

  // Map the pointer into canvas (image-pixel) space using the LIVE rendered size.
  // The canvas's on-screen size is governed by CSS and can differ from whatever
  // display size was computed at load — a tall image gets width-clamped by its
  // container, say. Reading getBoundingClientRect every stroke keeps the brush
  // under the cursor no matter how the layout sized things.
  function pointFrom(canvas, e) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  // The slider picks a step on a relative scale; how many pixels that is depends
  // on the photo. Resolved per stroke rather than cached when the slider moves,
  // because the dialog reopens on a different photo — and re-sizes the canvas to
  // it — without the slider ever moving.
  function brushWidth(canvas) {
    return brushPx(sizeStep, canvas.width, canvas.height);
  }

  function draw(e) {
    const canvas = getCanvas();
    if (!drawing || !canvas || isBusy()) return;
    const pt = pointFrom(canvas, e);
    if (!pt) return;
    const ctx = canvas.getContext('2d');
    // One continuous, fully-opaque stroke with round caps/joins. Erase mode uses
    // destination-out so the stroke removes from the selection instead of adding
    // to it. Solid pixels keep the shape clean; the translucent look comes from
    // the canvas element's CSS opacity.
    ctx.globalCompositeOperation = tool === 'erase' ? 'destination-out' : 'source-over';
    const color = getPhase() === 'refine' ? REFINE_COLOR : DRAW_COLOR;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    const width = brushWidth(canvas);
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (lastX === null || lastY === null) {
      ctx.beginPath();                                  // single tap: a round dot
      ctx.arc(pt.x, pt.y, width / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    lastX = pt.x;
    lastY = pt.y;
    if (tool === 'brush' && !painted) {
      painted = true;      // first mark: flip the flag and refresh the button once
      notifyReady();
    }
  }

  function start(e) {
    if (isBusy()) return;
    drawing = true;
    lastX = null;
    lastY = null;
    draw(e);
  }

  function stop() {
    if (!drawing) return;
    drawing = false;
    lastX = null;
    lastY = null;
    painted = rescan(); // recompute accurately once (handles erasing it all away)
    notifyReady();
    // In refine mode, re-crop the existing AI output through the new strokes —
    // instant and free, no API call.
    if (getPhase() === 'refine' && onRefineStroke) onRefineStroke();
  }

  /** Accurate but expensive: only ever on stroke end, never per-move. */
  function rescan() {
    const canvas = getCanvas();
    if (!canvas || !canvas.width || !canvas.height) return false;
    const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] > ALPHA_THRESHOLD) return true;
    }
    return false;
  }

  function clear() {
    const canvas = getCanvas();
    if (!canvas) return;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    painted = false;
    notifyReady();
  }

  // Recolour every painted stroke, keeping alpha. Mask logic reads only alpha, so
  // this is purely cosmetic — it marks the switch into the refine phase.
  function recolor(color) {
    const canvas = getCanvas();
    if (!canvas || !canvas.width || !canvas.height) return;
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  function setTool(t) {
    tool = t === 'erase' ? 'erase' : 'brush';
  }

  // A ring under the pointer at the brush's true footprint. The slider is a
  // relative scale now, so its position says nothing about how much of THIS
  // photo a stroke will cover — the ring is what makes the size legible. The
  // crosshair stays underneath it: the ring shows the extent, the crosshair the
  // centre.
  /** @type {HTMLElement | null} */
  let cursorEl = null;

  function hideCursor() {
    if (cursorEl) cursorEl.style.display = 'none';
  }

  function updateCursor(e) {
    const host = getCursorHost ? getCursorHost() : null;
    const canvas = getCanvas();
    if (!host || !canvas || !canvas.width) return;
    if (!cursorEl) {
      cursorEl = document.createElement('div');
      cursorEl.className = 'mask-brush-cursor';
      cursorEl.setAttribute('aria-hidden', 'true');
      host.appendChild(cursorEl);
    }
    if (isBusy()) {
      hideCursor();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const hostRect = host.getBoundingClientRect();
    // Image pixels -> CSS pixels: the same ratio pointFrom inverts.
    const shown = brushWidth(canvas) * (rect.width / canvas.width);
    cursorEl.style.display = 'block';
    cursorEl.style.width = shown + 'px';
    cursorEl.style.height = shown + 'px';
    cursorEl.style.left = (e.clientX - hostRect.left) + 'px';
    cursorEl.style.top = (e.clientY - hostRect.top) + 'px';
    cursorEl.style.setProperty('--mask-cursor-color', getPhase() === 'refine' ? REFINE_COLOR : DRAW_COLOR);
    cursorEl.classList.toggle('is-erase', tool === 'erase');
  }

  /** Attach the pointer listeners. Idempotent — the dialog may reopen many times. */
  function attach() {
    const canvas = getCanvas();
    if (attached || !canvas) return;
    attached = true;
    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', (e) => { draw(e); updateCursor(e); });
    canvas.addEventListener('mouseenter', updateCursor);
    canvas.addEventListener('mouseup', stop);
    canvas.addEventListener('mouseleave', stop);
    canvas.addEventListener('mouseleave', hideCursor);
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      hideCursor();     // a finger has no hover position for the ring to track
      const t = e.touches[0];
      start({ clientX: t.clientX, clientY: t.clientY });
    });
    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const t = e.touches[0];
      draw({ clientX: t.clientX, clientY: t.clientY });
    });
    canvas.addEventListener('touchend', (e) => { e.preventDefault(); stop(); });
    canvas.style.pointerEvents = 'auto';
    canvas.style.cursor = 'crosshair';
  }

  return {
    attach,
    setTool,
    getTool: () => tool,
    setSizeStep: (n) => { sizeStep = n; },
    getSizeStep: () => sizeStep,
    clear,
    recolor,
    hasContent: () => painted,
    rescan,
    REFINE_COLOR,
  };
}
