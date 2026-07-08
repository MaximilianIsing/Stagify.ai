// The blue "glow + scale" hover effect that used to live in inline
// onmouseover/onmouseout attributes on the hero catchphrase and the nav
// "Upload. Stage. Imagine." text. Any element tagged data-hover-glow gets it,
// so the CSP can drop 'unsafe-inline' from script-src.
(function () {
  function over(e) {
    var s = e.currentTarget.style;
    s.transform = 'scale(1.1)';
    s.color = '#3b82f6';
    s.textShadow = '0 0 20px rgba(59, 130, 246, 0.5)';
  }
  function out(e) {
    var s = e.currentTarget.style;
    s.transform = 'scale(1)';
    s.color = '#1e3a8a';
    s.textShadow = 'none';
  }
  var els = document.querySelectorAll('[data-hover-glow]');
  for (var i = 0; i < els.length; i++) {
    els[i].addEventListener('mouseover', over);
    els[i].addEventListener('mouseout', out);
  }
})();
