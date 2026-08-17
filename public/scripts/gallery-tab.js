// Stagify.ai — the top nav's "Gallery" tab, shown only to signed-in visitors.
//
// The gallery is one person's own staged history. To anyone signed out it is not a
// locked feature to be advertised (the way the Staging dropdown's Stagify+ rows are)
// — it is a page about them that does not exist yet, so the tab is hidden outright
// rather than dimmed. gallery-gate.js turns the same visitor away from the URL.
//
// Follows the two patterns this nav already uses:
//   - a pure predicate plus ONE idempotent DOM writer, like
//     app/remove-furniture-gate.js and staging-menu.js, so applyUserToUI() (which
//     runs from eight sites) and anything else that re-runs cannot fight over the
//     class;
//   - the tab ships HIDDEN in the markup, so signed-out is the no-JS default and a
//     signed-in visitor is revealed once /api/auth/me answers. The other direction
//     would flash a tab at everyone and take it back.
//
// That default cost the OTHER flash — a signed-in visitor watched the tab pop into the
// nav a round trip late, shoving the links beside it along — so scripts/session-class.js
// now sets `html.has-session` from the stored token before the first paint and the
// stylesheet shows the tab through the `.hidden` this writer owns. The writer still owns
// the truth: it takes that class back off the moment /api/auth/me disagrees.
//
// `.hidden` rather than `desktop-only`: the two stack, and they mean different
// things. `desktop-only` is the PC-only rule (a width), this is the auth rule (a
// person). Either one alone is enough to keep the tab off the screen.

import { authSettled } from './session-state.js';

/** The event nav-pill.js listens for. See dispatch below for why it exists. */
export const NAV_VISIBILITY_EVENT = 'stagify:navvisibility';

/** The class scripts/session-class.js puts on <html> before the first paint. */
export const SESSION_CLASS = 'has-session';

/**
 * Should the Gallery tab be shown?
 *
 * Pure so the rule is testable on its own, and so "signed in" has exactly one
 * definition. Deliberately NOT plan-aware: the gallery is not a Stagify+ feature,
 * and a free user's saved renders are still their renders.
 *
 * @param {boolean} isSignedIn
 * @returns {boolean}
 */
export function galleryTabVisible(isSignedIn) {
  return !!isSignedIn;
}

/** Live auth state, read the same way staging-menu.js reads the plan. */
function currentIsSignedIn() {
  const auth = window.StagifyAuth;
  return !!(auth && auth.user);
}

/**
 * The single writer for the Gallery tab's visibility.
 *
 * Idempotent and safe to call on a page with no tab (admin.html has an empty nav),
 * which is why auth.js can call it unconditionally from applyUserToUI().
 *
 * @returns {boolean} whether the tab ended up visible
 */
export function syncGalleryTab() {
  const tabs = document.querySelectorAll('[data-nav-gallery]');
  if (!tabs.length) return false;
  const show = galleryTabVisible(currentIsSignedIn());

  // Hand the tab back from session-class.js's pre-paint guess to the real answer, but only
  // once there IS one. That class makes the CSS show the tab THROUGH the `.hidden` below,
  // so leaving it armed for a visitor whose token turned out to be expired would keep a tab
  // on screen that this writer believes it has just hidden. Taking it off too early is the
  // opposite failure and just as quiet: every call site today runs after /api/auth/me
  // settles, but one optimistic call added later would restore the flash with nothing
  // failing, which is why this asks rather than assumes.
  if (authSettled(window.StagifyAuth)) {
    document.documentElement?.classList?.toggle(SESSION_CLASS, show);
  }

  let changed = false;
  tabs.forEach((el) => {
    if (el.classList.contains('hidden') === show) changed = true;
    el.classList.toggle('hidden', !show);
  });

  // The nav pill measures offsets, and a tab appearing between "Staging" and
  // "Guides" moves every link after it. nav-pill.js's ResizeObserver watches
  // .nav-center, whose size need not change when a child inside it does, so it
  // cannot be relied on here — and observing the links' class attribute instead
  // would loop, because the pill writes `is-lit` onto those same links.
  //
  // So: say it out loud, and only when something actually moved. Fired on the
  // document rather than window so a detached test DOM can hear it too.
  if (changed && typeof document.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
    document.dispatchEvent(new CustomEvent(NAV_VISIBILITY_EVENT));
  }
  return show;
}
