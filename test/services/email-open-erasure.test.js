// The erasure seam on open tracking (lib/services/email.js#forgetEmailOpenState).
//
// WHY THIS EXISTS: a GDPR erasure scrubs the erased address out of
// data/email_opened.json (lib/data/user-deletion.js#scrubEmailOpened), but this
// factory loads that file into a Map ONCE and then rewrites the WHOLE map to disk on
// the next open by anybody. So on a running server the scrub was undone by the next
// stranger's tracking pixel, and erasure only actually held across a process restart.
// `forgetEmailOpenState` drops the address from that cache so the scrub sticks.
//
// The scrub below is not reimplemented: it calls the real `redactJsonStore` with the
// real `email_opened.json` entry from JSON_REDACTIONS, so if the erasure side changes
// how it rewrites the file, this test changes with it. Importing that module is inert
// — it opens no database until createUserDeletion() is called, which this never does.
//
// Temp dir per test, fresh factory per test → the real ./data is never touched and no
// tracking state leaks between cases.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEmail } from '../../lib/services/email.js';
import { JSON_REDACTIONS, redactJsonStore } from '../../lib/data/user-deletion.js';

const tmps = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-openerase-'));
  tmps.push(dir);
  return dir;
}
afterEach(() => {
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

const openedFile = (dir) => path.join(dir, 'email_opened.json');
const readOpened = (dir) => JSON.parse(fs.readFileSync(openedFile(dir), 'utf8'));

/** appendFile is async, so wait for the CSV row that accompanies a recorded open. */
async function settle(dir, expected) {
  const file = path.join(dir, 'email_open_logs.csv');
  for (let i = 0; i < 100; i += 1) {
    const rows = fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8').trim().split('\n').length - 1
      : 0;
    if (rows >= expected) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Scrub one address out of email_opened.json exactly as an erasure does. */
function eraseFromDisk(dir, email) {
  const spec = JSON_REDACTIONS.find((s) => s.file === 'email_opened.json');
  assert.ok(spec, 'user-deletion.js must still cover email_opened.json');
  return redactJsonStore(openedFile(dir), spec.scrub, { userId: 'u_erased', email });
}

test('a scrubbed address is not written back to disk by the next open', async () => {
  const dir = tmpDir();
  const em = emailApi(dir);

  // Seed: two recorded opens, which loads the cache AND puts both addresses in it.
  em.logEmailOpenToFile('erased@example.com', proxyReq);
  await settle(dir, 1);
  em.logEmailOpenToFile('keeper@example.com', proxyReq);
  await settle(dir, 2);
  assert.ok(readOpened(dir)['erased@example.com'], 'seeded on disk');
  assert.equal(em.hasEmailEverOpened('erased@example.com'), true, 'and cached in memory');

  // The erasure. Mixed case on purpose: user-deletion matches case-insensitively and
  // so must the invalidation, or the cache keeps the address the file just lost.
  const scrub = eraseFromDisk(dir, 'Erased@Example.COM');
  assert.equal(scrub.matched, 1, 'the erasure removed it from the file');
  assert.equal(readOpened(dir)['erased@example.com'], undefined);

  assert.equal(em.forgetEmailOpenState('Erased@Example.COM'), 1, 'and from the cache');

  // The regression: ANY later open rewrites the whole map over the scrubbed file.
  em.logEmailOpenToFile('stranger@example.com', proxyReq);
  await settle(dir, 3);

  const onDisk = readOpened(dir);
  assert.equal(onDisk['erased@example.com'], undefined, 'the erased address is not resurrected');
  assert.ok(onDisk['keeper@example.com'], 'an unrelated address is untouched');
  assert.ok(onDisk['stranger@example.com'], 'the new open is recorded normally');
  assert.equal(em.hasEmailEverOpened('erased@example.com'), false, 'and the cache agrees with the file');
});

test('never loaded is a no-op — it neither loads nor creates the file', () => {
  const dir = tmpDir();
  const em = emailApi(dir);

  // An erasure can run before this process has served a single tracking pixel. There
  // is then nothing cached to contradict the scrubbed file, so the correct answer is
  // to do nothing at all rather than pull the file into memory to delete from it.
  assert.equal(em.forgetEmailOpenState('anyone@example.com'), 0);
  assert.equal(fs.existsSync(openedFile(dir)), false, 'no file is written');
  assert.equal(fs.existsSync(path.join(dir, 'email_open_logs.csv')), false);
});

test('an address that is not tracked is a no-op, not an error', async () => {
  const dir = tmpDir();
  const em = emailApi(dir);
  em.logEmailOpenToFile('present@example.com', proxyReq);
  await settle(dir, 1);
  const before = fs.readFileSync(openedFile(dir), 'utf8');

  // Most erasures are of accounts that never opened a tracked email.
  assert.equal(em.forgetEmailOpenState('absent@example.com'), 0);
  for (const junk of ['', '   ', null, undefined, 12345, {}]) {
    assert.equal(em.forgetEmailOpenState(junk), 0, `${JSON.stringify(junk)} is a no-op`);
  }
  assert.equal(fs.readFileSync(openedFile(dir), 'utf8'), before, 'the file is never rewritten by this call');
  assert.equal(em.hasEmailEverOpened('present@example.com'), true, 'and nothing else is dropped');
});

test('it drops every casing variant the cache is holding', () => {
  const dir = tmpDir();
  const em = emailApi(dir);
  // markEmailOpened does not normalise, so a key can differ in case from the address
  // an erasure is given (the route lowercases, the CSV bootstrap lowercases, a direct
  // caller need not). All of them have to go, or the file gets one of them back.
  em.markEmailOpened('Mixed@Example.com', '2026-01-01T00:00:00Z');
  em.markEmailOpened('mixed@example.com', '2026-01-02T00:00:00Z');
  em.markEmailOpened('other@example.com', '2026-01-03T00:00:00Z');

  assert.equal(em.forgetEmailOpenState('MIXED@EXAMPLE.COM'), 2);
  assert.equal(em.hasEmailEverOpened('Mixed@Example.com'), false);
  assert.equal(em.hasEmailEverOpened('mixed@example.com'), false);
  assert.equal(em.hasEmailEverOpened('other@example.com'), true);
});
