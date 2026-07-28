// The CSV half of GDPR erasure. Redaction rewrites a live log file, so the failure
// mode here is CORRUPTION, not a wrong number: a parser that treats a newline inside
// a quoted field as a record boundary would split a real row in half and shift every
// column after it. The writers embed free-text user input (`additionalPrompt`,
// `userMessage`, the bug-report conversation), so quoted newlines are routine.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCsvRecords, redactCsvFile, REDACTED } from '../../lib/data/csv-redaction.js';

const dirs = [];
function tmpFile(name, contents) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-csvred-'));
  dirs.push(d);
  const f = path.join(d, name);
  fs.writeFileSync(f, contents);
  return f;
}
afterEach(() => {
  while (dirs.length) {
    try { fs.rmSync(dirs.pop(), { recursive: true, force: true }); } catch { /* temp dir */ }
  }
});

// ---- parser ---------------------------------------------------------------

test('a newline inside a quoted field does not start a new record', () => {
  const text = 'a,b\n1,"line one\nline two"\n3,4\n';
  const recs = parseCsvRecords(text);
  assert.equal(recs.length, 3, 'header + 2 data records');
  assert.deepEqual(recs[1].fields, ['1', 'line one\nline two']);
  assert.deepEqual(recs[2].fields, ['3', '4']);
});

test('doubled quotes decode to one literal quote', () => {
  const recs = parseCsvRecords('a\n"he said ""hi"", loudly"\n');
  assert.deepEqual(recs[1].fields, ['he said "hi", loudly']);
});

test('CRLF terminators and a final record with no newline both parse', () => {
  const recs = parseCsvRecords('a,b\r\n1,2\r\n3,4');
  assert.equal(recs.length, 3);
  assert.deepEqual(recs[1].fields, ['1', '2'], 'the CR is a terminator, not part of the field');
  assert.deepEqual(recs[2].fields, ['3', '4'], 'an unterminated last record still counts');
});

test('every record keeps its exact source slice', () => {
  const text = 'a,b\n1,"x\ny"\n3,4\n';
  const recs = parseCsvRecords(text);
  assert.equal(recs.map((r) => r.raw).join(''), text, 'raw slices must reassemble the file byte-for-byte');
});

// ---- redaction ------------------------------------------------------------

const LOG =
  'timestamp,email,ipAddress,note\n' +
  '2026-01-01,keep@example.com,1.1.1.1,fine\n' +
  '2026-01-02,GONE@example.com,2.2.2.2,"multi\nline note"\n' +
  '2026-01-03,gone@example.com,3.3.3.3,another\n';

test('matching rows lose their identifying cells; everything else is untouched', () => {
  const f = tmpFile('prompt_logs.csv', LOG);
  const res = redactCsvFile(f, {
    match: [{ column: 'email', value: 'gone@example.com', caseInsensitive: true }],
    redact: ['email', 'ipAddress'],
  });

  assert.equal(res.matched, 2, 'case-insensitive email match hits both rows');
  const out = parseCsvRecords(fs.readFileSync(f, 'utf8'));
  assert.equal(out.length, 4, 'no row was added or dropped — the counters depend on this');
  assert.deepEqual(out[1].fields, ['2026-01-01', 'keep@example.com', '1.1.1.1', 'fine'], 'other people untouched');
  assert.deepEqual(out[2].fields, ['2026-01-02', REDACTED, REDACTED, 'multi\nline note'], 'quoted newline survives');
  assert.deepEqual(out[3].fields, ['2026-01-03', REDACTED, REDACTED, 'another']);
});

test('a file with no match is not rewritten at all', () => {
  const f = tmpFile('prompt_logs.csv', LOG);
  const before = fs.readFileSync(f);
  const res = redactCsvFile(f, { match: [{ column: 'email', value: 'nobody@example.com' }], redact: ['email'] });
  assert.equal(res.matched, 0);
  assert.deepEqual(fs.readFileSync(f), before, 'byte-identical');
});

test('columns are resolved by NAME, so an appended column shifts nothing', () => {
  // prompt_logs.csv gained five outcome columns by appending; a positional
  // assumption here would blank the wrong cells.
  const f = tmpFile('prompt_logs.csv', 'timestamp,email,ipAddress,status,durationMs\nt,gone@example.com,9.9.9.9,ok,120\n');
  redactCsvFile(f, { match: [{ column: 'email', value: 'gone@example.com' }], redact: ['email', 'ipAddress'] });
  const out = parseCsvRecords(fs.readFileSync(f, 'utf8'));
  assert.deepEqual(out[1].fields, ['t', REDACTED, REDACTED, 'ok', '120'], 'appended columns keep their values');
});

test('a file this user has no column in is left alone', () => {
  const f = tmpFile('mask_logs.csv', 'timestamp,userId\nt,u_2\n');
  const res = redactCsvFile(f, { match: [{ column: 'email', value: 'x@y.z' }], redact: ['email'] });
  assert.equal(res.matched, 0);
  assert.match(res.reason || '', /no matching columns/);
});

test('a missing file is reported, not thrown', () => {
  const f = path.join(os.tmpdir(), 'stagify-does-not-exist-' + process.pid + '.csv');
  const res = redactCsvFile(f, { match: [{ column: 'email', value: 'a@b.c' }], redact: ['email'] });
  assert.equal(res.present, false);
  assert.equal(res.matched, 0);
});

test('redaction is idempotent — a second pass changes nothing', () => {
  const f = tmpFile('prompt_logs.csv', LOG);
  const spec = { match: [{ column: 'email', value: 'gone@example.com', caseInsensitive: true }], redact: ['email', 'ipAddress'] };
  redactCsvFile(f, spec);
  const once = fs.readFileSync(f);
  const second = redactCsvFile(f, spec);
  assert.equal(second.matched, 0, 'the address is gone, so nothing matches any more');
  assert.deepEqual(fs.readFileSync(f), once);
});

test('a redacted row re-escapes safely (no CSV break-out, no formula injection)', () => {
  const f = tmpFile('bug_reports.csv', 'timestamp,email,description\nt,gone@example.com,"=cmd|calc,\\"quoted\\""\n');
  redactCsvFile(f, { match: [{ column: 'email', value: 'gone@example.com' }], redact: ['email'] });
  const raw = fs.readFileSync(f, 'utf8');
  const out = parseCsvRecords(raw);
  assert.equal(out.length, 2, 'still one data row — the comma inside the field did not split it');
  assert.equal(out[1].fields[1], REDACTED);
  assert.match(raw, /"'=cmd/, 'the formula-injection prefix is (re-)applied on rewrite');
});
