// Tier 2 — the async-safe router (lib/http/async-router.js).
//
// Express 5 forwards a rejected promise from an `async` handler to error middleware
// natively, where server.js's catch-all turns it into a clean 500. Express 4 did not (the
// request hung), which is why createAsyncRouter() once wrapped every handler. These tests
// pin the native behavior so a downgrade or regression fails CI: a rejecting handler
// reaches the catch-all, and preceding middleware (guards, rate limiters) runs in order.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAsyncRouter } from '../../lib/http/async-router.js';

// Boot a throwaway express app on a random port; resolve with base URL + closer.
function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

test('a rejecting async route reaches the catch-all (500) instead of hanging', async (t) => {
  const app = express();
  const router = createAsyncRouter();
  router.get('/boom', async () => { throw new Error('kaboom'); });
  app.use(router);
  // Catch-all mirrors server.js: turn any escaped error into a clean JSON 500.
  app.use((err, req, res, _next) => {
    res.status(500).json({ error: 'Internal server error' });
  });
  const srv = await listen(app);
  t.after(() => srv.close());

  const r = await fetch(srv.baseUrl + '/boom');
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { error: 'Internal server error' });
});

test('preceding middleware still runs, in order, before the handler', async (t) => {
  const app = express();
  const router = createAsyncRouter();
  const calls = [];
  const guard = (req, res, next) => { calls.push('guard'); next(); };
  router.get('/ok', guard, async (_req, res) => { calls.push('handler'); res.json({ ok: true }); });
  app.use(router);
  const srv = await listen(app);
  t.after(() => srv.close());

  const r = await fetch(srv.baseUrl + '/ok');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.deepEqual(calls, ['guard', 'handler']);
});

test('a guard that short-circuits stops the handler from running', async (t) => {
  const app = express();
  const router = createAsyncRouter();
  let handlerRan = false;
  const denyGuard = (req, res) => res.status(403).json({ error: 'denied' });
  router.get('/guarded', denyGuard, async (_req, res) => { handlerRan = true; res.json({ ok: true }); });
  app.use(router);
  const srv = await listen(app);
  t.after(() => srv.close());

  const r = await fetch(srv.baseUrl + '/guarded');
  assert.equal(r.status, 403);
  assert.equal(handlerRan, false);
});
