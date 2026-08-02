// Tier 2 — multer upload size caps + the error path.
//
// Uploads use multer.memoryStorage(), so every file is buffered whole in RAM; the
// per-uploader fileSize caps bound that (protects a small instance from OOM). A
// too-large upload must be rejected with a clean 413 — this also guards a real
// regression: the multer error handler must sit AFTER the routers that use multer,
// or these surface as a raw 500 instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.js';

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

// The two RAM-exhaustion controls on chatUpload that nothing covered. Both live on
// memoryStorage, so both bound how much a single request can buffer, and both were
// silently deletable: test/helpers/chat-app.js builds its OWN limit-free multer
// ("the same shape as lib/http/uploads.js, minus the production size limits"), so
// the route tests never saw them, and the size test above only exercises fileSize.

test('the max-count on /api/chat-upload is enforced, not just documented', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  // .array('files', 5): a sixth file must be refused. Unbounded, 20MB x N is the
  // whole RAM ceiling — the per-file cap alone does not bound a request.
  const fd = new FormData();
  for (let i = 0; i < 6; i += 1) {
    fd.append('files', new Blob([Buffer.alloc(1024)], { type: 'image/png' }), `f${i}.png`);
  }
  // Only LIMIT_FILE_SIZE maps to 413 (server.js); every other MulterError is a 400
  // carrying its own code, so that is what an over-count actually looks like.
  const res = await fetch(`${srv.baseUrl}/api/chat-upload`, { method: 'POST', body: fd });
  const body = await res.json();
  assert.equal(res.status, 400, `a 6th file must be refused (got ${res.status})`);
  assert.equal(body.code, 'LIMIT_UNEXPECTED_FILE', `refused for the right reason: ${JSON.stringify(body)}`);

  // And exactly five must NOT be refused for being too many — it fails later, on
  // auth, which is what makes the assertion above about the count and not about
  // uploads failing in general.
  const ok = new FormData();
  for (let i = 0; i < 5; i += 1) {
    ok.append('files', new Blob([Buffer.alloc(1024)], { type: 'image/png' }), `f${i}.png`);
  }
  const okRes = await fetch(`${srv.baseUrl}/api/chat-upload`, { method: 'POST', body: ok });
  const okBody = await okRes.json().catch(() => ({}));
  assert.notEqual(okBody.code, 'LIMIT_UNEXPECTED_FILE', 'five files is within the cap');
});

test('the non-file field cap on /api/chat-upload is enforced', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  // fieldSize: 25MB guards `conversationHistory`, which carries base64 images and is
  // a TEXT field — fileSize does not apply to it at all, so without this cap one
  // request could buffer an unbounded string.
  const over = new FormData();
  over.append('files', new Blob([Buffer.alloc(1024)], { type: 'image/png' }), 'a.png');
  over.append('conversationHistory', 'x'.repeat(26 * MB));
  const res = await fetch(`${srv.baseUrl}/api/chat-upload`, { method: 'POST', body: over });
  const body = await res.json();
  assert.equal(res.status, 400, `a 26MB text field must be refused (got ${res.status})`);
  assert.equal(body.code, 'LIMIT_FIELD_VALUE', `refused for the right reason: ${JSON.stringify(body)}`);

  // The cap has to be pinned from BELOW as well, and that is the assertion with
  // teeth: busboy's DEFAULT fieldSize is 1MB, so simply deleting the explicit 25MB
  // makes the limit stricter, not looser — the over-cap check above passes either
  // way. A 5MB history is a realistic conversation carrying base64 images, and it
  // must go through; with the line removed it is rejected LIMIT_FIELD_VALUE.
  const under = new FormData();
  under.append('files', new Blob([Buffer.alloc(1024)], { type: 'image/png' }), 'a.png');
  under.append('conversationHistory', 'x'.repeat(5 * MB));
  const okRes = await fetch(`${srv.baseUrl}/api/chat-upload`, { method: 'POST', body: under });
  const okBody = await okRes.json().catch(() => ({}));
  assert.notEqual(
    okBody.code,
    'LIMIT_FIELD_VALUE',
    'a 5MB history must fit — the explicit 25MB cap is what allows it over busboy\'s 1MB default',
  );
});
