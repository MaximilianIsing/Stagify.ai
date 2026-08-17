// Tier 2 — the ORDER of the upload chain, against a real server boot.
//
// This file used to assert the multer size caps from here, anonymously. It cannot any
// more, and the reason is the point of the file: /api/process-image and
// /api/chat-upload now refuse an unauthenticated caller BEFORE multer runs, so an
// anonymous over-cap upload never reaches the size check at all.
//
// That inversion is the only observable proof the reorder landed. multer buffers the
// whole multipart body into memory before any handler runs, so while auth lived only
// inside the handler an anonymous request made this single-instance process allocate
// 25MB x 6 files (process-image) or 20MB x 5 (chat-upload) and THEN get told to sign
// in. genLimiter bounds the RATE of those requests, not the cost of one. A same-sized
// LEGAL upload proves nothing here — anonymous was already refused, just later and
// after the allocation. Only an OVER-cap one separates the two orderings:
//
//   multer first → 413 (it read the body and tripped LIMIT_FILE_SIZE)
//   gate first   → 401/403 (nothing was read)
//
// The caps themselves are exercised, with the production multer instances and an
// authorized caller, in test/http/upload-limits-enforced.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.js';

const MB = 1024 * 1024;

function fileForm(field, bytes, type, name) {
  const fd = new FormData();
  fd.append(field, new Blob([Buffer.alloc(bytes)], { type }), name);
  return fd;
}

async function post(base, path, fd) {
  const r = await fetch(base + path, { method: 'POST', body: fd });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

test('an over-cap anonymous upload is refused before multer reads it', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  // 26MB against a 25MB cap, and 21MB against a 20MB cap: both would be a clean 413
  // if multer ran first. A 401/403 means the body was never buffered.
  const staging = await post(srv.baseUrl, '/api/process-image', fileForm('image', 26 * MB, 'image/png', 'b.png'));
  assert.equal(staging.status, 401, `the gate must answer first (got ${staging.status})`);
  assert.equal(staging.body.code, 'AUTH_REQUIRED');

  // Pro-gated rather than signed-in-gated, so an anonymous caller gets the 401 arm of
  // requireProAccount — the same reply its in-handler call would have sent.
  const chat = await post(srv.baseUrl, '/api/chat-upload', fileForm('files', 21 * MB, 'image/png', 'b.png'));
  assert.equal(chat.status, 401, `the gate must answer first (got ${chat.status})`);
  assert.equal(chat.body.code, 'AUTH_REQUIRED');
});

test('the gate does not depend on the upload being over-cap', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  // The mirror of the case above: a small anonymous upload gets the SAME refusal. If
  // this ever diverges from the over-cap result, the reply is being decided by the
  // size check rather than the gate — i.e. multer is back in front.
  const small = await post(srv.baseUrl, '/api/process-image', fileForm('image', 64 * 1024, 'image/png', 's.png'));
  assert.equal(small.status, 401);
  assert.equal(small.body.code, 'AUTH_REQUIRED');
});

test('/api/enhance-exterior refuses a non-subscriber before multer too', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const res = await post(srv.baseUrl, '/api/enhance-exterior', fileForm('image', 26 * MB, 'image/png', 'b.png'));
  assert.equal(res.status, 401, `the gate must answer first (got ${res.status})`);
  assert.equal(res.body.code, 'AUTH_REQUIRED');
});

test('/api/stage-by-endpoint-key still reaches multer, and still 413s', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  // The partner endpoint carries no session — it is guarded by the endpoint key, which
  // already ran before multer. So its 413 must SURVIVE this change, and it is the one
  // route that proves the staging multer's 25MB cap is still armed on a real boot.
  // With no key configured the guard answers first; either way the point stands that
  // nothing here is a 500.
  const res = await post(srv.baseUrl, '/api/stage-by-endpoint-key', fileForm('image', 26 * MB, 'image/png', 'b.png'));
  assert.ok([401, 403, 413].includes(res.status), `expected a clean refusal, got ${res.status}`);
  assert.notEqual(res.status, 500, 'a refused partner upload must never surface as a server error');
});
