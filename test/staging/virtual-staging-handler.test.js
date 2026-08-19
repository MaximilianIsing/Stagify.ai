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
function fakeReq(body = {}, originalname = '123-main-mstr.jpg') {
  return {
    body,
    files: { image: [{ buffer: Buffer.from('room-bytes'), originalname }] },
  };
}

/** A render-persistence double that records what it was handed. */
function fakePersistence(seen) {
  return {
    enabled: () => true,
    recordPending: (arg) => {
      seen.push(arg);
      return { entries: arg.natives.map((n, i) => ({ id: `r${i}`, native: n.buffer })), evicted: [] };
    },
    uploadInBackground: async () => ({ ok: 1, failed: 0 }),
  };
}

/**
 * Build the handler with sane fakes. `processStaging` defaults to an instant
 * pass-through that echoes the variation TAG so ordering can be asserted.
 *
 * Deliberately not the prompt: every variation of a request now gets a byte-identical
 * `additionalPrompt` (the per-variation parenthetical that used to differentiate them
 * is gone — see the handler), so a prompt-derived return value would collide across
 * variations. `params.variation` is the real discriminator and the one the render log
 * records, which makes it what these tests should key on anyway.
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
      // The whole params object, not just the prompt: the prompt is now identical across
      // variations, and the tests below need to assert exactly that.
      calls.push(params);
      if (req) req._stagingGenerations = (req._stagingGenerations || 0) + 1;
      return `img:${params.variation}`;
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

test('the row records which studio made it and which photo it came from', async () => {
  // The filename is the whole point of this one. A user who never opens either dropdown
  // gets roomType 'Bedroom' + style 'standard' on EVERY render, so twenty renders of twenty
  // different houses all derived the identical name "Standard Bedroom".
  const seen = [];
  const { handleVirtualStagingMultipart } = makeHandler({
    renderPersistence: fakePersistence(seen),
    processStaging: async (_buf, params) => { params.onNative?.(Buffer.from('n'), {}); return 'img'; },
  });
  await handleVirtualStagingMultipart(
    fakeReq({ roomType: 'Bedroom', furnitureStyle: 'luxury' }, '412-rosewood-mstr.jpg'),
    fakeRes(),
    { user: PRO, recordUsage: true, treatAsPro: true },
  );
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].extra, { source: 'interior', sourceName: '412-rosewood-mstr.jpg' });
  assert.equal(seen[0].extra.qualifier, undefined,
    'interior stores NO qualifier — its name still derives from the room_type and '
    + 'furniture_style columns, and a frozen copy would only go stale against them');
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
      return `img:${params.variation}`;
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
      // Keyed on the variation TAG, not on prompt text. This used to scrape the index
      // back out of `additionalPrompt` with /variation (\d)/, which only worked while
      // the handler differentiated the variations by prompt — the thing that was making
      // the extra variations drift on architecture.
      const idx = Number(params.variation.split('/')[0]) - 1;
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

// THE GUARD THIS FILE EXISTS FOR NOW. Variations 2..N used to get an extra
// "(Subtle variation n of N: ... slightly different furniture arrangement ...)"
// parenthetical appended to the user's own free-text box. Three things were wrong with
// it, and the first is a real bug rather than a matter of taste:
//
//   1. generatePrompt() promotes additionalPrompt to BE the base prompt on the 'custom'
//      style, falling back to 'standard' only when the box is EMPTY. Appending made the
//      box non-empty, so a Custom-with-nothing-typed request — a state the style picker
//      lets anyone reach — lost its entire staging brief on variations 2..N while
//      variation 1 kept it. The model was left to improvise the room, architecture and
//      all, which is precisely what that fallback exists to prevent.
//   2. It restated the architecture lock inside additionalPrompt, the one place
//      lib/staging/prompts.js tells every caller not to put one: the authoritative block
//      is appended last with override authority, and it states the rule as a COUNT of
//      windows and doors because an abstract paraphrase is not checkable.
//   3. It asked for a different furniture ARRANGEMENT with no spatial constraint, on the
//      extra variations only — so those were the ones that drifted on walls.
//
// Asserting the prompts are IDENTICAL is what keeps all three fixed, because each of the
// three failures required the prompts to differ. Diversity comes from the independent
// per-render seed instead.
test('every variation stages from the SAME prompt — no per-variation prompt text', async () => {
  const { handleVirtualStagingMultipart, calls } = makeHandler();
  await handleVirtualStagingMultipart(
    fakeReq({ variationCount: '3', furnitureStyle: 'custom', additionalPrompt: '' }),
    fakeRes(),
    { user: PRO, recordUsage: true, treatAsPro: false },
  );
  assert.equal(calls.length, 3);
  for (const params of calls) {
    assert.equal(params.additionalPrompt, '',
      'an empty Custom box must stay empty on EVERY variation — a non-empty one hijacks '
      + 'the base prompt in generatePrompt() and strips the room out of the brief');
  }
  assert.equal(new Set(calls.map((p) => p.additionalPrompt)).size, 1,
    'all variations share one prompt');
});

test('a typed prompt reaches every variation unchanged, with nothing appended', async () => {
  const { handleVirtualStagingMultipart, calls } = makeHandler();
  await handleVirtualStagingMultipart(
    fakeReq({ variationCount: '3', additionalPrompt: 'warm oak floors, big plants' }),
    fakeRes(),
    { user: PRO, recordUsage: true, treatAsPro: false },
  );
  for (const params of calls) {
    assert.equal(params.additionalPrompt, 'warm oak floors, big plants',
      'the user\'s words reach the model verbatim on every variation');
  }
});

// The render log's drift column is only worth having if the row says WHICH variation it
// was — otherwise "do the later variations drift more?" stays a hunch, which is how the
// prompt suffix above survived as long as it did.
test('each render is tagged n/N so drift can be counted per variation', async () => {
  const { handleVirtualStagingMultipart, calls } = makeHandler();
  await handleVirtualStagingMultipart(fakeReq({ variationCount: '3' }), fakeRes(), {
    user: PRO, recordUsage: true, treatAsPro: false,
  });
  assert.deepEqual(calls.map((p) => p.variation), ['1/3', '2/3', '3/3']);
});

test('a single render is tagged 1/1, not left blank', async () => {
  // Blank is reserved for the surfaces that never fan out (chat, Exterior, the v1 API),
  // so a studio render is always distinguishable from one of those in the log.
  const { handleVirtualStagingMultipart, calls } = makeHandler();
  await handleVirtualStagingMultipart(fakeReq({}), fakeRes(), {
    user: FREE, recordUsage: true, treatAsPro: false,
  });
  assert.deepEqual(calls.map((p) => p.variation), ['1/1']);
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

// ── "Label as virtually staged" ──────────────────────────────────────────────────────
//
// The disclosure option is UNGATED by plan, which is the opposite of every other option
// this handler resolves. That asymmetry is deliberate (an MLS/NAR compliance control is not
// an upsell) and therefore fragile: the obvious "consistency" cleanup is to fold it in
// beside removeBool's `isPro &&`, which would silently paywall it. These pin it down.

/** Capture the full stagingParams object(s) handed to processStaging. */
function captureParams() {
  const seen = [];
  return {
    seen,
    processStaging: async (_buf, params, req) => {
      seen.push(params);
      if (req) req._stagingGenerations = (req._stagingGenerations || 0) + 1;
      return 'img';
    },
  };
}

test('labelVirtuallyStaged is available to FREE accounts — it is not a pro feature', async () => {
  const cap = captureParams();
  const { handleVirtualStagingMultipart } = makeHandler({ processStaging: cap.processStaging });
  await handleVirtualStagingMultipart(
    fakeReq({ roomType: 'Bedroom', labelVirtuallyStaged: 'true' }),
    fakeRes(),
    { user: FREE, recordUsage: true, treatAsPro: false },
  );
  assert.equal(cap.seen.length, 1);
  assert.equal(
    cap.seen[0].labelVirtuallyStaged, true,
    'a free account asking for the disclosure gets it — do NOT add `isPro &&` to this coercion',
  );
});

test('removeFurniture is STILL pro-gated (proving the two were not merged)', async () => {
  // The regression guard for the cleanup described above: if someone unifies the two
  // coercions, one of these two tests fails whichever direction they unify in.
  const cap = captureParams();
  const { handleVirtualStagingMultipart } = makeHandler({ processStaging: cap.processStaging });
  await handleVirtualStagingMultipart(
    fakeReq({ roomType: 'Bedroom', removeFurniture: 'true' }),
    fakeRes(),
    { user: FREE, recordUsage: true, treatAsPro: false },
  );
  assert.equal(cap.seen[0].removeFurniture, false, 'a free account does not get furniture removal');
});

test('labelVirtuallyStaged: multipart string forms coerce, everything else is false', async () => {
  // multer delivers every field as a string, so the truthy set has to be explicit —
  // `!!'false'` is true, which would stamp every render for users who never ticked the box.
  for (const [input, expected] of [
    ['true', true], ['on', true], [true, true],
    ['false', false], ['off', false], ['0', false], ['', false], ['1', false],
    [undefined, false], [null, false], ['TRUE', false],
  ]) {
    const cap = captureParams();
    const { handleVirtualStagingMultipart } = makeHandler({ processStaging: cap.processStaging });
    const body = { roomType: 'Bedroom' };
    if (input !== undefined) body.labelVirtuallyStaged = input;
    await handleVirtualStagingMultipart(fakeReq(body), fakeRes(), { user: FREE, recordUsage: true, treatAsPro: false });
    assert.equal(cap.seen[0].labelVirtuallyStaged, expected, `${JSON.stringify(input)} → ${expected}`);
  }
});

test('stampLang is validated against the real locale set, never trusted into a filename', async () => {
  // It arrives from the browser's localStorage and ends up selecting a PNG on disk, so a
  // traversal-shaped value must not survive the handler. Unknown values become English.
  for (const [input, expected] of [
    ['german', 'german'], ['japanese', 'japanese'], ['english', 'english'],
    ['klingon', 'english'], ['', 'english'], ['../../etc/passwd', 'english'],
    ['English', 'english'], [undefined, 'english'],
  ]) {
    const cap = captureParams();
    const { handleVirtualStagingMultipart } = makeHandler({ processStaging: cap.processStaging });
    const body = { roomType: 'Bedroom', labelVirtuallyStaged: 'true' };
    if (input !== undefined) body.stampLang = input;
    await handleVirtualStagingMultipart(fakeReq(body), fakeRes(), { user: FREE, recordUsage: true, treatAsPro: false });
    assert.equal(cap.seen[0].stampLang, expected, `${JSON.stringify(input)} → ${expected}`);
  }
});

test('stampStyle is an allow-list, because it picks a code path', async () => {
  // Unlike the language, an unknown style cannot become a filename — but it does select a
  // branch in the compositor, so it is snapped to the known set here rather than being
  // handed on and resolved somewhere further in. Same rule, one layer earlier.
  for (const [input, expected] of [
    ['dark', 'dark'], ['light', 'light'], ['minimal', 'minimal'],
    ['neon', 'dark'], ['', 'dark'], ['DARK', 'dark'], [undefined, 'dark'],
  ]) {
    const cap = captureParams();
    const { handleVirtualStagingMultipart } = makeHandler({ processStaging: cap.processStaging });
    const body = { roomType: 'Bedroom', labelVirtuallyStaged: 'true' };
    if (input !== undefined) body.stampStyle = input;
    await handleVirtualStagingMultipart(fakeReq(body), fakeRes(), { user: FREE, recordUsage: true, treatAsPro: false });
    assert.equal(cap.seen[0].stampStyle, expected, `${JSON.stringify(input)} → ${expected}`);
  }
});

test('stampScale is clamped, so the slider cannot be posted past its range', async () => {
  // The form sends whatever the range input holds, but nothing stops a hand-rolled POST
  // from sending 500 — which would ask sharp for a badge many times wider than the photo.
  for (const [input, expected] of [
    ['1', 1], ['0.7', 0.7], ['1.6', 1.6], ['1.35', 1.35],
    ['500', 1.6], ['-2', 0.7], ['abc', 1], ['', 1], [undefined, 1],
  ]) {
    const cap = captureParams();
    const { handleVirtualStagingMultipart } = makeHandler({ processStaging: cap.processStaging });
    const body = { roomType: 'Bedroom', labelVirtuallyStaged: 'true' };
    if (input !== undefined) body.stampScale = input;
    await handleVirtualStagingMultipart(fakeReq(body), fakeRes(), { user: FREE, recordUsage: true, treatAsPro: false });
    assert.equal(cap.seen[0].stampScale, expected, `${JSON.stringify(input)} → ${expected}`);
  }
});

test('the badge options are NOT pro-gated either', async () => {
  // The flag deliberately skips `isPro &&` (see above); its style and size have to travel
  // the same way, or a free account would tick the box, pick a style, and silently get the
  // default one. Nothing about that failure is visible until the render comes back.
  const cap = captureParams();
  const { handleVirtualStagingMultipart } = makeHandler({ processStaging: cap.processStaging });
  await handleVirtualStagingMultipart(
    fakeReq({ roomType: 'Bedroom', labelVirtuallyStaged: 'true', stampStyle: 'minimal', stampScale: '1.4' }),
    fakeRes(),
    { user: FREE, recordUsage: true, treatAsPro: false },
  );
  assert.equal(cap.seen[0].stampStyle, 'minimal', 'a free account keeps its chosen style');
  assert.equal(cap.seen[0].stampScale, 1.4, 'and its chosen size');
});

test('every variation of a multi-variation render carries the disclosure flag', async () => {
  // The flag rides stagingParamsBase, which is spread per variation. If it were attached to
  // only the first, a pro user asking for three images would publish two unlabelled ones.
  const cap = captureParams();
  const { handleVirtualStagingMultipart } = makeHandler({ processStaging: cap.processStaging });
  await handleVirtualStagingMultipart(
    fakeReq({
      roomType: 'Bedroom',
      variationCount: '3',
      labelVirtuallyStaged: 'true',
      stampLang: 'italian',
      stampStyle: 'light',
      stampScale: '1.2',
    }),
    fakeRes(),
    { user: PRO, recordUsage: true, treatAsPro: true },
  );
  assert.equal(cap.seen.length, 3, 'sanity: three variations ran');
  for (const [i, params] of cap.seen.entries()) {
    assert.equal(params.labelVirtuallyStaged, true, `variation ${i + 1} is labelled`);
    assert.equal(params.stampLang, 'italian', `variation ${i + 1} keeps the language`);
    // The look has to ride along with the flag: three images from one submission that do
    // not match each other are unusable as a set, and the user only asked once.
    assert.equal(params.stampStyle, 'light', `variation ${i + 1} keeps the style`);
    assert.equal(params.stampScale, 1.2, `variation ${i + 1} keeps the size`);
  }
});

// ---- The two-stage furniture-removal branch --------------------------------
//
// "Remove existing furniture" runs a dedicated erase pass BEFORE staging, so a render on
// this path is two full generative passes rather than one — and each pass is another chance
// for the model to reconstruct the room's architecture. The branch had no test at all, which
// is how its three outcomes (already empty / erased / erase unavailable) could each silently
// change behaviour. All three converge on the same requirement: the staging pass must NOT be
// re-issued the "remove all furniture" instruction, because by then there is nothing to
// remove and the instruction only invites the model to keep deleting.

test('remove-furniture: an already-empty room skips the erase entirely', async () => {
  let erased = 0;
  const cap = { seen: [] };
  const { handleVirtualStagingMultipart } = makeHandler({
    roomIsAlreadyEmpty: async () => true,
    eraseFurniture: async () => { erased += 1; return null; },
    processStaging: async (buf, params) => { cap.seen.push({ buf, params }); return 'img'; },
  });

  const res = fakeRes();
  await handleVirtualStagingMultipart(
    fakeReq({ roomType: 'Bedroom', removeFurniture: 'true' }), res,
    { user: PRO, recordUsage: true, treatAsPro: true },
  );

  assert.equal(erased, 0, 'no Gemini erase call is paid for on an already-empty room');
  assert.equal(cap.seen[0].params.removeFurniture, false, 'and staging is not told to remove anything');
  assert.equal(res.body.emptyRoom, undefined, 'nothing was emptied, so no empty-room image is returned');
});

test('remove-furniture: a successful erase stages from the EMPTIED room, not the original', async () => {
  const emptied = Buffer.from('emptied-room-bytes');
  const cap = { seen: [] };
  const { handleVirtualStagingMultipart } = makeHandler({
    roomIsAlreadyEmpty: async () => false,
    eraseFurniture: async () => ({ buffer: emptied, dataUrl: 'data:image/png;base64,AAAA' }),
    processStaging: async (buf, params) => { cap.seen.push({ buf, params }); return 'img'; },
  });

  const res = fakeRes();
  await handleVirtualStagingMultipart(
    fakeReq({ roomType: 'Bedroom', removeFurniture: 'true' }), res,
    { user: PRO, recordUsage: true, treatAsPro: true },
  );

  assert.equal(cap.seen[0].buf, emptied, 'staging runs on the erased room');
  assert.equal(cap.seen[0].params.removeFurniture, false, 'and is not asked to remove furniture again');
  assert.equal(res.body.emptyRoom, 'data:image/png;base64,AAAA', 'the empty room is returned for the before/after view');
});

test('remove-furniture: a failed erase falls back to single-pass removal, not to a no-op', async () => {
  // eraseFurniture returns null when Gemini is unavailable or every attempt failed. The
  // fallback must keep removeFurniture TRUE — the user asked for an empty room, and the
  // single-pass staging prompt is the only thing left that will deliver one.
  const cap = { seen: [] };
  const { handleVirtualStagingMultipart } = makeHandler({
    roomIsAlreadyEmpty: async () => false,
    eraseFurniture: async () => null,
    processStaging: async (buf, params) => { cap.seen.push({ buf, params }); return 'img'; },
  });

  const res = fakeRes();
  await handleVirtualStagingMultipart(
    fakeReq({ roomType: 'Bedroom', removeFurniture: 'true' }), res,
    { user: PRO, recordUsage: true, treatAsPro: true },
  );

  assert.equal(cap.seen[0].params.removeFurniture, true, 'staging still removes furniture itself');
  assert.equal(res.body.emptyRoom, undefined, 'and there is no empty-room image to show');
});

test('remove-furniture: the keep-list is trimmed and clamped before it reaches the eraser', async () => {
  // Free-text off a request body. 500 chars is the documented ceiling; without the clamp an
  // unbounded string rides into the erase prompt.
  let seenKeep = null;
  const { handleVirtualStagingMultipart } = makeHandler({
    roomIsAlreadyEmpty: async () => false,
    eraseFurniture: async (_buf, _req, keep) => { seenKeep = keep; return null; },
  });

  await handleVirtualStagingMultipart(
    fakeReq({ roomType: 'Bedroom', removeFurniture: 'true', keepFurniture: '  ' + 'x'.repeat(600) + '  ' }),
    fakeRes(), { user: PRO, recordUsage: true, treatAsPro: true },
  );

  assert.equal(seenKeep.length, 500, 'clamped to 500 characters');
  assert.ok(!/^\s|\s$/.test(seenKeep), 'and trimmed');
});

test('remove-furniture: a free account cannot reach the erase pass at all', async () => {
  // Removal is Stagify+/Enterprise. The gate is `isPro`, not the checkbox, so a tampered
  // request body must not buy a second generative pass.
  let erased = 0;
  const cap = { seen: [] };
  const { handleVirtualStagingMultipart } = makeHandler({
    roomIsAlreadyEmpty: async () => false,
    eraseFurniture: async () => { erased += 1; return null; },
    processStaging: async (buf, params) => { cap.seen.push(params); return 'img'; },
  });

  await handleVirtualStagingMultipart(
    fakeReq({ roomType: 'Bedroom', removeFurniture: 'true' }), fakeRes(),
    { user: FREE, recordUsage: true },
  );

  assert.equal(erased, 0, 'no erase pass for a free account');
  assert.equal(cap.seen[0].removeFurniture, false, 'and the flag is dropped, not honoured');
});
