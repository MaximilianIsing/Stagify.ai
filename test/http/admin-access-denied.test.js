// Tier: unit (lib/http/http-guards.js) — the refused-attempt hook.
//
// WHY THIS IS ITS OWN FILE. The "who tried the door" half of the Access tab does
// not live on a route; it lives in `rejectWith`, the one funnel every refusal in
// the app passes through. That placement is the whole design, and it is only
// correct if three things hold, none of which is obvious from reading the call
// site:
//
//   1. **Every guard is covered.** protectLogs, requireEndpointKey,
//      stagingEndpointKeyGuard and the module-level rejectEndpointKey all reach
//      rejectWith. Instrumenting a route instead would have missed
//      /api/stage-by-endpoint-key and POST /api/getpro, which hold the SAME secret
//      — the second of which grants Pro to whoever guesses it.
//   2. **Exactly one row per refusal.** Two guards in a chain, or a helper that
//      also recorded, would silently double every number on the tab.
//   3. **Recording happens BEFORE the limiter.** Over the per-IP ceiling the
//      limiter answers 429 itself and never calls back — so recording afterwards
//      would drop precisely the brute-force burst the operator most needs to see.
//      This is the assertion most likely to regress under a "tidy up" refactor.
//
// And the credential is never stored, only which KIND was offered. A table you can
// go looking for secrets in is a liability, not an audit trail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpGuards, rejectEndpointKey, ADMIN_SESSION_HEADER } from '../../lib/http/http-guards.js';

const KEY = 'super-secret-endpoint-key';
const plainMatches = (a, b) => a === b;
const passThroughLimiter = (req, res, next) => next();

/** A recorder standing in for lib/data/admin-access.js. */
function spy() {
  const events = [];
  return { events, record(ev) { events.push(ev); return { ok: true }; } };
}

/** Minimal req/res doubles — the guards only touch these. */
function reqWith(headers = {}, url = '/promptlogs') {
  const lower = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
  return {
    ip: '203.0.113.9',
    originalUrl: url,
    path: url,
    socket: { remoteAddress: '203.0.113.9' },
    get: (h) => lower[String(h).toLowerCase()],
  };
}

function resDouble() {
  const res = {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(k, v) { res.headers[k] = v; },
    set(k, v) { res.headers[k] = v; return res; },
    status(c) { res.statusCode = c; return res; },
    json(b) { res.body = b; return res; },
  };
  return res;
}

function guards(access, deps = {}) {
  return createHttpGuards({
    genAI: null,
    LOGS_ACCESS_KEY: KEY,
    endpointKeyMatches: plainMatches,
    endpointKeyLimiter: passThroughLimiter,
    adminAccess: access,
    ...deps,
  });
}

// ── Coverage ────────────────────────────────────────────────────────────────

test('all three factory guards record a refusal', () => {
  for (const name of ['protectLogs', 'requireEndpointKey', 'stagingEndpointKeyGuard']) {
    const access = spy();
    const g = guards(access);
    g[name](reqWith({ 'X-Stagify-Endpoint-Key': 'wrong' }), resDouble(), () => {});
    assert.equal(access.events.length, 1, `${name} must record its refusal`);
    assert.equal(access.events[0].outcome, 'denied');
  }
});

test('the module-level rejectEndpointKey records too — it guards the same secret', () => {
  // POST /api/getpro compares the key inline and reaches this export directly.
  // It grants Pro to whoever gets the key right, so leaving it uninstrumented
  // would move the guessing one endpoint over, unseen.
  const access = spy();
  guards(access);
  rejectEndpointKey(reqWith({}, '/api/getpro'), resDouble(), () => {});
  assert.equal(access.events.length, 1);
  assert.equal(access.events[0].path, '/api/getpro');
});

// ── Exactly once ────────────────────────────────────────────────────────────

test('one refused request is exactly one row', () => {
  const access = spy();
  const { protectLogs } = guards(access);
  protectLogs(reqWith({ 'X-Stagify-Endpoint-Key': 'wrong' }), resDouble(), () => {});
  assert.equal(access.events.length, 1, 'double counting would silently double every number on the tab');
});

test('a request that PASSES records nothing', () => {
  // The console polls ~10 admin endpoints per refresh. If a success recorded here,
  // the log would be pure noise and the denied signal unreadable.
  const access = spy();
  const { protectLogs } = guards(access);
  let passed = false;
  protectLogs(reqWith({ 'X-Stagify-Endpoint-Key': KEY }), resDouble(), () => { passed = true; });
  assert.equal(passed, true);
  assert.equal(access.events.length, 0);
});

// ── Which credential was offered ────────────────────────────────────────────

test('the reason distinguishes a wrong key, a dead session and nothing at all', () => {
  const cases = [
    [{ 'X-Stagify-Endpoint-Key': 'wrong' }, 'bad-key'],
    [{ [ADMIN_SESSION_HEADER]: 'stale-token' }, 'bad-session'],
    [{}, 'no-credential'],
  ];
  for (const [headers, reason] of cases) {
    const access = spy();
    const { protectLogs } = guards(access);
    protectLogs(reqWith(headers), resDouble(), () => {});
    assert.equal(access.events[0].reason, reason, JSON.stringify(headers));
  }
});

test('the credential itself is never stored, not even a prefix', () => {
  const access = spy();
  const { protectLogs } = guards(access);
  protectLogs(reqWith({ 'X-Stagify-Endpoint-Key': 'hunter2-the-real-key' }), resDouble(), () => {});
  const dumped = JSON.stringify(access.events[0]);
  assert.ok(!dumped.includes('hunter2'), 'an audit trail must not become a place to go looking for secrets');
});

test('the address and device are captured', () => {
  const access = spy();
  const { protectLogs } = guards(access);
  protectLogs(reqWith({ 'user-agent': 'curl/8.4.0' }), resDouble(), () => {});
  assert.equal(access.events[0].ip, '203.0.113.9');
  assert.equal(access.events[0].userAgent, 'curl/8.4.0');
});

// ── Ordering against the limiter ────────────────────────────────────────────

test('a refusal is recorded even when the rate limiter swallows the request', () => {
  // Over the ceiling the limiter answers 429 and never calls back. Recording after
  // it would drop exactly the brute-force burst worth seeing — so the burst would
  // be invisible on the one tab built to show it.
  const access = spy();
  const limiterThatAnswers = (req, res) => { res.status(429).json({ error: 'Too many' }); };
  const { protectLogs } = createHttpGuards({
    genAI: null,
    LOGS_ACCESS_KEY: KEY,
    endpointKeyMatches: plainMatches,
    endpointKeyLimiter: limiterThatAnswers,
    adminAccess: access,
  });

  const res = resDouble();
  protectLogs(reqWith({ 'X-Stagify-Endpoint-Key': 'wrong' }), res, () => {});
  assert.equal(res.statusCode, 429, 'the limiter answered, not the guard');
  assert.equal(access.events.length, 1, 'and the attempt is STILL on the record');
});

// ── Degrading ───────────────────────────────────────────────────────────────

test('a recorder that throws does not change the refusal', () => {
  const thrower = { record() { throw new Error('disk full'); } };
  const { protectLogs } = guards(thrower);
  const res = resDouble();
  assert.doesNotThrow(() => protectLogs(reqWith({}), res, () => {}));
  assert.equal(res.statusCode, 403, 'a guard must never fail because a counter did');
});

test('with no recorder installed the guards behave exactly as before', () => {
  // Every existing caller omits `adminAccess`; none of them may change behaviour.
  const { protectLogs } = createHttpGuards({
    genAI: null,
    LOGS_ACCESS_KEY: KEY,
    endpointKeyMatches: plainMatches,
    endpointKeyLimiter: passThroughLimiter,
    adminAccess: null,
  });
  const res = resDouble();
  assert.doesNotThrow(() => protectLogs(reqWith({}), res, () => {}));
  assert.equal(res.statusCode, 403);
});
