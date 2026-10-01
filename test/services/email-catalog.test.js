// Email catalog (lib/services/email-catalog.js). The catalog is the single source
// the admin Emails tab previews and the "send test" button mails, built from the
// same pure renderers the real senders use. These tests pin the roster, assert
// every entry is a complete, renderable email, and that links honour appUrl.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmailCatalog, createTestEmailSender } from '../../lib/services/email-catalog.js';

const EXPECTED_IDS = [
  'verification',
  'account-exists',
  'password-reset',
  'password-changed',
  'trial-welcome',
  'trial-activation',
  'trial-value',
  'trial-ending',
  'subscription-canceled',
];

test('list() returns the full user-facing roster in order', () => {
  const cat = createEmailCatalog({ appUrl: 'https://stagify.ai' });
  assert.deepEqual(cat.ids(), EXPECTED_IDS);
  assert.deepEqual(cat.list().map((e) => e.id), EXPECTED_IDS);
});

test('every entry is a complete, renderable email', () => {
  const cat = createEmailCatalog({ appUrl: 'https://stagify.ai' });
  for (const e of cat.list()) {
    assert.ok(e.label && e.category && e.description, `${e.id} has metadata`);
    assert.ok(typeof e.subject === 'string' && e.subject.length, `${e.id} has a subject`);
    assert.ok(typeof e.html === 'string' && e.html.length > 40, `${e.id} has html`);
    assert.ok(typeof e.text === 'string' && e.text.length > 20, `${e.id} has text`);
  }
});

test('renderById returns a single entry, or null for an unknown id', () => {
  const cat = createEmailCatalog({ appUrl: 'https://stagify.ai' });
  const one = cat.renderById('trial-welcome');
  assert.equal(one.id, 'trial-welcome');
  assert.match(one.subject, /trial is live/i);
  assert.equal(cat.renderById('does-not-exist'), null);
});

test('links use the configured appUrl (trailing slash normalised)', () => {
  const cat = createEmailCatalog({ appUrl: 'https://example.test/' });
  const welcome = cat.renderById('trial-welcome');
  assert.match(welcome.html, /https:\/\/example\.test\//);
  assert.doesNotMatch(welcome.html, /example\.test\/\//, 'no double slash from a trailing-slash appUrl');
});

test('sample data renders realistic previews (code, reset link, ending recap)', () => {
  const cat = createEmailCatalog({ appUrl: 'https://stagify.ai' });
  assert.match(cat.renderById('verification').html, /123456/);
  assert.match(cat.renderById('password-reset').html, /reset-password\.html\?token=/);
  assert.match(cat.renderById('trial-ending').subject, /in 2 days/i);
  assert.match(cat.renderById('trial-ending').html, /staged <strong>4 rooms/);
});

test('defaults to the production origin when no appUrl is given', () => {
  const cat = createEmailCatalog();
  assert.match(cat.renderById('trial-welcome').html, /https:\/\/stagify\.ai\//);
});

// createTestEmailSender: the Emails tab's "send test to me". It must never throw,
// because the admin route maps its { ok, status, error } straight onto the response.
function fakeResend(impl) {
  const sent = [];
  return { sent, emails: { send: async (msg) => { sent.push(msg); return impl ? impl(msg) : { data: { id: 'x' } }; } } };
}

test('test sender: no resend client answers 503', async () => {
  const send = createTestEmailSender({ resend: null, from: 'team@stagify.ai', emailCatalog: createEmailCatalog() });
  const out = await send({ id: 'verification', toEmail: 'op@example.com' });
  assert.equal(out.ok, false);
  assert.equal(out.status, 503);
});

test('test sender: unknown template answers 400 without sending', async () => {
  const resend = fakeResend();
  const send = createTestEmailSender({ resend, from: 'team@stagify.ai', emailCatalog: createEmailCatalog() });
  const out = await send({ id: 'nope', toEmail: 'op@example.com' });
  assert.equal(out.status, 400);
  assert.equal(resend.sent.length, 0);
});

test('test sender: sends the rendered template to the exact address, subject prefixed', async () => {
  const resend = fakeResend();
  const cat = createEmailCatalog();
  const send = createTestEmailSender({ resend, from: 'team@stagify.ai', emailCatalog: cat });
  const out = await send({ id: 'trial-welcome', toEmail: 'op@example.com' });
  assert.deepEqual(out, { ok: true });
  const entry = cat.renderById('trial-welcome');
  assert.equal(resend.sent.length, 1);
  assert.equal(resend.sent[0].to, 'op@example.com');
  assert.equal(resend.sent[0].from, 'team@stagify.ai');
  assert.equal(resend.sent[0].subject, `[Test] ${entry?.subject}`);
  assert.equal(resend.sent[0].html, entry?.html);
});

test('test sender: a provider-reported error answers 502', async () => {
  const resend = fakeResend(() => ({ error: { message: 'domain not verified' } }));
  const send = createTestEmailSender({ resend, from: 'team@stagify.ai', emailCatalog: createEmailCatalog() });
  const out = await send({ id: 'verification', toEmail: 'op@example.com' });
  assert.equal(out.status, 502);
  assert.equal(out.error, 'The email provider rejected the send.');
});

test('test sender: a thrown send answers 502 instead of rejecting', async () => {
  const resend = fakeResend(() => { throw new Error('network down'); });
  const send = createTestEmailSender({ resend, from: 'team@stagify.ai', emailCatalog: createEmailCatalog() });
  const out = await send({ id: 'verification', toEmail: 'op@example.com' });
  assert.equal(out.status, 502);
  assert.equal(out.error, 'Could not send the test email.');
});
