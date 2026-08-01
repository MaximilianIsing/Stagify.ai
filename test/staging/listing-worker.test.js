// Tier: unit (fake store, fake AI) — lib/staging/listing-worker.js.
//
// WHAT THIS COVERS, AND WHY THESE THINGS
// `tick()` is the whole worker: one claim, one render, one row written. It is driven
// directly here with fakes, so every branch runs without a database, a timer, or a paid
// model call. The load-bearing cases:
//
//   * extractBible returning null must leave the room's support frames BLOCKED. The
//     failure mode this guards is the tempting one — render them anyway — which would
//     produce a differently-furnished room at every angle and quietly break the only
//     thing the feature promises. The assertion is that processStaging is NOT called
//     again for a support frame, not merely that a warning was logged.
//   * The support path must pass BOTH the bible (in stagingParams) AND the hero render's
//     bytes (in the furniture-reference slot). Either one alone is a different product:
//     text-only loses the actual pixels, image-only loses the locked piece list. Both are
//     asserted, and dropping either from the router would fail this test.
//   * tick() must never throw. A worker that dies on one bad photo strands every
//     remaining frame of the listing, with no error surfaced anywhere.
//   * A stale lease must return to the queue: `reclaimStaleClaims` runs FIRST, before the
//     claim, because a process killed mid-render is the normal case on every deploy.
//   * A TRANSIENT failure must go back on the queue, bounded. One 503 on frame 2 of 3 used
//     to lose that frame permanently while the progress endpoint read as complete, so the
//     operator was told "staging finished" and silently got 2 of 3.
//   * A render whose row went away mid-flight (its listing was DELETED) must not be counted
//     as a success, and the blob it already wrote must be removed — `storage.write` does a
//     mkdir -p, so it recreates the very directory the delete removed.
//   * A finished listing must reach status 'ready'. Nothing else in the codebase writes it.
//
// THE FAKE STORE MIRRORS THE REAL SQL, DELIBERATELY. It used to be KINDER than reality:
// `attachBibleToQueuedRenders` skipped hero rows, which the real UPDATE did not, so this
// suite asserted an invariant the database did not have and stayed green while a hero was
// being staged as a support frame. A fake that is more correct than the thing it stands in
// for is worse than no fake — every predicate below is copied from project-renders.js, and
// test/data/project-renders.test.js pins the SQL itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createListingWorker, readJobSettings, isRetryableFailure,
  DEFAULT_LEASE_MS, DEFAULT_INTERVAL_MS, MAX_RENDER_ATTEMPTS, TERMINAL_ERROR_CODES,
} from '../../lib/staging/listing-worker.js';
import { DEFAULT_LEASE_MS as STORE_LEASE_MS } from '../../lib/data/project-renders.js';

const WEBP_URL = `data:image/webp;base64,${Buffer.from('rendered-bytes').toString('base64')}`;
const PNG_URL = `data:image/png;base64,${Buffer.from('png-fallback').toString('base64')}`;
const BIBLE_DOC = { version: 1, roomKey: 'living-room-1', roomType: 'Living room', furnitureStyle: 'standard', palette: {}, lighting: {}, pieces: [{ slot: 'sofa', identity: 'grey 3-seat', placement: 'facing window', critical: true }], negatives: [] };

/**
 * A queue-shaped fake of lib/data/projects.js: rows in arrays, with every predicate copied
 * from the real statements in lib/data/project-renders.js — the claim's FIFO + bible barrier,
 * the "still writable" guard that makes a lost race detectable, the barred-support-rows-of-one-room
 * set that `attachBible` releases and `failBlockedRoom` buries, and the retry budget.
 * @param {{ photos?: any[], renders?: any[], bibles?: any[], project?: any }} [seed] - Initial rows.
 * @returns {any} The fake store plus a `calls` log.
 */
function fakeStore(seed = {}) {
  const photos = seed.photos || [];
  const renders = seed.renders || [];
  const bibles = seed.bibles || [];
  const project = seed.project ?? { id: 'p1', extra: null };
  /** @type {string[]} */
  const calls = [];
  let bibleSeq = 0;

  const photoOf = (/** @type {any} */ r) => photos.find((p) => p.id === r.photoId) || null;
  // CLAIMABLE_WHERE: queued, its photo still exists, and either the frame is the room's hero
  // or its bible has been attached.
  const claimable = (/** @type {any} */ r) => {
    const photo = photoOf(r);
    return r.status === 'queued' && !!photo && (photo.frameRole === 'hero' || r.bibleId !== null);
  };
  // STILL_WRITABLE: 'ok' and 'superseded' are final. Anything else is live work whose row a
  // worker may still settle.
  const writable = (/** @type {any} */ r) => r.status !== 'ok' && r.status !== 'superseded';
  // BARRED_PHOTOS_IN_ROOM: queued NON-HERO frames of one room. Heroes are excluded — the real
  // UPDATE does not stamp them, and the fake pretending otherwise is exactly what hid a bug.
  const barredInRoom = (/** @type {any} */ r, /** @type {string} */ projectId, /** @type {string} */ roomKey) => {
    const photo = photoOf(r);
    return r.projectId === projectId && r.status === 'queued'
      && !!photo && photo.roomKey === roomKey && photo.frameRole !== 'hero';
  };

  const store = {
    calls, photos, renders, bibles, project,
    reclaimStaleClaims({ now, leaseMs }) {
      calls.push('reclaimStaleClaims');
      let n = 0;
      for (const r of renders) {
        if (r.status === 'running' && r.claimedAt !== null && now - r.claimedAt > leaseMs) {
          r.status = 'queued';
          r.claimedAt = null;
          n += 1;
        }
      }
      return n;
    },
    claimNextRender({ now }) {
      calls.push('claimNextRender');
      const row = renders.find(claimable);
      if (!row) return null;
      row.status = 'running';
      row.claimedAt = now;
      return row;
    },
    getPhoto: (id) => photos.find((p) => p.id === id) || null,
    getProject: () => project,
    updateProject(id, patch) {
      calls.push('updateProject');
      Object.assign(project, patch);
      return project;
    },
    hasPendingWork() {
      return renders.some((r) => r.status === 'running') || renders.some(claimable);
    },
    getBible: (id) => bibles.find((b) => b.id === id) || null,
    getRender: (id) => renders.find((r) => r.id === id) || null,
    completeRender(id, patch) {
      calls.push('completeRender');
      const row = renders.find((r) => r.id === id);
      if (!row || !writable(row)) return null;
      Object.assign(row, patch, { status: 'ok' });
      return row;
    },
    failRender(id, patch) {
      calls.push('failRender');
      const row = renders.find((r) => r.id === id);
      if (!row || !writable(row)) return null;
      Object.assign(row, patch, { status: 'failed', genAttempts: (row.genAttempts || 0) + 1 });
      return row;
    },
    requeueRenderForRetry(id, patch) {
      calls.push('requeueRenderForRetry');
      const row = renders.find((r) => r.id === id);
      if (!row || !writable(row)) return null;
      // The budget test is part of the UPDATE in the real store, so it is part of this.
      if ((row.genAttempts || 0) + 1 >= patch.maxAttempts) return null;
      Object.assign(row, patch, { status: 'queued', claimedAt: null, genAttempts: (row.genAttempts || 0) + 1 });
      return row;
    },
    failBlockedRendersForRoom(projectId, roomKey, { errorCode } = {}) {
      calls.push('failBlockedRendersForRoom');
      let n = 0;
      for (const r of renders) {
        if (!barredInRoom(r, projectId, roomKey) || r.bibleId !== null) continue;
        Object.assign(r, { status: 'failed', errorCode, claimedAt: null });
        n += 1;
      }
      return n;
    },
    createBible(arg) {
      calls.push('createBible');
      bibleSeq += 1;
      const row = { id: `b${bibleSeq}`, ...arg, version: bibleSeq };
      bibles.push(row);
      return row;
    },
    attachBibleToQueuedRenders(projectId, roomKey, bibleId) {
      calls.push('attachBibleToQueuedRenders');
      let n = 0;
      for (const r of renders) {
        // No `bibleId === null` test: the real UPDATE re-points an already-attached queued
        // render on purpose, so a newer bible version wins for work that has not started.
        if (!barredInRoom(r, projectId, roomKey)) continue;
        r.bibleId = bibleId;
        n += 1;
      }
      return n;
    },
    createBibleAndUnblockRoom(arg) {
      calls.push('createBibleAndUnblockRoom');
      const bible = store.createBible(arg);
      const unblocked = store.attachBibleToQueuedRenders(arg.projectId, arg.roomKey, bible.id);
      return { bible, unblocked };
    },
  };
  return store;
}

/**
 * @param {Map<string, Buffer>} blobs - Pre-seeded blob map.
 * @param {string[]} calls - Shared call log.
 * @returns {any} A fake project-storage whose `read` rejects (ENOENT) on a missing key.
 */
function fakeStorage(blobs, calls) {
  return {
    blobs,
    keyFor: ({ projectId, kind, id, ext }) => `projects/${projectId}/${kind}/${id}.${ext}`,
    async write(key, buf) { calls.push(`write:${key}`); blobs.set(key, Buffer.from(buf)); return { key, bytes: buf.length }; },
    async read(key) {
      const buf = blobs.get(key);
      if (!buf) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return buf;
    },
    async remove(key) { calls.push(`remove:${key}`); return blobs.delete(key); },
  };
}

/**
 * Build a worker over one project with one hero photo and `supportCount` support photos,
 * all queued. `over` replaces any dep.
 * @param {{ supportCount?: number, extraJson?: any, over?: any }} [opts] - Fixture options.
 * @returns {any} `{ worker, store, storage, staged, blobs }`.
 */
function makeWorker({ supportCount = 1, extra = null, over = {} } = {}) {
  const photos = [{ id: 'ph_hero', projectId: 'p1', storageKey: 'src/hero.jpg', roomKey: 'living-room-1', roomType: 'Living room', frameRole: 'hero' }];
  const renders = [{ id: 'r_hero', projectId: 'p1', photoId: 'ph_hero', bibleId: null, variation: 1, status: 'queued', storageKey: null, claimedAt: null, createdAt: 1, genAttempts: 0 }];
  for (let i = 0; i < supportCount; i += 1) {
    photos.push({ id: `ph_s${i}`, projectId: 'p1', storageKey: `src/s${i}.jpg`, roomKey: 'living-room-1', roomType: 'Living room', frameRole: 'support' });
    renders.push({ id: `r_s${i}`, projectId: 'p1', photoId: `ph_s${i}`, bibleId: null, variation: 1, status: 'queued', storageKey: null, claimedAt: null, createdAt: 2 + i, genAttempts: 0 });
  }
  // 'staging' is the state a queued listing is really in — and the one the worker is the only
  // thing that ever moves off.
  // `userId` is part of the fixture because every real project has an owner, and the render
  // log's attribution (and therefore its erasability) is resolved from it.
  const store = fakeStore({ photos, renders, project: { id: 'p1', userId: 'u-owner', status: 'staging', extra } });
  const blobs = new Map(photos.map((p) => [p.storageKey, Buffer.from(`bytes-of-${p.id}`)]));
  const storage = fakeStorage(blobs, store.calls);

  /** @type {any[]} */
  const staged = [];
  const worker = createListingWorker({
    projects: store,
    storage,
    processStaging: async (buf, params, req, refs, model, outcome) => {
      staged.push({ buf, params, req, refs, model, outcome });
      if (outcome) Object.assign(outcome, { promptText: 'PROMPT', model: 'gemini-x', attempts: 2, qualityScore: 95, consistencyScore: 88 });
      return WEBP_URL;
    },
    extractBible: async () => BIBLE_DOC,
    getGeminiImageModel: (m) => (String(m).includes('gpt-5') ? 'gemini-3.1-flash-image' : 'gemini-2.5-flash-image'),
    ...over,
  });
  return { worker, store, storage, staged, blobs };
}

// ── Empty queue ──────────────────────────────────────────────────────────────

test('an empty queue is { done: false } and spends nothing', async () => {
  const store = fakeStore();
  let called = 0;
  const worker = createListingWorker({
    projects: store,
    storage: fakeStorage(new Map(), store.calls),
    processStaging: async () => { called += 1; return WEBP_URL; },
    extractBible: async () => BIBLE_DOC,
    getGeminiImageModel: () => 'gemini-x',
  });
  const res = await worker.tick();
  assert.deepEqual(res, { done: false, blockedByMissingBible: 0 });
  assert.equal(called, 0);
  assert.deepEqual(store.calls, ['reclaimStaleClaims', 'claimNextRender']);
});

// ── Hero path ────────────────────────────────────────────────────────────────

test('hero success: bytes stored, render completed with its audit trail, bible attached', async () => {
  const { worker, store, staged, blobs } = makeWorker();
  const res = await worker.tick();

  assert.deepEqual(
    { done: res.done, renderId: res.renderId, kind: res.kind, status: res.status, bibleCreated: res.bibleCreated },
    { done: true, renderId: 'r_hero', kind: 'hero', status: 'ok', bibleCreated: true },
  );
  const hero = store.renders[0];
  assert.equal(hero.status, 'ok');
  assert.equal(hero.storageKey, 'projects/p1/out/r_hero.webp');
  assert.equal(blobs.get(hero.storageKey).toString(), 'rendered-bytes');
  // The compliance audit trail, not debug noise.
  assert.equal(hero.promptText, 'PROMPT');
  assert.equal(hero.model, 'gemini-x');
  assert.equal(hero.genAttempts, 2);
  assert.equal(hero.qualityScore, 95);
  assert.equal(hero.consistencyScore, 88);
  assert.equal(typeof hero.durationMs, 'number');

  // The hero is rendered with NO reference image and no bible — it defines the bible.
  assert.equal(staged.length, 1);
  assert.equal(staged[0].refs, null);
  assert.equal(staged[0].params.designBible, undefined);
  assert.equal(staged[0].params.frameRole, 'hero');
  assert.equal(staged[0].req, null, 'there is no request behind a queued render');

  // …and the attach call is what unblocks the room's support frames.
  assert.ok(store.calls.includes('attachBibleToQueuedRenders'));
  assert.equal(store.renders[1].bibleId, 'b1');
  assert.equal(store.bibles[0].heroRenderId, 'r_hero');
});

// ── Usage metering ───────────────────────────────────────────────────────────
// `/stage` only ENQUEUES, so there is no request in scope when the money is actually
// spent. That gap is why this path metered NOTHING: enterprise-domain accounts are
// promoted to `plan: 'pro'`, so they passed the gate and staged whole listings for free.

test('a completed render is metered against its owner, in generation attempts', async () => {
  /** @type {any[]} */
  const metered = [];
  const { worker } = makeWorker({ over: { reportListingUsage: (userId, qty) => metered.push([userId, qty]) } });
  await worker.tick();
  assert.deepEqual(metered, [['u-owner', 2]],
    'quantity is `attempts`, not 1 — a quality-gate retry is a real generation that really cost money');
});

test('metering happens once per completed render, and never for a failed one', async () => {
  /** @type {any[]} */
  const metered = [];
  const { worker } = makeWorker({
    over: {
      reportListingUsage: (userId, qty) => metered.push([userId, qty]),
      processStaging: async () => { throw new Error('model exploded'); },
    },
  });
  const res = await worker.tick();
  assert.notEqual(res.status, 'ok', 'precondition: this tick failed');
  assert.deepEqual(metered, [], 'a render that produced nothing must not be billed');
});

test('a render that vanished mid-flight is not billed', async () => {
  // completeRender matching zero rows means the listing was deleted or superseded while
  // the model was working. Billing there would charge for an image nobody will ever see.
  /** @type {any[]} */
  const metered = [];
  const { worker, store } = makeWorker({
    over: { reportListingUsage: (userId, qty) => metered.push([userId, qty]) },
  });
  store.completeRender = () => null;
  await worker.tick();
  assert.deepEqual(metered, [], 'no meter event for a render whose row was gone');
});

test('a meter that throws does not turn a delivered render into a failed one', async () => {
  // This runs AFTER completeRender has committed. A Stripe outage must not re-queue a
  // paid image; losing events is the right direction to be wrong in.
  const { worker, store } = makeWorker({
    over: { reportListingUsage: () => { throw new Error('stripe is down'); } },
  });
  const res = await worker.tick();
  assert.equal(res.status, 'ok', 'the render still succeeded');
  assert.equal(store.renders[0].status, 'ok');
  assert.equal(store.renders[0].storageKey, 'projects/p1/out/r_hero.webp');
});

test('a worker built without a meter still renders (the seam is optional)', async () => {
  // Every pre-existing test constructs the worker without this dep; it must stay optional
  // rather than becoming a hard dependency that a missing wire turns into a crash.
  const { worker, store } = makeWorker();
  const res = await worker.tick();
  assert.equal(res.status, 'ok');
  assert.equal(store.renders[0].status, 'ok');
});

test('hero renders on the plus-tier image model (listings are a Stagify+ feature)', async () => {
  const { worker, staged } = makeWorker();
  await worker.tick();
  assert.equal(staged[0].model, 'gemini-3.1-flash-image');
});

test('a PNG fallback from the delivery step is stored under a .png key, not mislabelled .webp', async () => {
  const { worker, store, blobs } = makeWorker({ over: { processStaging: async () => PNG_URL } });
  await worker.tick();
  assert.equal(store.renders[0].storageKey, 'projects/p1/out/r_hero.png');
  assert.equal(blobs.get('projects/p1/out/r_hero.png').toString(), 'png-fallback');
});

// ── THE important one: no bible → nothing unconditioned ──────────────────────

test('extractBible returning null renders nothing unconditioned — and does not leave the room queued forever', async () => {
  const { worker, store, staged } = makeWorker({ supportCount: 2, over: { extractBible: async () => null } });

  const first = await worker.tick();
  assert.equal(first.status, 'ok', 'the hero itself still succeeded — only the bible failed');
  assert.equal(first.bibleCreated, false);
  assert.equal(first.blockedFailed, 2, 'both barred support rows were settled, not abandoned');
  assert.equal(first.blockedByMissingBible, 1, 'the since-boot diagnostic still counts the room');
  assert.equal(store.renders[0].status, 'ok');
  assert.equal(staged.length, 1, 'exactly the hero was rendered');
  assert.ok(!store.calls.includes('createBible'));
  assert.ok(!store.calls.includes('attachBibleToQueuedRenders'));

  // THE POINT: the support rows are failed with a code, NOT left queued. Left queued they were
  // structurally unclaimable forever — `queued` stayed non-zero, so the listing never read as
  // finished, the browser polled indefinitely and /stage answered 409 with no way out.
  assert.ok(store.renders.slice(1).every((r) => r.status === 'failed' && r.errorCode === 'BIBLE_MISSING' && r.bibleId === null));
  // …and the failure is bookkeeping only: no support frame may be generated at ANY cost.
  for (let i = 0; i < 5; i += 1) {
    const res = await worker.tick();
    assert.equal(res.done, false, 'the queue is drained, not spinning');
  }
  assert.equal(staged.length, 1, 'processStaging must NOT be called again for a support frame');
  assert.equal(worker.stats().blockedByMissingBible, 1);
  // A listing whose only remaining work was structurally blocked settles at 'ready' with
  // failed frames rather than hanging on 'staging' forever.
  assert.equal(store.project.status, 'ready');
});

test('a blocked room is settled without touching a queued HERO variation of the same room', async () => {
  // failBlockedRendersForRoom must not bury claimable work. A second hero variation is still
  // runnable (and could yet produce the bible), so only non-hero frames may be failed.
  const { worker, store } = makeWorker({ supportCount: 1, over: { extractBible: async () => null } });
  store.renders.push({ id: 'r_hero2', projectId: 'p1', photoId: 'ph_hero', bibleId: null, variation: 2, status: 'queued', storageKey: null, claimedAt: null, createdAt: 9, genAttempts: 0 });

  const res = await worker.tick();
  assert.equal(res.blockedFailed, 1, 'only the support frame');
  assert.equal(store.renders.find((r) => r.id === 'r_hero2').status, 'queued', 'the hero variation is still claimable');
  assert.equal(store.project.status, 'staging', 'and the listing is NOT finished while it is');
  assert.equal((await worker.tick()).renderId, 'r_hero2', 'it runs on the next tick');
});

// ── Support path ─────────────────────────────────────────────────────────────

test('support path passes the bible in stagingParams AND the hero bytes as the reference image', async () => {
  const { worker, store, staged, blobs } = makeWorker();
  await worker.tick(); // hero: renders, creates the bible, unblocks the support frame
  const res = await worker.tick();

  assert.equal(res.kind, 'support');
  assert.equal(res.status, 'ok');
  assert.equal(staged.length, 2);
  const support = staged[1];

  // (1) The structured bible — the locked piece list.
  assert.deepEqual(support.params.designBible, BIBLE_DOC);
  assert.equal(support.params.frameRole, 'support');
  // (2) The hero render's actual pixels, in the extra-image (furniture-reference) slot.
  //     Dropping this argument is exactly the mutation this assertion catches.
  assert.ok(Array.isArray(support.refs), 'the hero render must ride the reference slot');
  assert.equal(support.refs.length, 1);
  assert.equal(support.refs[0].toString(), blobs.get('projects/p1/out/r_hero.webp').toString());
  assert.equal(support.refs[0].toString(), 'rendered-bytes');
  // (3) The source photo being staged is the SUPPORT photo, not the hero's.
  assert.equal(support.buf.toString(), 'bytes-of-ph_s0');
  assert.equal(store.renders[1].status, 'ok');
});

test('support with a missing bible row fails as BIBLE_MISSING rather than rendering blind', async () => {
  const store = fakeStore({
    photos: [{ id: 'ph1', projectId: 'p1', storageKey: 'src/a.jpg', roomKey: 'r1', roomType: 'Living room', frameRole: 'support' }],
    renders: [{ id: 'r1', projectId: 'p1', photoId: 'ph1', bibleId: 'b_gone', variation: 1, status: 'queued', storageKey: null, claimedAt: null, createdAt: 1 }],
  });
  let called = 0;
  const worker = createListingWorker({
    projects: store,
    storage: fakeStorage(new Map([['src/a.jpg', Buffer.from('a')]]), store.calls),
    processStaging: async () => { called += 1; return WEBP_URL; },
    extractBible: async () => BIBLE_DOC,
    getGeminiImageModel: () => 'gemini-x',
  });
  const res = await worker.tick();
  assert.equal(res.status, 'failed');
  assert.equal(res.errorCode, 'BIBLE_MISSING');
  assert.equal(called, 0, 'no paid generation may happen without the bible');
  assert.equal(store.renders[0].status, 'failed');
});

test('support degrades to bible-text-only when the hero blob is gone (still conditioned, never blind)', async () => {
  const { worker, staged, blobs } = makeWorker();
  await worker.tick();
  blobs.delete('projects/p1/out/r_hero.webp'); // the render row survives; the file does not
  const res = await worker.tick();
  assert.equal(res.status, 'ok');
  assert.deepEqual(staged[1].params.designBible, BIBLE_DOC, 'the piece list still conditions the render');
  assert.equal(staged[1].refs, null, 'and no bogus reference image is invented');
});

test('a non-hero frame claimed with no bible fails instead of rendering (barrier backstop)', async () => {
  // The store's WHERE clause should make this unreachable. If it ever regresses, the
  // worker must refuse rather than produce an inconsistent frame.
  const store = fakeStore({
    photos: [{ id: 'ph1', projectId: 'p1', storageKey: 'src/a.jpg', roomKey: 'r1', roomType: 'Living room', frameRole: 'support' }],
    renders: [{ id: 'r1', projectId: 'p1', photoId: 'ph1', bibleId: null, variation: 1, status: 'queued', storageKey: null, claimedAt: null, createdAt: 1 }],
  });
  // Bypass the fake's own barrier to simulate the regression.
  store.claimNextRender = () => { const r = store.renders[0]; r.status = 'running'; return r; };
  let called = 0;
  const worker = createListingWorker({
    projects: store,
    storage: fakeStorage(new Map([['src/a.jpg', Buffer.from('a')]]), store.calls),
    processStaging: async () => { called += 1; return WEBP_URL; },
    extractBible: async () => BIBLE_DOC,
    getGeminiImageModel: () => 'gemini-x',
  });
  const res = await worker.tick();
  assert.equal(res.errorCode, 'BIBLE_MISSING');
  assert.equal(called, 0);
});

test('THE ROLE IS THE PHOTO\'S: a hero row carrying a bibleId still runs as a hero', async () => {
  // The defect this pins. `attachBible` used to stamp every queued render of the room,
  // heroes included, and the worker derived the role as `bibleId ? 'support' : 'hero'` — so a
  // stamped HERO was dispatched down the support path and staged against a bible extracted
  // from a DIFFERENT frame. The `kind === 'hero' && frameRole !== 'hero'` backstop could not
  // fire, because `kind` was already 'support'.
  const { worker, store, staged } = makeWorker({ supportCount: 0 });
  store.renders[0].bibleId = 'b_stale';
  store.bibles.push({ id: 'b_stale', projectId: 'p1', roomKey: 'living-room-1', heroRenderId: 'r_other', doc: BIBLE_DOC });

  const res = await worker.tick();
  assert.equal(res.kind, 'hero', 'the photo says hero, so it is a hero');
  assert.equal(res.status, 'ok');
  assert.equal(staged.length, 1);
  assert.equal(staged[0].params.designBible, undefined, 'a hero is NEVER conditioned on a bible — it authors one');
  assert.equal(staged[0].params.frameRole, 'hero');
  assert.equal(staged[0].refs, null, 'and no other frame\'s render is fed in as a reference');
  assert.ok(store.calls.includes('createBibleAndUnblockRoom'), 'it authored its room\'s bible as normal');
});

// ── A render whose row went away mid-flight (the deleted-listing hole) ────────

test('a DELETE landing mid-render is not counted as a success, and its blob is removed', async () => {
  // storage.write does a mkdir -p, so a render completing after DELETE /api/projects/:id
  // RECREATES the project directory the delete removed and writes a staged photo of a listing
  // the user deleted. completeRender matched 0 rows and returned null; the worker ignored that
  // and reported status 'ok'. Nothing references the file, so no sweep would ever find it.
  const { worker, store, storage, blobs } = makeWorker();
  const realClaim = store.claimNextRender;
  store.claimNextRender = (opts) => {
    const row = realClaim(opts);
    // The DELETE lands while the model is generating: rows go, blobs go with them.
    store.renders.length = 0;
    return row;
  };

  const res = await worker.tick();
  assert.equal(res.status, 'failed');
  assert.equal(res.errorCode, 'RENDER_GONE');
  assert.equal(worker.stats().completed, 0, 'a render of a deleted listing is not a completed render');
  assert.equal(blobs.has('projects/p1/out/r_hero.webp'), false, 'the orphan blob was unlinked');
  assert.ok(store.calls.includes('remove:projects/p1/out/r_hero.webp'), 'and unlinked explicitly, not merely absent');
  assert.deepEqual([...storage.blobs.keys()], ['src/hero.jpg', 'src/s0.jpg'], 'only the source photos the fixture seeded are left');
});

test('an orphan blob that cannot be unlinked is loud, and still not a success', async () => {
  const { worker, store, storage } = makeWorker();
  storage.remove = async () => { throw new Error('EPERM'); };
  const realClaim = store.claimNextRender;
  store.claimNextRender = (opts) => { const row = realClaim(opts); store.renders.length = 0; return row; };

  const res = await worker.tick();
  assert.equal(res.errorCode, 'RENDER_GONE');
  assert.equal(worker.stats().completed, 0);
});

test('RENDER_GONE is terminal — a deleted row must never be requeued', async () => {
  const { worker, store } = makeWorker();
  // Keep the row so the retry path COULD reach it, but make it unwritable the way a newer
  // bible does (superseded), which is the other way completeRender loses the race.
  const realClaim = store.claimNextRender;
  store.claimNextRender = (opts) => {
    const row = realClaim(opts);
    store.renders[0].status = 'superseded';
    return row;
  };
  const res = await worker.tick();
  assert.equal(res.errorCode, 'RENDER_GONE');
  assert.equal(store.renders[0].status, 'superseded', 'a retired render is not dragged back to queued');
  assert.ok(!store.calls.includes('requeueRenderForRetry'));
});

// ── The drift the reviewer flagged, persisted ────────────────────────────────

test('mismatchedSlots is persisted, so the UI can say WHICH pieces drifted', async () => {
  // The pipeline computes it per render and it used to be dropped on the floor, leaving the
  // studio able to show "consistency 88" but not "the sofa and the rug drifted" — which is
  // the only actionable half of that number.
  const { worker, store } = makeWorker({
    over: {
      processStaging: async (buf, params, req, refs, model, outcome) => {
        Object.assign(outcome, { attempts: 1, consistencyScore: 62, mismatchedSlots: ['sofa', 'rug'] });
        return WEBP_URL;
      },
    },
  });
  await worker.tick();
  assert.deepEqual(store.renders[0].extra, { mismatchedSlots: ['sofa', 'rug'] });
  assert.equal(store.renders[0].consistencyScore, 62);
});

test('an outcome with no mismatchedSlots writes no extra at all (it must not clobber the bag)', async () => {
  const { worker, store } = makeWorker({ over: { processStaging: async () => WEBP_URL } });
  await worker.tick();
  assert.equal(store.renders[0].extra, undefined, 'omitted, so the store leaves extra_json alone');
});

// ── Project status: the only thing that ever writes 'ready' ───────────────────

test('the project reaches \'ready\' exactly when nothing is claimable or running', async () => {
  const { worker, store } = makeWorker({ supportCount: 2 });
  assert.equal(store.project.status, 'staging');

  await worker.tick(); // hero: the two support frames become claimable
  assert.equal(store.project.status, 'staging', 'work remains');
  await worker.tick();
  assert.equal(store.project.status, 'staging', 'still one support frame to go');
  await worker.tick();
  assert.equal(store.project.status, 'ready', 'the last render is what settles the listing');
  assert.ok(store.calls.includes('updateProject'));
});

test('a listing that is not \'staging\' is never dragged into \'ready\'', async () => {
  // A stray render finishing must not resurrect an archived listing or promote one that is
  // still being assembled.
  for (const status of ['archived', 'draft', 'ready']) {
    const { worker, store } = makeWorker({ supportCount: 0 });
    store.project.status = status;
    await worker.tick();
    assert.equal(store.project.status, status, `${status} must be left alone`);
  }
});

// ── Failure handling ─────────────────────────────────────────────────────────

test('a thrown processStaging is recorded on the render and tick() does not throw', async () => {
  const boom = Object.assign(new Error('model refused'), { code: 'NO_IMAGE_GENERATED' });
  const { worker, store } = makeWorker({ over: { processStaging: async () => { throw boom; } } });
  const res = await worker.tick();
  assert.equal(res.done, true);
  assert.equal(res.status, 'retrying', 'a refusal from the model is transient, not terminal');
  assert.equal(res.errorCode, 'NO_IMAGE_GENERATED');
  assert.equal(store.renders[0].status, 'queued', 'and the frame is back on the queue');
  assert.equal(store.renders[0].errorCode, 'NO_IMAGE_GENERATED');
  assert.equal(store.renders[0].genAttempts, 1);
  assert.equal(typeof store.renders[0].durationMs, 'number');
  assert.equal(worker.stats().failed, 1);
});

// ── Bounded retry (a transient error must not lose a frame silently) ──────────

test('a transient failure is retried up to MAX_RENDER_ATTEMPTS and only then terminal', async () => {
  // The defect: `failRender` was terminal and nothing ever requeued a failed row, so one 503
  // on frame 2 of 3 gave {ok:2, failed:1} — which read as complete, and the operator was told
  // "staging finished" while silently getting 2 of 3.
  let attempts = 0;
  const { worker, store } = makeWorker({
    over: {
      processStaging: async () => {
        attempts += 1;
        throw Object.assign(new Error('upstream 503'), { code: 'MODEL_UNAVAILABLE' });
      },
    },
  });

  for (let i = 1; i < MAX_RENDER_ATTEMPTS; i += 1) {
    const res = await worker.tick();
    assert.equal(res.status, 'retrying', `attempt ${i} must go back on the queue`);
    assert.equal(store.renders[0].status, 'queued');
    assert.equal(store.renders[0].genAttempts, i, 'and the attempt is counted, or this loops forever');
  }
  const last = await worker.tick();
  assert.equal(last.status, 'failed', 'the budget is spent — now it is terminal');
  assert.equal(store.renders[0].status, 'failed');
  assert.equal(store.renders[0].genAttempts, MAX_RENDER_ATTEMPTS, 'counted exactly once per attempt');
  assert.equal(attempts, MAX_RENDER_ATTEMPTS, 'no more paid calls than the budget allows');
  assert.deepEqual(await worker.tick(), { done: false, blockedByMissingBible: 0 }, 'and it is not retried forever');
  // The listing settles rather than sitting on 'staging' with a dead frame.
  assert.equal(store.project.status, 'ready');
});

test('a MISSING INPUT is terminal on the first failure — retrying it would just re-read the absence', async () => {
  // Each of these is a missing input, not a flaky call: no number of retries makes the photo
  // row, its bytes, or the bible exist. Spending 3 paid attempts to rediscover that is waste.
  const { worker, store } = makeWorker();
  store.photos.length = 0;
  store.claimNextRender = () => { const r = store.renders[0]; r.status = 'running'; return r; };

  const res = await worker.tick();
  assert.equal(res.errorCode, 'PHOTO_MISSING');
  assert.equal(res.status, 'failed', 'not retried');
  assert.equal(store.renders[0].genAttempts, 1);
  assert.ok(!store.calls.includes('requeueRenderForRetry'), 'the retry path is not even entered');
});

test('the retryable/terminal split is explicit and covers every code the worker itself raises', () => {
  for (const code of TERMINAL_ERROR_CODES) assert.equal(isRetryableFailure(code), false, code);
  for (const code of ['MODEL_UNAVAILABLE', 'ECONNRESET', 'SQLITE_BUSY', 'NO_IMAGE_GENERATED', 'ERROR']) {
    assert.equal(isRetryableFailure(code), true, `${code} must stay retryable — an unknown code is transient by default`);
  }
  // The worker's own withCode() calls, so the classification cannot silently miss one.
  for (const code of ['PHOTO_MISSING', 'SOURCE_MISSING', 'BIBLE_MISSING', 'RENDER_GONE']) {
    assert.ok(TERMINAL_ERROR_CODES.includes(code), `${code} is raised by the worker and must be classified`);
  }
});

test('an error with no code falls back to its name, never its message', async () => {
  const { worker, store } = makeWorker({ over: { processStaging: async () => { throw new TypeError('undefined is not a function'); } } });
  const res = await worker.tick();
  assert.equal(res.errorCode, 'TypeError');
  assert.ok(!String(store.renders[0].errorCode).includes('undefined is not'), 'no prose in the stored code');
});

test('a non-image return value fails as NO_IMAGE_GENERATED and stores nothing', async () => {
  const { worker, store, blobs } = makeWorker({ over: { processStaging: async () => 'not-a-data-url' } });
  const res = await worker.tick();
  assert.equal(res.errorCode, 'NO_IMAGE_GENERATED');
  assert.equal(store.renders[0].storageKey, null);
  assert.equal(blobs.has('projects/p1/out/r_hero.webp'), false);
});

test('an empty base64 payload is refused rather than stored as a 0-byte render', async () => {
  const { worker, store, blobs } = makeWorker({ over: { processStaging: async () => 'data:image/webp;base64,' } });
  assert.equal((await worker.tick()).errorCode, 'NO_IMAGE_GENERATED');
  assert.equal(store.renders[0].storageKey, null);
  assert.equal(blobs.has('projects/p1/out/r_hero.webp'), false, 'nothing was written');
});

test('a photo deleted between the claim and the read fails as PHOTO_MISSING', async () => {
  const { worker, store } = makeWorker();
  const realClaim = store.claimNextRender;
  // The real store's JOIN makes an orphaned render unclaimable, so reaching this branch
  // means the row vanished DURING the tick — which a concurrent DELETE can do.
  store.claimNextRender = (opts) => {
    const row = realClaim(opts);
    store.photos.length = 0;
    return row;
  };
  const res = await worker.tick();
  assert.equal(res.errorCode, 'PHOTO_MISSING');
  assert.equal(store.renders[0].status, 'failed');
});

test('an orphaned render is never claimed at all (the store\'s JOIN, mirrored)', async () => {
  const { worker, store } = makeWorker();
  store.photos.length = 0;
  assert.deepEqual(await worker.tick(), { done: false, blockedByMissingBible: 0 });
});

test('unreadable source bytes fail with the storage error\'s own code', async () => {
  const missingBlob = makeWorker();
  missingBlob.blobs.delete('src/hero.jpg');
  const res = await missingBlob.worker.tick();
  assert.equal(res.status, 'failed');
  assert.equal(res.errorCode, 'ENOENT', 'storage.read rejects, and its code is what gets recorded');
});

test('a store that throws while marking the failure still does not throw out of tick()', async () => {
  const { worker, store } = makeWorker({ over: { processStaging: async () => { throw new Error('nope'); } } });
  // Both writers, since a transient failure tries the requeue first.
  store.requeueRenderForRetry = () => { throw new Error('database is locked'); };
  store.failRender = () => { throw new Error('database is locked'); };
  const res = await worker.tick();
  assert.equal(res.status, 'failed', 'the tick still reports the outcome');
});

test('a store that throws while settling the project does not turn a good render into a failure', async () => {
  const { worker, store } = makeWorker();
  store.hasPendingWork = () => { throw new Error('database is locked'); };
  const res = await worker.tick();
  assert.equal(res.status, 'ok', 'the render succeeded; the status write is best-effort');
  assert.equal(store.renders[0].status, 'ok');
});

test('a queue-poll failure is swallowed as an empty tick, not a crash', async () => {
  const { worker, store } = makeWorker();
  store.claimNextRender = () => { throw new Error('SQLITE_BUSY'); };
  assert.deepEqual(await worker.tick(), { done: false, blockedByMissingBible: 0 });
});

// ── Lease / reclaim ──────────────────────────────────────────────────────────

test('reclaimStaleClaims runs BEFORE the claim, so a killed process\'s lease returns to the queue', async () => {
  const { worker, store } = makeWorker();
  // Simulate a process killed mid-render: the row is 'running' with an old lease.
  store.renders[0].status = 'running';
  store.renders[0].claimedAt = Date.now() - (DEFAULT_LEASE_MS + 60_000);

  const res = await worker.tick();
  assert.equal(res.renderId, 'r_hero', 'the stale row must be reclaimed and re-run');
  assert.equal(res.status, 'ok');
  const order = store.calls.filter((c) => c === 'reclaimStaleClaims' || c === 'claimNextRender');
  assert.deepEqual(order.slice(0, 2), ['reclaimStaleClaims', 'claimNextRender'], 'the sweep must come first or the row stays stuck');
});

test('a lease that has NOT expired is left alone', async () => {
  const { worker, store } = makeWorker();
  store.renders[0].status = 'running';
  store.renders[0].claimedAt = Date.now();
  const res = await worker.tick();
  assert.equal(res.done, false, 'a live lease belongs to whoever holds it');
});

test('a custom leaseMs is honoured', async () => {
  const { worker, store } = makeWorker({ over: { leaseMs: 50 } });
  store.renders[0].status = 'running';
  store.renders[0].claimedAt = Date.now() - 500;
  assert.equal((await worker.tick()).renderId, 'r_hero');
});

// ── Job settings ─────────────────────────────────────────────────────────────

test('jobSettings from the project drive the staging params', async () => {
  const { worker, staged } = makeWorker({
    extra: { jobSettings: { furnitureStyle: 'mid-century', additionalPrompt: 'warm light', removeFurniture: true, variationCount: 3 } },
  });
  await worker.tick();
  assert.equal(staged[0].params.furnitureStyle, 'mid-century');
  assert.equal(staged[0].params.additionalPrompt, 'warm light');
  assert.equal(staged[0].params.removeFurniture, true);
  assert.equal(staged[0].params.roomType, 'Living room', 'the photo\'s own room type wins');
});

test('readJobSettings degrades to safe defaults rather than stranding a listing', () => {
  const photo = /** @type {any} */ ({ roomType: 'Bedroom' });
  assert.deepEqual(readJobSettings(null, photo), { roomType: 'Bedroom', furnitureStyle: 'standard', additionalPrompt: '', removeFurniture: false });
  // An absent, non-object, or garbage-typed bag all fall back rather than throwing.
  for (const extra of [null, {}, { jobSettings: null }, { jobSettings: 'nope' }, { jobSettings: { furnitureStyle: 42, removeFurniture: 'true' } }]) {
    const out = readJobSettings(/** @type {any} */ ({ extra }), photo);
    assert.equal(out.furnitureStyle, 'standard');
    assert.equal(out.removeFurniture, false, 'only a real boolean true enables removal');
  }
  assert.equal(readJobSettings(null, null).roomType, 'Living room');
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

test('start() arms an unref\'d interval, is idempotent, and stop() disarms it', async () => {
  const { worker } = makeWorker();
  assert.equal(worker.isRunning(), false);
  worker.start();
  assert.equal(worker.isRunning(), true);
  worker.start(); // idempotent — a second call must not stack a second timer
  assert.equal(worker.isRunning(), true);
  worker.stop();
  assert.equal(worker.isRunning(), false);
  worker.stop(); // also idempotent
  assert.equal(worker.isRunning(), false);
});

test('the interval drains the queue without overlapping ticks', async () => {
  // Serial is the design: two concurrent generations would double the cost ceiling.
  let concurrent = 0;
  let peak = 0;
  const { worker, store } = makeWorker({
    supportCount: 2,
    over: {
      intervalMs: 5,
      processStaging: async (buf, params, req, refs, model, outcome) => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((r) => setTimeout(r, 20));
        concurrent -= 1;
        if (outcome) outcome.attempts = 1;
        return WEBP_URL;
      },
    },
  });
  worker.start();
  const deadline = Date.now() + 3000;
  while (store.renders.some((r) => r.status !== 'ok') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  worker.stop();
  assert.ok(store.renders.every((r) => r.status === 'ok'), 'every frame must finish');
  assert.equal(peak, 1, 'ticks must never overlap');
  assert.equal(worker.stats().completed, 3);
});

test('the exported defaults are the documented ones', () => {
  assert.equal(DEFAULT_INTERVAL_MS, 2000);
  assert.equal(MAX_RENDER_ATTEMPTS, 3);
});

test('the lease is the STORE\'s constant, not a second copy', () => {
  // The worker used to declare its own 5-minute lease against the store's documented
  // 10 minutes, and the worker's value is the one that governs (it is what gets passed to
  // reclaimStaleClaims) — so the store's "generous on purpose, a duplicate render costs a
  // paid API call" was fiction. Identity, not equality: two equal literals drift again.
  assert.equal(DEFAULT_LEASE_MS, STORE_LEASE_MS);
  assert.equal(DEFAULT_LEASE_MS, 10 * 60 * 1000, 'and it is the store\'s generous value that survived');
});

// ── Render-log attribution (GDPR) ────────────────────────────────────────────

test('the listing owner reaches the staging call, so its CSV row is erasable', async () => {
  // The row prompt_logs.csv gets for a listing render used to say `email: unknown`, because
  // the worker renders with `req: null` and every attribution field fell back. That is not
  // untidiness: lib/data/user-deletion.js matches that file on the EMAIL cell, so a GDPR
  // erasure could never find those rows — while the row itself carries `additionalPrompt`
  // verbatim, which for a listing agent routinely holds an address and client notes.
  const { worker, staged } = makeWorker({
    over: { resolveOwnerEmail: (userId) => (userId === 'u-owner' ? 'seller@example.com' : '') },
  });
  const result = await worker.tick();
  assert.equal(result.status, 'ok');
  assert.equal(staged[0].params.ownerEmail, 'seller@example.com');
});

test('no resolver, or one that throws, still renders — attribution is best-effort', async () => {
  // The seam is optional on purpose: every pre-existing caller builds this worker without
  // it, and a lookup failure must never cost the customer a paid render. It degrades to the
  // old 'unknown' behaviour rather than failing the frame.
  const without = makeWorker();
  assert.equal((await without.worker.tick()).status, 'ok');
  assert.equal(without.staged[0].params.ownerEmail, undefined);

  const throwing = makeWorker({
    over: { resolveOwnerEmail: () => { throw new Error('store is down'); } },
  });
  assert.equal((await throwing.worker.tick()).status, 'ok');
  assert.equal(throwing.staged[0].params.ownerEmail, undefined);
});
