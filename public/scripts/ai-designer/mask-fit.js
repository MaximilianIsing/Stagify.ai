// Sizes the mask-editor canvases to the room the dialog ACTUALLY has.
//
// The old sizing handed the image a flat fraction of the viewport height (70%
// desktop / 50% mobile) and left the rest to flexbox. That over-commits: the
// header + tool row + brush slider + prompt + reference block + buttons need
// ~300px more, and `.mask-editor-content` is capped at 90vh. On a short window
// the column overflowed, and because `.mask-editor-canvas-container` sets
// `overflow: hidden` — which drops a flex item's automatic minimum size to 0 —
// flex silently shrank the image box while the canvas kept its explicit pixel
// height. Result: the photo was clipped at the bottom with nothing to scroll.
//
// So instead of guessing: measure the chrome with the image collapsed, give the
// image whatever height is left, and scale it proportionally.
//
//   createMaskFit() -> { setImage, fit, bind, unbind }

// `.mask-editor-modal.active` padding — the gutter the dialog can't grow into.
const MODAL_PADDING = 20;
// Never scale the image away entirely; below these the dialog scrolls instead
// (`.mask-editor-content` is `overflow-y: auto`). A mask you can't see is worse
// than a dialog you have to scroll, so the photo keeps a floor share of the
// height budget even when the controls would rather have it.
const MIN_CANVAS = 120;
const MIN_CANVAS_SHARE = 0.3;
// The <=768px layout is built to scroll (see the media block in ai-designer.css),
// so there the image keeps the generous half-viewport it has always had.
const MOBILE_CANVAS_SHARE = 0.5;
// Cap on the measure/scale iterations below (each one is a forced reflow).
const MAX_FIT_PASSES = 6;

export function createMaskFit() {
  let naturalW = 0;
  let naturalH = 0;
  let resizeHandler = null;
  let rafId = 0;

  function parts() {
    const modal = document.getElementById('mask-editor-modal');
    if (!modal || !modal.classList.contains('active')) return null;
    const content = /** @type {HTMLElement} */ (modal.querySelector('.mask-editor-content'));
    const container = /** @type {HTMLElement} */ (modal.querySelector('.mask-editor-canvas-container'));
    const canvases = /** @type {NodeListOf<HTMLCanvasElement>} */ (modal.querySelectorAll('canvas.mask-editor-canvas'));
    if (!content || !container || !canvases.length) return null;
    return { content, container, canvases };
  }

  // Height of everything except the image. Measured at a specific image width
  // because the dialog hugs its content: a narrower image means a narrower
  // dialog, which re-wraps the hint/label rows and changes the chrome height.
  function chromeHeightAt(content, container, width) {
    const prevWidth = container.style.width;
    const prevHeight = container.style.height;
    container.style.width = width + 'px';
    container.style.height = '0px';
    const height = content.getBoundingClientRect().height;
    container.style.width = prevWidth;
    container.style.height = prevHeight;
    return height;
  }

  function setImage(width, height) {
    naturalW = width || 0;
    naturalH = height || 0;
  }

  function fit() {
    const el = parts();
    if (!el || !naturalW || !naturalH) return;
    const { content, container, canvases } = el;

    const vv = window.visualViewport;
    const viewportW = (vv && vv.width) || window.innerWidth;
    const viewportH = (vv && vv.height) || window.innerHeight;

    // `.mask-editor-content` is capped at 90vw/90vh inside a 20px-padded modal,
    // so this is the box the whole dialog has to live in.
    const boxW = Math.min(viewportW * 0.9, viewportW - MODAL_PADDING * 2);
    const boxH = Math.min(viewportH * 0.9, viewportH - MODAL_PADDING * 2);

    const contentStyle = getComputedStyle(content);
    const containerStyle = getComputedStyle(container);
    const insetX = parseFloat(contentStyle.paddingLeft) + parseFloat(contentStyle.paddingRight)
      + parseFloat(containerStyle.borderLeftWidth) + parseFloat(containerStyle.borderRightWidth);
    const availW = Math.max(MIN_CANVAS, boxW - insetX);
    const floorH = window.matchMedia('(max-width: 768px)').matches
      ? viewportH * MOBILE_CANVAS_SHARE
      : Math.max(MIN_CANVAS, boxH * MIN_CANVAS_SHARE);

    // Iterate to a fixed point: a shorter image is a narrower image, a narrower
    // dialog re-wraps the hint/label rows, and taller chrome shortens the image
    // again. Width only ever decreases, so this settles in a pass or three —
    // at the fixed point chrome + image is exactly the height budget.
    let width = Math.min(naturalW, availW);
    let height = Math.round(naturalH * (width / naturalW));
    let settled = false;
    for (let pass = 0; pass < MAX_FIT_PASSES && !settled; pass++) {
      const availH = Math.max(floorH, boxH - chromeHeightAt(content, container, width));
      const scale = Math.min(availW / naturalW, availH / naturalH, 1);
      const nextWidth = Math.round(naturalW * scale);
      settled = nextWidth === width;
      width = nextWidth;
      height = Math.round(naturalH * scale);
    }

    // Only if it never settled: re-check against the width it ended on and, if
    // that still doesn't fit, take the overshoot off both axes together so the
    // photo stays in proportion.
    if (!settled) {
      const lastAvailH = Math.max(floorH, boxH - chromeHeightAt(content, container, width));
      if (height > lastAvailH) {
        const scale = lastAvailH / naturalH;
        width = Math.round(naturalW * scale);
        height = Math.round(naturalH * scale);
      }
    }

    canvases.forEach((canvas) => {
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
    });
  }

  function bind() {
    if (resizeHandler) return;
    // Coalesce bursts (drag-resize, mobile URL-bar collapse) into one reflow.
    resizeHandler = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => { rafId = 0; fit(); });
    };
    window.addEventListener('resize', resizeHandler);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', resizeHandler);
  }

  function unbind() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (!resizeHandler) return;
    window.removeEventListener('resize', resizeHandler);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', resizeHandler);
    resizeHandler = null;
  }

  return { setImage, fit, bind, unbind };
}
