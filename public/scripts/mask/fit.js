// Sizes a mask editor's canvases to the room its dialog ACTUALLY has.
//
// The naive sizing — hand the image a flat fraction of the viewport height and
// let flex sort out the rest — over-commits: the header, tool row, brush slider,
// prompt, reference block and buttons need roughly 300px more, and the dialog is
// capped near the viewport height. On a short window the column overflows. What
// happens next depends on the dialog's CSS: the AI Designer's canvas container
// sets `overflow: hidden`, which drops a flex item's automatic minimum size to 0,
// so flex silently shrank the image box while the canvas kept its explicit pixel
// height and the photo was CLIPPED. The stage editor's content scrolls instead,
// so nothing was cut off — but the prompt field and the Apply button ended up
// below the fold, which is its own kind of broken.
//
// So instead of guessing: measure the chrome with the image collapsed, give the
// image whatever height is left, and scale it proportionally.
//
// The two dialogs sit in different CSS regimes, which is why the box maths is
// parameterised rather than hardcoded:
//
//                    modal padding   max-width          max-height
//   AI Designer      20px            90vw               90vh
//   stage editor     16px            min(920px, 100%)   calc(100vh - 32px)
//
//   createMaskFit({ getModal, contentSelector, containerSelector, canvasSelector, ... })
//     -> { setImage, fit, bind, unbind }

// Never scale the image away entirely; below these the dialog scrolls instead
// (both contents are `overflow-y: auto`). A mask you can't see is worse than a
// dialog you have to scroll, so the photo keeps a floor share of the budget even
// when the controls would rather have it.
const MIN_CANVAS = 120;
const MIN_CANVAS_SHARE = 0.3;
// The <=768px layouts are built to scroll, so there the image keeps the generous
// half-viewport it has always had.
const MOBILE_CANVAS_SHARE = 0.5;
// Cap on the measure/scale iterations below (each one is a forced reflow).
const MAX_FIT_PASSES = 6;

/**
 * @param {{
 *   getModal: () => HTMLElement | null,
 *   contentSelector: string,
 *   containerSelector: string,
 *   canvasSelector: string,
 *   modalPadding?: number,
 *   widthShare?: number,
 *   heightShare?: number,
 *   maxContentWidth?: number,
 * }} config - The dialog's elements plus the three numbers describing how its
 *   stylesheet caps the content box.
 */
export function createMaskFit({
  getModal,
  contentSelector,
  containerSelector,
  canvasSelector,
  modalPadding = 20,
  widthShare = 0.9,
  heightShare = 0.9,
  maxContentWidth = Infinity,
}) {
  let naturalW = 0;
  let naturalH = 0;
  let resizeHandler = null;
  let rafId = 0;

  function parts() {
    const modal = getModal();
    if (!modal || !modal.classList.contains('active')) return null;
    const content = /** @type {HTMLElement} */ (modal.querySelector(contentSelector));
    const container = /** @type {HTMLElement} */ (modal.querySelector(containerSelector));
    const canvases = /** @type {NodeListOf<HTMLCanvasElement>} */ (modal.querySelectorAll(canvasSelector));
    if (!content || !container || !canvases.length) return null;
    return { content, container, canvases };
  }

  // Height of everything except the image. Measured at a specific image width
  // because a dialog that hugs its content gets narrower with a narrower image,
  // which re-wraps the hint/label rows and changes the chrome height. (A
  // fixed-width dialog is unaffected — the loop below just settles immediately.)
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

    // The box the whole dialog has to live in, per its own stylesheet's caps.
    const boxW = Math.min(viewportW * widthShare, viewportW - modalPadding * 2, maxContentWidth);
    const boxH = Math.min(viewportH * heightShare, viewportH - modalPadding * 2);

    const contentStyle = getComputedStyle(content);
    const containerStyle = getComputedStyle(container);
    const insetX = parseFloat(contentStyle.paddingLeft) + parseFloat(contentStyle.paddingRight)
      + parseFloat(containerStyle.borderLeftWidth) + parseFloat(containerStyle.borderRightWidth);
    const availW = Math.max(MIN_CANVAS, boxW - insetX);
    const floorH = window.matchMedia('(max-width: 768px)').matches
      ? viewportH * MOBILE_CANVAS_SHARE
      : Math.max(MIN_CANVAS, boxH * MIN_CANVAS_SHARE);

    // Iterate to a fixed point: a shorter image can be a narrower image, a
    // narrower dialog re-wraps rows, and taller chrome shortens the image again.
    // Width only ever decreases, so this settles in a pass or three — at the
    // fixed point chrome + image is exactly the height budget.
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
