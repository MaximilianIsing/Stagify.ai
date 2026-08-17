// Tier: route contract (real guard, REAL uptime monitor) — the server-status and
// incident endpoints in routes/admin.js.
//
// WHY THE REAL MONITOR (mountAdmin's `realUptime: true`). These four routes are CRUD
// over persisted monitor state, and the interesting behaviour — that a posted
// incident reaches the PUBLIC snapshot, that resolving one clears the disruption,
// that a rejected post writes nothing — lives in that state. Against a stub every
// assertion here would only be checking that the route called the method it calls.
//
// The property this file exists to protect: what an operator types in the console
// lands on the page strangers read. The last assertion walks that whole path.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mountAdmin, ADMIN_KEY } from '../helpers/admin-app.js';

const auth = { 'X-Stagify-Endpoint-Key': ADMIN_KEY };
const jsonAuth = { ...auth, 'Content-Type': 'application/json' };
const HOUR = 60 * 60 * 1000;

let app;
afterEach(async () => {
  if (app) { await app.close(); app = null; }
});

const post = (body) => fetch(app.baseUrl + '/api/admin/incidents', {
  method: 'POST', headers: jsonAuth, body: JSON.stringify(body),
});
const adminStatus = async () => (await fetch(app.baseUrl + '/api/admin/status', { headers: auth })).json();

// ---- The gate --------------------------------------------------------------

test('every status endpoint is behind the admin gate', async () => {
  app = await mountAdmin({ realUptime: true });

  const unauthed = [
    fetch(app.baseUrl + '/api/admin/status'),
    fetch(app.baseUrl + '/api/admin/incidents', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }),
    fetch(app.baseUrl + '/api/admin/incidents/abc/resolve', { method: 'POST' }),
    fetch(app.baseUrl + '/api/admin/incidents/abc', { method: 'DELETE' }),
  ];
  for (const res of await Promise.all(unauthed)) {
    assert.equal(res.status, 403, `${res.url} must be gated`);
  }
});

// ---- The admin snapshot ----------------------------------------------------

test('the admin snapshot carries the depth the public one leaves out', async () => {
  app = await mountAdmin({ realUptime: true });
  const data = await adminStatus();

  assert.ok(data.buckets['24h'] && data.buckets['7d'], 'the two public graphs are still there');
  assert.ok(Array.isArray(data.buckets['30d']), 'plus the 30-day one the public page does not draw');
  assert.ok(data.windows['24h'].coverage !== undefined, 'coverage, which qualifies every percentage');
  assert.ok(data.config.gapThresholdMs > 0, 'and the monitor settings behind those numbers');
  assert.ok(Array.isArray(data.manual), 'posted entries are also available as their own list');
});

test('the admin snapshot is never cached — a status view has to be current', async () => {
  app = await mountAdmin({ realUptime: true });
  const res = await fetch(app.baseUrl + '/api/admin/status', { headers: auth });
  assert.match(res.headers.get('cache-control') || '', /no-store/);
});

// ---- Posting ---------------------------------------------------------------

test('posting an incident returns it, and it shows up in the log', async () => {
  app = await mountAdmin({ realUptime: true });
  const res = await post({ title: 'Renders failing — upstream outage', affectsUptime: true });
  assert.equal(res.status, 201);

  const { incident } = await res.json();
  assert.equal(incident.title, 'Renders failing — upstream outage');
  assert.equal(incident.end, null, 'no end supplied means ongoing');

  const data = await adminStatus();
  assert.equal(data.manual.length, 1);
  assert.equal(data.currentState, 'down', 'an unresolved outage is reported as a disruption');
});

test('a bad post is a 400 carrying the message the operator needs to read', async () => {
  app = await mountAdmin({ realUptime: true });

  const blank = await post({ title: '   ' });
  assert.equal(blank.status, 400);
  assert.match((await blank.json()).error, /title is required/i);

  const backwards = await post({ title: 'Outage', start: Date.now(), end: Date.now() - HOUR });
  assert.equal(backwards.status, 400);
  assert.match((await backwards.json()).error, /after the start/i);

  assert.equal((await adminStatus()).manual.length, 0, 'and nothing was written');
});

test('affectsUptime decides whether the percentages move', async () => {
  app = await mountAdmin({ realUptime: true });
  const now = Date.now();
  // The monitor was created a moment ago, so its monitored window starts a moment
  // ago and NOTHING backdated would count (see the next test — that is deliberate).
  // Age it so this models the real case: a monitor that has been running a while.
  app.uptime._getState().monitoringStart = now - 30 * 24 * HOUR;

  await post({ title: 'Scheduled maintenance', start: now - 2 * HOUR, end: now - HOUR, affectsUptime: false });
  assert.equal((await adminStatus()).windows['24h'].downMs, 0, 'a notice is not downtime');

  await post({ title: 'Real outage', start: now - 4 * HOUR, end: now - 3 * HOUR, affectsUptime: true });
  assert.equal((await adminStatus()).windows['24h'].downMs, HOUR, 'an outage is');
});

test('an incident backdated before monitoring began does not move the figure', async () => {
  // Surprising but right, and the same rule the auto side follows: a percentage is
  // only ever computed over the stretch we actually watched, so a fresh monitor
  // cannot be talked into claiming knowledge of the week before it existed. The
  // entry still PUBLISHES — it just does not rewrite history it never saw, and
  // `coverage` on the window is what tells the reader so.
  app = await mountAdmin({ realUptime: true });
  const now = Date.now();

  await post({ title: 'Outage from before we watched', start: now - 6 * HOUR, end: now - 5 * HOUR, affectsUptime: true });

  const data = await adminStatus();
  assert.equal(data.windows['24h'].downMs, 0);
  assert.equal(data.manual.length, 1, 'it is still on the page');
  assert.ok(data.windows['24h'].coverage < 1, 'and coverage is what explains the gap');
});

// ---- Resolving and deleting ------------------------------------------------

test('resolving closes an ongoing incident and clears the disruption', async () => {
  app = await mountAdmin({ realUptime: true });
  const { incident } = await (await post({ title: 'Investigating', affectsUptime: true })).json();
  assert.equal((await adminStatus()).currentState, 'down');

  const res = await fetch(`${app.baseUrl}/api/admin/incidents/${incident.id}/resolve`, { method: 'POST', headers: auth });
  assert.equal(res.status, 200);

  const data = await adminStatus();
  assert.equal(data.manual[0].ongoing, false);
  assert.equal(data.currentState, 'up');
});

test('deleting removes it entirely', async () => {
  app = await mountAdmin({ realUptime: true });
  const { incident } = await (await post({ title: 'Posted by mistake' })).json();

  const res = await fetch(`${app.baseUrl}/api/admin/incidents/${incident.id}`, { method: 'DELETE', headers: auth });
  assert.equal(res.status, 200);
  assert.equal((await adminStatus()).manual.length, 0);
});

test('an unknown id is a 404 on both, not a silent success', async () => {
  app = await mountAdmin({ realUptime: true });
  const resolve = await fetch(app.baseUrl + '/api/admin/incidents/nope/resolve', { method: 'POST', headers: auth });
  const del = await fetch(app.baseUrl + '/api/admin/incidents/nope', { method: 'DELETE', headers: auth });
  assert.equal(resolve.status, 404);
  assert.equal(del.status, 404);
});

// ---- The whole point -------------------------------------------------------

test('an incident posted in the console reaches the PUBLIC status payload', async () => {
  // The end-to-end property, asserted against the same pure snapshot builder that
  // GET /api/status serves. If this passes and the public page still shows nothing,
  // the bug is in public/scripts/status.js, not here.
  app = await mountAdmin({ realUptime: true });
  await post({ title: 'Staging is degraded while we fail over', affectsUptime: true });

  const publicSnapshot = app.uptime.getSnapshot();
  const entry = publicSnapshot.incidents.find((i) => i.cause === 'Staging is degraded while we fail over');
  assert.ok(entry, 'a posted incident must appear in the public feed');
  assert.equal(entry.ongoing, true);
  // `cause`, not `title`: status.js already renders that field, which is what lets a
  // posted incident display on the public page with no client change at all.
  assert.equal(publicSnapshot.currentState, 'down', 'and the public banner reflects it');
});

test('resetting the history clears posted incidents as well as detected ones', async () => {
  app = await mountAdmin({ realUptime: true });
  await post({ title: 'Something happened', affectsUptime: true });

  const res = await fetch(app.baseUrl + '/api/status/reset', { method: 'POST', headers: auth });
  assert.equal(res.status, 200);
  assert.equal((await adminStatus()).manual.length, 0,
    'the confirm dialog promises everything goes; leaving posted entries would contradict it');
});
