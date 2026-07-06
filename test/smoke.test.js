// Tier 0 — boot smoke test.
//
// The single most common way this monolithic server.js takes production down is
// "it doesn't start" (a bad import, a syntax slip, a route wired wrong). This test
// boots the real server and asserts GET /health returns 200 { status: 'healthy' }.
// No secrets, no API calls, no money spent — the server degrades gracefully when
// unconfigured.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../test-helpers/server.js';

test('server boots and GET /health returns healthy', async () => {
  const server = await startServer();
  try {
    const res = await fetch(`${server.baseUrl}/health`);
    assert.equal(res.status, 200, 'GET /health should return 200');
    const body = await res.json();
    assert.equal(body.status, 'healthy', 'health body should report status: healthy');
  } finally {
    server.close();
  }
});
