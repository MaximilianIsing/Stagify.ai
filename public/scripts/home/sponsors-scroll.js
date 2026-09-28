// Sponsors marquee — infinite horizontal auto-scroll of the sponsor logos.
// The track holds the logo set duplicated twice; the animation translates by
// exactly one copy's width and repeats, giving a seamless loop. Honours
// prefers-reduced-motion.
//
// The motion itself belongs to CSS (@keyframes sponsors-marquee in styles.css).
// This module only MEASURES: it writes --marquee-distance and --marquee-duration
// onto the track and adds .is-animating. That split is the whole point —
//
//   This used to be a rAF loop doing `offset += speed`, i.e. pixels per FRAME.
//   The real scroll rate was therefore speed x the display's refresh rate: 54px/s
//   on a 60Hz panel, ~108px/s on a 120Hz one, and it fell behind by a whole
//   0.9px every time the main thread dropped a frame (this is the busiest page
//   in the app). A CSS animation is time-based by definition and runs on the
//   compositor, so neither refresh rate nor main-thread jank can touch it.
//
// The speed buckets that used to key off window.innerWidth are gone too: they
// were non-monotonic (a 1367px window ran 11% slower than a 1366px one) and gave
// the widest screens the slowest setting. Duration is now distance / speed, so
// px-per-second is constant at every viewport width by construction.

let sponsorsResizeObserver = null;
let sponsorsInitialized = false;

// The one knob. Pixels per second, at every refresh rate and every width.
const SPEED_PX_PER_SEC = 100;

function initSponsorsScroll() {
  if (sponsorsInitialized) return;

  const track = /** @type {HTMLElement|null} */ (document.getElementById('sponsors-track'));
  if (!track) return;

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    track.style.transform = 'translateX(0)';
    // Parking the track is not enough: it sits in an overflow:hidden box wide
    // enough for ~2 of the 10 logos, so bailing out here used to make the other 8
    // unreachable rather than merely still. Hand the strip to the browser as a
    // normal scroller instead (see .sponsors--static in styles.css).
    const box = track.closest('.sponsors-container');
    if (box) box.classList.add('sponsors--static');
    sponsorsInitialized = true;
    return;
  }

  // The distance at which the loop wraps: how far the first item of the DUPLICATE
  // half sits from the first item of the original. Translating by exactly that puts
  // duplicate logo #1 where original logo #1 was, which is what makes the seam
  // invisible.
  //
  // Note this is NOT 50% of the track. The track is 22 items with only 21 gaps
  // between them, so translateX(-50%) lands half a gap short — measured at 1987px
  // against the correct 2014px on a 1080p desktop, i.e. a 27px lurch on every
  // repeat. That is why the distance has to be measured here and handed to CSS.
  //
  // Measured from getBoundingClientRect(), not offsetLeft/offsetWidth: those round
  // to whole pixels, and the old approach (sum 11 widths + 11 gaps) accumulated
  // that rounding into a ~1px error, which is a 1px jump once per loop. Rects are
  // fractional, and one subtraction cannot drift.
  function computeResetWidth() {
    const items = /** @type {HTMLElement[]} */ (Array.from(track.querySelectorAll('.sponsor-item')));
    const half = Math.floor(items.length / 2);
    if (half < 1 || !items[half]) return 0;
    return items[half].getBoundingClientRect().left - items[0].getBoundingClientRect().left;
  }

  let appliedDistance = 0;

  function applyMarquee() {
    const distance = computeResetWidth();
    if (!(distance > 0)) return false;
    track.style.setProperty('--marquee-distance', `${distance}px`);
    track.style.setProperty('--marquee-duration', `${distance / SPEED_PX_PER_SEC}s`);
    track.classList.add('is-animating');
    appliedDistance = distance;
    return true;
  }

  // computeResetWidth() sums offsetWidth, which is 0 for an <img> that has not
  // loaded — and these 22 tags carry no width/height attributes (deliberately;
  // see the comment above the track in index.html). index-deferred.js injects
  // this file after `load`, so the images are normally settled already, but the
  // DOMContentLoaded path at the bottom can arrive first and would otherwise bake
  // a nonsense duration into the animation. Measure only once they are ready.
  function whenLogosReady() {
    const pending = Array.from(track.querySelectorAll('img'))
      .filter((img) => !img.complete || img.naturalWidth === 0);
    if (!pending.length) return Promise.resolve();
    return Promise.all(pending.map((img) => new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    })));
  }

  sponsorsInitialized = true;

  whenLogosReady().then(() => {
    if (!sponsorsInitialized) return;
    applyMarquee();

    // A ResizeObserver on the track rather than a window.resize listener: the
    // wrap distance changes with the gap and logo sizes (they step at the 768px
    // and 480px breakpoints), and with font/layout shifts a window listener never
    // hears about. Transforms do not affect layout size, so the running animation
    // cannot feed this back into itself.
    if (typeof ResizeObserver !== 'function') return;
    let resizeTimer;
    sponsorsResizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!sponsorsInitialized) return;
        const next = computeResetWidth();
        if (!(next > 0) || Math.abs(next - appliedDistance) < 1) return;
        // Restart from 0 rather than retargeting mid-flight: the keyframes run
        // from translateX(0), so changing the endpoint under a running animation
        // would jump the strip. Removing the class + reading offsetWidth forces
        // the reflow that makes the re-add count as a new animation.
        track.classList.remove('is-animating');
        void track.offsetWidth;
        applyMarquee();
      }, 150);
    });
    sponsorsResizeObserver.observe(track);
  });
}

function cleanupSponsorsScroll() {
  if (sponsorsResizeObserver) {
    sponsorsResizeObserver.disconnect();
    sponsorsResizeObserver = null;
  }
  const track = document.getElementById('sponsors-track');
  if (track) {
    track.classList.remove('is-animating');
    track.style.removeProperty('--marquee-distance');
    track.style.removeProperty('--marquee-duration');
  }
  sponsorsInitialized = false;
}

// Guarded rather than a bare DOMContentLoaded listener: index-deferred.js injects this
// file after `load`, by which point that event has already fired and a plain listener
// would never run. The failure would be silent — no error, the marquee simply never
// starts. Same shape as staging-studio.js and home-reveal.js.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSponsorsScroll);
} else {
  initSponsorsScroll();
}
window.addEventListener('beforeunload', cleanupSponsorsScroll);

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
