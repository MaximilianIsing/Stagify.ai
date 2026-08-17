// Tier: route contract (real guard + real store, faked everything else) —
// the admin-console session endpoints in routes/admin.js and the second credential
// they add to `protectLogs`.
//
// WHY A SEPARATE FILE FROM admin-route.test.js. That suite's premise is one
// credential: the key opens everything, nothing else opens anything. These endpoints
// deliberately break that symmetry, and the asymmetry IS the security design:
//
//   - the KEY mints a session (and only the key can — a token that could mint fresh
//     tokens would be unrevocable in practice),
//   - the TOKEN opens the dashboard's routes, so the operator stops retyping the key,
//   - neither is ever accepted from a URL, so no admin route is reachable by anything
//     a browser sends on its own. That is what keeps CSRF unreachable by construction
//     here, and it is the property a cookie-based session would have given up.
//
// mountAdmin wires the REAL createHttpGuards and a REAL SQLite session store, so what
// is asserted below is the actual guard behaviour, not a re-description of it.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mountAdmin, ADMIN_KEY } from '../helpers/admin-app.js';

const keyAuth = { 'X-Stagify-Endpoint-Key': ADMIN_KEY };
const sessionAuth = (token) => ({ 'X-Stagify-Admin-Session': token });

let app;
afterEach(async () => {
  if (app) { await app.close(); app = null; }
});

/** Sign in the way the console does: POST the key, get a token back. */
async function mintSession(base = app) {
  const res = await fetch(base.baseUrl + '/api/admin/session', { method: 'POST', headers: keyAuth });
  assert.equal(res.status, 200, 'the key should mint a session');
  return res.json();
}

// ---- Minting --------------------------------------------------------------

test('the key mints a session token with an expiry a month out', async () => {
  app = await mountAdmin();
  const before = Date.now();
  const { token, expiresAt } = await mintSession();

  assert.match(token, /^[0-9a-f]{64}$/);
  // Bounded loosely on purpose: the server stamps the expiry a moment after `before`,
  // so an exact 30 would be a clock race. What matters is the order of magnitude —
  // that this is a month and not an hour.
  const days = (expiresAt - before) / (24 * 60 * 60 * 1000);
  assert.ok(days > 29 && days < 31, `expected ~30 days, got ${days}`);
});

test('minting requires the KEY — a session token cannot mint another', async () => {
  app = await mountAdmin();
  const { token } = await mintSession();

  const res = await fetch(app.baseUrl + '/api/admin/session', { method: 'POST', headers: sessionAuth(token) });
  assert.equal(res.status, 403,
    'a stolen token must not be able to mint fresh ones — revoking the token you know '
    + 'about would otherwise achieve nothing');
});

test('minting refuses a wrong key, and refuses a key in the query string', async () => {
  app = await mountAdmin();
  const wrong = await fetch(app.baseUrl + '/api/admin/session', {
    method: 'POST', headers: { 'X-Stagify-Endpoint-Key': 'nope' },
  });
  assert.equal(wrong.status, 403);

  const inUrl = await fetch(`${app.baseUrl}/api/admin/session?key=${ADMIN_KEY}`, { method: 'POST' });
  assert.equal(inUrl.status, 403, 'a key in the URL leaks via access logs, history and Referer');
});

// ---- What the token opens, and what it does not ---------------------------

test('the token opens the dashboard routes, so the console stops asking for the key', async () => {
  app = await mountAdmin();
  const { token } = await mintSession();

  for (const url of ['/api/admin/ping', '/api/hosted-images', '/authstore', '/enterprise-domains']) {
    const res = await fetch(app.baseUrl + url, { headers: sessionAuth(token) });
    assert.equal(res.status, 200, `${url} should accept a session token`);
  }
});

test('a wrong, empty or revoked token is refused like a wrong key', async () => {
  app = await mountAdmin();
  const { token } = await mintSession();

  for (const bad of ['f'.repeat(64), 'not-a-token', '']) {
    const res = await fetch(app.baseUrl + '/api/hosted-images', { headers: sessionAuth(bad) });
    assert.equal(res.status, 403, `"${bad.slice(0, 12)}" must not authenticate`);
  }

  await fetch(app.baseUrl + '/api/admin/session', { method: 'DELETE', headers: sessionAuth(token) });
  const after = await fetch(app.baseUrl + '/api/hosted-images', { headers: sessionAuth(token) });
  assert.equal(after.status, 403, 'a revoked token is as good as a wrong one');
});

test('a token in the query string is not a credential', async () => {
  app = await mountAdmin();
  const { token } = await mintSession();

  const res = await fetch(`${app.baseUrl}/api/hosted-images?session=${token}`);
  assert.equal(res.status, 403,
    'header-only, exactly like the key: nothing a browser sends automatically, and '
    + 'nothing that survives in a log line, may reach an admin route');
});

// ---- Revocation -----------------------------------------------------------

test('sign-out revokes the presented token and leaves other devices signed in', async () => {
  app = await mountAdmin();
  const laptop = await mintSession();
  const phone = await mintSession();

  const res = await fetch(app.baseUrl + '/api/admin/session', { method: 'DELETE', headers: sessionAuth(laptop.token) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, revoked: 1 });

  assert.equal((await fetch(app.baseUrl + '/api/hosted-images', { headers: sessionAuth(laptop.token) })).status, 403);
  assert.equal((await fetch(app.baseUrl + '/api/hosted-images', { headers: sessionAuth(phone.token) })).status, 200);
});

test('signing out with { all: true } drops every device — the lost-laptop lever', async () => {
  app = await mountAdmin();
  const laptop = await mintSession();
  const phone = await mintSession();

  const res = await fetch(app.baseUrl + '/api/admin/session', {
    method: 'DELETE',
    headers: { ...keyAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ all: true }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).revoked, 2);

  for (const s of [laptop, phone]) {
    assert.equal((await fetch(app.baseUrl + '/api/hosted-images', { headers: sessionAuth(s.token) })).status, 403);
  }
  // The key still works, so revoking everything cannot lock the operator out.
  assert.equal((await fetch(app.baseUrl + '/api/hosted-images', { headers: keyAuth })).status, 200);
});

test('revoking an unknown token succeeds quietly rather than reporting what exists', async () => {
  app = await mountAdmin();
  const res = await fetch(app.baseUrl + '/api/admin/session', { method: 'DELETE', headers: keyAuth });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, revoked: 0 });
});

// ---- Degradation ----------------------------------------------------------

test('with no session store configured the key still works and minting says so', async () => {
  // The dep is optional in the bag, so a boot that could not open the store must
  // degrade to "type the key every time", never to an open door.
  app = await mountAdmin({ withAdminSessions: false });

  assert.equal((await fetch(app.baseUrl + '/api/hosted-images', { headers: keyAuth })).status, 200);
  assert.equal((await fetch(app.baseUrl + '/api/admin/session', { method: 'POST', headers: keyAuth })).status, 503);
  assert.equal(
    (await fetch(app.baseUrl + '/api/hosted-images', { headers: sessionAuth('f'.repeat(64)) })).status,
    403,
    'and no token can authenticate when there is nothing to validate it against',
  );
});
