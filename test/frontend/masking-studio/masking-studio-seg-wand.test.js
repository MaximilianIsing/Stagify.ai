// Tier: frontend island logic (real canvas) — public/scripts/masking-studio/seg-wand.js.
//
// Magic select. One POST to /api/segment returns every object Gemini found in the
// photo; the island decodes each into a full-resolution mask, caches the set, and
// every later click resolves by hit-testing that cache. The click then paints through
// the same path as a brush stroke, so undo and pixel-claiming behave identically.
//
// e2e/masking-studio-wand.spec.js drives the happy path in a browser. What is pinned
// here is the cache contract and the decoder's tolerance, none of which a smoke test
// reaches:
//
//   - THE STALE-PHOTO CONTRACT is cross-module: the entry bumps state.segToken and
//     nulls state.segCache when a new photo loads, and this island captures the token
//     before its fetch and refuses to cache on mismatch. Break it and clicks on the
//     new photo select objects from the old one.
//   - AN EMPTY LIST IS NEVER CACHED. Gemini occasionally returns zero items for a
//     perfectly good room; caching that would make every later click insta-miss for
//     as long as the photo stays loaded, with no way back short of re-uploading.
//   - ONE BAD MASK MUST NOT SINK THE BATCH. Items are decoded in a loop with a
//     per-item catch, so a single undecodable PNG costs one object, not all of them.
//
// Canvases are real (@napi-rs/canvas), so the binarize-at-127 step and the alpha
// hit-test run on actual pixels.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';

import { installMaskDom, FakeEl } from '../../helpers/mask-dom.js';
import { createSegWand } from '../../../public/scripts/masking-studio/seg-wand.js';

const W = 400;
const H = 300;

const REAL = {
  fetch: globalThis.fetch,
  window: globalThis.window,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
};

let dom = null;
afterEach(() => {
  if (dom) dom.restore();
  dom = null;
  globalThis.fetch = REAL.fetch;
  globalThis.window = REAL.window;
  globalThis.setInterval = REAL.setInterval;
  globalThis.clearInterval = REAL.clearInterval;
});


/** A grey photo to segment. */
function photoCanvas(w = W, h = H) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#888';
  ctx.fillRect(0, 0, w, h);
  return c;
}

/**
 * A segmentation mask PNG stand-in: white (kept, red channel 255) inside `white`,
 * black (dropped) elsewhere. Returned by the injected loadImage, so it is drawn and
 * binarized for real.
 */
function maskImage(bw, bh, white) {
  const c = createCanvas(bw, bh);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, bw, bh);
  if (white) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(white[0], white[1], white[2], white[3]);
  }
  return c;
}

/** box_2d is [y0, x0, y1, x1] normalized to 0–1000. */
const box = (x0, y0, x1, y1) => [y0, x0, y1, x1];

/** An /api/segment item covering the whole of its box. */
const item = (b, over = {}) => ({ box_2d: b, label: 'sofa', mask: 'data:image/png;base64,AA', ...over });

function mount({
  phase = 'draw',
  segCache = null,
  segToken = 1,
  layer = { id: 'L1' },
  point = { x: 10, y: 10 },
  response = null,
  items = [item(box(0, 0, 500, 500))],
  holdFetch = null,
  fetchThrows = false,
  decodeFails = false,
  maskAllBlack = false,
  busyMessages = null,
  w = W,
  h = H,
} = {}) {
  dom = installMaskDom();

  // Scratch canvases the island rasterises into, so the request downscale can be
  // checked by dimension rather than by encoded payload size.
  const canvases = [];
  const realCreate = dom.doc.createElement.bind(dom.doc);
  dom.doc.createElement = (tag) => {
    const el = realCreate(tag);
    if (tag === 'canvas') canvases.push(el);
    return el;
  };

  const state = {
    base: { w, h, canvas: photoCanvas(w, h) },
    phase,
    segCache,
    segToken,
    layers: [layer],
  };
  const calls = { painted: [], toasts: [], posts: [] };
  const wandBusyEl = new FakeEl('div');
  const stack = new FakeEl('div');

  globalThis.window = /** @type {any} */ ({
    StagifyAuth: { getToken: () => 'tok-9' },
    LanguageSystem: busyMessages
      ? { getText: () => busyMessages }
      : null,
  });
  // Compress the busy-message cadence: the copy rotation is not under test, but that
  // the interval is STARTED and STOPPED is.
  globalThis.setInterval = /** @type {any} */ (
    (fn, ms, ...rest) => REAL.setInterval(fn, ms > 1 ? 1 : ms, ...rest)
  );
  globalThis.fetch = /** @type {any} */ (
    async (url, opts) => {
      calls.posts.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
      if (holdFetch) await holdFetch;
      if (fetchThrows) throw new Error('offline');
      if (response) return response;
      return { ok: true, status: 200, json: async () => ({ success: true, items }) };
    }
  );

  const island = createSegWand({
    state,
    stack,
    wandBusyEl,
    activeLayer: () => layer,
    canvasPoint: () => point,
    paintMaskIntoLayer: (l, maskCanvas) => calls.painted.push({ layer: l, mask: maskCanvas }),
    requestError: (status, result) => `request failed (${status}${result && result.error ? `: ${result.error}` : ''})`,
    showToast: (message, type) => calls.toasts.push({ message, type }),
    tx: (_key, def) => def,
    loadImage: async () => {
      if (decodeFails) throw new Error('decode');
      // Sized to the box the caller decoded; the island rescales it into place, so
      // any size works — this keeps the white region proportional.
      return /** @type {any} */ (maskImage(100, 100, maskAllBlack ? null : [0, 0, 50, 100]));
    },
  });

  return { island, state, calls, canvases, wandBusyEl, stack };
}

// ---- the request ------------------------------------------------------------

test('the photo is sent downscaled, flattened and attributed', async () => {
  // A photo LARGER than the 1024 budget, or the downscale is a no-op and this proves
  // nothing: coordinates come back normalized, so full resolution would only cost
  // tokens and upload time.
  const h = mount({ w: 2048, h: 1536 });

  await h.island.ensureSegCache();

  assert.equal(h.calls.posts.length, 1);
  const post = h.calls.posts[0];
  assert.equal(post.url, '/api/segment');
  assert.equal(post.headers.Authorization, 'Bearer tok-9');
  assert.match(post.body.image, /^data:image\/jpeg/, 'JPEG, so transparency is flattened not dropped');
  assert.equal(post.body.query, '', 'the untargeted sweep sends no query');
  assert.deepEqual(
    { w: h.canvases[0].width, h: h.canvases[0].height },
    { w: 1024, h: 768 },
    'the payload is capped at a 1024px long edge',
  );
});

test('a failed request surfaces the server reason rather than a generic apology', async () => {
  const h = mount({
    response: { ok: false, status: 429, json: async () => ({ error: 'rate limited' }) },
  });

  await h.island.wandClick({});

  assert.equal(h.calls.toasts.length, 1);
  assert.match(h.calls.toasts[0].message, /429/, 'the status reaches the user');
  assert.match(h.calls.toasts[0].message, /rate limited/);
  assert.equal(h.calls.toasts[0].type, 'error');
});

test('a 200 that is not a success is still a failure', async () => {
  // The endpoint answers 200 with { success: false } for its own soft errors, so
  // status alone is not the check.
  const h = mount({ response: { ok: true, status: 200, json: async () => ({ success: false }) } });

  await h.island.wandClick({});

  assert.equal(h.calls.toasts.length, 1);
  assert.deepEqual(h.calls.painted, []);
  // WHICH message matters: treating success:false as a success yields an empty item
  // list, which reaches the hit-test and produces the "no object here" miss toast
  // instead. Same count, opposite meaning — the user is told to click more carefully
  // when in fact the request failed.
  assert.match(h.calls.toasts[0].message, /request failed/);
});

test('an unparseable body is a failure, not a crash', async () => {
  const h = mount({
    response: { ok: true, status: 200, json: async () => { throw new Error('not json'); } },
  });

  await h.island.wandClick({});

  assert.equal(h.calls.toasts.length, 1);
});

test('a dead network reports instead of hanging the wand', async () => {
  const h = mount({ fetchThrows: true });

  await h.island.wandClick({});

  assert.equal(h.calls.toasts.length, 1);
  assert.equal(h.stack.classList.contains('is-analyzing'), false, 'the busy state is cleared');
});

// ---- the cache contract ------------------------------------------------------

test('a second click reuses the cache instead of re-asking Gemini', async () => {
  const h = mount();

  await h.island.ensureSegCache();
  await h.island.ensureSegCache();

  assert.equal(h.calls.posts.length, 1, 'one sweep per photo, not one per click');
});

test('clicks made while the sweep is running share the one request', async () => {
  // Without the shared promise the second click either fires a duplicate POST or is
  // dropped on the floor; the user clicked, so it must land.
  let release = () => {};
  const held = new Promise((r) => { release = r; });
  const h = mount({ holdFetch: held });

  const a = h.island.ensureSegCache();
  const b = h.island.ensureSegCache();
  release();
  await Promise.all([a, b]);

  assert.equal(h.calls.posts.length, 1);
});

test('a result for a replaced photo is discarded, not cached', async () => {
  // The cross-module contract: the entry bumps segToken on every new photo. Caching a
  // stale result would let a click on the new photo select an object from the old one.
  let release = () => {};
  const held = new Promise((r) => { release = r; });
  const h = mount({ holdFetch: held });

  const pending = h.island.ensureSegCache();
  h.state.segToken = 2; // a new photo lands mid-flight
  release();

  assert.equal(await pending, null, 'the stale sweep resolves to nothing');
  assert.equal(h.state.segCache, null, 'and nothing is cached');
});

test('an empty sweep is never cached, so the next click can try again', async () => {
  const h = mount({ items: [] });

  const first = await h.island.ensureSegCache();

  assert.deepEqual(first, [], 'the caller sees the empty result');
  assert.equal(h.state.segCache, null, 'but it is not remembered');

  await h.island.ensureSegCache();
  assert.equal(h.calls.posts.length, 2, 'so a later click re-asks rather than insta-missing');
});

test('a non-empty sweep is cached', async () => {
  // The other half: without it the assertion above passes with caching removed.
  const h = mount();

  await h.island.ensureSegCache();

  assert.ok(Array.isArray(h.state.segCache) && h.state.segCache.length === 1);
});

test('a failed sweep leaves nothing behind to block a retry', async () => {
  const h = mount({ fetchThrows: true });

  await h.island.wandClick({});
  await h.island.wandClick({});

  assert.equal(h.calls.posts.length, 2, 'the in-flight latch is released on the error path too');
});

// ---- the busy indicator ------------------------------------------------------

test('the busy state is raised for the sweep and lowered afterwards', async () => {
  let release = () => {};
  const held = new Promise((r) => { release = r; });
  const h = mount({ holdFetch: held });

  const pending = h.island.ensureSegCache();
  assert.equal(h.stack.classList.contains('is-analyzing'), true);
  assert.equal(h.wandBusyEl.classList.contains('hidden'), false);
  assert.ok(h.wandBusyEl.textContent.length > 0, 'and it says something');

  release();
  await pending;

  assert.equal(h.stack.classList.contains('is-analyzing'), false);
  assert.equal(h.wandBusyEl.classList.contains('hidden'), true);
});

test('the progress lines come from the language pack when it has them', async () => {
  let release = () => {};
  const held = new Promise((r) => { release = r; });
  const h = mount({ holdFetch: held, busyMessages: ['Analysiere…', 'Fast fertig…'] });

  const pending = h.island.ensureSegCache();
  assert.equal(h.wandBusyEl.textContent, 'Analysiere…', 'localized, not the English fallback');

  release();
  await pending;
});

test('a language pack with no lines falls back rather than blanking the label', async () => {
  let release = () => {};
  const held = new Promise((r) => { release = r; });
  const h = mount({ holdFetch: held, busyMessages: [] });

  const pending = h.island.ensureSegCache();
  assert.ok(h.wandBusyEl.textContent.length > 0, 'an empty pack must not produce an empty label');

  release();
  await pending;
});

// ---- decoding ----------------------------------------------------------------

test('an object with a pixel mask is decoded to a full-resolution selection', async () => {
  const h = mount({ items: [item(box(0, 0, 500, 500))] });

  const cache = await h.island.ensureSegCache();

  assert.equal(cache.length, 1);
  assert.equal(cache[0].canvas.width, W, 'the selection is photo-sized, not box-sized');
  assert.equal(cache[0].canvas.height, H);
  assert.ok(cache[0].area > 0);
  assert.equal(cache[0].label, 'sofa');
});

test('an object with no pixel mask falls back to its bounding box', async () => {
  // The API frequently omits usable masks. A box the brush can refine beats nothing.
  const h = mount({ items: [item(box(100, 100, 400, 400), { mask: null })] });

  const cache = await h.island.ensureSegCache();

  assert.equal(cache.length, 1);
  assert.ok(cache[0].area > 0, 'the box itself becomes the selection');
});

test('a degenerate box is skipped', async () => {
  const h = mount({
    items: [item(box(300, 300, 300, 300)), item(box(400, 400, 100, 100))],
  });

  assert.deepEqual(await h.island.ensureSegCache(), [], 'zero-size and inverted boxes are dropped');
});

test('a mask that binarizes to nothing is dropped, not kept as an empty selection', async () => {
  // The probability map is thresholded at the documented midpoint, and a low-
  // confidence object can land entirely under it. Keeping the result would put an
  // invisible zero-area entry in the cache — and since the hit-test prefers the
  // SMALLEST match, that entry would win every click it overlapped and paint nothing.
  const h = mount({ items: [item(box(0, 0, 500, 500))], maskAllBlack: true });

  assert.deepEqual(await h.island.ensureSegCache(), []);
});

test('one undecodable mask costs one object, not the whole sweep', async () => {
  const h = mount({
    items: [item(box(0, 0, 500, 500)), item(box(500, 500, 900, 900), { mask: null })],
    decodeFails: true,
  });

  const cache = await h.island.ensureSegCache();

  assert.equal(cache.length, 1, 'the maskless item still decodes');
});

// ---- clicking ------------------------------------------------------------------

test('clicking an object paints it into the active area', async () => {
  const h = mount({ point: { x: 10, y: 10 } });

  await h.island.wandClick({});

  assert.equal(h.calls.painted.length, 1);
  assert.equal(h.calls.painted[0].layer.id, 'L1');
  assert.deepEqual(h.calls.toasts, []);
});

test('the smallest object under the cursor wins', async () => {
  // Clicking a cushion on a sofa should select the cushion. Ordering by area is the
  // only thing that makes the click mean "this thing" rather than "whatever encloses
  // it", and the API returns no z-order to fall back on.
  const h = mount({
    items: [
      item(box(0, 0, 900, 900), { label: 'sofa', mask: null }),
      item(box(0, 0, 200, 200), { label: 'cushion', mask: null }),
    ],
    point: { x: 10, y: 10 },
  });

  const cache = await h.island.ensureSegCache();
  await h.island.wandClick({});

  const chosen = cache.find((c) => c.canvas === h.calls.painted[0].mask);
  assert.equal(chosen.label, 'cushion');
});

test('clicking empty space says so instead of painting nothing', async () => {
  const h = mount({
    items: [item(box(0, 0, 200, 200), { mask: null })],
    point: { x: W - 1, y: H - 1 },
  });

  await h.island.wandClick({});

  assert.deepEqual(h.calls.painted, []);
  assert.equal(h.calls.toasts.length, 1);
  assert.match(h.calls.toasts[0].message, /No object found/);
});

test('a click outside the photo is clamped rather than read out of bounds', async () => {
  // canvasPoint can hand back a coordinate past the edge on a fast drag-release.
  // getImageData past the edge returns zeroes, which reads as a miss; clamping makes
  // the nearest real pixel answer instead.
  const h = mount({
    items: [item(box(900, 900, 1000, 1000), { mask: null })],
    point: { x: W + 500, y: H + 500 },
  });

  await h.island.wandClick({});

  assert.equal(h.calls.painted.length, 1, 'the click lands on the object at the corner');
});

test('a click with no active area does nothing', async () => {
  const h = mount({ layer: null });

  await h.island.wandClick({});

  assert.deepEqual(h.calls.painted, []);
  assert.equal(h.calls.posts.length, 0, 'and does not even ask the server');
});

test('a click that misses the canvas does nothing', async () => {
  const h = mount({ point: null });

  await h.island.wandClick({});

  assert.deepEqual(h.calls.painted, []);
  assert.equal(h.calls.posts.length, 0);
});

test('a click whose sweep finished after the studio left the draw phase is dropped', async () => {
  // Generation started while the analysis ran. Painting now would mutate a layer the
  // pipeline is already compositing from.
  let release = () => {};
  const held = new Promise((r) => { release = r; });
  const h = mount({ holdFetch: held });

  const pending = h.island.wandClick({});
  h.state.phase = 'generating';
  release();
  await pending;

  assert.deepEqual(h.calls.painted, []);
});
