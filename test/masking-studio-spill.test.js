// Unit tests for the pure spill detector extracted into
// public/scripts/masking-studio/spill.js. No DOM: it runs on typed arrays, so
// these tests build tiny RGBA/alpha grids by hand and run under node --test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeSpillFill } from '../public/scripts/masking-studio/spill.js';

const idx = (x, y, w) => y * w + x;

// A w*h RGBA buffer filled with one flat colour (opaque).
function rgbaFilled(w, h, [r, g, b]) {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    a[p] = r; a[p + 1] = g; a[p + 2] = b; a[p + 3] = 255;
  }
  return a;
}

function fillRectRGBA(arr, w, x0, y0, x1, y1, [r, g, b]) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const p = idx(x, y, w) * 4;
      arr[p] = r; arr[p + 1] = g; arr[p + 2] = b; arr[p + 3] = 255;
    }
  }
}

function fillRectA(arr, w, x0, y0, x1, y1, v) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) arr[idx(x, y, w)] = v;
  }
}

// Black base, white "object" rectangle painted into `edited`, and a painted
// stroke rectangle — the standard fixture for an object that overhangs its
// highlight to the right.
function fixture(w, h, { paint, object }) {
  const base = rgbaFilled(w, h, [0, 0, 0]);
  const edited = rgbaFilled(w, h, [0, 0, 0]);
  if (object) fillRectRGBA(edited, w, object[0], object[1], object[2], object[3], [255, 255, 255]);
  const painted = new Uint8Array(w * h);
  if (paint) fillRectA(painted, w, paint[0], paint[1], paint[2], paint[3], 255);
  return { base, edited, painted };
}

test('computeSpillFill: no change at all → nothing to snap', () => {
  const w = 12, h = 8;
  const { base, edited, painted } = fixture(w, h, { paint: [2, 1, 5, 6] });
  const { count } = computeSpillFill({ base, edited, painted, labels: null, myIdx: 0, w, h });
  assert.equal(count, 0);
});

test('computeSpillFill: object fully inside the highlight → no overhang', () => {
  const w = 14, h = 10;
  // Object rectangle sits entirely within the painted rectangle.
  const { base, edited, painted } = fixture(w, h, { paint: [2, 1, 10, 8], object: [3, 2, 9, 7] });
  const { count } = computeSpillFill({ base, edited, painted, labels: null, myIdx: 0, w, h });
  assert.equal(count, 0);
});

test('computeSpillFill: object overhanging the highlight is captured (grow-only)', () => {
  const w = 16, h = 10;
  // Painted cols 2..5; the AI object runs cols 2..11 — a clear right overhang.
  const { base, edited, painted } = fixture(w, h, { paint: [2, 1, 5, 8], object: [2, 1, 11, 8] });
  const { fill, count } = computeSpillFill({ base, edited, painted, labels: null, myIdx: 0, w, h });
  assert.ok(count > 0, 'overhang should produce a suggestion');
  assert.equal(fill[idx(8, 4, w)], 1, 'an interior overhang pixel is filled');
  assert.equal(fill[idx(3, 4, w)], 0, 'a painted pixel is never part of the added fill');
  assert.equal(fill[idx(14, 4, w)], 0, 'an untouched far pixel is never filled');
});

test('computeSpillFill: the fill is bounded by maxBand distance from the highlight', () => {
  const w = 16, h = 10;
  const { base, edited, painted } = fixture(w, h, { paint: [2, 1, 5, 8], object: [2, 1, 11, 8] });
  const { fill } = computeSpillFill({ base, edited, painted, labels: null, myIdx: 0, w, h, maxBand: 2 });
  assert.equal(fill[idx(6, 4, w)], 1, 'one step past the highlight is within the band');
  assert.equal(fill[idx(8, 4, w)], 0, 'three steps past the highlight is beyond maxBand=2');
});

test('computeSpillFill: never floods into another area\'s Voronoi cell', () => {
  const w = 24, h = 12;
  const { base, edited, painted } = fixture(w, h, { paint: [2, 1, 7, 10], object: [2, 1, 15, 10] });
  // Cols <12 belong to area 0 (ours), cols >=12 to area 1.
  const labels = new Int16Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) labels[idx(x, y, w)] = x < 12 ? 0 : 1;

  const clipped = computeSpillFill({ base, edited, painted, labels, myIdx: 0, w, h });
  assert.ok(clipped.count > 0, 'overhang inside our cell is suggested');
  assert.equal(clipped.fill[idx(9, 5, w)], 1, 'overhang inside our cell is kept');
  assert.equal(clipped.fill[idx(14, 5, w)], 0, 'overhang inside the neighbour cell is clipped away');

  // Without labels the same overhang crosses freely — proves the clip did it.
  const open = computeSpillFill({ base, edited, painted, labels: null, myIdx: 0, w, h });
  assert.equal(open.fill[idx(14, 5, w)], 1, 'with no partition the neighbour region is reachable');
});

test('computeSpillFill: declines when the change dwarfs the highlight (unreliable diff)', () => {
  const w = 16, h = 10;
  // Tiny 2x2 highlight, huge object change — a global/misplaced result, not a
  // trustworthy overhang, so the guard should refuse to suggest anything.
  const { base, edited, painted } = fixture(w, h, { paint: [2, 2, 3, 3], object: [2, 2, 13, 8] });
  const { count } = computeSpillFill({ base, edited, painted, labels: null, myIdx: 0, w, h });
  assert.equal(count, 0);
});

test('computeSpillFill: respects the minFill floor', () => {
  const w = 16, h = 10;
  const { base, edited, painted } = fixture(w, h, { paint: [2, 1, 5, 8], object: [2, 1, 11, 8] });
  // A real overhang exists, but demanding an implausibly large fill declines it.
  const { count } = computeSpillFill({ base, edited, painted, labels: null, myIdx: 0, w, h, minFill: 100000 });
  assert.equal(count, 0);
});

test('computeSpillFill: unpainted area yields no fill', () => {
  const w = 12, h = 8;
  const { base, edited } = fixture(w, h, { object: [2, 1, 8, 6] });
  const painted = new Uint8Array(w * h); // nothing painted
  const { count } = computeSpillFill({ base, edited, painted, labels: null, myIdx: 0, w, h });
  assert.equal(count, 0);
});
