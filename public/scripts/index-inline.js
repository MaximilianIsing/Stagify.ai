// Two small homepage behaviours that used to live in inline <script> blocks,
// externalised so the CSP can drop 'unsafe-inline' from script-src. Loaded with
// defer; both only act after the DOM is parsed / on window load.

// 1) Keep an incoming fragment (#faq, #plans, #ai-designer-demo, …) landing on the
//    thing it names.
//
//    WHY THE UA CANNOT BE TRUSTED HERE. index-deferred.js runs the below-fold modules
//    AFTER `load`, i.e. after the browser has already done its one fragment scroll, and
//    one of them changes the page's height above the anchors: home-testimonials.js
//    collapses #testimonials from its no-JS column of five stacked quotes (~2000px) into
//    a ~375px deck. Everything below that section — #compare, #why, #plans, #faq — then
//    slides ~1.6k px UP the document while the scroll position stays put, so
//    `index.html#faq` (the Stagify+ page's "Questions before you buy?" link) used to land
//    in the footer, well past the FAQ. Re-assert the scroll while the page is still
//    resizing, and stop the moment the visitor takes over.
(function () {
  // How long the correction stays armed. NOT a "give the page a moment" fudge: it has to
  // outlast index-deferred.js, which schedules the whole below-fold batch through
  // requestIdleCallback with a 2000ms timeout — so on a busy main thread
  // home-testimonials.js has not even STARTED loading until t≈2s, and only then does the
  // deck collapse. Anything tighter reverts to the old behaviour exactly when the device
  // is slow enough for it to matter.
  var WINDOW_MS = 8000;

  // Read once. staging-entry.js consumes and strips its own `#stage` / `#basic-mask`
  // during page setup, so by the time this runs an action fragment is already gone —
  // whatever is left here names a place on the page, not a screen to open.
  var hash = location.hash || '';
  if (hash.length < 2) return;

  /** @returns {Element|null} The box to bring into view, or null if the id resolves to nothing. */
  function scrollTarget() {
    var el;
    try {
      el = document.getElementById(decodeURIComponent(hash.slice(1)));
    } catch (_e) {
      el = null; // a malformed %-escape in the fragment
    }
    if (!el) return null;
    // #ai-designer-demo is a panel of the studio showcase carousel, absolutely
    // positioned and 3D-transformed, so its own box is a poor scroll target — scroll
    // the section that contains it. studio-showcase.js separately reads the hash and
    // brings this panel to the front. Falls back to the element itself so this keeps
    // working if the carousel is ever unwound back into plain sections.
    if (el.id === 'ai-designer-demo') return el.closest('.home-section') || el;
    // Everything else is scrolled exactly where the UA would have scrolled it, so this
    // only ever CORRECTS a landing, never invents a different one.
    return el;
  }

  function assert() {
    var el = scrollTarget();
    if (el) el.scrollIntoView({ block: 'start' });
  }

  function afterLoad() {
    if (!scrollTarget()) return;
    assert();

    var evs = ['wheel', 'touchstart', 'keydown', 'pointerdown'];
    var observer = null;
    var timer = 0;
    function stop() {
      if (observer) observer.disconnect();
      clearTimeout(timer);
      evs.forEach(function (ev) { window.removeEventListener(ev, stop); });
    }
    evs.forEach(function (ev) {
      window.addEventListener(ev, stop, { once: true, passive: true });
    });
    var scroller = document.querySelector('main');
    if (!scroller || !window.ResizeObserver) {
      // No ResizeObserver: a single late re-assert, which is what this block did before
      // it learned to watch. Still catches the deck, the only mover that matters.
      timer = setTimeout(function () { assert(); stop(); }, WINDOW_MS);
      return;
    }
    // Ceiling on the correction window: past this the position is the visitor's, even if
    // they never touched it.
    timer = setTimeout(stop, WINDOW_MS);
    observer = new ResizeObserver(function () { assert(); });
    // Watch the SECTIONS, not the scroller: `main` is the scroll container
    // (styles.css), so its own border box is viewport-sized and never changes — the
    // height that moves is the content laid out inside it.
    Array.prototype.forEach.call(scroller.children, function (child) { observer.observe(child); });
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
