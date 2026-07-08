// Fills the copyright year in page footers. Replaces the former inline
// <script>document.write(new Date().getFullYear())</script> snippets so the CSP
// can drop 'unsafe-inline' from script-src. Any <span class="footer-year"></span>
// placeholder gets the current year.
(function () {
  var year = String(new Date().getFullYear());
  var spans = document.querySelectorAll('.footer-year');
  for (var i = 0; i < spans.length; i++) {
    spans[i].textContent = year;
  }
})();
