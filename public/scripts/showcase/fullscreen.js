// The homepage showcase's expand control — an island of studio-showcase.js.
//
// Lifted out because studio-showcase.js is at the 650-line cap and because this is a
// cohesive concern with a clean seam: it needs the Showcase only for its root (to find
// the buttons) and one callback (to re-measure afterwards).
//
// TWO PATHS, chosen at CLICK time, not at wire time.
//
// DESKTOP: native fullscreen on the `.shw__media` box, exactly as before.
//
// PHONE: the rotate-to-landscape view (../immersive-view.js). iPhone Safari has no
// Element.requestFullscreen at all, so the desktop path was a no-op there, and even
// where a phone does have it, a 16:9 demo inside a portrait viewport is a letterbox
// nobody can read. The button opens a full-viewport overlay and turns the media 90deg
// while the phone is held upright instead.
//
// Either way it TOGGLES rather than only entering, so the same control gets you back
// out — `aria-pressed` carries the state, which means the label never has to change
// and the i18n pack needs one key per path, not two.

import { anyImmersiveOpen, createImmersive, isPhone, markRotateButton } from '../immersive-view.js';

/**
 * True while the front panel's media is expanded — natively, or portaled into the
 * rotate-to-landscape overlay.
 *
 * The carousel consults this before every panel change. Cycling in either state would
 * swap the content out from under a viewer who cannot see the carousel behind it, and
 * in the immersive case would also relayout the stage around an empty slot and orphan
 * the DOM move the overlay is holding.
 *
 * @returns {boolean}
 */
export function expanded() {
  return !!document.fullscreenElement || anyImmersiveOpen();
}

/**
 * @param {{ root: HTMLElement }} sc the Showcase (only its root is used here)
 * @param {() => void} onViewChange re-measure + re-place the players
 */
export function wireFullscreen(sc, onViewChange) {
  const buttons = /** @type {HTMLElement[]} */ ([].slice.call(sc.root.querySelectorAll('[data-shw-fullscreen]')));
  if (!buttons.length) return;
  // Some embedding contexts disallow fullscreen outright. Hide the control instead of
  // shipping a button whose only behaviour is a rejected promise — but NOT on a phone,
  // where the rotate path needs no fullscreen support and is the whole point.
  if (!document.fullscreenEnabled && !isPhone()) {
    buttons.forEach((btn) => { btn.hidden = true; });
    return;
  }
  buttons.forEach((btn) => {
    markRotateButton(btn, window);
    const media = btn.closest('.shw__media');
    const immersive = media
      ? createImmersive({ target: media, button: btn, onChange: () => onViewChange() })
      : null;
    btn.addEventListener('click', () => {
      if (!media) return;
      if (isPhone()) {
        if (immersive) immersive.toggle();
        return;
      }
      if (document.fullscreenElement === media) document.exitFullscreen();
      // A rejection here is normal — a user gesture can be refused — and there is
      // nothing to recover, so swallow it rather than surfacing an unhandled rejection.
      else media.requestFullscreen().catch(() => {});
    });
  });
  document.addEventListener('fullscreenchange', () => {
    // The immersive view may itself have taken native fullscreen (Android), which
    // fires this event with the OVERLAY as the fullscreen element — not the media. The
    // comparison below would then read `false` and strip the close glyph off a button
    // that is very much open. The overlay owns the button's state while it is up.
    if (anyImmersiveOpen()) return;
    buttons.forEach((btn) => {
      const on = document.fullscreenElement === btn.closest('.shw__media');
      btn.classList.toggle('is-fs', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    onViewChange();
  });
}
