// Starts the homepage's decorative background video, once the page has finished loading.
//
// WHY THIS FILE EXISTS. #background-video is a fixed, z-index:-1, opacity:.8 backdrop, and
// background.mp4 is 1,281,846 B. It used to carry `autoplay`, which overrides `preload` —
// an autoplaying, muted, in-viewport video is played, and playing it means streaming it.
// So desktop pulled the whole 1.25 MB inside the LCP window: roughly 1.0s of PageSpeed's
// 10 Mbps desktop budget, spent competing with the hero photo that the <link rel=preload>
// in <head> exists to rush. Phones never paid it (the <source> is gated at 769px), so this
// was the desktop half of a saving mobile already had.
//
// index.html therefore ships the element with `preload="none"` and NO `autoplay`, which
// fetches nothing at all, and this file asks it to play from index-deferred.js — i.e. after
// `load` plus an idle callback. The `poster` paints the backdrop from first paint either
// way, so what a visitor sees is the same picture, with the motion joining it a moment
// later.
//
// THE MARKER IS PART OF THE CONTRACT. app/background-video.js reads "video is paused" as
// "autoplay was blocked, fall back to a flat #b2c4f6 page". That inference is only sound
// once a play has been attempted, and on this page it deliberately has not been for the
// first second or two. So `data-bg-started` goes on the element BEFORE play() is called,
// and that module's startAttempted() waits for it. Setting it after, or not at all, brings
// back the flat-blue homepage on every desktop visit.

/**
 * Attach the source and start playback. Idempotent; safe to call on a page without one.
 *
 * Exported so test/frontend/bg-video-start.test.js can drive it against a stub rather than
 * scraping this file for strings — the ordering of `data-bg-started` against play() is the
 * thing worth testing, and a source scan cannot see ordering.
 */
export function startBackgroundVideo() {
  const video = /** @type {HTMLVideoElement | null} */ (document.getElementById('background-video'));
  if (!video) return;

  // No source was selected — this is a phone, where the <source>'s `media` gate matched
  // nothing on purpose and styles.css paints the backdrop as a body::before instead.
  // Calling load()/play() here would be asking for the UA's play glyph back.
  if (!video.currentSrc && !video.querySelector('source[src]')) return;

  // Ordered before play() on purpose — see the header.
  video.setAttribute('data-bg-started', '');

  // `preload="none"` means resource selection has run but no bytes have been requested.
  // play() alone is enough to start that, but load() makes the intent explicit and is a
  // no-op when the media is already loading.
  try {
    video.load();
  } catch {
    /* Nothing to recover: play() below reports the real failure. */
  }

  // A rejected play() is not an error worth surfacing. app/background-video.js owns the
  // fallback, and its retry loop is now armed by the marker set above.
  const played = video.play();
  if (played && typeof played.catch === 'function') played.catch(() => {});
}

/* Injected by index-deferred.js after `load`, so DOMContentLoaded and load have both
   already fired and registering on either would never run. Guarded rather than assumed, so
   the file is also correct if it is ever loaded as a plain tag. */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startBackgroundVideo);
} else {
  startBackgroundVideo();
}
