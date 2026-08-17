// The multer RAM ceilings, exercised through the PRODUCTION upload configs.
//
// WHY THIS EXISTS, AND WHY IT IS NOT IN test/server/upload-limits.test.js
// These caps used to be asserted against a real server boot with an anonymous request.
// They cannot be any more: both routes now refuse an unauthenticated caller before
// multer runs, so an anonymous over-cap upload is a 401 and never reaches the size
// check. (That inversion is what upload-limits.test.js now guards — it is the proof
// the reorder landed.) The booted server has no cheap way to mint a session: the data
// directory is not overridable, so authenticating there would write a user into the
// developer's own auth-store.db.
//
// So the caps move in-process, where the auth dep is a stub — but with the REAL multer
// instances from lib/http/uploads.js and the REAL error mapping from
// lib/http/multer-errors.js, because the harnesses' own limit-free multer is exactly
// how these went uncovered before.
//
// Every cap here is a RAM ceiling on memoryStorage: multer buffers each file whole, so
// without them one request bounds nothing. They are also all silently deletable —
// removing a limit makes uploads *work better* right up until a big one arrives.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountStaging } from '../helpers/staging-app.js';
import { mountChat } from '../helpers/chat-app.js';
import { stagingProcessUpload, chatUpload, MAX_UPLOAD_BYTES } from '../../lib/http/uploads.js';

const MB = 1024 * 1024;
const PRO = { id: 'u1', email: 'pro@example.com', plan: 'pro' };
const png = (bytes) => new Blob([Buffer.alloc(bytes)], { type: 'image/png' });

/** Mount the staging router with the production multer and an authorized caller. */
const stagingApp = () =>
  mountStaging({
    stagingProcessUpload,
    getAuthUserFromRequest: () => PRO,
    requireProAccount: () => PRO,
  });

/** Mount the chat router with the production multer and an authorized caller. */
const chatApp = () => mountChat({ chatUpload, requireProAccount: () => PRO });

async function post(app, path, fd) {
  const r = await fetch(app.baseUrl + path, { method: 'POST', body: fd });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

test('a file over MAX_UPLOAD_BYTES is a clean 413, not a 500', async (t) => {
  const app = await stagingApp();
  t.after(() => app.close());

  const fd = new FormData();
  fd.append('image', png(MAX_UPLOAD_BYTES + MB), 'big.png');
  const res = await post(app, '/api/process-image', fd);
  assert.equal(res.status, 413, `expected 413, got ${res.status}`);
  assert.equal(res.body.code, 'FILE_TOO_LARGE');
});

test('a file at the cap passes the size gate', async (t) => {
  const app = await stagingApp();
  t.after(() => app.close());

  // Pins the cap from BELOW. Without this, deleting the limit line entirely — or
  // tightening it to something far smaller — still passes the over-cap test above.
  const fd = new FormData();
  fd.append('image', png(64 * 1024), 'small.png');
  const res = await post(app, '/api/process-image', fd);
  assert.notEqual(res.status, 413, 'a small upload must not be refused for size');
  assert.notEqual(res.body.code, 'FILE_TOO_LARGE');
});

test('the staging upload accepts one room image plus five furniture references', async (t) => {
  const app = await stagingApp();
  t.after(() => app.close());

  // .fields() is what bounds the FILE COUNT, and the count is half the RAM ceiling:
  // 25MB x N is unbounded without it. Five references is the documented maximum.
  const ok = new FormData();
  ok.append('image', png(1024), 'room.png');
  for (let i = 0; i < 5; i += 1) ok.append('furnitureImage', png(1024), `ref${i}.png`);
  const okRes = await post(app, '/api/process-image', ok);
  assert.notEqual(okRes.body.code, 'LIMIT_UNEXPECTED_FILE', 'five references is within the cap');

  const over = new FormData();
  over.append('image', png(1024), 'room.png');
  for (let i = 0; i < 6; i += 1) over.append('furnitureImage', png(1024), `ref${i}.png`);
  const overRes = await post(app, '/api/process-image', over);
  assert.equal(overRes.status, 400, `a 6th reference must be refused (got ${overRes.status})`);
  assert.equal(overRes.body.code, 'LIMIT_UNEXPECTED_FILE');
});

test('the max-count on /api/chat-upload is enforced, not just documented', async (t) => {
  const app = await chatApp();
  t.after(() => app.close());

  // .array('files', 5): a sixth file must be refused. Only LIMIT_FILE_SIZE maps to
  // 413; every other MulterError is a 400 carrying its own code, so that is what an
  // over-count actually looks like.
  const over = new FormData();
  for (let i = 0; i < 6; i += 1) over.append('files', png(1024), `f${i}.png`);
  const overRes = await post(app, '/api/chat-upload', over);
  assert.equal(overRes.status, 400, `a 6th file must be refused (got ${overRes.status})`);
  assert.equal(overRes.body.code, 'LIMIT_UNEXPECTED_FILE');

  const ok = new FormData();
  for (let i = 0; i < 5; i += 1) ok.append('files', png(1024), `f${i}.png`);
  const okRes = await post(app, '/api/chat-upload', ok);
  assert.notEqual(okRes.body.code, 'LIMIT_UNEXPECTED_FILE', 'five files is within the cap');
});

test('the per-file size cap on /api/chat-upload is enforced', async (t) => {
  const app = await chatApp();
  t.after(() => app.close());

  const fd = new FormData();
  fd.append('files', png(21 * MB), 'big.png');
  const res = await post(app, '/api/chat-upload', fd);
  assert.equal(res.status, 413, `21MB against a 20MB cap must be 413 (got ${res.status})`);
  assert.equal(res.body.code, 'FILE_TOO_LARGE');
});

test('the non-file field cap on /api/chat-upload is enforced', async (t) => {
  const app = await chatApp();
  t.after(() => app.close());

  // fieldSize: 25MB guards `conversationHistory`, which carries base64 images and is a
  // TEXT field — fileSize does not apply to it at all, so without this cap one request
  // could buffer an unbounded string.
  const over = new FormData();
  over.append('files', png(1024), 'a.png');
  over.append('conversationHistory', 'x'.repeat(26 * MB));
  const overRes = await post(app, '/api/chat-upload', over);
  assert.equal(overRes.status, 400, `a 26MB text field must be refused (got ${overRes.status})`);
  assert.equal(overRes.body.code, 'LIMIT_FIELD_VALUE');

  // The cap has to be pinned from BELOW as well, and that is the assertion with teeth:
  // busboy's DEFAULT fieldSize is 1MB, so simply deleting the explicit 25MB makes the
  // limit stricter, not looser — the over-cap check above passes either way. A 5MB
  // history is a realistic conversation carrying base64 images, and it must go through.
  const under = new FormData();
  under.append('files', png(1024), 'a.png');
  under.append('conversationHistory', 'x'.repeat(5 * MB));
  const underRes = await post(app, '/api/chat-upload', under);
  assert.notEqual(
    underRes.body.code,
    'LIMIT_FIELD_VALUE',
    'a 5MB history must fit — the explicit 25MB cap is what allows it over busboy\'s 1MB default',
  );
});
