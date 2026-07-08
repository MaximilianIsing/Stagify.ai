// AI Designer is Stagify+ only. Gate access before anything renders: anonymous
// visitors bounce straight to the homepage demo row, and signed-in users see a
// hidden page (via the html.ai-gate-pending style) until their plan is verified
// (ensureDesignerProAccess reveals it for Pro or redirects otherwise).
//
// Loaded as a render-blocking <script src> in <head> (no defer) so it runs
// before the body paints, exactly as the former inline block did — externalised
// only so the CSP can drop 'unsafe-inline' from script-src.
(function () {
  var hasToken = false;
  try { hasToken = !!localStorage.getItem('stagifyAuthToken'); } catch (e) {}
  if (!hasToken) {
    window.location.replace('index.html#ai-designer-demo');
    return;
  }
  document.documentElement.className += ' ai-gate-pending';
  // Safety net: never strand a signed-in user on a hidden page if the
  // plan check stalls (e.g. a hung request).
  setTimeout(function () {
    if (document.documentElement.classList.contains('ai-gate-pending')) {
      window.location.replace('index.html#ai-designer-demo');
    }
  }, 6000);
})();
