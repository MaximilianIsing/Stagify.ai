// Two small homepage behaviours that used to live in inline <script> blocks,
// externalised so the CSP can drop 'unsafe-inline' from script-src. Loaded with
// defer; both only act after the DOM is parsed / on window load.

// 1) When arriving with #ai-designer-demo (e.g. bounced from the Stagify+ AI
//    Designer page), scroll to that row reliably. Native anchor scrolling can
//    land short while below-the-fold content settles, so re-assert once after
//    load — unless the visitor has already taken over scrolling.
(function () {
  if (location.hash !== '#ai-designer-demo') return;
  function scrollToDemo() {
    var el = document.getElementById('ai-designer-demo');
    if (!el) return;
    // #ai-designer-demo is now a panel of the studio showcase carousel, absolutely
    // positioned and 3D-transformed, so its own box is a poor scroll target — scroll
    // the section that contains it. studio-showcase.js separately reads the hash and
    // brings this panel to the front. Falls back to the element itself so this keeps
    // working if the carousel is ever unwound back into plain sections.
    var target = el.closest('.home-section') || el;
    target.scrollIntoView({ block: 'start' });
  }
  function afterLoad() {
    scrollToDemo();
    // Re-assert once after late content (images/fonts) settles, but bail
    // if the visitor has already started scrolling themselves.
    var cancelled = false;
    var evs = ['wheel', 'touchstart', 'keydown', 'pointerdown'];
    function cancel() { cancelled = true; }
    evs.forEach(function (ev) {
      window.addEventListener(ev, cancel, { once: true, passive: true });
    });
    setTimeout(function () {
      if (!cancelled) scrollToDemo();
      evs.forEach(function (ev) { window.removeEventListener(ev, cancel); });
    }, 350);
  }
  // Guarded rather than a bare `load` listener: index-deferred.js injects this file
  // after `load`, so the event has already fired and the deep link would silently stop
  // working — the visitor would land on the homepage top instead of the demo row.
  if (document.readyState === 'complete') afterLoad();
  else window.addEventListener('load', afterLoad, { once: true });
})();

// 2) Spotlight glass: point a soft light at the cursor for each testimonial
//    card by tracking pointer position into --mx/--my (rAF-throttled).
(function () {
  var cards = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('#testimonials .tw-card'));
  if (!cards.length || !window.matchMedia || !matchMedia('(hover: hover)').matches) return;
  cards.forEach(function (card) {
    var queued = false, lx = 0, ly = 0;
    card.addEventListener('pointermove', function (e) {
      var r = card.getBoundingClientRect();
      lx = e.clientX - r.left;
      ly = e.clientY - r.top;
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        card.style.setProperty('--mx', lx + 'px');
        card.style.setProperty('--my', ly + 'px');
      });
    });
  });
})();

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
