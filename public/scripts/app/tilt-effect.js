// 3D tilt effect for the contact cards (scripts/app.js loads on contact.html).
//
// Plain exported init — no app state. Silent no-op on pages without a
// .contact-card (the home page has none).

export function init3DTiltEffect() {
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
