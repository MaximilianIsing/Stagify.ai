// Sponsors marquee — infinite horizontal auto-scroll of the sponsor logos.
// The track holds the logo set duplicated twice; the transform resets to 0 once
// the first copy has scrolled fully off, giving a seamless loop. Honours
// prefers-reduced-motion and pauses while the tab is hidden.
// Classic <script> (defines the globals `initSponsorsScroll` / `cleanupSponsorsScroll`).

let sponsorsAnimationId = null;
let sponsorsInitialized = false;

function initSponsorsScroll() {
  if (sponsorsInitialized) return;

  const track = document.getElementById('sponsors-track');
  if (!track) return;

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    track.style.transform = 'translateX(0)';
    return;
  }

  let offset = 0;

  // Pixels advanced per frame, tuned down on smaller viewports.
  function getScrollSpeed() {
    if (window.innerWidth <= 768) return 0.85;
    if (window.innerWidth <= 1366) return 1;
    if (window.innerWidth <= 1920) return 0.9;
    return 0.7;
  }

  let speed = getScrollSpeed();

  // Width of the first (original) half of the items including gaps — the offset
  // at which we wrap back to 0.
  function computeResetWidth() {
    const items = track.querySelectorAll('.sponsor-item');
    const halfCount = items.length / 2;
    let width = 0;
    for (let i = 0; i < halfCount; i++) width += items[i].offsetWidth;
    const gap = parseInt(window.getComputedStyle(track).gap) || 0;
    return width + gap * halfCount;
  }

  let resetWidth = computeResetWidth();

  function animate() {
    if (sponsorsAnimationId) cancelAnimationFrame(sponsorsAnimationId);
    offset += speed;
    if (offset >= resetWidth) offset = 0;
    track.style.transform = `translateX(-${offset}px)`;
    sponsorsAnimationId = requestAnimationFrame(animate);
  }

  if (sponsorsAnimationId) cancelAnimationFrame(sponsorsAnimationId);
  animate();
  sponsorsInitialized = true;

  let resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resetWidth = computeResetWidth();
      speed = getScrollSpeed();
    }, 100);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (sponsorsAnimationId) {
        cancelAnimationFrame(sponsorsAnimationId);
        sponsorsAnimationId = null;
      }
    } else if (!sponsorsAnimationId) {
      animate();
    }
  });
}

function cleanupSponsorsScroll() {
  if (sponsorsAnimationId) {
    cancelAnimationFrame(sponsorsAnimationId);
    sponsorsAnimationId = null;
  }
  sponsorsInitialized = false;
}

document.addEventListener('DOMContentLoaded', initSponsorsScroll);
window.addEventListener('beforeunload', cleanupSponsorsScroll);

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
