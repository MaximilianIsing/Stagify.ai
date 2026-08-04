// lib/staging/render-persistence.js — turning a finished render into a gallery entry.
//
// THE CONTRACT THIS FILE EXISTS TO PIN: a history feature must never be able to damage
// a paid render. The user has already waited a minute and already has their image — it
// is in the response. So a store that throws, a store that hangs, a source photo that
// will not decode, and a reference upload that fails all have to degrade to "the entry
// is missing from the gallery" and nothing else. Those are the tests below; the happy
// path is almost incidental.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createAuthStore } from '../../lib/data/auth-store.js';
import { getDb, closeDb } from '../../lib/data/db.js';
import { createStagedRenders } from '../../lib/data/staged-renders.js';
import { createRenderRefs } from '../../lib/data/render-refs.js';
import { createRenderPersistence, ENCODES } from '../../lib/staging/render-persistence.js';
import { createLocalObjectStore } from '../../lib/data/object-store-local.js';
import { createDisabledObjectStore } from '../../lib/data/object-store.js';
import { keyForRender } from '../../lib/data/object-keys.js';

const dirs = [];
const stores = [];

afterEach(() => {
  while (stores.length) { try { stores.pop().close(); } catch { /* already closed */ } }
  while (dirs.length) {
    const d = dirs.pop();
    try { closeDb(d); } catch { /* not open */ }
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ }
  }
});

/** A real PNG, so sharp has something genuine to decode. */
async function png(width = 1024, height = 683) {
  return sharp({ create: { width, height, channels: 3, background: { r: 120, g: 140, b: 160 } } })
    .png()
    .toBuffer();
}

function setup({ objectStore } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-persist-'));
  dirs.push(dir);
  const authStore = createAuthStore(dir);
  stores.push(authStore);
  const stagedRenders = createStagedRenders(dir);
  const renderRefs = createRenderRefs(dir);
  const store = objectStore ?? createLocalObjectStore({ baseDir: dir, secret: 's' });
  const persistence = createRenderPersistence({ objectStore: store, stagedRenders, renderRefs });
  const start = authStore.startRegistration('seller@example.com', 'CorrectHorse9!');
  const { user } = authStore.completeRegistration('seller@example.com', start.code);
  return { dir, db: getDb(dir), stagedRenders, renderRefs, persistence, store, user };
}

// ---- the happy path ---------------------------------------------------------------

test('a render becomes a visible gallery entry once its bytes land', async () => {
  const { persistence, stagedRenders, store, user } = setup();
  const native = await png();

  const pending = persistence.recordPending({
    user, isPro: true, natives: [{ buffer: native }],
    params: { roomType: 'Bedroom', furnitureStyle: 'modern' }, model: 'gemini',
  });
  assert.equal(pending.entries.length, 1);
  assert.equal(stagedRenders.get(pending.entries[0].id).status, 'pending', 'not visible yet');

  const res = await persistence.uploadInBackground({
    entries: pending.entries, sourceBuffer: await png(1920, 1080), user,
  });
  assert.deepEqual(res, { ok: 1, failed: 0 });

  const [row] = stagedRenders.listForUser({ userId: user.id });
  assert.equal(row.id, pending.entries[0].id);
  assert.equal(row.room_type, 'Bedroom');
  assert.ok(row.width > 0 && row.height > 0, 'dimensions come from the encoded result');

  const roles = stagedRenders.blobsFor(row.id).map((b) => b.role).sort();
  assert.deepEqual(roles, ['after', 'before', 'thumb']);
  for (const blob of stagedRenders.blobsFor(row.id)) {
    assert.ok(blob.bytes > 0, `${blob.role} recorded a real byte count`);
    assert.ok(await store.head(blob.storage_key), `${blob.role} is actually in the store`);
  }
});

test('the stored result is the NATIVE buffer, not a delivery upscale', async () => {
  // The whole storage argument. upscaleForDelivery enlarges the ~1 MP output to as much
  // as 4096px for the download; storing that would be ~6x the bytes of pure lanczos
  // interpolation carrying no extra detail.
  const { persistence, stagedRenders, store, user } = setup();
  const native = await png(1024, 683);
  const pending = persistence.recordPending({ user, isPro: true, natives: [{ buffer: native }], params: {} });
  await persistence.uploadInBackground({ entries: pending.entries, user });

  const after = stagedRenders.blobsFor(pending.entries[0].id).find((b) => b.role === 'after');
  const meta = await sharp(await store.get(after.storage_key)).metadata();
  assert.ok(meta.width <= ENCODES.after.maxEdge, 'never enlarged past the cap');
  assert.equal(meta.width, 1024, 'and not enlarged at all — the native size is the master');
  assert.equal(meta.format, 'webp');
});

test('the before photo is never stored larger than the after', async () => {
  // A 1600px "before" beside a 1024px "after" is backwards: it is only ever viewed in a
  // comparison against the result.
  const { persistence, stagedRenders, store, user } = setup();
  const pending = persistence.recordPending({
    user, isPro: true, natives: [{ buffer: await png(1024, 683) }], params: {},
  });
  await persistence.uploadInBackground({ entries: pending.entries, sourceBuffer: await png(4000, 3000), user });

  const blobs = stagedRenders.blobsFor(pending.entries[0].id);
  const before = await sharp(await store.get(blobs.find((b) => b.role === 'before').storage_key)).metadata();
  assert.ok(before.width <= ENCODES.before.maxEdge);
});

test('every variation of one request gets its own entry', async () => {
  const { persistence, stagedRenders, user } = setup();
  const natives = [{ buffer: await png() }, { buffer: await png() }, { buffer: await png() }];
  const pending = persistence.recordPending({ user, isPro: true, natives, params: {}, batchId: 'batch-1' });
  await persistence.uploadInBackground({ entries: pending.entries, user });

  const rows = stagedRenders.listForUser({ userId: user.id });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.variation).sort(), [0, 1, 2]);
  assert.deepEqual([...new Set(rows.map((r) => r.batch_id))], ['batch-1']);
});

// ---- failure isolation, which is the point ----------------------------------------

test('a store that throws on every put leaves the render untouched', async () => {
  const throwing = {
    configured: true, backend: 'broken',
    async put() { throw Object.assign(new Error('R2 down'), { code: 'ER2' }); },
    async get() { throw new Error('no'); },
    async remove() { return false; },
    async head() { return null; },
    presignGet() { return ''; },
  };
  const { persistence, stagedRenders, user } = setup({ objectStore: throwing });
  const pending = persistence.recordPending({ user, isPro: true, natives: [{ buffer: await png() }], params: {} });

  const res = await persistence.uploadInBackground({ entries: pending.entries, user });
  assert.deepEqual(res, { ok: 0, failed: 1 });
  // Absent from the gallery rather than a broken image — the manifest filters on `ok`.
  assert.deepEqual(stagedRenders.listForUser({ userId: user.id }), []);
  assert.equal(stagedRenders.get(pending.entries[0].id).status, 'pending');
});

test('uploadInBackground NEVER rejects, whatever the store does', async () => {
  // It is called as `void uploadInBackground(...)` from the response path. An unhandled
  // rejection in Node 22 exits the process, so a failed image save must not be able to
  // take the whole server down after a user has already been charged for the render.
  const nasty = {
    configured: true, backend: 'nasty',
    put() { throw new Error('thrown synchronously'); },
    async get() { throw new Error('no'); },
    async remove() { return false; },
    async head() { return null; },
    presignGet() { return ''; },
  };
  const { persistence, user } = setup({ objectStore: nasty });
  const pending = persistence.recordPending({ user, isPro: true, natives: [{ buffer: await png() }], params: {} });
  await assert.doesNotReject(() => persistence.uploadInBackground({ entries: pending.entries, user }));

  // ...including when the entries themselves are nonsense.
  await assert.doesNotReject(() => persistence.uploadInBackground({ entries: [{ id: 'x', native: null }], user }));
  await assert.doesNotReject(() => persistence.uploadInBackground({ entries: [], user }));
});

test('a source photo that will not decode costs the slider, not the entry', async () => {
  const { persistence, stagedRenders, user } = setup();
  const pending = persistence.recordPending({ user, isPro: true, natives: [{ buffer: await png() }], params: {} });

  const res = await persistence.uploadInBackground({
    entries: pending.entries, sourceBuffer: Buffer.from('not an image at all'), user,
  });
  assert.deepEqual(res, { ok: 1, failed: 0 }, 'the render still lands');
  const roles = stagedRenders.blobsFor(pending.entries[0].id).map((b) => b.role).sort();
  assert.deepEqual(roles, ['after', 'thumb'], 'just no before');
});

test('a failed reference upload does not fail the entry', async () => {
  const { persistence, stagedRenders, user } = setup();
  const pending = persistence.recordPending({ user, isPro: true, natives: [{ buffer: await png() }], params: {} });
  const res = await persistence.uploadInBackground({
    entries: pending.entries,
    refUploads: [{ buffer: Buffer.from('not an image') }],
    user,
  });
  assert.deepEqual(res, { ok: 1, failed: 0 });
  assert.equal(stagedRenders.listForUser({ userId: user.id }).length, 1);
});

test('references are deduped across the variations of one request', async () => {
  // Three variations share one sofa photo: one object, three links.
  const { persistence, renderRefs, user, store } = setup();
  const natives = [{ buffer: await png() }, { buffer: await png() }, { buffer: await png() }];
  const pending = persistence.recordPending({ user, isPro: true, natives, params: {} });
  const sofa = await png(800, 800);

  await persistence.uploadInBackground({ entries: pending.entries, refUploads: [{ buffer: sofa }], user });

  assert.equal(renderRefs.countForUser(user.id), 1, 'one stored object');
  for (const entry of pending.entries) {
    assert.equal(renderRefs.forRender(entry.id).length, 1, 'linked from every variation');
  }
  const [ref] = renderRefs.forRender(pending.entries[0].id);
  assert.ok(await store.head(ref.storage_key));
});

// ---- the off switch ---------------------------------------------------------------

// ---- extra_json: the naming payload ------------------------------------------------

test('recordPending SANITIZES extra, so no call site can skip it', async () => {
  // Every writer goes through this one door, which is where the cleaning belongs — the
  // same argument rename() makes in lib/data/staged-renders.js. Here the handler passes a
  // raw filename with a path and a hostile character, and neither survives.
  const { persistence, stagedRenders, user } = setup();
  const pending = persistence.recordPending({
    user,
    isPro: true,
    natives: [{ buffer: await png() }],
    params: {},
    extra: {
      source: 'exterior',
      qualifier: 'Golden\u202Ehour',
      sourceName: 'C:\\Users\\agent\\Pictures\\412-rosewood.jpg',
    },
  });
  const row = stagedRenders.get(pending.entries[0].id);
  assert.deepEqual(JSON.parse(row.extra_json), {
    source: 'exterior',
    qualifier: 'Golden hour',
    sourceName: '412-rosewood',
  });
});

test('an unrecognised source costs the render its NAME, never its row', async () => {
  const { persistence, stagedRenders, user } = setup();
  const pending = persistence.recordPending({
    user,
    isPro: true,
    natives: [{ buffer: await png() }],
    params: {},
    extra: { source: 'listing-studio', sourceName: 'house.jpg' },
  });
  assert.equal(pending.entries.length, 1, 'the render is still recorded');
  assert.equal(stagedRenders.get(pending.entries[0].id).extra_json, null);
});

test('a writer that passes no extra at all still records the render', async () => {
  // Back-compat with every row already in production, and the shape a fifth writer will
  // have on the day someone forgets. The drift guard is what catches the omission; this
  // asserts it is not ALSO a crash.
  const { persistence, stagedRenders, user } = setup();
  const pending = persistence.recordPending({ user, isPro: true, natives: [{ buffer: await png() }], params: {} });
  assert.equal(stagedRenders.get(pending.entries[0].id).extra_json, null);
});

test('variationBase offsets the variation column for a multi-call batch', async () => {
  // The AI Designer stages up to three DIFFERENT photos per turn, so it calls this once per
  // result rather than once with three natives. Without the offset all three would land as
  // variation 0 of the same batch.
  const { persistence, stagedRenders, user } = setup();
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const pending = persistence.recordPending({
      user, isPro: true, natives: [{ buffer: await png() }], params: {}, batchId: 'turn-1', variationBase: i,
    });
    ids.push(pending.entries[0].id);
  }
  assert.deepEqual(ids.map((id) => stagedRenders.get(id).variation), [0, 1, 2]);
  assert.deepEqual([...new Set(ids.map((id) => stagedRenders.get(id).batch_id))], ['turn-1']);
});

test('a disabled object store makes the whole thing a no-op', async () => {
  // On Render with no R2 the store is disabled. Persistence must not write rows for
  // bytes that will never exist.
  const { persistence, stagedRenders, user } = setup({ objectStore: createDisabledObjectStore() });
  assert.equal(persistence.enabled(), false);
  assert.equal(persistence.recordPending({ user, isPro: true, natives: [{ buffer: await png() }], params: {} }), null);
  assert.deepEqual(await persistence.uploadInBackground({ entries: [], user }), { ok: 0, failed: 0 });
  assert.deepEqual(stagedRenders.listForUser({ userId: user.id }), []);
});

test('an anonymous or absent user stores nothing', () => {
  const { persistence } = setup();
  assert.equal(persistence.recordPending({ user: null, isPro: false, natives: [{ buffer: Buffer.from('x') }], params: {} }), null);
});

test('the free-tier cap still applies through the persistence path', async () => {
  // The cap lives in the store, but this is the path that actually reaches it, so pin
  // that recordPending passes `isPro` through rather than defaulting somebody to Pro.
  const { persistence, stagedRenders, user } = setup();
  const native = await png(64, 64);
  for (let i = 0; i < 25; i += 1) {
    const pending = persistence.recordPending({ user, isPro: false, natives: [{ buffer: native }], params: {} });
    await persistence.uploadInBackground({ entries: pending.entries, user });
  }
  assert.equal(stagedRenders.countForUser(user.id), stagedRenders.FREE_GALLERY_LIMIT);
});

test('eviction is reported back so the UI can say a link stopped working', async () => {
  const { db, persistence, stagedRenders, user } = setup();
  const native = await png(64, 64);
  const ids = [];
  for (let i = 0; i < stagedRenders.FREE_GALLERY_LIMIT; i += 1) {
    const pending = persistence.recordPending({ user, isPro: false, natives: [{ buffer: native }], params: {} });
    await persistence.uploadInBackground({ entries: pending.entries, user });
    ids.push(pending.entries[0].id);
  }
  db.prepare('INSERT INTO gallery_shares (token_hash, render_id, user_id, created_at) VALUES (?, ?, ?, ?)')
    .run('sha256$x', ids[1], user.id, 1);

  const pending = persistence.recordPending({ user, isPro: false, natives: [{ buffer: native }], params: {} });
  assert.equal(pending.evicted.length, 1);
  assert.equal(pending.evicted[0].id, ids[0], 'the shared one is protected, the next oldest goes');
  assert.equal(pending.evicted[0].hadLiveShare, false);
});

test('the planned keys match what actually gets stored', async () => {
  // recordPending writes the after/thumb keys up front so a crash mid-upload leaves rows
  // the stale sweep can tombstone. If the upload used different keys, those rows would
  // point at nothing and the real bytes would be orphaned.
  const { persistence, stagedRenders, store, user } = setup();
  const pending = persistence.recordPending({ user, isPro: true, natives: [{ buffer: await png() }], params: {} });
  const planned = stagedRenders.blobsFor(pending.entries[0].id).map((b) => b.storage_key).sort();
  assert.deepEqual(planned, [
    keyForRender({ renderId: pending.entries[0].id, role: 'after' }),
    keyForRender({ renderId: pending.entries[0].id, role: 'thumb' }),
  ].sort());

  await persistence.uploadInBackground({ entries: pending.entries, user });
  for (const key of planned) assert.ok(await store.head(key), `${key} was planned and must exist`);
});
