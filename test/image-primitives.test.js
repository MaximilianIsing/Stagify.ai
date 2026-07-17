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
  upscaleForDelivery,
  nearestGeminiAspectRatio,
  cropToAspectRatio,
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

test('nearestGeminiAspectRatio: snaps to the nearest supported ratio (log-symmetric)', () => {
  assert.equal(nearestGeminiAspectRatio(1500, 1000).label, '3:2', 'exact 3:2');
  assert.equal(nearestGeminiAspectRatio(1600, 900).label, '16:9', 'exact 16:9');
  assert.equal(nearestGeminiAspectRatio(1024, 1024).label, '1:1', 'square');
  assert.equal(nearestGeminiAspectRatio(1200, 1000).label, '5:4', '1.20 → 5:4 (1.25) is nearest');
  assert.equal(nearestGeminiAspectRatio(1000, 1500).label, '2:3', 'portrait snaps to a portrait bucket');
  assert.equal(nearestGeminiAspectRatio(1080, 1920).label, '9:16', 'tall portrait (exact 9:16)');
  assert.equal(nearestGeminiAspectRatio(0, 100), null, 'missing dimension → null');
});

test('cropToAspectRatio: no-op within tolerance, centered cover-crop past it, fail-open', async () => {
  // An HONORED bucket (1344×768 = 1.75 vs 16:9 = 1.778, ~1.6% off) is left untouched —
  // this is what stops repeated round-trips from slowly zooming in.
  const honored = await png(1344, 768);
  assert.equal(await cropToAspectRatio(honored, 16 / 9), honored, 'honored bucket → identity (same reference)');

  // A clear IGNORE (square output, target 3:2) → crop the excess height, keep the width,
  // no stretch. 1200×1200 → 1200×800.
  const square = await png(1200, 1200);
  const cropped = await cropToAspectRatio(square, 1.5);
  const cm = await meta(cropped);
  assert.equal(cm.width, 1200, 'width kept (crop, not resize)');
  assert.equal(cm.height, 800, 'height cropped to width / 1.5');
  assert.equal(cm.format, 'png');

  // Too-wide ignore → crop the sides instead. 2000×800 (2.5) target 1:1 → 800×800.
  const wide = await png(2000, 800);
  const wm = await meta(await cropToAspectRatio(wide, 1));
  assert.equal(wm.width, 800, 'width cropped to height × 1');
  assert.equal(wm.height, 800, 'height kept');

  // Non-finite / zero target → passthrough.
  assert.equal(await cropToAspectRatio(square, 0), square, 'zero target → identity');

  // Undecodable buffer → fail-open to the input rather than throwing.
  const garbage = Buffer.from('not-an-image');
  assert.equal(await cropToAspectRatio(garbage, 1.5), garbage, 'fail-open on decode error');
});

test('pin + crop is a stable fixed point — no AR drift across repeated round-trips', async () => {
  // The bug this fix closes: iterative staging (download → re-upload → stage again) let a
  // tiny per-round AR wobble compound into a visible stretch. With the ratio pinned, an
  // honored output is a fixed bucket, so re-snapping + the (no-op) crop leave the shape
  // EXACTLY constant round after round. Model here always returns 2.5's honored "3:2"
  // bucket (1248×832); assert 8 rounds don't move a pixel.
  let buf = await png(1248, 832);
  for (let i = 0; i < 8; i++) {
    const m = await meta(buf);
    const pin = nearestGeminiAspectRatio(m.width, m.height);
    assert.equal(pin.label, '3:2', 'stays snapped to the same bucket every round');
    buf = await cropToAspectRatio(buf, pin.ratio);
  }
  const fm = await meta(buf);
  assert.equal(fm.width, 1248, 'width unchanged after 8 round-trips');
  assert.equal(fm.height, 832, 'height unchanged after 8 round-trips (no compounding stretch)');
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

test('upscaleForDelivery: enlarges the model output ×2 as WebP, caps the long edge, and fails open', async () => {
  // ~1 MP-ish PNG (what the flash model returns) → doubled, delivered as WebP.
  const src = `data:image/png;base64,${(await png(800, 600)).toString('base64')}`;
  const out = await upscaleForDelivery(src);
  assert.match(out, /^data:image\/webp;base64,/, 'delivered as WebP, not PNG');
  const om = await meta(Buffer.from(out.split(',')[1], 'base64'));
  assert.equal(om.width, 1600, 'width doubled');
  assert.equal(om.height, 1200, 'height doubled');
  assert.equal(om.format, 'webp');

  // A large input whose ×2 would blow past the 4096 cap is only scaled up to the cap.
  const bigUrl = `data:image/png;base64,${(await png(3000, 1500)).toString('base64')}`;
  const capped = await upscaleForDelivery(bigUrl);
  const cm = await meta(Buffer.from(capped.split(',')[1], 'base64'));
  assert.ok(Math.max(cm.width, cm.height) <= 4096, 'long edge never exceeds the cap');
  assert.ok(cm.width > 3000, 'still enlarged toward the cap');

  // Already at the cap → not enlarged, but still normalized to WebP.
  const atCapUrl = `data:image/png;base64,${(await png(4096, 1000)).toString('base64')}`;
  const capOut = await upscaleForDelivery(atCapUrl);
  assert.match(capOut, /^data:image\/webp;base64,/);
  const acm = await meta(Buffer.from(capOut.split(',')[1], 'base64'));
  assert.equal(acm.width, 4096, 'not enlarged past the cap');
  assert.equal(acm.height, 1000);

  // Non-data-URL input is returned untouched (fail-open).
  assert.equal(await upscaleForDelivery('not-a-data-url'), 'not-a-data-url');
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
