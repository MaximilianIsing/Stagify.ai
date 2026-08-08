// Tier: frontend island logic (real canvas) — public/scripts/masking-studio/layers-ui.js.
//
// The area model's user interface: adding and removing areas, the layer cards, and
// the chip bar. The pure half — colour assignment, titles, status chips — lives in
// layers.js and is covered by masking-studio-layers.test.js. What is asserted here is
// the lifecycle, which is where the destructive mistakes are:
//
//   - REMOVING THE LAST AREA IMMEDIATELY CREATES A FRESH ONE. There is always
//     something to draw on; without it the studio lands in a state with a photo, no
//     area, and no way to make one except the chip bar's add button, which is itself
//     rendered from the (now empty) area list.
//   - THE ACTIVE AREA MUST SURVIVE ITS OWN DELETION. Removing the selected area has
//     to hand the selection to another one, or every subsequent stroke goes nowhere:
//     canDraw() requires an active layer, so the brush silently stops working.
//   - THE LAYER CANVAS IS DETACHED, NOT JUST FORGOTTEN. Dropping the array entry
//     without removing the element leaves the deleted area's paint on screen forever.
//   - EVERY AREA GETS ITS OWN COLOUR. Two areas sharing one is not cosmetic: the
//     colour is how a user tells which highlight belongs to which prompt.
//
// Canvases are real (@napi-rs/canvas), so the layer elements the island creates and
// inserts are the ones it actually draws into.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installMaskDom, FakeEl } from '../../helpers/mask-dom.js';
import { createLayersUi } from '../../../public/scripts/masking-studio/layers-ui.js';

const W = 120;
const H = 90;
const MAX_LAYERS = 3;
const PALETTE = [
  { hex: '#ff0000', name: 'red' },
  { hex: '#00ff00', name: 'green' },
  { hex: '#0000ff', name: 'blue' },
];

const REAL = { window: globalThis.window };

let dom = null;
afterEach(() => {
  if (dom) dom.restore();
  dom = null;
  globalThis.window = REAL.window;
});

function mount({ phase = 'draw', view = 'after', base = true, layers = [] } = {}) {
  dom = installMaskDom();

  const winListeners = new Map();
  dom.win.addEventListener = (t, fn) => {
    if (!winListeners.has(t)) winListeners.set(t, []);
    winListeners.get(t).push(fn);
  };
  globalThis.window = dom.win;

  const state = {
    base: base ? { w: W, h: H, canvas: null } : null,
    phase,
    view,
    layers: [...layers],
    layerSeq: 0,
    activeId: layers[0] ? layers[0].id : null,
    undoStack: [],
    redoStack: [],
  };

  const calls = {
    updateControls: 0, saves: 0, backdrop: 0, composites: 0, phases: [], toasts: [],
  };

  const layerList = new FakeEl('div');
  const chipbar = new FakeEl('div');
  const stack = new FakeEl('div');
  const resultCanvas = new FakeEl('canvas');
  stack.appendChild(resultCanvas);
  const addLayerBtn = new FakeEl('button');

  const island = createLayersUi({
    state,
    MAX_LAYERS,
    PALETTE,
    layerList,
    chipbar,
    stack,
    resultCanvas,
    addLayerBtn,
    tx: (_k, def) => def,
    showToast: (m, t) => calls.toasts.push({ message: m, type: t }),
    updateControls: () => { calls.updateControls += 1; },
    scheduleSessionSave: () => { calls.saves += 1; },
    updateStageBackdrop: () => { calls.backdrop += 1; },
    compositeAll: () => { calls.composites += 1; },
    setPhase: (p) => { calls.phases.push(p); state.phase = p; },
    snapshotForUndo: () => {},
    retryLayer: () => {},
    selectCandidate: () => {},
    wireFurnitureDrop: () => {},
    beginFurniturePick: () => {},
    snapLayer: () => {},
  });

  return {
    island,
    state,
    calls,
    layerList,
    chipbar,
    stack,
    addLayerBtn,
    /** Canvases the island inserted into the stack, in order. */
    layerCanvases: () => stack.children.filter((c) => c.className === 'ms-layer-canvas'),
    chips: () => chipbar.children,
    fireLanguageChange: () => (winListeners.get('languagechange') || []).forEach((fn) => fn()),
  };
}

// ---- adding ------------------------------------------------------------------

test('adding an area creates its canvas and selects it', () => {
  const h = mount();

  h.island.addLayer();

  assert.equal(h.state.layers.length, 1);
  assert.equal(h.state.activeId, h.state.layers[0].id);
  assert.equal(h.layerCanvases().length, 1, 'with a canvas of its own to draw on');
  assert.equal(h.calls.saves, 1);
});

test('the new canvas sits UNDER the result, so results always cover highlights', () => {
  const h = mount();

  h.island.addLayer();
  h.island.addLayer();

  const kids = h.stack.children;
  const resultIdx = kids.findIndex((c) => c.tagName === 'CANVAS' && c.className !== 'ms-layer-canvas');
  const lastLayerIdx = kids.map((c) => c.className).lastIndexOf('ms-layer-canvas');
  assert.ok(lastLayerIdx < resultIdx, 'every highlight is inserted before the result canvas');
});

test('each area gets a colour of its own', () => {
  // The colour is the only thing tying a highlight on the photo to a prompt in the
  // list; two areas sharing one makes the pairing unguessable.
  const h = mount();

  h.island.addLayer();
  h.island.addLayer();
  h.island.addLayer();

  const colours = h.state.layers.map((l) => h.island.layerColor(l));
  assert.equal(new Set(colours).size, 3);
});

test('a freed colour is reused after its area is removed', () => {
  const h = mount();
  h.island.addLayer();
  h.island.addLayer();
  const secondColour = h.island.layerColor(h.state.layers[1]);

  h.island.removeLayer(h.state.layers[1].id);
  h.island.addLayer();

  const colours = h.state.layers.map((l) => h.island.layerColor(l));
  assert.equal(new Set(colours).size, colours.length, 'still all distinct');
  assert.ok(colours.includes(secondColour), 'and the freed colour came back into use');
});

test('the area cap is enforced', () => {
  // Note for anyone mutation-testing this: the entry sets MAX_LAYERS = PALETTE.length,
  // so the count check and the "no colour left" check bound the same number and
  // deleting either one alone changes nothing. Both are guards on the same fact.
  const h = mount();

  for (let i = 0; i < MAX_LAYERS + 2; i += 1) h.island.addLayer();

  assert.equal(h.state.layers.length, MAX_LAYERS);
  assert.equal(h.layerCanvases().length, MAX_LAYERS, 'and no orphan canvases were left behind');
});

test('the add button explains the cap rather than doing nothing', () => {
  const h = mount();
  for (let i = 0; i < MAX_LAYERS; i += 1) h.island.addLayer();

  h.addLayerBtn.emit('click', {});

  assert.equal(h.state.layers.length, MAX_LAYERS);
  assert.equal(h.calls.toasts.length, 1);
  assert.match(h.calls.toasts[0].message, new RegExp(`up to ${MAX_LAYERS} areas`));
});

test('the add button adds while there is room', () => {
  const h = mount();

  h.addLayerBtn.emit('click', {});

  assert.equal(h.state.layers.length, 1);
  assert.deepEqual(h.calls.toasts, []);
});

test('no area can be added before a photo is loaded', () => {
  const h = mount({ base: false });

  h.island.addLayer();

  assert.deepEqual(h.state.layers, []);
});

// ---- removing ----------------------------------------------------------------------

test('removing an area detaches its canvas from the page', () => {
  // Splicing the array without removing the element leaves the deleted area's paint
  // on the photo permanently.
  const h = mount();
  h.island.addLayer();
  h.island.addLayer();
  const doomed = h.state.layers[1];

  h.island.removeLayer(doomed.id);

  assert.equal(h.state.layers.length, 1);
  assert.equal(h.layerCanvases().length, 1);
  assert.equal(h.layerCanvases().includes(doomed.canvasEl), false);
});

test('removing the selected area hands the selection to another', () => {
  // canDraw() requires an active area. Leaving activeId pointing at a deleted one
  // makes the brush silently stop working with no error and no visible cause.
  const h = mount();
  h.island.addLayer();
  h.island.addLayer();
  h.state.activeId = h.state.layers[1].id;

  h.island.removeLayer(h.state.layers[1].id);

  assert.equal(h.state.activeId, h.state.layers[0].id);
  assert.ok(h.island.activeLayer(), 'and it resolves to a real area');
});

test('removing an unselected area leaves the selection alone', () => {
  // Three areas with the MIDDLE one selected: with two, the "hand it to the last
  // remaining area" fallback happens to name the selected one anyway, so the guard
  // could be deleted and this would still pass.
  const h = mount();
  h.island.addLayer();
  h.island.addLayer();
  h.island.addLayer();
  const active = h.state.layers[1].id;
  h.state.activeId = active;

  h.island.removeLayer(h.state.layers[0].id);

  assert.equal(h.state.activeId, active);
});

test('removing the last area immediately provides a fresh one', () => {
  // Otherwise the studio sits with a photo, no area, and nothing to draw on.
  const h = mount();
  h.island.addLayer();
  const only = h.state.layers[0].id;

  h.island.removeLayer(only);

  assert.equal(h.state.layers.length, 1, 'there is always something to draw on');
  assert.notEqual(h.state.layers[0].id, only, 'and it is a new, empty one');
  assert.ok(h.island.activeLayer(), 'selected and ready');
});

test('removing an area that is not there does nothing', () => {
  const h = mount();
  h.island.addLayer();

  h.island.removeLayer('nope');

  assert.equal(h.state.layers.length, 1);
});

test('removing an area re-derives the phase UI', () => {
  // In refine, dropping an area has to refresh the ghost backdrop and may retire the
  // Looks Good button — running the phase machine again is what does both.
  const h = mount();
  h.island.addLayer();
  h.island.addLayer();

  h.island.removeLayer(h.state.layers[0].id);

  assert.ok(h.calls.phases.length > 0, 'the phase is re-applied rather than patched piecemeal');
  assert.ok(h.calls.saves > 0);
});

test('removing an area in review rebuilds the composite', () => {
  // The result on screen was composited FROM that area; leaving it would show an
  // edit for a highlight that no longer exists.
  const h = mount({ phase: 'review' });
  h.island.addLayer();
  h.island.addLayer();

  h.island.removeLayer(h.state.layers[0].id);

  assert.ok(h.calls.composites > 0);
});

test('removing an area while drawing does not rebuild the composite', () => {
  const h = mount({ phase: 'draw' });
  h.island.addLayer();
  h.island.addLayer();

  h.island.removeLayer(h.state.layers[0].id);

  assert.equal(h.calls.composites, 0, 'there is no result to rebuild yet');
});

// ---- lookups --------------------------------------------------------------------------

test('an area can be found by id, and a missing one answers null', () => {
  const h = mount();
  h.island.addLayer();
  const id = h.state.layers[0].id;

  assert.equal(h.island.getLayer(id), h.state.layers[0]);
  assert.equal(h.island.getLayer('nope'), null);
});

test('the active area is null when nothing is selected', () => {
  const h = mount();

  assert.equal(h.island.activeLayer(), null);
});

// ---- the chip bar ------------------------------------------------------------------------

test('the chip bar shows one chip per area plus an add button', () => {
  const h = mount();
  h.island.addLayer();
  h.island.addLayer();

  h.island.renderChips();

  const chips = h.chips();
  assert.equal(chips.length, 3, 'two areas and the add chip');
  assert.equal(chips[2].classList.contains('ms-chip--add'), true);
});

test('the add chip disappears at the cap', () => {
  const h = mount();
  for (let i = 0; i < MAX_LAYERS; i += 1) h.island.addLayer();

  h.island.renderChips();

  assert.equal(h.chips().length, MAX_LAYERS, 'no add chip for an area that cannot be created');
});

test('exactly one chip is marked active', () => {
  const h = mount();
  h.island.addLayer();
  h.island.addLayer();

  h.island.renderChips();

  const active = h.chips().filter((c) => c.classList.contains('is-active'));
  assert.equal(active.length, 1);
});

test('clicking a chip selects that area', () => {
  const h = mount();
  h.island.addLayer();
  h.island.addLayer();
  h.island.renderChips();
  const firstId = h.state.layers[0].id;

  h.chips()[0].emit('click', {});

  assert.equal(h.state.activeId, firstId);
});

test('chips are inert during a run', () => {
  // The pipeline composites from the layer canvases while it runs; switching the
  // active area mid-run invites a stroke into a canvas being read from.
  const h = mount();
  h.island.addLayer();
  h.island.addLayer();
  h.island.renderChips();
  const before = h.state.activeId;
  h.state.phase = 'generating';

  h.chips()[0].emit('click', {});
  h.chips()[2] && h.chips()[2].emit('click', {});

  assert.equal(h.state.activeId, before);
});

test('re-rendering the chips replaces them rather than stacking up', () => {
  const h = mount();
  h.island.addLayer();

  h.island.renderChips();
  h.island.renderChips();

  assert.equal(h.chips().length, 2, 'one area plus the add chip, not four elements');
});

test('the chip bar is hidden before a photo is loaded', () => {
  const h = mount({ base: false });

  h.island.updateChipbarVisibility();

  assert.equal(h.chipbar.classList.contains('hidden'), true);
});

test('the chip bar is hidden over a result, and shown over the original', () => {
  // The chips sit on the photo. Over the After view they would obscure the render
  // the user is judging; over Before they are back on their own highlights.
  const h = mount({ phase: 'review', view: 'after' });
  h.island.updateChipbarVisibility();
  assert.equal(h.chipbar.classList.contains('hidden'), true);

  h.state.view = 'before';
  h.island.updateChipbarVisibility();
  assert.equal(h.chipbar.classList.contains('hidden'), false);
});

test('the chip bar is shown while drawing', () => {
  const h = mount({ phase: 'draw' });

  h.island.updateChipbarVisibility();

  assert.equal(h.chipbar.classList.contains('hidden'), false);
});

// ---- localisation ----------------------------------------------------------------------

test('switching language rebuilds the cards rather than leaving stale copy', () => {
  // The card labels are rendered once into the DOM, not bound to a live lookup, so
  // nothing updates them unless the whole list is rebuilt.
  const h = mount();
  h.island.addLayer();
  const before = h.calls.updateControls;

  h.fireLanguageChange();

  assert.ok(h.calls.updateControls > before, 'the controls are re-derived too');
});
