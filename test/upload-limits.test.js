// Tier 2 — multer upload size caps + the error path.
//
// Uploads use multer.memoryStorage(), so every file is buffered whole in RAM; the
// per-uploader fileSize caps bound that (protects a small instance from OOM). A
// too-large upload must be rejected with a clean 413 — this also guards a real
// regression: the multer error handler must sit AFTER the routers that use multer,
// or these surface as a raw 500 instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

const MB = 1024 * 1024;

function fileForm(field, bytes, type, name) {
  const fd = new FormData();
  fd.append(field, new Blob([Buffer.alloc(bytes)], { type }), name);
  return fd;
}

async function postForm(base, path, fd) {
  const r = await fetch(base + path, { method: 'POST', body: fd });
  return r.status;
}

test('over-cap uploads are rejected with a clean 413', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  // Each cap: process-image 25MB, chat-upload 20MB. A file just over must 413.
  assert.equal(await postForm(srv.baseUrl, '/api/process-image', fileForm('image', 26 * MB, 'image/png', 'b.png')), 413);
  assert.equal(await postForm(srv.baseUrl, '/api/chat-upload', fileForm('files', 21 * MB, 'image/png', 'b.png')), 413);
});

test('within-cap uploads pass the size gate (not 413)', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  // A tiny file is accepted by multer, then rejected downstream (auth/invalid image),
  // but never as "too large".
  const status = await postForm(srv.baseUrl, '/api/process-image', fileForm('image', 64 * 1024, 'image/png', 's.png'));
  assert.notEqual(status, 413, `small upload should not 413 (got ${status})`);
});
