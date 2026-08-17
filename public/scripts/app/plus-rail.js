// The "What Stagify+ could add" rail at the foot of the staging toolbar.
//
// WHY IT EXISTS. A free or signed-out visitor gets four controls in that toolbar:
// room type, furniture style, additional prompting, and the (ungated) virtually-staged
// label. Every Stagify+ control is removed from the flow entirely — #remove-furniture-row
// and #stagify-pro-panel both ship `hidden` and are only revealed for a pro plan — so the
// one screen where somebody is actively configuring a render was also the one screen that
// never mentioned what a subscription would add. The only Pro surface a free user ever saw
// was the nav Staging dropdown, which is a navigation menu, not where intent lives.
//
// WHY IT SITS AT THE BOTTOM, COLLAPSED. The rail is deliberately the last thing in the
// toolbar, below the Process button and its progress row, and it ships shut. Nobody has to
// walk past a paywall to stage a photo, and not one free control moves. That costs reach —
// below the primary CTA is the quietest real estate in the modal — and that trade was made
// on purpose over the louder alternatives.
//
// TWO OWNERS, split the way remove-furniture-gate.js splits them:
//   • plan       — auth.js calls syncPlusRail() on every auth change
//   • open/shut  — app.js calls initPlusRail() once to wire the disclosure button
// Keeping them apart matters because applyUserToUI() runs from eight call sites; if the
// plan writer also owned the open/shut state it would slam the rail shut under a reader
// every time one of them fired.
//
// THE PERMANENT OPT-OUT. "Don’t show this again" inside the open panel writes a flag and
// the rail never comes back. Two things about that are deliberate:
//   • It is stored in localStorage, NOT on the account. The rail is shown to signed-OUT
//     visitors — see plusRailVisible — and they are the people most likely to want it
//     gone, so an account-backed preference would miss exactly them. Per-browser is the
//     honest scope, and it matches msHelpSeen in the Masking Studio.
//   • There is no UI to turn it back on, and that is the point of "permanently". Storage
//     is best-effort in both directions: a browser that refuses localStorage (private
//     mode, storage disabled) throws on read AND on write, so the rail stays visible and
//     the button silently does nothing rather than failing loudly at somebody who is
//     already telling us they do not want to see this.

/** localStorage flag: the visitor asked never to see the rail again. */
const DISMISS_KEY = 'plusRailDismissed';

/**
 * Whether the visitor has permanently dismissed the rail.
 *
 * Fails OPEN (returns false) when storage is unavailable, which is the safe direction:
 * the worst case is an upsell somebody has to collapse again, versus a paid feature list
 * that nobody can ever find.
 * @returns {boolean}
 */
export function plusRailDismissed() {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Whether the upsell rail should be on screen.
 *
 * Pure — no DOM, no storage — so the rule itself is unit-testable. Two independent
 * reasons to hide it, and they are NOT the same reason: `isPro` is a fact about the
 * account that reverses itself the moment a subscription lapses, `dismissed` is a
 * choice the visitor made that nothing here is allowed to reverse. Signed-out visitors
 * who have not dismissed it see the rail, because they are the least likely of anyone
 * to know what Stagify+ contains.
 * @param {boolean} isPro - Stagify+ / Enterprise (enterprise users carry plan 'pro').
 * @param {boolean} [dismissed] - the visitor chose "Don’t show this again".
 * @returns {boolean}
 */
export function plusRailVisible(isPro, dismissed) {
  return !isPro && !dismissed;
}

/**
 * Read the current plan off the global auth object.
 * Mirrors the defensive shape used by remove-furniture-gate.js and staging-menu.js:
 * isProUser() is the real answer, the `user.plan` read is the fallback for the window
 * before auth.js has finished defining its methods.
 * @returns {boolean}
 */
function currentIsPro() {
  const auth = /** @type {any} */ (window).StagifyAuth;
  if (auth && typeof auth.isProUser === 'function') return !!auth.isProUser();
  return !!(auth && auth.user && auth.user.plan === 'pro');
}

/**
 * Recompute the rail's visibility from the CURRENT plan and apply it.
 * Safe to call on pages with no stage modal (no-ops), and safe to call repeatedly.
 *
 * The rail ships in the markup WITHOUT `hidden`, the same direction the nav dropdown ships
 * its rows locked: free and signed-out is the default state, so this writer only ever takes
 * the rail away. Subscribing mid-session therefore removes it without a reload.
 *
 * Hiding also collapses it. Without that, a free user who opened the rail and then upgraded
 * would have it spring back open — still expanded, still selling them what they just bought —
 * the next time they signed out. The dismiss button leans on the same thing: it writes the
 * flag and calls straight back in here, so one writer owns every way the rail leaves.
 * @returns {boolean} whether the rail is now on screen
 */
export function syncPlusRail() {
  const rail = document.getElementById('plus-rail');
  if (!rail) return false;

  const visible = plusRailVisible(currentIsPro(), plusRailDismissed());
  rail.classList.toggle('hidden', !visible);
  if (!visible) setRailOpen(rail, false);
  return visible;
}

/**
 * Apply the open/shut state to the rail and its disclosure button.
 * `data-open` rather than a class, matching the nav dropdown's panel: the attribute is the
 * styling hook and aria-expanded is the announced one, and they are written together here so
 * they cannot disagree.
 * @param {HTMLElement} rail
 * @param {boolean} open
 * @returns {void}
 */
function setRailOpen(rail, open) {
  if (open) rail.setAttribute('data-open', '');
  else rail.removeAttribute('data-open');
  const toggle = rail.querySelector('.plus-rail__bar');
  if (toggle) toggle.setAttribute('aria-expanded', String(open));
}

/**
 * Wire the disclosure button and the permanent opt-out. Call once; safe on pages with no
 * stage modal.
 *
 * Deliberately does NOT set an initial OPEN state: the rail ships collapsed in the markup
 * with aria-expanded="false" already on the button, so there is nothing to sync on load and
 * no frame where an expanded panel collapses itself in front of the reader.
 *
 * It DOES sync visibility, and that half is new with the opt-out. The rail ships without
 * `hidden` so a slow or absent auth.js still shows it, which was fine while the plan was
 * the only reason to hide it — auth.js calls syncPlusRail() on boot. The dismiss flag has
 * no such caller, so without this line a dismissed rail would flash back on every load of
 * the homepage until applyUserToUI() happened to run.
 * @returns {void}
 */
export function initPlusRail() {
  const rail = document.getElementById('plus-rail');
  if (!rail) return;

  syncPlusRail();

  const toggle = rail.querySelector('.plus-rail__bar');
  if (toggle) {
    toggle.addEventListener('click', function () {
      setRailOpen(/** @type {HTMLElement} */ (rail), !rail.hasAttribute('data-open'));
    });
  }

  const hide = rail.querySelector('.plus-rail__hide');
  if (hide) {
    hide.addEventListener('click', function () {
      // Write first, then re-read through syncPlusRail rather than hiding the rail
      // directly. If storage refused the write, plusRailDismissed() still says false and
      // the rail correctly stays put — no state where the panel is gone for this page
      // view and back on the next one with nothing to explain it.
      try {
        window.localStorage.setItem(DISMISS_KEY, '1');
      } catch {
        /* private mode / storage disabled — syncPlusRail below leaves the rail alone */
      }
      syncPlusRail();
    });
  }
}
