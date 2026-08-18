// Tier: route contract (real guard, faked readers) — the two Signals-tab endpoints
// in routes/admin.js.
//
// WHY A SEPARATE FILE. Every other admin route serves a store read, a file, or a
// mutation. These two break that pattern in ways worth isolating:
//
//   - `GET /api/admin/metrics` is the first admin route that COMPUTES. It runs
//     analytical SQL against the production database on a click.
//   - `POST /api/admin/brief` is the only admin route that sends anything to a
//     third party.
//
// So the assertions here are about the contract, not the arithmetic: the gate, the
// degradation when a dependency is missing, and — the one that matters most — that
// nothing identifying a person can reach the model. The aggregates themselves are
// covered against real SQLite in test/analytics/admin-metrics.test.js and the
// prompt construction in test/services/admin-brief.test.js.
//
// THE DEGRADATION CASES ARE NOT EDGE CASES. The Signals tab computes its findings
// in the BROWSER; these endpoints only enrich them. If a missing OpenAI key or an
// unavailable database made either route error, a deployment without `GPT_KEY`
// would show a broken tab instead of a working one, so "absent dependency answers
// 200 with a null payload" is the designed behaviour and is asserted as such.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mountAdmin, ADMIN_KEY } from '../helpers/admin-app.js';

const auth = { 'X-Stagify-Endpoint-Key': ADMIN_KEY };
const jsonAuth = { ...auth, 'Content-Type': 'application/json' };

let app;
afterEach(async () => {
  if (app) { await app.close(); app = null; }
});

// ── The gate ────────────────────────────────────────────────────────────────

test('both endpoints are behind the admin gate', async () => {
  app = await mountAdmin();

  const metrics = await fetch(app.baseUrl + '/api/admin/metrics');
  assert.equal(metrics.status, 403, 'metrics must not be readable without the key');

  const brief = await fetch(app.baseUrl + '/api/admin/brief', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ findings: [{ title: 'x' }] }),
  });
  assert.equal(brief.status, 403, 'the brief must not be generatable without the key');
});

test('an unauthenticated brief request is refused without its body being read', async () => {
  // protectLogs is mounted BEFORE express.json() on this route. The property that
  // proves it: the generator is never reached, so a stranger cannot make the
  // server parse an arbitrary 256kb body (or bill a model call) by posting to it.
  app = await mountAdmin();
  await fetch(app.baseUrl + '/api/admin/brief', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ findings: [{ title: 'x' }] }),
  });
  assert.equal(app.calls.generateBrief.calls, 0, 'the brief generator ran for an unauthenticated caller');
});

// ── Metrics ─────────────────────────────────────────────────────────────────

test('metrics returns the snapshot under the key', async () => {
  const snapshot = { generatedAt: 1234, renders: { total: 7, distinctUsers: 3 } };
  app = await mountAdmin({ metricsSnapshot: snapshot });

  const res = await fetch(app.baseUrl + '/api/admin/metrics', { headers: auth });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).metrics, snapshot);
  assert.equal(app.calls.metricsSnapshot.calls, 1);
});

test('metrics degrades to a null payload when the reader is not configured', async () => {
  app = await mountAdmin({ withMetrics: false });

  const res = await fetch(app.baseUrl + '/api/admin/metrics', { headers: auth });
  assert.equal(res.status, 200, 'an absent dependency must not break the tab');
  const body = await res.json();
  assert.strictEqual(body.metrics, null);
  assert.equal(body.reason, 'unavailable');
});

test('a failing query is a 500 with a reference, not a leaked message', async () => {
  // The house rule for 5xx: the operator gets a ref to correlate with the logs,
  // never the exception text, which can carry SQL and column names.
  app = await mountAdmin({ metricsError: 'no such table: staged_renders' });

  const res = await fetch(app.baseUrl + '/api/admin/metrics', { headers: auth });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.ok(body.ref, 'a 500 must carry an error reference');
  assert.ok(
    !JSON.stringify(body).includes('no such table'),
    'the underlying error message must not reach the client',
  );
});

// ── Brief ───────────────────────────────────────────────────────────────────

test('the brief is generated from the posted findings', async () => {
  app = await mountAdmin({ briefResult: { summary: 'Kitchens are failing.', model: 'gpt-4o-mini' } });

  const findings = [{ title: 'Kitchen renders fail 4.1x more often', severity: 'critical' }];
  const res = await fetch(app.baseUrl + '/api/admin/brief', {
    method: 'POST', headers: jsonAuth, body: JSON.stringify({ findings }),
  });

  assert.equal(res.status, 200);
  assert.equal((await res.json()).summary, 'Kitchens are failing.');
  assert.equal(app.calls.generateBrief.calls, 1);
  assert.deepEqual(app.calls.generateBrief.lastArgs[0], findings, 'the findings are passed through verbatim');
});

test('the brief degrades to null when no model client is configured', async () => {
  // This is the state of any deployment without GPT_KEY. It must render as "no
  // brief", never as a failure — the findings underneath do not need a model.
  app = await mountAdmin({ withBrief: false });

  const res = await fetch(app.baseUrl + '/api/admin/brief', {
    method: 'POST', headers: jsonAuth, body: JSON.stringify({ findings: [{ title: 'x' }] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.summary, null);
  assert.equal(body.reason, 'unavailable');
});

test('a model failure reported by the generator is still a 200', async () => {
  app = await mountAdmin({ briefResult: { summary: null, reason: 'error' } });

  const res = await fetch(app.baseUrl + '/api/admin/brief', {
    method: 'POST', headers: jsonAuth, body: JSON.stringify({ findings: [{ title: 'x' }] }),
  });
  assert.equal(res.status, 200, 'a model outage must not 500 the Signals tab');
  assert.strictEqual((await res.json()).summary, null);
});

test('a body without a findings array is rejected before the generator runs', async () => {
  app = await mountAdmin();

  for (const body of [{}, { findings: 'not an array' }, { findings: null }]) {
    const res = await fetch(app.baseUrl + '/api/admin/brief', {
      method: 'POST', headers: jsonAuth, body: JSON.stringify(body),
    });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
  assert.equal(app.calls.generateBrief.calls, 0);
});

test('an oversized body is refused rather than forwarded', async () => {
  // The route caps express.json() at 256kb. Without it a caller holding the key
  // could push an arbitrarily large payload through to a metered model call.
  app = await mountAdmin();

  const huge = { findings: [{ title: 'x'.repeat(400 * 1024) }] };
  const res = await fetch(app.baseUrl + '/api/admin/brief', {
    method: 'POST', headers: jsonAuth, body: JSON.stringify(huge),
  });
  assert.ok(res.status >= 400, `expected a rejection, got ${res.status}`);
  assert.equal(app.calls.generateBrief.calls, 0, 'an oversized body must not reach the generator');
});
