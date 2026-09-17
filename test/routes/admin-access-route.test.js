// Tier: route (routes/admin-access.js) — the console's access log.
//
// The recording itself is covered by test/data/admin-access.test.js and the
// refusal hook by test/http/admin-access-denied.test.js. What is at stake HERE is
// the HTTP edge:
//
//   - **The guard.** This log holds IP addresses and devices; a request without the
//     credential must be refused before the store is touched. Leaking the access
//     log would hand an attacker the list of addresses that legitimately sign in.
//   - **The ping falls through.** This router records the console's page-load probe
//     by matching GET /api/admin/ping ahead of routes/admin.js and calling next().
//     If it ever stopped calling next(), the real handler would never answer and
//     every operator would be locked out at the login screen — a silent, total
//     outage of the console. It is pinned here.
//   - **A bad limit is not an error**, and **a missing store degrades rather than
//     503ing**: the tab should say recording is off, not show an error.
//   - **Geo resolution happens after the response**, never before it, so no operator
//     waits on a third-party network call to read their own access log.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAdminAccessRouter } from '../../routes/admin-access.js';

const KEY = 'test-endpoint-key';
const auth = { 'X-Stagify-Endpoint-Key': KEY };

/** Every server opened by a test, so none is left holding the runner open. */
const servers = [];
afterEach(() => { while (servers.length) servers.pop().close(); });

/** The shape lib/data/admin-access.js#summary returns, reduced to what matters here. */
const PAYLOAD = {
  generatedAt: 1750000000000,
  limit: 200,
  rows: [{ id: 1, ts: 1, lastTs: 2, hits: 3, ip: '203.0.113.9', outcome: 'denied', reason: 'bad-key', path: '/promptlogs', ua: '', browser: 'Chrome 126', os: 'Windows', isBot: false, geo: null }],
  summary: { totalEvents: 3, opens: 0, signins: 0, denied: 3, distinctIps: 1, deniedIps: 1, visitors: [] },
};

/** A stand-in store recording everything it was asked to do. */
function makeAccess(overrides = {}) {
  const calls = { summary: [], record: [], geo: 0 };
  return {
    calls,
    enabled: true,
    summary(opts) { calls.summary.push(opts); return PAYLOAD; },
    record(ev) { calls.record.push(ev); return { ok: true }; },
    async resolvePendingGeo() { calls.geo += 1; return 0; },
    ...overrides,
  };
}

async function mount({ adminAccess = makeAccess(), withPingHandler = true } = {}) {
  const app = express();
  app.set('trust proxy', 1);
  const protectLogs = (req, res, next) => (
    req.get('X-Stagify-Endpoint-Key') === KEY ? next() : res.status(403).json({ error: 'Forbidden' })
  );
  app.use(createAdminAccessRouter({ adminAccess, protectLogs }));
  // Stands in for the real handler in routes/admin.js that the ping falls through to.
  if (withPingHandler) app.get('/api/admin/ping', (req, res) => res.json({ ok: true, from: 'admin-router' }));
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  servers.push(srv);
  return { base: `http://127.0.0.1:${srv.address().port}`, access: adminAccess };
}

// ── The guard ───────────────────────────────────────────────────────────────

test('without the operator credential the log refuses, and never reaches the store', async () => {
  const { base, access } = await mount();
  const res = await fetch(`${base}/api/admin/access-log`);
  assert.equal(res.status, 403);
  assert.equal(access.calls.summary.length, 0, 'the guard runs before anything is read');
});

test('an unauthenticated ping is refused and records nothing', async () => {
  // Otherwise every scanner hitting /api/admin/ping would appear in the log as a
  // legitimate dashboard OPEN, which is the exact opposite of the point.
  const { base, access } = await mount();
  const res = await fetch(`${base}/api/admin/ping`);
  assert.equal(res.status, 403);
  assert.equal(access.calls.record.length, 0);
});

// ── The page-load ping ──────────────────────────────────────────────────────

test('the ping records one open AND still reaches the real handler', async () => {
  const { base, access } = await mount();
  const res = await fetch(`${base}/api/admin/ping`, { headers: auth });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.from, 'admin-router', 'next() must carry the request on — the console cannot sign in otherwise');
  assert.equal(access.calls.record.length, 1);
  assert.equal(access.calls.record[0].outcome, 'open');
  assert.equal(access.calls.record[0].path, '/admin', 'the PAGE that was opened, not the API path that reported it');
});

test('a store that throws still lets the ping through', async () => {
  // This handler sits in front of the console's own sign-in probe. A telemetry
  // failure turning that into a 500 would lock the operator out of the dashboard.
  const access = makeAccess({ record() { throw new Error('disk full'); } });
  const { base } = await mount({ adminAccess: access });
  const res = await fetch(`${base}/api/admin/ping`, { headers: auth });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).from, 'admin-router');
});

test('with no store at all the ping is untouched', async () => {
  const { base } = await mount({ adminAccess: null });
  const res = await fetch(`${base}/api/admin/ping`, { headers: auth });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).from, 'admin-router');
});

// ── The payload ─────────────────────────────────────────────────────────────

test('with the credential it answers the log and its rollup', async () => {
  const { base } = await mount();
  const res = await fetch(`${base}/api/admin/access-log`, { headers: auth });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.configured, true);
  assert.equal(body.rows.length, 1);
  assert.equal(body.summary.denied, 3);
});

test('a nonsense limit is clamped rather than refused', async () => {
  const { base, access } = await mount();
  for (const [asked, expected] of [['50', 50], ['500', 500], ['99999', 1000], ['1', 50], ['banana', 200]]) {
    const res = await fetch(`${base}/api/admin/access-log?limit=${asked}`, { headers: auth });
    assert.equal(res.status, 200, asked);
    assert.equal(access.calls.summary.at(-1).limit, expected, `limit=${asked}`);
  }
});

test('a missing store says recording is off instead of 503ing', async () => {
  const { base } = await mount({ adminAccess: null });
  const res = await fetch(`${base}/api/admin/access-log`, { headers: auth });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.configured, false);
  assert.deepEqual(body.rows, []);
  assert.equal(body.summary.denied, 0);
});

test('a store present but switched off reports configured false, with its rows', async () => {
  const { base } = await mount({ adminAccess: makeAccess({ enabled: false }) });
  const body = await (await fetch(`${base}/api/admin/access-log`, { headers: auth })).json();
  assert.equal(body.configured, false, 'the tab must say nothing new is being logged');
  assert.equal(body.rows.length, 1, 'but the history already recorded is still shown');
});

// ── Geo ─────────────────────────────────────────────────────────────────────

test('locations are resolved after the response, and a failure never reaches the client', async () => {
  // The ORDERING is the assertion here: a third-party network call must never sit
  // between the operator and their own access log. `res.headersSent` is the honest
  // witness for it — true only once res.json() has already flushed.
  let sentWhenResolved = null;
  let calledGeo = false;
  let capturedRes = null;
  const access = makeAccess({
    async resolvePendingGeo() {
      calledGeo = true;
      sentWhenResolved = capturedRes && capturedRes.headersSent;
      throw new Error('offline');
    },
  });

  const app = express();
  app.use(createAdminAccessRouter({
    adminAccess: access,
    protectLogs: (req, res, next) => { capturedRes = res; return next(); },
  }));
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  servers.push(srv);

  const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/admin/access-log`);
  const body = await res.json();

  assert.equal(res.status, 200, 'a dead geo provider must not break the operator\'s own access log');
  assert.equal(body.rows.length, 1);
  assert.equal(calledGeo, true, 'the lookup is actually kicked off');
  assert.equal(sentWhenResolved, true, 'and only AFTER res.json() — never awaited before it');
});

test('a store that throws on read is a 500 with a reference, not a stack', async () => {
  const access = makeAccess({ summary() { throw new Error('db gone'); } });
  const { base } = await mount({ adminAccess: access });
  const res = await fetch(`${base}/api/admin/access-log`, { headers: auth });
  const body = await res.json();

  assert.equal(res.status, 500);
  assert.match(body.error, /access log/i);
  assert.ok(!JSON.stringify(body).includes('db gone'), 'the internal message must not reach the client');
});
