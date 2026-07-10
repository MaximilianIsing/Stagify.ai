// Progressive-enhancement loader for non-critical stylesheets. They ship as
// media="print" (so they don't block first render) and are flipped to media="all"
// here once available. Loaded as a render-blocking <script src> at the same spot
// the former inline block occupied — right after the lazy <link>s — so the flip
// happens as early as before, minus the 'unsafe-inline' the inline version needed.
(function () {
  var links = document.querySelectorAll('link[data-lazy-css]');
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
