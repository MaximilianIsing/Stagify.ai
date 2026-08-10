/* Stagify.ai — #testimonials, the six-quote deck.
 *
 * The section used to be a two-up grid of two cards. It now holds six, which a grid
 * cannot carry: six cards ran about five screens tall between the two heaviest blocks
 * on the page, and the phone rule (`.tw-card:nth-child(n + 2) { display: none }`)
 * "solved" that by showing a phone visitor exactly ONE quote and discarding the rest.
 *
 * So: a deck. One readable card, the others fanned behind it, advanced by dragging the
 * top card away, by the arrows, or by the arrow keys. Same widget at every width — a
 * swipe is the native gesture on touch, so there is no second layout to maintain.
 *
 * PROGRESSIVE ENHANCEMENT IS THE CONTRACT. Every deck rule in home.css is scoped
 * behind `.tw-deck--ready`, which this module adds at the END of init. If this file
 * fails to load, throws, or is served stale, the section stays what the markup
 * literally is: a plain column of six readable quotes with the controls hidden.
 * Nothing is hidden by default and no quote is unreachable without JS.
 *
 * WHY THE CARDS STAY IN THE DOM. All six are always present and always in the HTML —
 * only `inert` moves. That keeps every testimonial crawlable (this section is social
 * proof; it should be indexed) while keeping the buried cards, which show as ~12px
 * slivers with no readable text, out of the tab order and off the screen-reader path.
 */

/** Drag distance, in px, past which the release throws the card instead of springing back. */
const THROW_PX = 90;

/** How far off-screen a thrown card flies. Comfortably past any card width we use. */
const FLY_PX = 640;

/** Matches the .is-flying transition in home.css. */
const FLY_MS = 420;

/**
 * @typedef {object} DragState
 * @property {number} x         clientX where the press started
 * @property {HTMLElement} card the card being dragged (always the top one)
 */

/**
 * Exported so test/frontend/home-testimonials.test.js can drive it against a fake DOM.
 *
 * @param {{ reducedMotion?: boolean }} [opts] injected in tests; defaults to the media query
 * @returns {boolean} true if a deck was found and wired
 */
export function initTestimonialDeck(opts = {}) {
  const deck = /** @type {HTMLElement|null} */ (document.querySelector('[data-deck]'));
  if (!deck) return false;

  const stack = /** @type {HTMLElement|null} */ (deck.querySelector('[data-deck-stack]'));
  if (!stack) return false;

  const cards = /** @type {HTMLElement[]} */ (
    Array.prototype.slice.call(stack.querySelectorAll('.tw-card'))
  );
  // One card is not a deck. Bail and leave the plain column — better than a dead
  // widget with arrows that cycle a single quote.
  if (cards.length < 2) return false;

  const prevBtn = /** @type {HTMLButtonElement|null} */ (deck.querySelector('[data-deck-prev]'));
  const nextBtn = /** @type {HTMLButtonElement|null} */ (deck.querySelector('[data-deck-next]'));
  const atEl = deck.querySelector('[data-deck-at]');
  const ofEl = deck.querySelector('[data-deck-of]');

  const reducedMotion =
    typeof opts.reducedMotion === 'boolean'
      ? opts.reducedMotion
      : Boolean(
          typeof window !== 'undefined' &&
            window.matchMedia &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches
        );

  /** Positions into `cards`. order[0] is the top card; advancing rotates the array. */
  let order = cards.map((_, i) => i);

  /** @type {DragState|null} */
  let drag = null;

  /** Written from cards.length rather than trusted from the markup, so adding a
   *  seventh testimonial does not silently leave the total reading "6". */
  if (ofEl) ofEl.textContent = String(cards.length);

  function paint() {
    order.forEach((cardIdx, pos) => {
      const card = cards[cardIdx];
      card.style.setProperty('--i', String(pos));
      // data-i drives the "only four layers are visible" rule in home.css. Kept as an
      // attribute rather than another custom property because CSS cannot select on a
      // custom property's value.
      card.dataset.i = String(pos);
      if (pos === 0) {
        card.dataset.top = '';
        card.removeAttribute('inert');
      } else {
        delete card.dataset.top;
        card.setAttribute('inert', '');
      }
    });
    if (atEl) atEl.textContent = String(order[0] + 1);
  }

  function next() {
    order = order.slice(1).concat(order[0]);
    paint();
  }

  function prev() {
    order = [order[order.length - 1]].concat(order.slice(0, -1));
    paint();
  }

  /**
   * Throw the top card off screen, then advance. With reduced motion the card is not
   * animated out at all — it just advances, so nothing flies across the viewport.
   *
   * @param {HTMLElement} card
   * @param {number} dx direction of the throw; sign is all that matters
   */
  function fling(card, dx) {
    if (reducedMotion) {
      card.style.transform = '';
      next();
      return;
    }
    card.classList.add('is-flying');
    const to = dx > 0 ? FLY_PX : -FLY_PX;
    card.style.transform = `translateX(${to}px) rotate(${dx > 0 ? 22 : -22}deg)`;
    window.setTimeout(() => {
      card.classList.remove('is-flying');
      card.style.transform = '';
      next();
    }, FLY_MS);
  }

  cards.forEach((card) => {
    card.addEventListener('pointerdown', (e) => {
      // Buried cards have pointer-events:none in CSS, but check anyway: a stale paint
      // or a CSS load failure should not let a drag start on the wrong card.
      if (card.dataset.top === undefined) return;
      drag = { x: e.clientX, card };
      card.classList.add('is-dragging');
      if (card.setPointerCapture) card.setPointerCapture(e.pointerId);
    });

    card.addEventListener('pointermove', (e) => {
      if (!drag || drag.card !== card) return;
      const dx = e.clientX - drag.x;
      card.style.transform = `translateX(${dx}px) rotate(${dx / 26}deg)`;
    });

    /** @param {PointerEvent} e */
    function release(e) {
      if (!drag || drag.card !== card) return;
      const dx = e.clientX - drag.x;
      drag = null;
      card.classList.remove('is-dragging');
      if (Math.abs(dx) > THROW_PX) fling(card, dx);
      // Spring back: clearing the inline transform hands the card back to the CSS
      // fan, and the .tw-card transition animates the return for free.
      else card.style.transform = '';
    }

    card.addEventListener('pointerup', release);
    card.addEventListener('pointercancel', release);
  });

  if (prevBtn) prevBtn.addEventListener('click', prev);
  if (nextBtn) nextBtn.addEventListener('click', next);

  // The stack is only a widget once this module runs, so its interactive semantics are
  // added here rather than sitting in the markup lying about a deck that may not exist.
  // The aria-label itself IS in the markup, via data-lang-attr, so language-loader.js
  // keeps it translated on a language switch — one set from here would go stale.
  stack.setAttribute('role', 'group');
  stack.setAttribute('tabindex', '0');
  stack.addEventListener('keydown', (e) => {
    const key = /** @type {KeyboardEvent} */ (e).key;
    if (key === 'ArrowRight' || key === 'ArrowDown') {
      e.preventDefault();
      next();
    } else if (key === 'ArrowLeft' || key === 'ArrowUp') {
      e.preventDefault();
      prev();
    } else if (key === 'Home') {
      e.preventDefault();
      order = cards.map((_, i) => i);
      paint();
    }
  });

  paint();
  deck.classList.add('tw-deck--ready');
  return true;
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initTestimonialDeck());
  } else {
    // index-deferred.js injects this module after `load`, so DOMContentLoaded fired
    // long ago — a bare listener would never run and the deck would silently never
    // arm, leaving the plain six-quote column. See the trap note in index-deferred.js.
    initTestimonialDeck();
  }
}
