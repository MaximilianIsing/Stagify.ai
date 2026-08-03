// Stagify.ai — the top-nav "Staging" dropdown.
//
// One owner for the menu on all nine nav-bearing pages: the Stagify+ lock on its
// three Pro rows, the open/close behaviour, and the two shortcuts into the home
// page's staging and Basic Mask screens.
//
// It replaces the pair of bare `.nav-ai-designer-pro` / `.nav-masking-studio-pro`
// links that auth.js used to reveal by stripping `.hidden`. Those were invisible
// to free users, so nothing advertised that the studios existed; the rows now
// stay visible and locked instead.
//
// Two existing patterns, deliberately:
//   - the LOCK follows app/remove-furniture-gate.js — a pure predicate plus ONE
//     idempotent DOM writer, so the auth pass and anything else that re-runs
//     can't fight over the same classes;
//   - the OPEN/CLOSE follows language-switcher.js — a `data-open` attribute the
//     stylesheet keys off (so the panel can animate), not a `.hidden` toggle.
//
// The Pro rows ship LOCKED in the markup. Free and anonymous are therefore the
// no-JS default and a Pro user is unlocked once /api/auth/me answers — the same
// direction the two links this replaced ran in, so there is no flash of an
// unlocked menu for a visitor who can't use it.

import { localizedTarget } from './i18n-routing.js';

const PLUS_PAGE = 'stagify-plus.html';

/**
 * Should a row be locked?
 *
 * Pure so the rule is testable on its own: only Stagify+ rows lock, and only
 * for a visitor who isn't Pro. "Image Staging" is not a Pro row, so it never
 * locks — not for a free account and not for an anonymous visitor (who gets the
 * sign-in prompt from the staging screen itself).
 *
 * @param {boolean} isPro
 * @param {boolean} isProItem - whether the row is a Stagify+ tool
 * @returns {boolean}
 */
export function stagingItemLocked(isPro, isProItem) {
  return !!isProItem && !isPro;
}

/** Live plan, read the same way app.js and remove-furniture-gate.js read it. */
function currentIsPro() {
  const auth = window.StagifyAuth;
  if (auth && typeof auth.isProUser === 'function') return !!auth.isProUser();
  return !!(auth && auth.user && auth.user.plan === 'pro');
}

/**
 * The single writer for the menu's locked state.
 *
 * One class, and nothing else. In particular NOT `aria-disabled`: a locked row
 * is still a working link — it goes to the Stagify+ page — and announcing it as
 * disabled would be a lie that also stops assistive tech and Playwright from
 * activating it. The state is carried into the accessibility tree by the visible
 * "Stagify+" chip instead, which the stylesheet reveals with the same class, so
 * a locked row reads as "Basic Mask, Stagify+" and an unlocked one as "Basic
 * Mask". The lock glyph is aria-hidden decoration.
 *
 * Idempotent and safe to call on a page with no menu (admin.html has an empty
 * nav), which is why auth.js can call it unconditionally from applyUserToUI().
 *
 * @returns {boolean} whether the rows ended up unlocked
 */
export function syncStagingMenu() {
  const items = document.querySelectorAll('[data-staging-pro]');
  if (!items.length) return false;
  const isPro = currentIsPro();
  items.forEach((el) => {
    el.classList.toggle('is-locked', stagingItemLocked(isPro, true));
  });
  return isPro;
}

/** @param {Element} root */
function wireMenu(root) {
  const trigger = root.querySelector('.staging-menu__trigger');
  const panel = root.querySelector('.staging-menu__panel');
  if (!trigger || !panel) return;
  /** @type {HTMLAnchorElement[]} */
  const rows = Array.from(panel.querySelectorAll('.staging-menu__item'));

  /**
   * The rows a keyboard can actually reach, recomputed per keypress.
   *
   * The AI Designer row is `desktop-only` — a PC-only tool, so the stylesheet
   * hides it below 768px (and ai-designer-gate.js sends a phone that reaches the
   * URL anyway back to the home page). A `display:none` element cannot take
   * focus, so leaving it in the rotation would make one ArrowDown press look
   * dead instead of moving on to the Masking Studio. Read live rather than
   * filtered once at wire time: the breakpoint flips under a rotation or a
   * window resize, and this menu is wired exactly once per page load.
   *
   * Same predicate nav-pill.js uses for "is this link actually laid out".
   *
   * @returns {HTMLAnchorElement[]}
   */
  const items = () => rows.filter((el) => el.offsetParent !== null);

  const isOpen = () => root.hasAttribute('data-open');

  /**
   * Aim the panel at its trigger without letting it escape the box that clips it.
   *
   * Phones only, and the breakpoint is never named here — offsetParent is asked
   * instead. Above 768px the wrapper is `position:relative`, so the panel is
   * positioned in the wrapper and the stylesheet already centres it on the trigger
   * with `left:50%`; there is nothing to compute. Below it the wrapper is static
   * and the panel is positioned in `.nav-center`, the element with overflow-x:clip
   * — spanning that box cleared the clipping but left the panel pointing at the
   * middle of the nav rather than at "Staging".
   *
   * Both offsets are read against that same box, and the result is clamped to it,
   * so aiming at the trigger can never reintroduce the clipping this replaced. If
   * the panel is too wide to leave a gutter either side, the offset is dropped and
   * the CSS falls back to centring — the best available answer at that width.
   */
  function alignPanel() {
    // Cast at the use site, the way the rest of this file does: querySelector hands
    // back an Element, and the offset* box metrics live on HTMLElement.
    const box = /** @type {HTMLElement} */ (panel);
    const btn = /** @type {HTMLElement} */ (trigger);
    const clip = /** @type {HTMLElement | null} */ (box.offsetParent);
    const clear = () => box.style.removeProperty('--staging-panel-shift');
    if (!clip || clip === root) return clear();
    const GAP = 8;
    const room = clip.clientWidth - box.offsetWidth;
    if (room <= GAP * 2) return clear();
    const centred = btn.offsetLeft + (btn.offsetWidth - box.offsetWidth) / 2;
    const shift = Math.min(Math.max(centred, GAP), room - GAP);
    box.style.setProperty('--staging-panel-shift', `${Math.round(shift)}px`);
  }

  function open() {
    alignPanel();
    root.setAttribute('data-open', '');
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey);
    // A rotation re-wraps the nav under an open menu, which moves the trigger and
    // resizes the clip box — both inputs above.
    window.addEventListener('resize', alignPanel);
  }

  function close() {
    root.removeAttribute('data-open');
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', alignPanel);
  }

  /** @param {Event} e */
  function onOutside(e) {
    if (!root.contains(/** @type {Node} */ (e.target))) close();
  }

  /** @param {KeyboardEvent} e */
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      /** @type {HTMLElement} */ (trigger).focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const reachable = items();
    if (!reachable.length) return;
    const here = reachable.indexOf(/** @type {HTMLAnchorElement} */ (document.activeElement));
    const step = e.key === 'ArrowDown' ? 1 : -1;
    const last = reachable.length - 1;
    const next = here === -1 ? (step === 1 ? 0 : last) : (here + step + reachable.length) % reachable.length;
    reachable[next].focus();
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isOpen()) close();
    else {
      open();
      const [first] = items();
      if (first) first.focus();
    }
  });

  panel.addEventListener('click', (e) => {
    const item = /** @type {HTMLElement | null} */ (e.target).closest?.('.staging-menu__item');
    if (!item) return;

    // Locked: send them to the Stagify+ page instead of the tool. Both studios
    // would bounce them there anyway (their own head-gates do it before paint),
    // so this only makes the outcome immediate and honest.
    if (item.classList.contains('is-locked')) {
      e.preventDefault();
      close();
      window.location.href = localizedTarget(PLUS_PAGE);
      return;
    }

    // Already on the home page: open the screen in place rather than navigating
    // to our own URL and re-parsing it. Off the home page these hooks don't
    // exist and the row's href does the work.
    const action = item.getAttribute('data-staging-open');
    const hook = action === 'stage' ? window.__stagifyOpenStaging
      : action === 'basic-mask' ? window.__stagifyOpenBasicMask
        : null;
    if (typeof hook === 'function') {
      e.preventDefault();
      close();
      hook();
      return;
    }
    close();
  });
}

function init() {
  const roots = document.querySelectorAll('[data-staging-menu]');
  if (!roots.length) return;
  roots.forEach(wireMenu);
  // Paint the lock from whatever auth state already exists. applyUserToUI()
  // calls this again once /api/auth/me answers.
  syncStagingMenu();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
