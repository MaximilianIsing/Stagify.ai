// Tier: pure frontend logic — public/scripts/bg-video-start.js.
//
// This module exists so background.mp4's 1.25 MB stays out of the homepage's LCP window:
// index.html ships #background-video with `preload="none"` and no `autoplay`, and this
// starts it from index-deferred.js after `load`. Two things about it are load-bearing and
// invisible in review:
//
//   1. `data-bg-started` must be set BEFORE play(). app/background-video.js reads "still
//      paused" as "autoplay was blocked" and responds by hiding the video and painting the
//      body flat #b2c4f6 — an inference that is only sound once a play has been attempted.
//      Its startAttempted() waits for this marker. Set it after play(), or not at all, and
//      the retry loop reaches the fallback one second into every desktop visit and replaces
//      a working backdrop with a blank blue page.
//
//   2. On a phone it must do NOTHING. The <source> is gated at `(min-width: 769px)`, so no
//      source is selected and styles.css paints the backdrop as a body::before instead.
//      Calling load()/play() there asks for the UA's unremovable play glyph back — the
//      exact artefact the mobile gate was added to remove.
//
// Both are ORDERING/BRANCHING facts, which is why this drives the real function against a
// stub instead of scanning the source: a scan sees both strings present in either order.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// readyState 'loading' keeps the module's own init tail from firing at import time — it
// takes the addEventListener branch, so nothing runs until a test calls the export.
globalThis.document = /** @type {any} */ ({
  readyState: 'loading',
  addEventListener() {},
  getElementById: () => null,
});

const { startBackgroundVideo } = await import('../../public/scripts/bg-video-start.js');

/**
 * A stand-in for the <video>, recording the order of everything the module does to it.
 *
 * @param {{ currentSrc?: string, hasSourceTag?: boolean, playRejects?: boolean }} [opts]
 */
function makeVideo(opts = {}) {
  const calls = [];
  const attrs = /** @type {Record<string, string>} */ ({});
  return {
    calls,
    attrs,
    currentSrc: opts.currentSrc || '',
    setAttribute(name, value) {
      attrs[name] = value;
      calls.push(`setAttribute:${name}`);
    },
    querySelector(sel) {
      return opts.hasSourceTag && sel === 'source[src]' ? {} : null;
    },
    load() {
      calls.push('load');
    },
    play() {
      calls.push('play');
      return opts.playRejects ? Promise.reject(new Error('blocked')) : Promise.resolve();
    },
  };
}

/** Point document.getElementById at a stub (or nothing). */
function mount(video) {
  globalThis.document.getElementById = (id) => (id === 'background-video' ? video : null);
}

test('marks the element as started BEFORE asking it to play', () => {
  const video = makeVideo({ hasSourceTag: true });
  mount(video);

  startBackgroundVideo();

  assert.deepEqual(
    video.calls,
    ['setAttribute:data-bg-started', 'load', 'play'],
    'the marker must be set before play(). app/background-video.js only arms its ' +
      '"autoplay was blocked, fall back to flat #b2c4f6" path once data-bg-started is ' +
      'present, so setting it afterwards leaves a window where a deliberately-paused ' +
      'video looks like a failed one.'
  );
  assert.equal(video.attrs['data-bg-started'], '');
});

test('does nothing at all when no source was selected (the phone case)', () => {
  // currentSrc '' and no <source src> in the DOM is exactly what the 769px media gate
  // produces. Touching the element here brings back the UA play glyph.
  const video = makeVideo({ currentSrc: '', hasSourceTag: false });
  mount(video);

  startBackgroundVideo();

  assert.deepEqual(
    video.calls,
    [],
    'bg-video-start.js touched a <video> with no selected source. On phones the <source> ' +
      'media gate matches nothing on purpose and the backdrop is painted in CSS; calling ' +
      'load()/play() there makes the UA draw its centred play glyph over the page.'
  );
});

test('still starts when the source is only discoverable as a <source> tag', () => {
  // preload="none" means resource selection has run but currentSrc may still be '' until
  // load() is called, so the <source> tag is the second half of the check.
  const video = makeVideo({ currentSrc: '', hasSourceTag: true });
  mount(video);

  startBackgroundVideo();

  assert.ok(video.calls.includes('play'), 'a desktop <video> with a <source> must be started');
});

test('a rejected play() is swallowed, not left as an unhandled rejection', async () => {
  const video = makeVideo({ hasSourceTag: true, playRejects: true });
  mount(video);

  startBackgroundVideo();
  // If the module did not attach a .catch, this turn of the microtask queue is where an
  // unhandled rejection would be reported.
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(video.calls.includes('play'));
});

test('no #background-video on the page is a no-op, not a crash', () => {
  mount(null);
  assert.doesNotThrow(() => startBackgroundVideo());
});
