// lib/data/data-dir.js — the single rule for where durable state lives on disk.
//
// The behaviour tests below are ordinary unit tests. The last one is a DRIFT
// GUARD: the rule used to be copy-pasted at ten call sites (the SQLite file, the
// uptime JSON, the counter seeds, and every CSV writer), three of them inside the
// file that already exported a resolver for it. Nothing stopped an eleventh copy
// appearing, and a copy that drifted would split state across two directories
// without any test noticing. That guard is the thing that keeps this consolidated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveDataDir, RENDER_DISK_MOUNT } from '../../lib/data/data-dir.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-data-dir-'));
}

test('resolves to <baseDir>/data locally and creates it on demand', () => {
  const base = tempDir();
  const out = resolveDataDir(base);
  assert.equal(out, path.join(base, 'data'));
  assert.ok(fs.statSync(out).isDirectory(), 'the data dir is created');
});

test('is idempotent — an existing data dir is returned untouched', () => {
  const base = tempDir();
  const first = resolveDataDir(base);
  fs.writeFileSync(path.join(first, 'marker.csv'), 'kept');
  const second = resolveDataDir(base);
  assert.equal(second, first);
  assert.equal(fs.readFileSync(path.join(first, 'marker.csv'), 'utf8'), 'kept',
    'the second call must not clobber what the first call created');
});

test('falls back to baseDir when the data dir cannot be created', () => {
  const base = tempDir();
  // A regular FILE where the directory should go makes mkdirSync throw on every
  // platform — the portable stand-in for an unwritable disk. A log write is not
  // worth crashing a boot over, so the caller gets baseDir instead of an throw.
  fs.writeFileSync(path.join(base, 'data'), 'not a directory');
  assert.equal(resolveDataDir(base), base);
});

// The mount point is injected rather than read from the real filesystem: '/data'
// exists on some dev machines (on Windows it resolves to C:\data), which used to
// make the "not mounted" case unobservable and skip the test on exactly the
// machines where it would have failed. Both branches now run everywhere.
function withRender(t) {
  const prev = process.env.RENDER;
  process.env.RENDER = 'true';
  t.after(() => {
    if (prev === undefined) delete process.env.RENDER;
    else process.env.RENDER = prev;
  });
}

test('the injected mount defaults to the real Render disk', () => {
  // The parameter exists for the tests below; production must still get /data,
  // so pin the default rather than letting the injection quietly redefine it.
  assert.equal(RENDER_DISK_MOUNT, '/data');
});

test('RENDER plus a mounted disk diverts writes to the disk', (t) => {
  withRender(t);
  const mount = path.join(tempDir(), 'mnt');
  fs.mkdirSync(mount);
  const base = tempDir();
  assert.equal(resolveDataDir(base, mount), mount,
    'with the disk mounted, state goes to it and not beside the app');
  assert.ok(!fs.existsSync(path.join(base, 'data')),
    'the local data dir is not created as a side effect');
});

test('RENDER alone does not divert writes — the disk must actually be mounted', (t) => {
  withRender(t);
  const mount = path.join(tempDir(), 'never-mounted'); // deliberately not created
  const base = tempDir();
  assert.equal(resolveDataDir(base, mount), path.join(base, 'data'),
    'without the mount, state stays local rather than going to a path that does not exist');
});

test('a mounted disk is ignored when RENDER is not set', (t) => {
  const prev = process.env.RENDER;
  delete process.env.RENDER;
  t.after(() => { if (prev !== undefined) process.env.RENDER = prev; });
  const mount = path.join(tempDir(), 'mnt');
  fs.mkdirSync(mount);
  const base = tempDir();
  assert.equal(resolveDataDir(base, mount), path.join(base, 'data'),
    'a stray /data on a dev box must not capture the app\'s writes');
});

test('DRIFT GUARD: only data-dir.js implements the Render-disk rule', () => {
  // Walk the shipped source (not tests, not node_modules) for anyone re-deriving
  // the storage location instead of calling resolveDataDir.
  const roots = ['lib', 'routes', 'scripts'].map((d) => path.join(repoRoot, d));
  roots.push(repoRoot); // for server.js itself
  const offenders = [];

  function scan(dir, recurse) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recurse && entry.name !== 'node_modules') scan(full, true);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const rel = path.relative(repoRoot, full).replace(/\\/g, '/');
      if (rel === 'lib/data/data-dir.js') continue; // the one legitimate home
      if (/process\.env\.RENDER\b/.test(fs.readFileSync(full, 'utf8'))) offenders.push(rel);
    }
  }

  for (const root of roots) scan(root, root !== repoRoot);

  assert.deepEqual(offenders, [],
    'these files re-derive the data directory instead of importing resolveDataDir ' +
    'from lib/data/data-dir.js — see the header comment there for why that matters');
});

test('STAGIFY_DATA_DIR overrides the local path, and Render still wins over it', () => {
  // The override exists so the eight test files that spawn a real `server.js` stop sharing
  // one SQLite file — under parallel load that killed a boot outright with
  // `SqliteError: disk I/O error`, which surfaced as a bare `fetch failed` in whichever
  // file happened to be running. It must never be reachable in production, so the Render
  // branch is checked FIRST and the ordering is asserted here rather than assumed.
  const base = tempDir();
  const override = path.join(tempDir(), 'elsewhere');
  const mount = tempDir(); // stands in for a mounted /data

  const prevRender = process.env.RENDER;
  const prevOverride = process.env.STAGIFY_DATA_DIR;
  try {
    delete process.env.RENDER;
    process.env.STAGIFY_DATA_DIR = override;
    assert.equal(resolveDataDir(base, mount), override, 'the override is used off Render');
    assert.equal(fs.existsSync(override), true, 'and created on demand');

    process.env.RENDER = 'true';
    assert.equal(resolveDataDir(base, mount), mount,
      'but a mounted Render disk still wins — production can never take the override');
  } finally {
    if (prevRender === undefined) delete process.env.RENDER; else process.env.RENDER = prevRender;
    if (prevOverride === undefined) delete process.env.STAGIFY_DATA_DIR; else process.env.STAGIFY_DATA_DIR = prevOverride;
  }
});

test('an unusable STAGIFY_DATA_DIR falls through instead of failing the boot', () => {
  // A misconfigured override must not be the reason the app cannot start.
  const base = tempDir();
  const prev = process.env.STAGIFY_DATA_DIR;
  try {
    // A path under an existing FILE cannot be created as a directory.
    const file = path.join(base, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    process.env.STAGIFY_DATA_DIR = path.join(file, 'nested');
    assert.equal(resolveDataDir(base), path.join(base, 'data'), 'falls back to <baseDir>/data');
  } finally {
    if (prev === undefined) delete process.env.STAGIFY_DATA_DIR; else process.env.STAGIFY_DATA_DIR = prev;
  }
});

test('an empty or whitespace override is ignored, not treated as a path', () => {
  const base = tempDir();
  const prev = process.env.STAGIFY_DATA_DIR;
  try {
    for (const blank of ['', '   ']) {
      process.env.STAGIFY_DATA_DIR = blank;
      assert.equal(resolveDataDir(base), path.join(base, 'data'), `"${blank}" must be ignored`);
    }
  } finally {
    if (prev === undefined) delete process.env.STAGIFY_DATA_DIR; else process.env.STAGIFY_DATA_DIR = prev;
  }
});
