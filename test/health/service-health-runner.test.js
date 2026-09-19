// The runner half of lib/health/service-health.js: caching, single-flight, per-probe
// TTLs, timeouts, and the rule that `detail` never leaves the building on a public
// payload. The decision table itself is pinned in service-health.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createServiceHealth, CACHE_MS } from '../../lib/health/service-health.js';

/** A stand-in for the shared SQLite handle that counts how often it is queried. */
function fakeDb() {
  const state = { queries: 0 };
  return {
    state,
    handle: { open: true, prepare: () => ({ get: () => { state.queries += 1; return { 1: 1 }; } }) },
  };
}

const okStore = (calls) => ({
  backend: 'r2',
  head: async () => { calls.n += 1; return null; }, // 404 — the expected pass
});

const countersOk = () => ({
  renders7d: { total: 100, failed: 1 },
  stuckStripeEvents: 0,
  tombstoneBacklog: 0,
  tombstonesFailing: 0,
  lastTombstoneError: null,
});

/** A full, healthy dep bag. */
function healthyDeps(overrides = {}) {
  const db = fakeDb();
  const calls = { n: 0 };
  return {
    db,
    calls,
    deps: {
      getDb: () => db.handle,
      objectStore: okStore(calls),
      genAI: {}, openai: {}, stripe: {}, resend: {}, googleOAuthClient: {},
      getHealthCounters: countersOk,
      ...overrides,
    },
  };
}

test('before the first refresh lands, every probed component is CHECK_PENDING', () => {
  const { deps } = healthyDeps();
  const health = createServiceHealth(deps);
  const { components } = health.getSection();
  // `app` is decided inline and is always real; everything else is pending.
  const app = components.find((c) => c.id === 'app');
  assert.equal(app.state, 'operational');
  for (const c of components.filter((c) => c.id !== 'app')) {
    assert.equal(c.state, 'unknown');
    assert.equal(c.reasonCode, 'CHECK_PENDING');
  }
});

test('a healthy server reports every component operational', async () => {
  const { deps } = healthyDeps();
  const health = createServiceHealth(deps);
  await health.refresh();
  const { components } = health.getSection();
  const bad = components.filter((c) => c.state !== 'operational');
  assert.deepEqual(bad.map((c) => `${c.id}:${c.reasonCode}`), []);
  assert.equal(components.length, 8);
});

test('getSection is synchronous and probe-free: a burst of pollers costs nothing', async () => {
  const { db, calls, deps } = healthyDeps();
  const health = createServiceHealth(deps);
  await health.refresh();
  const dbQueriesAfterFirst = db.state.queries;
  const headsAfterFirst = calls.n;

  for (let i = 0; i < 50; i += 1) health.getSection();

  assert.equal(db.state.queries, dbQueriesAfterFirst);
  assert.equal(calls.n, headsAfterFirst);
});

test('concurrent refreshes are single-flighted into one probe run', async () => {
  const { db, calls, deps } = healthyDeps();
  const health = createServiceHealth(deps);
  await Promise.all([health.refresh(), health.refresh(), health.refresh(), health.refresh()]);
  assert.equal(calls.n, 1);
  assert.equal(db.state.queries, 1);
});

test('per-probe TTLs keep a refresh from re-running the expensive checks', async () => {
  let clock = 1_000_000;
  const { calls, deps } = healthyDeps();
  const health = createServiceHealth({ ...deps, now: () => clock });
  await health.refresh();
  assert.equal(calls.n, 1);

  // A second refresh 30 s later: inside the 60 s storage TTL, so no second HEAD.
  clock += 30_000;
  await health.refresh();
  assert.equal(calls.n, 1);

  // Past it, and the bucket is probed again.
  clock += 40_000;
  await health.refresh();
  assert.equal(calls.n, 2);
});

test('a stale section is served immediately while a refresh runs behind it', async () => {
  let clock = 1_000_000;
  const { deps } = healthyDeps();
  const health = createServiceHealth({ ...deps, now: () => clock });
  await health.refresh();
  assert.equal(health.getSection().stale, false);

  clock += CACHE_MS + 1;
  const section = health.getSection();
  assert.equal(section.stale, true);
  // Still the real verdicts, not a pending placeholder — that is the point of
  // stale-while-revalidate on a page that is polled every 60 seconds.
  assert.equal(section.components.find((c) => c.id === 'database').state, 'operational');
});

test('a probe that throws yields unknown and never rejects', async () => {
  const { deps } = healthyDeps({
    objectStore: { backend: 'r2', head: async () => { throw new Error('HTTP 403 AccessDenied'); } },
  });
  const health = createServiceHealth(deps);
  await assert.doesNotReject(health.refresh());
  const storage = health.getSection({ includeDetail: true }).components.find((c) => c.id === 'storage');
  assert.equal(storage.state, 'down');
  assert.equal(storage.reasonCode, 'STORAGE_UNREACHABLE');
  assert.match(storage.detail, /AccessDenied/);
});

test('a probe that hangs times out into a degraded verdict, not a stuck request', async () => {
  const { deps } = healthyDeps({
    // Settles long after the budget rather than never: a promise that never settles
    // would leave the runner with pending work and no live handle to wait on.
    objectStore: { backend: 'r2', head: () => new Promise((resolve) => setTimeout(() => resolve(null), 300)) },
    timeouts: { storage: 60, refresh: 200 },
  });
  const health = createServiceHealth(deps);
  const started = Date.now();
  await health.refresh();
  // Back well before head() settles at 300 ms: the budget bounds the wait, not the work.
  assert.ok(Date.now() - started < 250);
  const storage = health.getSection().components.find((c) => c.id === 'storage');
  assert.ok(['degraded', 'unknown'].includes(storage.state), `unexpected ${storage.state}`);
});

test('a missing database dep is unknown, and a thrown query is down', async () => {
  const none = createServiceHealth({ genAI: {}, openai: {} });
  await none.refresh();
  const db = none.getSection().components.find((c) => c.id === 'database');
  assert.equal(db.state, 'unknown');
  assert.equal(db.reasonCode, 'CHECK_UNAVAILABLE');

  const broken = createServiceHealth({
    getDb: () => ({ open: true, prepare: () => { throw new Error('database is locked'); } }),
  });
  await broken.refresh();
  const brokenDb = broken.getSection({ includeDetail: true }).components.find((c) => c.id === 'database');
  assert.equal(brokenDb.state, 'down');
  assert.equal(brokenDb.detail, 'database is locked');
});

test('detail is admin-only and never appears on a public section', async () => {
  const { deps } = healthyDeps({
    objectStore: { backend: 'r2', head: async () => { throw new Error('/data/objects: permission denied'); } },
  });
  const health = createServiceHealth(deps);
  await health.refresh();

  const pub = health.getSection();
  for (const c of pub.components) {
    assert.equal('detail' in c, false, `${c.id} leaked detail onto the public payload`);
  }
  const admin = health.getSection({ includeDetail: true });
  assert.ok(admin.components.some((c) => typeof c.detail === 'string'));
});

test('the app component reflects the live uptime snapshot, not the cache', async () => {
  const { deps } = healthyDeps();
  const health = createServiceHealth(deps);
  await health.refresh();

  const up = health.getSection({ uptime: { currentState: 'up', status: 'operational' } });
  assert.equal(up.components.find((c) => c.id === 'app').state, 'operational');
  // No second refresh is needed for this to change — an open incident must be current.
  const down = health.getSection({ uptime: { currentState: 'down', status: 'degraded' } });
  assert.equal(down.components.find((c) => c.id === 'app').reasonCode, 'APP_INCIDENT_OPEN');
});

test('start() primes the cache and stop() leaves no timer running', async () => {
  const { deps } = healthyDeps();
  const health = createServiceHealth({ ...deps, intervalMs: 50 });
  health.start();
  await health.refresh();
  assert.equal(health.getSection().components.find((c) => c.id === 'storage').state, 'operational');
  health.stop();
  health.stop(); // idempotent
});
