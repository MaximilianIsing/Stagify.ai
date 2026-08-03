// The gallery is a PC-only feature, and a signed-in one. Send both a phone-sized
// viewport and a visitor with no session to the home page before anything renders,
// so the URL is never a way around the nav tab being hidden — a bookmark, a browser
// that restored the tab, a link someone pasted.
//
// Loaded as a render-blocking <script src> in <head> (no defer) so it runs before
// the body paints: a type="module" is deferred by definition and would show a
// frame of the grid on the way out. External rather than inline so the CSP can
// keep 'unsafe-inline' out of script-src.
//
// NO localeTarget() here, unlike ai-designer-gate.js and masking-studio-gate.js —
// this is not an oversight. gallery.html is behind auth, noindex and disallowed in
// robots.txt, so it is deliberately absent from LOCALIZED_PAGES in
// lib/i18n/locales.js: there is no /es/gallery.html to keep a visitor inside, and
// on a localized page rewriteHref() leaves `gallery.html` alone precisely because
// of that. Carrying their inlined prefix regex would be dead code plus a third copy
// of a list that has to stay in sync with the server. If the gallery ever joins
// LOCALIZED_PAGES, it needs their version — test/frontend/desktop-only-gates.test.js
// fails if that day comes and this file has not caught up.
(function () {
  // 768px is THE site-wide mobile breakpoint, and specifically the one behind
  // `.desktop-only` in styles.css — the class that hides the Gallery tab in the
  // nav. These two must agree, or there is a band of widths where the tab is gone
  // but the URL still works, or the reverse.
  //
  // Reads the LAYOUT viewport, so it depends on <meta name="viewport"> being
  // parsed first; it sits above this script in gallery.html's <head>, and
  // test/frontend/gallery/gallery-gate-mobile.test.js pins that order. Below it a
  // phone reports the ~980px fallback and nobody would ever be redirected.
  //
  // Fails OPEN on a browser with no matchMedia: showing the grid to someone we
  // cannot measure beats hiding their own renders from them.
  function isPhoneViewport(win) {
    if (!win || typeof win.matchMedia !== 'function') return false;
    return !!win.matchMedia('(max-width: 768px)').matches;
  }
  if (isPhoneViewport(window)) {
    window.location.replace('index.html');
    return;
  }

  // Signed out — the tab is hidden for them too (scripts/gallery-tab.js), and the
  // page is about renders they do not have. A presence check on the token, not a
  // verification of it: this runs before paint and cannot wait on the network. An
  // EXPIRED or revoked token therefore still gets in here, and gallery-app.js's
  // `signed-out` state is what catches it once /api/gallery answers 401 — that state
  // is not dead code, it is the other half of this.
  var hasToken = false;
  try { hasToken = !!localStorage.getItem('stagifyAuthToken'); } catch (e) {}
  if (!hasToken) {
    window.location.replace('index.html');
  }
})();
