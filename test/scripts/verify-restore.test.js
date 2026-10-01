// The restore drill's checks (scripts/verify-restore.js): a healthy restored copy passes,
// and each way a backup can quietly rot (empty, stale, missing heartbeat) fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { verifyRestore } from '../../scripts/verify-restore.js';

const NOW = Date.UTC(2026, 9, 1, 12);
const HOUR = 3_600_000;

function makeDb({ users = 3, lastBeat = NOW - 60_000, heartbeat = true } = {}) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
  for (let i = 0; i < users; i++) db.prepare('INSERT INTO users DEFAULT VALUES').run();
  db.exec('CREATE TABLE uptime_state (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)');
  if (heartbeat) db.prepare('INSERT INTO uptime_state (id, data) VALUES (1, ?)').run(JSON.stringify({ lastBeat }));
  return db;
}

test('a fresh, populated copy passes', () => {
  const r = verifyRestore(makeDb(), { now: NOW });
  assert.equal(r.ok, true, r.problems.join('; '));
  assert.equal(r.users, 3);
});

test('a stale heartbeat fails: replication stopped after boot', () => {
  const r = verifyRestore(makeDb({ lastBeat: NOW - 30 * HOUR }), { now: NOW, maxAgeHours: 24 });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /stale/);
});

test('an empty users table fails', () => {
  const r = verifyRestore(makeDb({ users: 0 }), { now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /empty/);
});

test('a missing heartbeat row fails', () => {
  const r = verifyRestore(makeDb({ heartbeat: false }), { now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /heartbeat/);
});

test('a database without the expected tables fails instead of throwing', () => {
  const r = verifyRestore(new Database(':memory:'), { now: NOW });
  assert.equal(r.ok, false);
  assert.ok(r.problems.length >= 2);
});
