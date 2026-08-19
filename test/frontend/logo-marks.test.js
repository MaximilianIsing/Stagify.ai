// Tier: served-asset drift — to-build/media-png/logo/** vs public/media-webp/logo/**.
//
// The product marks: the small badges beside a plan name (Pro64x64 on the Stagify+ card,
// Enterprise64x64 on the enterprise hero, Api64x64 for the developer API). Each ships as a
// WebP exported by hand from a PNG master in to-build/, which to-build/README.md documents
// as the one-way arrow `media-png/logo/** -> the favicons + logo images in public/`.
//
// WHY THIS GUARD EXISTS. A master added without its export is invisible: nothing imports
// to-build/, so a grep finds no references either way, and the missing WebP only surfaces
// as a broken image the first time somebody wires the mark into a page. That is exactly
// how the API marks sat unexported — the PNGs were added, the WebPs were not, and the
// omission was caught by eye rather than by anything here.
//
// The size in the filename is load-bearing (a `<link rel="icon" sizes="32x32">` and an
// `<img width="18">` both trust it), so it is asserted against the actual pixels rather
// than taken on trust.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MASTERS = path.join(ROOT, 'to-build', 'media-png', 'logo');
const SERVED = path.join(ROOT, 'public', 'media-webp', 'logo');

/**
 * The `*-full.png` masters are deliberately NOT served — they are the full-resolution
 * artwork the sized marks are cut from, and no page references one. Excluded by suffix
 * rather than by an allowlist of names so a future `foo-full.png` needs no edit here.
 */
const isFullArtwork = (name) => /-full\.png$/i.test(name);

const masters = fs.readdirSync(MASTERS).filter((f) => f.endsWith('.png'));

test('the logo folder still holds masters, so the sweep cannot pass vacuously', () => {
  assert.ok(masters.length >= 8, `expected the logo masters, found ${masters.length}`);
  assert.ok(masters.some(isFullArtwork), 'the -full artwork is gone — has the layout changed?');
  assert.ok(masters.some((f) => !isFullArtwork(f)), 'no sized masters found');
});

test('every sized logo master has a served WebP counterpart', () => {
  const missing = masters
    .filter((f) => !isFullArtwork(f))
    .map((f) => f.replace(/\.png$/i, '.webp'))
    .filter((webp) => !fs.existsSync(path.join(SERVED, webp)));

  assert.deepEqual(
    missing,
    [],
    'a PNG master was added without exporting its WebP. Export at quality 90 to match the '
    + 'existing marks (the photo scripts use 78, which is too lossy for a 32px badge) — see '
    + 'to-build/README.md.',
  );
});

test('no served mark is an orphan without a master to re-export from', () => {
  // The reverse direction. A WebP with no PNG behind it cannot be recropped or recoloured
  // later, which is the whole reason to-build/ exists.
  const served = fs.readdirSync(SERVED).filter((f) => f.endsWith('.webp'));
  const orphans = served.filter((f) => !fs.existsSync(path.join(MASTERS, f.replace(/\.webp$/i, '.png'))));
  assert.deepEqual(orphans, [], 'a served mark has no PNG master in to-build/media-png/logo');
});

test('a mark is the size its filename claims', async () => {
  // `<link rel="icon" sizes="32x32">` and `<img width="18" height="18">` both trust the
  // name. A 64px file called 32x32 is a silent, permanent mismatch.
  const served = fs.readdirSync(SERVED).filter((f) => /(\d+)x(\d+)\.webp$/i.test(f));
  assert.ok(served.length >= 8, `expected the sized marks, found ${served.length}`);

  for (const file of served) {
    const [, w, h] = file.match(/(\d+)x(\d+)\.webp$/i);
    const meta = await sharp(path.join(SERVED, file)).metadata();
    assert.equal(meta.width, Number(w), `${file} is ${meta.width}px wide`);
    assert.equal(meta.height, Number(h), `${file} is ${meta.height}px tall`);
    // These sit on coloured cards and page backgrounds; a flattened mark would show its
    // own rectangle. Every existing one carries alpha, and a new one must too.
    assert.equal(meta.hasAlpha, true, `${file} lost its transparency in export`);
  }
});
