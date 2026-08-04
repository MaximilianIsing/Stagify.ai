// "Refine in Masking Studio" on the staging result (public/scripts/app/refine-handoff.js).
//
// Two rules carry the whole feature, and both are easy to get subtly wrong:
//   1. The button appears only when the render actually reached the gallery, because the
//      handoff is a render ID and there is nothing to hand over without one.
//   2. It hands over the variation the user is LOOKING at. `gallery.ids` is index-aligned
//      with the carousel's variations, so always sending ids[0] would quietly refine a
//      different image than the one on screen — a bug nobody would notice until they saw
//      the result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRefineHandoff } from '../../../public/scripts/app/refine-handoff.js';
import { HANDOFF_KEY } from '../../../public/scripts/masking-handoff.js';

/** A button stand-in that records its class toggles and fires its listener on click(). */
function fakeButton() {
  let listener = null;
  return {
    hidden: true,
    classList: {
      toggle(name, on) { this.state = { name, on }; },
      state: null,
    },
    addEventListener: (_evt, fn) => { listener = fn; },
    click: () => listener && listener(),
  };
}

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
    read: (k) => map.get(k),
    size: () => map.size,
  };
}

function setup({ afterIndex = 0, sourceName = 'house.jpg' } = {}) {
  const button = fakeButton();
  const storage = fakeStorage();
  const navigated = [];
  // sessionStorage is what sendToMaskingStudio reaches for; give it a stand-in for the
  // duration of the test rather than a global shim.
  const realSession = global.sessionStorage;
  Object.defineProperty(global, 'sessionStorage', { value: storage, configurable: true });
  // localizedTarget reads location.pathname to keep a reader on /es on /es. The root path
  // is the English case, which is what the assertions below expect.
  const realLocation = global.location;
  Object.defineProperty(global, 'location', { value: { pathname: '/', hash: '' }, configurable: true });
  const handoff = createRefineHandoff({
    button: /** @type {any} */ (button),
    getAfterIndex: () => afterIndex,
    getSourceName: () => sourceName,
    navigate: (href) => navigated.push(href),
  });
  const restore = () => {
    if (realSession === undefined) delete (/** @type {any} */ (global)).sessionStorage;
    else Object.defineProperty(global, 'sessionStorage', { value: realSession, configurable: true });
    if (realLocation === undefined) delete (/** @type {any} */ (global)).location;
    else Object.defineProperty(global, 'location', { value: realLocation, configurable: true });
  };
  return { handoff, button, storage, navigated, restore };
}

test('the button stays hidden until a render reaches the gallery', () => {
  const { handoff, button, restore } = setup();
  handoff.setIds([]);
  assert.deepEqual(button.classList.state, { name: 'hidden', on: true });
  handoff.setIds(['r_1']);
  assert.deepEqual(button.classList.state, { name: 'hidden', on: false });
  restore();
});

test('a batch with no ids hides it again — persistence can fail per request', () => {
  const { handoff, button, restore } = setup();
  handoff.setIds(['r_1']);
  handoff.setIds([]);
  assert.deepEqual(button.classList.state, { name: 'hidden', on: true });
  restore();
});

test('clicking hands over the render on screen, not the first of the batch', () => {
  // A Stagify+ render can produce three variations. The carousel decides which is showing.
  const { handoff, button, storage, navigated, restore } = setup({ afterIndex: 2 });
  handoff.setIds(['r_a', 'r_b', 'r_c']);
  button.click();
  assert.deepEqual(JSON.parse(storage.read(HANDOFF_KEY)), { renderId: 'r_c', sourceName: 'house.jpg' });
  assert.equal(navigated.length, 1);
  assert.match(navigated[0], /masking-studio\.html$/);
  restore();
});

test('an index past the end falls back to the first render rather than doing nothing', () => {
  const { handoff, button, storage, restore } = setup({ afterIndex: 9 });
  handoff.setIds(['r_a']);
  button.click();
  assert.equal(JSON.parse(storage.read(HANDOFF_KEY)).renderId, 'r_a');
  restore();
});

test('clicking with no ids does nothing at all', () => {
  const { handoff, button, storage, navigated, restore } = setup();
  handoff.setIds([]);
  button.click();
  assert.equal(storage.size(), 0);
  assert.equal(navigated.length, 0, 'and above all it does not navigate');
  restore();
});

test('a refused handoff does not navigate, so nobody lands on an empty studio', () => {
  const button = fakeButton();
  const navigated = [];
  const realSession = global.sessionStorage;
  Object.defineProperty(global, 'sessionStorage', {
    value: { setItem() { throw new Error('quota'); }, getItem: () => null, removeItem() {} },
    configurable: true,
  });
  const handoff = createRefineHandoff({
    button: /** @type {any} */ (button),
    getAfterIndex: () => 0,
    getSourceName: () => '',
    navigate: (href) => navigated.push(href),
  });
  handoff.setIds(['r_1']);
  button.click();
  assert.equal(navigated.length, 0);
  if (realSession === undefined) delete (/** @type {any} */ (global)).sessionStorage;
  else Object.defineProperty(global, 'sessionStorage', { value: realSession, configurable: true });
});

test('a non-array from the response is treated as no ids, not a crash', () => {
  const { handoff, button, restore } = setup();
  handoff.setIds(/** @type {any} */ (undefined));
  assert.deepEqual(button.classList.state, { name: 'hidden', on: true });
  restore();
});
