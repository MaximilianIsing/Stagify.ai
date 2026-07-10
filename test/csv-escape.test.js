// escapeCsvField hardens CSV cells against two attacks that matter because these
// logs hold attacker-controlled text (userAgent, referralSource, email, prompt) and
// are later opened in a spreadsheet: (1) structural break-out via embedded
// quotes/commas/newlines, and (2) formula injection via a leading = + - @.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeCsvField } from '../lib/http/csv-escape.js';

test('escapeCsvField: null/undefined → empty string', () => {
  assert.equal(escapeCsvField(null), '');
  assert.equal(escapeCsvField(undefined), '');
});

test('escapeCsvField: plain values pass through unquoted', () => {
  assert.equal(escapeCsvField('agent'), 'agent');
  assert.equal(escapeCsvField('2026-07-10T00:00:00.000Z'), '2026-07-10T00:00:00.000Z');
  assert.equal(escapeCsvField(203), '203');
});

test('escapeCsvField: RFC-4180 quoting for comma / quote / newline, doubling inner quotes', () => {
  assert.equal(escapeCsvField('a,b'), '"a,b"', 'comma forces quoting');
  assert.equal(escapeCsvField('he said "hi"'), '"he said ""hi"""', 'inner quotes are doubled');
  assert.equal(escapeCsvField('line1\nline2'), '"line1\nline2"', 'newline forces quoting');
  assert.equal(escapeCsvField('a\r\nb'), '"a\r\nb"', 'CRLF forces quoting');
  // The classic break-out: a quote + comma trying to open a new column stays inside one cell.
  assert.equal(escapeCsvField('x","y'), '"x"",""y"');
});

test('escapeCsvField: neutralizes spreadsheet formula injection with a leading quote', () => {
  assert.equal(escapeCsvField('=1+1'), "'=1+1");
  assert.equal(escapeCsvField('+1'), "'+1");
  assert.equal(escapeCsvField('-1'), "'-1");
  assert.equal(escapeCsvField('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(escapeCsvField('\tcmd'), "'\tcmd", 'leading tab (skipped to reach a formula) is neutralized');
});

test('escapeCsvField: formula-injection payload that also needs quoting gets both treatments', () => {
  // Leading = triggers the ' prefix; the embedded comma then forces RFC-4180 quoting.
  assert.equal(escapeCsvField('=HYPERLINK("http://x","a"),b'), '"\'=HYPERLINK(""http://x"",""a""),b"');
});
