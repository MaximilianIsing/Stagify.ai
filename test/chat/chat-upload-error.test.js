// buildUnsupportedFileErrorBody (lib/chat/chat-upload-error.js) — the pure builder
// behind the /api/chat-upload catch block. Given the request's uploaded files it
// filters for the formats the pipeline can't handle (AVIF + any non-whitelisted
// image/*) and produces the user-facing error body, or null when nothing is
// unsupported (so the caller falls through to a generic 500). No I/O.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUnsupportedFileErrorBody, resolveUploadErrorBody } from '../../lib/chat/chat-upload-error.js';
import { logger } from '../../lib/logger.js';

const file = (originalname, mimetype) => ({ originalname, mimetype });

test('returns null when every file is a supported type', () => {
  const files = [file('room.jpg', 'image/jpeg'), file('plan.pdf', 'application/pdf'), file('notes.txt', 'text/plain')];
  assert.equal(buildUnsupportedFileErrorBody(files), null);
});

test('returns null for an empty upload list', () => {
  assert.equal(buildUnsupportedFileErrorBody([]), null);
});

test('flags AVIF by extension and by mime type as "AVIF"', () => {
  const byExt = buildUnsupportedFileErrorBody([file('shot.avif', 'application/octet-stream')]);
  const byMime = buildUnsupportedFileErrorBody([file('shot.bin', 'image/avif')]);
  assert.match(byExt.response, /this file type: AVIF/);
  assert.match(byMime.response, /this file type: AVIF/);
  assert.deepEqual(byExt.files, [{ name: 'shot.avif', type: 'application/octet-stream' }]);
  assert.deepEqual(byExt.memories, { stores: [], forgets: [] });
});

test('flags a non-whitelisted image/* type using its uppercased extension', () => {
  const body = buildUnsupportedFileErrorBody([file('scan.bmp', 'image/bmp')]);
  assert.match(body.response, /this file type: BMP/);
  assert.equal(body.files[0].type, 'image/bmp');
});

test('deduplicates types and pluralizes the message for multiple unsupported files', () => {
  const body = buildUnsupportedFileErrorBody([
    file('a.avif', 'image/avif'),
    file('b.avif', 'image/avif'),
    file('c.bmp', 'image/bmp'),
  ]);
  assert.match(body.response, /these file types: AVIF, BMP/, 'unique types, plural phrasing');
  assert.match(body.response, /convert these files/);
  assert.equal(body.files.length, 3, 'every offending file is listed');
});

test('ignores supported files while still reporting the unsupported ones', () => {
  const body = buildUnsupportedFileErrorBody([file('room.png', 'image/png'), file('bad.avif', 'image/avif')]);
  assert.match(body.response, /this file type: AVIF/);
  assert.equal(body.files.length, 1);
  assert.equal(body.files[0].name, 'bad.avif');
});

// ── resolveUploadErrorBody ──────────────────────────────────────────────────
// The catch block's whole decision, not just the builder: the "does this error
// smell like a file-type problem?" sniff, the req.files shape coercion, and the
// swallow-and-log guard. Returning null means "fall through to the generic 500",
// which is the branch a bug here would silently steal.
const openai = { chat: {} };

test('answers with the friendly body when an unsupported file is present', () => {
  const body = resolveUploadErrorBody({
    error: new Error('boom'),
    reqFiles: [file('bad.avif', 'image/avif')],
    openai,
  });
  assert.match(body.response, /this file type: AVIF/);
});

test('falls through (null) when the files are all supported', () => {
  assert.equal(
    resolveUploadErrorBody({ error: new Error('boom'), reqFiles: [file('room.png', 'image/png')], openai }),
    null,
  );
});

test('a file-type-flavoured error with no files still attempts the body, and falls through', () => {
  // isFileTypeError opens the branch; with no files the builder returns null and
  // the caller reaches its generic 500.
  for (const msg of ['unsupported image', 'bad FORMAT', 'avif not allowed', 'IMAGE decode failed']) {
    assert.equal(resolveUploadErrorBody({ error: new Error(msg), reqFiles: [], openai }), null);
  }
});

test('no OpenAI client configured: never attempts the friendly body', () => {
  assert.equal(
    resolveUploadErrorBody({ error: new Error('boom'), reqFiles: [file('bad.avif', 'image/avif')], openai: null }),
    null,
  );
});

test('the map-shaped .fields() fallback is coerced, not spread', () => {
  // A non-array req.files is wrapped in a single-element array; it has no
  // originalname, so the builder throws and the guard swallows it.
  const origError = logger.error;
  /** @type {any[][]} */
  const logged = [];
  logger.error = (...args) => { logged.push(args); };
  try {
    assert.equal(
      resolveUploadErrorBody({ error: new Error('boom'), reqFiles: { files: [] }, openai }),
      null,
    );
  } finally {
    logger.error = origError;
  }
  assert.equal(logged.length, 1, 'the failure is logged, not propagated');
});

test('a non-Error throw does not break the sniff', () => {
  assert.equal(resolveUploadErrorBody({ error: 'just a string', reqFiles: [], openai }), null);
});

test('no files at all and an unrelated error falls through', () => {
  assert.equal(resolveUploadErrorBody({ error: new Error('ECONNRESET'), reqFiles: undefined, openai }), null);
});
