// Behavioral test for lib/http/rate-limiters.js — the four express-rate-limit
// middlewares (authLimiter / emailLimiter / genLimiter / checkoutLimiter) that back
// the auth, public, staging, chat, and billing routers.
//
// WHY THIS IS SUBTLE: all four limiters live in ONE module and each reads its
// ceiling from an env var (RL_AUTH / RL_EMAIL / RL_GEN / RL_CHECKOUT, defaulting to
// 40 / 6 / 60 / 10)
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
const RL_CHECKOUT_SNAPSHOT = process.env.RL_CHECKOUT;
// Two more, for the rejection-logging tests at the bottom. They get their OWN
// limiters so they never depend on how much of another test's bucket is left.
const RL_VALIDATE_IMAGE_SNAPSHOT = process.env.RL_VALIDATE_IMAGE;
const RL_ENDPOINT_KEY_SNAPSHOT = process.env.RL_ENDPOINT_KEY;
process.env.RL_AUTH = '2';
process.env.RL_EMAIL = '2';
process.env.RL_GEN = '2';
process.env.RL_CHECKOUT = '2';
process.env.RL_VALIDATE_IMAGE = '2';
process.env.RL_ENDPOINT_KEY = '1';

// A single dynamic import, taken AFTER the env overrides above are in place. ESM
// caches the module, so this one construction of the three limiters is shared by
// every test below (a later `import()` of the same path would just return this
// cached instance).
const {
  authLimiter, emailLimiter, genLimiter, checkoutLimiter,
  validateImageLimiter, endpointKeyLimiter, setRateLimitRejectionLogger,
} = await import('../../lib/http/rate-limiters.js');

after(() => {
  for (const [key, snapshot] of [
    ['RL_AUTH', RL_AUTH_SNAPSHOT],
    ['RL_EMAIL', RL_EMAIL_SNAPSHOT],
    ['RL_GEN', RL_GEN_SNAPSHOT],
    ['RL_CHECKOUT', RL_CHECKOUT_SNAPSHOT],
    ['RL_VALIDATE_IMAGE', RL_VALIDATE_IMAGE_SNAPSHOT],
    ['RL_ENDPOINT_KEY', RL_ENDPOINT_KEY_SNAPSHOT],
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

test('checkoutLimiter 429s past its RL_CHECKOUT ceiling with its exact "Too many checkout attempts" message', async () => {
  // Guards the unauthenticated enterprise checkout, where every request past the
  // limiter mints a real Stripe Checkout Session (routes/billing.js).
  const app = express();
  app.use('/c', checkoutLimiter, (req, res) => res.json({ ok: true }));

  const server = await listen(app);
  try {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/c`;

    // With RL_CHECKOUT=2 the first two sequential requests are under the ceiling.
    const r1 = await fetch(url);
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { ok: true });

    const r2 = await fetch(url);
    assert.equal(r2.status, 200);
    assert.deepEqual(await r2.json(), { ok: true });

    const r3 = await fetch(url);
    assert.equal(r3.status, 429, 'the request past the RL_CHECKOUT ceiling is rejected');
    assert.deepEqual(await r3.json(), {
      error: 'Too many checkout attempts. Please wait a while and try again.',
    });
  } finally {
    await close(server);
  }
});

test('the module exports authLimiter, emailLimiter, genLimiter, and checkoutLimiter as callable middleware functions', async () => {
  assert.equal(typeof authLimiter, 'function', 'authLimiter is middleware');
  assert.equal(typeof emailLimiter, 'function', 'emailLimiter is middleware');
  assert.equal(typeof genLimiter, 'function', 'genLimiter is middleware');
  assert.equal(typeof checkoutLimiter, 'function', 'checkoutLimiter is middleware');
});

// ── Recording who got turned away ────────────────────────────────────────────
// A 429 is a user hitting a wall, and none of them were written down anywhere: the
// request is refused by middleware, so it never reaches a handler that logs. That
// made "people are bouncing off the rate limiter" unfalsifiable. The limiters are
// module singletons built at import time, so the writer arrives through a setter.

test('a 429 records a rate_limit rejection carrying the limiter name and the path', async () => {
  const seen = [];
  setRateLimitRejectionLogger((kind, code, detail, who) => seen.push({ kind, code, detail, hasReq: !!who?.req }));

  const app = express();
  app.use('/v', validateImageLimiter, (req, res) => res.json({ ok: true }));
  const server = await listen(app);
  try {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/v`;
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(url)).status, 200);
    assert.deepEqual(seen, [], 'requests UNDER the ceiling are not rejections');

    const over = await fetch(url);
    assert.equal(over.status, 429);
    // The response body must be untouched — adding the log changes what we KNOW,
    // never what the caller receives.
    assert.deepEqual(await over.json(), {
      error: 'Too many image checks. Please wait a moment and try again.',
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].kind, 'rate_limit');
    assert.equal(seen[0].code, 'validate_image', 'the limiter that fired is identifiable');
    assert.equal(seen[0].detail, '/v');
    assert.equal(seen[0].hasReq, true, 'the request rides along for ip/user-agent');
  } finally {
    setRateLimitRejectionLogger(null);
    await close(server);
  }
});

test('a throwing rejection logger still returns a clean 429', async () => {
  // Bookkeeping must never become a second failure for a user already turned away.
  setRateLimitRejectionLogger(() => { throw new Error('disk full'); });

  const app = express();
  app.use('/k', endpointKeyLimiter, (req, res) => res.json({ ok: true }));
  const server = await listen(app);
  try {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/k`;
    assert.equal((await fetch(url)).status, 200, 'RL_ENDPOINT_KEY=1 → the first request passes');

    const over = await fetch(url);
    assert.equal(over.status, 429);
    assert.deepEqual(await over.json(), {
      error: 'Too many attempts. Please wait a few minutes and try again.',
    });
  } finally {
    setRateLimitRejectionLogger(null);
    await close(server);
  }
});

test('with no logger installed the limiters still behave exactly as before', async () => {
  // The default is a no-op, so nothing depends on server.js having wired the writer.
  setRateLimitRejectionLogger(null);
  const app = express();
  app.use('/n', validateImageLimiter, (req, res) => res.json({ ok: true }));
  const server = await listen(app);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/n`);
    assert.equal(res.status, 429, 'the validate-image bucket is spent by the test above');
  } finally {
    await close(server);
  }
});
