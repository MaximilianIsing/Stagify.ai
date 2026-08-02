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
  const items = Array.from(panel.querySelectorAll('.staging-menu__item'));

  const isOpen = () => root.hasAttribute('data-open');

  function open() {
    root.setAttribute('data-open', '');
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey);
  }

  function close() {
    root.removeAttribute('data-open');
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey);
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
    const here = items.indexOf(/** @type {HTMLAnchorElement} */ (document.activeElement));
    const step = e.key === 'ArrowDown' ? 1 : -1;
    const next = here === -1 ? (step === 1 ? 0 : items.length - 1) : (here + step + items.length) % items.length;
    if (items[next]) items[next].focus();
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isOpen()) close();
    else {
      open();
      if (items[0]) items[0].focus();
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
