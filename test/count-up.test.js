// Tier: pure frontend logic — public/scripts/count-up.js.
//
// Covers the hero-stat counter's number/width math. The visible invariant the
// animation depends on is that the pill NEVER clips the number and NEVER overshoots
// its final width: smoothWidthCh must stay wide enough for the displayed digits,
// rise monotonically, and clamp to the final length. The module's IIFE assigns
// window.StagifyHeroStats at import time, so we stub `window` before importing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {};
const { format, widthForText, lenAtDecade, rampValue, smoothWidthCh } = await import('../public/scripts/count-up.js');

test('format rounds and groups like the displayed value', () => {
  assert.equal(format(0), '0');
  assert.equal(format(9.8), '10', 'rounds to the displayed digits');
  assert.equal(format(1234.6), '1,235');
  assert.equal(format(1000000), '1,000,000');
});

test('widthForText counts characters and floors at 1ch', () => {
  assert.equal(widthForText('1,235'), '5ch');
  assert.equal(widthForText(''), '1ch');
  assert.equal(widthForText('7'), '1ch');
});

test('lenAtDecade is the grouped length of 10^exp', () => {
  assert.equal(lenAtDecade(0), 1);   // "1"
  assert.equal(lenAtDecade(2), 3);   // "100"
  assert.equal(lenAtDecade(3), 5);   // "1,000"
  assert.equal(lenAtDecade(5), 7);   // "100,000"
});

test('rampValue eases from 0 to the target', () => {
  assert.equal(rampValue(100, 0), 0, 'starts at 0');
  assert.equal(rampValue(100, 1), 100, 'ends exactly on target');
  assert.equal(rampValue(100, 0.5), 87.5, 'cubic ease-out: 100*(1-0.5^3)');
  // Monotonically increasing across the ramp.
  let prev = -1;
  for (let t = 0; t <= 1.0001; t += 0.1) {
    const v = rampValue(100, t);
    assert.ok(v >= prev, `ramp non-decreasing at t=${t.toFixed(1)}`);
    prev = v;
  }
});

test('smoothWidthCh clamps to the final length and never overshoots', () => {
  assert.equal(smoothWidthCh(100, 1), 1, 'clamped down to finalLen');
  assert.equal(smoothWidthCh(999999, 3), 3, 'a huge value never exceeds finalLen');
  // At an exact decade the width equals that decade's grouped length.
  assert.equal(smoothWidthCh(100, 10), 3);
  assert.equal(smoothWidthCh(1000, 10), 5);
});

test('smoothWidthCh floors at 1ch for sub-1 values', () => {
  assert.equal(smoothWidthCh(0.4, 5), 1, 'rounds to 0 → treated as 1 → width 1');
  assert.equal(smoothWidthCh(1, 5), 1);
});

test('smoothWidthCh rises monotonically as the value climbs (no clipping mid-count)', () => {
  const finalLen = lenAtDecade(6); // room to grow toward a 7-figure target
  let prev = -1;
  for (const v of [1, 5, 50, 500, 5000, 50000, 500000, 1000000]) {
    const w = smoothWidthCh(v, finalLen);
    assert.ok(w >= prev, `width non-decreasing at value ${v} (got ${w}, prev ${prev})`);
    // Width must always reserve at least the displayed digit count.
    assert.ok(w >= lenAtDecade(Math.floor(Math.log10(Math.max(Math.round(v), 1)))) - 1e-9,
      `width covers the digits of ${v}`);
    prev = w;
  }
});
