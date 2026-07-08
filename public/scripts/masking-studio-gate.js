// Masking Studio is Stagify+ only. Gate access before anything renders:
// anonymous visitors bounce to the Stagify+ page (which explains the feature),
// and signed-in users see a hidden page (via the html.ms-gate-pending style)
// until their plan is verified (ensureStudioProAccess reveals it for Pro, or
// shows the upgrade dialog for signed-in free users).
//
// Loaded as a render-blocking <script src> in <head> (no defer) so it runs
// before the body paints, exactly as the former inline block did — externalised
// only so the CSP can drop 'unsafe-inline' from script-src.
(function () {
  var hasToken = false;
  try { hasToken = !!localStorage.getItem('stagifyAuthToken'); } catch (e) {}
  if (!hasToken) {
    window.location.replace('stagify-plus.html');
    return;
  }
  document.documentElement.className += ' ms-gate-pending';
  // Safety net: never strand a signed-in user on a hidden page if the
  // plan check stalls (e.g. a hung request). Generous enough that a
  // slow-but-working connection can still finish the check.
  setTimeout(function () {
    if (document.documentElement.classList.contains('ms-gate-pending')) {
      window.location.replace('stagify-plus.html');
    }
  }, 9000);
})();
