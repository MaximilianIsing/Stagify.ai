// Tier: guard wiring (unit) + route contract (real admin router over the real limiter).
//
// WHAT THIS COVERS
// The per-IP ceiling on WRONG endpoint-access keys, applied inside lib/http/http-guards.js.
//
// WHY IT EXISTS. The entire admin surface — the CSV log dumps, the user list, comp
// grants, GDPR erasure — is gated by ONE shared static secret with no accounts behind
// it, so guessing that secret is the only way in. Nothing bounded the guess rate: the
// dashboard shows a lockout after a few bad tries, but that counter lives in the
// browser (public/scripts/admin.js), so it protects nobody who skips the page and
// posts the header directly. This is the server-side half.
//
// WHERE IT LIVES, and why not on the router. The limiter runs in the two guards, not
// as middleware on routes/admin.js, because (a) only the guard knows whether a key was
// actually REJECTED — counting requests instead would let an operator working in the
// dashboard rate-limit themselves — and (b) the same secret also opens
// POST /api/stage-by-endpoint-key, so a limiter bolted onto the admin router alone
// would leave the key just as guessable one endpoint over.
//
// The properties pinned here:
//   - only rejected attempts count; a valid key never spends a slot,
//   - the 500 "key not configured" path doesn't count (our misconfig, not a guess),
//   - ONE bucket is shared by both guards, so alternating endpoints doesn't buy an
//     attacker double the budget,
//   - over the limit the 403 is NOT written — the limiter's 429 answers instead,
//   - a limiter that errors fails CLOSED (to the error handler), never degrading into
//     a pass-through,
//   - omitting the dep falls back to the REAL shared limiter, so the key can't end up
//     unguarded by an omitted dep.
//
// RL_ENDPOINT_KEY is overridden BEFORE the first import of the limiter module — it is
// a module-level singleton built once from the env var — hence the dynamic imports.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// 3 keeps the burst short; the production default is 10 per 15 minutes.
const RL_SNAPSHOT = process.env.RL_ENDPOINT_KEY;
process.env.RL_ENDPOINT_KEY = '3';

const { createHttpGuards } = await import('../../lib/http/http-guards.js');
const { endpointKeyLimiter } = await import('../../lib/http/rate-limiters.js');
const { mountAdmin, ADMIN_KEY } = await import('../helpers/admin-app.js');

after(() => {
  if (RL_SNAPSHOT === undefined) delete process.env.RL_ENDPOINT_KEY;
  else process.env.RL_ENDPOINT_KEY = RL_SNAPSHOT;
});

const KEY = 'super-secret-endpoint-key';
const plainMatches = (a, b) => a === b;

// ---------------------------------------------------------------------------
// Fakes (same shapes as test/http/http-guards.test.js)
// ---------------------------------------------------------------------------

function makeRes() {
  const res = {
    statusCode: undefined,
    jsonBody: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.jsonBody = body; return this; },
    // express-rate-limit's default handler answers with res.send(message), not json().
    send(body) { this.jsonBody = body; return this; },
    set(field, value) { this.headers[field] = value; return this; },
  };
  res.setHeader = (field, value) => res.set(field, value);
  res.getHeader = (field) => res.headers[field];
  return res;
}

function makeReq({ headers = {}, ip = '203.0.113.7' } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { headers: lower, query: {}, ip, get: (name) => lower[String(name).toLowerCase()] };
}

function makeNext() {
  const next = (err) => { next.called = true; next.calls += 1; next.err = err; };
  next.called = false; next.calls = 0; next.err = undefined;
  return next;
}

/** A limiter stub that records each call and (by default) lets the request through. */
function makeLimiterSpy(behaviour) {
  const spy = (req, res, next) => {
    spy.calls += 1;
    return behaviour ? behaviour(req, res, next) : next();
  };
  spy.calls = 0;
  return spy;
}

function guards(deps) {
  return createHttpGuards({ genAI: null, LOGS_ACCESS_KEY: KEY, endpointKeyMatches: plainMatches, ...deps });
}

// ===========================================================================
// Which attempts land in the bucket
// ===========================================================================

test('protectLogs does NOT consume the key limiter when the key is correct', () => {
  const limiter = makeLimiterSpy();
  const { protectLogs } = guards({ endpointKeyLimiter: limiter });
  const next = makeNext();
  protectLogs(makeReq({ headers: { 'X-Stagify-Endpoint-Key': KEY } }), makeRes(), next);

  assert.equal(next.called, true);
  assert.equal(limiter.calls, 0, 'a valid key must never spend a bucket slot');
});

test('protectLogs runs the key limiter on a WRONG key, then still 403s', () => {
  const limiter = makeLimiterSpy();
  const { protectLogs } = guards({ endpointKeyLimiter: limiter });
  const res = makeRes();
  const next = makeNext();
  protectLogs(makeReq({ headers: { 'X-Stagify-Endpoint-Key': 'nope' } }), res, next);

  assert.equal(limiter.calls, 1);
  assert.equal(res.statusCode, 403);
  assert.equal(res.jsonBody.error, 'Access denied');
  assert.equal(res.jsonBody.details, 'Valid access key required in the X-Stagify-Endpoint-Key header');
  assert.equal(next.called, false, 'the route must not run');
});

test('protectLogs runs the key limiter when the header is MISSING entirely', () => {
  const limiter = makeLimiterSpy();
  const { protectLogs } = guards({ endpointKeyLimiter: limiter });
  const res = makeRes();
  protectLogs(makeReq({ headers: {} }), res, makeNext());

  assert.equal(limiter.calls, 1, 'an absent key is still a rejected attempt');
  assert.equal(res.statusCode, 403);
});

test('protectLogs does NOT consume the key limiter on the 500 "key not configured" path', () => {
  const limiter = makeLimiterSpy();
  const { protectLogs } = guards({ LOGS_ACCESS_KEY: '', endpointKeyLimiter: limiter });
  const res = makeRes();
  protectLogs(makeReq({ headers: { 'X-Stagify-Endpoint-Key': 'anything' } }), res, makeNext());

  assert.equal(res.statusCode, 500);
  assert.equal(limiter.calls, 0, 'our own misconfiguration is not a guessing attempt');
});

test('stagingEndpointKeyGuard runs the key limiter on a wrong key but not on a right one', () => {
  const limiter = makeLimiterSpy();
  const { stagingEndpointKeyGuard } = guards({ endpointKeyLimiter: limiter });

  stagingEndpointKeyGuard(makeReq({ headers: { 'x-stagify-endpoint-key': KEY } }), makeRes(), makeNext());
  assert.equal(limiter.calls, 0);

  const res = makeRes();
  stagingEndpointKeyGuard(makeReq({ headers: { 'x-stagify-endpoint-key': 'nope' } }), res, makeNext());
  assert.equal(limiter.calls, 1);
  assert.equal(res.statusCode, 403);
});

test('SECURITY: both guards share ONE limiter instance, so alternating endpoints does not double the budget', () => {
  const limiter = makeLimiterSpy();
  const { protectLogs, stagingEndpointKeyGuard } = guards({ endpointKeyLimiter: limiter });

  protectLogs(makeReq({ headers: { 'X-Stagify-Endpoint-Key': 'a' } }), makeRes(), makeNext());
  stagingEndpointKeyGuard(makeReq({ headers: { 'x-stagify-endpoint-key': 'b' } }), makeRes(), makeNext());
  protectLogs(makeReq({ headers: { 'X-Stagify-Endpoint-Key': 'c' } }), makeRes(), makeNext());

  assert.equal(limiter.calls, 3, 'every wrong key lands in the same bucket regardless of which guard saw it');
});

// ===========================================================================
// What happens at and past the limit
// ===========================================================================

test('SECURITY: over the limit the 403 is NOT written — the limiter answers instead', () => {
  // The real limiter writes its own 429 and never calls back. Model that here: a
  // limiter that swallows `next` must leave the guard silent.
  const limiter = makeLimiterSpy((req, res) => res.status(429).json({ error: 'Too many attempts.' }));
  const { protectLogs } = guards({ endpointKeyLimiter: limiter });
  const res = makeRes();
  const next = makeNext();
  protectLogs(makeReq({ headers: { 'X-Stagify-Endpoint-Key': 'nope' } }), res, next);

  assert.equal(res.statusCode, 429, 'the limiter, not the guard, wrote the response');
  assert.equal(res.jsonBody.error, 'Too many attempts.');
  assert.equal(next.called, false, 'the route still must not run');
});

test('a key limiter that errors forwards to next(err) and does NOT fall through to the route', () => {
  const boom = new Error('store unavailable');
  const limiter = makeLimiterSpy((req, res, next) => next(boom));
  const { protectLogs } = guards({ endpointKeyLimiter: limiter });
  const res = makeRes();
  const seen = [];
  protectLogs(makeReq({ headers: { 'X-Stagify-Endpoint-Key': 'nope' } }), res, (err) => seen.push(err));

  assert.deepEqual(seen, [boom], 'the store failure reaches the Express error handler');
  assert.equal(res.statusCode, undefined, 'no 403 body was written alongside the error');
});

// ===========================================================================
// The fallback — omitting the dep must not mean "unlimited"
// ===========================================================================

test('omitting endpointKeyLimiter falls back to the REAL shared limiter, so an omitted dep cannot leave the key unguarded', async () => {
  // The dep is OMITTED here — that is the whole point. Deleting
  // `?? defaultEndpointKeyLimiter` in http-guards.js would make the guard call
  // `undefined(...)` and throw, and swapping the fallback for a pass-through would
  // drop the RateLimit-* headers; either way this fails.
  const { protectLogs } = createHttpGuards({ genAI: null, LOGS_ACCESS_KEY: KEY, endpointKeyMatches: plainMatches });
  const res = makeRes();
  const next = makeNext();
  // A fresh IP so this doesn't share a bucket with the route tests below.
  // The real limiter is async — await the guard, or the assertions race its writes.
  await protectLogs(makeReq({ headers: {}, ip: '198.51.100.1' }), res, next);

  // draft-7 standard headers are the real limiter's fingerprint; a stub writes none.
  assert.ok(
    Object.keys(res.headers).some((h) => h.toLowerCase().startsWith('ratelimit')),
    'the real limiter ran and wrote its RateLimit-* headers',
  );
  assert.equal(res.statusCode, 403, 'under the limit a wrong key still gets the normal 403');
  assert.equal(next.called, false);
});

test('the exported endpointKeyLimiter honours RL_ENDPOINT_KEY (this file set it to 3)', async () => {
  // Pins that the ceiling is env-tunable rather than hardcoded — the operator lever
  // for a deploy that needs a different budget.
  const ip = '198.51.100.99';
  const statuses = [];
  for (let i = 0; i < 4; i += 1) {
    const res = makeRes();
    await endpointKeyLimiter(makeReq({ ip }), res, () => res.status(403).json({ error: 'Access denied' }));
    statuses.push(res.statusCode);
  }
  assert.deepEqual(statuses, [403, 403, 403, 429], 'the 4th attempt trips the limit of 3');
});

// ===========================================================================
// Route contract — the real admin router, the real limiter, over HTTP
// ===========================================================================

test('ROUTE: repeated wrong keys against admin endpoints 429 after the limit, and mixing endpoints does not reset it', async () => {
  const app = await mountAdmin({ realKeyLimiter: true });
  try {
    // RL_ENDPOINT_KEY=3. Spend the bucket across DIFFERENT admin endpoints to prove
    // one shared bucket covers the whole surface rather than one per route.
    const paths = ['/authstore', '/promptlogs', '/chatlogs'];
    for (const p of paths) {
      const r = await fetch(`${app.baseUrl}${p}`, { headers: { 'X-Stagify-Endpoint-Key': 'wrong' } });
      assert.equal(r.status, 403, `${p} should still 403 while under the limit`);
    }

    // Fourth wrong key — bucket exhausted.
    const blocked = await fetch(`${app.baseUrl}/memories`, { headers: { 'X-Stagify-Endpoint-Key': 'wrong' } });
    assert.equal(blocked.status, 429, 'the 4th wrong key is rate limited, not merely denied');
    const body = await blocked.json();
    assert.match(body.error, /too many attempts/i);

    // And a MUTATING route is covered too — the limiter is on the guard, so every
    // route behind it inherits the ceiling with no per-route wiring.
    const mutating = await fetch(`${app.baseUrl}/api/admin/delete-user`, {
      method: 'POST',
      headers: { 'X-Stagify-Endpoint-Key': 'wrong', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'victim@example.com' }),
    });
    assert.equal(mutating.status, 429);
    assert.equal(app.calls.deleteUser.calls, 0, 'no erasure ran');
  } finally {
    await app.close();
  }
});

test('ROUTE: POST /api/getpro shares the same bucket — the inline key compare is not an unlimited oracle', async () => {
  // This route compares the key inline instead of going through protectLogs, and it
  // grants Pro to whoever gets it right. If it kept its own (or no) bucket, an
  // attacker would simply guess here instead of against the admin routes, and the
  // ceiling added to those would be decorative. Reverting routes/auth.js to a plain
  // `sendError(res, 403, ...)` has to fail something — this is it.
  const { mountAuth } = await import('../helpers/auth-app.js');
  const app = await mountAuth();
  try {
    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await fetch(`${app.baseUrl}/api/getpro`, {
        method: 'POST',
        headers: { 'X-Stagify-Endpoint-Key': `wrong-${i}` },
      });
      statuses.push(r.status);
    }
    assert.ok(statuses.includes(429), `a wrong key here must eventually be limited, got ${statuses.join(',')}`);
    assert.equal(statuses[statuses.length - 1], 429, 'and stay limited once the bucket is spent');
  } finally {
    await app.close();
  }
});

test('ROUTE: a rate-limited caller who then presents the CORRECT key is still served', async () => {
  // The operator fat-fingering the key a few times must not lock themselves out of
  // their own dashboard — the bucket only ever counted their WRONG attempts, and a
  // right one skips the limiter entirely.
  const app = await mountAdmin({ realKeyLimiter: true, dataLogFiles: { 'prompt_logs.csv': 'a,b\n1,2\n' } });
  try {
    for (let i = 0; i < 5; i += 1) {
      await fetch(`${app.baseUrl}/authstore`, { headers: { 'X-Stagify-Endpoint-Key': `wrong-${i}` } });
    }
    // Confirm the bucket really is spent for wrong keys...
    const blocked = await fetch(`${app.baseUrl}/authstore`, { headers: { 'X-Stagify-Endpoint-Key': 'wrong-again' } });
    assert.equal(blocked.status, 429);

    // ...yet the correct key sails past it.
    const ok = await fetch(`${app.baseUrl}/promptlogs`, { headers: { 'X-Stagify-Endpoint-Key': ADMIN_KEY } });
    assert.equal(ok.status, 200, 'a valid key is never rate limited');
  } finally {
    await app.close();
  }
});
