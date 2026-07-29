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

// ---- Referral link stats --------------------------------------------------

test('referrals requires the key and returns the per-link rollup', async () => {
  app = await mountAdmin();
  const noKey = await fetch(app.baseUrl + '/api/admin/referrals');
  assert.equal(noKey.status, 403);

  const res = await fetch(app.baseUrl + '/api/admin/referrals', { headers: auth });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.days, 30, 'the default window');
  assert.equal(body.links[0].slug, 'columbia');
  assert.deepEqual(app.calls.referralSummary.lastArgs, [{ days: 30 }]);
});

test('referrals clamps ?days= instead of passing it through', async () => {
  // `days` sizes a chart AND decides how many rows the query walks, so an
  // unbounded value would be a scan the caller picks.
  app = await mountAdmin();
  for (const [given, expected] of [['1', 7], ['90', 90], ['9999', 365], ['abc', 30], ['-5', 7]]) {
    const res = await fetch(app.baseUrl + `/api/admin/referrals?days=${given}`, { headers: auth });
    assert.equal((await res.json()).days, expected, `days=${given} → ${expected}`);
  }
});

test('referrals fails loudly when the store is not wired up', async () => {
  app = await mountAdmin({ referralSummary: null });
  const res = await fetch(app.baseUrl + '/api/admin/referrals', { headers: auth });
  assert.equal(res.status, 500, 'a silent empty list would read as "no clicks yet"');
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
