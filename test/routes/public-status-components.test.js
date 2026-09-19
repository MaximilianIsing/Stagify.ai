// GET /api/status once the per-subsystem section was added beside the heartbeat.
//
// Two properties matter more than the payload's shape and are asserted first:
//   1. `status` / `currentState` still mean what they always meant. Everything else is
//      additive, so a cached older bundle keeps working against a newer server.
//   2. `detail` NEVER reaches this endpoint. It is the one field that can carry an R2
//      error body or a SQLite message, and this response is public and unauthenticated.
//
// Driven through a real express app on a real socket, matching public-pages-route.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import createPublicRouter from '../../routes/public.js';
import { createServiceHealth } from '../../lib/health/service-health.js';

const pass = (req, res, next) => next();

const SNAPSHOT = {
  generatedAt: 1_700_000_000_000,
  status: 'operational',
  currentState: 'up',
  bootCount: 2,
  windows: { '24h': { uptimePct: 100 } },
  buckets: {},
  incidents: [],
  totalIncidents: 0,
};

/** @param {{ serviceHealth?: any }} [opts] */
async function mount(opts = {}) {
  const app = express();
  app.use(createPublicRouter({
    authStore: { getUserCount: () => 1 },
    uptimeMonitor: { getSnapshot: () => ({ ...SNAPSHOT }) },
    serviceHealth: opts.serviceHealth,
    resend: null,
    LOGS_ACCESS_KEY: 'k',
    endpointKeyMatches: (a, b) => a === b,
    emailLimiter: pass,
    emailPixelLimiter: pass,
    RESEND_FROM_EMAIL: 'noreply@stagify.ai',
    DEBUG_MODE: false,
    EMAIL_DEBUG_MODE: false,
    DEBUG_EMAIL: '',
    STATS_DEBUG: false,
    DEBUG_ROOMS: 0,
    DEBUG_USERS: 0,
    hostedImages: { getHostedImagesDir: () => '', readHostedImagesManifest: () => [] },
    email: { logEmailOpenToFile: () => {}, isConfirmedEmailClientOpen: () => false },
    healthHandler: (req, res) => res.json({ ok: true }),
    getPromptCount: () => 1,
    getContactCount: () => 1,
    incContactCount: () => {},
    __dirname: process.cwd(),
  }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const { port } = /** @type {any} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => r(undefined))),
  };
}

/** A health runner whose storage probe fails, so there is a `detail` to leak. */
async function brokenHealth() {
  const health = createServiceHealth({
    getDb: () => ({ open: true, prepare: () => ({ get: () => ({}) }) }),
    objectStore: { backend: 'r2', head: async () => { throw new Error('HTTP 403 AccessDenied on bucket renders'); } },
    genAI: {}, openai: {}, stripe: {}, resend: {}, googleOAuthClient: {},
    getHealthCounters: () => ({
      renders7d: { total: 0, failed: 0 },
      stuckStripeEvents: 0, tombstoneBacklog: 0, tombstonesFailing: 0, lastTombstoneError: null,
    }),
  });
  await health.refresh();
  return health;
}

test('the heartbeat fields are unchanged and the component fields are additive', async (t) => {
  const health = await brokenHealth();
  const srv = await mount({ serviceHealth: health });
  t.after(() => srv.close());

  const res = await fetch(`${srv.url}/api/status`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();

  for (const key of Object.keys(SNAPSHOT)) {
    assert.deepEqual(body[key], SNAPSHOT[key], `${key} changed meaning`);
  }
  assert.ok(Array.isArray(body.components));
  assert.equal(body.components.length, 8);
  assert.equal(typeof body.componentsCheckedAt, 'number');
  assert.equal(body.componentsSummary.down, 1);
  // Storage is core, so a bucket that will not authenticate is a real outage.
  assert.equal(body.overall, 'down');
});

test('no component on the public payload carries an infrastructure detail', async (t) => {
  const health = await brokenHealth();
  const srv = await mount({ serviceHealth: health });
  t.after(() => srv.close());

  const body = await (await fetch(`${srv.url}/api/status`)).json();
  const storage = body.components.find((c) => c.id === 'storage');
  assert.equal(storage.reasonCode, 'STORAGE_UNREACHABLE');
  assert.ok(storage.reason.length > 0, 'the English fallback must still be there to translate against');
  for (const c of body.components) {
    assert.equal('detail' in c, false, `${c.id} leaked detail onto /api/status`);
  }
  assert.equal(JSON.stringify(body).includes('AccessDenied'), false);
});

test('without the serviceHealth dep the payload is exactly what it always was', async (t) => {
  const srv = await mount({});
  t.after(() => srv.close());
  const body = await (await fetch(`${srv.url}/api/status`)).json();
  assert.deepEqual(body, SNAPSHOT);
});
