// Brush size as a fraction of the photo, not a pixel count.
//
// A pixel-valued brush is meaningless across the resolutions this app sees. The
// mask canvases are sized to the source image, which is never downscaled on the
// client, so the old fixed 20-150px slider covered 15% of a 1024px image and
// only 3.7% of a 4032px phone photo — at the top of its range the brush was a
// thin line on exactly the photos that needed broad strokes.
//
// Sizing off the long edge fixes both halves of that: the brush covers the same
// share of every photo, and because each editor fits the whole photo into its
// container, the same share also *looks* the same size on screen.
//
// The scale is geometric — each notch is ~20% wider than the last — so the low
// end keeps fine control instead of spending most of the slider's travel on
// sizes nobody drags to.

/**
 * Slider bounds. Every editor assigns these onto its `<input type="range">` at
 * wire time, so the values in the markup are a pre-hydration placeholder that
 * cannot drift out of sync with the scale.
 */
export const BRUSH_STEP_MIN = 1;
export const BRUSH_STEP_MAX = 16;

/**
 * 2.47% of the long edge — 47px on the 1920x1080 canvas the server generates at
 * (`lib/image/image-primitives.js`), i.e. the 50px this control shipped with.
 */
export const BRUSH_STEP_DEFAULT = 6;

const MIN_FRACTION = 0.01;
const MAX_FRACTION = 0.15;

// Below this a stroke is too thin to see, and on a small enough photo 1% would
// round away to nothing. Tiny images stop scaling down and take the floor.
const MIN_PX = 6;

/**
 * The step's share of the photo's long edge.
 *
 * Clamps here rather than at the call sites: the Masking Studio's `[` and `]`
 * shortcuts set the step directly and never pass through the input's min/max.
 *
 * @param {number} step - a slider step, nominally BRUSH_STEP_MIN..BRUSH_STEP_MAX
 * @returns {number} a fraction of the long edge, in [0.01, 0.15]
 */
export function brushFraction(step) {
  const rounded = Math.round(step) || BRUSH_STEP_MIN; // also catches NaN
  const s = Math.min(BRUSH_STEP_MAX, Math.max(BRUSH_STEP_MIN, rounded));
  const t = (s - BRUSH_STEP_MIN) / (BRUSH_STEP_MAX - BRUSH_STEP_MIN);
  return MIN_FRACTION * Math.pow(MAX_FRACTION / MIN_FRACTION, t);
}

/**
 * Brush diameter in canvas pixels, for a canvas of these dimensions.
 *
 * @param {number} step - a slider step
 * @param {number} width - canvas width in pixels (i.e. image pixels)
 * @param {number} height - canvas height in pixels
 * @returns {number} the diameter to use as ctx.lineWidth
 */
export function brushPx(step, width, height) {
  const longEdge = Math.max(width || 0, height || 0);
  if (!longEdge) return MIN_PX;
  return Math.max(MIN_PX, Math.round(brushFraction(step) * longEdge));
}
