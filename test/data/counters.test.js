// Unit tests for lib/data/counters.js — the two in-memory runtime counters
// (rooms staged / contact submissions) exposed through get/inc accessors.
//
// SCOPE: only the pure in-memory accessor behavior is exercised here:
//   getPromptCount/incPromptCount and getContactCount/incContactCount.
// These touch nothing outside the module — no fs, no network, no model or
// email client, so there is no external API call and no cost involved.
//
// Also covered: countCsvRecords, and the initializers that seed from it. Those
// used to be untestable — the log directory was derived internally from
// import.meta.url with no seam to redirect it — so both initializers now take an
// optional logDir override, and every test here points them at a temp dir. No
// real on-disk log is read, so the suite stays hermetic and side-effect free.
//
// The module is a process-wide singleton: promptCount/contactCount are module
// scoped and shared by every importer. Some other test file in the same process
// could already have mutated them, so every assertion here captures a fresh
// baseline via the get accessor and asserts a RELATIVE delta rather than an
// absolute value (never assumes the counter starts at 0).

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getPromptCount,
  incPromptCount,
  getContactCount,
  incContactCount,
  countCsvRecords,
  initializePromptCount,
  initializeContactCount,
} from '../../lib/data/counters.js';

const tempDirs = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-counters-'));
  tempDirs.push(d);
  return d;
}
/** Write a CSV and return its path. @returns {string} */
function csv(contents, name = 'prompt_logs.csv') {
  const dir = tempDir();
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return file;
}
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

const HEADER = 'timestamp,roomType,furnitureStyle,additionalPrompt,removeFurniture,userRole,referralSource,email,ipAddress,status,durationMs,model,attempts,errorCode';
/** One well-formed prompt_logs row; `prompt` is CSV-quoted as the real writer does. @returns {string} */
function row(prompt = 'make it cozy', ts = '2026-07-27T10:00:00.000Z') {
  return `${ts},living_room,modern,"${prompt}",false,agent,google,a@b.com,127.0.0.1,ok,1200,gemini,1,`;
}

test('incPromptCount raises getPromptCount by exactly 1 per call', () => {
  const before = getPromptCount();
  incPromptCount();
  assert.equal(getPromptCount(), before + 1);
});

test('N calls to incPromptCount add exactly N to getPromptCount', () => {
  const before = getPromptCount();
  const N = 5;
  for (let i = 0; i < N; i += 1) incPromptCount();
  assert.equal(getPromptCount(), before + N);
});

test('incContactCount raises getContactCount by exactly 1 per call', () => {
  const before = getContactCount();
  incContactCount();
  assert.equal(getContactCount(), before + 1);
});

test('N calls to incContactCount add exactly N to getContactCount', () => {
  const before = getContactCount();
  const N = 3;
  for (let i = 0; i < N; i += 1) incContactCount();
  assert.equal(getContactCount(), before + N);
});

test('incrementing the prompt counter leaves the contact counter untouched', () => {
  const contactBefore = getContactCount();
  incPromptCount();
  assert.equal(getContactCount(), contactBefore);
});

test('incrementing the contact counter leaves the prompt counter untouched', () => {
  const promptBefore = getPromptCount();
  incContactCount();
  assert.equal(getPromptCount(), promptBefore);
});

test('getPromptCount is a pure read: two calls with no inc return the same value', () => {
  assert.equal(getPromptCount(), getPromptCount());
});

test('getContactCount is a pure read: two calls with no inc return the same value', () => {
  assert.equal(getContactCount(), getContactCount());
});

// ---------------------------------------------------------------------------
// countCsvRecords — the seed used for the PUBLIC "Rooms Staged" figure, so an
// over-count is user-visible.
// ---------------------------------------------------------------------------

test('counts data rows and excludes the header', () => {
  assert.equal(countCsvRecords(csv(`${HEADER}\n${row()}\n${row()}\n${row()}\n`)), 3);
});

test('a header-only file counts as zero renders, not as one', () => {
  assert.equal(countCsvRecords(csv(`${HEADER}\n`)), 0);
});

test('a missing file counts as zero rather than throwing', () => {
  assert.equal(countCsvRecords(path.join(tempDir(), 'nope.csv')), 0);
});

test('an empty file counts as zero', () => {
  assert.equal(countCsvRecords(csv('')), 0);
});

test('a final row with no trailing newline is still counted', () => {
  assert.equal(countCsvRecords(csv(`${HEADER}\n${row()}\n${row()}`)), 2);
});

// The regression this whole rewrite exists for. The writer CSV-quotes free-text
// user input, so a prompt containing a line break spans several physical lines
// while remaining ONE record. The old /^\d{4}-\d{2}-\d{2}T.../gm line-scan counted
// each embedded timestamp-shaped line as another render.
test('a newline inside a quoted field does not start a new record', () => {
  const sneaky = 'line one\nline two\nline three';
  assert.equal(countCsvRecords(csv(`${HEADER}\n${row(sneaky)}\n${row()}\n`)), 2);
});

test('an embedded ISO timestamp inside a quoted prompt does not inflate the count', () => {
  // Precisely the input that fooled the old regex: a line break followed by
  // something timestamp-shaped at the start of the next physical line.
  const sneaky = 'redo this\n2026-01-01T00:00:00 was the last attempt';
  assert.equal(countCsvRecords(csv(`${HEADER}\n${row(sneaky)}\n`)), 1);
});

test('an escaped double-quote inside a field does not desynchronise the parser', () => {
  // "" is one literal quote — the pair must leave the parser still inside the
  // field, or every subsequent newline would be misread as in-quotes and the
  // whole rest of the file would collapse into one record.
  assert.equal(countCsvRecords(csv(`${HEADER}\n${row('a ""quoted"" phrase')}\n${row()}\n`)), 2);
});

test('a file with unbalanced quotes falls back to a line count instead of collapsing', () => {
  // A stray opening quote desynchronises a quote-aware scan: every later newline
  // reads as in-field, so a naive parser would report ~1 record for the whole
  // file. The public counter must degrade to over-counting, never to near-zero.
  const strayQuote = '2026-07-27T10:00:00.000Z,living_room,modern,"oops,false,agent,google,a@b.com,127.0.0.1,ok,1,m,1,';
  assert.equal(countCsvRecords(csv(`${HEADER}\n${row()}\n${strayQuote}\n${row()}\n`)), 3);
});

test('a file with no header at all counts every row', () => {
  // A rotated or hand-trimmed log: rows start with an ISO timestamp, so there is
  // no header to subtract.
  assert.equal(countCsvRecords(csv(`${row()}\n${row()}\n`)), 2);
});

test('counting is chunk-boundary safe for a file larger than one read buffer', () => {
  // 64 KB read chunks: this file spans many of them, with quoted newlines placed
  // throughout so a record straddles a boundary mid-field.
  const rows = [];
  for (let i = 0; i < 2000; i += 1) rows.push(row(`prompt ${i}\n2026-02-02T02:02:02 embedded`));
  assert.equal(countCsvRecords(csv(`${HEADER}\n${rows.join('\n')}\n`)), 2000);
});

// ---------------------------------------------------------------------------
// The initializers — same counting, wired to the counter state.
// ---------------------------------------------------------------------------

test('initializePromptCount seeds getPromptCount from prompt_logs.csv', () => {
  const file = csv(`${HEADER}\n${row()}\n${row()}\n`);
  initializePromptCount(path.dirname(file));
  assert.equal(getPromptCount(), 2);
});

test('initializeContactCount seeds getContactCount from contact_logs.csv', () => {
  const file = csv('timestamp,name,email\n2026-07-27T10:00:00.000Z,Ann,a@b.com\n', 'contact_logs.csv');
  initializeContactCount(path.dirname(file));
  assert.equal(getContactCount(), 1);
});

test('initializing against a directory with no log file yields zero, not a throw', () => {
  initializePromptCount(tempDir());
  assert.equal(getPromptCount(), 0);
});

test('the two initializers seed independently', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'prompt_logs.csv'), `${HEADER}\n${row()}\n${row()}\n${row()}\n`);
  fs.writeFileSync(path.join(dir, 'contact_logs.csv'), 'timestamp,name\n2026-07-27T10:00:00.000Z,Ann\n');
  initializePromptCount(dir);
  initializeContactCount(dir);
  assert.equal(getPromptCount(), 3);
  assert.equal(getContactCount(), 1);
});
