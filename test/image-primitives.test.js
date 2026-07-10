// Sharp image transforms (lib/image-primitives.js). These are deterministic given
// their input buffers, but they sit on the staging / mask-edit hot path: a flipped
// threshold or channel index silently warps output, paints a magenta splotch into
// results, or reviews the wrong pixels. We feed real sharp-generated images and
// assert on decoded dimensions / format / actual pixel values — no fakes, no API.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  downscaleImage,
  enforceAspectRatio,
  padBufferToAspectRatio,
  buildMarkedRoomImage,
  normalizeMaskOutputToRoom,
  downscaleImageForGPT,
  compositeForReview,
  orientedDimensions,
} from '../lib/image/image-primitives.js';

// A solid-color PNG of the given size.
const png = (w, h, rgb = { r: 10, g: 120, b: 200 }) =>
  sharp({ create: { width: w, height: h, channels: 3, background: rgb } }).png().toBuffer();

// A solid-color JPEG of the given size.
const jpg = (w, h, rgb = { r: 10, g: 120, b: 200 }) =>
  sharp({ create: { width: w, height: h, channels: 3, background: rgb } }).jpeg().toBuffer();

// A black PNG with a white filled rectangle [x0,x1) × [y0,y1).
async function maskWithRect(W, H, x0, y0, x1, y1) {
  const raw = Buffer.alloc(W * H * 3, 0);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 3;
      raw[i] = raw[i + 1] = raw[i + 2] = 255;
    }
  }
  return sharp(raw, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

// Decode to RGBA with a pixel accessor.
async function pixels(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    info,
    at: (x, y) => {
      const i = (y * info.width + x) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    },
  };
}

const meta = (buf) => sharp(buf).metadata();

test('downscaleImage: an in-bounds upright JPEG is returned untouched (identity)', async () => {
  const smallJpeg = await jpg(100, 100);
  assert.equal(await downscaleImage(smallJpeg), smallJpeg, 'upright in-bounds JPEG → identity, no re-encode');
});

test('downscaleImage: an in-bounds non-JPEG is normalized to JPEG so callers can label it image/jpeg', async () => {
  // A PNG that fits the box used to pass through unchanged but was still labeled
  // image/jpeg by every caller — a MIME/content mismatch. It is now re-encoded.
  const smallPng = await png(100, 100);
  const out = await downscaleImage(smallPng);
  const m = await meta(out);
  assert.equal(m.format, 'jpeg', 'in-bounds PNG is normalized to JPEG');
  assert.equal(m.width, 100, 'dimensions preserved (no downscale needed)');
  assert.equal(m.height, 100);
});

test('downscaleImage: an oversized image is fit-resized to JPEG within 1920x1080', async () => {
  const big = await png(2400, 1350); // 0.8 scale → 1920x1080
  const out = await downscaleImage(big);
  const m = await meta(out);
  assert.equal(m.width, 1920);
  assert.equal(m.height, 1080);
  assert.equal(m.format, 'jpeg', 'downscaled output is re-encoded to JPEG');
});

test('downscaleImage: bakes in EXIF orientation (5–8 swap W/H) and clears the tag', async () => {
  // A 120×60 image tagged orientation 6 (rotate 90° CW) displays as 60×120 upright.
  const rotated = await sharp({ create: { width: 120, height: 60, channels: 3, background: { r: 10, g: 120, b: 200 } } })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const out = await downscaleImage(rotated);
  const m = await meta(out);
  assert.equal(m.width, 60, 'orientation applied → visual width');
  assert.equal(m.height, 120, 'orientation applied → visual height');
  assert.ok(!m.orientation || m.orientation === 1, 'EXIF orientation is baked in and reset to upright');
});

test('orientedDimensions: swaps W/H for EXIF orientations 5–8, passes through otherwise', () => {
  assert.deepEqual(orientedDimensions({ width: 120, height: 60, orientation: 1 }), { width: 120, height: 60 });
  assert.deepEqual(orientedDimensions({ width: 120, height: 60 }), { width: 120, height: 60 }, 'missing orientation → treated as upright');
  assert.deepEqual(orientedDimensions({ width: 120, height: 60, orientation: 6 }), { width: 60, height: 120 }, 'orientation 6 swaps');
  assert.deepEqual(orientedDimensions({ width: 120, height: 60, orientation: 8 }), { width: 60, height: 120 }, 'orientation 8 swaps');
  assert.equal(orientedDimensions(null), null);
  assert.equal(orientedDimensions({ width: 0, height: 0 }), null, 'zero dims → null');
});

test('enforceAspectRatio: no-op under tolerance, stretch-correct within cap, leave-as-is past cap', async () => {
  // drift 0 → returned unchanged (same reference).
  const square = await png(400, 400);
  assert.equal(await enforceAspectRatio(square, 400, 400), square, 'zero drift → identity');

  // ~4.8% drift (400x420 vs 1:1 target), inside the 8% cap → corrected to 400x400 PNG.
  const drifted = await png(400, 420);
  const corrected = await enforceAspectRatio(drifted, 400, 400);
  const m = await meta(corrected);
  assert.equal(m.width, 400);
  assert.equal(m.height, 400, 'height stretched back to the target ratio');
  assert.equal(m.format, 'png');

  // 50% drift (400x800 vs 1:1) exceeds the 8% cap → returned unchanged, no distortion.
  const wild = await png(400, 800);
  assert.equal(await enforceAspectRatio(wild, 400, 400), wild, 'over-cap drift → identity (no zoom/warp)');

  assert.equal(await enforceAspectRatio(square, 0, 400), square, 'missing target dim → passthrough');
});

test('padBufferToAspectRatio: grows the short side with transparent margin; respects tol and non-finite AR', async () => {
  // 100x50 (AR 2.0) into a 1:1 canvas → grow height to 100, transparent pad, PNG w/ alpha.
  const wide = await png(100, 50);
  const padded = await padBufferToAspectRatio(wide, 1.0);
  assert.equal(padded.padded, true);
  const pm = await meta(padded.buffer);
  assert.equal(pm.width, 100);
  assert.equal(pm.height, 100);
  assert.equal(pm.hasAlpha, true, 'padding is transparent → alpha channel present');

  // Too-tall case grows width instead.
  const tall = await png(50, 100);
  const paddedTall = await padBufferToAspectRatio(tall, 1.0);
  const ptm = await meta(paddedTall.buffer);
  assert.equal(ptm.width, 100);
  assert.equal(ptm.height, 100);

  // Within tolerance → no padding, original buffer returned.
  const near = await padBufferToAspectRatio(wide, 2.0, 0.02);
  assert.equal(near.padded, false);
  assert.equal(near.buffer, wide, 'AR within tol → identity');

  const nan = await padBufferToAspectRatio(wide, Number.NaN);
  assert.equal(nan.padded, false);
  assert.equal(nan.buffer, wide, 'non-finite targetAR → identity');
});

test('buildMarkedRoomImage: draws a magenta OUTLINE (not a fill) around the mask region', async () => {
  const W = 200, H = 200;
  const room = await png(W, H, { r: 0, g: 128, b: 0 }); // solid green room
  const mask = await maskWithRect(W, H, 60, 60, 140, 140); // centered white square
  const marked = await buildMarkedRoomImage(room, mask, W, H);

  const m = await meta(marked);
  assert.equal(m.width, W);
  assert.equal(m.height, H);

  const { at } = await pixels(marked);
  const isMagenta = ([r, g, b]) => r === 255 && g === 0 && b === 255;

  // A pixel just inside the mask border is magenta; the center is NOT (proves an
  // outline, not a fill); a pixel well outside the mask is untouched room green.
  assert.ok(isMagenta(at(61, 100)), 'border band is magenta');
  assert.ok(!isMagenta(at(100, 100)), 'center of the region is NOT magenta (outline, not fill)');
  const corner = at(5, 5);
  assert.deepEqual([corner[0], corner[1], corner[2]], [0, 128, 0], 'outside the mask stays room color');
});

test('compositeForReview: applies edited pixels only inside the white mask; fails open on bad input', async () => {
  const W = 64, H = 64;
  const original = await png(W, H, { r: 255, g: 0, b: 0 }); // red
  const editedBuf = await png(W, H, { r: 0, g: 0, b: 255 }); // blue
  const editedDataUrl = `data:image/png;base64,${editedBuf.toString('base64')}`;
  const mask = await maskWithRect(W, H, 0, 0, W / 2, H); // left half white

  const out = await compositeForReview(original, mask, editedDataUrl, W, H);
  assert.match(out, /^data:image\/png;base64,/);
  const { at } = await pixels(out.split(',')[1] && Buffer.from(out.split(',')[1], 'base64'));
  const [lr, lg, lb] = at(10, 32);
  const [rr, rg, rb] = at(54, 32);
  assert.deepEqual([lr, lg, lb], [0, 0, 255], 'left half (masked) shows the edited blue');
  assert.deepEqual([rr, rg, rb], [255, 0, 0], 'right half (unmasked) shows the original red');

  // Undecodable edited data URL → returns it verbatim rather than throwing.
  const bad = 'data:image/png;base64,@@@notbase64@@@';
  assert.equal(await compositeForReview(original, mask, bad, W, H), bad, 'fail-open on decode error');
});

test('normalizeMaskOutputToRoom: cover-crops a drifted AR back to room dims; passthrough when aligned', async () => {
  // 100x100 output but the room is 200x100 (AR drift 0.5) → cover-resized to 200x100.
  const square = (await png(100, 100)).toString('base64');
  const fixed = await normalizeMaskOutputToRoom(square, 200, 100);
  assert.match(fixed, /^data:image\/png;base64,/);
  const fm = await meta(Buffer.from(fixed.split(',')[1], 'base64'));
  assert.equal(fm.width, 200);
  assert.equal(fm.height, 100);

  // AR already matches → returns the original base64 wrapped, no re-encode.
  const aligned = (await png(200, 100)).toString('base64');
  assert.equal(await normalizeMaskOutputToRoom(aligned, 200, 100), `data:image/png;base64,${aligned}`);

  // Undecodable input → fail-open to the raw base64.
  assert.equal(await normalizeMaskOutputToRoom('@@@', 200, 100), 'data:image/png;base64,@@@');
});

test('downscaleImageForGPT: passes through small/non-data-url input; re-encodes large images to JPEG ≤1024', async () => {
  assert.equal(await downscaleImageForGPT('not-a-data-url'), 'not-a-data-url', 'non data-url → unchanged');

  const smallUrl = `data:image/png;base64,${(await png(512, 512)).toString('base64')}`;
  assert.equal(await downscaleImageForGPT(smallUrl), smallUrl, '≤1024 → unchanged');

  const bigUrl = `data:image/png;base64,${(await png(1500, 1500)).toString('base64')}`;
  const out = await downscaleImageForGPT(bigUrl);
  assert.match(out, /^data:image\/jpeg;base64,/, 'large PNG is re-encoded to JPEG');
  const om = await meta(Buffer.from(out.split(',')[1], 'base64'));
  assert.ok(om.width <= 1024 && om.height <= 1024, 'long side clamped to 1024');
});
