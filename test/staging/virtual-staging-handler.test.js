// Tier: core pipeline — the virtual-staging multipart handler
// (lib/staging/virtual-staging-handler.js).
//
// Every dependency is injected, so the handler can be driven with a fake
// processStaging and a fake auth store — no model calls, no Express, no multer.
// These cover the parts that are easy to regress silently: how many variations run,
// whether they run CONCURRENTLY, that output order matches variation order, and that
// the metering block still fires exactly once with the request-wide attempt count.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVirtualStagingHandler } from '../../lib/staging/virtual-staging-handler.js';

/** Minimal Express-ish response recorder. */
function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

/** A multipart request carrying one image and the given body fields. */
function fakeReq(body = {}) {
  return {
    body,
    files: { image: [{ buffer: Buffer.from('room-bytes') }] },
  };
}

/**
 * Build the handler with sane fakes. `processStaging` defaults to an instant
 * pass-through that echoes the variation's prompt so ordering can be asserted.
 */
function makeHandler(overrides = {}) {
  const calls = [];
  const deps = {
    genAI: { getGenerativeModel: () => ({}) },
    DEBUG_MODE: false,
    authStore: {
      freeGenerationStatus: () => ({ allowed: true, used: 0, limit: 50 }),
      recordFreeGeneration: () => {},
      recordStagingActivity: () => {},
      findUserByEmail: () => null,
    },
    toPublicAuthUser: (u) => (u ? { email: u.email, plan: u.plan } : null),
    enterpriseDomainForUser: () => null,
    reportEnterpriseUsage: () => {},
    roomIsAlreadyEmpty: async () => true,
    eraseFurniture: async () => null,
    processStaging: async (_buf, params, req) => {
      calls.push(params.additionalPrompt);
      if (req) req._stagingGenerations = (req._stagingGenerations || 0) + 1;
      return `img:${params.additionalPrompt.slice(0, 16)}`;
    },
    ...overrides,
  };
  const { handleVirtualStagingMultipart } = createVirtualStagingHandler(deps);
  return { handleVirtualStagingMultipart, calls, deps };
}

const PRO = { id: 'u_pro', email: 'pro@x.com', plan: 'pro' };
const FREE = { id: 'u_free', email: 'free@x.com', plan: 'free' };

test('a single variation returns one image under `image`', async () => {
  const { handleVirtualStagingMultipart, calls } = makeHandler();
  const res = fakeRes();
  await handleVirtualStagingMultipart(fakeReq({ roomType: 'Bedroom' }), res, {
    user: FREE, recordUsage: true, treatAsPro: false,
  });
  assert.equal(calls.length, 1);
  assert.equal(res.body.success, true);
  assert.ok(res.body.image, 'the single-image shape is used');
  assert.equal(res.body.images, undefined);
});

test('pro variations RUN CONCURRENTLY, not one after another', async () => {
  // The regression this guards: variations used to be awaited in a `for` loop, so a
  // 3-variation pro render took the SUM of three model round-trips inside one blocking
  // request — the paid tier was the slowest path in the product.
  //
  // Asserted by peak overlap, not by elapsed time, so it cannot flake on a slow
  // machine — and each call yields for a fixed tick rather than waiting on its
  // siblings, so a sequential regression FAILS the assertion instead of deadlocking.
  let inFlight = 0;
  let maxInFlight = 0;
  const { handleVirtualStagingMultipart } = makeHandler({
    processStaging: async (_buf, params) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return `img:${params.additionalPrompt.slice(0, 8)}`;
    },
  });
  const res = fakeRes();
  await handleVirtualStagingMultipart(fakeReq({ variationCount: '3' }), res, {
    user: PRO, recordUsage: true, treatAsPro: false,
  });
  assert.equal(maxInFlight, 3, 'all three variations must overlap; 1 means they ran sequentially');
  assert.equal(res.body.images.length, 3);
});

test('concurrent variations still come back in variation order', async () => {
  // Promise.all resolves in input order, so a slow first variation must not end up
  // second in the carousel.
  const delays = [30, 0, 10];
  const { handleVirtualStagingMultipart } = makeHandler({
    processStaging: async (_buf, params) => {
      const n = /variation (\d)/.exec(params.additionalPrompt);
      const idx = n ? Number(n[1]) - 1 : 0;
      await new Promise((r) => setTimeout(r, delays[idx]));
      return `img${idx + 1}`;
    },
  });
  const res = fakeRes();
  await handleVirtualStagingMultipart(fakeReq({ variationCount: '3' }), res, {
    user: PRO, recordUsage: true, treatAsPro: false,
  });
  assert.deepEqual(res.body.images, ['img1', 'img2', 'img3']);
  assert.equal(res.body.image, 'img1', 'the primary image is the first variation');
});

test('one failing variation still fails the whole request (unchanged contract)', async () => {
  let started = 0;
  const { handleVirtualStagingMultipart } = makeHandler({
    processStaging: async () => {
      started += 1;
      if (started === 2) throw Object.assign(new Error('nope'), { code: 'NO_IMAGE_GENERATED' });
      return 'ok';
    },
  });
  await assert.rejects(
    () => handleVirtualStagingMultipart(fakeReq({ variationCount: '3' }), fakeRes(), {
      user: PRO, recordUsage: true, treatAsPro: false,
    }),
    /nope/,
  );
});

test('a free account is pinned to one variation even when it asks for three', async () => {
  const { handleVirtualStagingMultipart, calls } = makeHandler();
  const res = fakeRes();
  await handleVirtualStagingMultipart(fakeReq({ variationCount: '3' }), res, {
    user: FREE, recordUsage: true, treatAsPro: false,
  });
  assert.equal(calls.length, 1, 'variations are a paid feature');
  assert.ok(res.body.image);
});

test('the free daily cap is enforced before any paid work happens, and is RECORDED', async () => {
  // Hitting the free ceiling is the clearest upgrade signal the product has, and it
  // used to write no row anywhere — the request is refused before processStaging, so
  // nothing logged it and it was invisible in every funnel.
  let staged = 0;
  const rejections = [];
  const { handleVirtualStagingMultipart } = makeHandler({
    authStore: {
      freeGenerationStatus: () => ({ allowed: false, used: 50, limit: 50 }),
      recordFreeGeneration: () => {},
      findUserByEmail: () => null,
    },
    processStaging: async () => { staged += 1; return 'x'; },
    logRejectionToFile: (kind, code, detail, who) => rejections.push({ kind, code, detail, id: who.userId }),
  });
  const res = fakeRes();
  await handleVirtualStagingMultipart(fakeReq({}), res, {
    user: FREE, recordUsage: true, treatAsPro: false,
  });
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.code, 'DAILY_LIMIT_REACHED');
  assert.equal(staged, 0, 'no Gemini call is made once the cap is hit');
  assert.deepEqual(rejections, [
    { kind: 'daily_limit', code: 'DAILY_LIMIT_REACHED', detail: '50/50', id: 'u_free' },
  ]);
});

test('a render that is allowed through records no rejection', async () => {
  const rejections = [];
  const { handleVirtualStagingMultipart } = makeHandler({
    logRejectionToFile: (...a) => rejections.push(a),
  });
  await handleVirtualStagingMultipart(fakeReq({}), fakeRes(), {
    user: FREE, recordUsage: true, treatAsPro: false,
  });
  assert.deepEqual(rejections, []);
});

test('enterprise usage is metered once, with the request-wide attempt total', async () => {
  const metered = [];
  const { handleVirtualStagingMultipart } = makeHandler({
    enterpriseDomainForUser: () => 'acme.com',
    reportEnterpriseUsage: (domain, qty) => metered.push({ domain, qty }),
  });
  await handleVirtualStagingMultipart(fakeReq({ variationCount: '3' }), fakeRes(), {
    user: PRO, recordUsage: true, treatAsPro: false,
  });
  assert.deepEqual(metered, [{ domain: 'acme.com', qty: 3 }]);
});

test('a pro render records trial activation; a free render records a free generation instead', async () => {
  const activity = [];
  const freeGens = [];
  const deps = {
    recordStagingActivity: (u) => { activity.push(u.id); return true; },
    authStore: {
      freeGenerationStatus: () => ({ allowed: true, used: 0, limit: 50 }),
      recordFreeGeneration: (id) => freeGens.push(id),
      findUserByEmail: () => null,
    },
  };

  const pro = makeHandler(deps);
  await pro.handleVirtualStagingMultipart(fakeReq({}), fakeRes(), {
    user: PRO, recordUsage: true, treatAsPro: false,
  });
  assert.deepEqual(activity, ['u_pro']);
  assert.deepEqual(freeGens, []);

  const free = makeHandler(deps);
  await free.handleVirtualStagingMultipart(fakeReq({}), fakeRes(), {
    user: FREE, recordUsage: true, treatAsPro: false,
  });
  assert.deepEqual(activity, ['u_pro'], 'a free account has no trial to activate');
  assert.deepEqual(freeGens, ['u_free']);
});

test('a request with no image is rejected before anything else', async () => {
  const { handleVirtualStagingMultipart } = makeHandler();
  const res = fakeRes();
  await handleVirtualStagingMultipart({ body: {}, files: {} }, res, {
    user: PRO, recordUsage: true, treatAsPro: false,
  });
  assert.equal(res.statusCode, 400);
});
