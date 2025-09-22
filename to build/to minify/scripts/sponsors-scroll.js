/**
 * Sponsors Horizontal Scrolling Animation
 * Continuous scroll without any time-based resets
 */

document.addEventListener('DOMContentLoaded', function() {
  const sponsorsTrack = document.getElementById('sponsors-track');
  if (!sponsorsTrack) return;

  // Reduced motion support for accessibility
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    sponsorsTrack.style.transform = 'translateX(0)';
    return;
  }

  let scrollPosition = 0;
  
  function getScrollSpeed() {
    // Slower speed on mobile devices
    if (window.innerWidth <= 768) {
      return 0.25; // pixels per frame on mobile
    }
    return 0.4; // pixels per frame on desktop
  }
  
  let scrollSpeed = getScrollSpeed();
  
  function calculateLoopDistance() {
    const sponsorItems = sponsorsTrack.querySelectorAll('.sponsor-item');
    const totalItems = sponsorItems.length;
    const itemsPerSet = totalItems / 2;
    
    let totalWidth = 0;
    for (let i = 0; i < itemsPerSet; i++) {
      totalWidth += sponsorItems[i].offsetWidth;
    }
    
    const computedStyle = window.getComputedStyle(sponsorsTrack);
    const gap = parseInt(computedStyle.gap) || 0;
    
    // Include gaps between items AND the gap that would naturally occur at the loop reset
    // This ensures seamless transition when resetting from end to beginning
    totalWidth += gap * itemsPerSet;
    
    return totalWidth;
  }

  let loopDistance = calculateLoopDistance();
  let animationId;

  function scroll() {
    scrollPosition += scrollSpeed;
    
    // Reset position when we've scrolled one complete loop
    if (scrollPosition >= loopDistance) {
      scrollPosition = 0;
    }
    
    sponsorsTrack.style.transform = `translateX(-${scrollPosition}px)`;
    animationId = requestAnimationFrame(scroll);
  }

  // Start scrolling
  scroll();

  // Recalculate on resize
  let resizeTimeout;
  window.addEventListener('resize', function() {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      loopDistance = calculateLoopDistance();
      scrollSpeed = getScrollSpeed(); // Update speed on resize
    }, 100);
  });

  // Pause when page is hidden
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
      cancelAnimationFrame(animationId);
    } else {
      scroll();
    }
  });
});
