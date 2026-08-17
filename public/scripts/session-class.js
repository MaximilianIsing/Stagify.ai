// Stagify.ai — `html.has-session`, set before the first paint.
//
// The top nav's Gallery tab ships HIDDEN, because the gallery is one person's own staged
// history and to a signed-out visitor it is not a locked feature to advertise — it is a
// page about them that does not exist yet. Shipping hidden is therefore right: it is the
// no-JS default, and it is what a crawler should see.
//
// The cost was a flash the other way round. `gallery-tab.js` reveals the tab from
// `applyUserToUI()`, which runs only once `GET /api/auth/me` has answered — a full round
// trip after DOMContentLoaded — so a signed-in visitor watched the tab pop into the nav a
// moment after the page settled, shoving the links beside it along as it went.
//
// Whether somebody is signed in is knowable synchronously, unlike their PLAN: the bearer
// token is in localStorage and the nav only asks "is there a session", so one class set
// here closes the gap entirely. It is a presence check on the token, NOT a verification of
// it — an expired or revoked token still arms this, and the tab is then taken away when
// /api/auth/me refuses it. Showing a nav link is not access; gallery-gate.js and the
// server own that.
//
// Loaded as a render-blocking <script src> (no defer/module) because a deferred script
// runs after the paint this exists to beat, and as a file rather than inline because the
// CSP has no 'unsafe-inline' in script-src. It sits LAST in <head>, after every
// stylesheet: the page cannot render until that CSS arrives anyway, so a small
// same-origin script fetched alongside it costs nothing, while putting it first would
// delay discovery of the very stylesheets first paint is waiting on.
(function () {
  var signedIn = false;
  try {
    signedIn = !!localStorage.getItem('stagifyAuthToken');
  } catch (e) {
    /* storage unavailable — fall through to the shipped markup, which hides the tab */
  }
  if (signedIn) document.documentElement.className += ' has-session';
})();
