// Tier: pure frontend logic — public/scripts/heic-convert.js.
//
// Covers the two pure exports the browser's HEIC pipeline relies on:
//   - sniff(bytes): identifies an image by its real leading bytes (magic numbers +
//     ISO-BMFF `ftyp` brand), so a mislabeled file (JPEG saved as ".heic") is not
//     needlessly run through the 1.3 MB converter,
//   - isHeic(file): the by-type / by-extension predicate that decides whether the
//     converter is invoked at all.
// The module's IIFE assigns window.StagifyHeic at import time, so we stub `window`
// before importing (the functions under test touch neither window nor document).

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {};
const { sniff, isHeic } = await import('../public/scripts/heic-convert.js');

// Build a >=12-byte Uint8Array from ascii strings and/or raw byte numbers.
function bytes(...parts) {
  const out = [];
  for (const p of parts) {
    if (typeof p === 'string') for (const ch of p) out.push(ch.charCodeAt(0));
    else out.push(p);
  }
  while (out.length < 12) out.push(0);
  return new Uint8Array(out);
}
// A 4-byte fake box size, so `ftyp` lands at offset 4 and the brand at offset 8.
const SIZE = [0x00, 0x00, 0x00, 0x18];

test('sniff identifies raster formats by their magic bytes', () => {
  assert.equal(sniff(bytes(0xFF, 0xD8, 0xFF, 0xE0)), 'jpeg');
  assert.equal(sniff(bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A)), 'png');
  assert.equal(sniff(bytes('GIF89a')), 'gif');
  assert.equal(sniff(bytes('RIFF', 0, 0, 0, 0, 'WEBP')), 'webp');
});

test('sniff reads the ISO-BMFF ftyp brand for AVIF vs HEIC', () => {
  assert.equal(sniff(bytes(...SIZE, 'ftyp', 'avif')), 'avif');
  assert.equal(sniff(bytes(...SIZE, 'ftyp', 'heic')), 'heic');
  assert.equal(sniff(bytes(...SIZE, 'ftyp', 'mif1')), 'heic');
  // An unrecognized brand inside an ftyp box still falls back to heic so the
  // converter gets a chance rather than the pipeline rejecting a real image.
  assert.equal(sniff(bytes(...SIZE, 'ftyp', 'qt  ')), 'heic');
});

test('sniff returns null for too-short buffers and unknown content', () => {
  assert.equal(sniff(new Uint8Array([0xFF, 0xD8, 0xFF])), null, 'under 12 bytes → null');
  assert.equal(sniff(null), null);
  assert.equal(sniff(bytes(0x00, 0x01, 0x02, 0x03, 0x04)), null, 'no known signature → null');
});

test('sniff trusts content over extension (a JPEG named .heic still sniffs jpeg)', () => {
  assert.equal(sniff(bytes(0xFF, 0xD8, 0xFF, 0xE1, 0x12, 0x34)), 'jpeg');
});

test('isHeic detects HEIC/HEIF by MIME type', () => {
  assert.equal(isHeic({ type: 'image/heic' }), true);
  assert.equal(isHeic({ type: 'image/heif-sequence' }), true);
  assert.equal(isHeic({ type: 'IMAGE/HEIC' }), true, 'type match is case-insensitive');
});

test('isHeic falls back to the extension only for empty/generic types', () => {
  assert.equal(isHeic({ type: '', name: 'photo.HEIC' }), true, 'empty type + .heic name');
  assert.equal(isHeic({ type: 'application/octet-stream', name: 'x.heif' }), true);
  // A file the browser positively typed as JPEG is never treated as HEIC, even
  // with a misleading .heic name — the real type wins.
  assert.equal(isHeic({ type: 'image/jpeg', name: 'x.heic' }), false);
  assert.equal(isHeic({ type: '', name: 'photo.png' }), false);
});

test('isHeic is null-safe', () => {
  assert.equal(isHeic(null), false);
  assert.equal(isHeic(undefined), false);
});
