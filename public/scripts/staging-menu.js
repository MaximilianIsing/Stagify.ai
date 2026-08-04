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
   * Place the panel under the nav row, aimed at its trigger.
   *
   * Phones only, and the breakpoint is still never named here — the stylesheet's own
   * `position` is asked instead, which is the thing that actually encodes it. Above
   * 768px the panel is absolute inside a relative wrapper and the CSS centres it on
   * the trigger with `left:50%`; there is nothing to compute. Below it the panel is
   * `position:fixed` (see the long note in styles.css: it is fixed so that no
   * ancestor's overflow can clip it, which is what erased it on iOS), and a fixed box
   * resolves its offsets against the viewport — so "under the nav row, aimed at
   * Staging" has to be measured and written out here.
   *
   * NOT offsetParent/offsetLeft any more: a fixed element has no offsetParent, so the
   * old guard read as "desktop" and skipped the very branch that needs the work.
   * Everything below is viewport coordinates from getBoundingClientRect, which is the
   * same space `top`/`left` resolve in, so the two cannot drift apart.
   */
  function alignPanel() {
    // Cast at the use site, the way the rest of this file does: querySelector hands
    // back an Element, and the box metrics live on HTMLElement.
    const box = /** @type {HTMLElement} */ (panel);
    const btn = /** @type {HTMLElement} */ (trigger);
    const clear = () => {
      box.style.removeProperty('--staging-panel-top');
      box.style.removeProperty('--staging-panel-left');
    };
    if (getComputedStyle(box).position !== 'fixed') return clear();
    // The nav row is what the panel is aimed under and clamped to. It is the menu's
    // own parent, so this needs no class name to find.
    const row = root.parentElement;
    if (!row) return clear();
    const GAP = 8;
    const rowBox = row.getBoundingClientRect();
    const btnBox = btn.getBoundingClientRect();
    const width = box.offsetWidth;
    // Clamp inside the row, but never past the viewport either — on a narrow phone the
    // row can be wider than the space the panel may occupy.
    const min = Math.max(rowBox.left, 0) + GAP;
    const max = Math.min(rowBox.right, window.innerWidth) - width - GAP;
    const centred = btnBox.left + (btnBox.width - width) / 2;
    // Math.max(min, max) so an over-wide panel pins to the left gutter rather than
    // inverting the clamp and flying off to the left.
    const left = Math.min(Math.max(centred, min), Math.max(min, max));
    box.style.setProperty('--staging-panel-left', `${Math.round(left)}px`);
    box.style.setProperty('--staging-panel-top', `${Math.round(rowBox.bottom + GAP)}px`);
  }

  function open() {
    alignPanel();
    root.setAttribute('data-open', '');
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey);
    // A rotation re-wraps the nav under an open menu, which moves the trigger and
    // resizes the row — both inputs above.
    window.addEventListener('resize', alignPanel);
    // The panel is position:fixed on phones, so it does NOT ride the page: anything
    // that moves the nav row in viewport space has to be followed explicitly. The
    // header is sticky at top:0 so this is usually a no-op, but a phone's collapsing
    // URL bar moves the whole viewport out from under it, and scroll is the only
    // event that reports it. Passive: this never calls preventDefault.
    window.addEventListener('scroll', alignPanel, { passive: true });
  }

  function close() {
    root.removeAttribute('data-open');
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', alignPanel);
    window.removeEventListener('scroll', alignPanel);
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
      // Move focus into the panel for KEYBOARD opens only. A button activated by
      // Enter/Space reports detail 0; a real click or tap reports 1 or more, which
      // is the standard way to tell them apart without sniffing pointer types.
      //
      // Focusing on a tap is actively harmful on a phone. The panel lives in a
      // position:sticky header, and focus() asks the browser to scroll the focused
      // element into view — against a dynamic URL bar and a sticky ancestor that is
      // a scroll the page did not ask for. It also arms
      // `.staging-menu__item:focus-visible .staging-menu__tip`, which paints a dark
      // tooltip over the rows below the one it belongs to. Neither is wanted by
      // someone who just tapped; a keyboard user needs the focus and gets it.
      if (/** @type {MouseEvent} */ (e).detail === 0) {
        const [first] = items();
        if (first) first.focus();
      }
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
