// The #learn section's four photo strips ("What virtual staging is, and why it sells").
//
// WHAT THIS OWNS
//   - which strip is open, and the aria-expanded state that goes with it
//   - opening on hover (fine pointers only), on click, and on keyboard focus
//   - arrow-key movement between the four headers
//
// WHY IT REPLACED FOUR STACKED ROWS. The section used to be four image-beside-text
// rows: ~1,780px, a sixth of the homepage, for four paragraphs. As strips it is one
// fixed-height row of four panels — about a third of the height, and nothing below it
// moves when you switch between them.
//
// PROGRESSIVE ENHANCEMENT, same contract as studio-showcase.js. The markup ships as
// four plain stacked photo cards with every panel open, and only becomes a strip widget
// once this file adds `.hstrips--ready` (see the fallback block in styles/home.css).
// That matters more here than usual: index-deferred.js injects this script after
// `load`, so every visitor sees the un-upgraded markup first, and any failure that
// keeps this module from running — JS off, a 404, a parse error anywhere in the
// injected batch, no ES-module support — has to land on something readable.
//
// THE `.is-open` CLASS IS LOAD-BEARING FOR MORE THAN LAYOUT. The checklist stagger in
// home.css keys off it. It used to key off home-reveal.js's scroll-driven
// `.is-visible`, which fires while the panel is still collapsed — the animation was
// spent before anyone could open it.

/**
 * Below this width four vertical spines leave no room for any of them to open, so the
 * strips fall back to a stack. Mirrors the `@media (max-width: 900px)` block for
 * `.hstrips--ready` in styles/home.css — move one and you must move the other.
 * test/frontend/home-strips.test.js fails if they drift apart.
 */
export const FLAT_QUERY = '(max-width: 900px)';

/** Keys that move between headers, mapped to how they move. */
const ARROW_KEYS = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'];

/**
 * Where a key press should move focus, given where it is now.
 *
 * Split out as a pure function so the wrap-around is testable without a DOM — an
 * off-by-one here is invisible until someone actually arrows off the end of the strip.
 * Down/Up are accepted alongside Right/Left because below 900px the strips are stacked,
 * and the vertical arrows are what that layout implies.
 *
 * @param {string} key
 * @param {number} current index of the focused header
 * @param {number} count number of strips
 * @returns {number} the index to move to, or -1 when the key means nothing here
 */
export function indexForKey(key, current, count) {
  if (count <= 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0;
  if (step === 0) return -1;
  return ((current + step) % count + count) % count;
}

/** @returns {boolean} whether the pointer can hover — a phone tap must not "hover". */
function canHover() {
  return !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);
}

/**
 * @typedef {object} Strips
 * @property {HTMLElement} root
 * @property {HTMLElement[]} strips
 * @property {HTMLButtonElement[]} buttons
 * @property {number} active
 */

/**
 * Open strip `n` and close the rest.
 *
 * One is ALWAYS open — there is no all-closed state. Four collapsed spines with no copy
 * beside them is not a resting state anyone would choose; it reads as broken.
 *
 * @param {Strips} sc
 * @param {number} n
 */
function open(sc, n) {
  const i = ((n % sc.strips.length) + sc.strips.length) % sc.strips.length;
  sc.active = i;
  sc.strips.forEach((strip, j) => {
    const on = j === i;
    strip.classList.toggle('is-open', on);
    sc.buttons[j].setAttribute('aria-expanded', String(on));
  });
}

/**
 * @param {Strips} sc
 */
function wire(sc) {
  sc.strips.forEach((strip, i) => {
    const btn = sc.buttons[i];

    btn.addEventListener('click', () => open(sc, i));

    // The WHOLE collapsed strip is the target, not just its heading. On a phone the
    // heading is a ~40px bar at the bottom of a 104px panel, so two thirds of what
    // looks like a button did nothing — and on a wide screen a collapsed spine's
    // button is a narrow ribbon down one edge, with the rest of the photo inert.
    // Guarded on the collapsed state so a click inside the OPEN panel is left alone:
    // that is where the copy is, and selecting it must not re-trigger anything.
    strip.addEventListener('click', () => {
      if (!strip.classList.contains('is-open')) open(sc, i);
    });

    // Hover opens on a desktop pointer — that is the whole appeal of the pattern. On
    // the strip rather than the button for the same reach reason as the click above.
    strip.addEventListener('mouseenter', () => {
      if (canHover()) open(sc, i);
    });

    // Focus opens too, so tabbing through the section reveals each panel's copy
    // instead of walking past four closed spines. Without this a keyboard visitor can
    // reach a header but has to press Enter to see anything, while a mouse visitor
    // gets it for free.
    btn.addEventListener('focus', () => open(sc, i));
  });

  sc.root.addEventListener('keydown', (e) => {
    if (!ARROW_KEYS.includes(e.key)) return;
    const current = sc.buttons.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    if (current < 0) return;
    const next = indexForKey(e.key, current, sc.buttons.length);
    if (next < 0) return;
    // Only now — an unhandled arrow key must still scroll the page.
    e.preventDefault();
    sc.buttons[next].focus();
  });
}

/**
 * @param {HTMLElement} root
 * @returns {Strips|null}
 */
function build(root) {
  const strips = /** @type {HTMLElement[]} */ ([].slice.call(root.querySelectorAll('.hstrip')));
  const buttons = /** @type {HTMLButtonElement[]} */ ([].slice.call(root.querySelectorAll('.hstrip__btn')));
  if (strips.length < 2 || buttons.length !== strips.length) return null;
  return { root, strips, buttons, active: 0 };
}

function init() {
  const root = /** @type {HTMLElement|null} */ (document.querySelector('[data-strips]'));
  if (!root) return;
  const sc = build(root);
  // Leave the markup completely alone rather than half-upgrading it: the CSS fallback
  // keeps the strips as four readable photo cards for as long as .hstrips--ready is
  // absent, and a half-built widget is worse than none.
  if (!sc) return;

  wire(sc);

  // THE UPGRADE ITSELF MUST NOT ANIMATE. Before `.hstrips--ready` lands, the fallback
  // has all four panels' copy at full opacity — that is what makes a dead script
  // readable. Switching it on therefore moves three of them from opacity 1 to 0, and
  // without this suppression that move TRANSITIONS: every page load shows a flash of
  // all four panels' text fading out. Apply the state with transitions off, flush it,
  // then hand them back.
  root.classList.add('hstrips--no-tx');
  root.classList.add('hstrips--ready');
  open(sc, 0);
  void root.offsetHeight; // flush, so the styles above land without being animated

  const enableTransitions = () => root.classList.remove('hstrips--no-tx');
  requestAnimationFrame(enableTransitions);
  // rAF never fires while the tab is in the background, and this file is injected after
  // `load` — a visitor who opens the page in a background tab would otherwise come back
  // to a section whose transitions are permanently off. The timer is the backstop.
  setTimeout(enableTransitions, 120);
}

// Guarded on `document` so the unit test can import the pure helpers above without this
// trying to initialise against a DOM that is not there.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // index-deferred.js injects this file after `load`, so DOMContentLoaded has long
    // since fired — a bare listener would never run. (See the trap note in that file.)
    init();
  }
}
