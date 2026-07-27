// Tier: frontend island logic (window/Image-stubbed) — public/scripts/app/download-menu.js.
//
// The caret beside "Download Result" offers the staged result at several sizes.
// Three things in there are quiet failures — they never throw, they just hand the
// user the wrong thing — so the assertions target those:
//
//  1. READINESS. An unsized <canvas> reports the HTML default 300x150, NOT 0, so the
//     obvious `canvas.width > 0` check reads "ready" on a blank page. That shipped
//     once: the download control was live (and would emit a 300x150 JPEG of nothing)
//     before anything had been staged.
//  2. ASPECT RATIO. "Original" matches the upload's LONG EDGE, not both dimensions,
//     because the staged output's ratio is a snapped Gemini bucket that can differ
//     from the upload's. Matching both would silently stretch the room.
//  3. THE PROBE NEVER HANGING. Row building awaits the original's dimensions; the
//     first implementation used img.decode(), which never settles while the tab is
//     backgrounded, so the menu would simply never open — no error, no menu.
//
// Only construction touches the DOM, and every element access is guarded, so the
// pure exports are imported directly and `Image` is stubbed per-test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {};

const {
  canvasIsReady,
  buildSizeRows,
  rowLabelText,
  probeDimensions,
  MULTIPLIERS,
} = await import('../public/scripts/app/download-menu.js');

// A canvas stub: `attrs` mirrors the content attributes, which is what separates
// "never sized" from "sized to N" — the IDL width alone cannot.
const fakeCanvas = ({ widthAttr, width, height = 832 }) => ({
  hasAttribute: (name) => name === 'width' && widthAttr !== undefined,
  width,
  height,
});

const LABELS = { original: 'Original', native: 'native' };

// ── readiness ──────────────────────────────────────────────────────────────────

test('an unsized canvas is NOT ready even though it reports 300x150', () => {
  // The exact regression: no width attribute, but the HTML default is a truthy 300.
  const canvas = fakeCanvas({ widthAttr: undefined, width: 300, height: 150 });
  assert.equal(canvas.width > 0, true, 'the naive check would pass here');
  assert.equal(canvasIsReady(canvas), false, 'so readiness must not use it');
});

test('a staged canvas is ready', () => {
  assert.equal(canvasIsReady(fakeCanvas({ widthAttr: '1248', width: 1248 })), true);
});

test('a reset canvas (width assigned 0) is not ready', () => {
  assert.equal(canvasIsReady(fakeCanvas({ widthAttr: '0', width: 0, height: 0 })), false);
});

test('a missing canvas is not ready rather than throwing', () => {
  assert.equal(canvasIsReady(null), false);
  assert.equal(canvasIsReady(undefined), false);
});

// ── row maths ──────────────────────────────────────────────────────────────────

test('rows are Original first, then each multiplier', () => {
  const rows = buildSizeRows(1248, 832, { width: 4032, height: 2688 }, LABELS);
  assert.deepEqual(rows.map((r) => r.label), ['Original', '2×', '1×', '0.5×']);
  assert.equal(rows.length, MULTIPLIERS.length + 1);
});

test('multipliers scale both dimensions off the staged result', () => {
  const rows = buildSizeRows(1248, 832, null, LABELS);
  assert.deepEqual(
    rows.map((r) => `${r.width}x${r.height}`),
    ['2496x1664', '1248x832', '624x416']
  );
});

test('only the 1x row is marked native', () => {
  const rows = buildSizeRows(1248, 832, null, LABELS);
  assert.deepEqual(rows.map((r) => r.note), ['', 'native', '']);
  const native = rows.filter((r) => r.note === 'native');
  assert.equal(native.length, 1);
  assert.equal(native[0].label, '1×');
  assert.deepEqual([native[0].width, native[0].height], [1248, 832],
    'native must be the untouched staged size');
});

test('Original matches the upload when the aspect ratios already agree', () => {
  // 4032x2688 and 1248x832 are both 3:2.
  const [original] = buildSizeRows(1248, 832, { width: 4032, height: 2688 }, LABELS);
  assert.deepEqual([original.width, original.height], [4032, 2688]);
});

test('Original preserves the OUTPUT ratio rather than stretching to the upload', () => {
  // Upload is 4:3, staged output is 3:2 — the snapped-bucket mismatch.
  const [original] = buildSizeRows(1248, 832, { width: 4000, height: 3000 }, LABELS);
  assert.equal(original.width, 4000, 'long edge matches the upload');
  assert.notEqual(original.height, 3000, 'but the short edge must NOT be forced');
  assert.equal(original.height, 2667);
  const staged = 1248 / 832;
  assert.ok(
    Math.abs(original.width / original.height - staged) < 0.001,
    'the staged aspect ratio survives, so the room is never distorted'
  );
});

test('Original handles a portrait upload by its long edge too', () => {
  const [original] = buildSizeRows(832, 1248, { width: 2000, height: 3000 }, LABELS);
  assert.equal(original.height, 3000);
  assert.equal(original.width, 2000);
});

test('an upload smaller than the staged result still yields whole pixels', () => {
  const [original] = buildSizeRows(1248, 832, { width: 4, height: 3 }, LABELS);
  assert.ok(Number.isInteger(original.width) && original.width >= 1);
  assert.ok(Number.isInteger(original.height) && original.height >= 1);
});

test('an unmeasurable original drops only its row, never the menu', () => {
  const rows = buildSizeRows(1248, 832, null, LABELS);
  assert.deepEqual(rows.map((r) => r.label), ['2×', '1×', '0.5×']);
});

test('a zero-sized canvas yields no rows at all', () => {
  assert.deepEqual(buildSizeRows(0, 0, { width: 100, height: 100 }, LABELS), []);
});

test('row labels parenthesise the note', () => {
  assert.equal(rowLabelText({ label: '1×', note: 'native' }), '1× (native)');
  assert.equal(rowLabelText({ label: '2×', note: '' }), '2×');
});

// ── the probe ──────────────────────────────────────────────────────────────────

/** Install a stub `Image` whose behaviour is chosen per test; returns a restore fn. */
function stubImage(behaviour) {
  const prev = globalThis.Image;
  globalThis.Image = class {
    set src(value) {
      this._src = value;
      behaviour(this);
    }
    get src() { return this._src; }
  };
  return () => { globalThis.Image = prev; };
}

test('probeDimensions resolves the natural size on load', async () => {
  const restore = stubImage((img) => {
    img.naturalWidth = 4032;
    img.naturalHeight = 2688;
    setImmediate(() => img.onload());
  });
  try {
    assert.deepEqual(await probeDimensions('data:image/jpeg;base64,x'), {
      width: 4032, height: 2688,
    });
  } finally { restore(); }
});

test('probeDimensions resolves null on error instead of rejecting', async () => {
  const restore = stubImage((img) => setImmediate(() => img.onerror()));
  try {
    assert.equal(await probeDimensions('not-an-image'), null);
  } finally { restore(); }
});

test('probeDimensions resolves null for a zero-sized image', async () => {
  const restore = stubImage((img) => {
    img.naturalWidth = 0;
    img.naturalHeight = 0;
    setImmediate(() => img.onload());
  });
  try {
    assert.equal(await probeDimensions('data:image/gif;base64,x'), null);
  } finally { restore(); }
});

test('probeDimensions times out instead of hanging forever', async () => {
  // The decode()-in-a-backgrounded-tab case: neither callback ever fires. Without
  // the timeout the caller awaits forever and the menu never opens.
  const restore = stubImage(() => { /* never settles */ });
  try {
    const started = Date.now();
    assert.equal(await probeDimensions('data:image/jpeg;base64,x', 25), null);
    assert.ok(Date.now() - started >= 20, 'waited for the timeout rather than returning early');
  } finally { restore(); }
});

test('probeDimensions short-circuits an empty source without constructing an Image', async () => {
  let constructed = false;
  const restore = stubImage(() => { constructed = true; });
  try {
    assert.equal(await probeDimensions(''), null);
    assert.equal(constructed, false);
  } finally { restore(); }
});

test('a late callback after the timeout cannot re-resolve the promise', async () => {
  let captured = null;
  const restore = stubImage((img) => { captured = img; });
  try {
    const result = await probeDimensions('data:image/jpeg;base64,x', 20);
    assert.equal(result, null);
    // Fire the load that arrived too late; nothing should throw or change.
    captured.naturalWidth = 10;
    captured.naturalHeight = 10;
    assert.doesNotThrow(() => captured.onload());
  } finally { restore(); }
});
