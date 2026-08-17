// Exterior Studio — the pre-paint half of exterior-studio/access.js.
//
// This is a gate that RESHAPES, never redirects, and that distinction is the whole point.
// masking-studio-gate.js / ai-designer-gate.js / gallery-gate.js `location.replace` anyone
// without a token; this page must not, because it has a public view that Googlebot and
// signed-out visitors are meant to reach (see exterior-studio/access.js for the full
// reasoning, and the guard in test/frontend/staging-menu.test.js that pins it).
//
// What it fixes: the markup ships in the ANONYMOUS state — the pitch and a "Get Stagify+"
// button visible, the tool hidden — which is right for everyone except the people who
// already paid. The plan is only knowable from /api/auth/me, a round trip away, so a
// Stagify+ visitor used to paint the sales pitch and lose it a moment later. The last
// known plan is cached in localStorage by auth.js precisely so this script can read it
// synchronously, before the first paint, and pre-apply the Pro shape.
//
// The cache is a GUESS, not an authorization. A visitor who cancelled still gets the tool
// for one round trip before access.js puts the pitch back; the server gate
// (requireProAccount on POST /api/enhance-exterior) is what actually decides, and it
// answers 403 no matter what this class says.
//
// Loaded as a render-blocking <script src> in <head> (no defer/module) so it runs before
// the body paints. It is a file rather than an inline block because the CSP has no
// 'unsafe-inline' in script-src — see lib/http/app-middleware.js.
//
// NOTE: unlike the other three gates this needs no copy of their localeTarget() /
// locale-prefix regex, because it never navigates. One less duplicate to keep in sync
// with lib/i18n/locales.js.
(function () {
  var PENDING_CLASS = 'ex-pro-pending';

  var pro = false;
  try {
    // BOTH facts, not either: the plan cache alone would pre-paint the tool for someone
    // who has signed out in another tab, and the token alone cannot tell free from Pro.
    pro =
      !!localStorage.getItem('stagifyAuthToken') && localStorage.getItem('stagifyPlan') === 'pro';
  } catch (e) {
    /* storage unavailable — fall through to the public shape, which is always safe */
  }
  if (!pro) return;

  document.documentElement.className += ' ' + PENDING_CLASS;

  // Safety net, mirroring the 6s/9s ones in the other gates but with the opposite action:
  // there, a stalled plan check strands a signed-in user on a hidden page, so they
  // redirect. Here the class only ever HIDES the public page, so simply dropping it
  // restores the page every visitor is allowed to see. Nothing to bounce, nothing to lose.
  setTimeout(function () {
    document.documentElement.classList.remove(PENDING_CLASS);
  }, 6000);
})();
