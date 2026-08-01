// Tier: unit (real SQLite + a real temp filesystem) — lib/data/project-blob-gc.js.
//
// WHY A SWEEP NEEDS UNUSUALLY CAREFUL TESTS
// This is the only code in the application whose job is to DELETE customers' property
// photographs, and it decides what to delete by absence — a file nobody references. Every
// way that inference can be wrong is a way to destroy a paying customer's work:
//
//   - THE WRITE-THEN-RECORD RACE is the dangerous one and the reason `minAgeMs` exists. The
//     worker writes a render's blob BEFORE `completeRender` writes the row, so for those few
//     seconds a live render is byte-for-byte indistinguishable from an orphan. The test for
//     this is not "young files are skipped" in the abstract — it reproduces the actual
//     interleaving: blob on disk, row not yet written, sweep runs.
//   - REFERENCED FILES MUST SURVIVE, from BOTH columns. A sweep that read only `renders`
//     would delete every uploaded source photo in the account.
//   - DRY RUN MUST NOT DELETE. It is the default, and an operator will trust the number
//     before they trust the tool.
//   - IT MUST NOT LEAVE THE PROJECTS ROOT, and must not touch anything that does not match
//     the storage layout — a stray file is somebody else's, and absence of a row is not
//     evidence about it.
//
// Real files in a temp dir, because the whole subject is what is on disk.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectBlobGc, liveKeys, DEFAULT_MIN_AGE_MS } from '../../lib/data/project-blob-gc.js';
import { createProjects } from '../../lib/data/projects.js';
import { createProjectStorage } from '../../lib/data/project-storage.js';
import { closeDb, getDb } from '../../lib/data/db.js';

const NOW = Date.UTC(2026, 6, 31, 12);
const OWNER = 'u_broker';
const PROJECT_ID = 'a'.repeat(32);

const dirs = [];

/** A store, a blob store and a sweeper over one fresh data dir. */
function harness({ now = () => NOW } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-gc-'));
  dirs.push(dir);
  return {
    dir,
    projects: createProjects(dir),
    storage: createProjectStorage({ baseDir: dir }),
    gc: createProjectBlobGc({ baseDir: dir, now }),
  };
}

/** Write a blob and backdate it, so age is a property of the test rather than of the clock. */
async function writeBlob(h, key, bytes = 'pixels', ageMs = DEFAULT_MIN_AGE_MS * 2) {
  await h.storage.write(key, Buffer.from(bytes));
  const abs = h.storage.absolutePathFor(key);
  const when = new Date(NOW - ageMs);
  fs.utimesSync(abs, when, when);
  return key;
}

const keyFor = (h, kind, id, ext = 'webp') => h.storage.keyFor({ projectId: PROJECT_ID, kind, id, ext });

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    // Windows cannot unlink the .db/-wal/-shm files while the shared handle is open.
    closeDb(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── The race ────────────────────────────────────────────────────────────────

test('a render written seconds ago with no row YET is never touched', () => {
  // THE test. This is the exact interleaving the worker produces: `storage.write` has
  // happened, `completeRender` has not. The blob is unreferenced and is NOT an orphan.
  // A sweep without the age floor deletes the image a customer is waiting for.
  const h = harness();
  const key = keyFor(h, 'out', 'b'.repeat(32));
  return writeBlob(h, key, 'in-flight', 2000).then(async () => {
    const report = await h.gc.sweep({ apply: true });
    assert.equal(report.tooYoung, 1, 'counted, so an operator can see the sweep held back');
    assert.equal(report.orphans, 0, 'and NOT called an orphan');
    assert.equal(report.removed, 0);
    assert.equal(fs.existsSync(h.storage.absolutePathFor(key)), true, 'the render must survive');
  });
});

test('the floor is the file\'s own mtime, so it survives a restart mid-sweep', async () => {
  const h = harness();
  const young = await writeBlob(h, keyFor(h, 'out', 'c'.repeat(32)), 'young', 60 * 1000);
  const old = await writeBlob(h, keyFor(h, 'out', 'd'.repeat(32)), 'old', DEFAULT_MIN_AGE_MS + 1000);

  const report = await h.gc.sweep({ apply: true });
  assert.equal(report.removed, 1);
  assert.equal(fs.existsSync(h.storage.absolutePathFor(young)), true);
  assert.equal(fs.existsSync(h.storage.absolutePathFor(old)), false);
});

test('minAgeMs is configurable, and 0 sweeps everything unreferenced', async () => {
  const h = harness();
  const key = await writeBlob(h, keyFor(h, 'out', 'e'.repeat(32)), 'fresh', 0);
  assert.equal((await h.gc.sweep({ apply: true })).removed, 0, 'the default protects it');
  assert.equal((await h.gc.sweep({ apply: true, minAgeMs: 0 })).removed, 1, 'an explicit 0 does not');
  assert.equal(fs.existsSync(h.storage.absolutePathFor(key)), false);
});

// ── What must survive ───────────────────────────────────────────────────────

test('a referenced SOURCE photo survives — the sweep reads both columns', async () => {
  // Reading only `renders` would delete every uploaded photo in the account.
  const h = harness();
  const project = h.projects.createProject({ userId: OWNER, title: 'Listing', now: NOW });
  const key = keyFor(h, 'src', 'f'.repeat(32));
  await writeBlob(h, key);
  const added = h.projects.addPhoto({ projectId: project.id, storageKey: key, sha256: 'sha-1', now: NOW });
  assert.equal(added.ok, true, 'precondition');

  const report = await h.gc.sweep({ apply: true });
  assert.equal(report.orphans, 0);
  assert.equal(fs.existsSync(h.storage.absolutePathFor(key)), true);
});

test('a referenced RENDER survives', async () => {
  const h = harness();
  const project = h.projects.createProject({ userId: OWNER, title: 'Listing', now: NOW });
  const src = keyFor(h, 'src', '1'.repeat(32));
  await writeBlob(h, src);
  const photo = h.projects.addPhoto({ projectId: project.id, storageKey: src, sha256: 'sha-2', now: NOW });
  const render = h.projects.enqueueRender({ projectId: project.id, photoId: photo.photo.id, now: NOW });
  const out = keyFor(h, 'out', '2'.repeat(32));
  await writeBlob(h, out);
  h.projects.claimNextRender({ now: NOW });
  h.projects.completeRender(render.id, { storageKey: out, now: NOW });

  const report = await h.gc.sweep({ apply: true });
  assert.equal(report.orphans, 0, 'both the source and the render are referenced');
  assert.equal(fs.existsSync(h.storage.absolutePathFor(out)), true);
});

test('the blob a deleted listing left behind IS reclaimed — the leak this exists for', async () => {
  // DELETE removes rows first and blobs second, on purpose. A crash or a failed unlink
  // between the two leaves exactly this: a file with no row, forever.
  const h = harness();
  const project = h.projects.createProject({ userId: OWNER, title: 'Listing', now: NOW });
  const key = keyFor(h, 'out', '3'.repeat(32));
  await writeBlob(h, key);
  const photo = h.projects.addPhoto({ projectId: project.id, storageKey: key, sha256: 'sha-3', now: NOW });
  assert.equal(photo.ok, true);

  // Rows go; the unlink "fails" (we simply do not call it).
  h.projects.deleteProject(project.id);
  assert.equal(fs.existsSync(h.storage.absolutePathFor(key)), true, 'precondition: the file leaked');

  const report = await h.gc.sweep({ apply: true });
  assert.equal(report.removed, 1);
  assert.equal(report.bytes > 0, true, 'and reports the space reclaimed');
  assert.equal(fs.existsSync(h.storage.absolutePathFor(key)), false);
});

// ── Dry run ─────────────────────────────────────────────────────────────────

test('a sweep reports without deleting unless it is told to apply', async () => {
  const h = harness();
  const key = await writeBlob(h, keyFor(h, 'out', '4'.repeat(32)));

  const dry = await h.gc.sweep();
  assert.equal(dry.orphans, 1, 'it says what it would do');
  assert.equal(dry.removed, 0, 'and does none of it');
  assert.deepEqual(dry.sample, [key], 'with a sample an operator can eyeball');
  assert.equal(fs.existsSync(h.storage.absolutePathFor(key)), true);

  // `apply: 'yes'` is not `true`. A truthy string must not delete anything.
  const fuzzy = await h.gc.sweep({ apply: /** @type {any} */ ('yes') });
  assert.equal(fuzzy.removed, 0, 'apply is strictly boolean true');
  assert.equal(fs.existsSync(h.storage.absolutePathFor(key)), true);

  assert.equal((await h.gc.sweep({ apply: true })).removed, 1);
});

test('the sample is bounded, so a listing full of orphans cannot flood the response', async () => {
  const h = harness();
  for (let i = 0; i < 25; i += 1) {
    await writeBlob(h, keyFor(h, 'out', String(i).padStart(32, '0')));
  }
  const report = await h.gc.sweep();
  assert.equal(report.orphans, 25);
  assert.equal(report.sample.length, 20);
  assert.equal((await h.gc.sweep({ sampleLimit: 3 })).sample.length, 3);
});

// ── What it refuses to touch ────────────────────────────────────────────────

test('anything that does not match the storage layout is skipped, never deleted', async () => {
  const h = harness();
  const root = path.join(h.dir, 'data', 'projects');
  fs.mkdirSync(path.join(root, PROJECT_ID, 'out'), { recursive: true });
  // A loose file at the root, and a directory that is not a project id.
  fs.writeFileSync(path.join(root, 'README.txt'), 'not ours');
  fs.mkdirSync(path.join(root, 'not-a-project-id', 'out'), { recursive: true });
  const stray = path.join(root, 'not-a-project-id', 'out', 'x.webp');
  fs.writeFileSync(stray, 'not ours either');
  // BACKDATED deliberately. Left fresh, the age floor would refuse it and this test would
  // pass with the layout check DELETED — the second guard masking the first. Mutation
  // testing caught exactly that, so the stray has to be old enough that only the layout
  // check can save it.
  const old = new Date(NOW - DEFAULT_MIN_AGE_MS * 2);
  fs.utimesSync(stray, old, old);

  const report = await h.gc.sweep({ apply: true });
  assert.equal(fs.existsSync(path.join(root, 'README.txt')), true, 'a loose file is not this module\'s to delete');
  assert.equal(fs.existsSync(path.join(root, 'not-a-project-id', 'out', 'x.webp')), true,
    'nor is a file under a directory that cannot be a project id');
  assert.equal(report.removed, 0);
  assert.ok(report.skipped >= 1, 'and the operator is told something was skipped');
});

test('a missing projects directory is a clean zero, not a crash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-gc-'));
  dirs.push(dir);
  const gc = createProjectBlobGc({ baseDir: dir, now: () => NOW });
  assert.deepEqual(await gc.sweep({ apply: true }),
    { scanned: 0, orphans: 0, removed: 0, bytes: 0, tooYoung: 0, skipped: 0, sample: [] });
});

// ── liveKeys ────────────────────────────────────────────────────────────────

test('liveKeys reads both columns and is case-insensitive', async () => {
  const h = harness();
  const project = h.projects.createProject({ userId: OWNER, title: 'Listing', now: NOW });
  const src = keyFor(h, 'src', '5'.repeat(32));
  await writeBlob(h, src);
  const photo = h.projects.addPhoto({ projectId: project.id, storageKey: src, sha256: 'sha-5', now: NOW });
  const render = h.projects.enqueueRender({ projectId: project.id, photoId: photo.photo.id, now: NOW });
  const out = keyFor(h, 'out', '6'.repeat(32));
  h.projects.claimNextRender({ now: NOW });
  h.projects.completeRender(render.id, { storageKey: out, now: NOW });

  const keys = liveKeys(getDb(h.dir));
  assert.equal(keys.has(src.toLowerCase()), true);
  assert.equal(keys.has(out.toLowerCase()), true);
  assert.equal(keys.size, 2, 'and nothing else');
});

test('a NULL storage_key contributes nothing rather than an empty key', () => {
  // A queued render has no storage_key yet. An empty string in the live set would make
  // every orphan look referenced — the sweep would silently stop working.
  const h = harness();
  const project = h.projects.createProject({ userId: OWNER, title: 'Listing', now: NOW });
  const src = keyFor(h, 'src', '7'.repeat(32));
  const photo = h.projects.addPhoto({ projectId: project.id, storageKey: src, sha256: 'sha-7', now: NOW });
  h.projects.enqueueRender({ projectId: project.id, photoId: photo.photo.id, now: NOW });

  const keys = liveKeys(getDb(h.dir));
  assert.equal(keys.has(''), false);
  assert.equal(keys.size, 1, 'only the photo, not the queued render');
});

// ── Resilience ──────────────────────────────────────────────────────────────

test('a nested directory inside src/ or out/ is skipped, not recursed into', async () => {
  // The layout is fixed at projects/<id>/{src,out}/<file>. Anything deeper was not written
  // by this app, and a sweep that walked into it would be deleting by absence of evidence
  // about files it knows nothing about.
  const h = harness();
  const root = path.join(h.dir, 'data', 'projects');
  // The directory is NAMED like a legal key on purpose. Called `thumbs` it would be caught
  // by the layout check instead, and this test would pass with the isFile() check deleted —
  // the second guard masking the first, which mutation testing caught here once already.
  const nested = path.join(root, PROJECT_ID, 'out', `${'e'.repeat(32)}.webp`);
  fs.mkdirSync(nested, { recursive: true });
  const buried = path.join(nested, 'deep.webp');
  fs.writeFileSync(buried, 'not ours');
  const old = new Date(NOW - DEFAULT_MIN_AGE_MS * 2);
  fs.utimesSync(buried, old, old);
  fs.utimesSync(nested, old, old);

  const report = await h.gc.sweep({ apply: true });
  assert.equal(report.scanned, 0, 'a directory is not a file and must not even be scanned');
  assert.equal(report.orphans, 0);
  assert.equal(report.removed, 0);
  assert.equal(report.skipped >= 1, true, 'the directory is reported');
  assert.equal(fs.existsSync(buried), true, 'and what is under it is untouched');
  assert.equal(fs.existsSync(nested), true);
});

test('one file that cannot be unlinked does not abandon the rest of the reclaim', async () => {
  // A locked or permission-denied file must cost exactly itself. Aborting the sweep would
  // mean one stuck blob permanently blocks reclaiming everything behind it — which on a
  // filling disk is the moment the reclaim is needed most.
  const h = harness();
  const stuck = await writeBlob(h, keyFor(h, 'out', '8'.repeat(32)), 'stuck');
  const fine = await writeBlob(h, keyFor(h, 'out', '9'.repeat(32)), 'fine');

  const realUnlink = fs.promises.unlink;
  const stuckPath = h.storage.absolutePathFor(stuck);
  // @ts-expect-error — swapping a promises API member for the duration of one call.
  fs.promises.unlink = async (target, ...rest) => {
    if (String(target) === stuckPath) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    return realUnlink(target, ...rest);
  };
  try {
    // `sweep` must RESOLVE, not reject: an unlink failure that propagates would abandon
    // every candidate behind it in the walk.
    const report = await h.gc.sweep({ apply: true });
    assert.equal(report.orphans, 2, 'both were identified');
    assert.equal(report.removed, 1, 'and the reclaimable one was still reclaimed');
  } finally {
    // @ts-expect-error — restoring the real implementation.
    fs.promises.unlink = realUnlink;
  }
  assert.equal(fs.existsSync(stuckPath), true, 'the stuck file is left for the next sweep');
  assert.equal(fs.existsSync(h.storage.absolutePathFor(fine)), false);
});
