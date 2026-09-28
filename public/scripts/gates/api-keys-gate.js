// The API dashboard is a PC-only page. Send a phone-sized viewport to the home page
// before anything renders, so the URL is never a way around the account-menu row being
// hidden — a bookmark, a browser that restored the tab, the link in the docs.
//
// WHY THIS PAGE REFUSES PHONES. It is a two-column inspector: a list of everything the
// account owns beside a detail pane of stats, a thirty-day chart and a definition list.
// Collapsed to one column every selection becomes a scroll, and the pane it scrolls to
// is a table of numbers that has to be read side by side to mean anything. It is also,
// bluntly, a page you visit from the machine you write code on.
//
// Loaded as a render-blocking <script src> in <head> (no defer) so it runs before the
// body paints: a type="module" is deferred by definition and would show a frame of the
// dashboard on the way out. External rather than inline so the CSP can keep
// 'unsafe-inline' out of script-src.
//
// NO SIGNED-IN CHECK, unlike gallery-gate.js. The two pages differ in what a signed-out
// visitor is owed: the gallery is about renders they do not have, while this page has a
// real signed-out state that explains what an API key is and offers a way in. Bouncing
// them would send someone who followed the docs' own link back to the home page.
//
// NO localeTarget() here, unlike ai-designer-gate.js. api-keys.html is noindex and is
// deliberately absent from LOCALIZED_PAGES in lib/i18n/locales.js: there is no
// /es/api-keys.html to keep a visitor inside, so `index.html` always resolves to the
// English home page and carrying their inlined prefix regex would be dead code plus a
// third copy of a list that has to stay in sync with the server. If this page ever
// joins LOCALIZED_PAGES it needs their version — test/frontend/desktop-only-gates.test.js
// fails if that day comes and this file has not caught up.
(function () {
  // 768px is THE site-wide mobile breakpoint, and specifically the one behind
  // `.desktop-only` in styles.css — the class that hides the API row in the account
  // menu and the dashboard button on developers.html. These must agree, or there is a
  // band of widths where the entrances are gone but the URL still works, or the reverse.
  //
  // Reads the LAYOUT viewport, so it depends on <meta name="viewport"> being parsed
  // first; it sits above this script in api-keys.html's <head>, and
  // test/frontend/api-keys/api-keys-gate-mobile.test.js pins that order. Below it a
  // phone reports the ~980px fallback and nobody would ever be redirected.
  //
  // Fails OPEN on a browser with no matchMedia: showing a cramped dashboard to someone
  // we cannot measure beats bouncing a desktop visitor off their own account page.
  function isPhoneViewport(win) {
    if (!win || typeof win.matchMedia !== 'function') return false;
    return !!win.matchMedia('(max-width: 768px)').matches;
  }
  if (isPhoneViewport(window)) {
    window.location.replace('index.html');
  }
})();
