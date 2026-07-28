// The refine step's shared maths: how far to grow the brushed region before
// sending it to the model, and how to re-composite an already-generated result
// through the current strokes.
//
// Both mask editors carried identical copies of all of this, including the two
// magic ratios and the 55%-ghost overlay. Re-cropping is instant and free — no
// API call — which is the whole point of the refine phase.
import { buildBlendMask, compositeMaskedEditCanvas } from '../mask-core.js';

// Secret brush expansion: grow the selection a little so slight under-brushing is
// still covered, with a feathered edge so the composite shows no seam. Kept
// modest (about half what it once was) now that the refine step lets people
// extend the mask themselves.
const CORE_GROW_RATIO = 0.02275;
const FEATHER_RATIO = 0.04;
const MIN_CORE_GROW = 12;
const MIN_FEATHER = 20;

// How strongly the raw AI output is ghosted over the composite while refining.
const GHOST_ALPHA = 0.55;

/**
 * Growth radii for an image of this size, in pixels.
 * @param {number} w
 * @param {number} h
 * @returns {{ coreGrow: number, featherPx: number }}
 */
export function maskGrowths(w, h) {
  const maxDim = Math.max(w, h);
  return {
    coreGrow: Math.max(MIN_CORE_GROW, Math.round(maxDim * CORE_GROW_RATIO)),
    featherPx: Math.max(MIN_FEATHER, Math.round(maxDim * FEATHER_RATIO)),
  };
}

/**
 * Copy a canvas/image into a detached canvas — used to snapshot the pristine
 * source before the refine preview overwrites the visible base canvas.
 * @param {CanvasImageSource} src
 * @param {number} w
 * @param {number} h
 * @returns {HTMLCanvasElement}
 */
export function snapshotCanvas(src, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

/**
 * Re-composite the already-generated AI output through the CURRENT brush strokes
 * onto the pristine original, and paint it into the editor's base canvas.
 *
 * The raw output is then ghosted on top at 55% so the user can see the ENTIRE
 * generated region — including parts outside the current brush — and judge where
 * to extend or trim. That ghost is visual only: the committed result is
 * re-composited cleanly from the same state, never read back off this canvas.
 *
 * @param {{
 *   baseCanvas: HTMLCanvasElement,
 *   drawCanvas: HTMLCanvasElement,
 *   state: { origCanvas: CanvasImageSource, w: number, h: number, coreGrow: number, featherPx: number, editedImg: CanvasImageSource },
 * }} args
 * @returns {void}
 */
export function renderRefinePreview({ baseCanvas, drawCanvas, state }) {
  if (!baseCanvas || !drawCanvas || !state) return;
  const { origCanvas, w, h, coreGrow, featherPx, editedImg } = state;
  // Name the missing piece. The two editors used different keys for the snapshot
  // (`origCanvas` vs `originCanvas`), and handing drawImage an undefined source
  // surfaces only as "the provided value is not of type ..." from deep inside the
  // canvas API, with nothing to say which field was wrong.
  if (!origCanvas || !editedImg) {
    throw new Error(
      `renderRefinePreview: refine state is missing ${!origCanvas ? 'origCanvas' : 'editedImg'}`,
    );
  }
  const keep = buildBlendMask(drawCanvas, w, h, coreGrow, featherPx);
  const composed = compositeMaskedEditCanvas(origCanvas, keep, editedImg, w, h);
  const bctx = baseCanvas.getContext('2d');
  bctx.clearRect(0, 0, w, h);
  bctx.drawImage(composed, 0, 0);
  bctx.save();
  bctx.globalAlpha = GHOST_ALPHA;
  bctx.drawImage(editedImg, 0, 0, w, h);
  bctx.restore();
}
