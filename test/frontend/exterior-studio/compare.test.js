// Tier: frontend island logic — public/scripts/exterior-studio/compare.js.
//
// The before/after wipe. Only one thing here is subtle, and it is invisible in a
// screenshot of the default position: the after image has to be counter-sized against
// its own clipping wrapper. Miss it and dragging the slider SQUEEZES the after image
// instead of uncovering the before one — at 50% both look plausible, so the bug only
// shows once someone drags, and it reads as a rendering artefact rather than a bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompare } from '../../../public/scripts/exterior-studio/compare.js';

/** A stand-in exposing just the surface the island touches. */
function el(extra = {}) {
  /** @type {Record<string, string>} */
  const props = {};
  /** @type {Record<string, Function[]>} */
  const listeners = {};
  return {
    style: { setProperty: (k, v) => { props[k] = v; }, get props() { return props; } },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    fire: (type) => (listeners[type] || []).forEach((fn) => fn()),
    get listeners() { return listeners; },
    ...extra,
  };
}

function mount() {
  const root = el();
  const before = el();
  const after = el({ naturalWidth: 1600, naturalHeight: 1000 });
  const afterWrap = el();
  const range = el({ value: '50' });
  const api = createCompare({ root, before, after, afterWrap, range });
  return { api, root, before, after, afterWrap, range };
}

test('the widget starts at the midpoint', () => {
  const m = mount();
  assert.equal(m.afterWrap.style.props['--ex-split'], '50%');
});

test('the after image is counter-sized against its clipping wrapper', () => {
  // The wrapper is <pct>% of the box; the image inside it must be (100/pct * 100)% of the
  // WRAPPER, which resolves back to exactly the box width. Without this the image is laid
  // out at 100% of a shrinking wrapper, so sliding scales it down instead of revealing.
  const m = mount();
  m.api.setSplit(25);
  assert.equal(m.afterWrap.style.props['--ex-split'], '25%');
  assert.equal(m.after.style.props['--ex-after-width'], '400%', '100/25 * 100');

  m.api.setSplit(80);
  assert.equal(m.after.style.props['--ex-after-width'], '125%', '100/80 * 100');
});

test('the two halves line up at every position', () => {
  // The property that actually matters, stated once rather than as three magic numbers:
  // wrapper width x image width must always resolve to the full box.
  const m = mount();
  for (const pct of [1, 10, 33, 50, 67, 99, 100]) {
    m.api.setSplit(pct);
    const split = parseFloat(m.afterWrap.style.props['--ex-split']);
    const width = parseFloat(m.after.style.props['--ex-after-width']);
    assert.ok(Math.abs((split / 100) * (width / 100) - 1) < 1e-9, `misaligned at ${pct}%`);
  }
});

test('a zero split does not divide by zero', () => {
  // Dragging fully to one end is a normal gesture, and NaN% silently drops the whole
  // declaration — the image would jump to its natural size mid-drag.
  const m = mount();
  assert.doesNotThrow(() => m.api.setSplit(0));
  assert.equal(m.afterWrap.style.props['--ex-split'], '0%');
  assert.equal(m.after.style.props['--ex-after-width'], '100%');
});

test('out-of-range and non-numeric positions are clamped, never written raw', () => {
  const m = mount();
  m.api.setSplit(999);
  assert.equal(m.afterWrap.style.props['--ex-split'], '100%');
  m.api.setSplit(-40);
  assert.equal(m.afterWrap.style.props['--ex-split'], '0%');
  m.api.setSplit(/** @type {any} */ ('nonsense'));
  assert.equal(m.afterWrap.style.props['--ex-split'], '0%', 'NaN would drop the declaration');
});

test('dragging the range drives the wipe', () => {
  const m = mount();
  m.range.value = '30';
  m.range.fire('input');
  assert.equal(m.afterWrap.style.props['--ex-split'], '30%');
});

test('show() loads both frames and resets the slider to the middle', () => {
  const m = mount();
  m.api.setSplit(10);
  m.api.show('blob:before', 'data:image/webp;base64,AFTER');
  assert.equal(m.before.src, 'blob:before');
  assert.equal(m.after.src, 'data:image/webp;base64,AFTER');
  assert.equal(m.range.value, '50', 'a new result starts from the middle');
  assert.equal(m.afterWrap.style.props['--ex-split'], '50%');
});

test('the box is pinned to the result\'s own shape once it loads', () => {
  // The upload and the render are the same photo at different pixel sizes (the delivered
  // image is upscaled). A box that resized between them would jump the moment a result
  // arrived, right where the user is looking.
  const m = mount();
  m.api.show('blob:before', 'data:after');
  assert.equal(m.root.style.props['--ex-ar'], undefined, 'nothing is claimed before the image loads');
  m.after.fire('load');
  assert.equal(m.root.style.props['--ex-ar'], '1600 / 1000');
});

test('an image that loads with no dimensions leaves the CSS default in place', () => {
  const m = mount();
  m.after.naturalWidth = 0;
  m.after.naturalHeight = 0;
  m.api.show('blob:before', 'data:after');
  m.after.fire('load');
  assert.equal(m.root.style.props['--ex-ar'], undefined, 'a 0/0 ratio would collapse the box');
});
