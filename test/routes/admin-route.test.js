// Tier: route contract (real guard, faked stores) — routes/admin.js.
//
// WHAT THIS COVERS
// Every admin endpoint is protected by the same access-key guard, and the router
// hosts the only mutating admin actions (image host/unhost, memory + uptime reset)
// plus the CSV/JSON backup downloads. This suite mounts the real router with the
// REAL protectLogs guard (see test/helpers/admin-app.js) and asserts:
//   - the access-key gate: no key / wrong key → 403, correct key → through; a server
//     with no key configured → 500 (fail closed),
//   - host-image: a valid upload writes a file + manifest entry and returns its url;
//     a missing file or an upload error → 400,
//   - unhost: invalid id → 400, unknown id → 404, valid id → removes file + entry,
//   - the snapshot/reset actions invoke the injected store/monitor helpers and shape
//     their responses (authstore/memories/enterprise-domains downloads, resetmemories,
//     status reset),
//   - log downloads: an existing CSV is served, a missing one → 404.
// No datastore and no full server boot; the manifest is in-memory, files land in a
// temp dir, and the access key is a constant compared with the real comparator.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mountAdmin, ADMIN_KEY } from '../helpers/admin-app.js';

const auth = { 'X-Stagify-Endpoint-Key': ADMIN_KEY };
const PNG = { buffer: Buffer.from('fake-png-bytes'), mimetype: 'image/png', originalname: 'shot.png', size: 14 };

let app;
afterEach(async () => {
  if (app) { await app.close(); app = null; }
});

// ---- Access-key gate ------------------------------------------------------

test('admin endpoints reject a missing or wrong access key with 403', async () => {
  app = await mountAdmin();
  const noKey = await fetch(app.baseUrl + '/api/hosted-images');
  assert.equal(noKey.status, 403, 'no key → 403');
  const wrongKey = await fetch(app.baseUrl + '/api/hosted-images', { headers: { 'X-Stagify-Endpoint-Key': 'nope' } });
  assert.equal(wrongKey.status, 403, 'wrong key → 403');
  const ok = await fetch(app.baseUrl + '/api/hosted-images', { headers: auth });
  assert.equal(ok.status, 200, 'correct key → through');
});

test('a server with no access key configured fails closed (500)', async () => {
  app = await mountAdmin({ logsAccessKey: '' });
  const res = await fetch(app.baseUrl + '/api/hosted-images', { headers: auth });
  assert.equal(res.status, 500);
});

// ---- Host / list / unhost images -----------------------------------------

test('host-image writes the file + a manifest entry and returns its url', async () => {
  app = await mountAdmin({ uploadFile: PNG });
  const res = await fetch(app.baseUrl + '/api/host-image', { method: 'POST', headers: auth });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.id, /^[a-f0-9]{32}$/, 'a 32-hex unguessable id');
  assert.equal(body.path, '/i/' + body.id);
  assert.match(body.url, /\/i\/[a-f0-9]{32}$/);

  const manifest = app.getManifest();
  assert.equal(manifest.length, 1, 'the entry was persisted');
  assert.equal(manifest[0].mime, 'image/png');
  assert.ok(fs.existsSync(path.join(app.hostedImagesDir, manifest[0].file)), 'the image bytes were written');
});

test('host-image → 400 when no file is provided', async () => {
  app = await mountAdmin(); // no uploadFile
  const res = await fetch(app.baseUrl + '/api/host-image', { method: 'POST', headers: auth });
  assert.equal(res.status, 400);
  assert.equal(app.getManifest().length, 0);
});

test('host-image → 400 when the upload middleware errors', async () => {
  app = await mountAdmin({ uploadError: 'File too large' });
  const res = await fetch(app.baseUrl + '/api/host-image', { method: 'POST', headers: auth });
  assert.equal(res.status, 400);
});

test('hosted-images lists persisted entries newest-first with their /i/ path', async () => {
  app = await mountAdmin({ uploadFile: PNG });
  await fetch(app.baseUrl + '/api/host-image', { method: 'POST', headers: auth });
  const res = await fetch(app.baseUrl + '/api/hosted-images', { headers: auth });
  const { images } = await res.json();
  assert.equal(images.length, 1);
  assert.equal(images[0].path, '/i/' + images[0].id);
});

test('unhost rejects a malformed id (400) and an unknown id (404)', async () => {
  app = await mountAdmin();
  const bad = await fetch(app.baseUrl + '/api/hosted-images/not-hex', { method: 'DELETE', headers: auth });
  assert.equal(bad.status, 400);
  const missing = await fetch(app.baseUrl + '/api/hosted-images/' + 'a'.repeat(32), { method: 'DELETE', headers: auth });
  assert.equal(missing.status, 404);
});

test('unhost removes the file and its manifest entry', async () => {
  app = await mountAdmin({ uploadFile: PNG });
  const hosted = await (await fetch(app.baseUrl + '/api/host-image', { method: 'POST', headers: auth })).json();
  const file = app.getManifest()[0].file;
  assert.ok(fs.existsSync(path.join(app.hostedImagesDir, file)));

  const del = await fetch(app.baseUrl + '/api/hosted-images/' + hosted.id, { method: 'DELETE', headers: auth });
  assert.equal(del.status, 200);
  assert.equal(app.getManifest().length, 0, 'entry removed from the manifest');
  assert.ok(!fs.existsSync(path.join(app.hostedImagesDir, file)), 'the image bytes were deleted');
});

// ---- Snapshot downloads + reset actions -----------------------------------

test('authstore serves the REDACTED snapshot, never the credential-bearing export', async () => {
  app = await mountAdmin();
  const res = await fetch(app.baseUrl + '/authstore', { headers: auth });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') || '', /auth-store\.json/);
  assert.deepEqual(await res.json(), { users: [] });
  assert.equal(app.calls.authExportRedacted.calls, 1, 'a live redacted snapshot is rebuilt');
  assert.equal(
    app.calls.authExport.calls,
    0,
    'exportStore() carries password hashes + live session tokens and must never reach HTTP',
  );
});

test('admin ping validates the key without returning any data', async () => {
  app = await mountAdmin();
  const res = await fetch(app.baseUrl + '/api/admin/ping', { headers: auth });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(app.calls.authExportRedacted.calls, 0, 'the login probe touches no store');

  const denied = await fetch(app.baseUrl + '/api/admin/ping');
  assert.equal(denied.status, 403, 'still gated by the endpoint key');
});

test('memories download serves the exported memories snapshot', async () => {
  app = await mountAdmin();
  const res = await fetch(app.baseUrl + '/memories', { headers: auth });
  assert.equal(res.status, 200);
  assert.equal(app.calls.exportAllMemories.calls, 1);
});

test('enterprise-domains download serves the enterprise snapshot', async () => {
  app = await mountAdmin();
  const res = await fetch(app.baseUrl + '/enterprise-domains', { headers: auth });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { domains: [] });
});

test('resetmemories invokes the reset action and acks success', async () => {
  app = await mountAdmin();
  const res = await fetch(app.baseUrl + '/resetmemories', { method: 'POST', headers: auth });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).success, true);
  assert.equal(app.calls.resetAllMemories.calls, 1);
});

test('GET /resetmemories wipes nothing — a mutating GET is one retry from a double wipe', async () => {
  app = await mountAdmin();
  const res = await fetch(app.baseUrl + '/resetmemories', { headers: auth });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'POST');
  // The property that matters: the store was never touched.
  assert.equal(app.calls.resetAllMemories.calls, 0, 'a GET must never reset memories');
});

test('GET /resetmemories still 403s without the key, revealing nothing about the verb', async () => {
  app = await mountAdmin();
  const res = await fetch(app.baseUrl + '/resetmemories');
  assert.equal(res.status, 403);
  assert.equal(app.calls.resetAllMemories.calls, 0);
});

// ---- GDPR erasure ---------------------------------------------------------

test('delete-user erases the account and reports what it removed', async () => {
  app = await mountAdmin();
  const res = await fetch(app.baseUrl + '/api/admin/delete-user', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'gone@example.com' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.rows, { users: 1, sessions: 2, memories: 1 }, 'the per-table counts reach the operator');
  assert.equal(app.calls.deleteUser.calls, 1);
  assert.deepEqual(app.calls.deleteUser.lastArgs[0], { userId: undefined, email: 'gone@example.com', force: false });
});

test('delete-user requires the admin key and an identifier, and never guesses force', async () => {
  app = await mountAdmin();

  const noKey = await fetch(app.baseUrl + '/api/admin/delete-user', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'gone@example.com' }),
  });
  assert.equal(noKey.status, 403);

  const noId = await fetch(app.baseUrl + '/api/admin/delete-user', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(noId.status, 400);
  assert.equal(app.calls.deleteUser.calls, 0, 'an irreversible action must not run on an empty body');

  // Only a literal `true` forces past the live-subscription refusal — not "yes", not 1.
  await fetch(app.baseUrl + '/api/admin/delete-user', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 'u_1', force: 'yes' }),
  });
  assert.equal(app.calls.deleteUser.lastArgs[0].force, false);
});

test('delete-user surfaces a refusal with its code (404 unknown, 400 still paying)', async () => {
  app = await mountAdmin({ deleteUserResult: { ok: false, code: 'NOT_FOUND', error: 'No such user' } });
  const missing = await fetch(app.baseUrl + '/api/admin/delete-user', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 'nope' }),
  });
  assert.equal(missing.status, 404);
  await app.close();

  app = await mountAdmin({
    deleteUserResult: { ok: false, code: 'ACTIVE_SUBSCRIPTION', error: 'Cancel it in Stripe first' },
  });
  const paying = await fetch(app.baseUrl + '/api/admin/delete-user', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 'u_1' }),
  });
  assert.equal(paying.status, 400);
  const body = await paying.json();
  assert.equal(body.code, 'ACTIVE_SUBSCRIPTION', 'the caller can tell the two refusals apart');
  assert.match(body.error, /Could not delete|Cancel it in Stripe/);
});

test('GET /api/admin/delete-user erases nothing', async () => {
  app = await mountAdmin();
  const res = await fetch(app.baseUrl + '/api/admin/delete-user', { headers: auth });
  assert.equal(res.status, 404, 'no GET route is registered for it');
  assert.equal(app.calls.deleteUser.calls, 0);
});

test('status/reset wipes uptime history and returns the fresh snapshot', async () => {
  app = await mountAdmin();
  const res = await fetch(app.baseUrl + '/api/status/reset', { method: 'POST', headers: auth });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.deepEqual(body.snapshot, { up: true, since: 'now' });
  assert.equal(app.calls.uptimeReset.calls, 1);
});

// ---- Emails tab: preview gallery + test send ------------------------------

test('email-previews requires the key and returns the full catalog', async () => {
  app = await mountAdmin();
  const noKey = await fetch(app.baseUrl + '/api/admin/email-previews');
  assert.equal(noKey.status, 403, 'gated by the access key');

  const res = await fetch(app.baseUrl + '/api/admin/email-previews', { headers: auth });
  assert.equal(res.status, 200);
  const { emails } = await res.json();
  assert.ok(Array.isArray(emails) && emails.length >= 8, 'returns every user-facing email');
  const welcome = emails.find((e) => e.id === 'trial-welcome');
  assert.ok(welcome && welcome.subject && welcome.html, 'entries carry subject + html');
});

test('email-test-send: valid id + email invokes the sender and acks', async () => {
  app = await mountAdmin();
  const res = await fetch(app.baseUrl + '/api/admin/email-test-send', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'trial-welcome', email: 'me@example.com' }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.equal(app.calls.sendTestEmail.calls, 1, 'the test-send helper was called once');
  assert.deepEqual(app.calls.sendTestEmail.lastArgs[0], { id: 'trial-welcome', toEmail: 'me@example.com' });
});

test('email-test-send: missing fields or a bad email → 400, sender not called', async () => {
  app = await mountAdmin();
  const send = (body) => fetch(app.baseUrl + '/api/admin/email-test-send', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  assert.equal((await send({ email: 'me@example.com' })).status, 400, 'missing id');
  assert.equal((await send({ id: 'trial-welcome' })).status, 400, 'missing email');
  assert.equal((await send({ id: 'trial-welcome', email: 'not-an-email' })).status, 400, 'bad email');
  assert.equal(app.calls.sendTestEmail.calls, 0, 'never reached the sender');
});

test('email-test-send: the key gate rejects an unauthenticated request', async () => {
  app = await mountAdmin();
  const res = await fetch(app.baseUrl + '/api/admin/email-test-send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'trial-welcome', email: 'me@example.com' }),
  });
  assert.equal(res.status, 403);
  assert.equal(app.calls.sendTestEmail.calls, 0);
});

test('email-test-send: a sender failure surfaces its status', async () => {
  app = await mountAdmin({ testSendResult: { ok: false, status: 503, error: 'Email delivery is not configured on this server.' } });
  const res = await fetch(app.baseUrl + '/api/admin/email-test-send', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'trial-welcome', email: 'me@example.com' }),
  });
  assert.equal(res.status, 503);
});

// ---- Referral links (CRUD over a real store) ------------------------------

const jsonAuth = { ...auth, 'Content-Type': 'application/json' };
const createLink = (base, body) =>
  fetch(base + '/api/admin/referrals', { method: 'POST', headers: jsonAuth, body: JSON.stringify(body) });
const listLinks = async (base) =>
  (await (await fetch(base + '/api/admin/referrals', { headers: auth })).json()).links;

test('every referral endpoint requires the access key', async () => {
  app = await mountAdmin();
  const calls = [
    ['GET', '/api/admin/referrals'],
    ['POST', '/api/admin/referrals'],
    ['POST', '/api/admin/referrals/columbia/deactivate'],
    ['POST', '/api/admin/referrals/columbia/activate'],
    ['DELETE', '/api/admin/referrals/columbia'],
  ];
  for (const [method, url] of calls) {
    const res = await fetch(app.baseUrl + url, { method });
    assert.equal(res.status, 403, `${method} ${url} should reject without a key`);
  }
});

test('creating a link returns it and makes it listable', async () => {
  app = await mountAdmin();
  const res = await createLink(app.baseUrl, { slug: 'columbia', label: 'Columbia University', note: 'Campus outreach' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.link.slug, 'columbia');
  assert.equal(body.link.path, '/columbia');
  assert.equal(body.link.active, true);

  const links = await listLinks(app.baseUrl);
  assert.equal(links.length, 1);
  assert.equal(links[0].clicks, 0);
  assert.equal(links[0].series.length, 30, 'a chart series comes back even with no clicks');
});

test('a bad slug is a 400 and a taken or reserved one is a 409', async () => {
  app = await mountAdmin();
  await createLink(app.baseUrl, { slug: 'columbia', label: 'Columbia' });

  const malformed = await createLink(app.baseUrl, { slug: 'not a slug', label: 'X' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).code, 'SLUG_INVALID');

  const noLabel = await createLink(app.baseUrl, { slug: 'nyu', label: '' });
  assert.equal(noLabel.status, 400);

  const dupe = await createLink(app.baseUrl, { slug: 'columbia', label: 'Again' });
  assert.equal(dupe.status, 409, 'a name already in use is a conflict, not a malformed request');

  const reserved = await createLink(app.baseUrl, { slug: 'admin', label: 'Nope' });
  assert.equal(reserved.status, 409);
  assert.equal((await reserved.json()).code, 'SLUG_RESERVED');
});

test('deactivate keeps the link listed, delete removes it', async () => {
  app = await mountAdmin();
  await createLink(app.baseUrl, { slug: 'columbia', label: 'Columbia' });
  app.referrals.recordHit({ slug: 'columbia', userAgent: 'Mozilla/5.0 Chrome/126.0 Safari/537.36' });

  const off = await fetch(app.baseUrl + '/api/admin/referrals/columbia/deactivate', { method: 'POST', headers: auth });
  assert.equal(off.status, 200);
  assert.equal((await off.json()).link.active, false);

  let links = await listLinks(app.baseUrl);
  assert.equal(links.length, 1, 'still on the dashboard');
  assert.equal(links[0].active, false);
  assert.equal(links[0].clicks, 1, 'with its history');

  const on = await fetch(app.baseUrl + '/api/admin/referrals/columbia/activate', { method: 'POST', headers: auth });
  assert.equal((await on.json()).link.active, true, 'and it can be restored');

  const gone = await fetch(app.baseUrl + '/api/admin/referrals/columbia', { method: 'DELETE', headers: auth });
  assert.equal(gone.status, 200);
  assert.equal((await gone.json()).hitsDeleted, 1, 'the caller is told what it destroyed');
  links = await listLinks(app.baseUrl);
  assert.deepEqual(links, []);
});

test('acting on a link that does not exist is a 404', async () => {
  app = await mountAdmin();
  for (const [method, url] of [
    ['POST', '/api/admin/referrals/ghost/deactivate'],
    ['POST', '/api/admin/referrals/ghost/activate'],
    ['DELETE', '/api/admin/referrals/ghost'],
  ]) {
    const res = await fetch(app.baseUrl + url, { method, headers: auth });
    assert.equal(res.status, 404, `${method} ${url}`);
  }
});

test('referrals clamps ?days= instead of passing it through', async () => {
  // `days` sizes a chart AND decides how many rows the query walks, so an
  // unbounded value would be a scan the caller picks.
  app = await mountAdmin();
  await createLink(app.baseUrl, { slug: 'columbia', label: 'Columbia' });
  for (const [given, expected] of [['1', 7], ['90', 90], ['9999', 365], ['abc', 30], ['-5', 7]]) {
    const res = await fetch(app.baseUrl + `/api/admin/referrals?days=${given}`, { headers: auth });
    const body = await res.json();
    assert.equal(body.days, expected, `days=${given} → ${expected}`);
    assert.equal(body.links[0].series.length, expected, 'and the series actually follows it');
  }
});

test('referrals fails loudly when the store is not wired up', async () => {
  app = await mountAdmin({ withReferrals: false });
  for (const [method, url] of [
    ['GET', '/api/admin/referrals'],
    ['POST', '/api/admin/referrals'],
    ['DELETE', '/api/admin/referrals/columbia'],
  ]) {
    const res = await fetch(app.baseUrl + url, { method, headers: jsonAuth, body: method === 'POST' ? '{}' : undefined });
    assert.equal(res.status, 500, `${method} ${url} — a silent empty list would read as "no clicks yet"`);
  }
});

// ---- CSV log downloads ----------------------------------------------------

test('a present CSV log is served, a missing one → 404', async () => {
  app = await mountAdmin({ dataLogFiles: { 'prompt_logs.csv': 'a,b\n1,2\n' } });
  const present = await fetch(app.baseUrl + '/promptlogs', { headers: auth });
  assert.equal(present.status, 200);
  assert.match(await present.text(), /a,b/);

  const missing = await fetch(app.baseUrl + '/contactlogs', { headers: auth }); // never seeded
  assert.equal(missing.status, 404);
});

test('the rejection log is downloadable, and its absence is a plain 404', async () => {
  // The dashboard now loads this feed on every sign-in, so it has to behave like
  // the other CSV exports. Its 404 is the ordinary state of a deploy that has
  // never refused a request — the loader swallows it deliberately, which only
  // works if the route answers 404 rather than throwing.
  app = await mountAdmin({});
  const missing = await fetch(app.baseUrl + '/rejectionlogs', { headers: auth });
  assert.equal(missing.status, 404);

  await app.close();
  app = await mountAdmin({ dataLogFiles: { 'rejection_logs.csv': 'timestamp,kind,code\n2026-06-01T00:00:00Z,daily_limit,DAILY_LIMIT_REACHED\n' } });
  const present = await fetch(app.baseUrl + '/rejectionlogs', { headers: auth });
  assert.equal(present.status, 200);
  assert.match(await present.text(), /daily_limit/);
});

// ---- Session revocation ---------------------------------------------------

test('revoke-sessions signs one account out and reports how many were dropped', async () => {
  app = await mountAdmin({ revokeSessionsResult: { ok: true, userId: 'u_9', email: 'sam@example.com', revoked: 3 } });
  const res = await fetch(app.baseUrl + '/api/admin/revoke-sessions', {
    method: 'POST', headers: jsonAuth, body: JSON.stringify({ userId: 'u_9' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  // The count is the payload, not a nicety: revoking zero sessions is a real
  // outcome and the operator cannot tell it from success without this number.
  assert.deepEqual(body, { ok: true, userId: 'u_9', email: 'sam@example.com', revoked: 3 });
  assert.equal(app.calls.revokeUserSessions.calls, 1);
});

test('revoke-sessions reports zero as zero rather than as a bare success', async () => {
  app = await mountAdmin({ revokeSessionsResult: { ok: true, userId: 'u_9', email: 'sam@example.com', revoked: 0 } });
  const res = await fetch(app.baseUrl + '/api/admin/revoke-sessions', {
    method: 'POST', headers: jsonAuth, body: JSON.stringify({ userId: 'u_9' }),
  });
  assert.equal((await res.json()).revoked, 0);
});

test('revoke-sessions needs a userId, and an unknown account is a 404', async () => {
  app = await mountAdmin({});
  const noId = await fetch(app.baseUrl + '/api/admin/revoke-sessions', {
    method: 'POST', headers: jsonAuth, body: '{}',
  });
  assert.equal(noId.status, 400);
  assert.equal(app.calls.revokeUserSessions.calls, 0, 'a bodyless call never reaches the store');

  await app.close();
  app = await mountAdmin({ revokeSessionsResult: { ok: false, error: 'No such user', code: 'NOT_FOUND' } });
  const missing = await fetch(app.baseUrl + '/api/admin/revoke-sessions', {
    method: 'POST', headers: jsonAuth, body: JSON.stringify({ userId: 'nope' }),
  });
  assert.equal(missing.status, 404, 'NOT_FOUND maps to 404, not to a generic 400');
  assert.equal((await missing.json()).code, 'NOT_FOUND');
});

test('revoke-sessions is guarded, and an unauthenticated body is never parsed', async () => {
  app = await mountAdmin({});
  const res = await fetch(app.baseUrl + '/api/admin/revoke-sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'u_9' }),
  });
  assert.equal(res.status, 403);
  assert.equal(app.calls.revokeUserSessions.calls, 0, 'the guard runs before the handler, and before express.json()');
});
