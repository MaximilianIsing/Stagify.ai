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

  // THE ONLY REDIRECT LEFT IS THE ONE ABOVE, and it is about the VIEWPORT, not the
  // visitor. This gate used to bounce anyone without a token to index.html#ai-designer-demo
  // and hide the page behind `html.ai-gate-pending body{visibility:hidden}` until the plan
  // check answered, with a second redirect if it never did. All of that is gone: the page
  // has a public view now — the pitch for an anonymous visitor and for a signed-in free
  // account, the studio for Stagify+ — so bouncing them took away the very page written
  // for them, and took it away from Googlebot too, which carries no token either.
  //
  // What is left is the same reshaping job scripts/preview-gate.js does for the other
  // preview pages. This page cannot simply mount that shared file, because the viewport
  // check above has to run FIRST and that file never navigates by design; keeping the two
  // apart is deliberate rather than a duplication to tidy away. Everything below is the
  // shared gate's body, and test/frontend/preview-gate.test.js pins the shared copy.
  var PENDING_CLASS = 'ai-pro-pending';
  var pro = false;
  try {
    // BOTH facts, not either: the plan cache alone would pre-paint the studio for someone
    // who signed out in another tab, and the token alone cannot tell free from Pro.
    pro = !!localStorage.getItem('stagifyAuthToken') && localStorage.getItem('stagifyPlan') === 'pro';
  } catch (e) {
    /* storage unavailable — fall through to the public shape, which is safe for anyone */
  }
  if (!pro) return;

  document.documentElement.className += ' ' + PENDING_CLASS;

  // The safety net now has the OPPOSITE action to the one it replaced. That timer redirected
  // a stalled visitor away from a page it had hidden; this one simply drops the class,
  // which restores the page every visitor is allowed to see. Nothing to bounce.
  setTimeout(function () {
    document.documentElement.classList.remove(PENDING_CLASS);
  }, 6000);
})();
