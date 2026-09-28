// Stagify.ai — the homepage hero's remembered pick, applied before the first paint.
//
// The hero photo ships STATIC in index.html because it is the LCP element, and the pair it
// ships is the DEFAULT one (Modern bedroom) because index.html is one file cached for
// everybody. scripts/home/hero-picker.js remembers what the visitor last picked and restores it —
// but it is a module, so it runs at the end of parsing, and its restore goes out over the
// network. A returning visitor whose pick is not the default therefore watched the default
// photo paint and then cross-fade into theirs, a beat later. That flash is what this exists
// to remove, and removing it is all it does.
//
// WHY A SEPARATE, CLASSIC, PARSER-BLOCKING FILE. It has to run before the first paint:
// a module (or a defer) runs after parsing, which is exactly the timing that produced the
// flash. It cannot be inline, because the CSP carries no 'unsafe-inline' for scripts (see
// lib/http/app-middleware.js) — inline JS on these pages moves to a file, always. And it has
// to sit AFTER the <img> in the markup, because it needs the node. Same shape, same reasons,
// as scripts/site/session-class.js, which reads localStorage in <head> for the same pre-paint
// purpose; like that one it is preloaded from <head> so a parser-blocking fetch is not
// discovered late and queued behind ~60 module tags.
//
// IT KNOWS NOTHING ABOUT ROOMS OR STYLES, deliberately. The room/style tables live in
// hero-picker.js and re-listing them here is how they drift apart. Instead hero-picker.js
// writes the RESOLVED basename ("coastal-living-room") into its own key beside the pick, and
// this file does a string substitution inside the src/srcset already on the element. That
// also means no media path, no width ladder and no `sizes` string are written down twice, and
// that the localized renders (/es, /fr, … under <base href="/">) are handled by construction.
//
// IT IS THE ONLY PLACE OTHER THAN hero-picker.js THAT TOUCHES THAT <img>, and it hands over
// cleanly: the pair it applied is left on the node as data-hp-restored, which hero-picker.js
// reads so it adopts what is actually on screen instead of re-fetching it.
(function () {
  var img = document.querySelector('[data-hp-img]');
  if (!img) return;

  var want;
  try {
    want = window.localStorage.getItem('heroPickImg'); // IMG_KEY in scripts/home/hero-picker.js
  } catch {
    return; // storage blocked; the default pair is a perfectly good answer
  }
  /* Shape check, not a lookup — the tables are not here. It is the visitor's own storage, so
     this is not a trust boundary so much as a guard against a stale or hand-edited value
     becoming an arbitrary URL in src. Slug halves only: <style>-<room>, room slugs being one
     or two words ("living-room"). */
  if (!want || !/^[a-z]+(?:-[a-z]+){1,3}$/.test(want)) return;

  var src = img.getAttribute('src') || '';
  var srcset = img.getAttribute('srcset') || '';
  var cur = src.slice(src.lastIndexOf('/') + 1, -'.webp'.length); // "modern-bedroom"
  if (!cur || cur === want) return;

  /* A remembered pair whose renders no longer exist would otherwise leave an empty frame
     where the LCP photo should be — worse than the flash this removes. One 404 and the
     markup's own pair goes back, including the data attribute, so hero-picker.js adopts the
     default like any first-time visit. */
  img.addEventListener('error', function revert() {
    img.removeEventListener('error', revert);
    img.removeAttribute('data-hp-restored');
    img.srcset = srcset;
    img.src = src;
  });

  /* srcset before src, for the reason setCandidates() in hero-picker.js gives: src first and
     the browser may commit to that URL before it has the candidate list. `sizes` is left
     alone — the canvas is the same size whatever is in it. */
  img.srcset = srcset.split(cur).join(want);
  img.src = src.replace(cur, want);
  img.setAttribute('data-hp-restored', want);
})();
