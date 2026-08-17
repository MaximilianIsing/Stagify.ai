// Stagify.ai — the pre-paint half of preview-access.js, shared by every preview page.
//
// A gate that RESHAPES, never redirects, and that distinction is the whole point.
// gallery-gate.js still `location.replace`s anyone without a token; a preview page must
// not, because it has a public view that Googlebot and signed-out visitors are meant to
// reach (see preview-access.js for the reasoning, and the `data-staging-preview` guard in
// test/frontend/staging-menu.test.js that pins the nav half of it).
//
// What it fixes: the markup ships in the ANONYMOUS state — pitch visible, tool hidden —
// which is right for everyone except the people who already paid. The plan is only knowable
// from /api/auth/me, a round trip away, so a Stagify+ visitor would paint the sales pitch
// and lose it a moment later. auth.js caches the last known plan in localStorage precisely
// so this script can read it synchronously, before the first paint, and pre-apply the Pro
// shape.
//
// The cache is a GUESS, not an authorization. Someone who cancelled still gets the tool for
// one round trip before the page's sync writer puts the pitch back; the server gate
// (requireProAccount on the route the studio posts to) is what actually decides, and it
// answers 403 no matter what this class says.
//
// ONE FILE, THREE PAGES. Each preview page names its own <html> class on the script tag:
//
//   <script src="scripts/preview-gate.js" data-pending-class="ms-pro-pending"></script>
//
// The class has to be per-page because the CSS rules it drives are per-page (each studio
// hides a different tool id). Everything else here is identical, and it was three
// copy-pasted files before this one.
//
// Loaded as a render-blocking <script src> in <head> (no defer/module) so it runs before
// the body paints, and registered in head-scripts.test.js's blocking allow-list. It is a
// file rather than an inline block because the CSP has no 'unsafe-inline' in script-src —
// see lib/http/app-middleware.js.
//
// NOTE: unlike the redirecting gates this needs no copy of their localeTarget() and its
// locale-prefix regex, because it never navigates. One less duplicate to keep in sync with
// lib/i18n/locales.js.
(function () {
  // `document.currentScript` is the <script> element being executed, which is exactly what
  // a synchronous classic script can rely on (it is null in a module or a callback, and
  // both are ruled out by this file being render-blocking and non-deferred).
  var el = document.currentScript;
  var PENDING_CLASS = el && el.getAttribute('data-pending-class');
  // No class named means the page has not opted in. Returning leaves the public shape,
  // which is always safe to show anyone — including a subscriber, who simply sees the
  // pitch for one round trip.
  if (!PENDING_CLASS) return;

  var pro = false;
  try {
    // BOTH facts, not either: the plan cache alone would pre-paint the tool for someone who
    // signed out in another tab, and the token alone cannot tell free from Pro.
    pro = !!localStorage.getItem('stagifyAuthToken') && localStorage.getItem('stagifyPlan') === 'pro';
  } catch (e) {
    /* storage unavailable — fall through to the public shape */
  }
  if (!pro) return;

  document.documentElement.className += ' ' + PENDING_CLASS;

  // Safety net, mirroring the 6s/9s ones in the redirecting gates but with the opposite
  // action: there, a stalled plan check strands a signed-in user on a hidden page, so they
  // redirect. Here the class only ever HIDES the public page, so dropping it restores the
  // page every visitor is allowed to see. Nothing to bounce, nothing to lose.
  setTimeout(function () {
    document.documentElement.classList.remove(PENDING_CLASS);
  }, 6000);
})();
