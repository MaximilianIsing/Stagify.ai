// Full-screen viewing, and the focus management that makes it usable rather than a trap.
//
// A lightbox is the single most common place a page loses keyboard users, and this repo
// has already shipped one that did (see test/frontend/dialog-a11y.test.js — the AI
// Designer's close control was a <span>). The four things that matter are done here
// explicitly and none of them is free:
//
//   1. `role="dialog"` + `aria-modal="true"` + `aria-label`, so it announces as a dialog
//      rather than as "clickable group".
//   2. Tab is CYCLED between the controls this module owns. Not "Escape works, good
//      enough": without the cycle, Tab walks out of the overlay into a gallery the reader
//      cannot see, and the focus ring vanishes off-screen.
//   3. Focus is RESTORED to the element that opened it. Losing focus to <body> sends the
//      next Tab back to the top of the document, which on this page means re-traversing
//      the whole listing.
//   4. The page behind is marked `aria-hidden` while it is open, so a screen reader's
//      virtual cursor cannot wander into it.
//
// Navigation is deliberately three ways — arrow keys, on-screen buttons, and a horizontal
// swipe — because the two audiences for this link are a seller on a laptop and a buyer on
// a phone, and neither should have to discover the other's affordance.

import { el, setHidden } from './dom.js';

/** How far a touch must travel horizontally to count as a swipe rather than a scroll. */
const SWIPE_PX = 40;

/**
 * @typedef {object} LightboxSlide
 * @property {string} src
 * @property {string} alt
 * @property {string} caption - Room label; shown in the bar and used for the count line.
 * @property {number|null} width
 * @property {number|null} height
 */

/**
 * @typedef {object} Lightbox
 * @property {any} node
 * @property {(slides: LightboxSlide[]) => void} setSlides
 * @property {(index: number, trigger?: any) => void} open
 * @property {() => void} close
 * @property {() => boolean} isOpen
 * @property {() => number} index
 * @property {() => void} destroy
 */

/**
 * Build the (initially hidden) viewer. Nothing is appended to the document here — the
 * caller mounts `node` where it wants it, which keeps this module free of assumptions
 * about the page.
 *
 * @param {Document} doc
 * @param {{ label?: string, backdropCloses?: boolean }} [options]
 * @returns {Lightbox}
 */
export function createLightbox(doc, options = {}) {
  /** @type {LightboxSlide[]} */
  let slides = [];
  let current = 0;
  let visible = false;
  /** @type {any} */
  let trigger = null;
  /** @type {any} */
  let pageRoot = null;
  let touchStartX = 0;
  let touchTracking = false;

  const picture = el(doc, 'img', {
    className: 'sh-lightbox__img',
    attrs: { alt: '', decoding: 'async' },
  });

  const caption = el(doc, 'p', { className: 'sh-lightbox__caption' });
  const counter = el(doc, 'p', { className: 'sh-lightbox__counter' });

  const closeButton = el(doc, 'button', {
    className: 'sh-lightbox__close',
    text: '×',
    attrs: { type: 'button', 'aria-label': 'Close the full-screen view' },
  });
  const prevButton = el(doc, 'button', {
    className: 'sh-lightbox__nav sh-lightbox__nav--prev',
    text: '‹',
    attrs: { type: 'button', 'aria-label': 'Previous photo' },
  });
  const nextButton = el(doc, 'button', {
    className: 'sh-lightbox__nav sh-lightbox__nav--next',
    text: '›',
    attrs: { type: 'button', 'aria-label': 'Next photo' },
  });

  const stage = el(doc, 'div', { className: 'sh-lightbox__stage', children: [picture] });

  const node = el(doc, 'div', {
    className: 'sh-lightbox',
    attrs: {
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': options.label || 'Photo viewer',
      hidden: '',
      tabindex: '-1',
    },
    children: [
      el(doc, 'div', {
        className: 'sh-lightbox__bar',
        children: [
          el(doc, 'div', { className: 'sh-lightbox__meta', children: [caption, counter] }),
          closeButton,
        ],
      }),
      stage,
      prevButton,
      nextButton,
    ],
  });

  /** The controls Tab is allowed to reach, in visual order. */
  const focusables = () => [closeButton, prevButton, nextButton].filter((control) => !control.disabled);

  /** Paint the current slide. Cheap enough to run on every navigation. */
  const paint = () => {
    const slide = slides[current];
    if (!slide) return;
    picture.setAttribute('src', slide.src);
    picture.setAttribute('alt', slide.alt);
    if (slide.width) picture.setAttribute('width', String(slide.width));
    if (slide.height) picture.setAttribute('height', String(slide.height));
    caption.textContent = slide.caption;
    counter.textContent = `${current + 1} of ${slides.length}`;
    const single = slides.length < 2;
    setHidden(prevButton, single);
    setHidden(nextButton, single);
    prevButton.disabled = single;
    nextButton.disabled = single;
  };

  /**
   * Move by `delta`, wrapping. Wrapping rather than stopping at the ends is the right call
   * for a gallery of one property: there is no "end of the internet" to protect, and a
   * dead arrow key at frame 1 reads as a broken button.
   * @param {number} delta
   */
  const step = (delta) => {
    if (slides.length < 2) return;
    current = (current + delta + slides.length) % slides.length;
    paint();
  };

  const close = () => {
    if (!visible) return;
    visible = false;
    setHidden(node, true);
    if (doc.body) doc.body.classList.remove('sh-locked');
    if (pageRoot) pageRoot.removeAttribute('aria-hidden');
    // Release the bytes: a full-resolution render left in an <img> that nobody can see is
    // the largest thing on the page.
    picture.setAttribute('src', '');
    const restoreTo = trigger;
    trigger = null;
    if (restoreTo && typeof restoreTo.focus === 'function') restoreTo.focus();
  };

  closeButton.addEventListener('click', close);
  prevButton.addEventListener('click', () => step(-1));
  nextButton.addEventListener('click', () => step(1));

  if (options.backdropCloses !== false) {
    node.addEventListener('click', (event) => {
      // Only the backdrop itself — a click that landed on the photo or a control has
      // already been handled, and closing on it would make the viewer feel unusable.
      if (event && event.target === node) close();
    });
  }

  node.addEventListener('keydown', (event) => {
    const key = event && event.key;
    if (key === 'Escape') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      close();
      return;
    }
    if (key === 'ArrowLeft') {
      step(-1);
      return;
    }
    if (key === 'ArrowRight') {
      step(1);
      return;
    }
    if (key !== 'Tab') return;

    // The trap. Tab is cancelled unconditionally and focus is moved by hand around this
    // module's OWN control list, so the cycle cannot leak into the gallery behind the
    // overlay — and an `activeElement` that is not one of ours (the dialog itself, on the
    // very first Tab) simply starts at the beginning of the list rather than falling
    // through to the document.
    const controls = focusables();
    if (!controls.length) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    const active = doc.activeElement;
    const at = controls.indexOf(active);
    const offset = event.shiftKey ? -1 : 1;
    const nextIndex = at === -1
      ? (event.shiftKey ? controls.length - 1 : 0)
      : (at + offset + controls.length) % controls.length;
    const target = controls[nextIndex];
    if (target && typeof target.focus === 'function') target.focus();
  });

  stage.addEventListener('touchstart', (event) => {
    const touch = event && event.touches && event.touches[0];
    if (!touch) return;
    touchStartX = touch.clientX;
    touchTracking = true;
  });
  stage.addEventListener('touchend', (event) => {
    if (!touchTracking) return;
    touchTracking = false;
    const touch = event && event.changedTouches && event.changedTouches[0];
    if (!touch) return;
    const delta = touch.clientX - touchStartX;
    if (Math.abs(delta) < SWIPE_PX) return;
    step(delta < 0 ? 1 : -1);
  });

  return {
    node,

    setSlides(next) {
      slides = Array.isArray(next) ? next : [];
      if (current >= slides.length) current = 0;
    },

    open(index, from) {
      if (!slides.length) return;
      current = Math.min(Math.max(Number(index) || 0, 0), slides.length - 1);
      trigger = from || null;
      visible = true;
      pageRoot = typeof doc.getElementById === 'function' ? doc.getElementById('sh-root') : null;
      if (pageRoot) pageRoot.setAttribute('aria-hidden', 'true');
      if (doc.body) doc.body.classList.add('sh-locked');
      setHidden(node, false);
      paint();
      if (typeof closeButton.focus === 'function') closeButton.focus();
    },

    close,
    isOpen: () => visible,
    index: () => current,

    destroy() {
      close();
      if (node.parentNode && typeof node.parentNode.removeChild === 'function') {
        node.parentNode.removeChild(node);
      }
    },
  };
}
