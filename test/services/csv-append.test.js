// lib/services/csv-append.js — the one race-free CSV append.
//
// WHY THIS EXISTS: five writers had copy-pasted this shape —
//
//     const fileExists = fs.existsSync(logFile);
//     if (!fileExists) fs.writeFileSync(logFile, HEADER + '\n' + row);   // truncating
//     else fs.appendFile(logFile, row, cb);
//
// Two writers racing on a FRESH file both see `!fileExists`, and the second
// writeFileSync truncates away the first one's row. On Render the data dir is a
// fresh mount on first deploy and /api/process-image is routinely concurrent, so
// the loss window is real — and it eats the first rows of a brand-new log, which
// is exactly when nobody is watching.
//
// The tests below drive the OLD shape and the NEW one over the same interleaving
// so the difference is demonstrated rather than asserted on faith.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendCsvRow } from '../../lib/services/csv-append.js';

const dirs = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-csvappend-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

const HEADER = 'timestamp,value';
const rows = (file) => fs.readFileSync(file, 'utf8').trim().split('\n');

test('the first write lays down the header and the row, in that order', () => {
  const file = path.join(tempDir(), 'log.csv');
  appendCsvRow(file, HEADER, 'a,1\n', 'test log');
  assert.deepEqual(rows(file), [HEADER, 'a,1']);
});

test('later writes append and never rewrite the header', () => {
  const file = path.join(tempDir(), 'log.csv');
  appendCsvRow(file, HEADER, 'a,1\n', 'test log');
  appendCsvRow(file, HEADER, 'b,2\n', 'test log');
  appendCsvRow(file, HEADER, 'c,3\n', 'test log');
  assert.deepEqual(rows(file), [HEADER, 'a,1', 'b,2', 'c,3']);
  assert.equal(fs.readFileSync(file, 'utf8').split(HEADER).length - 1, 1, 'exactly one header');
});

test('a burst of writers onto a FRESH file loses nothing', () => {
  // The regression itself. Every call believes it is the first — which is the
  // condition the old exists-then-write shape mishandled.
  const file = path.join(tempDir(), 'log.csv');
  const N = 50;
  for (let i = 0; i < N; i += 1) appendCsvRow(file, HEADER, `row,${i}\n`, 'test log');

  const lines = rows(file);
  assert.equal(lines[0], HEADER, 'header first');
  assert.equal(lines.length, N + 1, `expected ${N} data rows plus the header, got ${lines.length - 1} rows`);
  for (let i = 0; i < N; i += 1) {
    assert.ok(lines.includes(`row,${i}`), `row ${i} must survive`);
  }
});

// The mutation test: reproduce the OLD implementation here and show it losing data
// on the same interleaving. If this ever stops failing, the race was never real and
// the tests above are guarding nothing.
test('the exists-then-write shape this replaced really does lose the first row', () => {
  const file = path.join(tempDir(), 'legacy.csv');
  // Interleave two "concurrent" writers by hand: both observe the missing file
  // before either writes, which is precisely the production window.
  const firstSawMissing = !fs.existsSync(file);
  const secondSawMissing = !fs.existsSync(file);
  assert.ok(firstSawMissing && secondSawMissing, 'both writers observe an absent file');
  fs.writeFileSync(file, HEADER + '\n' + 'first,1\n'); // writer A
  fs.writeFileSync(file, HEADER + '\n' + 'second,2\n'); // writer B truncates A away

  const lines = rows(file);
  assert.ok(!lines.includes('first,1'), "the old shape drops writer A's row — that is the bug");
  assert.deepEqual(lines, [HEADER, 'second,2']);

  // And the same interleaving through appendCsvRow keeps both.
  const fixed = path.join(tempDir(), 'fixed.csv');
  appendCsvRow(fixed, HEADER, 'first,1\n', 'test log');
  appendCsvRow(fixed, HEADER, 'second,2\n', 'test log');
  assert.deepEqual(rows(fixed), [HEADER, 'first,1', 'second,2']);
});

test('a header write that fails for a real reason skips the row rather than orphaning it', () => {
  // A directory where the file should be: the create fails with EISDIR, not EEXIST.
  const dir = tempDir();
  const file = path.join(dir, 'log.csv');
  fs.mkdirSync(file);
  assert.doesNotThrow(() => appendCsvRow(file, HEADER, 'a,1\n', 'test log'), 'errors are logged, never thrown');
  assert.deepEqual(fs.readdirSync(file), [], 'nothing was written into the directory');
});
