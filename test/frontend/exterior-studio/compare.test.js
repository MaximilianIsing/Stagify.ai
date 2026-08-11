// Tier: frontend island logic — public/scripts/exterior-studio/compare.js.
//
// The wipe itself is no longer this file's problem. It used to be: the studio carried its
// own control, in which the after image had to be counter-sized against a clipping wrapper
// (miss it and dragging SQUEEZED the after image instead of uncovering the before one),
// and most of this spec was arithmetic pinning that down. The studio now draws the SHARED
// control from styles/compare.css — clip-path off one `--compare-split`, the same one the
// seam and grip read — so the two halves cannot come apart by construction and there is no
// second number left to get wrong.
//
// What remains here is what stayed exterior-specific: publishing the split in both the
// shapes the stylesheet needs, and pinning the box to the RESULT's own dimensions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompare } from '../../../public/scripts/exterior-studio/compare.js';

/** A stand-in exposing just the surface the island touches. */
function el(extra = {}) {
  /** @type {Record<string, string>} */
  const props = {};
  /** @type {Record<string, string>} */
  const attrs = {};
  /** @type {Record<string, Function[]>} */
  const listeners = {};
  return {
    style: { setProperty: (k, v) => { props[k] = v; }, get props() { return props; } },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    fire: (type) => (listeners[type] || []).forEach((fn) => fn()),
    get attrs() { return { ...attrs }; },
    ...extra,
  };
}

function mount(opts = {}) {
  const root = el();
  const before = el();
  const after = el({ naturalWidth: 1600, naturalHeight: 1000 });
  const range = el({ value: '50' });
  const api = createCompare({ root, before, after, range, ...opts });
  return { api, root, before, after, range };
}

test('the widget starts at the midpoint', () => {
  const m = mount();
  assert.equal(m.root.style.props['--compare-split'], '50%');
});

test('the split is published as a percentage AND as a bare number', () => {
  // The percentage drives the clip-path and the two pseudo-elements; the number drives the
  // BEFORE/AFTER tags' fade, because CSS cannot divide a percentage back down to a ratio.
  // They are set together from one clamped value so they can never describe two positions.
  const m = mount();
  m.api.setSplit(25);
  assert.equal(m.root.style.props['--compare-split'], '25%');
  assert.equal(m.root.style.props['--compare-split-n'], '0.25');

  m.api.setSplit(80);
  assert.equal(m.root.style.props['--compare-split'], '80%');
  assert.equal(m.root.style.props['--compare-split-n'], '0.8');
});

test('both ends of the travel are reachable and exact', () => {
  // Dragging fully to one end is a normal gesture, and it is where the old control looked
  // worst — a native thumb is inset by half its own width, so it sat visibly off the seam.
  const m = mount();
  m.api.setSplit(0);
  assert.equal(m.root.style.props['--compare-split'], '0%');
  assert.equal(m.root.style.props['--compare-split-n'], '0');
  m.api.setSplit(100);
  assert.equal(m.root.style.props['--compare-split'], '100%');
  assert.equal(m.root.style.props['--compare-split-n'], '1');
});

test('out-of-range and non-numeric positions are clamped, never written raw', () => {
  const m = mount();
  m.api.setSplit(999);
  assert.equal(m.root.style.props['--compare-split'], '100%');
  m.api.setSplit(-40);
  assert.equal(m.root.style.props['--compare-split'], '0%');
  m.api.setSplit(/** @type {any} */ ('nonsense'));
  assert.equal(m.root.style.props['--compare-split'], '0%', 'NaN would drop the declaration');
});

test('dragging the range drives the wipe', () => {
  const m = mount();
  m.range.value = '30';
  m.range.fire('input');
  assert.equal(m.root.style.props['--compare-split'], '30%');
});

test('the slider says what it is showing, not just a number', () => {
  // A range with no aria-valuetext is announced as a bare "30" — no unit, and no clue
  // which half of the comparison it refers to.
  const m = mount({ valueText: (p) => `${p}% enhanced` });
  assert.equal(m.range.getAttribute('aria-valuetext'), '50% enhanced', 'set on wiring, not first drag');
  m.range.value = '30';
  m.range.fire('input');
  assert.equal(m.range.getAttribute('aria-valuetext'), '30% enhanced');
});

test('show() loads both frames and resets the slider to the middle', () => {
  const m = mount();
  m.api.setSplit(10);
  m.api.show('blob:before', 'data:image/webp;base64,AFTER');
  assert.equal(m.before.src, 'blob:before');
  assert.equal(m.after.src, 'data:image/webp;base64,AFTER');
  assert.equal(m.range.value, '50', 'a new result starts from the middle');
  assert.equal(m.root.style.props['--compare-split'], '50%');
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

test('the ratio is published as a number too, so the height cap can be a width cap', () => {
  // `max-height` on an aspect-ratio box does not shrink the box, it BREAKS the ratio and
  // leaves object-fit cropping the render. The stylesheet caps width instead —
  // `calc(70vh * --ex-ar-num)` — which needs the ratio as something calc() can multiply.
  const m = mount();
  m.api.show('blob:before', 'data:after');
  m.after.fire('load');
  assert.equal(m.root.style.props['--ex-ar-num'], '1.6');
});

test('an image that loads with no dimensions leaves the CSS default in place', () => {
  const m = mount();
  m.after.naturalWidth = 0;
  m.after.naturalHeight = 0;
  m.api.show('blob:before', 'data:after');
  m.after.fire('load');
  assert.equal(m.root.style.props['--ex-ar'], undefined, 'a 0/0 ratio would collapse the box');
  assert.equal(m.root.style.props['--ex-ar-num'], undefined, 'and NaN would drop the max-width entirely');
});
