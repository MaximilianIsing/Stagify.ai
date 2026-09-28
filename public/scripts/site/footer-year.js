// Corrects the copyright year in page footers. Replaces the former inline
// <script>document.write(new Date().getFullYear())</script> snippets so the CSP
// can drop 'unsafe-inline' from script-src.
//
// The markup SEEDS the year — every page ships <span class="footer-year">2026</span>
// with a literal year, not an empty span. That is the whole point: this file loads as
// a module (defer-by-default) over its own request, so it cannot run until the page is
// parsed and the script has come down the wire, and an empty span meant the footer
// visibly read "© Stagify.ai" for a beat before the year popped in.
//
// So this script is a CORRECTOR, not the source of truth: it only matters when the
// seeded year has gone stale — a tab left open across New Year, or a deploy that
// predates the rollover. test/frontend/site-footer-parity.test.js pins the seed so a
// new page cannot reintroduce the empty span and lose the fast paint again.
(function () {
  var year = String(new Date().getFullYear());
  var spans = document.querySelectorAll('.footer-year');
  for (var i = 0; i < spans.length; i++) {
    // Skip the write when the seed is already right, which is the normal case — an
    // unconditional textContent assignment dirties the node and costs a relayout.
    if (spans[i].textContent !== year) spans[i].textContent = year;
  }
})();

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
