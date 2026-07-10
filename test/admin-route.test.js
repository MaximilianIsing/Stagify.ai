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
import { mountAdmin, ADMIN_KEY } from './helpers/admin-app.js';

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

test('authstore download serves the store snapshot as a JSON attachment', async () => {
  app = await mountAdmin();
  const res = await fetch(app.baseUrl + '/authstore', { headers: auth });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') || '', /auth-store\.json/);
  assert.deepEqual(await res.json(), { users: [], sessions: [] });
  assert.equal(app.calls.authExport.calls, 1, 'a live snapshot is rebuilt');
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
  const res = await fetch(app.baseUrl + '/resetmemories', { headers: auth });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).success, true);
  assert.equal(app.calls.resetAllMemories.calls, 1);
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

// ---- CSV log downloads ----------------------------------------------------

test('a present CSV log is served, a missing one → 404', async () => {
  app = await mountAdmin({ dataLogFiles: { 'prompt_logs.csv': 'a,b\n1,2\n' } });
  const present = await fetch(app.baseUrl + '/promptlogs', { headers: auth });
  assert.equal(present.status, 200);
  assert.match(await present.text(), /a,b/);

  const missing = await fetch(app.baseUrl + '/contactlogs', { headers: auth }); // never seeded
  assert.equal(missing.status, 404);
});
