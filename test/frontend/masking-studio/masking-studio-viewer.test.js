// Tier: frontend island logic (DOM-stubbed) — public/scripts/masking-studio/viewer.js.
//
// The studio's presentation layer: the draw/generating/review phase machine, the
// before/compare/after toggle and its divider, zoom & pan, and updateControls — the
// single place that decides what is clickable.
//
// It is all class toggles and `disabled` flags, which is exactly why it is worth
// pinning: every failure here is silent. A control that stays enabled during a run
// does not throw, it just lets the user mutate a layer the pipeline is compositing
// from; a phase that forgets to un-hide "View result" does not error, it strands the
// user away from work they already paid for.
//
// The three behaviours with a documented intent behind them, and so the ones a
// refactor is most likely to quietly lose:
//
//   - "EDIT HIGHLIGHTS" MUST NOT STRAND THE USER. Going back to draw with results
//     already generated keeps "View result" reachable. Without it the only way back
//     to a finished render is to run it again.
//   - THE DISABLED HINT HAS A PRECEDENCE. No photo, then no highlight, then no
//     prompt — each names the ONE next thing to do. Reordering them tells a user with
//     an empty studio to write a prompt.
//   - A REMOVE-MODE AREA NEEDS NO PROMPT. It is complete as soon as it is painted, so
//     the "every area needs a prompt" rule has to exempt it or Apply Edit never
//     enables for a pure removal.
//
// Layout is NOT modelled: this shim knows structure and attributes, not CSS. It can
// prove the divider was clipped to 30%, never that the result looks right — that is
// e2e/masking-studio.spec.js's job.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installMaskDom, FakeEl } from '../../helpers/mask-dom.js';
import { createViewer } from '../../../public/scripts/masking-studio/viewer.js';

const MAX_LAYERS = 3;

const REAL = {
  window: globalThis.window,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
};

/**
 * Intervals the island started. The busy-message rotation runs until the phase
 * leaves 'generating', and the island clears its own — but a case that ENDS mid-run
 * (several here do, deliberately) leaves one live. Under a compressed clock that is
 * a 1ms timer the runner will wait on forever, so a broken clear would hang the
 * suite instead of failing it. Sweeping them keeps a failure a failure.
 */
let openIntervals = [];

let dom = null;
afterEach(() => {
  openIntervals.forEach((id) => REAL.clearInterval(id));
  openIntervals = [];
  if (dom) dom.restore();
  dom = null;
  globalThis.window = REAL.window;
  globalThis.setInterval = REAL.setInterval;
  globalThis.clearInterval = REAL.clearInterval;
});

/** An element with a box, for the pointer/zoom math that reads one. */
function boxed(tag, rect) {
  const el = new FakeEl(tag);
  el.getBoundingClientRect = () => rect;
  el.scrollLeft = 0;
  el.scrollTop = 0;
  return el;
}

function layer(id, over = {}) {
  return {
    id,
    status: 'idle',
    editedImg: null,
    painted: false,
    prompt: '',
    mode: 'stage',
    furniture: null,
    canvasEl: new FakeEl('canvas'),
    ...over,
  };
}

/** A finished area, the shape setPhase's `hasResults` looks for. */
const doneLayer = (id, over = {}) =>
  layer(id, { status: 'done', editedImg: {}, painted: true, prompt: 'a sofa', ...over });

function mount({
  layers = [layer('L1')],
  phase = 'draw',
  view = 'after',
  base = true,
  zoom = 1,
  undoStack = [],
  redoStack = [],
  loadingMessages = null,
} = {}) {
  dom = installMaskDom();

  const state = {
    base: base ? { w: 800, h: 600 } : null,
    phase,
    view,
    zoom,
    comparing: false,
    layers,
    undoStack,
    redoStack,
  };

  const els = {};
  for (const name of [
    'stack', 'viewToggle', 'viewerHeader', 'viewerActions', 'editHighlightsBtn',
    'viewResultBtn', 'downloadBtn', 'toggleBeforeBtn', 'toggleCompareBtn', 'toggleAfterBtn',
    'compareEl', 'compareGrip', 'compareLabelBefore', 'compareLabelAfter', 'addLayerBtn',
    'replaceBtn', 'brushSlider', 'brushBtn', 'eraseBtn', 'rectBtn', 'wandBtn', 'undoBtn',
    'redoBtn', 'generateBtn', 'ctaHint', 'resultCanvas',
  ]) {
    els[name] = new FakeEl('div');
  }
  els.baseCanvas = boxed('canvas', { left: 100, top: 50, width: 400, height: 300 });
  els.viewerEl = boxed('div', { left: 0, top: 0, width: 500, height: 400 });

  // A comma selector resolves to plain Element in the shim's matcher, so the layer
  // list serves its own children rather than pretending FakeEl parses CSS.
  const layerControls = [new FakeEl('textarea'), new FakeEl('button')];
  els.layerList = new FakeEl('div');
  els.layerList.querySelectorAll = () => layerControls;

  const calls = { renderLayers: 0, chipbar: 0, backdrop: 0, hideCursor: 0 };

  globalThis.window = /** @type {any} */ ({
    LanguageSystem: loadingMessages ? { getText: () => loadingMessages } : null,
  });
  // Compress the 2.2s message rotation; that it is started and cleared is what
  // matters, not the cadence. Every id is recorded so afterEach can sweep it.
  globalThis.setInterval = /** @type {any} */ (
    (fn, ms, ...rest) => {
      const id = REAL.setInterval(fn, ms > 1 ? 1 : ms, ...rest);
      openIntervals.push(id);
      return id;
    }
  );

  const island = createViewer({
    state,
    MAX_LAYERS,
    ...els,
    tx: (_key, def) => def,
    renderLayers: () => { calls.renderLayers += 1; },
    updateChipbarVisibility: () => { calls.chipbar += 1; },
    updateStageBackdrop: () => { calls.backdrop += 1; },
    hideCursor: () => { calls.hideCursor += 1; },
    layerColor: (l) => `#color-${l.id}`,
    layerTitle: (l) => `Area ${l.id}`,
  });

  return { island, state, calls, els, layerControls };
}

const hidden = (el) => el.classList.contains('hidden');

// ---- the phase machine --------------------------------------------------------

test('review shows the view toggle and the result actions', () => {
  const h = mount({ layers: [doneLayer('L1')] });

  h.island.setPhase('review');

  assert.equal(hidden(h.els.viewToggle), false);
  assert.equal(hidden(h.els.editHighlightsBtn), false);
  assert.equal(hidden(h.els.downloadBtn), false);
  assert.equal(hidden(h.els.viewerHeader), false);
});

test('drawing with results keeps "View result" reachable', () => {
  // Edit highlights → draw. The results still exist, so there must be a way back to
  // them; otherwise the only route to a finished render is to pay to run it again.
  const h = mount({ layers: [doneLayer('L1')] });

  h.island.setPhase('draw');

  assert.equal(hidden(h.els.viewResultBtn), false, 'the way back to the result stays open');
  assert.equal(hidden(h.els.viewerHeader), false, 'and the header that holds it stays up');
  assert.equal(hidden(h.els.viewToggle), true, 'but the before/after toggle is review-only');
  assert.equal(hidden(h.els.downloadBtn), true);
});

test('drawing with nothing generated collapses the header entirely', () => {
  // Nothing to show means the photo sits higher; leaving an empty bar there is the
  // whole reason the collapse exists.
  const h = mount({ layers: [layer('L1')] });

  h.island.setPhase('draw');

  assert.equal(hidden(h.els.viewResultBtn), true);
  assert.equal(hidden(h.els.viewerHeader), true);
  assert.equal(hidden(h.els.viewerActions), true);
});

test('leaving review tears the compare view down', () => {
  // The divider clips the result canvas with an inline clipPath. Left behind, it
  // survives into the draw phase and hides half of whatever is drawn next.
  const h = mount({ layers: [doneLayer('L1')], view: 'compare' });
  h.island.setPhase('review');
  assert.equal(hidden(h.els.compareEl), false, 'compare is up');

  h.island.setPhase('draw');

  assert.equal(hidden(h.els.compareEl), true);
  assert.equal(h.els.resultCanvas.style.clipPath, '', 'the clip is cleared, not just hidden');
  assert.equal(h.els.stack.classList.contains('is-compare'), false);
  assert.equal(h.state.comparing, false);
  assert.equal(hidden(h.state.layers[0].canvasEl), false, 'the highlight layers come back');
});

test('the drawing surface is live only in the draw phase', () => {
  const h = mount();

  h.island.setPhase('draw');
  assert.equal(h.els.stack.classList.contains('can-draw'), true);
  assert.equal(h.calls.hideCursor, 0);

  h.island.setPhase('generating');
  assert.equal(h.els.stack.classList.contains('can-draw'), false);
  assert.equal(h.els.stack.classList.contains('is-busy'), true);
  assert.equal(h.calls.hideCursor, 1, 'the brush cursor is dismissed with the surface');
});

// ---- the view toggle -----------------------------------------------------------

test('each view marks its own button active and no other', () => {
  const h = mount({ layers: [doneLayer('L1')] });
  h.island.setPhase('review');

  for (const [view, btn] of [
    ['before', 'toggleBeforeBtn'],
    ['compare', 'toggleCompareBtn'],
    ['after', 'toggleAfterBtn'],
  ]) {
    h.island.setView(view);
    const active = ['toggleBeforeBtn', 'toggleCompareBtn', 'toggleAfterBtn']
      .filter((n) => h.els[n].classList.contains('active'));
    assert.deepEqual(active, [btn], `${view} lights exactly one button`);
  }
});

test('an unrecognised view falls back to after rather than showing nothing', () => {
  const h = mount({ layers: [doneLayer('L1')] });
  h.island.setPhase('review');

  h.island.setView('nonsense');

  assert.equal(h.state.view, 'after');
  assert.equal(hidden(h.els.resultCanvas), false);
});

test('the before view hides the result and shows the highlights again', () => {
  const h = mount({ layers: [doneLayer('L1')] });
  h.island.setPhase('review');

  h.island.setView('before');

  assert.equal(hidden(h.els.resultCanvas), true);
  assert.equal(hidden(h.state.layers[0].canvasEl), false);
});

test('the after view hides the highlights so they do not sit over the render', () => {
  const h = mount({ layers: [doneLayer('L1')] });
  h.island.setPhase('review');

  h.island.setView('after');

  assert.equal(hidden(h.els.resultCanvas), false);
  assert.equal(hidden(h.state.layers[0].canvasEl), true);
});

test('compare outside review is refused', () => {
  // setView is reachable from the toggle buttons, which are hidden but not disabled
  // outside review; a stray call must not clip the canvas mid-draw.
  const h = mount({ layers: [doneLayer('L1')], phase: 'draw' });

  h.island.setView('compare');

  assert.equal(hidden(h.els.compareEl), true);
  assert.equal(h.els.resultCanvas.style.clipPath, '');
});

// ---- the compare divider --------------------------------------------------------

test('the divider clips the result and reports its position to assistive tech', () => {
  const h = mount({ layers: [doneLayer('L1')] });

  h.island.setComparePos(0.3);

  assert.equal(h.els.compareEl.style.left, '30.00%');
  assert.equal(h.els.resultCanvas.style.clipPath, 'inset(0 0 0 30.00%)');
  assert.equal(h.els.compareGrip.getAttribute('aria-valuenow'), '30');
});

test('the divider cannot be dragged off the photo', () => {
  const h = mount({ layers: [doneLayer('L1')] });

  h.island.setComparePos(-5);
  assert.equal(h.els.compareGrip.getAttribute('aria-valuenow'), '0');

  h.island.setComparePos(99);
  assert.equal(h.els.compareGrip.getAttribute('aria-valuenow'), '100');
});

test('dragging maps the pointer onto the photo, not the window', () => {
  // The photo box starts at x=100 and is 400 wide, so the midpoint is x=300.
  const h = mount({ layers: [doneLayer('L1')] });

  h.island.moveCompare({ clientX: 300 });

  assert.equal(h.els.compareGrip.getAttribute('aria-valuenow'), '50');
});

test('a drag before the photo has been laid out is ignored', () => {
  const h = mount({ layers: [doneLayer('L1')] });
  h.els.baseCanvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });

  h.island.setComparePos(0.5);
  h.island.moveCompare({ clientX: 300 });

  assert.equal(
    h.els.compareGrip.getAttribute('aria-valuenow'),
    '50',
    'a zero-width box must not produce a NaN position',
  );
});

test('the divider is keyboard operable', () => {
  const h = mount({ layers: [doneLayer('L1')] });
  h.island.setComparePos(0.5);

  const press = (key) => {
    const e = { key, prevented: 0, preventDefault() { this.prevented += 1; } };
    h.els.compareGrip.emit('keydown', e);
    return e;
  };

  assert.equal(press('ArrowLeft').prevented, 1);
  assert.equal(h.els.compareGrip.getAttribute('aria-valuenow'), '47');

  press('ArrowRight');
  press('ArrowRight');
  assert.equal(h.els.compareGrip.getAttribute('aria-valuenow'), '53');

  press('Home');
  assert.equal(h.els.compareGrip.getAttribute('aria-valuenow'), '0');

  press('End');
  assert.equal(h.els.compareGrip.getAttribute('aria-valuenow'), '100');
});

test('an unrelated key leaves the divider alone', () => {
  const h = mount({ layers: [doneLayer('L1')] });
  h.island.setComparePos(0.5);

  h.els.compareGrip.emit('keydown', { key: 'a', preventDefault() { throw new Error('must not'); } });

  assert.equal(h.els.compareGrip.getAttribute('aria-valuenow'), '50');
});

// ---- zoom -----------------------------------------------------------------------

test('zooming in sets an explicit width and marks the viewer', () => {
  const h = mount();

  h.island.setZoom(2);

  assert.equal(h.state.zoom, 2);
  assert.equal(h.els.baseCanvas.style.width, '800px', 'fit width 400 × 2');
  assert.equal(h.els.baseCanvas.style.maxWidth, 'none');
  assert.equal(h.els.viewerEl.classList.contains('is-zoomed'), true);
});

test('returning to fit clears the inline sizing rather than pinning it', () => {
  // Leaving width/maxWidth set at zoom 1 pins the photo to whatever the last zoom
  // computed, so it stops responding to the window.
  const h = mount();
  h.island.setZoom(2);

  h.island.setZoom(1);

  assert.equal(h.els.baseCanvas.style.width, '');
  assert.equal(h.els.baseCanvas.style.maxWidth, '');
  assert.equal(h.els.baseCanvas.style.maxHeight, '');
  assert.equal(h.els.viewerEl.classList.contains('is-zoomed'), false);
});

test('zoom is clamped to its range', () => {
  const h = mount();

  h.island.setZoom(99);
  assert.equal(h.state.zoom, 4);

  h.island.setZoom(0.01);
  assert.equal(h.state.zoom, 1);
});

test('resetZoom returns to fit from any zoom', () => {
  const h = mount();
  h.island.setZoom(3);

  h.island.resetZoom();

  assert.equal(h.state.zoom, 1);
  assert.equal(h.els.baseCanvas.style.width, '');
  assert.equal(h.els.viewerEl.classList.contains('is-zoomed'), false);
});

test('zooming with no photo does nothing', () => {
  const h = mount({ base: false });

  h.island.setZoom(2);

  assert.equal(h.state.zoom, 1);
});

test('ctrl+wheel zooms; a plain wheel is left as a scroll', () => {
  const h = mount();

  const plain = { deltaY: -100, ctrlKey: false, prevented: 0, preventDefault() { this.prevented += 1; } };
  h.els.viewerEl.emit('wheel', plain);
  assert.equal(plain.prevented, 0, 'the page must still scroll normally');
  assert.equal(h.state.zoom, 1);

  const zoomy = { deltaY: -100, ctrlKey: true, clientX: 250, clientY: 200, prevented: 0, preventDefault() { this.prevented += 1; } };
  h.els.viewerEl.emit('wheel', zoomy);
  assert.equal(zoomy.prevented, 1);
  assert.ok(h.state.zoom > 1);
});

test('zooming toward a point scrolls to keep it under the cursor', () => {
  const h = mount();

  h.island.setZoom(2, { x: 300, y: 200 });

  // focal 300 is 300px into a viewer starting at x=0; at 2× that content sits at 600,
  // so the viewport must move 300 to keep it under the cursor.
  assert.equal(h.els.viewerEl.scrollLeft, 300);
  assert.equal(h.els.viewerEl.scrollTop, 200);
});

// ---- control enablement -----------------------------------------------------------

test('everything is locked down while a run is in flight', () => {
  const h = mount({ layers: [layer('L1', { painted: true, prompt: 'sofa' })] });

  h.island.setPhase('generating');

  for (const name of [
    'addLayerBtn', 'replaceBtn', 'brushSlider', 'brushBtn', 'eraseBtn', 'rectBtn',
    'wandBtn', 'undoBtn', 'redoBtn', 'editHighlightsBtn', 'downloadBtn', 'generateBtn',
  ]) {
    assert.equal(h.els[name].disabled, true, `${name} must be disabled mid-run`);
  }
  for (const el of h.layerControls) {
    assert.equal(el.disabled, true, 'the per-area prompt boxes lock too');
  }
});

test('the area cap disables adding, and staying under it does not', () => {
  const under = mount({ layers: [layer('a'), layer('b')] });
  under.island.updateControls();
  assert.equal(under.els.addLayerBtn.disabled, false);

  const atCap = mount({ layers: [layer('a'), layer('b'), layer('c')] });
  atCap.island.updateControls();
  assert.equal(atCap.els.addLayerBtn.disabled, true);
});

test('undo and redo follow their stacks, and only in the draw phase', () => {
  const h = mount({ undoStack: [{}], redoStack: [] });

  h.island.setPhase('draw');
  assert.equal(h.els.undoBtn.disabled, false);
  assert.equal(h.els.redoBtn.disabled, true, 'nothing to redo');

  h.island.setPhase('review');
  assert.equal(h.els.undoBtn.disabled, true, 'history is not editable from the result view');
});

test('download waits for something to download', () => {
  const empty = mount({ layers: [layer('L1')] });
  empty.island.updateControls();
  assert.equal(empty.els.downloadBtn.disabled, true);

  const ready = mount({ layers: [doneLayer('L1')] });
  ready.island.updateControls();
  assert.equal(ready.els.downloadBtn.disabled, false);
});

// ---- Apply Edit and the hint that explains it ---------------------------------------

test('with no photo, the hint asks for a photo', () => {
  const h = mount({ base: false, layers: [] });

  h.island.updateControls();

  assert.equal(h.els.generateBtn.disabled, true);
  assert.match(h.els.ctaHint.textContent, /upload an image first/i);
  assert.equal(hidden(h.els.ctaHint), false);
});

test('with a photo but no highlight, the hint asks for a highlight', () => {
  // Precedence matters: telling someone with an empty studio to "write a prompt" is
  // an instruction they cannot act on yet.
  const h = mount({ layers: [layer('L1')] });

  h.island.updateControls();

  assert.equal(h.els.generateBtn.disabled, true);
  assert.match(h.els.ctaHint.textContent, /Paint at least one area/i);
});

test('with a highlight but no prompt, the hint asks for a prompt', () => {
  const h = mount({ layers: [layer('L1', { painted: true })] });

  h.island.updateControls();

  assert.equal(h.els.generateBtn.disabled, true);
  assert.match(h.els.ctaHint.textContent, /short prompt or a furniture photo/i);
});

test('a painted area with a prompt is ready, and the hint disappears', () => {
  const h = mount({ layers: [layer('L1', { painted: true, prompt: '  a grey sofa  ' })] });

  h.island.updateControls();

  assert.equal(h.els.generateBtn.disabled, false);
  assert.equal(h.els.ctaHint.textContent, '');
  assert.equal(hidden(h.els.ctaHint), true);
});

test('whitespace is not a prompt', () => {
  const h = mount({ layers: [layer('L1', { painted: true, prompt: '   ' })] });

  h.island.updateControls();

  assert.equal(h.els.generateBtn.disabled, true);
});

test('a furniture photo counts instead of a prompt', () => {
  const h = mount({ layers: [layer('L1', { painted: true, furniture: 'data:image/png;base64,AA' })] });

  h.island.updateControls();

  assert.equal(h.els.generateBtn.disabled, false);
});

test('a remove-mode area needs no prompt at all', () => {
  // Removal is fully specified by the highlight. Requiring a prompt would make a pure
  // "take this out" edit impossible to start.
  const h = mount({ layers: [layer('L1', { painted: true, mode: 'remove' })] });

  h.island.updateControls();

  assert.equal(h.els.generateBtn.disabled, false);
  assert.equal(h.els.ctaHint.textContent, '');
});

test('one unfinished area holds the whole run back', () => {
  // Every painted area is generated in the same run, so a blank one would burn a
  // generation on an empty instruction.
  const h = mount({
    layers: [layer('a', { painted: true, prompt: 'sofa' }), layer('b', { painted: true })],
  });

  h.island.updateControls();

  assert.equal(h.els.generateBtn.disabled, true);
  assert.match(h.els.ctaHint.textContent, /short prompt or a furniture photo/i);
});

test('an unpainted area is not counted against the run', () => {
  // Adding an area and not using it is normal; it must not block Apply Edit.
  const h = mount({
    layers: [layer('a', { painted: true, prompt: 'sofa' }), layer('b')],
  });

  h.island.updateControls();

  assert.equal(h.els.generateBtn.disabled, false);
});

test('no hint is shown while generating, since nothing is actionable', () => {
  const h = mount({ layers: [layer('L1')] });

  h.island.setPhase('generating');

  assert.equal(h.els.ctaHint.textContent, '');
  assert.equal(hidden(h.els.ctaHint), true);
});

// ---- the busy overlay ---------------------------------------------------------------

test('each participating area gets a dot in its own colour', () => {
  const h = mount();

  h.island.renderBusyDots([
    layer('a', { status: 'generating' }),
    layer('b', { status: 'done' }),
    layer('c', { status: 'failed' }),
  ]);

  const overlay = h.els.stack.children.find((c) => c.classList.contains('ms-busy-overlay'));
  const dots = overlay.querySelector('.ms-busy-dots').children;
  assert.equal(dots.length, 3);
  assert.equal(dots[0].classList.contains('ms-busy-dot--running'), true, 'the running one pulses');
  assert.equal(dots[0].style.background, '#color-a');
  assert.equal(dots[1].textContent, '✓');
  assert.equal(dots[2].textContent, '!');
  assert.equal(dots[2].style.background, '#b91c1c', 'a failure is red, not its area colour');
  assert.equal(dots[0].title, 'Area a', 'each dot names its area');
});

test('re-rendering the dots replaces them rather than stacking up', () => {
  const h = mount();

  h.island.renderBusyDots([layer('a'), layer('b')]);
  h.island.renderBusyDots([layer('a')]);

  const overlay = h.els.stack.children.find((c) => c.classList.contains('ms-busy-overlay'));
  assert.equal(overlay.querySelector('.ms-busy-dots').children.length, 1);
});

test('the overlay is built once and reused', () => {
  const h = mount();

  h.island.renderBusyDots([layer('a')]);
  h.island.setPhase('generating');
  h.island.setPhase('draw');

  const overlays = h.els.stack.children.filter((c) => c.classList.contains('ms-busy-overlay'));
  assert.equal(overlays.length, 1, 'one overlay per studio, not one per run');
});

test('the busy overlay follows the run and is hidden otherwise', () => {
  // Note for anyone mutation-testing this file: setPhase toggles the overlay AND then
  // calls stopBusyMessages, which hides it again. The second hide is unreachable on
  // its own — setPhase is stopBusyMessages' only caller and has already decided one
  // line earlier — so deleting it changes nothing observable. That is redundant
  // source, not a hole in this test.
  const h = mount();

  h.island.setPhase('generating');
  const overlay = h.els.stack.children.find((c) => c.classList.contains('ms-busy-overlay'));
  assert.equal(hidden(overlay), false);
  assert.ok(overlay.querySelector('.ms-busy-msg').textContent.length > 0, 'it says something');

  h.island.setPhase('review');
  assert.equal(hidden(overlay), true);
});

test('the progress lines are localized when the pack has them', () => {
  const h = mount({ loadingMessages: ['Möbel werden platziert…', 'Fast fertig…'] });

  h.island.setPhase('generating');

  const overlay = h.els.stack.children.find((c) => c.classList.contains('ms-busy-overlay'));
  assert.equal(overlay.querySelector('.ms-busy-msg').textContent, 'Möbel werden platziert…');
});

test('an empty language pack falls back rather than blanking the label', () => {
  const h = mount({ loadingMessages: [] });

  h.island.setPhase('generating');

  const overlay = h.els.stack.children.find((c) => c.classList.contains('ms-busy-overlay'));
  assert.ok(overlay.querySelector('.ms-busy-msg').textContent.length > 0);
});
