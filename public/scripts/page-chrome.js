// Shared chrome for the non-studio pages: contact, status, guides.
//
// WHY THIS EXISTS. These three pages used to load `scripts/app.js` — index.html's
// staging application, ~175 KB across 21 static imports (stage-mask-editor,
// staging-pipeline, download-menu, furniture-refs, …). None of them has a
// #stage-modal, so every selector in that module resolved to null and the entire
// graph was downloaded, parsed and executed to accomplish two things. Those two
// things are below; everything else app.js did here was already a no-op
// (loadHeroStats() bails early without a .hp-stat__num, so it
// never even fired its /api/prompt-count + /api/contact-count requests).
//
// Do NOT "simplify" this into bare <script type="module"> tags pointing straight at
// app/background-video.js and app/tilt-effect.js. Both files only *export* their
// init function — neither self-invokes — so tags like that load, parse, and do
// nothing at all, silently. The calls have to live somewhere, and this is it.
//
// Do NOT move this file into a post-`load` deferred loader either: the timing
// contract below depends on running before DOMContentLoaded.

import { initBackgroundVideoSync } from './app/background-video.js';
import { init3DTiltEffect } from './app/tilt-effect.js';

// At module eval, deliberately — see app/background-video.js:6. Module scripts run
// before DOMContentLoaded, so the DOMContentLoaded/beforeunload/pagehide listeners
// it registers still land in time. No-ops without #background-video.
initBackgroundVideoSync();

// Needs a built DOM (it queries .contact-card), so it runs on DOMContentLoaded the
// same way app.js called it. Guarded readyState form because a module script can
// resolve after the event has already fired — the trap documented in
// index-deferred.js:16-22. Self-guards on non-contact pages: it bails early without
// a fine pointer, and the .contact-card NodeList is simply empty elsewhere.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init3DTiltEffect);
} else {
  init3DTiltEffect();
}
