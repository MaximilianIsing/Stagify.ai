// Tier: frontend island logic (real canvas) — public/scripts/masking-studio/snap-refine.js.
//
// "Snap to object" is the fix for the one artefact the refine step reliably produces:
// compositing each area's output through the painted mask cuts the model's work off at
// the stroke edge, so a sofa arm or a chair leg that the AI drew just PAST the
// highlight lands sliced. This island measures that overhang per area after a run and
// then, on request, grows the mask to include it.
//
// The pure flood detector is covered by masking-studio-spill.test.js. What is asserted
// here is the island's own half — which areas are eligible for a suggestion, that a
// stale suggestion cannot outlive the run that produced it, and that accepting one
// paints a full-resolution mask through the normal stroke path.
//
// PIXELS ARE REAL: document.createElement('canvas') comes from @napi-rs/canvas via
// test/helpers/mask-dom.js, the same backing the mask/ slices use. The downsample, the
// flood and the nearest-neighbour upscale all actually run, so "the suggestion covers
// the overhang" is measured on the resulting bitmap rather than mocked away.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';

import { installMaskDom } from '../../helpers/mask-dom.js';
import { createSnapRefine } from '../../../public/scripts/masking-studio/snap-refine.js';

const W = 100;
const H = 80;

let dom = null;
afterEach(() => {
  if (dom) dom.restore();
  dom = null;
});

/** A canvas filled black, optionally with white rectangles painted on it. */
function canvasWith(rects = [], w = W, h = H) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  for (const [x0, y0, x1, y1] of rects) ctx.fillRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  return c;
}

/** A transparent stroke canvas with opaque white where the user painted. */
function strokeCanvas(rects = [], w = W, h = H) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  for (const [x0, y0, x1, y1] of rects) ctx.fillRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  return c;
}

/**
 * One area. The default is the standard fixture: the user highlighted x10–30 and the
 * model drew an object out to x45, so 31–45 is overhang the composite would slice off.
 */
function layer(id, over = {}) {
  return {
    id,
    colorIdx: 0,
    painted: true,
    status: 'done',
    mode: 'stage',
    name: '',
    prompt: '',
    spill: null,
    canvasEl: strokeCanvas([[10, 10, 30, 30]]),
    editedImg: canvasWith([[10, 10, 45, 30]]),
    ...over,
  };
}

function mount({ layers = [layer('L1')], phase = 'draw', base = true, w = W, h = H } = {}) {
  dom = installMaskDom();
  const state = {
    base: base ? { w, h, canvas: canvasWith([], w, h) } : null,
    layers,
    phase,
    activeId: layers[0] ? layers[0].id : null,
  };
  const painted = [];
  const island = createSnapRefine({
    state,
    paintMaskIntoLayer: (l, maskCanvas) => {
      // Captured at call time: the island is supposed to have already consumed the
      // suggestion by this point, and reading it afterwards would not show that.
      painted.push({ layer: l, mask: maskCanvas, spillAtPaint: l.spill });
    },
  });
  return { island, state, painted };
}

/** Count of opaque pixels in a canvas, and the rightmost column holding one. */
function paintStats(canvas) {
  const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let count = 0;
  let maxX = -1;
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      if (d[(y * canvas.width + x) * 4 + 3] > 10) {
        count += 1;
        if (x > maxX) maxX = x;
      }
    }
  }
  return { count, maxX };
}

// ---- which areas get a suggestion -------------------------------------------

test('an object overhanging its highlight produces a suggestion', () => {
  const { island, state } = mount();

  const suggested = island.computeSpillForDone();

  assert.equal(suggested, 1, 'the one done area gained a suggestion');
  assert.ok(state.layers[0].spill, 'and it is stashed on the layer');
  assert.ok(state.layers[0].spill.count > 0);
  assert.equal(state.layers[0].spill.pw, W, 'the suggestion records the grid it was computed on');
  assert.equal(state.layers[0].spill.ph, H);
});

test('an object that stayed inside its highlight produces nothing', () => {
  // The negative case is load-bearing: without it every assertion here would still
  // pass with the detector wired to return a constant.
  const { island, state } = mount({
    layers: [layer('L1', { editedImg: canvasWith([[12, 12, 28, 28]]) })],
  });

  assert.equal(island.computeSpillForDone(), 0);
  assert.equal(state.layers[0].spill, null);
});

test('a remove-mode area is never offered a snap', () => {
  // Remove rebuilds the room BEHIND the mask. There is no object to snap to, and the
  // diff against the base is large — exactly the input that would otherwise produce a
  // huge bogus suggestion.
  const { island, state } = mount({ layers: [layer('L1', { mode: 'remove' })] });

  assert.equal(island.computeSpillForDone(), 0);
  assert.equal(state.layers[0].spill, null);
});

test('an area that has not finished generating is skipped', () => {
  const { island, state } = mount({ layers: [layer('L1', { status: 'pending' })] });

  assert.equal(island.computeSpillForDone(), 0);
  assert.equal(state.layers[0].spill, null);
});

test('an area with no result image is skipped', () => {
  const { island, state } = mount({ layers: [layer('L1', { editedImg: null })] });

  assert.equal(island.computeSpillForDone(), 0);
  assert.equal(state.layers[0].spill, null);
});

test('an unpainted area is skipped even if its canvas still holds pixels', () => {
  // `painted` is the authority, not the bitmap. The flag is recomputed by a
  // downsampled alpha scan that ignores paint too faint to count, so a canvas with
  // leftover specks below that threshold still reads as empty — and seeding a flood
  // from those specks would grow a mask out of noise the user cannot even see.
  const { island, state } = mount({ layers: [layer('L1', { painted: false })] });

  assert.equal(island.computeSpillForDone(), 0);
  assert.equal(state.layers[0].spill, null);
});

test('a run with no photo loaded computes nothing', () => {
  const { island } = mount({ base: false });

  assert.equal(island.computeSpillForDone(), 0);
});

test('a fresh run clears the previous run suggestion even when it finds none', () => {
  // The stale-suggestion bug: re-run an area, get no overhang this time, and the old
  // spill would still be sitting on the layer with the button still lit. Accepting it
  // would grow the mask by pixels measured against an image that no longer exists.
  const stale = layer('L1', { editedImg: canvasWith([[12, 12, 28, 28]]) });
  stale.spill = { pw: W, ph: H, fill: new Uint8Array(W * H), count: 42 };
  const { island, state } = mount({ layers: [stale] });

  assert.equal(island.computeSpillForDone(), 0);
  assert.equal(state.layers[0].spill, null, 'the previous suggestion must not survive the re-run');
});

test('only the areas taking part in a run are recomputed', () => {
  // A partial re-run must leave the other areas' suggestions alone rather than
  // silently retiring buttons the user can still legitimately press.
  // Separate territory on purpose: two areas painted over the SAME pixels get
  // partitioned into one winner and one empty-handed loser, which would make this
  // assertion fail for a reason that has nothing to do with participation.
  const a = layer('A', {
    canvasEl: strokeCanvas([[10, 10, 20, 30]]),
    editedImg: canvasWith([[10, 10, 32, 30]]),
  });
  const b = layer('B', {
    canvasEl: strokeCanvas([[60, 10, 70, 30]]),
    editedImg: canvasWith([[60, 10, 82, 30]]),
  });
  const { island, state } = mount({ layers: [a, b] });

  island.computeSpillForDone();
  const bSpill = state.layers[1].spill;
  assert.ok(bSpill, 'both areas start with a suggestion');

  island.computeSpillForDone([a]);

  assert.ok(state.layers[0].spill, 'the participating area is recomputed');
  assert.equal(state.layers[1].spill, bSpill, 'the untouched area keeps its suggestion object');
});

test('two areas reaching for the same pixels are partitioned, never both given them', () => {
  // Adjacent highlights on one long object: both floods can reach the pixels between
  // them, so the island clips each to its own Voronoi cell. Without that clip BOTH
  // areas claim the overlap and accepting both snaps paints the same region twice —
  // two areas fighting over one strip of sofa, each re-composited over the other.
  //
  // The highlights are close enough that the bands genuinely intersect; spaced further
  // apart the flood's own distance bound would separate them and this would pass with
  // the partition deleted.
  const left = layer('L', {
    canvasEl: strokeCanvas([[10, 10, 20, 30]]),
    editedImg: canvasWith([[10, 10, 60, 30]]),
  });
  const right = layer('R', {
    canvasEl: strokeCanvas([[30, 10, 40, 30]]),
    editedImg: canvasWith([[10, 10, 60, 30]]),
  });
  const { island, state } = mount({ layers: [left, right] });

  island.computeSpillForDone();

  const [lf, rf] = state.layers.map((l) => (l.spill ? l.spill.fill : new Uint8Array(W * H)));
  assert.ok(state.layers[0].spill && state.layers[1].spill, 'both areas get a suggestion');

  let overlap = 0;
  for (let i = 0; i < lf.length; i += 1) if (lf[i] && rf[i]) overlap += 1;
  assert.equal(overlap, 0, 'no pixel may be offered to two areas at once');
});

// ---- accepting a suggestion --------------------------------------------------

test('accepting a snap paints a full-resolution mask through the stroke path', () => {
  const { island, state, painted } = mount();
  island.computeSpillForDone();

  island.snapLayer('L1');

  assert.equal(painted.length, 1, 'the snap goes through paintMaskIntoLayer, not a private write');
  assert.equal(painted[0].layer, state.layers[0]);
  assert.equal(painted[0].mask.width, W, 'the mask is upscaled back to the photo resolution');
  assert.equal(painted[0].mask.height, H);

  const stats = paintStats(painted[0].mask);
  assert.ok(stats.count > 0, 'the mask actually carries the suggested pixels');
  assert.ok(
    stats.maxX > 30,
    `the mask must reach past the original highlight edge (x=30), got x=${stats.maxX}`,
  );
});

test('the snap mask is upscaled back to the photo, not left on the working grid', () => {
  // The detector runs on a downsampled grid capped at 640px on the long edge. A photo
  // bigger than that is the ONLY case where the working grid and the photo differ, so
  // it is the only case that can prove the upscale happens — paint a 640-wide mask
  // onto a 1000-wide layer and the snap lands in the wrong place, scaled to ~64%.
  const big = { w: 1000, h: 800 };
  const { island, painted } = mount({
    ...big,
    layers: [
      layer('L1', {
        canvasEl: strokeCanvas([[100, 100, 300, 300]], big.w, big.h),
        editedImg: canvasWith([[100, 100, 450, 300]], big.w, big.h),
      }),
    ],
  });

  island.computeSpillForDone();
  island.snapLayer('L1');

  assert.equal(painted.length, 1);
  assert.equal(painted[0].mask.width, big.w, 'the mask is the photo width, not the 640px grid');
  assert.equal(painted[0].mask.height, big.h);
  assert.ok(paintStats(painted[0].mask).count > 0, 'and it is not blank after the upscale');
});

test('the suggestion is consumed before the repaint, so the button retires', () => {
  // Ordering, not just eventual state: paintMaskIntoLayer re-renders the controls, and
  // a spill still set at that moment leaves "Snap to object" lit for a suggestion that
  // has already been applied. Pressing it again would grow the mask a second time.
  const { island, painted } = mount();
  island.computeSpillForDone();

  island.snapLayer('L1');

  assert.equal(painted[0].spillAtPaint, null, 'spill was already cleared when the repaint ran');
});

test('snapping an area with no suggestion does nothing', () => {
  const { island, painted } = mount();

  island.snapLayer('L1');

  assert.deepEqual(painted, []);
});

test('snapping an unknown area does nothing', () => {
  const { island, painted } = mount();
  island.computeSpillForDone();

  island.snapLayer('nope');

  assert.deepEqual(painted, []);
});

test('a snap is refused outside the draw phase', () => {
  // Mid-generation the layer canvases are being composited from; growing a mask then
  // would race the run it is supposed to refine.
  const { island, state, painted } = mount();
  island.computeSpillForDone();
  state.phase = 'generating';

  island.snapLayer('L1');

  assert.deepEqual(painted, []);
  assert.ok(state.layers[0].spill, 'and the suggestion survives for when drawing resumes');
});

// ---- the button's own predicate ---------------------------------------------

test('hasPendingSpill reports whether anything is actually offerable', () => {
  const { island, state } = mount();
  assert.equal(island.hasPendingSpill(), false, 'nothing before a run');

  island.computeSpillForDone();
  assert.equal(island.hasPendingSpill(), true);

  island.snapLayer('L1');
  assert.equal(island.hasPendingSpill(), false, 'and nothing once it has been accepted');

  // An empty suggestion is not a suggestion: a zero count must not light the button.
  state.layers[0].spill = { pw: W, ph: H, fill: new Uint8Array(W * H), count: 0 };
  assert.equal(island.hasPendingSpill(), false);
});
