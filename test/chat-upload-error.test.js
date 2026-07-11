// buildUnsupportedFileErrorBody (lib/chat/chat-upload-error.js) — the pure builder
// behind the /api/chat-upload catch block. Given the request's uploaded files it
// filters for the formats the pipeline can't handle (AVIF + any non-whitelisted
// image/*) and produces the user-facing error body, or null when nothing is
// unsupported (so the caller falls through to a generic 500). No I/O.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUnsupportedFileErrorBody } from '../lib/chat/chat-upload-error.js';

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
