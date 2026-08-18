// Tier: route contract (fake Resend) — POST /api/send-email.
//
// WHAT THIS COVERS
// The Resend SDK does NOT throw when a send is rejected: it resolves with
// { data: null, error }. The handler used to ignore that field entirely, so a
// bounce, a suppressed recipient or a bad `from` still answered 200
// {success:true} — and callers had no way to tell a delivered mail from a
// dropped one. These tests pin both halves of the contract: the failure branch
// must surface, and the success branch must return the id from its real v6
// location (`data.id`, not `result.id`).
//
// The router is mounted on a bare Express app with a fake Resend client, so
// nothing here sends mail or touches the network.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import createPublicRouter from '../../routes/public.js';

const KEY = 'test-endpoint-key';
const pass = (req, res, next) => next();

// Mount the real public router with a scripted Resend. `sendResult` is whatever
// resend.emails.send() should resolve to (or a function to throw from).
async function mountPublicEmail(sendResult) {
  const sent = [];
  const resend = {
    emails: {
      send: async (data) => {
        sent.push(data);
        if (typeof sendResult === 'function') return sendResult(data);
        return sendResult;
      },
    },
  };

  const app = express();
  app.use(express.json());
  app.use(
    createPublicRouter({
      resend,
      LOGS_ACCESS_KEY: KEY,
      // Real guard semantics are covered by test/server/guards.test.js; here we
      // only need the key to match so we reach the send.
      endpointKeyMatches: (received, expected) => received === expected,
      emailLimiter: pass,
      RESEND_FROM_EMAIL: 'noreply@stagify.ai',
      DEBUG_MODE: false,
      EMAIL_DEBUG_MODE: false,
      DEBUG_EMAIL: 'debug@stagify.ai',
      // Unused by /api/send-email, but the factory destructures the whole bag.
      authStore: {}, uptimeMonitor: {}, STATS_DEBUG: false, DEBUG_ROOMS: 0, DEBUG_USERS: 0,
      hostedImages: { getHostedImagesDir: () => '', readHostedImagesManifest: () => ({}) },
      email: { logEmailOpenToFile: () => {}, isConfirmedEmailClientOpen: () => false },
      healthHandler: (req, res) => res.json({ ok: true }),
      getPromptCount: () => 0, getContactCount: () => 0, incContactCount: () => {},
      __dirname: process.cwd(),
    }),
  );

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    sent,
    close: () => new Promise((r) => server.close(r)),
  };
}

let app;
afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

const postEmail = (base, body) =>
  fetch(`${base}/api/send-email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Stagify-Endpoint-Key': KEY },
    body: JSON.stringify(body),
  });

const BODY = { to: 'someone@example.com', subject: 'hi', text: 'hello' };

test('a Resend-rejected send returns 502, not a false success', async () => {
  app = await mountPublicEmail({
    data: null,
    error: { statusCode: 422, name: 'validation_error', message: 'Invalid `to` field.' },
  });

  const res = await postEmail(app.baseUrl, BODY);
  const json = await res.json();

  assert.equal(res.status, 502);
  assert.equal(json.success, undefined);
  assert.equal(json.error, 'Failed to send email');
  // Resend's prose describes OUR account, domains and suppression list, so it stays
  // server-side: the caller gets a reference, the operator gets the text in the log.
  assert.match(json.ref, /^[0-9a-f]{8}$/);
  assert.doesNotMatch(JSON.stringify(json), /Invalid `to` field|validation_error/);
  // The send was still attempted — this is the response-handling bug, not a guard.
  assert.equal(app.sent.length, 1);
});

test('a non-string Resend error is still surfaced as a 502', async () => {
  app = await mountPublicEmail({ data: null, error: { statusCode: 429 } });

  const res = await postEmail(app.baseUrl, BODY);
  const json = await res.json();

  assert.equal(res.status, 502);
  assert.match(json.ref, /^[0-9a-f]{8}$/, 'a stringified upstream object is still only a reference');
  assert.doesNotMatch(JSON.stringify(json), /429/);
});

test('a successful send returns the id from the v6 data envelope', async () => {
  app = await mountPublicEmail({ data: { id: 'msg_abc123' }, error: null });

  const res = await postEmail(app.baseUrl, BODY);
  const json = await res.json();

  assert.equal(res.status, 200);
  assert.equal(json.success, true);
  // Regression guard: reading result.id instead of result.data.id silently
  // returned undefined on every successful send.
  assert.equal(json.id, 'msg_abc123');
  assert.deepEqual(app.sent[0].to, ['someone@example.com']);
  assert.equal(app.sent[0].from, 'noreply@stagify.ai');
});

test('a thrown transport error is still a 500 (unchanged)', async () => {
  app = await mountPublicEmail(() => {
    throw new Error('socket hang up');
  });

  const res = await postEmail(app.baseUrl, BODY);
  const json = await res.json();

  assert.equal(res.status, 500);
  assert.equal(json.error, 'Failed to send email');
  assert.match(json.ref, /^[0-9a-f]{8}$/);
  assert.doesNotMatch(JSON.stringify(json), /socket hang up/, 'transport internals stay in the log');
});
