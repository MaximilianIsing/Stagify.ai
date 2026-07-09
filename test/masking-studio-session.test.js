// Unit tests for the pure Masking Studio session-persistence helpers extracted
// into public/scripts/masking-studio/session.js (layer ⇄ stored-object
// projection + restorability guard). No DOM / IndexedDB, so they run directly
// under node --test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  serializeLayer,
  serializeSession,
  deserializeLayer,
  isRestorableSession,
} from '../public/scripts/masking-studio/session.js';
import { createLayer } from '../public/scripts/masking-studio/layers.js';

// A live-ish layer as the entry holds it: the persisted fields plus the runtime
// bits (canvas, candidates, status) that must NOT survive to storage.
function liveLayer(overrides = {}) {
  return {
    colorIdx: 2,
    name: 'Kitchen',
    prompt: 'a cozy sofa',
    mode: 'stage',
    furniture: { ref: 'x' },
    furnitureName: 'sofa.png',
    painted: true,
    // runtime-only — deliberately dropped on serialize:
    canvasEl: { tag: 'canvas' },
    status: 'done',
    candidates: ['a', 'b'],
    editedImg: {},
    ...overrides,
  };
}

test('serializeLayer: keeps only the persisted fields + mask, drops runtime state', () => {
  const blob = { size: 1 };
  const out = serializeLayer(liveLayer(), blob);
  assert.deepEqual(out, {
    colorIdx: 2,
    name: 'Kitchen',
    prompt: 'a cozy sofa',
    mode: 'stage',
    furniture: { ref: 'x' },
    furnitureName: 'sofa.png',
    painted: true,
    mask: blob,
  });
  // No runtime leakage.
  assert.equal('canvasEl' in out, false);
  assert.equal('status' in out, false);
  assert.equal('candidates' in out, false);
});

test('serializeLayer: an unpainted layer stores no mask even if a blob is passed', () => {
  const out = serializeLayer(liveLayer({ painted: false }), { size: 99 });
  assert.equal(out.painted, false);
  assert.equal(out.mask, null);
});

test('serializeSession: wraps base blob + layers with the supplied savedAt', () => {
  const baseBlob = { size: 10 };
  const layers = [{ colorIdx: 0 }];
  assert.deepEqual(serializeSession(baseBlob, layers, 1234), {
    savedAt: 1234,
    baseBlob: baseBlob,
    layers: layers,
  });
});

test('serialize → deserialize round-trips the persisted fields', () => {
  const canvasEl = { tag: 'canvas' };
  const stored = serializeLayer(liveLayer(), { size: 1 });
  const back = deserializeLayer(stored, { id: 'L7', canvasEl, painted: true, paletteLength: 6 });
  assert.equal(back.id, 'L7');
  assert.equal(back.canvasEl, canvasEl);
  assert.equal(back.colorIdx, 2);
  assert.equal(back.name, 'Kitchen');
  assert.equal(back.prompt, 'a cozy sofa');
  assert.equal(back.mode, 'stage');
  assert.deepEqual(back.furniture, { ref: 'x' });
  assert.equal(back.furnitureName, 'sofa.png');
  assert.equal(back.painted, true);
});

test('deserializeLayer: yields the full default layer shape (via createLayer)', () => {
  const back = deserializeLayer({}, { id: 'L1', canvasEl: null, painted: false, paletteLength: 6 });
  const template = createLayer({ id: 'L1', colorIdx: 0, canvasEl: null });
  // Every key createLayer stamps must be present after a restore too.
  assert.deepEqual(Object.keys(back).sort(), Object.keys(template).sort());
  assert.equal(back.status, 'idle');
  assert.equal(back.candIdx, 0);
  assert.deepEqual(back.candidates, []);
  assert.equal(back.el, null);
});

test('deserializeLayer: clamps a stored colorIdx into the current palette', () => {
  // Palette shrank since the save (index 5 no longer exists).
  assert.equal(deserializeLayer({ colorIdx: 5 }, { id: 'L1', canvasEl: null, painted: false, paletteLength: 3 }).colorIdx, 2);
  // Negative / garbage floors to 0.
  assert.equal(deserializeLayer({ colorIdx: -4 }, { id: 'L1', canvasEl: null, painted: false, paletteLength: 6 }).colorIdx, 0);
  assert.equal(deserializeLayer({ colorIdx: undefined }, { id: 'L1', canvasEl: null, painted: false, paletteLength: 6 }).colorIdx, 0);
});

test('deserializeLayer: normalizes mode — only "remove" survives, everything else is "stage"', () => {
  const base = { id: 'L1', canvasEl: null, painted: false, paletteLength: 6 };
  assert.equal(deserializeLayer({ mode: 'remove' }, base).mode, 'remove');
  assert.equal(deserializeLayer({ mode: 'stage' }, base).mode, 'stage');
  assert.equal(deserializeLayer({ mode: 'bogus' }, base).mode, 'stage');
  assert.equal(deserializeLayer({}, base).mode, 'stage');
});

test('deserializeLayer: missing/legacy string fields fall back to empty, furniture to null', () => {
  const back = deserializeLayer({ colorIdx: 1 }, { id: 'L1', canvasEl: null, painted: false, paletteLength: 6 });
  assert.equal(back.name, '');
  assert.equal(back.prompt, '');
  assert.equal(back.furniture, null);
  assert.equal(back.furnitureName, '');
});

test('deserializeLayer: painted is taken from the caller (mask-decode result), not the stored flag', () => {
  const base = { id: 'L1', canvasEl: null, paletteLength: 6 };
  // Stored says painted but the mask failed to decode → not painted.
  assert.equal(deserializeLayer({ painted: true }, { ...base, painted: false }).painted, false);
  assert.equal(deserializeLayer({ painted: false }, { ...base, painted: true }).painted, true);
});

test('isRestorableSession: needs a base photo blob', () => {
  assert.equal(isRestorableSession({ baseBlob: { size: 1 }, layers: [] }), true);
  assert.equal(isRestorableSession({ baseBlob: null }), false);
  assert.equal(isRestorableSession({}), false);
  assert.equal(isRestorableSession(null), false);
  assert.equal(isRestorableSession(undefined), false);
});
