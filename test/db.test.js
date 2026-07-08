// SQLite layer (lib/db.js) — the pragmas we rely on and that data actually persists.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, resolveDataDir } from '../lib/data/db.js';

const tempDirs = [];
const openDbs = [];
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
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

test('openDb applies the expected pragmas (WAL, NORMAL sync, foreign keys, busy timeout)', () => {
  const db = open(path.join(tempDir(), 'p.db'));
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('synchronous', { simple: true }), 1, 'NORMAL');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'foreign keys ON');
  assert.ok(db.pragma('busy_timeout', { simple: true }) >= 5000);
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
