// Tier: frontend pure helpers (no DOM) — public/scripts/pdf-page-to-image.js.
//
// Floor plans arrive as PDFs, and the server has never been able to read one:
// lib/chat/chat-upload-prep.js accepts application/pdf and reduces it to the literal
// placeholder "[File: plan.pdf, Type: application/pdf - Content cannot be directly
// read]", so it never becomes an image and can never reach blueprintTo3D — while the
// homepage, the AI Designer's welcome message and all 11 language packs promised exactly
// that. The fix rasterizes page 1 in the BROWSER, the same way heic-convert.js handles
// the other format the pipeline cannot read.
//
// The rendering itself needs pdf.js and a canvas, so it is exercised by the e2e/manual
// pass. What is unit-tested here is the part that decides WHETHER to rasterize and at
// WHAT scale — the two places a wrong answer is silent:
//
//   - isPdf/sniffPdf wrong in one direction sends a real image to the PDF renderer; wrong
//     in the other leaves a genuine plan as the unreadable placeholder, which is the
//     original bug.
//   - scaleForPage too low loses the dimension text the model reads off the drawing; too
//     high builds a canvas that blows the 25MB upload cap from an architectural sheet.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isPdf, sniffPdf, scaleForPage } from '../../public/scripts/pdf-page-to-image.js';

// ── isPdf ────────────────────────────────────────────────────────────────────

test('isPdf: recognises the PDF mime types', () => {
  assert.equal(isPdf({ type: 'application/pdf', name: 'plan.pdf' }), true);
  assert.equal(isPdf({ type: 'application/x-pdf', name: 'plan.pdf' }), true);
  assert.equal(isPdf({ type: 'APPLICATION/PDF', name: 'plan.pdf' }), true, 'case-insensitive');
});

test('isPdf: falls back to the extension when the browser reports no type', () => {
  // Some browsers report an empty or generic type for a dragged file.
  assert.equal(isPdf({ type: '', name: 'floor-plan.pdf' }), true);
  assert.equal(isPdf({ type: 'application/octet-stream', name: 'floor-plan.PDF' }), true);
});

test('isPdf: leaves images alone', () => {
  assert.equal(isPdf({ type: 'image/png', name: 'plan.png' }), false);
  assert.equal(isPdf({ type: 'image/jpeg', name: 'room.jpg' }), false);
  // A real JPEG that merely has a generic type is NOT claimed on its extension.
  assert.equal(isPdf({ type: 'application/octet-stream', name: 'room.jpg' }), false);
});

test('isPdf: is safe on missing/garbage input', () => {
  assert.equal(isPdf(null), false);
  assert.equal(isPdf(undefined), false);
  assert.equal(isPdf({}), false);
});

// ── sniffPdf ─────────────────────────────────────────────────────────────────
//
// Content wins over the filename, for the same reason heic-convert.js sniffs: files lie
// about their extension, and a PNG named .pdf handed to the PDF renderer just throws.

const bytes = (...b) => new Uint8Array(b);
const PDF_MAGIC = bytes(0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x37); // "%PDF-1.7"
const PNG_MAGIC = bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A);

test('sniffPdf: accepts the %PDF- signature', () => {
  assert.equal(sniffPdf(PDF_MAGIC), true);
});

test('sniffPdf: rejects a PNG wearing a .pdf name', () => {
  assert.equal(sniffPdf(PNG_MAGIC), false);
});

test('sniffPdf: rejects truncated or missing headers rather than guessing', () => {
  assert.equal(sniffPdf(bytes(0x25, 0x50)), false, 'too short to decide');
  assert.equal(sniffPdf(null), false);
  assert.equal(sniffPdf(undefined), false);
  assert.equal(sniffPdf(bytes()), false);
});

// ── scaleForPage ─────────────────────────────────────────────────────────────

test('scaleForPage: enlarges a small page toward the 2000px target', () => {
  // A US-Letter page at 72dpi is 612x792; its long edge needs ~2.53x.
  const scale = scaleForPage(612, 792);
  assert.ok(scale > 2.5 && scale < 2.6, `expected ~2.53, got ${scale}`);
  assert.ok(792 * scale > 1900, 'the long edge lands near the target');
});

test('scaleForPage: measures the LONG edge, whatever the orientation', () => {
  // A plan is as often landscape as portrait; both must reach the same long edge.
  assert.equal(scaleForPage(792, 612), scaleForPage(612, 792));
});

test('scaleForPage: never shrinks a page that is already large enough', () => {
  // An architectural E-size sheet is already far past the target. Rendering it at <1
  // would throw away the dimension text the whole rasterization exists to preserve —
  // but rendering at 1 is the ceiling, not an invitation to go bigger.
  assert.equal(scaleForPage(2448, 3168), 1);
  assert.equal(scaleForPage(10000, 8000), 1);
});

test('scaleForPage: clamps the enlargement so a tiny page cannot explode the canvas', () => {
  // A 10x10 page would otherwise want 200x, i.e. a 2000x2000 canvas from a page holding
  // no detail at all. Enlarging invents nothing; it only costs bytes.
  assert.equal(scaleForPage(10, 10), 4);
});

test('scaleForPage: falls back to 1 for a degenerate page', () => {
  assert.equal(scaleForPage(0, 0), 1);
  assert.equal(scaleForPage(undefined, undefined), 1);
});
