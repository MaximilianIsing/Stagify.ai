// AI Designer is Stagify+ only. Gate access before anything renders: anonymous
// visitors bounce straight to the homepage demo row, and signed-in users see a
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
