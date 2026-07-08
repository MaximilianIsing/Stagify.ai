// Multer fileFilter configs (lib/http/uploads.js). These three filters are the
// upload gatekeepers for the whole app: they decide, per file, whether multer
// accepts the bytes into memoryStorage or rejects the request. They are pure —
// (req, file, cb) in, a single cb(err, accept) out, no I/O — so we exercise them
// directly with hand-rolled fakes and never touch multer's request pipeline,
// disk, network, or any model/store.
//
// Why each filter matters:
//  - imageFileFilter        → the room/furniture staging uploads. Only the four
//                             raster types the pipeline can actually process.
//  - pdfFileFilter          → floor-plan uploads. Accepts by MIME *or* by .pdf
//                             extension, because some clients mislabel PDFs as
//                             application/octet-stream.
//  - hostedImageFileFilter  → admin public image hosting. SECURITY-CRITICAL: it
//                             must reject image/svg+xml. A hosted SVG executes
//                             script on our own origin (stored XSS), so the SVG
//                             rejection below is the point of the whole filter,
//                             not an incidental case. It accepts exactly the keys
//                             of HOSTED_IMAGE_MIME_EXT and nothing else.
//
// HOSTED_IMAGE_MIME_EXT is the mime→extension map routes/admin.js uses to name
// the file on save; we pin the exact mapping so a drifted extension (or a newly
// allowed type) trips a test.
//
// Every assertion below was checked against the ACTUAL source — the accept sets,
// the exact Error message strings, and the map values are all verbatim from
// lib/http/uploads.js, not assumed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  imageFileFilter,
  pdfFileFilter,
  hostedImageFileFilter,
  HOSTED_IMAGE_MIME_EXT,
} from '../lib/http/uploads.js';

// Invoke a multer fileFilter with a fake file and capture how it called back.
// Returns { accepted, error } where error is the Error's message (or null when
// the filter accepted). The req arg is unused by every filter, so we pass {}.
function runFilter(filter, { mimetype, originalname } = {}) {
  let accepted = false;
  let error = null;
  filter({}, { mimetype, originalname }, (err, accept) => {
    if (err) {
      error = err instanceof Error ? err.message : String(err);
    } else {
      accepted = accept === true;
    }
  });
  return { accepted, error };
}

// ── imageFileFilter ─────────────────────────────────────────────────────────

test('imageFileFilter accepts the four processable raster types (jpeg, jpg, png, webp)', () => {
  for (const mimetype of ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']) {
    const r = runFilter(imageFileFilter, { mimetype, originalname: 'room.img' });
    assert.deepEqual(r, { accepted: true, error: null }, `${mimetype} should be accepted`);
  }
});

test('imageFileFilter rejects svg, gif, pdf, and octet-stream with the PNG/JPG/JPEG/WebP message', () => {
  for (const mimetype of ['image/svg+xml', 'image/gif', 'application/pdf', 'application/octet-stream']) {
    const r = runFilter(imageFileFilter, { mimetype, originalname: 'x' });
    assert.equal(r.accepted, false, `${mimetype} must not be accepted`);
    assert.equal(r.error, 'Only PNG, JPG, JPEG, and WebP files are allowed', `${mimetype} error string`);
  }
});

// ── pdfFileFilter ───────────────────────────────────────────────────────────

test('pdfFileFilter accepts a real application/pdf MIME type', () => {
  const r = runFilter(pdfFileFilter, { mimetype: 'application/pdf', originalname: 'floorplan.pdf' });
  assert.deepEqual(r, { accepted: true, error: null });
});

test('pdfFileFilter accepts by .pdf extension (case-insensitive) even when MIME is octet-stream', () => {
  // Some clients send application/octet-stream for PDFs; the .pdf tail rescues them.
  const r = runFilter(pdfFileFilter, { mimetype: 'application/octet-stream', originalname: 'plan.PDF' });
  assert.deepEqual(r, { accepted: true, error: null }, 'uppercase .PDF extension should still pass');
});

test('pdfFileFilter accepts application/pdf even when the filename has no .pdf extension (MIME-only branch)', () => {
  // Isolates the first OR-branch: MIME says PDF, the filename does NOT end in .pdf.
  const r = runFilter(pdfFileFilter, { mimetype: 'application/pdf', originalname: 'document' });
  assert.deepEqual(r, { accepted: true, error: null });
});

test('pdfFileFilter rejects a text/plain notes.txt with the "Only PDF files are allowed" message', () => {
  const r = runFilter(pdfFileFilter, { mimetype: 'text/plain', originalname: 'notes.txt' });
  assert.equal(r.accepted, false);
  assert.equal(r.error, 'Only PDF files are allowed');
});

// ── hostedImageFileFilter ───────────────────────────────────────────────────

test('hostedImageFileFilter accepts exactly the keys of HOSTED_IMAGE_MIME_EXT', () => {
  for (const mimetype of Object.keys(HOSTED_IMAGE_MIME_EXT)) {
    const r = runFilter(hostedImageFileFilter, { mimetype, originalname: 'pic' });
    assert.deepEqual(r, { accepted: true, error: null }, `${mimetype} is an allowed hosted type`);
  }
});

test('hostedImageFileFilter REJECTS image/svg+xml — a hosted SVG could run script on our origin', () => {
  // This is the security reason the filter exists: SVG is never hostable.
  const r = runFilter(hostedImageFileFilter, { mimetype: 'image/svg+xml', originalname: 'evil.svg' });
  assert.equal(r.accepted, false, 'SVG must be rejected');
  assert.equal(r.error, 'Only PNG, JPG, WebP, and GIF images can be hosted');
});

test('hostedImageFileFilter rejects other non-allowlisted types (bmp, tiff, pdf) with the same message', () => {
  for (const mimetype of ['image/bmp', 'image/tiff', 'application/pdf']) {
    const r = runFilter(hostedImageFileFilter, { mimetype, originalname: 'x' });
    assert.equal(r.accepted, false, `${mimetype} must not be hostable`);
    assert.equal(r.error, 'Only PNG, JPG, WebP, and GIF images can be hosted', `${mimetype} error string`);
  }
});

// ── HOSTED_IMAGE_MIME_EXT ───────────────────────────────────────────────────

test('HOSTED_IMAGE_MIME_EXT maps each allowed MIME type to its exact file extension', () => {
  assert.deepEqual(HOSTED_IMAGE_MIME_EXT, {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  });
});
