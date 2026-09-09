// Tier: route (routes/admin-api-usage.js) — the console's API usage endpoint.
//
// The aggregation itself is covered by test/analytics/api-usage.test.js. What is at
// stake HERE is the HTTP edge:
//
//   - **The guard.** This body carries customer emails and what each of them spends.
//     Every request without the operator credential must be refused, and the guard
//     must run before anything else.
//   - **A bad window is not an error.** `days` is an operator typing in a URL bar;
//     the useful answer is the default window, not a 400 they have to interpret.
//   - **A missing aggregator degrades, it does not 503.** A deployment whose database
//     predates the API tables should show a panel that says so.
//   - **The body stays a shaped aggregate.** No key ids, no key prefixes, no
//     idempotency keys, no fingerprints — none of it is needed to answer "how busy is
//     the API", and a key prefix is half of a credential.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAdminApiUsageRouter } from '../../routes/admin-api-usage.js';

const KEY = 'test-endpoint-key';
const auth = { 'X-Stagify-Endpoint-Key': KEY };

/** Every server opened by a test, so none is left holding the runner open. */
const servers = [];
afterEach(() => { while (servers.length) servers.pop().close(); });

/** A stand-in aggregator that records the options it was handed. */
function makeStats(payload) {
  const calls = [];
  return {
    calls,
    summary(opts) {
      calls.push(opts);
      if (typeof payload === 'function') return payload(opts);
      return payload;
    },
  };
}

const SAMPLE = {
  generatedAt: 1750000000000,
  since: 1747408000000,
  days: 30,
  buckets: [{ day: 1747408000000, delivered: 2, refunded: 0 }],
  traffic: { delivered: 2, refunded: 0, inFlight: 0, creditsBurned: 2, medianMs: 4000, durationSample: 2 },
  accounts: [{ userId: 'u1', email: 'a@example.com', plan: 'pro', delivered: 2 }],
  accountsTotal: 1,
  accountsShown: 1,
  economics: { outstanding: 40, lifetimePurchased: 100, lifetimeSpent: 60, fundedAccounts: 1, suspended: 0, purchasedInWindow: 100, grantedInWindow: 0 },
  keys: { total: 2, active: 1, accounts: 1 },
};

async function mount({ apiUsageStats = makeStats(SAMPLE) } = {}) {
  const app = express();
  const protectLogs = (req, res, next) => (
    req.get('X-Stagify-Endpoint-Key') === KEY ? next() : res.status(403).json({ error: 'Forbidden' })
  );
  app.use(createAdminApiUsageRouter({
    apiUsageStats,
    protectLogs,
    setSensitiveHeaders: (res) => res.set('Referrer-Policy', 'no-referrer'),
  }));
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  servers.push(srv);
  return { base: `http://127.0.0.1:${srv.address().port}`, stats: apiUsageStats };
}

// ── The guard ───────────────────────────────────────────────────────────────

test('without the operator credential the endpoint refuses, and never reaches the store', async () => {
  const stats = makeStats(SAMPLE);
  const { base } = await mount({ apiUsageStats: stats });

  const res = await fetch(`${base}/api/admin/api-usage`);
  assert.equal(res.status, 403);
  // The guard runs FIRST. If the aggregate had already been computed, a leak would
  // be one accidental `res.json` away.
  assert.equal(stats.calls.length, 0);
});

test('a wrong credential is refused too', async () => {
  const { base } = await mount();
  const res = await fetch(`${base}/api/admin/api-usage`, {
    headers: { 'X-Stagify-Endpoint-Key': 'not-the-key' },
  });
  assert.equal(res.status, 403);
});

test('with the credential it answers the aggregate under a named key', async () => {
  const { base } = await mount();
  const res = await fetch(`${base}/api/admin/api-usage`, { headers: auth });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.usage, SAMPLE);
});

// ── Caching and headers ─────────────────────────────────────────────────────

test('the body is no-store — it carries customer emails and spend', async () => {
  const { base } = await mount();
  const res = await fetch(`${base}/api/admin/api-usage`, { headers: auth });

  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
});

// ── The window ──────────────────────────────────────────────────────────────

test('days is passed through when it is sane', async () => {
  const { base, stats } = await mount();
  await fetch(`${base}/api/admin/api-usage?days=7`, { headers: auth });
  assert.deepEqual(stats.calls, [{ days: 7 }]);
});

test('an out-of-range or unparseable window is clamped, never rejected', async () => {
  const { base, stats } = await mount();

  const cases = [
    ['days=5000', 90],
    ['days=0', 1],
    ['days=-12', 1],
    ['days=banana', 30],
    ['', 30],
    // A float rounds rather than producing fractional-day buckets.
    ['days=7.4', 7],
  ];

  for (const [query] of cases) {
    const res = await fetch(`${base}/api/admin/api-usage?${query}`, { headers: auth });
    assert.equal(res.status, 200, `${query} should not be an error`);
  }

  assert.deepEqual(stats.calls.map((c) => c.days), cases.map(([, days]) => days));
});

// ── Degrading ───────────────────────────────────────────────────────────────

test('a missing aggregator answers 200 with a null payload, not a 503', async () => {
  const { base } = await mount({ apiUsageStats: null });
  const res = await fetch(`${base}/api/admin/api-usage`, { headers: auth });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.usage, null);
  assert.equal(body.reason, 'unavailable');
});

test('a dependency that is not shaped like the aggregator degrades the same way', async () => {
  const { base } = await mount({ apiUsageStats: /** @type {any} */ ({ notSummary: true }) });
  const res = await fetch(`${base}/api/admin/api-usage`, { headers: auth });

  assert.equal(res.status, 200);
  assert.equal((await res.json()).usage, null);
});

test('a throwing aggregate is a 500 with a reference, not a stack', async () => {
  const stats = makeStats(() => { throw new Error('no such column: nonsense'); });
  const { base } = await mount({ apiUsageStats: stats });
  const res = await fetch(`${base}/api/admin/api-usage`, { headers: auth });

  assert.equal(res.status, 500);
  const body = await res.json();
  // The operator gets a stable message and a reference to correlate with the log.
  assert.match(String(body.error), /Failed to read API usage/);
  assert.ok(!JSON.stringify(body).includes('no such column'), 'the driver message must not reach the client');
});
