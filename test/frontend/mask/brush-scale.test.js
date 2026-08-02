// Unit tests for the brush's relative size scale (public/scripts/mask/brush-scale.js).
//
// The brush used to be a pixel count with a fixed 20-150 slider, while the mask
// canvases are sized to the source photo — which is never downscaled on the
// client. So the same slider position meant 15% of a 1024px image and 3.7% of a
// 4032px phone photo, and at the top of its range the brush was a thin line on
// exactly the photos that needed broad strokes.
//
// These pin the two things that make the replacement worth having: a step is the
// same share of every photo, and the top of the range is genuinely large. The
// stroke-level consequences are covered in mask-brush.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRUSH_STEP_MIN,
  BRUSH_STEP_MAX,
  BRUSH_STEP_DEFAULT,
  brushFraction,
  brushPx,
} from '../../../public/scripts/mask/brush-scale.js';

const STEPS = Array.from(
  { length: BRUSH_STEP_MAX - BRUSH_STEP_MIN + 1 },
  (_, i) => BRUSH_STEP_MIN + i,
);

const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

test('the ends of the slider are exactly 1% and 15% of the long edge', () => {
  assert.ok(close(brushFraction(BRUSH_STEP_MIN), 0.01), `min was ${brushFraction(BRUSH_STEP_MIN)}`);
  assert.ok(close(brushFraction(BRUSH_STEP_MAX), 0.15), `max was ${brushFraction(BRUSH_STEP_MAX)}`);
});

test('every step is larger than the one before it', () => {
  for (let i = 1; i < STEPS.length; i++) {
    const prev = brushFraction(STEPS[i - 1]);
    const cur = brushFraction(STEPS[i]);
    assert.ok(cur > prev, `step ${STEPS[i]} (${cur}) should exceed step ${STEPS[i - 1]} (${prev})`);
  }
});

test('the scale is geometric, so the small end keeps fine control', () => {
  // A linear ramp would spend most of the slider's travel on sizes nobody drags
  // to and leave the usable small end crammed into the first notch or two. Equal
  // ratios instead of equal differences is what stops that.
  const ratios = STEPS.slice(1).map((s) => brushFraction(s) / brushFraction(s - 1));
  const first = ratios[0];
  for (const r of ratios) {
    assert.ok(close(r, first, 1e-9), `step ratios differ: ${r} vs ${first}`);
  }
  // ~20% per notch — small enough to tune with, large enough to cross the range.
  assert.ok(first > 1.15 && first < 1.25, `unexpected per-step ratio ${first}`);
});

test('the default step reproduces the 50px brush this control shipped with', () => {
  // Anchored at the resolution the server actually generates at (1920x1080), so
  // the default still feels like what users had. Changing the range must not
  // quietly move the default out from under them.
  assert.equal(brushPx(BRUSH_STEP_DEFAULT, 1920, 1080), 47);
});

test('the widest brush is far wider than the old fixed cap on a big photo', () => {
  // The actual complaint: 150px was the maximum on every photo, which on a phone
  // photo covered 3.7% of the frame.
  assert.ok(brushPx(BRUSH_STEP_MAX, 4032, 3024) > 500, 'a phone photo gets a genuinely broad brush');
  assert.equal(brushPx(BRUSH_STEP_MAX, 4032, 3024), 605);
  assert.equal(brushPx(BRUSH_STEP_MAX, 1920, 1080), 288);
});

test('a step is the same share of the photo whatever its resolution', () => {
  for (const step of STEPS) {
    const small = brushPx(step, 1024, 768) / 1024;
    const large = brushPx(step, 4096, 3072) / 4096;
    assert.ok(
      Math.abs(small - large) < 0.001,
      `step ${step} covers ${small} of a small photo but ${large} of a large one`,
    );
  }
});

test('the long edge drives the size, not the width', () => {
  // A portrait photo and its landscape rotation must take the same brush, or the
  // same step would behave differently the moment someone turned their phone.
  assert.equal(brushPx(10, 3024, 4032), brushPx(10, 4032, 3024));
});

test('a tiny photo takes the pixel floor instead of an invisible stroke', () => {
  // 1% of a 300px thumbnail is 3px, which all but disappears under the mask's
  // own antialiasing. The floor is the one place the scale stops being relative.
  assert.equal(brushPx(BRUSH_STEP_MIN, 300, 200), 6);
  assert.ok(brushPx(BRUSH_STEP_MAX, 300, 200) > 6, 'but the top of the range still scales');
});

test('steps outside the range clamp rather than escaping the scale', () => {
  // The Masking Studio's [ and ] shortcuts set the step directly, so nothing
  // upstream guarantees the input's min/max was applied.
  assert.equal(brushFraction(0), brushFraction(BRUSH_STEP_MIN));
  assert.equal(brushFraction(-99), brushFraction(BRUSH_STEP_MIN));
  assert.equal(brushFraction(BRUSH_STEP_MAX + 1), brushFraction(BRUSH_STEP_MAX));
  assert.equal(brushFraction(9999), brushFraction(BRUSH_STEP_MAX));
});

test('a garbage step falls back to the smallest rather than producing NaN', () => {
  // parseInt on an empty slider value yields NaN; a NaN lineWidth silently paints
  // nothing, which reads as "the brush broke" rather than "the brush is small".
  assert.equal(brushFraction(NaN), brushFraction(BRUSH_STEP_MIN));
  assert.equal(brushPx(NaN, 1920, 1080), brushPx(BRUSH_STEP_MIN, 1920, 1080));
  assert.ok(Number.isFinite(brushPx(NaN, 1920, 1080)));
});

test('a canvas with no dimensions yet returns the floor, not zero or NaN', () => {
  // The editors resolve the width live from the canvas, which is 0x0 until a
  // photo is loaded into it.
  assert.equal(brushPx(BRUSH_STEP_DEFAULT, 0, 0), 6);
  assert.ok(Number.isFinite(brushPx(BRUSH_STEP_DEFAULT, undefined, undefined)));
});

test('every step yields a whole number of pixels', () => {
  // ctx.lineWidth accepts fractions, but a fractional diameter puts a half-covered
  // pixel on both edges of every stroke and softens the mask for no benefit.
  for (const step of STEPS) {
    const px = brushPx(step, 1920, 1080);
    assert.equal(px, Math.round(px), `step ${step} produced ${px}`);
  }
});
