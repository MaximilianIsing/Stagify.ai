// Unit tests for the pure Masking Studio helpers extracted into
// public/scripts/masking-studio/layers.js (bounded-concurrency pool + palette
// index picker). No DOM, so they run directly under node --test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPool,
  nextColorIdx,
  createLayer,
  layerColor,
  layerTitle,
  previewText,
  statusChip,
  nearestAreaLabels,
} from '../public/scripts/masking-studio/layers.js';

// The pure helpers take a translate(key, fallback) fn; tests exercise the
// English fallbacks by returning the fallback verbatim.
const tx = (_key, def) => def;

test('createPool: never runs more than `size` jobs at once', async () => {
  const pool = createPool(2);
  let active = 0;
  let maxActive = 0;
  const job = () => async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return active;
  };
  await Promise.all(Array.from({ length: 6 }, () => pool(job())));
  assert.ok(maxActive <= 2, `max concurrent was ${maxActive}, expected <= 2`);
});

test('createPool: runs every job and resolves with each result', async () => {
  const pool = createPool(3);
  const results = await Promise.all([1, 2, 3, 4, 5].map((n) => pool(async () => n * 10)));
  assert.deepEqual(results.sort((a, b) => a - b), [10, 20, 30, 40, 50]);
});

test('createPool: a rejecting job rejects its own promise but the pool keeps draining', async () => {
  const pool = createPool(1);
  const settled = await Promise.allSettled([
    pool(async () => { throw new Error('boom'); }),
    pool(async () => 'ok'),
  ]);
  assert.equal(settled[0].status, 'rejected');
  assert.equal(settled[0].reason.message, 'boom');
  assert.equal(settled[1].status, 'fulfilled');
  assert.equal(settled[1].value, 'ok');
});

test('nextColorIdx: lowest free index, skipping used ones', () => {
  assert.equal(nextColorIdx([], 6), 0);
  assert.equal(nextColorIdx([{ colorIdx: 0 }, { colorIdx: 1 }], 6), 2);
  // Gaps are filled lowest-first.
  assert.equal(nextColorIdx([{ colorIdx: 0 }, { colorIdx: 2 }], 6), 1);
});

test('nextColorIdx: -1 when the palette is exhausted', () => {
  const layers = [0, 1, 2].map((colorIdx) => ({ colorIdx }));
  assert.equal(nextColorIdx(layers, 3), -1);
});

test('createLayer: carries id/colorIdx/canvasEl and stamps default bookkeeping', () => {
  const canvasEl = { tag: 'canvas' };
  const layer = createLayer({ id: 'L1', colorIdx: 2, canvasEl });
  assert.equal(layer.id, 'L1');
  assert.equal(layer.colorIdx, 2);
  assert.equal(layer.canvasEl, canvasEl);
  assert.equal(layer.painted, false);
  assert.equal(layer.mode, 'stage');
  assert.equal(layer.status, 'idle');
  assert.deepEqual(layer.candidates, []);
});

test('createLayer: each layer owns its own candidates array (no shared reference)', () => {
  const a = createLayer({ id: 'L1', colorIdx: 0, canvasEl: null });
  const b = createLayer({ id: 'L2', colorIdx: 1, canvasEl: null });
  a.candidates.push('x');
  assert.deepEqual(b.candidates, []);
});

test('layerColor: reads the hex from the assigned palette slot', () => {
  const palette = [{ hex: '#aaa' }, { hex: '#bbb' }, { hex: '#ccc' }];
  assert.equal(layerColor({ colorIdx: 1 }, palette), '#bbb');
});

test('layerTitle: user name wins; otherwise 1-based "Area {n}"', () => {
  const named = { name: 'Kitchen' };
  const blank = { name: '' };
  const layers = [blank, named];
  assert.equal(layerTitle(named, layers, tx), 'Kitchen');
  assert.equal(layerTitle(blank, layers, tx), 'Area 1');
});

test('previewText: prompt > remove-mode label > furniture name > empty', () => {
  assert.equal(previewText({ prompt: '  sofa ', mode: 'stage' }, tx), 'sofa');
  assert.equal(previewText({ prompt: '', mode: 'remove' }, tx), 'Remove object');
  assert.equal(
    previewText({ prompt: '', mode: 'stage', furniture: {}, furnitureName: 'chair.png' }, tx),
    'chair.png'
  );
  assert.equal(previewText({ prompt: '', mode: 'stage', furniture: null }, tx), '');
});

// Build one seed alpha array from a list of "on" pixel indices.
const seedFrom = (n, on) => {
  const a = new Uint8Array(n);
  on.forEach((i) => { a[i] = 255; });
  return a;
};

test('nearestAreaLabels: splits a 1-D row at the midline between two seeds', () => {
  // Seeds at both ends of a 5-wide row. Distances to seed0 are [0,1,2,3,4] and
  // to seed1 [4,3,2,1,0]; the tie at the centre resolves deterministically to
  // the lower-index area, so exactly the left half (incl. centre) is area 0.
  const labels = nearestAreaLabels([seedFrom(5, [0]), seedFrom(5, [4])], 5, 1, 10);
  assert.deepEqual(Array.from(labels), [0, 0, 0, 1, 1]);
});

test('nearestAreaLabels: every pixel is owned by exactly one area (disjoint cells)', () => {
  // Two seeds in opposite corners of an 8x8 grid — no pixel is left unassigned
  // and none is shared, which is what keeps two areas from editing one band.
  const w = 8, h = 8, n = w * h;
  const labels = nearestAreaLabels([seedFrom(n, [0]), seedFrom(n, [n - 1])], w, h, 10);
  assert.ok(labels.every((v) => v === 0 || v === 1), 'no pixel left unlabeled');
  assert.equal(labels[0], 0, 'seed 0 owns its own pixel');
  assert.equal(labels[n - 1], 1, 'seed 1 owns its own pixel');
});

test('nearestAreaLabels: a single seeded area owns the whole photo', () => {
  const labels = nearestAreaLabels([seedFrom(9, [4]), new Uint8Array(9)], 3, 3, 10);
  assert.ok(Array.from(labels).every((v) => v === 0));
});

test('nearestAreaLabels: no seeds anywhere → all pixels unlabeled (-1)', () => {
  const labels = nearestAreaLabels([new Uint8Array(9)], 3, 3, 10);
  assert.ok(Array.from(labels).every((v) => v === -1));
});

test('nearestAreaLabels: sub-threshold alpha does not seed an area', () => {
  // Alpha 8 is below the default threshold of 10, so area 1 has no seed and
  // area 0 (solid) wins everything — mirrors the >8 painted-pixel test.
  const faint = new Uint8Array(4); faint.fill(8);
  const labels = nearestAreaLabels([seedFrom(4, [0]), faint], 2, 2, 10);
  assert.ok(Array.from(labels).every((v) => v === 0));
});

test('statusChip: run status wins, then readiness of the area', () => {
  assert.equal(statusChip({ status: 'generating' }, tx).text, 'Staging…');
  assert.equal(statusChip({ status: 'done' }, tx).cls, 'ms-layer-status--done');
  assert.equal(statusChip({ status: 'failed' }, tx).cls, 'ms-layer-status--failed');
  // idle + not highlighted → empty hint, no class
  assert.deepEqual(
    statusChip({ status: 'idle', painted: false }, tx),
    { cls: '', text: 'Not highlighted yet' }
  );
  // painted stage area with a prompt → ready
  assert.equal(
    statusChip({ status: 'idle', painted: true, mode: 'stage', prompt: 'rug', furniture: null }, tx).cls,
    'ms-layer-status--ready'
  );
  // painted remove area is ready even with no prompt
  assert.equal(
    statusChip({ status: 'idle', painted: true, mode: 'remove', prompt: '', furniture: null }, tx).cls,
    'ms-layer-status--ready'
  );
  // painted stage area with nothing to do → needs details
  assert.equal(
    statusChip({ status: 'idle', painted: true, mode: 'stage', prompt: '   ', furniture: null }, tx).text,
    'Needs a prompt or photo'
  );
});
