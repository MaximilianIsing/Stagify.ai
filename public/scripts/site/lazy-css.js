// Progressive-enhancement loader for non-critical stylesheets. They ship as
// media="print" (so they don't block first render) and are flipped to media="all"
// here once available. It sits right after the lazy <link>s, as an external file so
// the CSP needs no 'unsafe-inline'.
//
// It is NOT render-blocking: every call site loads it as <script type="module">, which
// implies `defer`, so the flip cannot run until the whole document is parsed (index.html
// is ~261 KB). Combined with the Lowest fetch priority the browser gives a media="print"
// sheet, the gap between first paint and the flip is wide. That is fine for what
// belongs here — modals, below-fold animations — but it is why a rule for anything
// VISIBLE at first paint must not live in a sheet listed below. The account button was
// exactly that mistake; see the note beside .profile-menu-wrap in styles.css.
//
// Shared by every page that defers a stylesheet, not just the homepage. The selector is
// page-agnostic, so adopting the pattern on a new page is two steps and no JS change:
// mark the <link> `media="print" data-lazy-css`, and include this script after it.
//
// Whenever you do that, carry the <noscript> fallback across too — the flip is the
// only thing that ever loads those sheets, so a no-JS visitor gets none of them.
(function () {
  var links = /** @type {NodeListOf<HTMLLinkElement>} */ (document.querySelectorAll('link[data-lazy-css]'));
  for (var i = 0; i < links.length; i++) {
    (function (link) {
      if (link.sheet) { link.media = 'all'; }
      else { link.addEventListener('load', function () { link.media = 'all'; }); }
    })(links[i]);
  }
})();

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
