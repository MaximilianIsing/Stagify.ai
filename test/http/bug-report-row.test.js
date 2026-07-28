// /api/bug-report is unauthenticated and appends to a CSV on the same persistent
// volume as auth-store.db, so the row builder's clamps ARE the disk-fill defence.
// These tests pin each ceiling: without them a caller could append a body-limit-sized
// row per request and fill the volume out from under SQLite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBugReportRow,
  flattenConversationHistory,
  BUG_REPORT_HEADER,
  BUG_REPORT_LIMITS,
  BUG_REPORT_LOG_MAX_BYTES,
} from '../../lib/http/bug-report-row.js';

test('a huge body produces a bounded row, not a huge one', () => {
  const huge = 'x'.repeat(2 * 1024 * 1024);
  const row = buildBugReportRow(
    {
      description: huge,
      steps: huge,
      email: huge,
      userId: huge,
      userAgent: huge,
      url: huge,
      timestamp: huge,
      conversationHistory: Array.from({ length: 5000 }, () => ({ role: 'user', content: huge })),
    },
    '1.2.3.4'
  );

  // Sum of every cap, doubled to allow for CSV quote-escaping, plus slack for the
  // truncation markers and delimiters — still four orders of magnitude under 2MB.
  const capSum = Object.values(BUG_REPORT_LIMITS).reduce((a, b) => a + b, 0);
  assert.ok(row.length < capSum * 2 + 2000, `row was ${row.length} chars`);
  assert.ok(row.endsWith('\n'));
  // One row, never many: nothing may inject a raw line break outside CSV quoting.
  assert.equal(row.split('\n').length, 2, 'row must stay a single CSV record');
  assert.equal(row.match(/,/g) === null, false);
});

test('each field is clamped to its own limit', () => {
  const row = buildBugReportRow(
    { description: 'd'.repeat(50000), steps: 's'.repeat(50000), url: 'u'.repeat(50000) },
    'ip'
  );
  assert.ok(!row.includes('d'.repeat(BUG_REPORT_LIMITS.description + 1)));
  assert.ok(row.includes('d'.repeat(BUG_REPORT_LIMITS.description)));
  assert.ok(!row.includes('s'.repeat(BUG_REPORT_LIMITS.steps + 1)));
  assert.ok(!row.includes('u'.repeat(BUG_REPORT_LIMITS.url + 1)));
  assert.ok(row.includes('[truncated]'));
});

test('a normal-sized report is stored verbatim', () => {
  const row = buildBugReportRow(
    {
      description: 'The mask editor freezes',
      steps: 'Open the editor, drag a photo in',
      email: 'user@example.com',
      userId: 'u-1',
      userAgent: 'Mozilla/5.0',
      url: 'https://stagify.ai/ai-designer.html',
      timestamp: '2026-07-28T00:00:00.000Z',
      conversationHistory: [{ role: 'user', content: 'stage this' }],
    },
    '9.9.9.9'
  );
  assert.ok(row.includes('The mask editor freezes'));
  assert.ok(row.includes('Open the editor, drag a photo in') || row.includes('"Open the editor, drag a photo in"'));
  assert.ok(row.includes('user@example.com'));
  assert.ok(!row.includes('[truncated]'));
  assert.equal(row.split(',').length >= BUG_REPORT_HEADER.split(',').length, true);
});

test('history keeps the newest messages and reports what it dropped', () => {
  const history = Array.from({ length: BUG_REPORT_LIMITS.historyMessages + 10 }, (_, i) => ({
    role: 'user',
    content: `msg-${i}`,
  }));
  const log = flattenConversationHistory(history);
  assert.ok(log.includes('[10 earlier message(s) omitted]'));
  assert.ok(log.includes(`msg-${history.length - 1}`), 'newest message must survive');
  assert.ok(!log.includes('msg-0 '), 'oldest message must be dropped');
  // Numbering stays absolute so a dropped prefix does not renumber what is kept.
  assert.ok(log.includes(`Message ${history.length} [USER]`));
});

test('image payloads are counted, never stored', () => {
  const dataUrl = `data:image/png;base64,${'A'.repeat(100000)}`;
  const log = flattenConversationHistory([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'stage this' },
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    },
  ]);
  assert.ok(log.includes('[2 image(s)]'));
  assert.ok(!log.includes('AAAA'), 'base64 bytes must never reach the CSV');
});

test('malformed history entries do not throw', () => {
  // The body is untrusted: a missing role used to crash the route with a 500.
  assert.equal(flattenConversationHistory([{ content: 'no role' }]).includes('[UNKNOWN]'), true);
  assert.doesNotThrow(() => flattenConversationHistory([null, 42, { content: [null, { type: 'text' }] }]));
  assert.equal(flattenConversationHistory('not an array'), 'No conversation history');
  assert.equal(flattenConversationHistory([]), 'No conversation history');
});

test('newlines in history cannot split the CSV record', () => {
  const row = buildBugReportRow(
    { description: 'ok', conversationHistory: [{ role: 'user', content: 'a\nb\r\nc' }] },
    'ip'
  );
  assert.ok(row.includes('a b  c') || row.includes('a b c'), 'newlines collapse to spaces');
});

test('the file ceiling is a sane backstop', () => {
  assert.ok(BUG_REPORT_LOG_MAX_BYTES > 1024 * 1024);
  assert.ok(BUG_REPORT_LOG_MAX_BYTES <= 64 * 1024 * 1024);
});
