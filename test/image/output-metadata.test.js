// lib/image/output-metadata.js — Stagify provenance EXIF/XMP embedding. Verified against
// real sharp-encoded images (no mocks): decode the output and assert the actual metadata
// bytes are present, on every format the app delivers (WebP, PNG, JPEG).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  withDisclosureMetadata,
  STAGIFY_SOFTWARE_TAG,
  STAGIFY_ARTIST_TAG,
  DIGITAL_SOURCE_TYPE,
  DISCLOSURE_DESCRIPTIONS,
} from '../../lib/image/output-metadata.js';

const solid = (w = 20, h = 20) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 120, b: 200 } } });

function assertTagged(m, mode) {
  assert.ok(m.exif, 'EXIF block present');
  const exifText = m.exif.toString('latin1');
  assert.ok(exifText.includes(STAGIFY_SOFTWARE_TAG), 'EXIF Software tag present');
  assert.ok(exifText.includes(DISCLOSURE_DESCRIPTIONS[mode]), 'EXIF ImageDescription matches mode');
  assert.ok(exifText.includes(STAGIFY_ARTIST_TAG), 'EXIF Artist tag present');
  assert.ok(m.xmp, 'XMP block present');
  const xmpText = m.xmp.toString('utf8');
  assert.ok(xmpText.includes(DIGITAL_SOURCE_TYPE), 'XMP DigitalSourceType present');
  assert.ok(xmpText.includes(DISCLOSURE_DESCRIPTIONS[mode]), 'XMP dc:description matches mode');
  assert.ok(xmpText.includes(STAGIFY_SOFTWARE_TAG), 'XMP xmp:CreatorTool present');
}

test('withDisclosureMetadata: rejects an unknown mode', () => {
  assert.throws(() => withDisclosureMetadata(solid(), { mode: 'bogus' }), /mode must be/);
});

test('withDisclosureMetadata: WebP output carries EXIF + XMP for mode "staged"', async () => {
  const out = await withDisclosureMetadata(solid(), { mode: 'staged' }).webp().toBuffer();
  const m = await sharp(out).metadata();
  assert.equal(m.format, 'webp');
  assertTagged(m, 'staged');
});

test('withDisclosureMetadata: PNG output carries EXIF + XMP identically (no format special-casing)', async () => {
  const out = await withDisclosureMetadata(solid(), { mode: 'staged' }).png().toBuffer();
  const m = await sharp(out).metadata();
  assert.equal(m.format, 'png');
  assertTagged(m, 'staged');
});

test('withDisclosureMetadata: JPEG output carries EXIF + XMP identically', async () => {
  const out = await withDisclosureMetadata(solid(), { mode: 'staged' }).jpeg().toBuffer();
  const m = await sharp(out).metadata();
  assert.equal(m.format, 'jpeg');
  assertTagged(m, 'staged');
});

test('withDisclosureMetadata: mode "edited" uses the mask-edit wording, not the staging wording', async () => {
  const out = await withDisclosureMetadata(solid(), { mode: 'edited' }).webp().toBuffer();
  const m = await sharp(out).metadata();
  assertTagged(m, 'edited');
  const exifText = m.exif.toString('latin1');
  assert.ok(!exifText.includes(DISCLOSURE_DESCRIPTIONS.staged), '"edited" mode must not carry the "staged" description');
});

test('withDisclosureMetadata: mergeExif keeps a pre-existing EXIF tag alongside the added Software tag', async () => {
  const withSourceExif = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .withExif({ IFD0: { Make: 'SourceCameraCo' } })
    .jpeg()
    .toBuffer();
  const out = await withDisclosureMetadata(sharp(withSourceExif), { mode: 'staged', mergeExif: true })
    .jpeg()
    .toBuffer();
  const m = await sharp(out).metadata();
  const exifText = m.exif.toString('latin1');
  assert.ok(exifText.includes('SourceCameraCo'), 'source EXIF (Make) survives withExifMerge');
  assert.ok(exifText.includes(STAGIFY_SOFTWARE_TAG), 'added Software tag survives alongside it');
});

test('withDisclosureMetadata: mergeExif:false (default) replaces rather than merges', async () => {
  const withSourceExif = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .withExif({ IFD0: { Make: 'SourceCameraCo' } })
    .jpeg()
    .toBuffer();
  const out = await withDisclosureMetadata(sharp(withSourceExif), { mode: 'staged' }).jpeg().toBuffer();
  const m = await sharp(out).metadata();
  const exifText = m.exif.toString('latin1');
  assert.ok(!exifText.includes('SourceCameraCo'), 'plain withExif replaces wholesale, source Make is dropped');
  assert.ok(exifText.includes(STAGIFY_SOFTWARE_TAG));
});
