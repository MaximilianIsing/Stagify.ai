// Progressive-enhancement loader for non-critical stylesheets. They ship as
// media="print" (so they don't block first render) and are flipped to media="all"
// here once available. Loaded as a render-blocking <script src> at the same spot
// the former inline block occupied — right after the lazy <link>s — so the flip
// happens as early as before, minus the 'unsafe-inline' the inline version needed.
//
// Shared by every page that defers a stylesheet, not just the homepage (it was named
// index-lazy-css.js while index.html was the only caller). The selector is
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
