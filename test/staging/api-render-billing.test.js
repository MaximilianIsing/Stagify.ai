// Tier: unit (real credit store on a temp data dir, fake render handler) —
// lib/staging/api-render-billing.js.
//
// WHAT THIS COVERS
// The band that ties one credit to one render. The billing store is REAL here (the
// point is that the two compose correctly); only the render handler is faked, so a
// test can make it succeed, throw, or answer in-band exactly as the real one does.
//
// The cases that matter are all about money surviving a bad render:
//   - a caller with no credits is refused BEFORE the handler is invoked at all,
//   - a throw refunds, and an IN-BAND error response refunds too (the handler answers
//     the request itself, so a return value cannot be trusted),
//   - both settle paths firing on one request refunds exactly once,
//   - a delivered image is NOT refunded even though 'finish' fires,
//   - the wrapper always passes recordUsage:false and skipQualityReview:true, which is
//     what keeps enterprise metering from double-billing and one credit at one
//     generation, and
//   - the fingerprint notices a swapped photo under a reused idempotency key.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { closeDb } from '../../lib/data/db.js';
import { createApiBilling } from '../../lib/data/api-billing.js';
import { createApiRenderBilling, fingerprintRequest } from '../../lib/staging/api-render-billing.js';

const tempDirs = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-api-render-'));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop();
    try { closeDb(d); } catch { /* already closed */ }
    fs.rmSync(d, { recursive: true, force: true });
  }
});

const USER = { id: 'user_1', email: 'dev@example.com', plan: 'free' };

/** A res that really emits, because both settle paths hang off its events. */
function fakeRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.body = null;
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; res.emit('finish'); return res; };
  return res;
}

function fakeReq(over = {}) {
  return { body: { roomType: 'Bedroom' }, files: { image: [{ buffer: Buffer.from('photo') }] }, ...over };
}

/**
 * Build the band with a real store and a scripted handler.
 * @param {(req:any,res:any,meta:any)=>Promise<any>} handler
 */
function setup(handler) {
  const billing = createApiBilling(tempDir());
  const calls = [];
  const { runBilledRender } = createApiRenderBilling({
    apiBilling: billing,
    handleVirtualStagingMultipart: async (req, res, meta) => {
      calls.push({ meta });
      return handler(req, res, meta);
    },
  });
  return { billing, runBilledRender, calls };
}

const opts = (over = {}) => ({
  keyId: 'ak_1', userId: USER.id, user: USER, idempotencyKey: 'idem_1', ...over,
});

test('a successful render debits exactly one credit and is not refunded', async () => {
  const { billing, runBilledRender, calls } = setup(async (req, res) => res.status(200).json({ ok: true }));
  billing.grantCredits({ userId: USER.id, credits: 3 });

  const out = await runBilledRender(fakeReq(), fakeRes(), opts());

  assert.equal(out.outcome, 'rendered');
  assert.equal(calls.length, 1);
  assert.equal(billing.getBalance(USER.id).balance, 2, 'exactly one credit');
  assert.equal(billing.getRequest(out.requestId).status, 'succeeded');
});

test('zero balance is refused BEFORE the render handler is ever invoked', async () => {
  const { billing, runBilledRender, calls } = setup(async () => {
    throw new Error('the handler must not run — a model call would already be spent');
  });

  const out = await runBilledRender(fakeReq(), fakeRes(), opts());

  assert.equal(out.outcome, 'insufficient');
  assert.equal(out.balance, 0);
  assert.equal(calls.length, 0, 'no paid work may happen before the credit is taken');
  assert.equal(billing.getBalance(USER.id).balance, 0);
});

test('a handler that throws refunds the credit', async () => {
  const boom = Object.assign(new Error('no image generated'), { code: 'NO_IMAGE_GENERATED' });
  const { billing, runBilledRender } = setup(async () => { throw boom; });
  billing.grantCredits({ userId: USER.id, credits: 3 });

  const out = await runBilledRender(fakeReq(), fakeRes(), opts());

  assert.equal(out.outcome, 'failed');
  assert.equal(out.error, boom, 'the router needs the error to map it to a code');
  assert.equal(billing.getBalance(USER.id).balance, 3, 'a failed render is free');
  assert.equal(billing.getRequest(out.requestId).status, 'refunded');
});

test('an IN-BAND error response refunds, even though nothing threw', async () => {
  // This is the case a return-value check would miss entirely: the real handler
  // answers 400/500 itself and resolves normally.
  const { billing, runBilledRender } = setup(async (req, res) => res.status(400).json({ error: 'No image file provided' }));
  billing.grantCredits({ userId: USER.id, credits: 3 });

  const out = await runBilledRender(fakeReq(), fakeRes(), opts());

  assert.equal(out.outcome, 'rendered', 'the wrapper did not throw — the response carries the failure');
  assert.equal(billing.getBalance(USER.id).balance, 3, 'the caller must not pay for a 400');
  assert.equal(billing.getRequest(out.requestId).status, 'refunded');
});

test('a handler that answers AND throws refunds exactly once', async () => {
  // Both settle paths fire. api-billing.js guards on the row still being 'charged',
  // so the second is a no-op — this test is what pins that composition.
  const { billing, runBilledRender } = setup(async (req, res) => {
    res.status(500).json({ error: 'disclosure stamp failed' });
    throw Object.assign(new Error('stamp'), { code: 'DISCLOSURE_STAMP_FAILED' });
  });
  billing.grantCredits({ userId: USER.id, credits: 3 });

  const out = await runBilledRender(fakeReq(), fakeRes(), opts());

  assert.equal(billing.getBalance(USER.id).balance, 3);
  assert.equal(
    billing.listLedger(USER.id).filter((r) => r.reason === 'refund').length,
    1,
    'a double refund would hand back a credit that was never spent',
  );
  assert.equal(out.error.code, 'DISCLOSURE_STAMP_FAILED');
});

test('a client that hangs up mid-render still settles the row', async () => {
  const { billing, runBilledRender } = setup(async (req, res) => {
    res.emit('close'); // the socket died before anything was written
    return undefined;
  });
  billing.grantCredits({ userId: USER.id, credits: 3 });

  const out = await runBilledRender(fakeReq(), fakeRes(), opts());
  // statusCode is still the default 200, so this settles as delivered rather than
  // refunded — the image WAS produced, the caller just stopped listening. The
  // idempotency key is what lets them retrieve it.
  assert.equal(billing.getRequest(out.requestId).status, 'succeeded');
});

test('the wrapper always renders as pro, unmetered, one generation, tagged api', async () => {
  const { billing, runBilledRender, calls } = setup(async (req, res) => res.status(200).json({ ok: true }));
  billing.grantCredits({ userId: USER.id, credits: 2 });

  await runBilledRender(fakeReq(), fakeRes(), opts());
  const { meta } = calls[0];

  assert.equal(meta.recordUsage, false, 'credits are the meter — enterprise must not ALSO bill');
  assert.equal(meta.treatAsPro, true);
  assert.equal(meta.skipQualityReview, true, 'one credit must buy exactly one generation');
  assert.equal(meta.sourceTag, 'api');
  assert.equal(meta.user, USER, 'the render belongs in the owner\'s gallery');
});

test('the realized generation count is recorded, so cost-per-credit stays answerable', async () => {
  const { billing, runBilledRender } = setup(async (req, res) => {
    req._stagingGenerations = 2; // a transient provider error was retried
    return res.status(200).json({ ok: true });
  });
  billing.grantCredits({ userId: USER.id, credits: 2 });

  const out = await runBilledRender(fakeReq(), fakeRes(), opts());
  assert.equal(JSON.parse(billing.getRequest(out.requestId).extra_json).generations, 2);
});

test('replaying the same key after success returns the stored request without charging', async () => {
  let ran = 0;
  const { billing, runBilledRender } = setup(async (req, res) => { ran += 1; return res.status(200).json({ ok: true }); });
  billing.grantCredits({ userId: USER.id, credits: 5 });

  const first = await runBilledRender(fakeReq(), fakeRes(), opts());
  const replay = await runBilledRender(fakeReq(), fakeRes(), opts());

  assert.equal(replay.outcome, 'replay');
  assert.equal(replay.requestId, first.requestId);
  assert.equal(ran, 1, 'a replay must not re-render');
  assert.equal(billing.getBalance(USER.id).balance, 4, 'nor re-charge');
});

test('swapping the photo under one idempotency key is caught, not answered with the old room', async () => {
  const { billing, runBilledRender } = setup(async (req, res) => res.status(200).json({ ok: true }));
  billing.grantCredits({ userId: USER.id, credits: 5 });

  await runBilledRender(fakeReq(), fakeRes(), opts());
  const different = fakeReq({ files: { image: [{ buffer: Buffer.from('a DIFFERENT photo') }] } });
  const out = await runBilledRender(different, fakeRes(), opts());

  assert.equal(out.outcome, 'key_reused');
});

test('the fingerprint ignores field order and the auth token, but not the pixels', () => {
  const a = fingerprintRequest({ body: { roomType: 'Bedroom', style: 'Modern' }, files: {} });
  const b = fingerprintRequest({ body: { style: 'Modern', roomType: 'Bedroom' }, files: {} });
  assert.equal(a, b, 'a client reordering its form fields is the same request');

  const withToken = fingerprintRequest({ body: { roomType: 'Bedroom', style: 'Modern', authToken: 'x' }, files: {} });
  assert.equal(a, withToken, 'a credential is not a parameter');

  const other = fingerprintRequest({ body: { roomType: 'Kitchen', style: 'Modern' }, files: {} });
  assert.notEqual(a, other);

  const img1 = fingerprintRequest({ body: {}, files: { image: [{ buffer: Buffer.from('one') }] } });
  const img2 = fingerprintRequest({ body: {}, files: { image: [{ buffer: Buffer.from('two') }] } });
  assert.notEqual(img1, img2, 'the photo is part of the request');
});
