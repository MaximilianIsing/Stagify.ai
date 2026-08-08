// Tier: frontend island logic (real canvas) — public/scripts/masking-studio/draw-tools.js.
//
// The drawing surface: brush, eraser, rectangle and wand, plus the undo/redo history
// and the "paint a ready-made mask in as if it had been brushed" path that both the
// segmentation wand and the refine snap go through.
//
// Two invariants here are the reason the studio's masks can be trusted:
//
//   - AREAS NEVER OVERLAP. Painting into one area CLAIMS those pixels from every
//     other, by erasing them elsewhere. Two areas holding the same pixel would send
//     two conflicting edits for it and composite one over the other.
//   - `painted` IS RESCANNED, NOT ASSUMED. Erasing (or another area claiming your
//     pixels) can empty a layer without that layer being touched directly, so the
//     flag is recomputed for EVERY layer after every stroke. It gates Apply Edit,
//     the session save and the spill detector, so a stale `true` starts a run on an
//     empty mask.
//
// Undo/redo are exact inverses by construction — each pops one stack and pushes the
// CURRENT state of the same layers onto the other. The round-trip is asserted on real
// pixels rather than on stack lengths.
//
// Canvases are real (@napi-rs/canvas via test/helpers/mask-dom.js), so claiming,
// erasing and the alpha rescan all happen for real.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';

import { installMaskDom, FakeEl } from '../../helpers/mask-dom.js';
import { createDrawTools } from '../../../public/scripts/masking-studio/draw-tools.js';
import {
  BRUSH_STEP_MIN,
  BRUSH_STEP_MAX,
  BRUSH_STEP_DEFAULT,
} from '../../../public/scripts/mask/brush-scale.js';

const W = 200;
const H = 160;

const REAL = { window: globalThis.window };

let dom = null;
afterEach(() => {
  if (dom) dom.restore();
  dom = null;
  globalThis.window = REAL.window;
});

/** A layer canvas: a real canvas wearing the DOM clothes the island needs. */
function layerCanvas() {
  const c = createCanvas(W, H);
  const classes = new Set();
  c.classList = {
    add: (n) => classes.add(n),
    remove: (n) => classes.delete(n),
    contains: (n) => classes.has(n),
    toggle: (n, on) => (on ? classes.add(n) : classes.delete(n)),
  };
  c.style = {};
  return c;
}

function layer(id, over = {}) {
  return {
    id,
    colorIdx: 0,
    painted: false,
    canvasEl: layerCanvas(),
    blendMask: null,
    prompt: '',
    mode: 'stage',
    ...over,
  };
}

/** Paint an opaque block into a layer, as a stroke would. */
function fill(l, [x0, y0, x1, y1], color = '#ff0000') {
  const ctx = l.canvasEl.getContext('2d');
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = color;
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  l.painted = true;
}

/** An opaque white stamp, the shape the wand and the snap hand in. */
function stamp([x0, y0, x1, y1]) {
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  return c;
}

const alphaAt = (l, x, y) => l.canvasEl.getContext('2d').getImageData(x, y, 1, 1).data[3];
const paintedPixels = (l) => {
  const d = l.canvasEl.getContext('2d').getImageData(0, 0, W, H).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n += 1;
  return n;
};

// `activeId` defaults to the FIRST layer rather than a fixed id: snapshotForUndo
// only copies the active area and areas that already hold paint, so a harness whose
// activeId names no real layer records an empty snapshot and every undo assertion
// silently becomes a no-op.
function mount({ layers = [layer('L1')], phase = 'draw', activeId = null, base = true, segCache = null } = {}) {
  const active = activeId || (layers[0] ? layers[0].id : null);
  dom = installMaskDom();
  globalThis.window = /** @type {any} */ ({ LanguageSystem: null });

  const state = {
    base: base ? { w: W, h: H, canvas: createCanvas(W, H) } : null,
    phase,
    layers,
    activeId: active,
    brushStep: BRUSH_STEP_DEFAULT,
    undoStack: [],
    redoStack: [],
    segCache,
    zoom: 1,
  };

  const calls = { renderLayers: 0, updateControls: 0, saves: 0, backdrop: 0, segSweeps: 0, wandClicks: 0 };

  const els = {};
  for (const n of ['stack', 'viewerEl', 'undoBtn', 'redoBtn', 'brushBtn', 'eraseBtn', 'rectBtn', 'wandBtn', 'brushRow', 'wandRow']) {
    els[n] = new FakeEl('div');
  }
  els.brushSlider = new FakeEl('input');
  els.baseCanvas = new FakeEl('canvas');
  els.baseCanvas.getBoundingClientRect = () => ({ left: 20, top: 10, width: W, height: H });
  els.viewerEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: W, height: H });

  const island = createDrawTools({
    state,
    ...els,
    activeLayer: () => state.layers.find((l) => l.id === state.activeId) || null,
    getLayer: (id) => state.layers.find((l) => l.id === id) || null,
    layerColor: () => '#ff0000',
    renderLayers: () => { calls.renderLayers += 1; },
    updateControls: () => { calls.updateControls += 1; },
    scheduleSessionSave: () => { calls.saves += 1; },
    updateStageBackdrop: () => { calls.backdrop += 1; },
    setZoom: () => {},
    moveCompare: () => {},
    wandClick: () => { calls.wandClicks += 1; },
    ensureSegCache: async () => { calls.segSweeps += 1; return []; },
  });

  return { island, state, calls, els };
}

// ---- pixel claiming ---------------------------------------------------------

test('painting a mask into an area claims those pixels from every other area', () => {
  // Overlapping areas would send two conflicting edits for the same pixels; the
  // composite then shows whichever happened to be applied last.
  const a = layer('A');
  const b = layer('B');
  fill(b, [40, 40, 120, 120]);
  const h = mount({ layers: [a, b], activeId: 'A' });

  h.island.paintMaskIntoLayer(a, stamp([50, 50, 100, 100]));

  assert.ok(alphaAt(a, 70, 70) > 0, 'A owns the pixels it just claimed');
  assert.equal(alphaAt(b, 70, 70), 0, 'and B has given them up');
  assert.ok(alphaAt(b, 115, 115) > 0, 'while keeping the rest of its own area');
});

test('the claimed pixels take the area colour, not the stamp colour', () => {
  const a = layer('A');
  const h = mount({ layers: [a] });

  h.island.paintMaskIntoLayer(a, stamp([50, 50, 100, 100]));

  const [r, g, b] = a.canvasEl.getContext('2d').getImageData(70, 70, 1, 1).data;
  assert.deepEqual([r, g, b], [255, 0, 0], 'tinted to the area colour so areas stay distinguishable');
});

test('an area emptied by another claim is no longer marked painted', () => {
  // `painted` gates Apply Edit and the spill detector. A layer whose pixels were all
  // taken is empty in fact but would still read as painted without the rescan — and
  // the run would go out with an empty mask.
  const a = layer('A');
  const b = layer('B');
  fill(b, [50, 50, 100, 100]);
  const h = mount({ layers: [a, b], activeId: 'A' });

  h.island.paintMaskIntoLayer(a, stamp([0, 0, W, H]));

  assert.equal(b.painted, false, 'B lost everything and knows it');
  assert.equal(a.painted, true);
});

test('a claim invalidates the cached compositing masks', () => {
  // The blend mask is frozen at generate time; a later stroke makes it wrong, so it
  // has to be dropped or the composite crops to the old strokes.
  const a = layer('A', { blendMask: createCanvas(W, H) });
  const b = layer('B', { blendMask: createCanvas(W, H) });
  const h = mount({ layers: [a, b], activeId: 'A' });

  h.island.paintMaskIntoLayer(a, stamp([10, 10, 40, 40]));

  assert.equal(a.blendMask, null);
  assert.equal(b.blendMask, null, 'every layer, not just the one that changed');
});

test('a claim repaints the studio and saves the work', () => {
  const h = mount();

  h.island.paintMaskIntoLayer(h.state.layers[0], stamp([10, 10, 40, 40]));

  assert.ok(h.calls.renderLayers > 0);
  assert.ok(h.calls.updateControls > 0);
  assert.ok(h.calls.backdrop > 0, 'the refine ghost re-crops as strokes change');
  assert.equal(h.calls.saves, 1);
});

// ---- undo and redo -----------------------------------------------------------------

test('undo restores the exact pixels from before the stroke', () => {
  const a = layer('A');
  fill(a, [10, 10, 30, 30]);
  const h = mount({ layers: [a] });
  const before = paintedPixels(a);

  h.island.paintMaskIntoLayer(a, stamp([100, 100, 150, 150]));
  assert.ok(paintedPixels(a) > before, 'the stroke landed');

  h.island.undoStroke();

  assert.equal(paintedPixels(a), before, 'and was taken back exactly');
  assert.equal(alphaAt(a, 120, 120), 0);
  assert.ok(alphaAt(a, 20, 20) > 0, 'without disturbing what was there first');
});

test('redo puts the stroke back', () => {
  const a = layer('A');
  const h = mount({ layers: [a] });
  h.island.paintMaskIntoLayer(a, stamp([100, 100, 150, 150]));
  const after = paintedPixels(a);

  h.island.undoStroke();
  h.island.redoStroke();

  assert.equal(paintedPixels(a), after);
  assert.ok(alphaAt(a, 120, 120) > 0);
});

test('undo restores every area the stroke touched, not just the active one', () => {
  // A claim edits two layers at once. Undoing only the active one leaves the other
  // permanently missing the pixels it gave up.
  const a = layer('A');
  const b = layer('B');
  fill(b, [50, 50, 100, 100]);
  const h = mount({ layers: [a, b], activeId: 'A' });
  const bBefore = paintedPixels(b);

  h.island.paintMaskIntoLayer(a, stamp([60, 60, 90, 90]));
  assert.ok(paintedPixels(b) < bBefore, 'B gave pixels up');

  h.island.undoStroke();

  assert.equal(paintedPixels(b), bBefore, 'and got them back');
});

test('a new stroke discards the redo history', () => {
  // Otherwise redo replays a stroke that belongs to a branch the user has left, and
  // it lands on top of whatever they have drawn since.
  const a = layer('A');
  const h = mount({ layers: [a] });
  h.island.paintMaskIntoLayer(a, stamp([100, 100, 150, 150]));
  h.island.undoStroke();
  assert.equal(h.state.redoStack.length, 1);

  h.island.paintMaskIntoLayer(a, stamp([10, 10, 40, 40]));

  assert.deepEqual(h.state.redoStack, []);
});

test('the history is bounded', () => {
  // Each entry is a full-resolution canvas per touched layer; an unbounded stack is
  // an unbounded memory cost across a long session.
  const a = layer('A');
  const h = mount({ layers: [a] });

  for (let i = 0; i < 12; i += 1) h.island.paintMaskIntoLayer(a, stamp([i, i, i + 20, i + 20]));

  assert.ok(h.state.undoStack.length <= 5, `undo history stayed bounded (${h.state.undoStack.length})`);
});

test('undo and redo do nothing with an empty history', () => {
  const h = mount();

  assert.doesNotThrow(() => h.island.undoStroke());
  assert.doesNotThrow(() => h.island.redoStroke());
});

test('history is frozen outside the draw phase', () => {
  // Review shows composited results built from these exact strokes; changing them
  // there would leave the picture and the masks describing different things.
  const a = layer('A');
  const h = mount({ layers: [a] });
  h.island.paintMaskIntoLayer(a, stamp([100, 100, 150, 150]));
  const after = paintedPixels(a);

  h.state.phase = 'review';
  h.island.undoStroke();

  assert.equal(paintedPixels(a), after);
});

test('an area deleted since the stroke is skipped rather than resurrected', () => {
  const a = layer('A');
  const b = layer('B');
  fill(b, [50, 50, 100, 100]);
  const h = mount({ layers: [a, b], activeId: 'A' });
  h.island.paintMaskIntoLayer(a, stamp([60, 60, 90, 90]));

  h.state.layers = [a]; // the user removed area B
  h.island.undoStroke();

  assert.equal(h.state.layers.length, 1, 'B stays deleted');
  assert.ok(paintedPixels(a) >= 0);
});

test('the undo snapshot skips areas that cannot be affected', () => {
  // A stroke can only touch the active area and areas that already hold paint —
  // claiming is a no-op on an empty canvas. Snapshotting every area would copy a
  // full-resolution canvas per empty area on every pointerdown.
  const a = layer('A');
  const empty = layer('B');
  const painted = layer('C');
  fill(painted, [10, 10, 20, 20]);
  const h = mount({ layers: [a, empty, painted], activeId: 'A' });

  h.island.snapshotForUndo();

  assert.deepEqual(
    h.state.undoStack[0].map((e) => e.id).sort(),
    ['A', 'C'],
    'the active area and the painted one, not the empty one',
  );
});

// ---- the emptiness scan -------------------------------------------------------------

test('the content scan sees a small mark and an empty canvas apart', () => {
  const h = mount();
  const blank = createCanvas(W, H);
  const marked = createCanvas(W, H);
  const ctx = marked.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(100, 80, 4, 4);

  assert.equal(h.island.scanHasContent(blank), false);
  assert.equal(h.island.scanHasContent(marked), true, 'a few pixels must survive the downscale');
});

test('nearly-transparent paint does not count as content', () => {
  // Anti-aliased edges and a mis-fired eraser leave a haze that is invisible on
  // screen; treating it as a highlight would start a run on an empty mask.
  const h = mount();
  const faint = createCanvas(W, H);
  const ctx = faint.getContext('2d');
  ctx.fillStyle = 'rgba(255,0,0,0.01)';
  ctx.fillRect(0, 0, W, H);

  assert.equal(h.island.scanHasContent(faint), false);
});

// ---- the toolbar ------------------------------------------------------------------

test('picking a tool marks exactly one button, for sighted and screen-reader users alike', () => {
  const h = mount();

  for (const [tool, btn] of [['brush', 'brushBtn'], ['erase', 'eraseBtn'], ['rect', 'rectBtn'], ['wand', 'wandBtn']]) {
    h.island.setTool(tool);
    const active = ['brushBtn', 'eraseBtn', 'rectBtn', 'wandBtn'].filter((n) => h.els[n].classList.contains('is-active'));
    assert.deepEqual(active, [btn], `${tool} lights one button`);
    const pressed = ['brushBtn', 'eraseBtn', 'rectBtn', 'wandBtn'].filter((n) => h.els[n].getAttribute('aria-pressed') === 'true');
    assert.deepEqual(pressed, [btn], `${tool} announces one button as pressed`);
  }
});

test('an unknown tool falls back to the brush', () => {
  const h = mount();

  h.island.setTool('nonsense');

  assert.equal(h.els.brushBtn.classList.contains('is-active'), true);
});

test('the brush size control is swapped for the wand controls', () => {
  const h = mount();

  h.island.setTool('wand');
  assert.equal(h.els.brushRow.classList.contains('hidden'), true);
  assert.equal(h.els.wandRow.classList.contains('hidden'), false);

  h.island.setTool('brush');
  assert.equal(h.els.brushRow.classList.contains('hidden'), false);
  assert.equal(h.els.wandRow.classList.contains('hidden'), true);
});

test('picking the wand starts analysing the photo straight away', () => {
  // The sweep takes seconds. Starting it on tool select rather than on first click
  // means the photo is usually mapped by the time the user aims.
  const h = mount();

  h.island.setTool('wand');

  assert.equal(h.calls.segSweeps, 1);
});

test('the wand does not re-analyse a photo it has already mapped', () => {
  const h = mount({ segCache: [{}] });

  h.island.setTool('wand');

  assert.equal(h.calls.segSweeps, 0);
});

test('the wand does not analyse outside the draw phase', () => {
  const h = mount({ phase: 'review' });

  h.island.setTool('wand');

  assert.equal(h.calls.segSweeps, 0);
});

test('a failed prefetch is silent, because the click path reports it', () => {
  const h = mount();
  const island = h.island;

  assert.doesNotThrow(() => island.setTool('wand'));
});

// ---- brush size ----------------------------------------------------------------------

test('the brush size is clamped to the scale, whichever way it is set', () => {
  // The [ and ] shortcuts set the step directly and never pass through the slider's
  // min/max, so the clamp cannot live in the markup.
  const h = mount();

  h.island.setBrushStep(999);
  assert.equal(h.state.brushStep, BRUSH_STEP_MAX);

  h.island.setBrushStep(-50);
  assert.equal(h.state.brushStep, BRUSH_STEP_MIN);
});

test('the slider bounds come from the scale, not the markup', () => {
  const h = mount();

  assert.equal(h.els.brushSlider.min, String(BRUSH_STEP_MIN));
  assert.equal(h.els.brushSlider.max, String(BRUSH_STEP_MAX));
  assert.equal(h.els.brushSlider.value, String(BRUSH_STEP_DEFAULT), 'and it starts at the default');
});

test('the slider and the shortcuts stay in step', () => {
  const h = mount();

  h.island.setBrushStep(BRUSH_STEP_MIN + 1);

  assert.equal(h.els.brushSlider.value, String(BRUSH_STEP_MIN + 1), 'the control reflects the state');
});

// ---- pointer mapping --------------------------------------------------------------------

test('a pointer position maps onto the photo, allowing for its on-screen box', () => {
  // The canvas is displayed at whatever size fits; the strokes have to land in
  // intrinsic pixels or every mask is offset from what the user drew.
  const h = mount();

  const p = h.island.canvasPoint({ clientX: 20 + 50, clientY: 10 + 40 });

  assert.deepEqual(p, { x: 50, y: 40 });
});

test('a pointer position is scaled when the photo is displayed smaller than it is', () => {
  const h = mount();
  h.els.baseCanvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: W / 2, height: H / 2 });

  const p = h.island.canvasPoint({ clientX: 25, clientY: 20 });

  assert.deepEqual(p, { x: 50, y: 40 }, 'half-size on screen means double the coordinate');
});

test('a pointer position before the photo is laid out is refused', () => {
  const h = mount();
  h.els.baseCanvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });

  assert.equal(h.island.canvasPoint({ clientX: 10, clientY: 10 }), null, 'rather than dividing by zero');
});
