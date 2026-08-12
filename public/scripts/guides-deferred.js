// guides.html scripts that have nothing to do with first paint, loaded after `load`.
//
// WHY. Same reasoning as index-deferred.js: there is no bundler, so the page hand-lists
// its tags and every one of them is downloaded, parsed and executed inside the LCP
// window. demo-data.js (41 KB) and demo-player.js (13 KB) are the two biggest, and
// neither has anything to do with what the visitor first sees — the walkthroughs live
// below the fold, inside a tab panel that ships `hidden`. index.html already routes this
// exact pair through index-deferred.js; guides.html was still loading them eagerly.
//
// ORDER IS LOAD-BEARING. demo-data.js defines `window.STAGIFY_DEMOS`; demo-player.js
// defines the player that reads it. Neither is `async`, and non-async injected scripts
// preserve execution order among themselves, so listing them in this order is enough.
//
// THE PART THAT IS NOT JUST A COPY OF index-deferred.js. On index.html the mount is
// itself deferred (designer-demo.js is in the same list, after these two), so it cannot
// run early. On guides.html the mount lives in guides.js, which is NOT deferred — it
// wires the tablist at DOMContentLoaded so the tabs work immediately. That leaves a real
// gap: between first paint and these scripts landing, guides.js's mountPlayer() finds no
// window.SupademoPlayer, returns silently, and never tries again. A deep link
// (#guide-demo-<key>, which the HowTo structured data publishes) or a quick tab click in
// that window would leave a permanently blank panel with no error. So this file does not
// just inject — it calls back into guides.js afterwards to mount whatever is open.

/**
 * Exported so test/frontend/guides-deferred.test.js can assert against the real array
 * rather than regex-scraping this file, and so the module is genuinely *loaded* by a
 * test (which is what test/frontend/untested-frontend-modules.test.js counts).
 *
 * @type {Array<{ src: string, module: boolean }>}
 */
export const DEFERRED = [
  { src: 'scripts/demo-data.js', module: false },
  { src: 'scripts/demo-player.js', module: false },
];

/** Ask guides.js to mount the open walkthrough now that the player exists. */
function remountVisible() {
  const api = /** @type {any} */ (window).StagifyGuides;
  if (api && typeof api.remountVisible === 'function') api.remountVisible();
}

function loadDeferredScripts() {
  let pending = DEFERRED.length;
  // Fire the retry when the LAST script settles, not on each one: mounting needs both
  // STAGIFY_DEMOS and SupademoPlayer, and calling early would just bail again silently.
  // `error` counts too — a failed fetch must not leave the counter hanging, and
  // remountVisible() is a no-op when the globals genuinely are not there.
  const settled = () => { if (--pending === 0) remountVisible(); };

  for (const entry of DEFERRED) {
    const el = document.createElement('script');
    if (entry.module) el.type = 'module';
    else el.defer = true;
    el.src = entry.src;
    el.addEventListener('load', settled, { once: true });
    el.addEventListener('error', settled, { once: true });
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
