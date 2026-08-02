// Unit tests for the shared mask brush (public/scripts/mask/brush.js).
//
// The two mask editors carried near-identical copies of this; e2e pinned the
// user-visible behaviour first (e2e/stage-mask-brush.spec.js), and these cover
// the parts a browser test can only reach awkwardly: the pointer→canvas mapping
// when the on-screen box differs from the intrinsic size, the busy guard, and
// the two-tier "has anything been painted" check.
//
// Strokes land on a real @napi-rs/canvas, so every assertion is about actual
// pixels rather than call-shape.
//
// Sizes here are steps on the relative scale (public/scripts/mask/brush-scale.js),
// not pixels — a step is a share of the photo's long edge. On the 200x100 harness
// canvas that scale runs from the 6px floor up to 30px at step 16, which is why
// the step numbers look large next to the pixel widths they produce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMaskBrush } from '../../../public/scripts/mask/brush.js';
import { drawCanvas } from '../../helpers/mask-dom.js';

/** Brush wired to a canvas whose CSS box is half its intrinsic size. */
function setup({ phase = 'draw', busy = false, w = 200, h = 100, rect } = {}) {
  const canvas = drawCanvas({ w, h, rect: rect || { left: 0, top: 0, width: w, height: h } });
  const calls = { ready: 0, refine: 0 };
  const state = { phase, busy };
  const brush = createMaskBrush({
    getCanvas: () => canvas,
    getPhase: () => state.phase,
    isBusy: () => state.busy,
    onReadyChange: () => { calls.ready += 1; },
    onRefineStroke: () => { calls.refine += 1; },
  });
  brush.attach();
  return { canvas, brush, calls, state };
}

const down = (c, x, y) => c.emit('mousedown', { clientX: x, clientY: y });
const move = (c, x, y) => c.emit('mousemove', { clientX: x, clientY: y });
const up = (c) => c.emit('mouseup', {});

test('a click lays down a dot at the mapped canvas coordinate', () => {
  const { canvas, brush } = setup();
  brush.setSizeStep(14);
  down(canvas, 100, 50);
  up(canvas);

  assert.ok(canvas.alphaAt(100, 50) > 10, 'painted at the click point');
  assert.equal(canvas.alphaAt(5, 5), 0, 'and nowhere near the corner');
});

// The mapping is the part most likely to break in an extraction: the CSS box and
// the intrinsic size routinely differ, and a stale scale offsets every stroke.
test('scales pointer coordinates when the CSS box differs from the intrinsic size', () => {
  const { canvas, brush } = setup({
    w: 400, h: 200,
    rect: { left: 0, top: 0, width: 200, height: 100 }, // rendered at half size
  });
  brush.setSizeStep(6);
  down(canvas, 100, 50); // centre of the CSS box
  up(canvas);

  assert.ok(canvas.alphaAt(200, 100) > 10, 'maps to the centre in canvas pixels');
  assert.equal(canvas.alphaAt(100, 50), 0, 'not to the raw client coordinate');
});

test('accounts for the canvas being offset from the viewport origin', () => {
  const { canvas, brush } = setup({
    w: 200, h: 100,
    rect: { left: 50, top: 30, width: 200, height: 100 },
  });
  brush.setSizeStep(10);
  down(canvas, 150, 80); // 100,50 within the canvas
  up(canvas);

  assert.ok(canvas.alphaAt(100, 50) > 10);
});

test('a drag paints a connected stroke, not just its endpoints', () => {
  const { canvas, brush } = setup();
  brush.setSizeStep(11);
  down(canvas, 40, 50);
  move(canvas, 160, 50);
  up(canvas);

  assert.ok(canvas.alphaAt(40, 50) > 10, 'start painted');
  assert.ok(canvas.alphaAt(100, 50) > 10, 'midpoint painted — the segment was stroked');
  assert.ok(canvas.alphaAt(160, 50) > 10, 'end painted');
});

test('erase removes from the selection instead of adding', () => {
  const { canvas, brush } = setup();
  brush.setSizeStep(16);
  down(canvas, 100, 50);
  up(canvas);
  const afterBrush = canvas.paintedPixels();
  assert.ok(afterBrush > 0);

  brush.setTool('erase');
  down(canvas, 100, 50);
  up(canvas);

  assert.ok(canvas.paintedPixels() < afterBrush, 'the eraser took pixels away');
});

test('the draw phase paints blue and the refine phase green', () => {
  const { canvas, brush, state } = setup();
  brush.setSizeStep(14);
  down(canvas, 50, 50);
  up(canvas);
  assert.equal(canvas.colorAt(50, 50), '#2563eb');

  state.phase = 'refine';
  down(canvas, 150, 50);
  up(canvas);
  assert.equal(canvas.colorAt(150, 50), '#16a34a', 'refine strokes are visually distinct');
});

test('readiness flips on the first mark and is rechecked on stroke end', () => {
  const { canvas, brush, calls } = setup();
  assert.equal(brush.hasContent(), false, 'nothing painted yet');

  brush.setSizeStep(14);
  down(canvas, 100, 50);
  assert.equal(brush.hasContent(), true, 'the first mark enables Apply immediately');
  const afterFirstMark = calls.ready;
  assert.ok(afterFirstMark >= 1);

  up(canvas);
  assert.equal(brush.hasContent(), true, 'still painted after the accurate rescan');
  assert.ok(calls.ready > afterFirstMark, 'stroke end refreshes readiness too');
});

test('erasing the whole selection away takes readiness back to false', () => {
  const { canvas, brush } = setup();
  brush.setSizeStep(12);
  down(canvas, 100, 50);
  up(canvas);
  assert.equal(brush.hasContent(), true);

  // Erase generously over everything painted.
  brush.setTool('erase');
  brush.setSizeStep(16);
  down(canvas, 40, 50);
  move(canvas, 160, 50);
  up(canvas);

  assert.equal(canvas.paintedPixels(), 0, 'canvas is empty');
  assert.equal(brush.hasContent(), false, 'the stroke-end rescan caught it');
});

test('an erase stroke on an empty canvas never claims content', () => {
  const { canvas, brush } = setup();
  brush.setTool('erase');
  brush.setSizeStep(16);
  down(canvas, 100, 50);
  up(canvas);

  assert.equal(brush.hasContent(), false, 'erasing is not painting');
});

test('clear wipes the canvas and reports the change', () => {
  const { canvas, brush, calls } = setup();
  brush.setSizeStep(16);
  down(canvas, 100, 50);
  up(canvas);
  const before = calls.ready;

  brush.clear();

  assert.equal(canvas.paintedPixels(), 0);
  assert.equal(brush.hasContent(), false);
  assert.ok(calls.ready > before, 'the Apply button is refreshed');
});

test('nothing paints while a run is in flight', () => {
  const { canvas, brush, state } = setup({ busy: true });
  brush.setSizeStep(16);
  down(canvas, 100, 50);
  move(canvas, 120, 50);
  up(canvas);

  assert.equal(canvas.paintedPixels(), 0, 'the busy guard blocks the whole stroke');

  state.busy = false;
  down(canvas, 100, 50);
  up(canvas);
  assert.ok(canvas.paintedPixels() > 0, 'and lets go once the run ends');
});

test('a finished stroke re-crops only while refining', () => {
  const { canvas, brush, calls, state } = setup();
  brush.setSizeStep(14);
  down(canvas, 100, 50);
  up(canvas);
  assert.equal(calls.refine, 0, 'no preview work in the draw phase');

  state.phase = 'refine';
  down(canvas, 120, 50);
  up(canvas);
  assert.equal(calls.refine, 1, 'refine strokes re-composite the existing result');
});

test('recolor repaints existing strokes without changing coverage', () => {
  const { canvas, brush } = setup();
  brush.setSizeStep(16);
  down(canvas, 100, 50);
  up(canvas);
  const coverage = canvas.paintedPixels();

  brush.recolor('#16a34a');

  assert.equal(canvas.paintedPixels(), coverage, 'alpha is untouched — mask logic reads alpha');
  assert.equal(canvas.colorAt(100, 50), '#16a34a');
});

test('attach is idempotent so reopening never doubles the listeners', () => {
  const { canvas, brush } = setup(); // already attached once
  brush.attach();
  brush.attach();

  assert.equal(canvas.listenerCount('mousedown'), 1);
  assert.equal(canvas.listenerCount('mousemove'), 1);
});

test('touch events draw the same way as the mouse', () => {
  const { canvas, brush } = setup();
  brush.setSizeStep(12);
  const touch = (type, x, y) => canvas.emit(type, { preventDefault() {}, touches: [{ clientX: x, clientY: y }] });

  touch('touchstart', 40, 50);
  touch('touchmove', 160, 50);
  canvas.emit('touchend', { preventDefault() {} });

  assert.ok(canvas.alphaAt(100, 50) > 10, 'the swipe painted a connected stroke');
  assert.equal(brush.hasContent(), true);
});

// The point of the whole scale, and the one property no test asserted before:
// coverage was only ever checked by position, never by width, which is how a
// pixel-valued brush stayed 15% of a 1024px photo and 3.7% of a 4032px one
// without anything going red.
test('one step covers the same share of a small photo and a large one', () => {
  const shareOf = (w, h) => {
    const { canvas, brush } = setup({ w, h, rect: { left: 0, top: 0, width: w, height: h } });
    brush.setSizeStep(12);
    down(canvas, w / 2, h / 2);
    up(canvas);
    return canvas.paintedPixels() / (w * h);
  };

  const small = shareOf(400, 200);
  const large = shareOf(1600, 800); // 4x the long edge

  assert.ok(small > 0 && large > 0, 'both photos were painted on');
  const drift = Math.abs(small - large) / small;
  assert.ok(drift < 0.05, `same share of each photo (small ${small}, large ${large}, drift ${drift})`);
});

test('a bigger photo gets a proportionally wider stroke at the same step', () => {
  // Guards the direction as well as the ratio: a brush that ignored the canvas
  // entirely would also pass the share test if both canvases were the same size.
  const widthAt = (w, h) => {
    const { canvas, brush } = setup({ w, h, rect: { left: 0, top: 0, width: w, height: h } });
    brush.setSizeStep(16);
    down(canvas, w / 2, h / 2);
    up(canvas);
    let painted = 0;
    for (let y = 0; y < h; y++) if (canvas.alphaAt(Math.round(w / 2), y) > 10) painted++;
    return painted;
  };

  const narrow = widthAt(400, 400);
  const wide = widthAt(800, 800);

  assert.ok(wide > narrow * 1.8, `doubling the photo roughly doubles the brush (${narrow} -> ${wide})`);
});

test('an out-of-range step is clamped, not obeyed', () => {
  // The Masking Studio's [ and ] shortcuts set the step directly, so values
  // outside the range reach the scale without an input's min/max to stop them.
  const paintedAt = (step) => {
    const { canvas, brush } = setup({ w: 400, h: 200, rect: { left: 0, top: 0, width: 400, height: 200 } });
    brush.setSizeStep(step);
    down(canvas, 200, 100);
    up(canvas);
    return canvas.paintedPixels();
  };

  assert.equal(paintedAt(999), paintedAt(16), 'a huge step paints exactly what the maximum does');
  assert.equal(paintedAt(-5), paintedAt(1), 'and a negative one paints what the minimum does');
});

test('a zero-sized canvas is survived rather than crashed on', () => {
  const canvas = drawCanvas({ w: 1, h: 1, rect: { left: 0, top: 0, width: 0, height: 0 } });
  const brush = createMaskBrush({
    getCanvas: () => canvas, getPhase: () => 'draw', isBusy: () => false,
  });
  brush.attach();

  assert.doesNotThrow(() => { down(canvas, 10, 10); up(canvas); });
});
