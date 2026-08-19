// Tier: frontend island logic (DOM-stubbed) — public/scripts/app/background-video.js.
//
// The decorative hero video: its position is carried across navigations in
// localStorage, and autoplay is retried around mobile restrictions before giving up
// and painting a solid colour instead.
//
// THE CASE THIS FILE EXISTS FOR is the mobile one. index.html gates background.mp4
// behind `media="(min-width: 769px)"`, so on a phone the <video> selects no source at
// all and settles at networkState === NETWORK_NO_SOURCE (3). Every play() then fails —
// not because autoplay was blocked, but because there is nothing to play. Without the
// `hasSource()` guard the island reads that as "autoplay failed", paints
// `document.body.style.background` a flat blue, and destroys the CSS phone backdrop
// (a poster on body::before) that was working exactly as designed.
//
// It is invisible on desktop and on every emulator that loads the desktop source, so
// the guard has no natural failing test — these are it.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installMaskDom, FakeEl } from '../../helpers/mask-dom.js';
import { initBackgroundVideoSync } from '../../../public/scripts/app/background-video.js';

const KEY = 'stagify_background_video_time';
const HAS_SOURCE = 1;   // anything but 3
const NO_SOURCE = 3;    // NETWORK_NO_SOURCE — the normal phone state

const REAL = {
  localStorage: globalThis.localStorage,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  setTimeout: globalThis.setTimeout,
};

let openIntervals = [];
let dom = null;
afterEach(() => {
  openIntervals.forEach((id) => REAL.clearInterval(id));
  openIntervals = [];
  if (dom) dom.restore();
  dom = null;
  globalThis.localStorage = REAL.localStorage;
  globalThis.setInterval = REAL.setInterval;
  globalThis.clearInterval = REAL.clearInterval;
  globalThis.setTimeout = REAL.setTimeout;
});

/**
 * A <video> stand-in: the properties and events the island actually touches.
 *
 * TWO PROPERTIES CARRY THE WHOLE "is this a phone / has anyone asked it to play" story,
 * and they replaced `networkState` for different reasons:
 *
 *  - `currentSrc` is now what hasSource() reads. networkState answered "was a source
 *    selected?" only while the element autoplayed; the homepage now ships
 *    `preload="none"`, where a desktop browser HAS selected a source but requested no
 *    bytes, so networkState is not 3 and the old check wrongly reported a healthy video
 *    as playable-and-stuck. It is derived from networkState here so the existing cases
 *    keep reading the way they were written.
 *  - `autoplay` gates every "playback failed" inference. It defaults TRUE because that is
 *    what the ten non-homepage carriers still ship. The homepage is the `autoplay: false`
 *    case, and it is covered separately below.
 */
function fakeVideo({
  networkState = HAS_SOURCE,
  currentSrc = networkState === NO_SOURCE ? '' : 'https://stagify.ai/background.mp4',
  autoplay = true,
  paused = true,
  playRejects = false,
  duration = 30,
  readyState = 0,
} = {}) {
  const el = new FakeEl('video');
  el.networkState = networkState;
  el.currentSrc = currentSrc;
  el.autoplay = autoplay;
  el.paused = paused;
  el.duration = duration;
  el.readyState = readyState;
  el.currentTime = 0;
  el.playCalls = 0;
  el.play = () => {
    el.playCalls += 1;
    if (playRejects) return Promise.reject(new Error('NotAllowedError'));
    el.paused = false;
    return Promise.resolve();
  };
  return el;
}

function mount({ video = fakeVideo(), stored = null } = {}) {
  dom = installMaskDom();

  const store = new Map();
  if (stored !== null) store.set(KEY, stored);
  globalThis.localStorage = /** @type {any} */ ({
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  });

  const docListeners = new Map();
  const winListeners = new Map();
  dom.doc.addEventListener = (type, fn) => {
    if (!docListeners.has(type)) docListeners.set(type, []);
    docListeners.get(type).push(fn);
  };
  dom.doc.querySelector = (sel) => (sel === '#background-video' ? video : null);
  dom.win.addEventListener = (type, fn) => {
    if (!winListeners.has(type)) winListeners.set(type, []);
    winListeners.get(type).push(fn);
  };

  const ticks = [];
  globalThis.setInterval = /** @type {any} */ (
    (fn, ms) => {
      const id = REAL.setInterval(() => {}, 1_000_000); // a real, inert handle
      openIntervals.push(id);
      ticks.push({ fn, ms, id, cleared: false });
      return id;
    }
  );
  globalThis.clearInterval = /** @type {any} */ (
    (id) => {
      const t = ticks.find((x) => x.id === id);
      if (t) t.cleared = true;
      REAL.clearInterval(id);
    }
  );
  globalThis.setTimeout = /** @type {any} */ ((fn) => REAL.setTimeout(fn, 0));

  initBackgroundVideoSync();

  const fire = (map, type, evt = {}) => (map.get(type) || []).forEach((fn) => fn(evt));

  return {
    video,
    store,
    ticks,
    body: dom.body,
    fireDoc: (t, e) => fire(docListeners, t, e),
    fireWin: (t, e) => fire(winListeners, t, e),
    /** DOMContentLoaded is where all the video wiring happens. */
    ready: () => fire(docListeners, 'DOMContentLoaded'),
    /** Run the periodic autoplay retry the island schedules. */
    tick: () => ticks.filter((t) => !t.cleared && t.ms === 1000).forEach((t) => t.fn()),
  };
}

const settle = () => new Promise((r) => REAL.setTimeout(r, 5));

// ---- position is carried across navigations ---------------------------------

test('leaving the page stores where the video had got to', () => {
  const h = mount({ video: fakeVideo({ paused: false }) });
  h.video.currentTime = 12.5;

  h.fireWin('beforeunload');

  assert.equal(h.store.get(KEY), '12.5');
});

test('a paused video has no position worth storing', () => {
  // Storing 0 from a video that never started would rewind the next page.
  const h = mount({ video: fakeVideo({ paused: true }) });
  h.video.currentTime = 0;

  h.fireWin('beforeunload');
  h.fireWin('pagehide');

  assert.equal(h.store.has(KEY), false);
});

test('pagehide stores it too, since mobile often skips beforeunload', () => {
  const h = mount({ video: fakeVideo({ paused: false }) });
  h.video.currentTime = 7;

  h.fireWin('pagehide');

  assert.equal(h.store.get(KEY), '7');
});

test('a stored position is restored once the video knows its length', () => {
  const h = mount({ stored: '9.25', video: fakeVideo({ duration: 30 }) });
  h.ready();

  h.video.emit('loadedmetadata', {});

  assert.equal(h.video.currentTime, 9.25);
});

test('a stored position past the end of the video is ignored', () => {
  // The video can be swapped for a shorter one between visits; seeking past the end
  // leaves it stalled on a black frame.
  const h = mount({ stored: '99', video: fakeVideo({ duration: 30 }) });
  h.ready();

  h.video.emit('loadedmetadata', {});

  assert.equal(h.video.currentTime, 0);
});

test('a video already loaded when the page is ready is restored without waiting', () => {
  const h = mount({ stored: '4', video: fakeVideo({ readyState: 2, duration: 30 }) });

  h.ready();

  assert.equal(h.video.currentTime, 4, 'the loadedmetadata event has already been and gone');
});

// ---- the phone case: no source selected ---------------------------------------

test('a phone with no selected source is never repainted over', () => {
  // THE bug this guard prevents. On mobile the source is media-gated away, play()
  // always rejects, and a naive island concludes "autoplay blocked" and paints the
  // body — wiping the CSS poster backdrop that is the intended mobile experience.
  const h = mount({ video: fakeVideo({ networkState: NO_SOURCE, playRejects: true }) });
  h.ready();

  h.video.emit('canplay', {});
  h.tick();

  return settle().then(() => {
    assert.equal(h.body.style.background, '', 'the phone backdrop is left alone');
    assert.equal(h.video.style.display, '', 'and the element is not hidden either');
  });
});

test('the retry loop stops itself when there is no source to retry', () => {
  // Otherwise it wakes every second, forever, on every phone that loads the page.
  const h = mount({ video: fakeVideo({ networkState: NO_SOURCE }) });
  h.ready();

  h.tick();

  const retry = h.ticks.find((t) => t.ms === 1000);
  assert.equal(retry.cleared, true);
});

test('a phone does not even attempt playback on interaction', () => {
  const h = mount({ video: fakeVideo({ networkState: NO_SOURCE, playRejects: true }) });
  h.ready();

  h.fireDoc('touchstart');
  h.fireDoc('click');

  assert.equal(h.video.playCalls, 0);
});

// ---- the homepage: paused on purpose, which is NOT a failure ----------------------
//
// index.html ships #background-video with `preload="none"` and no `autoplay`, so its
// 1,281,846 B stays out of the LCP window; scripts/bg-video-start.js starts it after
// `load`. That makes "the video is paused a second after DOMContentLoaded" the INTENDED
// state on the busiest page on the site, where it used to be the signal for "autoplay was
// blocked, paint the body flat blue". These three are the difference between a working
// backdrop and a blank #b2c4f6 homepage on every desktop visit.

test('a video nobody has asked to play yet is never faulted for being paused', () => {
  const h = mount({ video: fakeVideo({ autoplay: false, playRejects: true }) });
  h.ready();

  h.video.emit('canplay', {});
  h.tick();
  h.tick();

  return settle().then(() => {
    assert.equal(h.body.style.background, '', 'the backdrop must be left alone');
    assert.equal(h.video.style.display, '', 'and the element must not be hidden');
  });
});

test('the retry budget is not spent while waiting for the deferred starter', () => {
  // The loop keeps waiting rather than counting attempts — otherwise the one retry it is
  // allowed is gone before bg-video-start.js has had a chance to run at all.
  const h = mount({ video: fakeVideo({ autoplay: false, playRejects: true }) });
  h.ready();

  h.tick();
  h.tick();

  return settle().then(() => {
    assert.equal(h.video.playCalls, 0, 'nothing should have tried to play it yet');
  });
});

test('once the starter marks it, the usual desktop fallback applies again', async () => {
  // The other half: the marker is what re-arms every path above, so a homepage video that
  // genuinely cannot start still degrades the way the other ten pages do.
  const video = fakeVideo({ autoplay: false, playRejects: true });
  const h = mount({ video });
  h.ready();

  video.setAttribute('data-bg-started', '');
  h.video.emit('canplay', {});
  await settle();

  assert.equal(h.video.style.display, 'none');
  assert.equal(h.body.style.background, '#b2c4f6');
});

test('a playing video stops the retry loop instead of ticking forever', () => {
  const h = mount({ video: fakeVideo({ paused: false }) });
  h.ready();

  h.tick();

  const retry = h.ticks.find((t) => t.ms === 1000);
  assert.equal(retry.cleared, true, 'the happy path used to leave this waking every second');
});

// ---- desktop: autoplay really can fail -------------------------------------------

test('a desktop video that will not start falls back to a solid background', async () => {
  const h = mount({ video: fakeVideo({ playRejects: true }) });
  h.ready();

  h.video.emit('canplay', {});
  await settle();

  assert.equal(h.video.style.display, 'none');
  assert.equal(h.body.style.background, '#b2c4f6');
});

test('a desktop video that starts is left visible', async () => {
  const h = mount({ video: fakeVideo() });
  h.ready();

  h.video.emit('canplay', {});
  await settle();

  assert.equal(h.video.playCalls, 1);
  assert.equal(h.body.style.background, '', 'nothing is painted over a working video');
});

test('the video is revealed once it has frames', () => {
  const h = mount();
  h.ready();

  h.video.emit('loadeddata', {});

  assert.equal(h.video.classList.contains('loaded'), true);
});

test('a user gesture retries playback on desktop', async () => {
  // Autoplay is commonly blocked until the user interacts; the first touch, click or
  // scroll is the earliest moment a retry can succeed.
  const h = mount({ video: fakeVideo({ paused: true }) });
  h.ready();

  h.fireDoc('click');
  await settle();

  assert.equal(h.video.playCalls, 1);
});

test('the retry loop gives up rather than spinning forever', async () => {
  const h = mount({ video: fakeVideo({ playRejects: true }) });
  h.ready();

  h.tick();
  h.tick();
  await settle();

  const retry = h.ticks.find((t) => t.ms === 1000);
  assert.equal(retry.cleared, true, 'the interval is cleared');
  assert.equal(h.body.style.background, '#b2c4f6', 'and the fallback is painted');
});

test('a page with no background video wires up without crashing', () => {
  dom = installMaskDom();
  dom.doc.addEventListener = () => {};
  dom.doc.querySelector = () => null;
  dom.win.addEventListener = () => {};

  assert.doesNotThrow(() => initBackgroundVideoSync());
});
