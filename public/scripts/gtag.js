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
