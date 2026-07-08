// Behavioral test for lib/http/rate-limiters.js — the three express-rate-limit
// middlewares (authLimiter / emailLimiter / genLimiter) that back the auth,
// public, staging, and chat routers.
//
// WHY THIS IS SUBTLE: all three limiters live in ONE module and each reads its
// ceiling from an env var (RL_AUTH / RL_EMAIL / RL_GEN, defaulting to 40 / 6 / 60)
// exactly ONCE, at module-load time (`limit: Number(process.env.RL_GEN || 60)`).
// By the time any test callback runs the values are already frozen into the
// constructed limiters, so the only way to exercise a small, deterministic ceiling
// is to set every env var BEFORE the module is first imported and then pull it in
// via a single DYNAMIC import that every test reuses. We set RL_AUTH / RL_EMAIL /
// RL_GEN to '2' at the top of this file (before any static import of the module
// could run) and snapshot/restore them in an after() hook so no sibling test file
// inherits the override.
//
// WHY NO REAL API / NO COST: this module is pure middleware configuration. It
// touches no model, email, payment, or database client — it just wires
// express-rate-limit with window/limit/message options. Each test mounts a bare
// throwaway Express app on 127.0.0.1:0, so there is no external network, no
// third-party call, and nothing billable. express-rate-limit keys by req.ip, and
// every loopback request from this process shares the same key, so a short burst
// of sequential fetches to the same URL accumulates against one bucket and trips
// the limit exactly at the configured ceiling. The three limiters each own an
// independent store, so exercising one does not spend another's budget.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

// Snapshot and override all three ceilings *before* the module under test is ever
// imported, so authLimiter / emailLimiter / genLimiter are each constructed with
// limit=2 rather than their defaults of 40 / 6 / 60.
const RL_AUTH_SNAPSHOT = process.env.RL_AUTH;
const RL_EMAIL_SNAPSHOT = process.env.RL_EMAIL;
const RL_GEN_SNAPSHOT = process.env.RL_GEN;
process.env.RL_AUTH = '2';
process.env.RL_EMAIL = '2';
process.env.RL_GEN = '2';

// A single dynamic import, taken AFTER the env overrides above are in place. ESM
// caches the module, so this one construction of the three limiters is shared by
// every test below (a later `import()` of the same path would just return this
// cached instance).
const { authLimiter, emailLimiter, genLimiter } = await import('../lib/http/rate-limiters.js');

after(() => {
  for (const [key, snapshot] of [
    ['RL_AUTH', RL_AUTH_SNAPSHOT],
    ['RL_EMAIL', RL_EMAIL_SNAPSHOT],
    ['RL_GEN', RL_GEN_SNAPSHOT],
  ]) {
    if (snapshot === undefined) delete process.env[key];
    else process.env[key] = snapshot;
  }
});

// Promisified listen on an ephemeral loopback port.
function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('genLimiter lets the first RL_GEN requests through and 429s the next with its exact configured message', async () => {
  const app = express();
  app.use('/g', genLimiter, (req, res) => res.json({ ok: true }));

  const server = await listen(app);
  try {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/g`;

    // Three sequential requests from the same loopback client. With RL_GEN=2 the
    // first two are under the ceiling and the third is over it.
    const r1 = await fetch(url);
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { ok: true });

    const r2 = await fetch(url);
    assert.equal(r2.status, 200);
    assert.deepEqual(await r2.json(), { ok: true });

    const r3 = await fetch(url);
    assert.equal(r3.status, 429, 'the request past the RL_GEN ceiling is rejected');
    assert.deepEqual(await r3.json(), {
      error: 'You are generating too quickly. Please wait a moment and try again.',
    });
  } finally {
    await close(server);
  }
});

test('authLimiter 429s past its RL_AUTH ceiling with its exact "Too many attempts" message', async () => {
  const app = express();
  app.use('/a', authLimiter, (req, res) => res.json({ ok: true }));

  const server = await listen(app);
  try {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/a`;

    // With RL_AUTH=2 the first two sequential requests are under the ceiling.
    const r1 = await fetch(url);
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { ok: true });

    const r2 = await fetch(url);
    assert.equal(r2.status, 200);
    assert.deepEqual(await r2.json(), { ok: true });

    // The third trips the limiter and returns authLimiter's exact message body.
    const r3 = await fetch(url);
    assert.equal(r3.status, 429, 'the request past the RL_AUTH ceiling is rejected');
    assert.deepEqual(await r3.json(), {
      error: 'Too many attempts. Please wait a few minutes and try again.',
    });
  } finally {
    await close(server);
  }
});

test('emailLimiter 429s past its RL_EMAIL ceiling with its exact "Too many requests" message', async () => {
  const app = express();
  app.use('/e', emailLimiter, (req, res) => res.json({ ok: true }));

  const server = await listen(app);
  try {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/e`;

    // With RL_EMAIL=2 the first two sequential requests are under the ceiling.
    const r1 = await fetch(url);
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { ok: true });

    const r2 = await fetch(url);
    assert.equal(r2.status, 200);
    assert.deepEqual(await r2.json(), { ok: true });

    // The third trips the limiter and returns emailLimiter's exact message body.
    const r3 = await fetch(url);
    assert.equal(r3.status, 429, 'the request past the RL_EMAIL ceiling is rejected');
    assert.deepEqual(await r3.json(), {
      error: 'Too many requests. Please wait a few minutes and try again.',
    });
  } finally {
    await close(server);
  }
});

test('the module exports authLimiter, emailLimiter, and genLimiter as callable middleware functions', async () => {
  assert.equal(typeof authLimiter, 'function', 'authLimiter is middleware');
  assert.equal(typeof emailLimiter, 'function', 'emailLimiter is middleware');
  assert.equal(typeof genLimiter, 'function', 'genLimiter is middleware');
});
