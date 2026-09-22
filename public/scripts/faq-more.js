/* Stagify.ai — the homepage FAQ's "show all questions" toggle.
 *
 * WHAT IT OWNS: one class on `.faq-plan` and one `aria-expanded` on the button. Which
 * rows that hides, and at which widths, is home.css's business — below 1001px the six
 * rooms without `data-featured` wait behind `.is-expanded`, and above it the whole
 * control is `display: none` because the sheet is a drawing again. Nothing here reads a
 * media query: the class is harmless at any width, so a tablet rotated from 900px to
 * 1200px cannot end up in a state this file has to repair.
 *
 * WHY IT IS ITS OWN MODULE AND NOT PART OF home-faq-plan.js. That one is injected by
 * index-deferred.js AFTER `load`, which is fine for a drawing and wrong for a control:
 * a tap in the seconds before it lands would do nothing. This ships with the head
 * modules, so the button works as soon as the markup is parsed.
 *
 * THE SIX ARE HIDDEN, NEVER REMOVED, and three separate things can still open one:
 * `#faq-privacy` in a search result, the language switcher restoring a hash, and
 * home-faq-plan.js's own wireDeepLinks on a later hashchange. So rather than duplicating
 * its fragment logic, this listens for the RESULT — a <details> that opened while the
 * list was collapsed — and expands around it. `toggle` does not bubble, hence capture.
 */

/** The class home.css keys the expanded list off. */
const EXPANDED = 'is-expanded';

/**
 * @param {ParentNode} [root]
 * @returns {void}
 */
export function initFaqMore(root = document) {
  const plan = /** @type {HTMLElement | null} */ (root.querySelector('.faq-plan'));
  const btn = /** @type {HTMLElement | null} */ (root.querySelector('.faq-more'));
  if (!plan || !btn) return;

  const setExpanded = (on) => {
    plan.classList.toggle(EXPANDED, on);
    btn.setAttribute('aria-expanded', String(on));
  };

  btn.addEventListener('click', () => setExpanded(!plan.classList.contains(EXPANDED)));

  // Duck-typed rather than `instanceof HTMLDetailsElement`: the same check has to hold in
  // the test's fake DOM, and `open` on a `.faq-room` is only ever a <details>'s.
  plan.addEventListener(
    'toggle',
    (e) => {
      const el = /** @type {HTMLElement & { open?: boolean } | null} */ (e.target);
      if (!el || !el.open) return;
      if (el.classList && el.classList.contains('faq-room') && !el.hasAttribute('data-featured')) {
        setExpanded(true);
      }
    },
    true,
  );

  // The fragment the page LOADED on is already resolved by the time any of that can fire:
  // the UA scrolled to the room before this ran, and if that room is one of the six it
  // scrolled to something `display: none`. Expanding here, before the toggle listener has
  // anything to hear, is what makes a deep link land on its answer.
  // A Document carries its window; a fragment or element does not, so fall back to the global.
  const view = /** @type {Partial<Document>} */ (root).defaultView || (typeof window === 'undefined' ? null : window);
  const expandForHash = () => {
    const id = String((view && view.location && view.location.hash) || '').replace(/^#/, '');
    if (!id) return;
    const el = plan.querySelector(`[id="${id.replace(/["\\]/g, '\\$&')}"]`);
    if (el && el.classList.contains('faq-room') && !el.hasAttribute('data-featured')) {
      setExpanded(true);
    }
  };
  expandForHash();
  if (view) view.addEventListener('hashchange', expandForHash);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initFaqMore());
  } else {
    initFaqMore();
  }
}
