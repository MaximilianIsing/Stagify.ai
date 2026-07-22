// Tier: frontend island logic (no DOM) — public/scripts/admin/helpers.js.
//
// Only the DOM-free half of the module is exercised here: the CSV parser that
// turns the downloaded log files into dashboard rows, plus the date/string
// formatters the tables and charts run every value through. The element
// builders (el/badge/iconDiv) are covered against the fake DOM in
// test/admin-grant-ui.test.js.
//
// parseCSV is the one with real teeth: the CSV logs contain user-supplied text
// (prompts, filenames), so quoting, embedded commas/newlines and doubled quotes
// have to survive the round trip or the dashboard silently mis-columns rows.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCSV, esc, fmtDate, dayKey, daysAgo } from '../public/scripts/admin/helpers.js';

test('parseCSV: plain rows, and blank input is an empty table', () => {
  assert.deepEqual(parseCSV('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCSV(''), []);
  assert.deepEqual(parseCSV('   \n  '), []);
  assert.deepEqual(parseCSV(/** @type {any} */ (null)), []);
});

test('parseCSV: quoted fields keep commas, newlines, and doubled quotes', () => {
  assert.deepEqual(parseCSV('a,"b,c"'), [['a', 'b,c']]);
  assert.deepEqual(parseCSV('a,"line1\nline2"'), [['a', 'line1\nline2']]);
  // "" inside a quoted field is one literal quote.
  assert.deepEqual(parseCSV('a,"say ""hi"""'), [['a', 'say "hi"']]);
});

test('parseCSV: CRLF and LF split the same, trailing newline adds no row', () => {
  assert.deepEqual(parseCSV('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCSV('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
  // A blank line between rows is dropped, not emitted as [''].
  assert.deepEqual(parseCSV('a,b\n\n1,2'), [['a', 'b'], ['1', '2']]);
  // A single unterminated field still yields its row.
  assert.deepEqual(parseCSV('solo'), [['solo']]);
});

test('esc: coerces to string, nullish becomes empty', () => {
  assert.equal(esc('hi'), 'hi');
  assert.equal(esc(/** @type {any} */ (null)), '');
  assert.equal(esc(/** @type {any} */ (undefined)), '');
  assert.equal(esc(/** @type {any} */ (0)), '');
  assert.equal(esc(/** @type {any} */ (7)), '7');
});

test('fmtDate: em dash for missing, month-day-year for a real timestamp', () => {
  assert.equal(fmtDate(''), '—');
  assert.equal(fmtDate(/** @type {any} */ (null)), '—');
  // Locale data varies by ICU build, so assert the shape, not the exact string.
  assert.match(fmtDate('2026-07-22T10:00:00.000Z'), /2026/);
});

test('dayKey: ISO date prefix, null when unparseable', () => {
  assert.equal(dayKey('2026-07-22T10:00:00.000Z'), '2026-07-22');
  assert.equal(dayKey('not-a-date'), null);
  assert.equal(dayKey(''), null);
});

test('daysAgo: n days back, snapped to local midnight', () => {
  const today = daysAgo(0);
  assert.equal(today.getHours(), 0);
  assert.equal(today.getMinutes(), 0);
  assert.equal(today.getSeconds(), 0);
  assert.equal(today.getMilliseconds(), 0);

  const week = daysAgo(7);
  // Exactly 7 local days apart (DST shifts the ms delta, so compare day counts).
  const dayMs = 24 * 60 * 60 * 1000;
  assert.equal(Math.round((today.getTime() - week.getTime()) / dayMs), 7);
  assert.ok(week < today);
});
