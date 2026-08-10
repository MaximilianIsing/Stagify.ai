// The blue "glow + scale" hover effect that used to live in inline
// onmouseover/onmouseout attributes on the hero catchphrase and the nav
// "Upload. Stage. Imagine." text. Any element tagged data-hover-glow gets it,
// so the CSP can drop 'unsafe-inline' from script-src.
(function () {
  // The hover deliberately no longer changes `color`. It used to swap the text to
  // #3b82f6, which against the page background (#b2c4f6) is 2.12:1 — below even the
  // 3:1 large-text floor, in a state that persists for as long as the pointer rests
  // there. The effect itself is carried by the scale and the blue halo, so keeping
  // the ink at its base #1e3a8a loses nothing visually and keeps the text readable.
  // The halo is a touch stronger to compensate for the colour that is no longer
  // doing any of the work.
  function over(e) {
    var s = e.currentTarget.style;
    s.transform = 'scale(1.1)';
    s.textShadow = '0 0 22px rgba(59, 130, 246, 0.65)';
  }
  function out(e) {
    var s = e.currentTarget.style;
    s.transform = 'scale(1)';
    s.textShadow = 'none';
  }
  var els = document.querySelectorAll('[data-hover-glow]');
  for (var i = 0; i < els.length; i++) {
    els[i].addEventListener('mouseover', over);
    els[i].addEventListener('mouseout', out);
  }
})();

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
