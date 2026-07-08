// Tier 2 — request-body size limits (server.js JSON parser scoping).
//
// The JSON body parser runs BEFORE the per-route rate limiters, and JSON.parse is
// synchronous, so an oversized body is buffered + parsed on ANY path it accepts —
// a cheap memory/DoS surface on a small instance. The app-wide limit is therefore
// SMALL (1MB); only the handful of routes that legitimately carry base64 images in
// JSON get a large limit. These tests prove a >1MB body is rejected (413)
// everywhere EXCEPT those routes (which accept it, then reject on content/auth).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

const TWO_MB = JSON.stringify({ blob: 'x'.repeat(2 * 1024 * 1024) });

async function postJson(base, path) {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: TWO_MB,
  });
  return r.status;
}

test('JSON body limit is small by default — a >1MB body is rejected with 413', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  // A normal small-body route, and even an unknown path, must 413 a 2MB body.
  // The unknown-path case is the important one: it proves an attacker can't force
  // a large buffer+parse just by picking any URL.
  assert.equal(await postJson(srv.baseUrl, '/api/log-contact'), 413);
  assert.equal(await postJson(srv.baseUrl, '/api/does-not-exist'), 413);
});

test('image/history routes accept a large JSON body (not 413)', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  // These legitimately receive base64 images in JSON, so a 2MB body must be
  // parsed (then rejected for missing/invalid content or auth) — never 413.
  for (const path of [
    '/api/validate-image',
    '/api/mask-edit',
    '/api/segment',
    '/api/chat',
    '/api/bug-report',
  ]) {
    const status = await postJson(srv.baseUrl, path);
    assert.notEqual(status, 413, `${path} should accept a 2MB body (got ${status})`);
  }
});
