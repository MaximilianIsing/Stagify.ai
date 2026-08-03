// AI Designer is Stagify+ only, and PC only. Gate access before anything
// renders: a phone-sized viewport goes to the home page whoever it belongs to,
// anonymous visitors bounce to the homepage demo row, and signed-in users see a
// hidden page (via the html.ai-gate-pending style) until their plan is verified
// (ensureDesignerProAccess reveals it for Pro or redirects otherwise).
//
// Loaded as a render-blocking <script src> in <head> (no defer) so it runs
// before the body paints, exactly as the former inline block did — externalised
// only so the CSP can drop 'unsafe-inline' from script-src.
(function () {
  // Classic (render-blocking) script — can't import the shared helper, so inline
  // the locale-prefix resolution: on a localized URL (/es, /fr/…) keep the visitor
  // in their language (<base href="/"> would otherwise drop them to English root).
  //
  // KEEP THE PREFIX LIST IN SYNC WITH lib/i18n/locales.js. It is duplicated here on
  // purpose (an ES import would defer this script past the paint it exists to beat),
  // and masking-studio-gate.js carries the identical copy. Both are guarded by
  // test/i18n/locale-data.test.js, which runs this function against every prefix the
  // server serves — adding a locale without touching both gates fails the build.
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
  // Is this a phone-sized viewport?
  //
  // 768px is THE site-wide mobile breakpoint, and specifically the one behind
  // `.desktop-only` in styles.css — the class that hides the AI Designer row in
  // the nav's Staging dropdown. These two must agree: the nav stops offering the
  // tool and the page stops accepting anyone, so there is no width at which the
  // row is hidden but a bookmark, a shared link or the guides' prose link still
  // lands on a layout the tool cannot use.
  //
  // Reads the LAYOUT viewport, which means this depends on <meta name="viewport">
  // being parsed first — it sits above this script in ai-designer.html's <head>,
  // and test/frontend/ai-designer/ai-designer-gate-mobile.test.js pins that order.
  // Below it a phone reports the ~980px fallback and no one would ever redirect.
  //
  // Fails OPEN on a browser with no matchMedia: showing the studio to someone we
  // cannot measure beats locking a desktop user out of a tool they pay for. The
  // plan gate below still applies either way.
  function isPhoneViewport(win) {
    if (!win || typeof win.matchMedia !== 'function') return false;
    return !!win.matchMedia('(max-width: 768px)').matches;
  }
  if (isPhoneViewport(window)) {
    window.location.replace(localeTarget('index.html'));
    return;
  }
  var hasToken = false;
  try { hasToken = !!localStorage.getItem('stagifyAuthToken'); } catch (e) {}
  if (!hasToken) {
    window.location.replace(localeTarget('index.html#ai-designer-demo'));
    return;
  }
  document.documentElement.className += ' ai-gate-pending';
  // Safety net: never strand a signed-in user on a hidden page if the
  // plan check stalls (e.g. a hung request).
  setTimeout(function () {
    if (document.documentElement.classList.contains('ai-gate-pending')) {
      window.location.replace(localeTarget('index.html#ai-designer-demo'));
    }
  }, 6000);
})();
