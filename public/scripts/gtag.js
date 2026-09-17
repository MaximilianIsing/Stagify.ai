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
 *
 * ── THE OPT-OUT GATE ──────────────────────────────────────────────────────────
 *
 * This tag builds Google Ads remarketing audiences, which under the CPRA is
 * "sharing personal information for cross-context behavioral advertising".
 * privacy.html §16.3 therefore promises two things, and this gate is what makes
 * both of them true rather than aspirational:
 *
 *   1. Global Privacy Control is honored. `navigator.globalPrivacyControl` is the
 *      opt-out preference signal California requires businesses to process; a
 *      browser that sends it (Brave, DuckDuckGo, Firefox's setting) never loads
 *      the tag at all.
 *   2. A manual opt-out exists, stored under STORAGE_KEY. The control that writes
 *      it is scripts/ad-optout.js, rendered into privacy.html §16.3 — that file
 *      declares the SAME key, and test/frontend/gtag-optout.test.js fails if the
 *      two ever drift apart.
 *
 * The gate returns BEFORE `gtag('config', …)` and before the loader is appended,
 * so an opted-out visitor queues nothing and makes no request to Google — an
 * opt-out that still fetched the tag would not be an opt-out.
 *
 * On a storage error the tag LOADS. A browser in private mode can throw on
 * localStorage, and treating that as an opt-out would silently switch off ad
 * measurement for a whole class of visitors with nothing to show why. GPC is read
 * first and separately, so that decision cannot be reached by the signal path.
 *
 * ── THE REGION GATE ───────────────────────────────────────────────────────────
 *
 * Opt-out is the US model. It is the WRONG model for the EEA, the UK and
 * Switzerland, where ePrivacy and the GDPR want prior opt-IN before a non-essential
 * advertising cookie is set — and this site actively serves those markets: eleven
 * languages including German, French and Spanish, at /de, /fr, /es (see
 * lib/i18n/locales.js). Those localized pages are rendered from these same English
 * files, so they carry this tag.
 *
 * Rather than build a consent banner in eleven languages, the tag simply does not
 * load there. Nothing is asked, nothing is stored, and nothing is sent to Google.
 *
 * WHY TIMEZONE AND NOT AN IP LOOKUP. The public pages are served as static files
 * (lib/http/app-middleware.js), so there is no per-request hook to stamp a country
 * into the HTML and no geo header to read. The alternative would be calling a
 * geo-IP service on every page view — which would ship every visitor's IP to a
 * third party in order to decide whether to ship their IP to a third party. The
 * browser's own timezone costs no request and tells nobody anything.
 *
 * IT OVER-BLOCKS, ON PURPOSE. `Europe/*` covers Moscow, Istanbul and Kyiv, which
 * are not EEA; a traveller and anyone on a VPN are misread in both directions. The
 * error that matters is the one that sets an ad cookie on a Berlin visitor with no
 * consent, so the whole prefix is treated as in-scope and the cost is some lost ad
 * measurement in places that were never the target market anyway.
 *
 * On an `Intl` exception the tag LOADS, matching the storage branch above: the
 * failure direction is chosen once, in one place, rather than per-check.
 */
window.dataLayer = window.dataLayer || [];
window.gtag =
  window.gtag ||
  function () {
    window.dataLayer.push(arguments);
  };

// Also declared in scripts/ad-optout.js — see the note above.
var STAGIFY_AD_OPTOUT_KEY = 'stagifyAdOptOut';

/**
 * Whether this visitor has opted out of ad measurement, by browser signal or by
 * the control on the privacy page.
 */
function stagifyAdOptedOut() {
  // The opt-out preference signal. Read on its own so a later storage exception
  // cannot overturn it.
  if (navigator.globalPrivacyControl === true) return true;
  try {
    return window.localStorage.getItem(STAGIFY_AD_OPTOUT_KEY) === '1';
  } catch (e) {
    // Storage unavailable (private mode, blocked cookies). Not an opt-out.
    return false;
  }
}

// EEA zones that do not sit under the `Europe/` prefix: Iceland, and Spain's and
// Portugal's Atlantic territories.
var STAGIFY_EEA_ATLANTIC_ZONES = [
  'Atlantic/Reykjavik',
  'Atlantic/Canary',
  'Atlantic/Azores',
  'Atlantic/Madeira',
];

/**
 * Whether this visitor looks to be in a consent-required region (EEA, UK, or
 * Switzerland), judged from the browser's timezone. See THE REGION GATE above for
 * why this is a timezone and why it deliberately over-blocks.
 */
function stagifyAdRegionBlocked() {
  try {
    var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz) return false;
    if (tz.indexOf('Europe/') === 0) return true;
    return STAGIFY_EEA_ATLANTIC_ZONES.indexOf(tz) > -1;
  } catch (e) {
    // No Intl, or a browser that refuses to resolve a zone. Not a region block.
    return false;
  }
}

if (!window.__gtagConfigured && !window.__gtagOptedOut) {
  if (stagifyAdRegionBlocked()) {
    // Both flags: `__gtagOptedOut` is the outcome every reader cares about (the tag
    // did not load), and `__gtagRegionBlocked` is WHY, so scripts/ad-optout.js can
    // explain the state instead of offering a toggle that cannot change it.
    window.__gtagOptedOut = true;
    window.__gtagRegionBlocked = true;
  } else if (stagifyAdOptedOut()) {
    // Left for scripts/ad-optout.js to read back, so the privacy page can tell the
    // visitor what actually happened on this load rather than guessing.
    window.__gtagOptedOut = true;
  } else {
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
}
