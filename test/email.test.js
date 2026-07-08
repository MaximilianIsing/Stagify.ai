// Email send + open-tracking (lib/email.js). The verification-code path must fail
// with the exact status/code contract the auth routes relay, must never leak prod
// mail when EMAIL_DEBUG_MODE redirects recipients, and the open-tracking proxy-UA
// filter gates whether an "open" counts at all. Fake `resend` transport + temp dir
// → no real email is ever sent, no real API call. Fresh factory per test isolates
// the per-instance open-tracking state.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEmail } from '../lib/email.js';

const tmps = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-email-'));
  tmps.push(dir);
  return dir;
}
afterEach(() => {
  while (tmps.length) {
    try { fs.rmSync(tmps.pop(), { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// A fake Resend transport that captures every payload and returns a scripted result.
function fakeResend(result = { data: { id: 'msg_1' }, error: null }) {
  const sent = [];
  return { sent, emails: { send: async (payload) => { sent.push(payload); return result; } } };
}

// Minimal CSV escaper (stands in for lib/logging's escapeCsvField).
const esc = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const baseDeps = (over = {}) => ({
  resend: null, RESEND_FROM_EMAIL: 'no-reply@stagify.ai',
  EMAIL_DEBUG_MODE: false, DEBUG_EMAIL: 'debug@stagify.ai',
  escapeCsvField: esc, getDataLogDir: () => tmpDir(), ...over,
});

test('sendRegistrationVerificationEmail: success returns the needsVerification contract and renders the code', async () => {
  const resend = fakeResend();
  const { sendRegistrationVerificationEmail } = createEmail(baseDeps({ resend }));
  const res = await sendRegistrationVerificationEmail({ toEmail: 'user@example.com', code: '135790' });

  assert.equal(res.ok, true);
  assert.equal(res.body.needsVerification, true);
  const p = resend.sent[0];
  assert.equal(p.subject, 'Your Stagify verification code');
  assert.equal(p.from, 'no-reply@stagify.ai');
  assert.equal(p.to, 'user@example.com', 'sent to the real recipient when not in debug mode');
  assert.ok(p.html.includes('135790'), 'code is in the HTML body');
  assert.ok(p.text.includes('135790'), 'code is in the text body');
  assert.ok(!p.text.includes('intended recipient'), 'no debug note in production mode');
});

test('sendRegistrationVerificationEmail: debug mode redirects to DEBUG_EMAIL and annotates the intended recipient', async () => {
  const resend = fakeResend();
  const { sendRegistrationVerificationEmail } = createEmail(baseDeps({ resend, EMAIL_DEBUG_MODE: true }));
  await sendRegistrationVerificationEmail({ toEmail: 'real@example.com', code: '111222' });

  const p = resend.sent[0];
  assert.equal(p.to, 'debug@stagify.ai', 'redirected away from the real user');
  assert.ok(p.html.includes('intended recipient: real@example.com'), 'HTML notes who it was meant for');
  assert.ok(p.text.includes('intended recipient: real@example.com'));
});

test('sendRegistrationVerificationEmail: transport failures map to the exact status/code the routes relay', async () => {
  const notConfigured = createEmail(baseDeps({ resend: null }));
  const r1 = await notConfigured.sendRegistrationVerificationEmail({ toEmail: 'a@b.com', code: '1' });
  assert.equal(r1.ok, false);
  assert.equal(r1.status, 503);
  assert.equal(r1.body.code, 'EMAIL_NOT_CONFIGURED');

  const failing = createEmail(baseDeps({ resend: fakeResend({ data: null, error: { message: 'rate limited' } }) }));
  const r2 = await failing.sendRegistrationVerificationEmail({ toEmail: 'a@b.com', code: '1' });
  assert.equal(r2.ok, false);
  assert.equal(r2.status, 502);
  assert.equal(r2.body.code, 'EMAIL_SEND_FAILED');
});

test('isStrictEmailClientProxyUa: only known image proxies count; bots and real browsers do not', () => {
  const { isStrictEmailClientProxyUa: p } = createEmail(baseDeps());
  // Recognized email-provider image proxies → true.
  assert.equal(p('Mozilla/5.0 GoogleImageProxy'), true);
  assert.equal(p('ggpht.com'), true);
  assert.equal(p('Microsoft Outlook 16.0'), true);
  assert.equal(p('ms-office'), true);
  // Bots, scanners, link-rewriters, and plain browsers → false (would count prefetches as opens).
  assert.equal(p('curl/7.88.1'), false);
  assert.equal(p('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537'), false);
  assert.equal(p('Outlook-iOS via SafeLinks'), false, 'a SafeLinks scan is rejected even though it says Outlook');
  assert.equal(p('cloudflare-alwaysonline'), false);
  assert.equal(p(''), false);
  assert.equal(p('unknown'), false);
});

test('open tracking: markEmailOpened is once-ever and the first timestamp wins', () => {
  const dir = tmpDir();
  const em = createEmail(baseDeps({ getDataLogDir: () => dir }));
  em.markEmailOpened('a@x.com', '2026-01-01T00:00:00Z');
  em.markEmailOpened('a@x.com', '2026-02-02T00:00:00Z'); // ignored — already opened
  assert.equal(em.hasEmailEverOpened('a@x.com'), true);
  assert.equal(em.hasEmailEverOpened('b@x.com'), false);

  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'email_opened.json'), 'utf8'));
  assert.deepEqual(Object.keys(stored), ['a@x.com']);
  assert.equal(stored['a@x.com'], '2026-01-01T00:00:00Z', 'the earlier open is not overwritten');
});

test('loadEmailOpened bootstraps only strict-proxy rows from the CSV', () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, 'email_open_logs.csv'),
    'timestamp,email,ipAddress,userAgent\n' +
    '2026-01-01T00:00:00Z,proxy@x.com,1.1.1.1,GoogleImageProxy\n' +
    '2026-01-01T00:00:00Z,bot@x.com,2.2.2.2,curl/7.0\n',
  );
  const em = createEmail(baseDeps({ getDataLogDir: () => dir }));
  em.loadEmailOpened();
  assert.equal(em.hasEmailEverOpened('proxy@x.com'), true, 'proxy-opened row imported');
  assert.equal(em.hasEmailEverOpened('bot@x.com'), false, 'bot row skipped');
  assert.ok(fs.existsSync(path.join(dir, 'email_opened.json')), 'bootstrap result is persisted');
});

test('logEmailOpenToFile records an open exactly once', () => {
  const dir = tmpDir();
  const em = createEmail(baseDeps({ getDataLogDir: () => dir }));
  const req = { ip: '1.2.3.4', get: () => 'GoogleImageProxy' };
  em.logEmailOpenToFile('c@x.com', req);
  em.logEmailOpenToFile('c@x.com', req); // second open is a no-op (already recorded)

  const lines = fs.readFileSync(path.join(dir, 'email_open_logs.csv'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'header + exactly one data row after two calls');
  assert.ok(lines[1].includes('c@x.com'));
  assert.equal(em.hasEmailEverOpened('c@x.com'), true);
});
