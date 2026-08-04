// Stagify.ai — the Exterior Studio's before/after compare slider.
//
// Two images stacked in one box; the AFTER image is clipped to the slider position and
// the BEFORE image shows through the rest. The interesting part is the second line of
// `setSplit`: the after image has to be counter-sized against its own clipping wrapper,
// or dragging the slider SQUEEZES it instead of revealing it.

/**
 * Wire the compare slider.
 *
 * @param {{ root: HTMLElement, before: HTMLImageElement, after: HTMLImageElement, afterWrap: HTMLElement, range: HTMLInputElement }} els - The compare widget's parts.
 * @returns {{ show: (beforeUrl: string, afterUrl: string) => void, setSplit: (percent: number) => void }} Controls for the widget.
 */
export function createCompare(els) {
  const { root, before, after, afterWrap, range } = els;

  /**
   * Position the wipe.
   *
   * The wrapper is `width: <pct>%` of the box, and the image inside it is
   * `width: <100/pct * 100>%` of the WRAPPER — which resolves back to exactly the box's
   * width. Without that second value the image would be laid out at 100% of a shrinking
   * wrapper, so sliding left would scale the after image down rather than uncover the
   * before image, and the two halves would stop lining up.
   * @param {number} percent - Slider position, 0–100.
   * @returns {void}
   */
  function setSplit(percent) {
    const pct = Math.max(0, Math.min(100, Number(percent) || 0));
    afterWrap.style.setProperty('--ex-split', `${pct}%`);
    // Guard the divide: at 0 the wrapper has no width and the ratio is meaningless.
    after.style.setProperty('--ex-after-width', pct === 0 ? '100%' : `${(100 / pct) * 100}%`);
  }

  /**
   * Load a pair of images into the widget and pin the box to the AFTER image's shape.
   *
   * Pinning matters because the two frames are the same photo at different pixel sizes
   * (the delivered render is upscaled), and a box that resized between them would jump
   * the moment a result arrived.
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
      }
    }, { once: true });
    range.value = '50';
    setSplit(50);
  }

  range.addEventListener('input', () => setSplit(Number(range.value)));
  setSplit(Number(range.value) || 50);

  return { show, setSplit };
}
