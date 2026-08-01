// CSV business-event writer (lib/services/logging.js) — the analytics sink, NOT the
// diagnostic logger. These rows drive the prompt/mask/chat CSV exports, so a broken
// escaper corrupts every downstream column and a wrong dir silently drops the data.
// We drive each writer against a throwaway temp __dirname and assert on the exact
// bytes written: header on first write, an appended row on the second, and the CSV
// escaping/redaction contract for fields with commas, quotes, and newlines.
//
// process.env.RENDER is snapshotted + cleared so the "/data mounted disk" branch is
// never taken — every write lands under <__dirname>/data where the test can read it.

import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogging, csvLogMaxBytes, CSV_LOG_MAX_BYTES } from '../../lib/services/logging.js';

const tmps = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-logging-'));
  tmps.push(dir);
  return dir;
}

// A fresh writer bound to its own temp __dirname → the CSVs live at <dir>/data/*.csv.
function freshLogging() {
  const dir = tmpDir();
  const logging = createLogging({ __dirname: dir });
  return { logging, dataDir: path.join(dir, 'data') };
}

const readCsv = (file) => fs.readFileSync(file, 'utf8');
const lines = (file) => readCsv(file).trim().split('\n');

// The first row is written synchronously (writeFileSync); every later row is an async
// fs.appendFile, so appends need a short poll before the bytes are on disk.
async function waitForLineCount(file, n, { tries = 100, delay = 5 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (fs.existsSync(file) && lines(file).length >= n) return;
    await new Promise((r) => setTimeout(r, delay));
  }
  assert.fail(`timed out waiting for ${n} lines in ${file}`);
}

let renderSnapshot;
beforeEach(() => {
  renderSnapshot = process.env.RENDER;
  delete process.env.RENDER; // force the local <__dirname>/data branch, never /data
});
afterEach(() => {
  if (renderSnapshot === undefined) delete process.env.RENDER;
  else process.env.RENDER = renderSnapshot;
  while (tmps.length) {
    try { fs.rmSync(tmps.pop(), { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('escapeCsvField: shared hardened escaper — RFC-4180 quoting + formula-injection neutralization', () => {
  const { logging } = freshLogging();
  // createLogging now re-exports the shared lib/http/csv-escape.js escaper (same
  // instance injected into email.js), so every CSV writer is hardened identically.
  const { escapeCsvField: e } = logging;
  assert.equal(e('plain'), 'plain', 'no special chars → unchanged');
  assert.equal(e(''), '', 'empty string stays empty');
  assert.equal(e(null), '', 'null → empty');
  assert.equal(e(undefined), '', 'undefined → empty');
  assert.equal(e(42), '42', 'non-strings are stringified');
  assert.equal(e('a,b'), '"a,b"', 'comma forces quoting');
  assert.equal(e('line\nbreak'), '"line\nbreak"', 'newline forces quoting');
  assert.equal(e('say "hi"'), '"say ""hi"""', 'inner quotes are doubled and the field wrapped');
  // Spreadsheet formula injection is neutralized with a leading quote (the reason the
  // shared escaper exists) — a prompt/userAgent starting with = + - @ can't execute in Excel.
  assert.equal(e('=1+1'), "'=1+1", 'leading = neutralized');
  assert.equal(e('+1'), "'+1", 'leading + neutralized');
  assert.equal(e('-cmd'), "'-cmd", 'leading - neutralized');
  assert.equal(e('@x'), "'@x", 'leading @ neutralized');
});

test('getDataLogDir: returns <__dirname>/data and creates it on demand', () => {
  const { logging, dataDir } = freshLogging();
  assert.equal(fs.existsSync(dataDir), false, 'dir does not exist before the first call');
  const dir = logging.getDataLogDir();
  assert.equal(dir, dataDir);
  assert.equal(fs.existsSync(dataDir), true, 'getDataLogDir creates the data dir');
});

test('logPromptToFile: first call writes header + row; the fields land in column order', () => {
  const { logging, dataDir } = freshLogging();
  const req = { ip: '203.0.113.9' };
  logging.logPromptToFile('the prompt', 'Living Room', 'Modern', 'extra note', false, 'realtor', 'google', 'u@x.com', req,
    { status: 'ok', durationMs: 8421.7, model: 'gemini-2.5-flash-image', attempts: 2, errorCode: '' });

  const file = path.join(dataDir, 'prompt_logs.csv');
  const l = lines(file);
  assert.equal(l.length, 2, 'header + exactly one data row (synchronous first write)');
  assert.equal(
    l[0],
    'timestamp,roomType,furnitureStyle,additionalPrompt,removeFurniture,userRole,referralSource,email,ipAddress,status,durationMs,model,attempts,errorCode',
  );
  const cols = l[1].split(',');
  // cols[0] is the ISO timestamp; assert the stable, positioned fields.
  assert.equal(cols[1], 'Living Room');
  assert.equal(cols[2], 'Modern');
  assert.equal(cols[3], 'extra note');
  assert.equal(cols[4], 'false');
  assert.equal(cols[5], 'realtor');
  assert.equal(cols[6], 'google');
  assert.equal(cols[7], 'u@x.com');
  assert.equal(cols[8], '203.0.113.9');
  // The outcome columns are APPENDED, so these indices must never shift — the
  // admin dashboard reads this file positionally.
  assert.equal(cols[9], 'ok');
  assert.equal(cols[10], '8422', 'durationMs is rounded to a whole millisecond');
  assert.equal(cols[11], 'gemini-2.5-flash-image');
  assert.equal(cols[12], '2');
  assert.equal(cols[13], '');
});

test('logPromptToFile: an omitted outcome writes unknown/empty, never a fake success', () => {
  const { logging, dataDir } = freshLogging();
  logging.logPromptToFile('p', 'Room', 'S', '', false, 'r', 'src', 'a@x.com', { ip: '1.1.1.1' });
  const cols = lines(path.join(dataDir, 'prompt_logs.csv'))[1].split(',');
  assert.equal(cols[9], 'unknown', 'status is unknown, not ok — an unrecorded render is not a success');
  assert.equal(cols[10], '', 'no duration invented');
  assert.equal(cols[12], '', 'no attempt count invented');
});

test('logPromptToFile: a failure row carries its error code and still records duration', () => {
  const { logging, dataDir } = freshLogging();
  logging.logPromptToFile('p', 'Room', 'S', '', false, 'r', 'src', 'a@x.com', { ip: '1.1.1.1' },
    { status: 'failed', durationMs: 1200, model: 'gemini-3-pro-image', attempts: 0, errorCode: 'NO_IMAGE_GENERATED' });
  const cols = lines(path.join(dataDir, 'prompt_logs.csv'))[1].split(',');
  assert.equal(cols[9], 'failed');
  assert.equal(cols[10], '1200');
  assert.equal(cols[12], '0', 'zero attempts is a real value, not a missing one');
  assert.equal(cols[13], 'NO_IMAGE_GENERATED');
});

test('logPromptToFile: a legacy-header file is upgraded in place, keeping every data row', async () => {
  const { logging, dataDir } = freshLogging();
  const file = path.join(dataDir, 'prompt_logs.csv');
  fs.mkdirSync(dataDir, { recursive: true });
  const legacy = 'timestamp,roomType,furnitureStyle,additionalPrompt,removeFurniture,userRole,referralSource,email,ipAddress';
  fs.writeFileSync(file, legacy + '\n2026-01-01T00:00:00.000Z,Old Room,Old Style,,false,r,src,old@x.com,1.1.1.1\n');

  logging.logPromptToFile('p', 'New Room', 'S', '', false, 'r', 'src', 'new@x.com', { ip: '2.2.2.2' },
    { status: 'ok', durationMs: 10, model: 'm', attempts: 1 });

  await waitForLineCount(file, 3);
  const l = lines(file);
  assert.equal(l[0], 'timestamp,roomType,furnitureStyle,additionalPrompt,removeFurniture,userRole,referralSource,email,ipAddress,status,durationMs,model,attempts,errorCode');
  assert.ok(l[1].includes('Old Room'), 'the pre-existing row survives the header rewrite');
  assert.ok(l[2].includes('New Room'));
  assert.equal(fs.existsSync(file + '.tmp'), false, 'the temp file is renamed away, not left behind');
});

test('logPromptToFile: unknown-field defaults and CSV escaping of nasty values', () => {
  const { logging, dataDir } = freshLogging();
  // roomType with a comma must be quoted; additionalPrompt with a quote must be doubled.
  logging.logPromptToFile('p', 'Kitchen, Dining', 'Boho', 'he said "wow"', true, null, null, null, null);

  const file = path.join(dataDir, 'prompt_logs.csv');
  const raw = readCsv(file);
  assert.ok(raw.includes('"Kitchen, Dining"'), 'comma field is quoted');
  assert.ok(raw.includes('"he said ""wow"""'), 'inner quotes doubled');
  // null role/referral/email fall back to the "unknown" sentinels; no req → ip "unknown".
  // null role/referral/email fall back to the "unknown" sentinels; no req → ip
  // "unknown". Asserted as a substring, not by splitting on commas: the quoted
  // "Kitchen, Dining" cell above contains one, which is the whole point of the
  // escaping under test. The outcome-column defaults have their own test.
  const dataRow = lines(file)[1];
  assert.ok(dataRow.includes(',unknown,unknown,unknown,unknown,'), `role/referral/email/ip default to unknown: ${dataRow}`);
});

test('logPromptToFile: a second call appends rather than rewriting the header', async () => {
  const { logging, dataDir } = freshLogging();
  const file = path.join(dataDir, 'prompt_logs.csv');
  logging.logPromptToFile('p1', 'Room1', 'S', '', false, 'r', 'src', 'a@x.com', { ip: '1.1.1.1' });
  logging.logPromptToFile('p2', 'Room2', 'S', '', false, 'r', 'src', 'b@x.com', { ip: '2.2.2.2' });

  await waitForLineCount(file, 3);
  const l = lines(file);
  assert.equal(l.length, 3, 'header + two rows');
  assert.equal(l.filter((x) => x.startsWith('timestamp,')).length, 1, 'header written exactly once');
  assert.ok(l[1].includes('Room1'));
  assert.ok(l[2].includes('Room2'));
});

test('logPromptToFile: neutralizes spreadsheet formula injection in an attacker-controlled field', () => {
  const { logging, dataDir } = freshLogging();
  // additionalPrompt is free text a user controls; a leading = must not execute in Excel.
  logging.logPromptToFile('p', 'Room', 'Style', '=2+3', false, 'realtor', 'google', 'u@x.com', { ip: '1.1.1.1' });
  const raw = readCsv(path.join(dataDir, 'prompt_logs.csv'));
  assert.ok(raw.includes("'=2+3"), `formula-leading field is prefixed with a quote: ${raw}`);
  assert.ok(!raw.includes(',=2+3'), 'the raw =2+3 must not appear as a bare cell value');
});

test('logMaskEditToFile: header, positioned fields, and the userAgent column from req', () => {
  const { logging, dataDir } = freshLogging();
  const req = { ip: '198.51.100.4', get: (h) => (h === 'user-agent' ? 'Mozilla/5.0 Test' : undefined) };
  logging.logMaskEditToFile('add a sofa', 'gpt-4o-mini', 'gemini-2.5', 1024, 768, 'user_7', req);

  const file = path.join(dataDir, 'mask_logs.csv');
  const l = lines(file);
  assert.equal(l[0], 'timestamp,prompt,model,geminiModel,imageWidth,imageHeight,userId,ipAddress,userAgent');
  const cols = l[1].split(',');
  assert.equal(cols[1], 'add a sofa');
  assert.equal(cols[2], 'gpt-4o-mini');
  assert.equal(cols[3], 'gemini-2.5');
  assert.equal(cols[4], '1024');
  assert.equal(cols[5], '768');
  assert.equal(cols[6], 'user_7');
  assert.equal(cols[7], '198.51.100.4');
  assert.equal(cols[8], 'Mozilla/5.0 Test');
});

test('logMaskEditToFile: missing req and blank ids fall back to unknown sentinels', () => {
  const { logging, dataDir } = freshLogging();
  logging.logMaskEditToFile('', null, null, null, null, null, null);
  const cols = lines(path.join(dataDir, 'mask_logs.csv'))[1].split(',');
  assert.equal(cols[2], 'unknown', 'model → unknown');
  assert.equal(cols[3], 'unknown', 'geminiModel → unknown');
  assert.equal(cols[6], 'unknown', 'userId → unknown');
  assert.equal(cols[7], 'unknown', 'no req → ip unknown');
  assert.equal(cols[8], 'unknown', 'no req → userAgent unknown');
});

test('logChatToFile: logs the user message but NEVER the AI response (privacy), and joins file metadata', () => {
  const { logging, dataDir } = freshLogging();
  const files = [
    { name: 'floor.png', type: 'image/png' },
    { originalname: 'plan.pdf', mimetype: 'application/pdf' }, // multer-shaped fallback keys
  ];
  logging.logChatToFile('user_9', 'stage my loft', 'SECRET assistant reply', files, '203.0.113.7', 'UA/1');

  const file = path.join(dataDir, 'chat_logs.csv');
  const l = lines(file);
  assert.equal(l[0], 'timestamp,userId,userMessage,aiResponse,fileNames,fileTypes,ipAddress,userAgent');
  const raw = readCsv(file);
  assert.ok(raw.includes('stage my loft'), 'the user message is recorded');
  assert.ok(!raw.includes('SECRET assistant reply'), 'the AI response is deliberately NOT written');
  assert.ok(raw.includes('floor.png; plan.pdf'), 'file names joined across name/originalname');
  assert.ok(raw.includes('image/png; application/pdf'), 'file types joined across type/mimetype');
  // Fields are quoted only when they contain comma/quote/newline (shared escaper); the
  // redacted aiResponse slot is left blank.
  const cells = l[1].split(',');
  assert.equal(cells[1], 'user_9', 'plain fields pass through unquoted');
  assert.equal(cells[3], '', 'aiResponse column is blank (never populated)');
});

test('logChatToFile: no files → empty name/type columns, and a second call appends', async () => {
  const { logging, dataDir } = freshLogging();
  const file = path.join(dataDir, 'chat_logs.csv');
  logging.logChatToFile('u1', 'hi', '', [], '1.1.1.1', 'UA');
  logging.logChatToFile('u2', 'again', '', null, '2.2.2.2', 'UA');

  await waitForLineCount(file, 3);
  const l = lines(file);
  assert.equal(l.length, 3, 'header + two rows');
  const cells = l[1].split(',');
  assert.equal(cells[4], '', 'no files → empty fileNames');
  assert.equal(cells[5], '', 'no files → empty fileTypes');
});

// ── The absolute byte ceiling ────────────────────────────────────────────────
// These three CSVs are append-only and were the only writers on the volume with no
// bound at all — `bug_reports.csv` and `email_open_logs.csv` both got one years ago.
// It matters more since the Listing Studio: one 30-photo listing at three variations
// writes ~80 prompt rows where the single-photo stager wrote one. The volume also
// holds SQLite's WAL, so an unbounded log takes auth and Stripe webhooks down with it.

test('a log at its ceiling stops GROWING, and is never truncated or rotated', async () => {
  // Truncation would silently drop history, and prompt_logs.csv is what seeds the public
  // "Rooms Staged" count at boot — rewriting it would move a public number. Refusing to
  // grow is the honest failure.
  const { logging, dataDir } = freshLogging();
  const file = path.join(dataDir, 'prompt_logs.csv');

  logging.logPromptToFile('p', 'Living room', 'modern', '', false, 'pro', 'x', 'a@b.co', null);
  await waitForLineCount(file, 2);
  const before = readCsv(file);

  process.env.CSV_LOG_MAX_BYTES = String(before.length);
  try {
    logging.logPromptToFile('p2', 'Bedroom', 'modern', '', false, 'pro', 'x', 'a@b.co', null);
    // The refusal is synchronous, but give a real append the same chance to land.
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(readCsv(file), before, 'the file is byte-identical — nothing added, nothing lost');
  } finally {
    delete process.env.CSV_LOG_MAX_BYTES;
  }

  // …and it resumes the moment the ceiling is raised again.
  logging.logPromptToFile('p3', 'Kitchen', 'modern', '', false, 'pro', 'x', 'a@b.co', null);
  await waitForLineCount(file, 3);
  assert.equal(lines(file).length, 3);
});

test('the ceiling never stops a log from being CREATED', async () => {
  // A new file is 0 bytes, so any ceiling is already "reached" by a naive check placed
  // around the whole writer. That would mean logging never starts at all.
  const { logging, dataDir } = freshLogging();
  process.env.CSV_LOG_MAX_BYTES = '1';
  try {
    logging.logPromptToFile('p', 'Living room', 'modern', '', false, 'pro', 'x', 'a@b.co', null);
    logging.logChatToFile('u1', 'hello', 'hi', [], '1.2.3.4', 'UA');
    logging.logMaskEditToFile('prompt', 'm', 'gm', 10, 10, 'u1', null);
    await waitForLineCount(path.join(dataDir, 'prompt_logs.csv'), 2);
    assert.equal(lines(path.join(dataDir, 'prompt_logs.csv')).length, 2, 'header + the first row');
    assert.equal(fs.existsSync(path.join(dataDir, 'chat_logs.csv')), true);
    assert.equal(fs.existsSync(path.join(dataDir, 'mask_logs.csv')), true);
  } finally {
    delete process.env.CSV_LOG_MAX_BYTES;
  }
});

test('all THREE logs are bounded, not just the prompt log', async () => {
  // chat_logs.csv carries whole user messages and model replies, so it grows fastest of
  // the three; covering only the prompt log would leave the worst offender unbounded.
  const { logging, dataDir } = freshLogging();
  const files = {
    prompt: path.join(dataDir, 'prompt_logs.csv'),
    chat: path.join(dataDir, 'chat_logs.csv'),
    mask: path.join(dataDir, 'mask_logs.csv'),
  };
  logging.logPromptToFile('p', 'Living room', 'modern', '', false, 'pro', 'x', 'a@b.co', null);
  logging.logChatToFile('u1', 'hello', 'hi', [], '1.2.3.4', 'UA');
  logging.logMaskEditToFile('prompt', 'm', 'gm', 10, 10, 'u1', null);
  for (const f of Object.values(files)) await waitForLineCount(f, 2);
  const before = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, readCsv(f)]));

  process.env.CSV_LOG_MAX_BYTES = '1';
  try {
    logging.logPromptToFile('p2', 'Bedroom', 'modern', '', false, 'pro', 'x', 'a@b.co', null);
    logging.logChatToFile('u1', 'again', 'hi', [], '1.2.3.4', 'UA');
    logging.logMaskEditToFile('again', 'm', 'gm', 10, 10, 'u1', null);
    await new Promise((r) => setTimeout(r, 60));
    for (const [name, f] of Object.entries(files)) {
      assert.equal(readCsv(f), before[name], `${name} must not have grown past its ceiling`);
    }
  } finally {
    delete process.env.CSV_LOG_MAX_BYTES;
  }
});

test('a nonsense CSV_LOG_MAX_BYTES falls back to the constant, never to unbounded', async () => {
  const { logging, dataDir } = freshLogging();
  const file = path.join(dataDir, 'prompt_logs.csv');
  for (const bad of ['0', '-5', 'lots', '']) {
    process.env.CSV_LOG_MAX_BYTES = bad;
    try {
      assert.equal(csvLogMaxBytes(), CSV_LOG_MAX_BYTES, `"${bad}" must fall back`);
    } finally {
      delete process.env.CSV_LOG_MAX_BYTES;
    }
  }
  // …and with the default in force, writing still works.
  logging.logPromptToFile('p', 'Living room', 'modern', '', false, 'pro', 'x', 'a@b.co', null);
  await waitForLineCount(file, 2);
  assert.equal(lines(file).length, 2);
});
