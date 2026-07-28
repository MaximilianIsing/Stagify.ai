/*
 * Google tag (gtag.js) — Google Ads (conversion ID AW-18274233484).
 *
 * Loaded on every public page via <script src="scripts/gtag.js"></script>.
 * This lives in an external file (not an inline <script>) on purpose: the site's
 * Content-Security-Policy has no 'unsafe-inline' for scripts, so an inline gtag
 * block would be silently blocked. The gtag.js library origin
 * (www.googletagmanager.com) is allowlisted in scriptSrc in
 * lib/http/app-middleware.js.
 *
 * Deliberately a CLASSIC script (no import/export) so it exposes the global
 * `gtag()` that later conversion-event snippets call, and so it stays outside the
 * ESM lint/type-check scope. Keep the conversion ID in this one file.
 *
 * Its <script> tag is `defer`, not synchronous. This file only queues two dataLayer
 * entries and appends an already-async loader — nothing below it in the document
 * depends on it during parsing — so a blocking tag bought nothing and cost a parser
 * stall at the very top of <head>, ahead of every stylesheet link, on all 19 public
 * pages. `defer` rather than `async` because it keeps document order: this tag is
 * first, so `window.gtag` is guaranteed to exist before any other deferred or module
 * script runs, which is the contract a future conversion snippet will rely on.
 * (A classic, non-deferred script would still run earlier — see
 * test/frontend/head-scripts.test.js, which pins the render-blocking set.)
 */
window.dataLayer = window.dataLayer || [];
window.gtag =
  window.gtag ||
  function () {
    window.dataLayer.push(arguments);
  };

if (!window.__gtagConfigured) {
  window.__gtagConfigured = true;
  window.gtag('js', new Date());
  window.gtag('config', 'AW-18274233484');

  // Equivalent of Google's <script async src="…/gtag/js?id=…"> loader tag,
  // injected here so the conversion ID lives in a single place.
  var loader = document.createElement('script');
  loader.async = true;
  loader.src = 'https://www.googletagmanager.com/gtag/js?id=AW-18274233484';
  document.head.appendChild(loader);
}
