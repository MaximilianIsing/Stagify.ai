// SQLite layer (lib/db.js) — the pragmas we rely on and that data actually persists.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, resolveDataDir, getDb, closeDb } from '../../lib/data/db.js';
import { createAuthStore } from '../../lib/data/auth-store.js';

const tempDirs = [];
const openDbs = [];
// Base dirs whose SHARED (memoized) connection must be released before rmSync —
// these come from getDb, not open(), so they aren't in openDbs.
const closeDbs = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-db-'));
  tempDirs.push(d);
  return d;
}
function open(p) {
  const db = openDb(p);
  openDbs.push(db);
  return db;
}
afterEach(() => {
  // Close handles before removing the dir — Windows won't unlink an open .db/-wal/-shm.
  while (openDbs.length) { try { openDbs.pop().close(); } catch { /* already closed */ } }
  while (closeDbs.length) { try { closeDb(closeDbs.pop()); } catch { /* already closed */ } }
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

test('openDb applies the expected pragmas (WAL, NORMAL sync, busy timeout)', () => {
  const db = open(path.join(tempDir(), 'p.db'));
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('synchronous', { simple: true }), 1, 'NORMAL');
  assert.ok(db.pragma('busy_timeout', { simple: true }) >= 5000);
});

// db.js no longer sets `foreign_keys` — see the note there. Two independent facts
// made that line a no-op, and this pins both so removing it stays safe:
//   1. no table declares a REFERENCES clause, so there is nothing to enforce; and
//   2. better-sqlite3 turns the pragma on by default, so dropping the explicit
//      call did not actually disable enforcement.
// If (1) ever stops holding, the FK assertion fires and points at db.js. If (2)
// ever stops holding (a driver upgrade changing its default), the pragma
// assertion fires — at which point the explicit line has to come back.
test('nothing declares a foreign key, and the driver still enables enforcement anyway', () => {
  const base = tempDir();
  createAuthStore(base); // the real schema, not a toy table
  closeDbs.push(base);
  const db = getDb(base);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all();
  assert.ok(tables.length > 0, 'sanity: the schema created some tables');
  const withFks = tables.filter((t) => db.pragma(`foreign_key_list(${t.name})`).length > 0);
  assert.deepEqual(withFks.map((t) => t.name), [], 'a table gained an FK — see the note in db.js');
  assert.equal(
    db.pragma('foreign_keys', { simple: true }),
    1,
    'better-sqlite3 stopped defaulting foreign_keys ON — restore the explicit pragma in db.js',
  );
});

test('data written through openDb persists to disk across a reopen', () => {
  const p = path.join(tempDir(), 'persist.db');
  const db = open(p);
  db.exec('CREATE TABLE t (x INTEGER)');
  db.prepare('INSERT INTO t (x) VALUES (?)').run(42);
  db.close();

  const db2 = open(p);
  assert.equal(db2.prepare('SELECT x FROM t').get().x, 42, 'the row survived closing and reopening');
});

test('resolveDataDir creates and returns <baseDir>/data locally', () => {
  const base = tempDir();
  const out = resolveDataDir(base);
  assert.equal(out, path.join(base, 'data'));
  assert.ok(fs.existsSync(out) && fs.statSync(out).isDirectory(), 'the data dir is created');
});
