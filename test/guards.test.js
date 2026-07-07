// Tier 2 (A) — access-guard status codes.
//
// The scariest regressions in this app are silent auth bypasses: a broken guard on
// a log-export route leaks the entire user store (password hashes + session tokens);
// a broken key check hands out free AI staging or an open email relay; a broken
// session check exposes Pro-only endpoints. These tests boot the real server and
// assert each guard REJECTS an unauthenticated / unkeyed request.
//
// Determinism: we boot with a DUMMY access key configured (below) but never send it,
// so guards are always in their "configured, key missing" state → 403 (not the 500
// they'd return when no key is configured at all, e.g. in bare CI).
//
// Safety: we only send read-only, unkeyed requests. We never hit destructive routes
// (/resetmemories, DELETE /api/hosted-images) — if a guard were actually broken we
// don't want the test itself to perform the action. Those routes share the SAME
// protectLogs middleware proven below.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

// A throwaway key that is configured on the server but never sent by any request.
const DUMMY_KEY = 'test-guard-key-not-a-real-secret';

let server;
before(async () => {
  server = await startServer({ endpoint_key: DUMMY_KEY, LOGS_ACCESS_KEY: DUMMY_KEY });
});
after(() => server?.close());

const get = (p) => fetch(`${server.baseUrl}${p}`);
const postJson = (p, body = {}) =>
  fetch(`${server.baseUrl}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// protectLogs — download/admin routes must 403 without the access-key header.
// Read-only routes only (see Safety note above).
const PROTECTED_LOG_ROUTES = [
  '/authstore',        // users, password hashes, session tokens — the crown jewels
  '/promptlogs',
  '/contactlogs',
  '/chatlogs',
  '/bugreports',
  '/masklogs',
  '/memories',
  '/email-open-logs',
  '/enterprise-domains',
  '/api/hosted-images',
];

test('log-export / admin routes reject requests with no access key (403)', async () => {
  for (const route of PROTECTED_LOG_ROUTES) {
    const res = await get(route);
    assert.equal(res.status, 403, `${route} should 403 without a key`);
  }
});

// Server-integration key endpoints must 403 without the shared secret.
test('endpoint-key routes reject requests with no key (403)', async () => {
  const stage = await postJson('/api/stage-by-endpoint-key');
  assert.equal(stage.status, 403, '/api/stage-by-endpoint-key should 403 without a key');

  const email = await postJson('/api/send-email', { to: 'x@example.com', subject: 's', text: 't' });
  assert.equal(email.status, 403, '/api/send-email should 403 without a key');
});

// The admin uptime-reset is a mutating protectLogs route — it must reject an
// unkeyed request (403) so server-status history can't be wiped anonymously.
// protectLogs runs before the handler, so no reset happens here.
test('POST /api/status/reset requires the admin key (403)', async () => {
  const res = await postJson('/api/status/reset');
  assert.equal(res.status, 403, 'POST /api/status/reset should 403 without a key');
});

// The actual Pro grant is POST /api/getpro, guarded by the admin key header (GET
// /getpro is just the retry page and returns HTML for everyone). A wrong key must
// be rejected so Pro can't be self-granted.
test('/api/getpro rejects a wrong admin key (no Pro granted)', async () => {
  const res = await fetch(`${server.baseUrl}/api/getpro`, {
    method: 'POST',
    headers: { 'X-Stagify-Endpoint-Key': 'definitely-not-the-real-key' },
  });
  assert.equal(res.status, 403, 'POST /api/getpro should 403 for a wrong key');
});

// requireProAccount routes must 401 (AUTH_REQUIRED) with no session.
test('Pro-only routes require a session (401)', async () => {
  assert.equal((await get('/api/welcome-message')).status, 401, '/api/welcome-message');
  assert.equal((await postJson('/api/chat', { messages: [] })).status, 401, '/api/chat');
  assert.equal((await postJson('/api/mask-edit', {})).status, 401, '/api/mask-edit');
  assert.equal((await postJson('/api/process-pdf', {})).status, 401, '/api/process-pdf');
});
