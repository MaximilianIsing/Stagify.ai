// Trial-lifecycle email senders (lib/services/lifecycle-emails.js). A fake Resend
// transport captures every payload — no real mail. Verifies each of the five
// templates: it no-ops safely without Resend, honours the EMAIL_DEBUG_MODE
// redirect, sends the right subject/links, and never throws on a transport error.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycleEmails } from '../lib/services/lifecycle-emails.js';

function fakeResend(result = { error: null }) {
  const sent = [];
  return { sent, emails: { send: async (payload) => { sent.push(payload); return result; } } };
}

const deps = (over = {}) => ({
  resend: fakeResend(),
  RESEND_FROM_EMAIL: 'team@stagify.ai',
  EMAIL_DEBUG_MODE: false,
  DEBUG_EMAIL: 'debug@stagify.ai',
  appUrl: 'https://stagify.ai',
  ...over,
});

test('no Resend configured → every sender skips without throwing', async () => {
  const e = createLifecycleEmails(deps({ resend: null }));
  for (const r of [
    await e.sendTrialWelcome({ toEmail: 'a@b.com' }),
    await e.sendTrialActivationNudge({ toEmail: 'a@b.com' }),
    await e.sendTrialValue({ toEmail: 'a@b.com' }),
    await e.sendTrialEnding({ toEmail: 'a@b.com', daysLeft: 2 }),
    await e.sendSubscriptionCanceled({ toEmail: 'a@b.com' }),
  ]) {
    assert.equal(r.ok, false);
    assert.equal(r.skipped, true);
  }
});

test('welcome: sends to the user, promises a pre-charge reminder, links home', async () => {
  const resend = fakeResend();
  const e = createLifecycleEmails(deps({ resend }));
  const r = await e.sendTrialWelcome({ toEmail: 'buyer@example.com' });
  assert.equal(r.ok, true);
  assert.equal(resend.sent.length, 1);
  const msg = resend.sent[0];
  assert.equal(msg.to, 'buyer@example.com');
  assert.equal(msg.from, 'team@stagify.ai');
  assert.match(msg.subject, /trial is live/i);
  assert.match(msg.text, /2 days before your trial ends/i);
  assert.match(msg.html, /https:\/\/stagify\.ai\//);
});

test('EMAIL_DEBUG_MODE redirects all mail to DEBUG_EMAIL', async () => {
  const resend = fakeResend();
  const e = createLifecycleEmails(deps({ resend, EMAIL_DEBUG_MODE: true }));
  await e.sendTrialWelcome({ toEmail: 'real-user@example.com' });
  assert.equal(resend.sent[0].to, 'debug@stagify.ai');
});

test('ending: pluralises the recap and reflects daysLeft in the subject', async () => {
  const resend = fakeResend();
  const e = createLifecycleEmails(deps({ resend }));

  await e.sendTrialEnding({ toEmail: 'x@y.com', daysLeft: 1, roomsStaged: 1 });
  assert.match(resend.sent[0].subject, /tomorrow/i);
  assert.match(resend.sent[0].text, /staged 1 room\b/);

  await e.sendTrialEnding({ toEmail: 'x@y.com', daysLeft: 3, roomsStaged: 6 });
  assert.match(resend.sent[1].subject, /in 3 days/i);
  assert.match(resend.sent[1].text, /staged 6 rooms/);
});

test('ending with zero rooms staged uses the "still time" recap, not a count', async () => {
  const resend = fakeResend();
  const e = createLifecycleEmails(deps({ resend }));
  await e.sendTrialEnding({ toEmail: 'x@y.com', daysLeft: 2, roomsStaged: 0 });
  assert.match(resend.sent[0].text, /still time/i);
  assert.doesNotMatch(resend.sent[0].text, /staged 0/);
});

test('canceled: shows the access-until date when provided and invites a reply', async () => {
  const resend = fakeResend();
  const e = createLifecycleEmails(deps({ resend }));
  const until = new Date('2026-08-15T00:00:00Z');
  const r = await e.sendSubscriptionCanceled({ toEmail: 'x@y.com', accessUntil: until });
  assert.equal(r.ok, true);
  assert.match(resend.sent[0].subject, /canceled/i);
  assert.match(resend.sent[0].html, /August 15, 2026/);
});

test('a Resend transport error resolves to { ok:false } rather than throwing', async () => {
  const resend = fakeResend({ error: { message: 'rate limited' } });
  const e = createLifecycleEmails(deps({ resend }));
  const r = await e.sendTrialValue({ toEmail: 'x@y.com' });
  assert.equal(r.ok, false);
});

test('value email points at the AI Designer + Masking Studio', async () => {
  const resend = fakeResend();
  const e = createLifecycleEmails(deps({ resend }));
  await e.sendTrialValue({ toEmail: 'x@y.com' });
  assert.match(resend.sent[0].text, /ai-designer\.html/);
  assert.match(resend.sent[0].text, /masking-studio\.html/);
});
