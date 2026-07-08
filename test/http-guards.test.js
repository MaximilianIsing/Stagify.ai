// -----------------------------------------------------------------------------
// test/http-guards.test.js
//
// Unit tests for `createHttpGuards` in lib/http/http-guards.js.
//
// The factory returns three Express-shaped functions:
//
//   createHttpGuards({ genAI, LOGS_ACCESS_KEY, endpointKeyMatches })
//     -> { healthHandler, protectLogs, stagingEndpointKeyGuard }
//
// Everything here is exercised by calling those functions DIRECTLY with
// hand-rolled fakes — there is no Express app, no real network, no Gemini
// client, and no store. Each dependency the guards touch is a fake:
//
//   * `genAI`            — health only reports `!!genAI`, so a truthy sentinel
//                          object vs. `null` is all we ever pass.
//   * `LOGS_ACCESS_KEY`  — a plain string secret (or falsy to hit the 500 path).
//   * `endpointKeyMatches` — the constant-time comparator that BOTH guards use.
//                          We inject `(a, b) => a === b` so we can reason about
//                          matches deterministically.
//
// The fake `res` captures `status()`, `json()`, and `set()`/`setHeader()` so we
// can assert both the status code / JSON body AND the sensitive headers that both
// guards apply via `setSensitiveHeaders` (from http-helpers.js:
// `Cache-Control: no-store` + `Referrer-Policy: no-referrer`). The fake `req`
// exposes an Express-style `req.get(name)` (used by both guards) plus raw
// `req.headers` / `req.query` so a test can plant a `?key=` and prove it is
// ignored.
//
// KEY BEHAVIOR that these tests pin down — the two guards are ALIGNED: both are
// HEADER-ONLY and use the constant-time `endpointKeyMatches`. A key supplied in
// `?key=` is refused by both (it would leak via access/proxy logs & Referer).
//
// House style: node's built-in test runner, strict assert. No source is
// modified; all needed exports already exist.
//
// Run:  node --test test/http-guards.test.js
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHttpGuards } from '../lib/http/http-guards.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * Build a fake Express `res` that records every mutation.
 *   res.statusCode  — last value passed to status()
 *   res.jsonBody    — last value passed to json()
 *   res.headers     — { [name]: value } populated by set()/setHeader()
 * status() returns `res` so the real `res.status(x).json(y)` chain works.
 */
function makeRes() {
  const res = {
    statusCode: undefined,
    jsonBody: undefined,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.jsonBody = body;
      return this;
    },
    set(field, value) {
      this.headers[field] = value;
      return this;
    },
  };
  // Express aliases setHeader -> set; expose both so whichever the source uses
  // is captured identically.
  res.setHeader = (field, value) => res.set(field, value);
  return res;
}

/**
 * Build a fake Express `req`.
 *   headers — raw lower-cased header bag (backs get()).
 *   query   — parsed query object (planted only to prove `?key=` is IGNORED).
 *   get(name) — Express-style case-insensitive header accessor used by BOTH
 *               guards. Returns undefined when absent.
 */
function makeReq({ headers = {}, query = {} } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    headers: lower,
    query,
    get(name) {
      return lower[String(name).toLowerCase()];
    },
  };
}

/** A `next` that records whether it was called (and how many times). */
function makeNext() {
  const next = () => {
    next.called = true;
    next.calls += 1;
  };
  next.called = false;
  next.calls = 0;
  return next;
}

const KEY = 'super-secret-endpoint-key';
const plainMatches = (a, b) => a === b;

// ===========================================================================
// healthHandler
// ===========================================================================

test('healthHandler reports status "healthy" and aiConfigured true when genAI is a truthy client', () => {
  const { healthHandler } = createHttpGuards({
    genAI: { some: 'client' },
    LOGS_ACCESS_KEY: KEY,
    endpointKeyMatches: plainMatches,
  });
  const res = makeRes();
  healthHandler(makeReq(), res);

  assert.equal(res.jsonBody.status, 'healthy');
  assert.equal(res.jsonBody.aiConfigured, true);
  // timestamp is an ISO string generated at call time.
  assert.equal(typeof res.jsonBody.timestamp, 'string');
  assert.equal(res.jsonBody.timestamp, new Date(res.jsonBody.timestamp).toISOString());
  // Health is a plain res.json(...) with no status() call.
  assert.equal(res.statusCode, undefined);
});

test('healthHandler reports aiConfigured false when genAI is null', () => {
  const { healthHandler } = createHttpGuards({
    genAI: null,
    LOGS_ACCESS_KEY: KEY,
    endpointKeyMatches: plainMatches,
  });
  const res = makeRes();
  healthHandler(makeReq(), res);

  assert.equal(res.jsonBody.status, 'healthy');
  assert.equal(res.jsonBody.aiConfigured, false);
});

// ===========================================================================
// protectLogs — header-only, constant-time, sets sensitive headers
// ===========================================================================

test('protectLogs returns 500 "Server configuration error" and does NOT call next when LOGS_ACCESS_KEY is undefined', () => {
  const { protectLogs } = createHttpGuards({
    genAI: null,
    LOGS_ACCESS_KEY: undefined,
    endpointKeyMatches: plainMatches,
  });
  const res = makeRes();
  const next = makeNext();
  protectLogs(makeReq({ headers: { 'X-Stagify-Endpoint-Key': 'anything' } }), res, next);

  assert.equal(res.statusCode, 500);
  assert.equal(res.jsonBody.error, 'Server configuration error');
  assert.equal(res.jsonBody.message, 'Logs access key not configured');
  assert.equal(next.called, false);
});

test('protectLogs returns 500 when LOGS_ACCESS_KEY is the empty string (falsy key)', () => {
  const { protectLogs } = createHttpGuards({
    genAI: null,
    LOGS_ACCESS_KEY: '',
    endpointKeyMatches: plainMatches,
  });
  const res = makeRes();
  const next = makeNext();
  protectLogs(makeReq({ headers: { 'X-Stagify-Endpoint-Key': '' } }), res, next);

  assert.equal(res.statusCode, 500);
  assert.equal(res.jsonBody.error, 'Server configuration error');
  assert.equal(next.called, false);
});

test('protectLogs still applies sensitive headers (no-store / no-referrer) even on the 500 config-error path', () => {
  const { protectLogs } = createHttpGuards({
    genAI: null,
    LOGS_ACCESS_KEY: '',
    endpointKeyMatches: plainMatches,
  });
  const res = makeRes();
  protectLogs(makeReq(), res, makeNext());

  // setSensitiveHeaders runs unconditionally at the top of protectLogs.
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
});

test('protectLogs calls next() and sets no status when the correct key is in the X-Stagify-Endpoint-Key header', () => {
  const { protectLogs } = createHttpGuards({
    genAI: null,
    LOGS_ACCESS_KEY: KEY,
    endpointKeyMatches: plainMatches,
  });
  const res = makeRes();
  const next = makeNext();
  protectLogs(makeReq({ headers: { 'X-Stagify-Endpoint-Key': KEY } }), res, next);

  assert.equal(next.called, true);
  assert.equal(next.calls, 1);
  assert.equal(res.statusCode, undefined);
  assert.equal(res.jsonBody, undefined);
});

test('protectLogs applies the sensitive headers on the authorized (next) path too', () => {
  const { protectLogs } = createHttpGuards({
    genAI: null,
    LOGS_ACCESS_KEY: KEY,
    endpointKeyMatches: plainMatches,
  });
  const res = makeRes();
  protectLogs(makeReq({ headers: { 'X-Stagify-Endpoint-Key': KEY } }), res, makeNext());

  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
});

test('protectLogs returns 403 "Access denied" when the header is missing entirely', () => {
  const { protectLogs } = createHttpGuards({
    genAI: null,
    LOGS_ACCESS_KEY: KEY,
    endpointKeyMatches: plainMatches,
  });
  const res = makeRes();
  const next = makeNext();
  protectLogs(makeReq({ headers: {} }), res, next);

  assert.equal(res.statusCode, 403);
  assert.equal(res.jsonBody.error, 'Access denied');
  assert.equal(res.jsonBody.message, 'Valid access key required in the X-Stagify-Endpoint-Key header');
  assert.equal(next.called, false);
});

test('protectLogs returns 403 when the header value is the wrong key', () => {
  const { protectLogs } = createHttpGuards({
    genAI: null,
    LOGS_ACCESS_KEY: KEY,
    endpointKeyMatches: plainMatches,
  });
  const res = makeRes();
  const next = makeNext();
  protectLogs(makeReq({ headers: { 'X-Stagify-Endpoint-Key': 'not-the-key' } }), res, next);

  assert.equal(res.statusCode, 403);
  assert.equal(res.jsonBody.error, 'Access denied');
  assert.equal(next.called, false);
});

test('SECURITY: protectLogs is header-only — a correct key supplied ONLY in ?key= (no header) is rejected with 403', () => {
  const { protectLogs } = createHttpGuards({
    genAI: null,
    LOGS_ACCESS_KEY: KEY,
    endpointKeyMatches: plainMatches,
  });
  const res = makeRes();
  const next = makeNext();
  // Correct secret, but presented via the query string only.
  protectLogs(makeReq({ query: { key: KEY }, headers: {} }), res, next);

  assert.equal(res.statusCode, 403);
  assert.equal(res.jsonBody.error, 'Access denied');
  assert.equal(next.called, false);
});

test('protectLogs consults endpointKeyMatches as (headerValue, LOGS_ACCESS_KEY) in that order, and 403s on a false result', () => {
  const seen = [];
  const spyMatches = (a, b) => {
    seen.push([a, b]);
    return a === b;
  };
  const { protectLogs } = createHttpGuards({
    genAI: null,
    LOGS_ACCESS_KEY: KEY,
    endpointKeyMatches: spyMatches,
  });
  const res = makeRes();
  const next = makeNext();
  // A WRONG header value so the two operands DIFFER — only then does the assertion
  // genuinely pin argument ORDER (headerValue first, the configured key second).
  protectLogs(makeReq({ headers: { 'X-Stagify-Endpoint-Key': 'wrong-value' } }), res, next);

  assert.deepEqual(seen, [['wrong-value', KEY]], 'called once with (headerValue, LOGS_ACCESS_KEY)');
  assert.equal(res.statusCode, 403, 'a false comparator result yields 403');
  assert.equal(next.called, false);
});

test('protectLogs short-circuits an empty-string header to 403 WITHOUT consulting the comparator', () => {
  const seen = [];
  const spyMatches = (a, b) => { seen.push([a, b]); return a === b; };
  const { protectLogs } = createHttpGuards({ genAI: null, LOGS_ACCESS_KEY: KEY, endpointKeyMatches: spyMatches });
  const res = makeRes();
  const next = makeNext();
  // accessKey is '' (falsy), so `accessKey && endpointKeyMatches(...)` skips the compare.
  protectLogs(makeReq({ headers: { 'X-Stagify-Endpoint-Key': '' } }), res, next);

  assert.equal(res.statusCode, 403);
  assert.equal(next.called, false);
  assert.deepEqual(seen, [], 'the comparator is never called for an empty header');
});

// ===========================================================================
// stagingEndpointKeyGuard — HEADER-ONLY, constant-time compare (mirrors protectLogs)
// ===========================================================================

test('stagingEndpointKeyGuard returns 500 "Server configuration error" when LOGS_ACCESS_KEY is falsy', () => {
  const { stagingEndpointKeyGuard } = createHttpGuards({
    genAI: null,
    LOGS_ACCESS_KEY: '',
    endpointKeyMatches: plainMatches,
  });
  const res = makeRes();
  const next = makeNext();
  stagingEndpointKeyGuard(makeReq({ headers: { 'x-stagify-endpoint-key': 'x' } }), res, next);

  assert.equal(res.statusCode, 500);
  assert.equal(res.jsonBody.error, 'Server configuration error');
  assert.equal(res.jsonBody.message, 'Endpoint access key not configured');
  assert.equal(next.called, false);
});

test('stagingEndpointKeyGuard calls next() when the correct key arrives via the x-stagify-endpoint-key header', () => {
  const { stagingEndpointKeyGuard } = createHttpGuards({
    genAI: null,
    LOGS_ACCESS_KEY: KEY,
    endpointKeyMatches: plainMatches,
  });
  const res = makeRes();
  const next = makeNext();
  stagingEndpointKeyGuard(makeReq({ headers: { 'x-stagify-endpoint-key': KEY } }), res, next);

  assert.equal(next.called, true);
  assert.equal(next.calls, 1);
  assert.equal(res.statusCode, undefined);
});

test('stagingEndpointKeyGuard trims a whitespace-padded header value before comparing', () => {
  const { stagingEndpointKeyGuard } = createHttpGuards({
    genAI: null,
    LOGS_ACCESS_KEY: KEY,
    endpointKeyMatches: plainMatches,
  });
  const res = makeRes();
  const next = makeNext();
  stagingEndpointKeyGuard(makeReq({ headers: { 'x-stagify-endpoint-key': `  ${KEY}  ` } }), res, next);

  assert.equal(next.called, true);
  assert.equal(res.statusCode, undefined);
});

test('SECURITY: stagingEndpointKeyGuard is header-only — a correct key supplied ONLY in ?key= (no header) is rejected with 403', () => {
  const { stagingEndpointKeyGuard } = createHttpGuards({
    genAI: null,
    LOGS_ACCESS_KEY: KEY,
    endpointKeyMatches: plainMatches,
  });
  const res = makeRes();
  const next = makeNext();
  stagingEndpointKeyGuard(makeReq({ query: { key: KEY }, headers: {} }), res, next);

  assert.equal(res.statusCode, 403, 'a URL key must never authenticate (it leaks via logs/Referer)');
  assert.equal(res.jsonBody.error, 'Access denied');
  assert.equal(next.called, false);
});

test('stagingEndpointKeyGuard returns 403 when the header key is wrong', () => {
  const { stagingEndpointKeyGuard } = createHttpGuards({
    genAI: null,
    LOGS_ACCESS_KEY: KEY,
    endpointKeyMatches: plainMatches,
  });
  const res = makeRes();
  const next = makeNext();
  stagingEndpointKeyGuard(makeReq({ headers: { 'x-stagify-endpoint-key': 'also-nope' } }), res, next);

  assert.equal(res.statusCode, 403);
  assert.equal(res.jsonBody.error, 'Access denied');
  assert.equal(res.jsonBody.message, 'Valid access key required in the X-Stagify-Endpoint-Key header');
  assert.equal(next.called, false);
});

test('stagingEndpointKeyGuard returns 403 when neither header nor query carries a key', () => {
  const { stagingEndpointKeyGuard } = createHttpGuards({
    genAI: null,
    LOGS_ACCESS_KEY: KEY,
    endpointKeyMatches: plainMatches,
  });
  const res = makeRes();
  const next = makeNext();
  stagingEndpointKeyGuard(makeReq({ query: {}, headers: {} }), res, next);

  assert.equal(res.statusCode, 403);
  assert.equal(res.jsonBody.error, 'Access denied');
  assert.equal(next.called, false);
});

test('stagingEndpointKeyGuard applies the sensitive headers (Cache-Control: no-store, Referrer-Policy: no-referrer) even on a 403', () => {
  const { stagingEndpointKeyGuard } = createHttpGuards({
    genAI: null,
    LOGS_ACCESS_KEY: KEY,
    endpointKeyMatches: plainMatches,
  });
  const res = makeRes();
  stagingEndpointKeyGuard(makeReq({ headers: {} }), res, makeNext());

  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
});

test('stagingEndpointKeyGuard compares via the injected constant-time endpointKeyMatches, called as (headerValue, LOGS_ACCESS_KEY)', () => {
  // The guard MUST consult endpointKeyMatches, not a plain ===. Injecting a
  // comparator that always returns false must turn away an otherwise-correct key.
  const seen = [];
  const alwaysFalse = (...args) => {
    seen.push(args);
    return false;
  };
  const { stagingEndpointKeyGuard } = createHttpGuards({
    genAI: null,
    LOGS_ACCESS_KEY: KEY,
    endpointKeyMatches: alwaysFalse,
  });
  const res = makeRes();
  const next = makeNext();
  stagingEndpointKeyGuard(makeReq({ headers: { 'x-stagify-endpoint-key': KEY } }), res, next);

  assert.equal(next.called, false, 'a false comparator result must reject even a byte-correct key');
  assert.equal(res.statusCode, 403);
  assert.deepEqual(seen, [[KEY, KEY]], 'called once as (headerValue, LOGS_ACCESS_KEY)');
});
