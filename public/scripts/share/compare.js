// The before/after comparison — the one thing on this page a seller is actually looking
// for, and the one control that has to work on a phone held in one hand.
//
// THREE INPUT MODES, ONE STATE. Pointer (which covers mouse, touch and pen in one code
// path), keyboard on a real <button>, and nothing else. The position lives in a single
// number and every mode goes through `setPosition`, so there is no way for the handle and
// the clip to disagree — which is the classic failure of the two-listener version of this
// widget, where the touch path updates one and the mouse path updates the other.
//
// WHY THE HANDLE IS A <button role="slider">. It has to be reachable by Tab, operable by
// arrow keys, and announced as an adjustable value. A <div tabindex="0"> gets none of that
// for free and loses the focus ring the moment somebody restyles it. `aria-valuenow` is
// kept in sync on every change, and the visible focus ring is in share.css with a
// `:focus-visible` rule that is NOT removed by the reset.
//
// WHY THE CLIP IS `clip-path` AND NOT `width`. Clipping a wrapper whose image is already
// laid out at full size reveals the original in place. Sizing the wrapper instead squashes
// the image horizontally as the handle moves — subtle at 50%, grotesque at 10%, and it is
// somebody's living room.
//
// A FRAME WITH NO ORIGINAL GETS NO SLIDER AT ALL. When the broker did not opt into the
// before view — or that particular frame has no source photo — `createCompare` returns a
// plain figure with the staged image. Not a disabled handle, not a slider over two copies
// of the same picture: no control, because there is nothing to compare.

import { el } from './dom.js';

/** Where the divider sits before anybody touches it. */
export const DEFAULT_POSITION = 50;

/** Arrow-key step, in percent. Home/End jump to the ends; Page keys move by five steps. */
const STEP = 4;

/**
 * @typedef {object} CompareSources
 * @property {string} stagedSrc
 * @property {string|null} originalSrc
 * @property {number|null} width
 * @property {number|null} height
 * @property {string} stagedAlt
 * @property {string} originalAlt
 */

/**
 * @typedef {object} CompareHandle
 * @property {any} node - The element to insert.
 * @property {boolean} interactive - False when this frame rendered as a bare image.
 * @property {(percent: number) => void} setPosition
 * @property {() => number} getPosition
 * @property {() => boolean} consumeDrag - True once after a gesture that MOVED the
 *   divider, so the frame's tap-to-zoom can tell a drag from a tap.
 */

/**
 * Clamp to the 0–100 the slider is defined over, rounding to whole percent so
 * `aria-valuenow` reads as an integer rather than 43.2857142857.
 * @param {number} value
 * @returns {number}
 */
function clampPercent(value) {
  if (!Number.isFinite(value)) return DEFAULT_POSITION;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * The `aspect-ratio` style for a frame, so the box occupies its final size before a single
 * byte of image has arrived. Without it a lazily-loaded gallery jumps under the reader's
 * thumb as each image resolves, which on a long listing is the difference between a
 * gallery and a fairground ride.
 * @param {number|null} width
 * @param {number|null} height
 * @returns {Record<string, string>}
 */
function ratioStyle(width, height) {
  return width && height ? { 'aspect-ratio': `${width} / ${height}` } : {};
}

/**
 * The staged image itself. Lazy and async-decoded everywhere: a 40-frame listing is 80
 * images, and the browser must be free to fetch none of them until they approach the
 * viewport.
 * @param {Document} doc
 * @param {string} src
 * @param {string} alt
 * @param {number|null} width
 * @param {number|null} height
 * @param {string} className
 * @returns {any}
 */
function image(doc, src, alt, width, height, className) {
  return el(doc, 'img', {
    className,
    attrs: {
      src,
      alt,
      loading: 'lazy',
      decoding: 'async',
      width: width ?? false,
      height: height ?? false,
      draggable: 'false',
    },
  });
}

/**
 * Build the comparison for one frame.
 *
 * @param {Document} doc
 * @param {CompareSources} sources
 * @param {{ beforeLabel?: string, afterLabel?: string, handleLabel?: string }} [labels]
 * @returns {CompareHandle}
 */
export function createCompare(doc, sources, labels = {}) {
  const ratio = ratioStyle(sources.width, sources.height);
  const staged = image(doc, sources.stagedSrc, sources.stagedAlt, sources.width, sources.height, 'sh-frame__img');

  if (!sources.originalSrc) {
    const plain = el(doc, 'div', { className: 'sh-frame__plate', style: ratio, children: [staged] });
    return {
      node: plain,
      interactive: false,
      setPosition: () => {},
      getPosition: () => 100,
      consumeDrag: () => false,
    };
  }

  const beforeLabel = labels.beforeLabel || 'Before';
  const afterLabel = labels.afterLabel || 'After';

  const original = image(
    doc,
    sources.originalSrc,
    sources.originalAlt,
    sources.width,
    sources.height,
    'sh-frame__img',
  );
  const beforeLayer = el(doc, 'div', { className: 'sh-compare__before', children: [original] });

  const handle = el(doc, 'button', {
    className: 'sh-compare__handle',
    attrs: {
      type: 'button',
      role: 'slider',
      'aria-orientation': 'horizontal',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': String(DEFAULT_POSITION),
      'aria-valuetext': `${DEFAULT_POSITION}% original`,
      'aria-label': labels.handleLabel || 'Drag, or use the arrow keys, to compare the original photo with the staged one',
    },
  });

  const root = el(doc, 'div', {
    className: 'sh-compare',
    style: { ...ratio, '--sh-pos': `${DEFAULT_POSITION}%` },
    children: [
      staged,
      beforeLayer,
      el(doc, 'span', { className: 'sh-compare__tag sh-compare__tag--before', text: beforeLabel, attrs: { 'aria-hidden': 'true' } }),
      el(doc, 'span', { className: 'sh-compare__tag sh-compare__tag--after', text: afterLabel, attrs: { 'aria-hidden': 'true' } }),
      handle,
    ],
  });

  let position = DEFAULT_POSITION;
  let dragging = false;
  let moved = false;

  /**
   * The single writer. Everything else — pointer, keyboard, the initial paint — calls it.
   * @param {number} percent
   */
  const setPosition = (percent) => {
    position = clampPercent(percent);
    root.style.setProperty('--sh-pos', `${position}%`);
    handle.setAttribute('aria-valuenow', String(position));
    handle.setAttribute('aria-valuetext', `${position}% original`);
  };

  /**
   * Turn a viewport x-coordinate into a percentage of the frame's width.
   * `getBoundingClientRect` is absent in the test document and zero-width for a frame that
   * has not been laid out yet; both are ignored rather than resolving to NaN or 0, which
   * would slam the divider to one edge on the first stray event.
   * @param {number} clientX
   */
  const trackTo = (clientX) => {
    const rect = typeof root.getBoundingClientRect === 'function' ? root.getBoundingClientRect() : null;
    if (!rect || !rect.width) return;
    setPosition(((clientX - rect.left) / rect.width) * 100);
  };

  root.addEventListener('pointerdown', (event) => {
    // Only the primary button; a right-click should open the context menu, not grab the
    // divider and leave it stuck because no pointerup ever arrives.
    if (event && typeof event.button === 'number' && event.button !== 0) return;
    dragging = true;
    moved = false;
    if (typeof root.setPointerCapture === 'function' && event && event.pointerId !== undefined) {
      try {
        root.setPointerCapture(event.pointerId);
      } catch {
        // Capture is an optimisation; without it the move listener still fires while the
        // pointer is over the frame.
      }
    }
    if (event && typeof event.clientX === 'number') trackTo(event.clientX);
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
  });

  root.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    moved = true;
    if (event && typeof event.clientX === 'number') trackTo(event.clientX);
  });

  const endDrag = () => {
    dragging = false;
  };
  root.addEventListener('pointerup', endDrag);
  root.addEventListener('pointercancel', endDrag);
  root.addEventListener('lostpointercapture', endDrag);

  handle.addEventListener('keydown', (event) => {
    const key = event && event.key;
    /** @type {number|null} */
    let next = null;
    if (key === 'ArrowLeft' || key === 'ArrowDown') next = position - STEP;
    else if (key === 'ArrowRight' || key === 'ArrowUp') next = position + STEP;
    else if (key === 'PageDown') next = position - STEP * 5;
    else if (key === 'PageUp') next = position + STEP * 5;
    else if (key === 'Home') next = 0;
    else if (key === 'End') next = 100;
    if (next === null) return;
    // The frame's tap-to-zoom listens on the whole plate; without this, every arrow press
    // that bubbles as a click-like activation would also open the lightbox.
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    moved = true;
    setPosition(next);
  });

  // A click ON the handle is part of the drag gesture, never a request to zoom.
  handle.addEventListener('click', (event) => {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
  });

  setPosition(DEFAULT_POSITION);

  return {
    node: root,
    interactive: true,
    setPosition,
    getPosition: () => position,
    consumeDrag: () => {
      const was = moved;
      moved = false;
      return was;
    },
  };
}
