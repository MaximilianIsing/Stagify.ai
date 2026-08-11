// Stagify.ai — the Exterior Studio's before/after slider.
//
// The CONTROL is styles/compare.css, shared with the gallery and the public share page:
// one clipped image, one transparent full-bleed range as the hit layer, and a seam plus a
// grip painted as pseudo-elements off a single `--compare-split`. This file only feeds it.
//
// It used to be a second implementation — a clipping wrapper the after image had to be
// counter-sized against, with a native range bar parked across the bottom of the photo. It
// worked, and it looked like a browser default sitting on someone's house. The shared
// control was already loaded on two other pages; this page now draws the same one.
//
// What is left here is the part that IS exterior-specific: pinning the box to the result's
// own shape, because the upload and the render are the same photo at different pixel sizes.

/**
 * Wire the compare slider.
 *
 * @param {{ root: HTMLElement, before: HTMLImageElement, after: HTMLImageElement, range: HTMLInputElement, valueText?: (percent: string) => string }} els - The
 *   compare widget's parts, and the copy for the slider's spoken value.
 * @returns {{ show: (beforeUrl: string, afterUrl: string) => void, setSplit: (percent: number) => void }} Controls for the widget.
 */
export function createCompare(els) {
  const { root, before, after, range } = els;
  const valueText = els.valueText || ((percent) => `${percent}% enhanced`);

  /**
   * Position the wipe.
   *
   * One custom property drives the clip AND both pseudo-elements, so the seam, the grip
   * and the edge of the after image are incapable of disagreeing — which is the whole
   * reason for reusing the shared control rather than keeping a second one.
   * @param {number} percent - Slider position, 0–100.
   * @returns {void}
   */
  function setSplit(percent) {
    const pct = Math.max(0, Math.min(100, Number(percent) || 0));
    root.style.setProperty('--compare-split', `${pct}%`);
    // The same position again, unitless, for the BEFORE/AFTER tags: each fades out as its
    // own half is dragged off screen, and CSS cannot divide a percentage back to a number.
    root.style.setProperty('--compare-split-n', String(pct / 100));
    // A range with no valuetext is announced as a bare number — "50", with no unit and no
    // clue which half of the comparison it refers to.
    range.setAttribute('aria-valuetext', valueText(String(pct)));
  }

  /**
   * Load a pair of images into the widget and pin the box to the AFTER image's shape.
   *
   * Two properties, one measurement. `--ex-ar` is the ratio the box lays out at;
   * `--ex-ar-num` is the same number unitless, which is what lets the stylesheet cap the
   * box by WIDTH instead of clamping its height. A height clamp on a portrait photo leaves
   * the ratio broken and object-fit quietly cropping the render — in a studio whose whole
   * job is showing you your result, that is the worst place to lose pixels.
   * @param {string} beforeUrl - The uploaded photo, as an object URL or data URL.
   * @param {string} afterUrl - The enhanced result.
   * @returns {void}
   */
  function show(beforeUrl, afterUrl) {
    before.src = beforeUrl;
    after.src = afterUrl;
    after.addEventListener('load', () => {
      if (after.naturalWidth && after.naturalHeight) {
        root.style.setProperty('--ex-ar', `${after.naturalWidth} / ${after.naturalHeight}`);
        root.style.setProperty('--ex-ar-num', String(after.naturalWidth / after.naturalHeight));
      }
    }, { once: true });
    range.value = '50';
    setSplit(50);
  }

  range.addEventListener('input', () => setSplit(Number(range.value)));
  setSplit(Number(range.value) || 50);

  return { show, setSplit };
}
