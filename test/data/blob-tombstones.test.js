// lib/data/blob-tombstones.js — the queue of object bytes owed a deletion.
//
// The tests that matter here are the failure ones. The whole point of this table is
// that an erasure's promise survives things that would otherwise silently break it: R2
// being down, the process dying between two deletes, a network partition. If a failed
// delete quietly dropped its queue entry, an account would look erased while its room
// photographs stayed in the bucket forever — and no existing test would notice, because
// the rows really would be gone.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuthStore } from '../../lib/data/auth-store.js';
import { createMemory } from '../../lib/data/memory.js';
import { getDb, closeDb } from '../../lib/data/db.js';
import { createBlobTombstones, createBlobReaper } from '../../lib/data/blob-tombstones.js';
import { createUserDeletion } from '../../lib/data/user-deletion.js';
import { keyForRender, keyForRef } from '../../lib/data/object-keys.js';

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

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-tombstones-'));
  dirs.push(dir);
  const authStore = createAuthStore(dir);
  stores.push(authStore);
  // Erasure spans tables owned by several factories; `memories` comes from this one,
  // and USER_ID_TABLES prepares a DELETE against it unconditionally.
  createMemory({ __dirname: dir, DEBUG_MODE: false });
  const logDir = path.join(dir, 'data');
  fs.mkdirSync(logDir, { recursive: true });
  const db = getDb(dir);
  // The Phase C tables, created here so erasure has something to tombstone FROM. The
  // shapes match lib/data/staged-renders.js; only the columns this path reads matter.
  db.exec(`
    CREATE TABLE IF NOT EXISTS render_blobs (render_id TEXT, role TEXT, storage_key TEXT, bytes INTEGER, user_id TEXT);
    CREATE TABLE IF NOT EXISTS ref_objects (ref_hash TEXT PRIMARY KEY, storage_key TEXT, user_id TEXT);
  `);
  const tombstones = createBlobTombstones(dir);
  return { dir, db, authStore, logDir, tombstones };
}

/** Register + verify an account, returning the user row. */
function makeUser(authStore, email = 'seller@example.com') {
  const start = authStore.startRegistration(email, 'CorrectHorse9!');
  const done = authStore.completeRegistration(email, start.code);
  assert.ok(done.ok, 'fixture user must register');
  return done.user;
}

/** An object store that records what it was asked to delete and can be made to fail. */
function fakeStore({ failWith = null, configured = true } = {}) {
  const removed = [];
  return {
    removed,
    configured,
    backend: 'fake',
    async put(key, buffer) { return { key, bytes: buffer.length }; },
    async get() { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); },
    async remove(key) {
      if (failWith) throw failWith;
      removed.push(key);
      return true;
    },
    async head() { return null; },
    presignGet() { return ''; },
  };
}

const KEY_A = keyForRender({ renderId: 'a'.repeat(32), role: 'after' });
const KEY_B = keyForRender({ renderId: 'a'.repeat(32), role: 'thumb' });

test('enqueue is idempotent, so racing erasures cannot double-queue', () => {
  const { tombstones } = setup();
  assert.equal(tombstones.enqueue([KEY_A, KEY_B]), 2);
  assert.equal(tombstones.enqueue([KEY_A]), 0, 'INSERT OR IGNORE — the key is the primary key');
  assert.equal(tombstones.pending(), 2);
});

test('enqueue refuses a key the store would reject anyway', () => {
  // A malformed storage_key means something upstream built a key it should not have.
  // Queuing it would park a permanently-terminal row at the head of the queue.
  const { tombstones } = setup();
  assert.equal(tombstones.enqueue(['../../auth-store.db', '']), 0);
  assert.equal(tombstones.pending(), 0);
});

test('a successful drain clears the queue', async () => {
  const { tombstones } = setup();
  tombstones.enqueue([KEY_A, KEY_B]);
  const store = fakeStore();
  const reaper = createBlobReaper({ tombstones, objectStore: store });

  const res = await reaper.drain();
  assert.deepEqual(res, { attempted: 2, deleted: 2, failed: 0 });
  assert.deepEqual(store.removed.sort(), [KEY_A, KEY_B].sort());
  assert.equal(tombstones.pending(), 0);
});

test('an object that was already gone still counts as done', async () => {
  // `remove` answers false for something absent. The obligation was "make sure this is
  // not there", so false is success — treating it as a failure would mean a row that
  // can never drain.
  const { tombstones } = setup();
  tombstones.enqueue([KEY_A]);
  const store = { ...fakeStore(), async remove() { return false; } };
  const reaper = createBlobReaper({ tombstones, objectStore: store });
  assert.deepEqual(await reaper.drain(), { attempted: 1, deleted: 1, failed: 0 });
  assert.equal(tombstones.pending(), 0);
});

test('a failing store keeps the obligation and records why', async () => {
  const { tombstones } = setup();
  tombstones.enqueue([KEY_A, KEY_B]);
  const boom = Object.assign(new Error('R2 is down'), { code: 'ER2', status: 500 });
  const reaper = createBlobReaper({ tombstones, objectStore: fakeStore({ failWith: boom }) });

  const res = await reaper.drain();
  assert.deepEqual(res, { attempted: 2, deleted: 2 - 2, failed: 2 });
  assert.equal(tombstones.pending(), 2, 'the queue must survive the outage');

  const rows = tombstones.take();
  for (const row of rows) {
    assert.equal(row.attempts, 1);
  }
});

test('the queue drains once the store recovers', async () => {
  const { tombstones } = setup();
  tombstones.enqueue([KEY_A]);
  const down = createBlobReaper({ tombstones, objectStore: fakeStore({ failWith: new Error('down') }) });
  await down.drain();
  assert.equal(tombstones.pending(), 1);

  const healthy = fakeStore();
  await createBlobReaper({ tombstones, objectStore: healthy }).drain();
  assert.equal(tombstones.pending(), 0);
  assert.deepEqual(healthy.removed, [KEY_A]);
});

test('a terminal failure is dropped rather than retried forever', async () => {
  const { tombstones } = setup();
  tombstones.enqueue([KEY_A]);
  const terminal = Object.assign(new Error('unsafe key'), { code: 'EUNSAFEKEY' });
  await createBlobReaper({ tombstones, objectStore: fakeStore({ failWith: terminal }) }).drain();
  // A malformed key cannot become well-formed by waiting, so keeping it would poison
  // the head of the queue for every future pass.
  assert.equal(tombstones.pending(), 0);
});

test('drain never rejects, whatever the store does', async () => {
  // It is called as `void reaper.drain()` from a post-commit path and from a
  // setInterval. An unhandled rejection in Node 22 exits the process, so a throwing
  // store must not be able to take the server down mid-erasure.
  const { tombstones } = setup();
  tombstones.enqueue([KEY_A]);
  const nasty = {
    ...fakeStore(),
    async remove() { throw Object.assign(new Error('very bad'), { code: 'ER2' }); },
  };
  await assert.doesNotReject(() => createBlobReaper({ tombstones, objectStore: nasty }).drain());

  const sync = { ...fakeStore(), remove() { throw new Error('thrown synchronously'); } };
  await assert.doesNotReject(() => createBlobReaper({ tombstones, objectStore: sync }).drain());
});

test('drain is a no-op when the object store is disabled', async () => {
  // On Render without R2 the store is disabled; draining would "succeed" against a
  // no-op remove and throw away obligations for bytes that may still exist.
  const { tombstones } = setup();
  tombstones.enqueue([KEY_A]);
  const reaper = createBlobReaper({ tombstones, objectStore: fakeStore({ configured: false }) });
  assert.deepEqual(await reaper.drain(), { attempted: 0, deleted: 0, failed: 0 });
  assert.equal(tombstones.pending(), 1, 'the obligation must survive a disabled store');
});

test('fresh work sorts ahead of repeatedly-failing work', async () => {
  const { tombstones } = setup();
  tombstones.enqueue([KEY_A]);
  await createBlobReaper({ tombstones, objectStore: fakeStore({ failWith: new Error('x') }) }).drain();
  tombstones.enqueue([KEY_B]);
  // A persistent failure must not starve everything queued behind it.
  assert.equal(tombstones.take(1)[0].storage_key, KEY_B);
});

// ---- the erasure integration, which is the reason any of this exists ---------------

test('erasing an account tombstones every object it owns', () => {
  const { dir, db, authStore, logDir } = setup();
  const user = makeUser(authStore);
  const other = makeUser(authStore, 'someone@example.com');

  const rid = 'b'.repeat(32);
  for (const role of ['after', 'before', 'thumb']) {
    db.prepare('INSERT INTO render_blobs (render_id, role, storage_key, user_id) VALUES (?, ?, ?, ?)')
      .run(rid, role, keyForRender({ renderId: rid, role }), user.id);
  }
  db.prepare('INSERT INTO ref_objects (ref_hash, storage_key, user_id) VALUES (?, ?, ?)')
    .run('c'.repeat(64), keyForRef({ refHash: 'c'.repeat(64) }), user.id);
  // Another account's bytes must be untouched.
  db.prepare('INSERT INTO render_blobs (render_id, role, storage_key, user_id) VALUES (?, ?, ?, ?)')
    .run('d'.repeat(32), 'after', keyForRender({ renderId: 'd'.repeat(32), role: 'after' }), other.id);

  const { deleteUser } = createUserDeletion({ baseDir: dir, getDataLogDir: () => logDir });
  const res = deleteUser({ userId: user.id });

  assert.equal(res.ok, true);
  assert.equal(res.rows.blob_tombstones, 4, '3 render blobs + 1 reference');
  assert.equal(res.blobsPending, 4, 'the operator is told what is still owed, not a completion we cannot verify');

  const queued = db.prepare('SELECT storage_key FROM blob_tombstones').all().map((r) => r.storage_key);
  assert.equal(queued.length, 4);
  assert.ok(queued.includes(keyForRender({ renderId: rid, role: 'before' })));
  assert.ok(!queued.some((k) => k.includes('d'.repeat(32))), "another account's bytes must not be queued");

  // NOTE: the render_blobs/ref_objects ROWS are not deleted here yet — those tables join
  // USER_ID_TABLES in lib/data/staged-renders.js, which owns them. The existing
  // "every user-keyed table in the real schema is covered by erasure" guard is what
  // forces that, because both tables carry a user_id column; see
  // test/data/staged-renders.test.js for the assertion that the rows go too.
  // What this test pins is the ordering that makes it possible: the keys are captured
  // INSIDE the transaction, so there is no interleaving where the rows are gone and
  // nothing records which bytes they named.
});

test('an erasure still succeeds when the object store is unreachable', async () => {
  // The bytes are in someone else's datacentre. An outage there must not be able to
  // fail a right-to-erasure request — the obligation is durable, so it can wait.
  const { dir, db, authStore, logDir, tombstones } = setup();
  const user = makeUser(authStore);
  db.prepare('INSERT INTO render_blobs (render_id, role, storage_key, user_id) VALUES (?, ?, ?, ?)')
    .run('e'.repeat(32), 'after', keyForRender({ renderId: 'e'.repeat(32), role: 'after' }), user.id);

  const store = fakeStore({ failWith: Object.assign(new Error('R2 down'), { code: 'ER2' }) });
  const blobReaper = createBlobReaper({ tombstones, objectStore: store });
  const { deleteUser } = createUserDeletion({ baseDir: dir, getDataLogDir: () => logDir, blobReaper });

  const res = deleteUser({ userId: user.id });
  assert.equal(res.ok, true, 'the rows are the part that must be atomic');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(user.id).n, 0);

  // Let the fire-and-forget drain run and fail.
  await new Promise((r) => setImmediate(r));
  assert.equal(tombstones.pending(), 1, 'the obligation outlives the outage');

  await createBlobReaper({ tombstones, objectStore: fakeStore() }).drain();
  assert.equal(tombstones.pending(), 0);
});

test('a reference shared by two renders is queued once', () => {
  // ref_objects is content-addressed, one row per distinct image, so the PRIMARY KEY on
  // blob_tombstones is what keeps a shared reference from being queued twice.
  const { dir, db, authStore, logDir } = setup();
  const user = makeUser(authStore);
  const hash = 'f'.repeat(64);
  db.prepare('INSERT INTO ref_objects (ref_hash, storage_key, user_id) VALUES (?, ?, ?)')
    .run(hash, keyForRef({ refHash: hash }), user.id);
  db.prepare('INSERT INTO render_blobs (render_id, role, storage_key, user_id) VALUES (?, ?, ?, ?)')
    .run('1'.repeat(32), 'after', keyForRef({ refHash: hash }), user.id);

  const { deleteUser } = createUserDeletion({ baseDir: dir, getDataLogDir: () => logDir });
  deleteUser({ userId: user.id });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM blob_tombstones').get().n, 1);
});

test('erasure works in a database that has no gallery tables at all', () => {
  // Erasure is the one path that cannot fail with "no such table". A deployment that
  // has never opened the gallery store — or any of the existing tests — must still be
  // able to erase an account.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-tombstones-bare-'));
  dirs.push(dir);
  const authStore = createAuthStore(dir);
  stores.push(authStore);
  createMemory({ __dirname: dir, DEBUG_MODE: false });
  const logDir = path.join(dir, 'data');
  fs.mkdirSync(logDir, { recursive: true });
  const user = makeUser(authStore, 'nobody@example.com');

  const { deleteUser } = createUserDeletion({ baseDir: dir, getDataLogDir: () => logDir });
  const res = deleteUser({ userId: user.id });
  assert.equal(res.ok, true);
  assert.equal(res.blobsPending, 0);
});
