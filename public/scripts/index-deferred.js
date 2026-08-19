// Homepage scripts that have nothing to do with the hero, loaded after `load`.
//
// WHY. There is no bundler (a standing decision — docs/guides/architecture.md), so the
// homepage hand-lists its tags and every one of them is downloaded, parsed and executed
// during the LCP window. That was ~63 modules / 400 KB of source competing for a
// 4x-throttled mobile CPU while the browser was trying to paint the hero. The files
// below have no DOM hook above index.html's sponsors strip, so none of them needs to be
// in that window. Pulling them out is CPU relief, not bandwidth relief — the bandwidth
// problem was fixed separately.
//
// ORDER IS LOAD-BEARING for the first three: demo-data.js defines
// `window.STAGIFY_DEMOS`, demo-player.js defines the player that reads it, and
// designer-demo.js mounts the players. They are injected in array order and, because
// none of them is `async`, the browser preserves execution order among them.
//
// THE TRAP, if you add to this list. Everything here runs AFTER `load`, so a module
// that registers work on `DOMContentLoaded` or `load` will never initialise — the event
// has already fired. It fails silently: no error, the feature just does not happen.
// Before adding a file, check its init tail and convert it to the guarded form:
//
//     if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
//     else init();
//
// sponsors-scroll.js, star-border.js and index-inline.js all needed exactly that fix.
// (star-border.js is no longer injected — the hero counters stopped being pills — but the
// note stands for anything added to the list below.)
//
// CSP: `script-src 'self'` restricts where scripts may come from, not how the element
// got into the document, and there is no 'strict-dynamic'. Same-origin injected tags are
// fine — this is not an inline script.

/**
 * Exported so test/frontend/index-deferred.test.js can assert against the real array
 * rather than regex-scraping this file, and so the module is genuinely *loaded* by a
 * test (which is what test/frontend/untested-frontend-modules.test.js counts).
 *
 * @type {Array<{ src: string, module: boolean }>}
 */
export const DEFERRED = [
  // Starts the decorative background video, which index.html deliberately ships with
  // `preload="none"` and no `autoplay` so its 1.25 MB stays out of the LCP window. First
  // in the list because it is the only entry a visitor can SEE arrive — everything below
  // is below-fold behaviour. Zero imports.
  { src: 'scripts/bg-video-start.js', module: true },
  // The main staging island: 38 modules, ~267 KB of source, ~89 KB brotli — by a wide
  // margin the largest thing the homepage used to download before it could paint, and
  // nothing in it is reachable until somebody starts staging. scripts/hero-cta-boot.js
  // stays in <head> and covers the gap: a click on #hero-upload before this arrives
  // dynamic-imports it (same module instance — the module map dedupes with the tag
  // injected here) and then opens the picker.
  // Second in the list, ahead of the below-fold decoration, because it is the only entry
  // a visitor can be actively waiting on.
  { src: 'scripts/app.js', module: true },
  // Guides walkthrough player — data, renderer, then the mount. Keep in this order.
  { src: 'scripts/demo-data.js', module: false },
  { src: 'scripts/demo-player.js', module: false },
  { src: 'scripts/designer-demo.js', module: true },
  // The studio showcase carousel. It asks designer-demo.js to mount the front
  // panel's player, but does NOT depend on winning that race — these tags are
  // injected dynamically, so nothing here is ordered in practice, and the two
  // rendezvous on the `stagify:demo-mount-ready` event instead.
  { src: 'scripts/studio-showcase.js', module: true },
  // Below-fold section behaviour.
  { src: 'scripts/staging-studio.js', module: true },
  // #restage's "stage it again" button. Imports scripts/restage-pool.js, so the browser
  // fetches two files here — that pair is the whole cost, because the 100 renders
  // themselves are fetched one per press and never warmed.
  { src: 'scripts/home-restage.js', module: true },
  { src: 'scripts/home-reveal.js', module: true },
  // #learn's four photo strips. Independent of home-reveal.js despite both touching
  // that section: this one owns `.is-open`, home-reveal.js owns `.is-visible`, and the
  // checklist stagger deliberately keys off the former (see the note in home.css).
  { src: 'scripts/home-strips.js', module: true },
  // #testimonials' seven-quote deck. Self-contained: it owns `tw-deck--ready` and adds
  // nothing else, so it neither races nor depends on home-reveal.js, which owns
  // `.is-visible` on the .tw-deck wrapper above it.
  { src: 'scripts/home-testimonials.js', module: true },
  { src: 'scripts/home-text-animate.js', module: true },
  // #compare's savings calculator and #ai-shift's chart. Both mount their OWN
  // IntersectionObserver rather than watching home-reveal.js's `.is-visible`: that
  // script's showAll() fallback adds the class to every .reveal at once, which would
  // fire these for a card far below the fold.
  { src: 'scripts/home-figures.js', module: true },
  // #why's paired ✓/✗ highlighting. Separate from home-figures.js: that module is
  // scoped to the two data figures and shares their ramp/observer scaffolding, none
  // of which this needs — it is plain pointer and focus wiring.
  { src: 'scripts/home-whyus.js', module: true },
  // #faq's floor plan. Generates SVG only — the accordion itself is native <details>,
  // so nothing here is load-bearing for reading the FAQ. Mounts its OWN
  // IntersectionObserver for the same reason home-figures.js does.
  { src: 'scripts/home-faq-plan.js', module: true },
  { src: 'scripts/sponsors-scroll.js', module: true },
  { src: 'scripts/plus-cta-auth.js', module: true },
  { src: 'scripts/index-inline.js', module: true },
  // Pointer-only decoration; both early-return on a coarse pointer, so on the phones
  // this is optimising for they are pure download-and-parse cost.
  { src: 'scripts/hover-glow.js', module: true },
  { src: 'scripts/aurora-scrollbar.js', module: true },
  { src: 'scripts/card-spotlight.js', module: true },
];

function loadDeferredScripts() {
  for (const entry of DEFERRED) {
    const el = document.createElement('script');
    if (entry.module) el.type = 'module';
    else el.defer = true;
    el.src = entry.src;
    document.body.appendChild(el);
  }
}

function schedule() {
  // The fallback takes the options argument too (and ignores it) so the union of the
  // two signatures still accepts the two-arg call below.
  const idle =
    window.requestIdleCallback ||
    ((/** @type {() => void} */ cb, /** @type {IdleRequestOptions=} */ _opts) => setTimeout(cb, 1));
  // A timeout so a permanently busy main thread cannot starve these forever.
  idle(loadDeferredScripts, { timeout: 2000 });
}

if (document.readyState === 'complete') schedule();
else window.addEventListener('load', schedule, { once: true });
