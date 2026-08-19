// The API documentation is a PC-only page. Send a phone-sized viewport to the home
// page before anything renders, so the URL is not a way around the footer link being
// hidden — a bookmark, a restored tab, a link someone pasted into Slack.
//
// Loaded as a render-blocking <script src> in <head> (no defer) so it runs before the
// body paints: a type="module" is deferred by definition and would show a frame of the
// three-column layout on the way out. External rather than inline so the CSP can keep
// 'unsafe-inline' out of script-src.
//
// localeTarget() IS carried here, matching ai-designer-gate.js. developers.html is in
// LOCALIZED_PAGES, so /es/developers.html exists — and without this a Spanish reader on
// a phone would be redirected to the ENGLISH root, losing their language on the way out.
// test/frontend/desktop-only-gates.test.js is what requires it, and it is why the page
// joining LOCALIZED_PAGES could not be a one-line change.
//
// UNLIKE the gallery, there is NO auth check: the docs are public, and a signed-out
// developer evaluating the API is exactly who they are for.
(function () {
  // Classic (render-blocking) script — cannot import the shared helper, so the locale
  // prefix resolution is inlined. KEEP THE PREFIX LIST IN SYNC WITH lib/i18n/locales.js;
  // ai-designer-gate.js carries the identical copy and test/i18n/locale-data.test.js
  // runs this function against every prefix the server serves.
  function localeTarget(rel) {
    var m = location.pathname.match(/^\/(es|fr|de|zh|ko|pt|ru|it|ja|nl)(\/|$)/);
    if (!m) return rel;
    var pfx = '/' + m[1];
    var i = rel.search(/[#?]/);
    var bare = (i === -1 ? rel : rel.slice(0, i)).replace(/^\//, '');
    var suffix = i === -1 ? '' : rel.slice(i);
    var p = bare ? '/' + bare : '/';
    if (p === '/index.html') p = '/';
    return (p === '/' ? pfx : pfx + p) + suffix;
  }

  // 768px is THE site-wide mobile breakpoint, and specifically the one behind
  // `.desktop-only` in styles.css — the class that hides the Developers link in the
  // shared footer. These two must agree, or there is a band of widths where the link
  // is gone but the URL still works, or the reverse.
  //
  // Reads the LAYOUT viewport, so it depends on <meta name="viewport"> being parsed
  // first; it sits above this script in developers.html's <head>, and
  // test/frontend/developers/developers-gate-mobile.test.js pins that order. Below it
  // a phone reports the ~980px fallback and nobody would ever be redirected.
  //
  // Fails OPEN on a browser with no matchMedia: showing the docs to someone we cannot
  // measure beats hiding public reference material from them.
  function isPhoneViewport(win) {
    if (!win || typeof win.matchMedia !== 'function') return false;
    return !!win.matchMedia('(max-width: 768px)').matches;
  }
  if (isPhoneViewport(window)) {
    window.location.replace(localeTarget('index.html'));
  }
})();
