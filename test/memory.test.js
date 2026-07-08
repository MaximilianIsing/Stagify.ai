// Per-user chat-memory store (lib/memory.js). Now SQLite-backed (shares the app DB
// via lib/db.js): saveMemories upserts ONE user's row, and a one-time importer
// migrates a legacy memories.json into SQLite exactly once. Regressions here either
// clobber a user's memories or silently re-import stale JSON over live data.
// Windows lock gotcha: close the DB handle before removing the temp dir.
// NOTE: evaluateMemoryActions is intentionally untested — it needs a real OpenAI
// client and is not wired into the live chat flow.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemory } from '../lib/data/memory.js';
import { getDb } from '../lib/data/db.js';

const tmps = [];
const openMems = [];
function newDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-mem-'));
  tmps.push(d);
  return d;
}
function mk(dir) {
  const m = createMemory({ __dirname: dir, DEBUG_MODE: false, openai: null });
  openMems.push(m);
  return m;
}
const freshMemory = () => {
  const dir = newDir();
  return { dir, mem: mk(dir) };
};

// resolveDataDir sends everything to /data when RENDER is set — force per-temp-dir
// isolation (npm test can run during a Render build where RENDER is present).
let savedRender;
before(() => { savedRender = process.env.RENDER; delete process.env.RENDER; });
after(() => { if (savedRender !== undefined) process.env.RENDER = savedRender; });
afterEach(() => {
  while (openMems.length) { try { openMems.pop().close(); } catch { /* already closed */ } }
  while (tmps.length) { try { fs.rmSync(tmps.pop(), { recursive: true, force: true }); } catch { /* best effort */ } }
});

test('saveMemories/loadMemories: per-user rows are independent', () => {
  const { mem } = freshMemory();
  mem.saveMemories('userA', [{ id: '1', content: 'A prefers modern' }]);
  mem.saveMemories('userB', [{ id: '2', content: 'B is an agent' }]);

  assert.deepEqual(mem.loadMemories('userA'), [{ id: '1', content: 'A prefers modern' }]);
  assert.deepEqual(mem.loadMemories('userB'), [{ id: '2', content: 'B is an agent' }], 'saving B did not touch A');
  assert.deepEqual(mem.loadMemories('nobody'), [], 'unknown user → empty array');
  assert.deepEqual(Object.keys(mem.loadAllMemories()).sort(), ['userA', 'userB']);
});

test('saveMemories upserts (overwrites) a user row rather than appending', () => {
  const { mem } = freshMemory();
  mem.saveMemories('u', [{ id: '1', content: 'first' }]);
  mem.saveMemories('u', [{ id: '1', content: 'first' }, { id: '2', content: 'second' }]);
  assert.deepEqual(mem.loadMemories('u').map((m) => m.content), ['first', 'second']);
  mem.saveMemories('u', []); // explicit clear
  assert.deepEqual(mem.loadMemories('u'), [], 'writing [] clears the row');
});

test('loadMemories tolerates a corrupt stored row (safeParseArray → [])', () => {
  const { dir, mem } = freshMemory();
  // Reach the same shared connection and plant malformed JSON in the row.
  const db = getDb(dir);
  db.prepare('INSERT OR REPLACE INTO memories (user_id, data) VALUES (?, ?)').run('corrupt', '{not valid json');
  assert.deepEqual(mem.loadMemories('corrupt'), [], 'a corrupt row reads as empty, not a crash');
});

test('resetAllMemories clears every user', () => {
  const { mem } = freshMemory();
  mem.saveMemories('a', [{ id: '1', content: 'x' }]);
  mem.saveMemories('b', [{ id: '2', content: 'y' }]);
  mem.resetAllMemories();
  assert.deepEqual(mem.loadAllMemories(), {});
  assert.deepEqual(mem.loadMemories('a'), []);
});

test('memories persist across a close + reopen on the same directory', () => {
  const { dir, mem } = freshMemory();
  mem.saveMemories('u', [{ id: '1', content: 'hello' }]);
  mem.close(); // drop the handle so the reopen is a genuinely fresh connection

  const reopened = mk(dir);
  assert.deepEqual(reopened.loadMemories('u'), [{ id: '1', content: 'hello' }]);
});

test('legacy memories.json is imported once, then never re-imported over live data', () => {
  const dir = newDir();
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'memories.json'), JSON.stringify({ alice: [{ id: '1', content: 'imported' }] }));

  const mem = mk(dir);
  assert.deepEqual(mem.loadMemories('alice'), [{ id: '1', content: 'imported' }], 'legacy JSON imported on first boot');
  mem.close();

  // A JSON that grows AFTER the first import must be ignored (the guard prevents
  // clobbering live SQLite data on every boot).
  fs.writeFileSync(
    path.join(dataDir, 'memories.json'),
    JSON.stringify({ alice: [{ id: '1', content: 'imported' }], bob: [{ id: '2', content: 'late' }] }),
  );
  const mem2 = mk(dir);
  assert.deepEqual(mem2.loadMemories('bob'), [], 'JSON added after the one-time import is NOT re-imported');
  assert.deepEqual(mem2.loadMemories('alice'), [{ id: '1', content: 'imported' }], 'existing data intact');
});
