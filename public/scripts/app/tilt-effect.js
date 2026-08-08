// 3D tilt effect for the contact cards (scripts/app.js loads on contact.html).
//
// Plain exported init — no app state. Silent no-op on pages without a
// .contact-card (the home page has none).
//
// PC ONLY, and the gate is here rather than in CSS on purpose. A touch device has
// no hover, so the only thing that can drive the tilt is the synthetic
// mouseenter -> mousemove pair a tap emits: that buys a forced layout read
// (getBoundingClientRect) and a transform write on a card carrying
// `transition:transform .1s ease-out`, for an effect the user cannot actually aim.
// Worse, no mouseleave follows a tap, so the card is left stuck mid-rotation. A CSS
// gate would not fix either half — this writes an INLINE style.transform, which
// outranks the deliberate `.contact-card:hover{transform:none}` phone rule in
// styles.css. Bailing before the listeners are attached is what removes the cost;
// suppressing the visual would not.
//
// Note this fails CLOSED (no matchMedia -> no tilt), the opposite of
// scripts/ai-designer-gate.js, which fails open. That one redirects, so guessing
// wrong throws a real user off the page; this one is decorative, so an unclassifiable
// device is better off without it. Same idiom as scripts/card-spotlight.js (the other
// cursor-following card effect) and scripts/stagify-plus-blackhole.js.

/**
 * @param {Window} win
 * @returns {boolean}
 */
function tiltSupported(win) {
  if (!win || typeof win.matchMedia !== 'function') return false;
  if (!win.matchMedia('(hover: hover) and (pointer: fine)').matches) return false;
  return !win.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function init3DTiltEffect() {
    if (!tiltSupported(window)) return;

    // Tilt is only for the contact cards.
    const contactCards = document.querySelectorAll('.contact-card');
    contactCards.forEach((card) => {
      applyTiltEffectToElement(card);
    });
}

function applyTiltEffectToElement(element) {
    let isHovering = false;
    let rect = null;        // cached on enter so we don't force a layout read per move
    let rafId = null;
    let lastX = 0, lastY = 0;

    element.addEventListener('mouseenter', function() {
      isHovering = true;
      rect = element.getBoundingClientRect();
    });

    element.addEventListener('mouseleave', function() {
      isHovering = false;
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      // Reset to neutral position
      element.style.transform = 'rotateX(0deg) rotateY(0deg)';
    });

    element.addEventListener('mousemove', function(e) {
      if (!isHovering || !rect) return;
      lastX = e.clientX;
      lastY = e.clientY;
      // Coalesce rapid moves into a single transform write per frame.
      if (rafId) return;
      rafId = requestAnimationFrame(function() {
        rafId = null;
        // Calculate rotation values (max 8 degrees) from the cached rect.
        const rotateY = ((lastX - (rect.left + rect.width / 2)) / (rect.width / 2)) * 8;
        const rotateX = -((lastY - (rect.top + rect.height / 2)) / (rect.height / 2)) * 8;
        element.style.transform = `rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
      });
    });
}
