// Tier: unit (hand-rolled req/res fakes, no Express) — lib/http/api-key-auth.js.
//
// WHAT THIS COVERS
// The door to /api/v1/*. Everything below the door assumes `req.apiUser` is the
// account that really owns the presented key, so the cases that matter are the ones
// where it must NOT be set:
//   - no header, a non-Bearer header, a Bearer that is not one of our keys,
//   - a key in ?key= or in the body is ignored — header only, always,
//   - a revoked key, and a key whose account has been erased,
//   - a suspended account is 403 even holding a perfectly good key,
//   - every refusal is counted against the reject bucket and a SUCCESS is not, which
//     is what stops a busy integration locking itself out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiKeyAuth, readBearerKey } from '../../lib/http/api-key-auth.js';

const GOOD = 'stg_live_' + 'a'.repeat(43);

/** A res that records what the middleware did to it. */
function fakeRes() {
  const res = {
    statusCode: 0,
    body: null,
    headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
  };
  return res;
}

function fakeReq(over = {}) {
  return { headers: {}, query: {}, body: {}, ip: '1.2.3.4', get(n) { return this.headers[String(n).toLowerCase()]; }, ...over };
}

/**
 * Build the middleware over fakes, recording how often the reject bucket was spent.
 */
function setup(over = {}) {
  const spent = [];
  const row = {
    id: 'ak_1', user_id: 'user_1', key_prefix: 'stg_live_aaa', revoked_at: null, ...(over.row || {}),
  };
  const deps = {
    apiKeys: {
      findByKey: (k) => (k === GOOD ? row : null),
      touchLastUsed: () => { touched.push(1); },
    },
    authStore: { findUserById: (id) => (over.noUser ? null : { id, email: 'dev@example.com', plan: 'free' }) },
    apiBilling: { getBalance: () => ({ balance: 10, suspendedAt: over.suspended || null }) },
    rejectLimiter: (req, res, next) => { spent.push(1); next(); },
  };
  const touched = [];
  const { requireApiKey } = createApiKeyAuth(deps);
  return { requireApiKey, spent, touched, row };
}

/** Run the middleware and report what happened. */
function run(requireApiKey, req) {
  const res = fakeRes();
  let nexted = false;
  let err;
  requireApiKey(req, res, (e) => { nexted = true; err = e; });
  return { res, nexted, err, req };
}

test('a valid key attaches the account and does NOT spend the reject bucket', () => {
  const { requireApiKey, spent, touched } = setup();
  const out = run(requireApiKey, fakeReq({ headers: { authorization: 'Bearer ' + GOOD } }));

  assert.equal(out.nexted, true);
  assert.equal(out.req.apiKey.id, 'ak_1');
  assert.equal(out.req.apiUser.id, 'user_1');
  assert.equal(spent.length, 0, 'a busy integration must not be able to lock itself out');
  assert.equal(touched.length, 1, 'last-used is stamped');
});

test('every refusal is a 401 with a distinct code, and each spends the reject bucket', () => {
  const cases = [
    ['no header at all', {}, 'API_KEY_MISSING'],
    ['a non-Bearer scheme', { authorization: 'Basic ' + GOOD }, 'API_KEY_MISSING'],
    ['a Bearer that is not one of ours', { authorization: 'Bearer nope' }, 'API_KEY_MISSING'],
    ['a well-formed key we never issued', { authorization: 'Bearer stg_live_' + 'z'.repeat(43) }, 'API_KEY_INVALID'],
  ];
  for (const [label, headers, code] of cases) {
    const { requireApiKey, spent } = setup();
    const out = run(requireApiKey, fakeReq({ headers }));
    assert.equal(out.res.statusCode, 401, label);
    assert.equal(out.res.body.code, code, label);
    assert.equal(out.nexted, false, label);
    assert.equal(spent.length, 1, `${label}: the attempt must be counted`);
  }
});

test('a key supplied anywhere but the Authorization header is ignored', () => {
  // A credential in a URL leaks via access logs, proxy logs, history and Referer.
  for (const req of [
    fakeReq({ query: { key: GOOD } }),
    fakeReq({ query: { api_key: GOOD } }),
    fakeReq({ body: { apiKey: GOOD } }),
    fakeReq({ headers: { 'x-api-key': GOOD } }),
  ]) {
    const { requireApiKey } = setup();
    const out = run(requireApiKey, req);
    assert.equal(out.res.statusCode, 401, 'only the Authorization header may carry a key');
    assert.equal(out.req.apiUser, undefined);
  }
});

test('a revoked key is refused, and says so', () => {
  const { requireApiKey, spent } = setup({ row: { revoked_at: 123 } });
  const out = run(requireApiKey, fakeReq({ headers: { authorization: 'Bearer ' + GOOD } }));

  assert.equal(out.res.statusCode, 401);
  assert.equal(out.res.body.code, 'API_KEY_REVOKED', 'the caller holds the key; vagueness protects nothing');
  assert.equal(spent.length, 1);
});

test('a key whose account was erased reads as invalid, not as a fourth state', () => {
  const { requireApiKey } = setup({ noUser: true });
  const out = run(requireApiKey, fakeReq({ headers: { authorization: 'Bearer ' + GOOD } }));

  assert.equal(out.res.statusCode, 401);
  assert.equal(out.res.body.code, 'API_KEY_INVALID');
});

test('a suspended account is 403 even with a perfectly good key', () => {
  const { requireApiKey, spent } = setup({ suspended: 999 });
  const out = run(requireApiKey, fakeReq({ headers: { authorization: 'Bearer ' + GOOD } }));

  assert.equal(out.res.statusCode, 403);
  assert.equal(out.res.body.code, 'ACCOUNT_SUSPENDED');
  assert.equal(out.nexted, false);
  assert.equal(spent.length, 0, 'a good credential must not count against the guessing bucket');
});

test('sensitive headers are set on every path, refused or not', () => {
  for (const headers of [{}, { authorization: 'Bearer ' + GOOD }]) {
    const { requireApiKey } = setup();
    const out = run(requireApiKey, fakeReq({ headers }));
    assert.equal(out.res.headers['Cache-Control'], 'no-store');
    assert.equal(out.res.headers['Referrer-Policy'], 'no-referrer');
  }
});

test('a limiter store failure is forwarded to Express, never swallowed into a pass', () => {
  // A limiter that cannot count must not silently become a pass-through.
  const boom = new Error('redis down');
  const { requireApiKey } = (() => {
    const { requireApiKey: _ } = createApiKeyAuth({
      apiKeys: { findByKey: () => null, touchLastUsed: () => {} },
      authStore: { findUserById: () => null },
      apiBilling: { getBalance: () => ({ balance: 0, suspendedAt: null }) },
      rejectLimiter: (req, res, next) => next(boom),
    });
    return { requireApiKey: _ };
  })();

  const out = run(requireApiKey, fakeReq({ headers: { authorization: 'Bearer stg_live_x' } }));
  assert.equal(out.err, boom);
  assert.equal(out.res.statusCode, 0, 'no response is written when the limiter itself failed');
});

test('readBearerKey tolerates padding and refuses everything that is not Bearer', () => {
  assert.equal(readBearerKey({ headers: { authorization: 'Bearer   abc  ' } }), 'abc');
  assert.equal(readBearerKey({ headers: { authorization: 'bearer abc' } }), '', 'the scheme is case-sensitive here');
  assert.equal(readBearerKey({ headers: {} }), '');
  assert.equal(readBearerKey({}), '');
  assert.equal(readBearerKey({ headers: { authorization: ['Bearer a', 'Bearer b'] } }), '', 'a duplicated header is not a key');
});
