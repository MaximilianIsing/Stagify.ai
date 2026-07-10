// Unit tests for the shared brush-mask image core, public/scripts/mask-core.js —
// the pure canvas algorithms (grow / model-mask / blend-mask / composite) imported
// by BOTH studios and the AI Designer, so a regression here silently corrupts every
// mask edit across the app.
//
// mask-core.js is canvas-bound (document.createElement('canvas') + the 2D raster
// API), not DOM-free, so it can't run under bare node like the other frontend
// units. We back it with @napi-rs/canvas — a dev-only, prebuilt (no node-gyp)
// canvas that implements getImageData/putImageData, scaled drawImage,
// globalCompositeOperation 'destination-in', ctx.filter blur and toDataURL
// faithfully — and assert REAL pixels, not call-shape. Nothing here touches
// runtime code; the dependency is test-only.
//
// The DOM shim below is the ONLY thing standing in for the browser: mask-core
// reaches for document.createElement('canvas'), so we hand it a real napi canvas.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';

// mask-core only touches `document` inside function bodies (never at import time),
// so setting this before the tests run is sufficient.
globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') throw new Error(`mask-core asked for <${tag}>, expected <canvas>`);
    return createCanvas(1, 1); // mask-core sets .width/.height itself
  },
};

const {
  growBinaryMask,
  buildModelMask,
  buildBlendMask,
  compositeMaskedEditCanvas,
  compositeMaskedEdit,
} = await import('../public/scripts/mask-core.js');

// ---- fixtures -------------------------------------------------------------

const W = 64;
const H = 64;
// A centered brushed square spanning x,y ∈ [24, 39]. Center (32,32) sits deep
// inside it; the corners sit far outside — both safe from edge anti-aliasing.
const BRUSH = { x: 24, y: 24, w: 16, h: 16 };

function paintedBrush(alpha = 1) {
  const cv = createCanvas(W, H);
  const c = cv.getContext('2d');
  c.fillStyle = `rgba(255,255,255,${alpha})`;
  c.fillRect(BRUSH.x, BRUSH.y, BRUSH.w, BRUSH.h);
  return cv;
}

function solid(css) {
  const cv = createCanvas(W, H);
  const c = cv.getContext('2d');
  c.fillStyle = css;
  c.fillRect(0, 0, W, H);
  return cv;
}

// Returns a px(x,y) -> [r,g,b,a] reader over a canvas's current pixels.
function reader(canvas) {
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  return (x, y) => {
    const i = (y * canvas.width + x) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };
}

// ---- growBinaryMask -------------------------------------------------------

test('growBinaryMask: brushed pixels become opaque white, output is w×h', () => {
  const out = growBinaryMask(paintedBrush(), W, H, 8);
  assert.equal(out.width, W);
  assert.equal(out.height, H);
  assert.deepEqual(reader(out)(32, 32), [255, 255, 255, 255]);
});

test('growBinaryMask: the mask grows OUTWARD past the brush, but not to infinity', () => {
  const px = reader(growBinaryMask(paintedBrush(), W, H, 8));
  // 4px beyond the painted right edge (39) — inside the grow=8 band → filled.
  assert.ok(px(43, 32)[3] > 200, `expected grown band opaque, got alpha ${px(43, 32)[3]}`);
  // 21px beyond the edge — well outside the band → untouched/transparent.
  assert.equal(px(60, 32)[3], 0);
  // Far corner never gets painted.
  assert.equal(px(0, 0)[3], 0);
});

test('growBinaryMask: alpha ≤ 10 is treated as unpainted (the >10 threshold)', () => {
  // 0.02·255 ≈ 5, below the threshold → nothing is considered brushed.
  const faint = reader(growBinaryMask(paintedBrush(0.02), W, H, 8));
  assert.equal(faint(32, 32)[3], 0);
  // A firmly-painted brush at the same spot DOES register (positive control).
  const firm = reader(growBinaryMask(paintedBrush(0.5), W, H, 8));
  assert.equal(firm(32, 32)[3], 255);
});

// ---- buildModelMask -------------------------------------------------------

test('buildModelMask: opaque black everywhere, opaque white inside the brush', () => {
  const out = buildModelMask(paintedBrush(), W, H, 8);
  assert.equal(out.width, W);
  assert.equal(out.height, H);
  const px = reader(out);
  // Unbrushed area the model must NOT touch → solid black, fully opaque.
  assert.deepEqual(px(0, 0), [0, 0, 0, 255]);
  // Brushed area the model MAY edit → solid white, fully opaque.
  assert.deepEqual(px(32, 32), [255, 255, 255, 255]);
});

// ---- buildBlendMask -------------------------------------------------------

test('buildBlendMask: opaque core, transparent far field, soft feathered edge', () => {
  const out = buildBlendMask(paintedBrush(), W, H, /* coreGrow */ 6, /* featherPx */ 6);
  const px = reader(out);
  // Core stays fully committed to the edit.
  assert.ok(px(32, 32)[3] > 200, `expected opaque core, got alpha ${px(32, 32)[3]}`);
  // Far field stays fully original (0 = keep original when composited).
  assert.equal(px(0, 0)[3], 0);
  // A feather exists: somewhere along the row out from the core there is a
  // partial-alpha pixel (neither fully edited nor fully original) — proof the
  // edge fades rather than hard-cuts.
  let sawFeather = false;
  for (let x = BRUSH.x + BRUSH.w; x < W; x++) {
    const a = px(x, 32)[3];
    if (a > 5 && a < 250) { sawFeather = true; break; }
  }
  assert.ok(sawFeather, 'expected a partial-alpha feather band around the core');
});

// ---- compositeMaskedEditCanvas (the safety guarantee) ---------------------

test('compositeMaskedEditCanvas: edited pixels appear ONLY inside the mask; original is kept elsewhere', () => {
  const original = solid('rgb(255,0,0)'); // red
  const edited = solid('rgb(0,0,255)');   // blue
  const keep = growBinaryMask(paintedBrush(), W, H, 8);

  const out = compositeMaskedEditCanvas(original, keep, edited, W, H);
  assert.equal(out.width, W);
  assert.equal(out.height, H);
  const px = reader(out);
  // Inside the mask → the edited (blue) pixels.
  assert.deepEqual(px(32, 32), [0, 0, 255, 255]);
  // Outside the mask → the ORIGINAL (red) pixels, physically unchanged. This is
  // the whole point of the mask composite: unbrushed areas can never change.
  assert.deepEqual(px(0, 0), [255, 0, 0, 255]);
  assert.deepEqual(px(60, 60), [255, 0, 0, 255]);
});

// ---- compositeMaskedEdit --------------------------------------------------

test('compositeMaskedEdit: returns the same composite as a PNG data URL', () => {
  const url = compositeMaskedEdit(solid('rgb(255,0,0)'), growBinaryMask(paintedBrush(), W, H, 8), solid('rgb(0,0,255)'), W, H);
  assert.equal(typeof url, 'string');
  assert.ok(url.startsWith('data:image/png;base64,'), 'expected a PNG data URL');
  assert.ok(url.length > 100, 'expected a non-trivial encoded image');
});
