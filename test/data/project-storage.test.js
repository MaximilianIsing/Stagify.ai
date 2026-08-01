// Tier: unit (real filesystem in a temp dir) — lib/data/project-storage.js.
//
// WHAT THIS COVERS
// The blob half of the Listing Studio: the source photos and renders that are deliberately
// NOT in SQLite. Two things are worth testing here, and they are not equally obvious:
//
//   1. THE PATH ARITHMETIC. A stored `storage_key` is relative (`projects/<pid>/src/<id>.webp`)
//      and its leading segment IS `projectsRoot()`. The first version of this module resolved
//      the raw key against that root, so bytes landed in `<dataDir>/projects/projects/<pid>/…`
//      while `removeProject` deleted `<dataDir>/projects/<pid>/…` — it reported success and
//      removed nothing, which silently defeated GDPR erasure of someone's room photographs.
//      A path-string test would have passed while that was live, so the tests below ROUND-TRIP
//      through the real functions: write bytes, then assert removeProject makes stat() null.
//
//   2. THE TRAVERSAL GATES. These keys come out of the database and will reach an HTTP route
//      that serves bytes back, so `..`, absolute paths, backslashes (this is Windows —
//      path.resolve turns `\` into a separator), percent-encoding and NUL bytes all have to be
//      refused. Both gates are exercised: the regex (isSafeStorageKey) and, separately, the
//      containment check (resolveWithinRoot), because the second one is unreachable while the
//      first holds and would otherwise never be tested at all.
//
// Runs against a throwaway data dir, so no real project data is touched.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createProjectStorage,
  isSafeStorageKey,
  resolveWithinRoot,
  STORAGE_KEY_PATTERN,
  KEY_PREFIX,
} from '../../lib/data/project-storage.js';

const PID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const PHOTO_ID = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const RENDER_ID = 'ffeeddccbbaa99887766554433221100';
const VALID_KEY = `projects/${PID}/src/${PHOTO_ID}.webp`;

const dirs = [];

/** A store on a fresh temp data dir. */
function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-blobs-'));
  dirs.push(dir);
  return { dir, storage: createProjectStorage({ baseDir: dir }) };
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

// ---- keyFor ----------------------------------------------------------------

test('keyFor builds the canonical relative key for both kinds', () => {
  const { storage } = store();
  assert.equal(storage.keyFor({ projectId: PID, kind: 'src', id: PHOTO_ID, ext: 'webp' }), VALID_KEY);
  assert.equal(storage.keyFor({ projectId: PID, kind: 'out', id: RENDER_ID, ext: 'webp' }), `projects/${PID}/out/${RENDER_ID}.webp`);
});

test('keyFor normalises the extension and the id case', () => {
  // Callers hand over '.WEBP', 'webp' and 'JPG' interchangeably; the persisted key must not.
  const { storage } = store();
  assert.equal(storage.keyFor({ projectId: PID, kind: 'src', id: PHOTO_ID, ext: '.WEBP' }), VALID_KEY);
  assert.equal(storage.keyFor({ projectId: PID.toUpperCase(), kind: 'src', id: PHOTO_ID.toUpperCase(), ext: 'webp' }), VALID_KEY);
  assert.equal(storage.keyFor({ projectId: PID, kind: 'src', id: PHOTO_ID, ext: '..jpg' }), `projects/${PID}/src/${PHOTO_ID}.jpg`);
});

test('keyFor refuses to build a key it could not serve back', () => {
  // Throwing beats returning a bad key: a bad key gets persisted into `storage_key` and only
  // surfaces much later, when somebody asks for the image.
  const { storage } = store();
  const bad = [
    { projectId: PID, kind: 'tmp', id: PHOTO_ID, ext: 'webp' },        // unknown kind
    { projectId: '../etc', kind: 'src', id: PHOTO_ID, ext: 'webp' },   // traversal in the id
    { projectId: PID, kind: 'src', id: 'not-hex-id', ext: 'webp' },
    { projectId: PID, kind: 'src', id: PHOTO_ID, ext: '' },            // no extension
    { projectId: PID, kind: 'src', id: PHOTO_ID, ext: 'toolongext' },
    { projectId: 'short', kind: 'src', id: PHOTO_ID, ext: 'webp' },    // id under 8 chars
  ];
  for (const arg of bad) {
    assert.throws(() => storage.keyFor(arg), /project-storage/, `should refuse ${JSON.stringify(arg)}`);
  }
});

// ---- Gate 1: the key regex -------------------------------------------------

test('a well-formed key passes the regex gate', () => {
  assert.equal(isSafeStorageKey(VALID_KEY), true);
  assert.equal(isSafeStorageKey(`projects/${PID}/out/${RENDER_ID}.jpg`), true);
  assert.ok(STORAGE_KEY_PATTERN.test(VALID_KEY), 'the exported pattern and the predicate agree');
});

test('every traversal shape is refused by the regex gate', () => {
  const attacks = [
    '..',
    '../..',
    `projects/${PID}/src/../../../auth-store.db`,
    `projects/../../${PID}/src/${PHOTO_ID}.webp`,
    `projects/${PID}/../out/${RENDER_ID}.webp`,
    '/etc/passwd',                                            // absolute, POSIX
    `/projects/${PID}/src/${PHOTO_ID}.webp`,                  // leading slash
    'C:\\Windows\\System32\\config\\SAM',                     // absolute, Windows
    `C:/data/projects/${PID}/src/${PHOTO_ID}.webp`,           // absolute with a drive letter
    `projects\\${PID}\\src\\${PHOTO_ID}.webp`,                // backslash separators
    `projects/${PID}/src/..\\..\\auth-store.db`,              // backslash traversal
    `projects/%2e%2e/%2e%2e/${PHOTO_ID}.webp`,                // percent-encoded ..
    `projects/${PID}/src/${PHOTO_ID}.webp%00.txt`,            // encoded NUL
    `projects/${PID}/src/${PHOTO_ID}.webp\u0000`,             // real NUL byte
    `projects/${PID}/src/${PHOTO_ID}\u0000.webp`,             // NUL mid-key
    `PROJECTS/${PID}/src/${PHOTO_ID}.webp`,                   // wrong prefix case
    `projects/${PID}/tmp/${PHOTO_ID}.webp`,                   // unknown kind
    `projects/${PID.toUpperCase()}/src/${PHOTO_ID}.webp`,     // uppercase hex
    `projects/${PID}/src/${PHOTO_ID}.webp/extra`,             // trailing segment
    `x/projects/${PID}/src/${PHOTO_ID}.webp`,                 // smuggled prefix
    `projects/${PID}/src/${PHOTO_ID}.webp\nprojects/${PID}/src/${PHOTO_ID}.webp`, // newline
    '',
    'projects/',
  ];
  for (const key of attacks) {
    assert.equal(isSafeStorageKey(key), false, `should refuse ${JSON.stringify(key)}`);
  }
});

test('a non-string key is refused rather than coerced', () => {
  for (const key of [null, undefined, 0, 42, {}, [], true, Symbol('k')]) {
    assert.equal(isSafeStorageKey(/** @type {any} */ (key)), false, `should refuse ${String(key)}`);
  }
});

// ---- Gate 2: containment ---------------------------------------------------

test('resolveWithinRoot refuses anything that lands outside the root', () => {
  // Tested directly because gate 2 is UNREACHABLE while gate 1 holds — no string that passes
  // STORAGE_KEY_PATTERN can resolve outside, since `.`, `\` and `:` are not in any allowed
  // class. That is the point of defence in depth, and the reason this gate needs its own test:
  // it is the one that still holds if the regex is ever loosened.
  const root = path.join(os.tmpdir(), 'stagify-root-check', 'projects');
  const escapes = [
    '..',
    '../..',
    '../../auth-store.db',
    `${PID}/../../../auth-store.db`,   // regex-shaped first segment, escaping tail
    '..\\..\\auth-store.db',           // Windows separators — path.resolve normalises these
    `${PID}\\..\\..\\auth-store.db`,
    path.join(os.tmpdir(), 'elsewhere.db'), // absolute
    '',                                // names the root itself, not something inside it
    '.',
  ];
  for (const relative of escapes) {
    assert.throws(
      () => resolveWithinRoot(root, relative),
      (err) => /** @type {any} */ (err).code === 'EUNSAFEKEY',
      `should refuse ${JSON.stringify(relative)}`,
    );
  }
});

test('resolveWithinRoot allows what is genuinely inside', () => {
  const root = path.join(os.tmpdir(), 'stagify-root-check', 'projects');
  assert.equal(resolveWithinRoot(root, `${PID}/src/${PHOTO_ID}.webp`), path.join(root, PID, 'src', `${PHOTO_ID}.webp`));
  // A traversal that stays inside is fine — the rule is containment, not "no dots".
  assert.equal(resolveWithinRoot(root, `${PID}/src/../out/${RENDER_ID}.webp`), path.join(root, PID, 'out', `${RENDER_ID}.webp`));
});

// ---- Path resolution -------------------------------------------------------

test('absolutePathFor maps a key onto the data dir WITHOUT doubling the projects segment', () => {
  // The regression test for the bug described at the top of this file.
  const { dir, storage } = store();
  const abs = storage.absolutePathFor(VALID_KEY);
  assert.equal(abs, path.join(dir, 'data', 'projects', PID, 'src', `${PHOTO_ID}.webp`));
  assert.equal(abs, path.join(storage.projectsRoot(), PID, 'src', `${PHOTO_ID}.webp`));
  assert.ok(!abs.includes(path.join('projects', 'projects')), 'the key prefix IS projectsRoot(), not a segment under it');
});

test('projectDir and absolutePathFor agree about where a project lives', () => {
  // The actual defect behind the doubling bug was two independently composed paths for one
  // layout. This pins that they come from the same resolver.
  const { storage } = store();
  const abs = storage.absolutePathFor(VALID_KEY);
  assert.equal(storage.projectDir(PID), path.join(storage.projectsRoot(), PID));
  assert.equal(path.dirname(path.dirname(abs)), storage.projectDir(PID), 'a blob sits two levels under its project dir');
});

test('projectsRoot creates the directory on demand', () => {
  const { dir, storage } = store();
  const root = storage.projectsRoot();
  assert.equal(root, path.join(dir, 'data', 'projects'));
  assert.ok(fs.statSync(root).isDirectory());
  assert.equal(storage.projectsRoot(), root, 'idempotent');
});

test('absolutePathFor, and everything built on it, refuses an unsafe key', async () => {
  const { storage } = store();
  const attacks = [`projects/${PID}/src/../../../auth-store.db`, '/etc/passwd', `projects\\${PID}\\src\\${PHOTO_ID}.webp`, ''];
  for (const key of attacks) {
    assert.throws(() => storage.absolutePathFor(key), (err) => /** @type {any} */ (err).code === 'EUNSAFEKEY');
    await assert.rejects(() => storage.read(key), (err) => /** @type {any} */ (err).code === 'EUNSAFEKEY');
    await assert.rejects(() => storage.write(key, Buffer.from('x')), (err) => /** @type {any} */ (err).code === 'EUNSAFEKEY');
    await assert.rejects(() => storage.remove(key), (err) => /** @type {any} */ (err).code === 'EUNSAFEKEY');
    await assert.rejects(() => storage.stat(key), (err) => /** @type {any} */ (err).code === 'EUNSAFEKEY');
  }
});

test('removeProject refuses an unsafe project id', async () => {
  const { storage } = store();
  for (const id of ['..', '../..', '/etc', 'not-hex', '', `${PID}/../..`]) {
    await assert.rejects(() => storage.removeProject(id), (err) => /** @type {any} */ (err).code === 'EUNSAFEKEY');
    assert.throws(() => storage.removeProjectSync(id), (err) => /** @type {any} */ (err).code === 'EUNSAFEKEY');
    assert.throws(() => storage.projectDir(id), (err) => /** @type {any} */ (err).code === 'EUNSAFEKEY');
  }
});

// ---- Read / write round trips ----------------------------------------------

test('a written blob reads back byte-for-byte, with its directory created on the way', async () => {
  const { storage } = store();
  const key = storage.keyFor({ projectId: PID, kind: 'src', id: PHOTO_ID, ext: 'webp' });
  const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x7f]);

  const before = Date.now();
  const written = await storage.write(key, bytes);
  assert.deepEqual(written, { key, bytes: bytes.length }, 'the key comes back so it can be persisted into storage_key');
  assert.deepEqual(await storage.read(key), bytes);

  const stat = await storage.stat(key);
  assert.equal(stat.bytes, bytes.length);
  assert.ok(stat.mtimeMs >= before - 2000 && stat.mtimeMs <= Date.now() + 2000, `mtime should be ~now, got ${stat.mtimeMs}`);
});

test('write accepts a Uint8Array and refuses anything that is not bytes', async () => {
  const { storage } = store();
  const key = storage.keyFor({ projectId: PID, kind: 'out', id: RENDER_ID, ext: 'webp' });
  await storage.write(key, new Uint8Array([1, 2, 3]));
  assert.deepEqual(await storage.read(key), Buffer.from([1, 2, 3]));
  for (const junk of [null, undefined, 42, {}]) {
    await assert.rejects(() => storage.write(key, /** @type {any} */ (junk)), TypeError);
  }
});

test('a blob overwritten in place keeps one file and the new bytes', async () => {
  const { storage } = store();
  const key = storage.keyFor({ projectId: PID, kind: 'out', id: RENDER_ID, ext: 'webp' });
  await storage.write(key, Buffer.from('first'));
  await storage.write(key, Buffer.from('second-and-longer'));
  assert.equal((await storage.read(key)).toString(), 'second-and-longer');
  assert.equal(fs.readdirSync(path.join(storage.projectDir(PID), 'out')).length, 1);
});

test('reading or statting a missing blob is ENOENT and null respectively', async () => {
  // A row can outlive its file, so these two answer differently on purpose: `stat` is the
  // "is it there?" probe, `read` is the "give me the bytes" call that must not silently
  // return empty.
  const { storage } = store();
  const key = storage.keyFor({ projectId: PID, kind: 'src', id: PHOTO_ID, ext: 'webp' });
  assert.equal(await storage.stat(key), null);
  await assert.rejects(() => storage.read(key), (err) => /** @type {any} */ (err).code === 'ENOENT');
});

test('remove deletes a blob and is idempotent afterwards', async () => {
  const { storage } = store();
  const key = storage.keyFor({ projectId: PID, kind: 'src', id: PHOTO_ID, ext: 'webp' });
  await storage.write(key, Buffer.from('bytes'));
  assert.equal(await storage.remove(key), true);
  assert.equal(await storage.stat(key), null);
  assert.equal(await storage.remove(key), false, 'a second remove is a no-op, not an error');
});

// ---- Project-wide removal (the erasure path) -------------------------------

test('removeProject deletes the bytes it was asked about — round-tripped, not path-compared', async () => {
  // THE test the doubling bug survived: a path-string assertion passed while every file
  // stayed on disk. This one writes through `write(keyFor(...))` and asks `stat` afterwards.
  const { storage } = store();
  const src = storage.keyFor({ projectId: PID, kind: 'src', id: PHOTO_ID, ext: 'webp' });
  const out = storage.keyFor({ projectId: PID, kind: 'out', id: RENDER_ID, ext: 'webp' });
  await storage.write(src, Buffer.from('source photo'));
  await storage.write(out, Buffer.from('render output'));
  assert.ok(await storage.stat(src), 'precondition: the source photo is on disk');
  assert.ok(await storage.stat(out), 'precondition: the render is on disk');

  assert.equal(await storage.removeProject(PID), true);
  assert.equal(await storage.stat(src), null, 'the source photo bytes are gone');
  assert.equal(await storage.stat(out), null, 'the render bytes are gone');
  assert.equal(fs.existsSync(storage.projectDir(PID)), false, 'and so is the project directory');
});

test('removeProjectSync does the same thing without awaiting — the erasure seam', async () => {
  // lib/data/user-deletion.js erases an account inside a synchronous SQLite transaction and
  // cannot await, so the sync twin has to resolve paths identically. If these two ever
  // disagreed, account erasure would leave the photographs behind.
  const { storage } = store();
  const src = storage.keyFor({ projectId: PID, kind: 'src', id: PHOTO_ID, ext: 'webp' });
  await storage.write(src, Buffer.from('source photo'));

  assert.equal(storage.removeProjectSync(PID), true);
  assert.equal(await storage.stat(src), null);
  assert.equal(storage.removeProjectSync(PID), true, 'idempotent: an already-absent project is fine');
});

test('removing one project leaves every other project alone', async () => {
  const { storage } = store();
  const other = 'bbbbbbbbccccccccddddddddeeeeeeee';
  const mine = storage.keyFor({ projectId: PID, kind: 'src', id: PHOTO_ID, ext: 'webp' });
  const theirs = storage.keyFor({ projectId: other, kind: 'src', id: PHOTO_ID, ext: 'webp' });
  await storage.write(mine, Buffer.from('mine'));
  await storage.write(theirs, Buffer.from('theirs'));

  await storage.removeProject(PID);
  assert.equal(await storage.stat(mine), null);
  assert.equal((await storage.read(theirs)).toString(), 'theirs', 'the other listing is untouched');
});

test('removeProject on a project that never had blobs is a clean no-op', async () => {
  const { storage } = store();
  assert.equal(await storage.removeProject(PID), true);
  assert.equal(fs.existsSync(storage.projectDir(PID)), false);
});

// ---- Layout invariants -----------------------------------------------------

test('src and out blobs are separated, and the key prefix is the exported constant', async () => {
  const { storage } = store();
  const src = storage.keyFor({ projectId: PID, kind: 'src', id: PHOTO_ID, ext: 'webp' });
  const out = storage.keyFor({ projectId: PID, kind: 'out', id: RENDER_ID, ext: 'png' });
  await storage.write(src, Buffer.from('s'));
  await storage.write(out, Buffer.from('o'));
  assert.deepEqual(fs.readdirSync(storage.projectDir(PID)).sort(), ['out', 'src']);
  assert.ok(src.startsWith(KEY_PREFIX) && out.startsWith(KEY_PREFIX));
  // Persisted keys must be POSIX on every platform: one written on Windows has to resolve on
  // Render's Linux disk.
  assert.ok(!src.includes('\\'), 'keys never carry a Windows separator');
});
