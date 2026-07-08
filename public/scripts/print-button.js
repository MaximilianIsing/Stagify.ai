// Wires up "Print / Save PDF" buttons. Any element tagged data-print opens the
// browser print dialog on click. Replaces an inline onclick="window.print()" so
// the CSP can drop 'unsafe-inline' from script-src.
(function () {
  var els = document.querySelectorAll('[data-print]');
  for (var i = 0; i < els.length; i++) {
    els[i].addEventListener('click', function () { window.print(); });
  }
})();
