/*
 * Card spotlight — a faint radial light that follows the cursor across frosted
 * glass cards, so the glass feels like a real, lit surface.
 *
 * Implementation: each card gets an absolutely-positioned overlay child at
 * z-index:-1 (with isolation:isolate on the card). That paints the glow ABOVE
 * the card's translucent background but BELOW its content — and crucially it
 * does NOT require overflow:hidden, so cards with overflowing badges (e.g. the
 * Stagify+ "popular" pill) keep them. The glow position tracks the pointer via
 * two CSS custom properties; opacity fade is pure CSS (:hover).
 *
 * Desktop only (fine pointer) — touch devices have no hover, so the effect is skipped.
 */
(function () {
  'use strict';

  if (!window.matchMedia || !window.matchMedia('(pointer: fine)').matches) return;

  var SELECTOR = [
    '.sp-feature',
    '.ent-highlight', '.ent-feature',
    '.whyus-card'
  ].join(',');

  var cards = document.querySelectorAll(SELECTOR);
  if (!cards.length) return;

  Array.prototype.forEach.call(cards, function (card) {
    if (card.querySelector(':scope > .card-spotlight')) return; // idempotent

    if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
    card.classList.add('has-spotlight');

    var overlay = document.createElement('span');
    overlay.className = 'card-spotlight';
    overlay.setAttribute('aria-hidden', 'true');
    card.appendChild(overlay);

    var raf = 0, mx = 50, my = 50;
    function apply() {
      raf = 0;
      overlay.style.setProperty('--sx', mx + '%');
      overlay.style.setProperty('--sy', my + '%');
    }

    card.addEventListener('pointermove', function (e) {
      var r = card.getBoundingClientRect();
      if (!r.width || !r.height) return;
      mx = ((e.clientX - r.left) / r.width) * 100;
      my = ((e.clientY - r.top) / r.height) * 100;
      if (!raf) raf = requestAnimationFrame(apply);
    }, { passive: true });
  });
})();
