// Ceilings and the proxy-UA filter on email open tracking (lib/services/email.js).
//
// WHY THIS EXISTS: GET /email/logo.png is unauthenticated by construction — a mail
// client's image proxy fetches it — and its `?email=` is attacker-controlled. Every
// address we have not seen before APPENDS a row to email_open_logs.csv, adds an entry
// to an in-memory Map and rewrites email_opened.json whole, all on the volume
// auth-store.db lives on. So the two things that keep the tracker from being an
// unbounded anonymous write are asserted here: which user agents are allowed to record
// an open at all, and the absolute ceilings past which recording stops.
//
// Fake transport + temp dir → no mail is sent and the real ./data is never touched.
// A fresh factory per test isolates the per-instance tracking state.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createEmail,
  EMAIL_OPEN_LOG_MAX_BYTES,
  EMAIL_OPEN_MAX_ENTRIES,
  emailOpenLogCeiling,
  emailOpenEntriesCeiling,
} from '../../lib/services/email.js';

const tmps = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-openceiling-'));
  tmps.push(dir);
  return dir;
}

const BYTES_SNAPSHOT = process.env.EMAIL_OPEN_LOG_MAX_BYTES;
const ENTRIES_SNAPSHOT = process.env.EMAIL_OPEN_MAX_ENTRIES;
afterEach(() => {
  if (BYTES_SNAPSHOT === undefined) delete process.env.EMAIL_OPEN_LOG_MAX_BYTES;
  else process.env.EMAIL_OPEN_LOG_MAX_BYTES = BYTES_SNAPSHOT;
  if (ENTRIES_SNAPSHOT === undefined) delete process.env.EMAIL_OPEN_MAX_ENTRIES;
  else process.env.EMAIL_OPEN_MAX_ENTRIES = ENTRIES_SNAPSHOT;
  while (tmps.length) {
    try { fs.rmSync(tmps.pop(), { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const esc = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const emailApi = (dir) => createEmail({
  resend: null,
  RESEND_FROM_EMAIL: 'no-reply@stagify.ai',
  EMAIL_DEBUG_MODE: false,
  DEBUG_EMAIL: 'debug@stagify.ai',
  escapeCsvField: esc,
  getDataLogDir: () => dir,
});

const proxyReq = { ip: '1.2.3.4', get: () => 'GoogleImageProxy' };

/** The CSV row count (excluding the header), or 0 before the file exists. */
function rowCount(dir) {
  const file = path.join(dir, 'email_open_logs.csv');
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8').trim().split('\n').length - 1;
}

/** appendFile is async, so give the tail of a batch a moment to land. */
async function settle(dir, expected) {
  for (let i = 0; i < 100 && rowCount(dir) < expected; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ── The user-agent filter ────────────────────────────────────────────────────

test('a bare `outlook` user agent no longer records an open', () => {
  const { isConfirmedEmailClientOpen } = emailApi(tmpDir());
  // The whole gate on the route is this predicate, and it used to accept any UA
  // CONTAINING 'outlook' — so `curl -H 'User-Agent: outlook'` marked any address in
  // `?email=` as opened, forever, one CSV row at a time.
  for (const ua of ['outlook', 'Outlook', 'my-outlook', 'outlook.com', 'OUTLOOK/1']) {
    assert.equal(
      isConfirmedEmailClientOpen({ get: () => ua }),
      false,
      `a bare "${ua}" must not count as an open`,
    );
  }
  // Neither does a fragment of the other Microsoft tokens.
  assert.equal(isConfirmedEmailClientOpen({ get: () => 'office' }), false);
  assert.equal(isConfirmedEmailClientOpen({ get: () => 'msoffices' }), false);
});

test('the real provider proxies still record an open', () => {
  const { isConfirmedEmailClientOpen: open } = emailApi(tmpDir());
  const real = [
    'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)',
    'Mozilla/5.0 GoogleImageProxy',
    'ggpht.com',
    'YahooMailProxy; https://help.yahoo.com/kb/yahoo-mail-proxy-SLN28749.html',
    'Mozilla/4.0 (compatible; ms-office; MSOffice 16)',
    'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; Microsoft Outlook 16.0.5134; Pro)',
    'Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.10827; Pro)',
  ];
  for (const ua of real) {
    assert.equal(open({ get: () => ua }), true, `a genuine proxy UA must still count: ${ua}`);
  }
});

// ── The ceilings ─────────────────────────────────────────────────────────────

test('the ceilings fall back to their compiled defaults on a missing or nonsense override', () => {
  delete process.env.EMAIL_OPEN_LOG_MAX_BYTES;
  delete process.env.EMAIL_OPEN_MAX_ENTRIES;
  assert.equal(emailOpenLogCeiling(), EMAIL_OPEN_LOG_MAX_BYTES);
  assert.equal(emailOpenEntriesCeiling(), EMAIL_OPEN_MAX_ENTRIES);

  for (const bad of ['', 'lots', '0', '-1', 'NaN']) {
    process.env.EMAIL_OPEN_LOG_MAX_BYTES = bad;
    process.env.EMAIL_OPEN_MAX_ENTRIES = bad;
    assert.equal(emailOpenLogCeiling(), EMAIL_OPEN_LOG_MAX_BYTES, `"${bad}" must not disable the backstop`);
    assert.equal(emailOpenEntriesCeiling(), EMAIL_OPEN_MAX_ENTRIES, `"${bad}" must not disable the backstop`);
  }

  process.env.EMAIL_OPEN_LOG_MAX_BYTES = '4096';
  process.env.EMAIL_OPEN_MAX_ENTRIES = '7';
  assert.equal(emailOpenLogCeiling(), 4096, 'a real override wins');
  assert.equal(emailOpenEntriesCeiling(), 7);
});

test('the open log stops growing once it hits its byte ceiling', async () => {
  const dir = tmpDir();
  const em = emailApi(dir);

  em.logEmailOpenToFile('first@example.com', proxyReq);
  await settle(dir, 1);
  const sizeAfterFirst = fs.statSync(path.join(dir, 'email_open_logs.csv')).size;
  assert.equal(rowCount(dir), 1);

  // Drop the ceiling to exactly what is already on disk.
  process.env.EMAIL_OPEN_LOG_MAX_BYTES = String(sizeAfterFirst);

  // A flood of never-seen addresses — the abuse shape — writes nothing more.
  for (let i = 0; i < 50; i += 1) em.logEmailOpenToFile(`flood${i}@example.com`, proxyReq);
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(rowCount(dir), 1, 'no row is appended past the ceiling');
  assert.equal(fs.statSync(path.join(dir, 'email_open_logs.csv')).size, sizeAfterFirst);
  assert.equal(em.hasEmailEverOpened('flood0@example.com'), false, 'and nothing is marked as opened');
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'email_opened.json'), 'utf8'));
  assert.deepEqual(Object.keys(stored), ['first@example.com'], 'the JSON side stops growing too');
});

test('the open log stops growing once it hits its entry ceiling', async () => {
  const dir = tmpDir();
  process.env.EMAIL_OPEN_MAX_ENTRIES = '3';
  // Deliberately no byte ceiling: the entry cap is what bounds the in-memory Map and
  // email_opened.json, which grow per UNIQUE address regardless of the CSV's size.
  const em = emailApi(dir);

  for (let i = 0; i < 25; i += 1) em.logEmailOpenToFile(`user${i}@example.com`, proxyReq);
  await settle(dir, 3);
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(rowCount(dir), 3, 'exactly the ceiling, not 25');
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'email_opened.json'), 'utf8'));
  assert.equal(Object.keys(stored).length, 3);
  assert.equal(em.hasEmailEverOpened('user0@example.com'), true, 'the first arrivals are kept');
  assert.equal(em.hasEmailEverOpened('user24@example.com'), false, 'the rest are dropped');
});

test('an address already recorded is unaffected by the ceilings', async () => {
  const dir = tmpDir();
  const em = emailApi(dir);
  em.logEmailOpenToFile('known@example.com', proxyReq);
  await settle(dir, 1);

  process.env.EMAIL_OPEN_MAX_ENTRIES = '1';
  process.env.EMAIL_OPEN_LOG_MAX_BYTES = '1';
  // A repeat open was always a no-op (binary tracking), and it must stay a cheap
  // no-op rather than tripping the ceiling warning path.
  em.logEmailOpenToFile('known@example.com', proxyReq);
  assert.equal(rowCount(dir), 1);
  assert.equal(em.hasEmailEverOpened('known@example.com'), true);
});
