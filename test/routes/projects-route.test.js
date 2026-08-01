// Tier: route contract (fake store, fake AI) — the listing-staging API in routes/projects.js.
//
// WHAT THIS COVERS, AND WHY THESE THINGS
// The router is the whole security boundary of the listing feature: it is Stagify+ only,
// it re-keys every lookup on the validated session user, and one of its routes serves raw
// image bytes. So the load-bearing tests here are:
//
//   * The gate is IN THE HANDLER, not the middleware chain. Reading the chain tells you
//     nothing, so every route is asserted to 401 without a session — including the ones
//     that take a path parameter, which would otherwise be reachable.
//   * Cross-user isolation answers 404, NOT 403, on all five resources: project, photo,
//     render, render BYTES, and source-photo BYTES. 403 would confirm the id exists,
//     turning the API into an enumeration oracle for other people's listings. The two byte
//     routes are asserted separately because they are the ones that actually leak pixels —
//     and the source photo is the more sensitive of the two (it is someone's real,
//     unstaged house, not a generated image).
//   * Everything a user can type is clamped (title/address length, ?limit, variationCount)
//     and an unknown enum value is a 400, not a store-level constraint violation (a 500).
//   * /stage refuses rather than double-billing: no photos, no room assignments, or a
//     queue that is still draining.
//   * DELETE removes the ROWS BEFORE the blobs. Reversed, a failed unlink leaves the user
//     looking at a listing whose images are already gone. The order is asserted with a
//     call log, because that is the only way an ordering contract can be pinned.
//
// The store and blob storage are in-memory fakes (test/helpers/projects-app.js); the SQL
// itself is covered by test/data/projects.test.js.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountProjects, seedProject, seedRoom, finishRender, createFakeStorage, PNG_1X1 } from '../helpers/projects-app.js';
import { MAX_PHOTO_BYTES, UNSUPPORTED_PHOTO_CODE } from '../../routes/projects.js';
import { crc32 } from '../../routes/projects-download.js';
import { DISCLOSURE_ENTRY_NAME, STAGING_DISCLOSURE_ARCHIVE } from '../../lib/staging/staging-disclosure.js';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { CANCELLED_CODE } from '../../routes/projects-queue.js';
import { OTHER_ROOM_TYPE } from '../../lib/staging/room-clustering.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const USER_A = { id: 'u_a', email: 'a@example.com', plan: 'pro' };
const USER_B = { id: 'u_b', email: 'b@example.com', plan: 'pro' };

let app;
afterEach(async () => { if (app) { await app.close(); app = null; } });

const call = (base, path_, { method = 'GET', body, headers = {} } = {}) =>
  fetch(`${base}${path_}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const stage = (base, projectId, body = {}) => call(base, `/api/projects/${projectId}/stage`, { method: 'POST', body });

/**
 * Drain the queue exactly as lib/staging/listing-worker.js does: claim, finish, and — for a
 * hero — author the room's bible and attach it, which is the call that lifts the claim
 * barrier for that room's support frames.
 *
 * This is what makes the enqueue contract observable. "/stage answered 200" was true of the
 * wedged queue too; only draining shows whether anything can ever run.
 * @returns {any[]} The renders in the order a worker would have claimed them.
 */
function drainQueue(store, projectId, { max = 60, withBible = true } = {}) {
  const order = [];
  for (let i = 0; i < max; i += 1) {
    const claimed = store.claimNextRender({ now: Date.now() + i });
    if (!claimed) break;
    order.push(claimed);
    const photo = store.getPhoto(claimed.photoId);
    store.completeRender(claimed.id, { storageKey: `projects/${projectId}/out/${claimed.id}.webp` });
    if (photo?.frameRole === 'hero' && withBible) {
      const bible = store.createBible({ projectId, roomKey: photo.roomKey, heroRenderId: claimed.id, doc: { palette: 'warm' } });
      store.attachBibleToQueuedRenders(projectId, photo.roomKey, bible.id);
    }
  }
  return order;
}

// ── Auth gate ────────────────────────────────────────────────────────────────

test('every route 401s without a session (the gate lives in the handler, not the chain)', async () => {
  app = await mountProjects();
  const routes = [
    ['POST', '/api/projects'],
    ['GET', '/api/projects'],
    ['GET', '/api/projects/p_1'],
    ['PATCH', '/api/projects/p_1'],
    ['DELETE', '/api/projects/p_1'],
    ['POST', '/api/projects/p_1/photos'],
    ['PATCH', '/api/projects/p_1/photos/ph_1'],
    ['DELETE', '/api/projects/p_1/photos/ph_1'],
    ['POST', '/api/projects/p_1/stage'],
    ['GET', '/api/projects/p_1/progress'],
    ['POST', '/api/projects/p_1/rooms/living-room-1/bible/regenerate'],
    ['POST', '/api/projects/p_1/cancel'],
    ['POST', '/api/projects/p_1/renders/r_1/retry'],
    ['GET', '/api/projects/p_1/renders/r_1/image'],
    ['GET', '/api/projects/p_1/photos/ph_1/image'],
    // The archive is the only route that hands over MANY images at once, so an unguarded
    // one would be the single worst leak in the feature.
    ['GET', '/api/projects/p_1/renders.zip'],
  ];
  for (const [method, route] of routes) {
    const res = await call(app.baseUrl, route, { method, body: method === 'GET' ? undefined : {} });
    assert.equal(res.status, 401, `${method} ${route} must 401 unauthenticated`);
    assert.equal((await res.json()).code, 'AUTH_REQUIRED');
  }
});

test('the gate runs before any store work', async () => {
  // Otherwise an anonymous caller still costs a lookup, and the guard becomes
  // ordering-dependent rather than unconditional.
  app = await mountProjects();
  seedProject(app, { userId: USER_A.id });
  app.calls.length = 0;
  await call(app.baseUrl, '/api/projects', { method: 'POST', body: { title: 'x' } });
  assert.deepEqual(app.calls, [], 'no store method may run for an unauthenticated caller');
});

// ── Cross-user isolation ─────────────────────────────────────────────────────

test('user B gets 404 (never 403) for user A\'s project, photo, render AND render bytes', async () => {
  // 403 would confirm the id exists. All four are asserted because the byte route is the
  // one that actually hands over pixels, and it is easy to guard the JSON routes only.
  app = await mountProjects({ user: USER_B });
  const { project, photos } = seedProject(app, { userId: USER_A.id });
  const render = app.projects.enqueueRender({ projectId: project.id, photoId: photos[0].id });
  const key = `projects/${project.id}/out/${render.id}.webp`;
  app.storage.blobs.set(key, Buffer.from('secret-pixels'));
  render.storageKey = key;
  render.status = 'ok';

  const cases = [
    ['GET', `/api/projects/${project.id}`],
    ['PATCH', `/api/projects/${project.id}`],
    ['DELETE', `/api/projects/${project.id}`],
    ['GET', `/api/projects/${project.id}/progress`],
    ['POST', `/api/projects/${project.id}/stage`],
    ['PATCH', `/api/projects/${project.id}/photos/${photos[0].id}`],
    ['DELETE', `/api/projects/${project.id}/photos/${photos[0].id}`],
    ['POST', `/api/projects/${project.id}/rooms/living-room-1/bible/regenerate`],
    ['POST', `/api/projects/${project.id}/cancel`],
    ['POST', `/api/projects/${project.id}/renders/${render.id}/retry`],
    ['GET', `/api/projects/${project.id}/renders/${render.id}/image`],
    ['GET', `/api/projects/${project.id}/photos/${photos[0].id}/image`],
    ['GET', `/api/projects/${project.id}/renders.zip`],
  ];
  for (const [method, route] of cases) {
    const res = await call(app.baseUrl, route, { method, body: method === 'GET' ? undefined : { title: 'hijack' } });
    assert.equal(res.status, 404, `${method} ${route} must 404 for a non-owner`);
    assert.notEqual(res.status, 403, `${method} ${route} must not confirm the id exists`);
  }
  assert.equal(app.projects.getProject(project.id).title, 'Seed', 'nothing may be mutated');
  assert.equal(app.storage.blobs.get(key).toString(), 'secret-pixels', 'the blob must survive');
});

test('a photo or render belonging to another project of the SAME user is still 404', async () => {
  // Ownership is not enough: the row also has to belong to the project in the path, or
  // /projects/:mine/photos/:theirs would work by accident.
  app = await mountProjects({ user: USER_A });
  const one = seedProject(app, { userId: USER_A.id });
  const two = seedProject(app, { userId: USER_A.id });
  const res = await call(app.baseUrl, `/api/projects/${one.project.id}/photos/${two.photos[0].id}`, { method: 'PATCH', body: { roomType: 'Bedroom' } });
  assert.equal(res.status, 404);
  const render = app.projects.enqueueRender({ projectId: two.project.id, photoId: two.photos[0].id });
  render.storageKey = 'projects/x/out/y.webp';
  app.storage.blobs.set(render.storageKey, Buffer.from('bytes'));
  const bytes = await call(app.baseUrl, `/api/projects/${one.project.id}/renders/${render.id}/image`);
  assert.equal(bytes.status, 404);
});

test('user B cannot see user A\'s listings in the collection', async () => {
  app = await mountProjects({ user: USER_B });
  seedProject(app, { userId: USER_A.id });
  const body = await (await call(app.baseUrl, '/api/projects')).json();
  assert.deepEqual(body.projects, []);
});

// ── Create / list / patch ────────────────────────────────────────────────────

test('POST /api/projects clamps the title to 120 and the address to 200 chars', async () => {
  app = await mountProjects({ user: USER_A });
  const body = await (await call(app.baseUrl, '/api/projects', {
    method: 'POST',
    body: { title: 'T'.repeat(500), address: 'A'.repeat(500) },
  })).json();
  assert.equal(body.project.title.length, 120);
  assert.equal(body.project.address.length, 200);
  assert.equal(body.project.userId, USER_A.id, 'ownership comes from the session, not the body');
});

test('POST /api/projects ignores a userId in the body (no IDOR via req.body)', async () => {
  app = await mountProjects({ user: USER_A });
  const body = await (await call(app.baseUrl, '/api/projects', { method: 'POST', body: { title: 'x', userId: USER_B.id } })).json();
  assert.equal(body.project.userId, USER_A.id);
});

test('POST /api/projects falls back to a default title', async () => {
  app = await mountProjects({ user: USER_A });
  const body = await (await call(app.baseUrl, '/api/projects', { method: 'POST', body: {} })).json();
  assert.equal(body.project.title, 'Untitled listing');
});

test('GET /api/projects clamps ?limit to 1–100 and defaults to 50', async () => {
  /** @type {any[]} */
  const seen = [];
  app = await mountProjects({ user: USER_A });
  const real = app.projects.listProjects;
  app.deps.projects.listProjects = (userId, opts) => { seen.push(opts); return real(userId, opts); };
  for (const q of ['', '?limit=0', '?limit=1000', '?limit=abc', '?limit=7']) {
    await call(app.baseUrl, `/api/projects${q}`);
  }
  assert.deepEqual(seen.map((o) => o.limit), [50, 1, 100, 50, 7]);
});

test('PATCH /api/projects/:id rejects an unknown status with 400 and changes nothing', async () => {
  app = await mountProjects({ user: USER_A });
  const { project } = seedProject(app, { userId: USER_A.id });
  const res = await call(app.baseUrl, `/api/projects/${project.id}`, { method: 'PATCH', body: { status: 'deleted' } });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'BAD_STATUS');
  assert.equal(app.projects.getProject(project.id).status, 'draft');
});

test('PATCH /api/projects/:id accepts each valid status and clamps the text fields', async () => {
  app = await mountProjects({ user: USER_A });
  const { project } = seedProject(app, { userId: USER_A.id });
  for (const status of ['draft', 'staging', 'ready', 'archived']) {
    const res = await call(app.baseUrl, `/api/projects/${project.id}`, { method: 'PATCH', body: { status } });
    assert.equal(res.status, 200, `${status} must be accepted`);
    assert.equal(app.projects.getProject(project.id).status, status);
  }
  await call(app.baseUrl, `/api/projects/${project.id}`, { method: 'PATCH', body: { title: 'T'.repeat(300) } });
  assert.equal(app.projects.getProject(project.id).title.length, 120);
});

test('PATCH /api/projects/:id with no recognised field is a 400, not a silent no-op', async () => {
  app = await mountProjects({ user: USER_A });
  const { project } = seedProject(app, { userId: USER_A.id });
  const res = await call(app.baseUrl, `/api/projects/${project.id}`, { method: 'PATCH', body: { nonsense: 1 } });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'EMPTY_PATCH');
});

test('GET /api/projects/:id returns the full listing bundle without any image data', async () => {
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id });
  const render = app.projects.enqueueRender({ projectId: project.id, photoId: photos[0].id });
  render.storageKey = `projects/${project.id}/out/${render.id}.webp`;
  const body = await (await call(app.baseUrl, `/api/projects/${project.id}`)).json();
  assert.equal(body.project.id, project.id);
  assert.equal(body.photos.length, 2);
  assert.equal(body.renders.length, 1);
  assert.ok(body.progress);
  // A 30-photo listing at 3 variations would be hundreds of MB as data URLs.
  assert.ok(!JSON.stringify(body).includes('data:image/'), 'no endpoint may return image data URLs');
});

// ── Delete ordering ──────────────────────────────────────────────────────────

test('DELETE /api/projects/:id deletes the DB rows BEFORE the blobs', async () => {
  app = await mountProjects({ user: USER_A });
  const { project } = seedProject(app, { userId: USER_A.id });
  app.calls.length = 0;
  const res = await call(app.baseUrl, `/api/projects/${project.id}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const dbAt = app.calls.indexOf('projects.deleteProject');
  const blobAt = app.calls.indexOf('storage.removeProject');
  assert.ok(dbAt >= 0 && blobAt >= 0, `both calls must happen: ${app.calls.join(', ')}`);
  assert.ok(dbAt < blobAt, `rows must go first, got: ${app.calls.join(', ')}`);
  assert.equal(app.projects.getProject(project.id), null);
});

test('DELETE photo removes the row first, then every orphaned blob (source AND renders)', async () => {
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id });
  const render = app.projects.enqueueRender({ projectId: project.id, photoId: photos[0].id });
  render.storageKey = `projects/${project.id}/out/${render.id}.webp`;
  app.storage.blobs.set(render.storageKey, Buffer.from('render'));
  app.calls.length = 0;
  const body = await (await call(app.baseUrl, `/api/projects/${project.id}/photos/${photos[0].id}`, { method: 'DELETE' })).json();
  assert.equal(body.blobs, 2, 'the render blob must be unlinked too, not just the source');
  assert.ok(app.calls.indexOf('projects.deletePhoto') < app.calls.indexOf('storage.remove'));
  assert.equal(app.storage.blobs.has(render.storageKey), false);
});

// ── Photo override ───────────────────────────────────────────────────────────

test('PATCH photo routes frameRole=hero through setHero (demoting the old hero)', async () => {
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id });
  assert.equal(photos[0].frameRole, 'hero');
  const res = await call(app.baseUrl, `/api/projects/${project.id}/photos/${photos[1].id}`, { method: 'PATCH', body: { frameRole: 'hero' } });
  assert.equal(res.status, 200);
  assert.ok(app.calls.includes('projects.setHero'), 'a plain updatePhoto would not demote the old hero');
  assert.equal(app.projects.getPhoto(photos[1].id).frameRole, 'hero');
  assert.equal(app.projects.getPhoto(photos[0].id).frameRole, 'support');
});

test('PATCH photo rejects an unknown frameRole with 400', async () => {
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id });
  const res = await call(app.baseUrl, `/api/projects/${project.id}/photos/${photos[0].id}`, { method: 'PATCH', body: { frameRole: 'primary' } });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'BAD_FRAME_ROLE');
});

test('PATCH photo clamps seq and applies roomKey/roomType/excluded', async () => {
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id });
  await call(app.baseUrl, `/api/projects/${project.id}/photos/${photos[1].id}`, {
    method: 'PATCH',
    body: { roomKey: 'bedroom-2', roomType: 'Bedroom', seq: 99999999, frameRole: 'excluded' },
  });
  const row = app.projects.getPhoto(photos[1].id);
  assert.equal(row.roomKey, 'bedroom-2');
  assert.equal(row.roomType, 'Bedroom');
  assert.equal(row.seq, 10000, 'seq is clamped to the ceiling');
  assert.equal(row.frameRole, 'excluded');
});

test('PATCH photo refuses to promote a hero with no room assigned', async () => {
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id, roomKey: null });
  const res = await call(app.baseUrl, `/api/projects/${project.id}/photos/${photos[0].id}`, { method: 'PATCH', body: { frameRole: 'hero' } });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'NO_ROOM_KEY');
});

// ── Photo upload ─────────────────────────────────────────────────────────────

const postPhotos = (base, projectId, files) => {
  const form = new FormData();
  for (const [i, buf] of files.entries()) form.append('photos', new File([buf], `p${i}.png`, { type: 'image/png' }), `p${i}.png`);
  return fetch(`${base}/api/projects/${projectId}/photos`, { method: 'POST', body: form });
};

test('POST photos stores, labels, groups, and picks a hero — reporting duplicates', async () => {
  app = await mountProjects({ user: USER_A });
  const project = app.projects.createProject({ userId: USER_A.id, title: 'Upload' });
  // The SAME bytes twice: identical sha256, so the second is a duplicate by content.
  const body = await (await postPhotos(app.baseUrl, project.id, [PNG_1X1, PNG_1X1])).json();
  assert.equal(body.photos.length, 1, 'a re-upload of identical bytes must not create a second row');
  assert.equal(body.duplicates, 1);
  assert.equal(body.photos[0].roomKey, 'living-room-1');
  assert.equal(body.photos[0].roomType, 'Living room');
  assert.equal(body.photos[0].frameRole, 'hero');
  assert.equal(body.photos[0].stageable, true);
  assert.equal(body.photos[0].width, 1, 'dimensions come from sharp, not the client');
});

// ── Source normalization ─────────────────────────────────────────────────────
// Source photos were 82–85% of the data volume's footprint, stored at up to 25 MB each —
// while `processStaging` downscales its input to 1920x1080 anyway, so none of that
// resolution ever reached the model. The volume also holds SQLite's WAL, so filling it took
// auth and Stripe webhooks down with the renders.

test('an oversized upload is stored downscaled, not as sent', async () => {
  app = await mountProjects({ user: USER_A });
  const project = app.projects.createProject({ userId: USER_A.id, title: 'Upload' });
  // A real 4000x3000 JPEG, which is an ordinary phone photo and far past what staging uses.
  const huge = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 120, g: 140, b: 160 } } })
    .jpeg({ quality: 92 })
    .toBuffer();

  const body = await (await postPhotos(app.baseUrl, project.id, [huge])).json();
  const [photo] = body.photos;
  assert.ok(photo, 'the photo is still accepted');

  const stored = app.storage.blobs.get(photo.storageKey);
  assert.ok(stored, 'and something was written');
  const meta = await sharp(stored).metadata();
  assert.ok(meta.width <= 1920 && meta.height <= 1080,
    `stored at ${meta.width}x${meta.height}; the model never sees more than 1920x1080`);
  assert.ok(stored.length < huge.length, 'and it is smaller on disk than what arrived');
});

test('the stored dimensions describe the stored bytes, not the ones that arrived', async () => {
  // The studio and the share gallery set width/height attributes from these to reserve
  // layout space. Recording the ORIGINAL dimensions against a downscaled file is a
  // guaranteed layout shift on every gallery the broker sends a client.
  app = await mountProjects({ user: USER_A });
  const project = app.projects.createProject({ userId: USER_A.id, title: 'Upload' });
  const huge = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .jpeg()
    .toBuffer();

  const body = await (await postPhotos(app.baseUrl, project.id, [huge])).json();
  const [photo] = body.photos;
  const meta = await sharp(app.storage.blobs.get(photo.storageKey)).metadata();
  assert.equal(photo.width, meta.width);
  assert.equal(photo.height, meta.height);
  assert.notEqual(photo.width, 4000, 'not the dimensions of what was sent');
});

test('a normalized PNG is stored under a .jpg key, so the byte route serves the right type', async () => {
  // downscaleImage re-encodes to JPEG. A `.png` key holding JPEG bytes would be served as
  // image/png, and with `nosniff` the browser simply refuses to render the operator's photo.
  app = await mountProjects({ user: USER_A });
  const project = app.projects.createProject({ userId: USER_A.id, title: 'Upload' });
  const png = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .png()
    .toBuffer();

  const body = await (await postPhotos(app.baseUrl, project.id, [png])).json();
  const [photo] = body.photos;
  assert.match(photo.storageKey, /\.jpg$/, 'the key must describe the bytes actually written');
  const meta = await sharp(app.storage.blobs.get(photo.storageKey)).metadata();
  assert.equal(meta.format, 'jpeg');
});

test('the dedup hash identifies what the CLIENT SENT, not what we chose to store', async () => {
  // Asserted directly against the sha of the sent bytes, because "re-uploading the same file
  // dedups" does NOT distinguish the two: `downscaleImage` is deterministic, so hashing the
  // normalized output would dedup identically today. The property matters anyway — the day a
  // sharp upgrade changes JPEG encoding by a byte, a normalized-bytes hash would stop
  // matching every row already stored and re-bill the operator for photographs they have
  // already staged. Mutation testing caught the weaker version of this test.
  app = await mountProjects({ user: USER_A });
  const project = app.projects.createProject({ userId: USER_A.id, title: 'Upload' });
  const shot = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 9, g: 9, b: 9 } } })
    .jpeg()
    .toBuffer();
  const sentSha = createHash('sha256').update(shot).digest('hex');

  const first = await (await postPhotos(app.baseUrl, project.id, [shot])).json();
  assert.equal(first.photos.length, 1);
  assert.equal(first.photos[0].sha256, sentSha, 'the row records the hash of the sent bytes');
  const storedSha = createHash('sha256').update(app.storage.blobs.get(first.photos[0].storageKey)).digest('hex');
  assert.notEqual(storedSha, sentSha, 'precondition: what we stored is NOT what was sent');

  const again = await (await postPhotos(app.baseUrl, project.id, [shot])).json();
  assert.equal(again.duplicates, 1, 'and re-dragging the same folder still dedups');
  assert.equal(again.photos.length, 1);
});

test('a photo sharp cannot process is stored as sent rather than dropped', async () => {
  // Fail open: the operator's upload is worth more than the bytes saved.
  app = await mountProjects({ user: USER_A });
  const project = app.projects.createProject({ userId: USER_A.id, title: 'Upload' });
  const notReallyAnImage = Buffer.from('\xff\xd8\xff\xe0 not actually a jpeg', 'binary');

  const res = await postPhotos(app.baseUrl, project.id, [notReallyAnImage]);
  assert.equal(res.status, 200, 'the upload still succeeds');
  const body = await res.json();
  assert.equal(body.photos.length, 1, 'and the photo is kept');
  assert.deepEqual(app.storage.blobs.get(body.photos[0].storageKey), notReallyAnImage,
    'stored byte-for-byte as it arrived');
});

test('POST photos records the upload-gate rejection code without dropping the photo', async () => {
  app = await mountProjects({
    user: USER_A,
    validateStageableImage: async () => ({ valid: false, code: 'FOOD', reason: 'Not a room.' }),
  });
  const project = app.projects.createProject({ userId: USER_A.id, title: 'Upload' });
  const body = await (await postPhotos(app.baseUrl, project.id, [PNG_1X1])).json();
  assert.equal(body.photos[0].stageable, false);
  assert.equal(body.photos[0].unstageableCode, 'FOOD');
});

test('POST photos fails OPEN when the stageability check throws', async () => {
  app = await mountProjects({
    user: USER_A,
    validateStageableImage: async () => { throw new Error('grader exploded'); },
  });
  const project = app.projects.createProject({ userId: USER_A.id, title: 'Upload' });
  const body = await (await postPhotos(app.baseUrl, project.id, [PNG_1X1])).json();
  assert.equal(body.photos[0].stageable, true, 'a flaky reviewer must not block a real listing');
});

test('POST photos leaves a photo unassigned when the labeller fails, and never guesses a room', async () => {
  app = await mountProjects({
    user: USER_A,
    roomClustering: { labelPhoto: async () => null },
  });
  const project = app.projects.createProject({ userId: USER_A.id, title: 'Upload' });
  const body = await (await postPhotos(app.baseUrl, project.id, [PNG_1X1])).json();
  assert.equal(body.photos[0].roomKey, null);
});

test('POST photos never runs more than 3 vision calls concurrently', async () => {
  let inFlight = 0;
  let peak = 0;
  app = await mountProjects({
    user: USER_A,
    roomClustering: {
      labelPhoto: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { roomType: 'Living room', roomLabel: 'main', isWide: true, confidence: 1 };
      },
    },
  });
  const project = app.projects.createProject({ userId: USER_A.id, title: 'Upload' });
  // Ten distinct payloads → ten distinct hashes → ten rows to label.
  const files = Array.from({ length: 10 }, (_, i) => Buffer.concat([PNG_1X1, Buffer.from(`#${i}`)]));
  await postPhotos(app.baseUrl, project.id, files);
  assert.ok(peak <= 3, `bounded to 3 concurrent vision calls, saw ${peak}`);
  assert.ok(peak > 1, 'and it must actually be concurrent, not serial');
});

test('POST photos with no files is a 400', async () => {
  app = await mountProjects({ user: USER_A });
  const project = app.projects.createProject({ userId: USER_A.id, title: 'Upload' });
  const res = await fetch(`${app.baseUrl}/api/projects/${project.id}/photos`, { method: 'POST', body: new FormData() });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'NO_PHOTOS');
});

test('an anonymous batch upload is refused BEFORE multer buffers the body', async () => {
  // THE POINT IS THE ORDER, not the 401 — the 401 was always there, inside the handler, by
  // which time multer had already read the whole multipart body into memory. At the declared
  // ceilings that is 40 x 25 MB, about a gigabyte, on a deliberately single-instance process,
  // for a request that was never going to be allowed. `genLimiter` bounds the RATE of those,
  // not the cost of one, so it is not the answer.
  //
  // Observed through the file stream: if multer ran, it would consume the parts. A body the
  // server never reads leaves the upload stream unconsumed, so counting the bytes the CLIENT
  // managed to hand over is the observable that distinguishes the two orderings.
  // THE DISCRIMINATOR: send a file OVER the per-photo limit, anonymously. Whichever
  // middleware runs first decides the answer, so the status code tells us the order —
  //   multer first  -> it reads the body, trips LIMIT_FILE_SIZE, and answers 413;
  //   the gate first -> nothing is read at all, and the answer is 401.
  // A same-sized legal upload would answer 401 either way and prove nothing.
  app = await mountProjects({ user: null });
  const project = app.projects.createProject({ userId: USER_A.id, title: 'Upload' });

  const oversized = Buffer.alloc(MAX_PHOTO_BYTES + 1024, 7);
  const form = new FormData();
  form.append('photos', new File([oversized], 'a.jpg', { type: 'image/jpeg' }), 'a.jpg');

  const res = await fetch(`${app.baseUrl}/api/projects/${project.id}/photos`, { method: 'POST', body: form });
  assert.equal(res.status, 401, 'the gate answered, so multer never read the body');
  assert.equal((await res.json()).code, 'AUTH_REQUIRED');
  assert.notEqual(res.status, 413, 'a 413 would mean multer buffered it before anyone asked who this was');
  assert.equal(app.projects.db.photos.length, 0, 'and nothing is stored');
});

test('the pre-filter does not replace the in-handler check', async () => {
  // The middleware is a pre-filter, not a new auth model. If someone deletes the handler's
  // own `requireProAccount` because "the middleware covers it", this fails: the route is then
  // one middleware-ordering mistake from being open, and the file's stated invariant is false.
  const source = fs.readFileSync(path.join(ROOT, 'routes', 'projects.js'), 'utf8');
  const handler = source.slice(source.indexOf("router.post('/api/projects/:id/photos'"));
  const body = handler.slice(0, handler.indexOf('router.patch('));
  // Strip comments first — this file explains the very thing being searched for, so a naive
  // scan would pass with the call deleted.
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /requireProUpload/, 'the pre-filter must be in the chain');
  assert.match(code, /const user = requireProAccount\(req, res\)/,
    'AND the handler must still check for itself');
});

test('POST photos refuses a non-image mimetype with a code, not a 500', async () => {
  // This test used to ASSERT the 500 — it pinned the bug rather than the behaviour. multer
  // forwards a fileFilter rejection as whatever object the callback was given, NOT as a
  // MulterError, so a plain Error sailed past the router's instanceof branch and reached the
  // app catch-all. A refusal that is working exactly as designed answered "server error",
  // gave the client no code to act on, and filed a Sentry report every time.
  app = await mountProjects({ user: USER_A });
  const project = app.projects.createProject({ userId: USER_A.id, title: 'Upload' });
  const form = new FormData();
  form.append('photos', new File([Buffer.from('%PDF-')], 'x.pdf', { type: 'application/pdf' }), 'x.pdf');
  const res = await fetch(`${app.baseUrl}/api/projects/${project.id}/photos`, { method: 'POST', body: form });
  assert.equal(res.status, 415, 'an unsupported media type, which is what this is');
  const body = await res.json();
  assert.equal(body.code, UNSUPPORTED_PHOTO_CODE);
  assert.match(body.details, /PNG|JPG|WebP/i, 'and it names what IS accepted');
  assert.equal(app.projects.db.photos.length, 0, 'and nothing is stored');
});

// ── /stage ───────────────────────────────────────────────────────────────────

test('/stage 409s with no photos', async () => {
  app = await mountProjects({ user: USER_A });
  const project = app.projects.createProject({ userId: USER_A.id, title: 'Empty' });
  const res = await call(app.baseUrl, `/api/projects/${project.id}/stage`, { method: 'POST', body: {} });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'NO_PHOTOS');
});

test('/stage 409s when the photos have no room assignments', async () => {
  app = await mountProjects({ user: USER_A });
  const { project } = seedProject(app, { userId: USER_A.id, roomKey: null });
  const res = await call(app.baseUrl, `/api/projects/${project.id}/stage`, { method: 'POST', body: {} });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'NO_ROOM_ASSIGNMENTS');
});

test('/stage 409s when renders are already queued or running', async () => {
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id });
  const queued = app.projects.enqueueRender({ projectId: project.id, photoId: photos[0].id });
  const first = await call(app.baseUrl, `/api/projects/${project.id}/stage`, { method: 'POST', body: {} });
  assert.equal(first.status, 409);
  assert.equal((await first.json()).code, 'RENDERS_IN_FLIGHT');
  // 'running' is equally in-flight; 'ok' is not, so a finished listing can be re-staged.
  queued.status = 'running';
  assert.equal((await call(app.baseUrl, `/api/projects/${project.id}/stage`, { method: 'POST', body: {} })).status, 409);
  queued.status = 'ok';
  assert.equal((await call(app.baseUrl, `/api/projects/${project.id}/stage`, { method: 'POST', body: {} })).status, 200);
});

test('/stage enqueues the hero first, then variationCount support frames, all bible-less', async () => {
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id, photoCount: 3 });
  const body = await (await call(app.baseUrl, `/api/projects/${project.id}/stage`, { method: 'POST', body: { variationCount: 2 } })).json();
  // 1 hero + 2 support photos x 2 variations.
  assert.equal(body.queued, 5);
  const rows = app.projects.listRenders(project.id);
  assert.equal(rows[0].photoId, photos[0].id, 'the hero must be enqueued first (FIFO gives it the model first)');
  assert.equal(rows.filter((r) => r.photoId === photos[0].id).length, 1, 'the hero is always exactly 1 — it defines the bible');
  assert.ok(rows.every((r) => r.bibleId === null), 'support rows go in blocked; the bible attaches later');
});

test('/stage clamps variationCount to 1–3 and defaults to 1', async () => {
  for (const [sent, expectVariations] of [[undefined, 1], [0, 1], [99, 3], ['abc', 1], [3, 3]]) {
    app = await mountProjects({ user: USER_A });
    const { project } = seedProject(app, { userId: USER_A.id, photoCount: 2 });
    const body = await (await call(app.baseUrl, `/api/projects/${project.id}/stage`, { method: 'POST', body: { variationCount: sent } })).json();
    assert.equal(body.queued, 1 + expectVariations, `variationCount=${sent} → ${expectVariations} support variation(s)`);
    assert.equal(app.projects.getProject(project.id).extra.jobSettings.variationCount, expectVariations);
    await app.close();
    app = null;
  }
});

test('/stage persists jobSettings and flips the project to staging', async () => {
  app = await mountProjects({ user: USER_A });
  const { project } = seedProject(app, { userId: USER_A.id });
  await call(app.baseUrl, `/api/projects/${project.id}/stage`, {
    method: 'POST',
    body: { furnitureStyle: 'mid-century', removeFurniture: 'true', additionalPrompt: 'warm' },
  });
  const row = app.projects.getProject(project.id);
  assert.equal(row.status, 'staging');
  assert.deepEqual(row.extra.jobSettings, { furnitureStyle: 'mid-century', additionalPrompt: 'warm', removeFurniture: true, variationCount: 1 });
});

test('/stage never bills for an exterior, even one that clustered and passed the upload check', async () => {
  // EVERY real listing shoot has these — the front elevation, the backyard, the garage. The
  // clusterer labels them `Other`, and they used to be staged like rooms: money spent
  // putting furniture on a driveway, and then that room's bible extraction failing because
  // there was no furniture to pin. Note what the fixture asserts: the frames are `stageable`
  // and un-excluded, so every OTHER guard passes them.
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id, photoCount: 2, roomKey: 'living-room-1', roomType: 'Living room' });
  const exteriors = seedRoom(app, project, { photoCount: 2, roomKey: 'other-1', roomType: OTHER_ROOM_TYPE, stageable: true });

  const body = await (await call(app.baseUrl, `/api/projects/${project.id}/stage`, { method: 'POST', body: {} })).json();
  assert.equal(body.rooms, 1, 'only the interior room is planned');
  assert.equal(body.queued, 2, 'and only its two frames are billed');

  const staged = new Set(app.projects.listRenders(project.id).map((r) => r.photoId));
  for (const shot of exteriors) {
    assert.equal(staged.has(shot.id), false, `exterior ${shot.id} must not be enqueued`);
  }
  assert.equal(staged.has(photos[0].id), true, 'the interior still stages');
});

test('/stage answers a shoot of ALL exteriors with its own actionable code', async () => {
  // NO_STAGEABLE_PHOTOS would read as "your photography is unusable", which is both wrong
  // and unhelpful — nothing is wrong with these frames, they simply are not rooms, and one
  // dropdown each fixes it. The operator's next move is completely different, so the code is.
  app = await mountProjects({ user: USER_A });
  const { project } = seedProject(app, { userId: USER_A.id, photoCount: 3, roomKey: 'other-1', roomType: OTHER_ROOM_TYPE });
  const res = await call(app.baseUrl, `/api/projects/${project.id}/stage`, { method: 'POST', body: {} });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'NO_INTERIOR_ROOMS');
  assert.match(body.error, /room type/i, 'the message has to name the fix, not just the problem');
  assert.deepEqual(app.projects.listRenders(project.id), [], 'and nothing may be enqueued');
});

test('giving an exterior a real room type is the whole override', async () => {
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id, photoCount: 1, roomKey: 'other-1', roomType: OTHER_ROOM_TYPE });
  assert.equal((await call(app.baseUrl, `/api/projects/${project.id}/stage`, { method: 'POST', body: {} })).status, 409);

  // The room-type control the tray already shows on every thumbnail.
  const patched = await call(app.baseUrl, `/api/projects/${project.id}/photos/${photos[0].id}`, {
    method: 'PATCH', body: { roomType: 'Sunroom' },
  });
  assert.equal(patched.status, 200);

  const body = await (await call(app.baseUrl, `/api/projects/${project.id}/stage`, { method: 'POST', body: {} })).json();
  assert.equal(body.queued, 1, 'now it stages');
});

test('/stage skips frames the operator excluded', async () => {
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id, photoCount: 3 });
  app.projects.updatePhoto(photos[2].id, { frameRole: 'excluded' });
  const body = await (await call(app.baseUrl, `/api/projects/${project.id}/stage`, { method: 'POST', body: {} })).json();
  assert.equal(body.queued, 2, 'an excluded frame is kept in the shoot but never staged');
});

// ── Progress + regenerate ────────────────────────────────────────────────────

test('GET progress is no-store and reports the worker\'s blocked count honestly', async () => {
  app = await mountProjects({
    user: USER_A,
    listingWorker: { stats: () => ({ ticks: 9, completed: 4, failed: 1, blockedByMissingBible: 2 }) },
  });
  const { project, photos } = seedProject(app, { userId: USER_A.id });
  app.projects.enqueueRender({ projectId: project.id, photoId: photos[0].id });
  const res = await call(app.baseUrl, `/api/projects/${project.id}/progress`);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.progress.queued, 1);
  assert.equal(body.status, 'draft');
  assert.equal(body.blockedByMissingBible, 2, 'the API must not hide that consistency is unenforced');
});

test('bible regenerate supersedes the room\'s renders and re-enqueues it', async () => {
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id, photoCount: 2 });
  app.projects.updateProject(project.id, { extraJson: JSON.stringify({ jobSettings: { variationCount: 3 } }) });
  const old = app.projects.enqueueRender({ projectId: project.id, photoId: photos[0].id });
  old.status = 'ok';
  const body = await (await call(app.baseUrl, `/api/projects/${project.id}/rooms/living-room-1/bible/regenerate`, { method: 'POST', body: {} })).json();
  assert.equal(body.superseded, 1);
  assert.equal(body.queued, 4, 'hero + 1 support photo x the stored 3 variations');
  assert.equal(app.projects.getRender(old.id).status, 'superseded');
  assert.equal(app.projects.getProject(project.id).status, 'staging');
});

test('bible regenerate 404s for an unknown room key', async () => {
  app = await mountProjects({ user: USER_A });
  const { project } = seedProject(app, { userId: USER_A.id });
  const res = await call(app.baseUrl, `/api/projects/${project.id}/rooms/no-such-room/bible/regenerate`, { method: 'POST', body: {} });
  assert.equal(res.status, 404);
});

// ── Byte serve ───────────────────────────────────────────────────────────────

test('render bytes are served with nosniff and a private immutable cache policy', async () => {
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id });
  const render = app.projects.enqueueRender({ projectId: project.id, photoId: photos[0].id });
  render.storageKey = `projects/${project.id}/out/${render.id}.webp`;
  render.status = 'ok';
  app.storage.blobs.set(render.storageKey, Buffer.from('webp-bytes'));

  const res = await call(app.baseUrl, `/api/projects/${project.id}/renders/${render.id}/image`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/webp');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'webp-bytes');
});

test('render bytes: a PNG fallback is served as image/png, not mislabelled webp', async () => {
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id });
  const render = app.projects.enqueueRender({ projectId: project.id, photoId: photos[0].id });
  render.storageKey = `projects/${project.id}/out/${render.id}.png`;
  app.storage.blobs.set(render.storageKey, PNG_1X1);
  const res = await call(app.baseUrl, `/api/projects/${project.id}/renders/${render.id}/image`);
  assert.equal(res.headers.get('content-type'), 'image/png');
});

test('render bytes: a render with a null storageKey is 404, never 200', async () => {
  // Otherwise a queued render would answer 200 with an empty body, and the studio would
  // render a broken image instead of continuing to poll.
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id });
  const render = app.projects.enqueueRender({ projectId: project.id, photoId: photos[0].id });
  assert.equal(render.storageKey, null);
  const res = await call(app.baseUrl, `/api/projects/${project.id}/renders/${render.id}/image`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'NOT_FOUND');
});

// ── Source-photo bytes ───────────────────────────────────────────────────────
// The companion of the render byte route, and the frontend's `photoImagePath()`. The tray
// thumbnails and the "before" pane both request it, and both degrade to an explicit
// "unavailable" state rather than a broken image — so a wrong status here is a silently
// blank studio, and a missing ownership check is another account's actual house.

test('photo bytes: the source photo is served with nosniff and a private immutable policy', async () => {
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id });

  const res = await call(app.baseUrl, `/api/projects/${project.id}/photos/${photos[0].id}/image`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG_1X1, 'the ORIGINAL upload, byte for byte');
});

test('photo bytes: the content type follows the stored key\'s extension', async () => {
  // Sources are whatever the operator uploaded (PNG/JPG/WebP), so a hardcoded type would
  // mislabel most of a real listing. Each branch of the extension map is exercised, plus
  // the unknown-extension fallback — with nosniff, octet-stream is a download, not
  // something the browser interprets.
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id, photoCount: 1 });
  const photo = app.projects.getPhoto(photos[0].id);

  const serveAs = async (ext) => {
    photo.storageKey = `projects/${project.id}/src/photo.${ext}`;
    app.storage.blobs.set(photo.storageKey, PNG_1X1);
    const res = await call(app.baseUrl, `/api/projects/${project.id}/photos/${photo.id}/image`);
    assert.equal(res.status, 200, `.${ext} must still serve`);
    return res.headers.get('content-type');
  };
  assert.equal(await serveAs('png'), 'image/png');
  assert.equal(await serveAs('jpg'), 'image/jpeg');
  assert.equal(await serveAs('jpeg'), 'image/jpeg');
  assert.equal(await serveAs('webp'), 'image/webp');
  assert.equal(await serveAs('heic'), 'application/octet-stream', 'an unknown extension is never guessed');
});

test('photo bytes: user B gets a 404 that reveals nothing about user A\'s photo', async () => {
  // THE test for this route. A 403 (or any body that differs from the unknown-id answer)
  // would confirm the id exists; the bytes themselves are someone's unstaged home.
  app = await mountProjects({ user: USER_B });
  const { project, photos } = seedProject(app, { userId: USER_A.id });
  const key = `projects/${project.id}/src/private.png`;
  app.storage.blobs.set(key, Buffer.from('someones-actual-house'));
  app.projects.getPhoto(photos[0].id).storageKey = key;

  const res = await call(app.baseUrl, `/api/projects/${project.id}/photos/${photos[0].id}/image`);
  assert.equal(res.status, 404);
  assert.notEqual(res.status, 403, 'a 403 would confirm the photo exists');
  const body = await res.json();

  // Byte-identical to the answer for an id that does not exist anywhere: same status, same
  // body. Anything that varies between the two is an existence oracle.
  const unknown = await call(app.baseUrl, `/api/projects/${project.id}/photos/ph_nope/image`);
  assert.equal(unknown.status, res.status);
  assert.deepEqual(body, await unknown.json(), 'the "not yours" and "not real" answers must be indistinguishable');

  const serialized = JSON.stringify(body);
  for (const leak of [photos[0].id, project.id, key, 'someones-actual-house', 'src']) {
    assert.ok(!serialized.includes(leak), `the 404 body must not mention ${leak}`);
  }
  assert.equal(app.storage.blobs.get(key).toString(), 'someones-actual-house', 'and the blob is untouched');
});

test('photo bytes: a photo from a DIFFERENT project of the same user is 404', async () => {
  // Ownership alone is not enough — the row must also belong to the project in the path,
  // or /projects/:mine/photos/:my-other-listings-photo would serve by accident.
  app = await mountProjects({ user: USER_A });
  const one = seedProject(app, { userId: USER_A.id });
  const two = seedProject(app, { userId: USER_A.id });
  const res = await call(app.baseUrl, `/api/projects/${one.project.id}/photos/${two.photos[0].id}/image`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'NOT_FOUND');
  // Sanity: the same id under its OWN project does serve, so the 404 above is the
  // project check firing and not a broken route.
  const own = await call(app.baseUrl, `/api/projects/${two.project.id}/photos/${two.photos[0].id}/image`);
  assert.equal(own.status, 200);
});

test('photo bytes: an unknown photo id is 404', async () => {
  app = await mountProjects({ user: USER_A });
  const { project } = seedProject(app, { userId: USER_A.id });
  const res = await call(app.baseUrl, `/api/projects/${project.id}/photos/ph_does_not_exist/image`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'NOT_FOUND');
});

test('photo bytes: a null storageKey is 404 and never reaches the blob layer', async () => {
  // A 200 of zero bytes would paint a broken image in the tray; the studio's
  // "no preview available" state depends on the failure being a real status.
  //
  // The `reads` spy is what makes this test pin the GUARD rather than its side effect: a
  // null key that falls through to storage.read() also ends in a 404 (the read rejects),
  // so asserting the status alone leaves "drop the storageKey check" a surviving mutant.
  // A null must never be handed to the path builder in the first place.
  const storage = createFakeStorage();
  /** @type {unknown[]} */
  const reads = [];
  const passThrough = storage.read;
  storage.read = async (key) => { reads.push(key); return passThrough(key); };

  app = await mountProjects({ user: USER_A, storage });
  const { project, photos } = seedProject(app, { userId: USER_A.id, photoCount: 1 });
  app.projects.getPhoto(photos[0].id).storageKey = null;

  const res = await call(app.baseUrl, `/api/projects/${project.id}/photos/${photos[0].id}/image`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'NOT_FOUND');
  assert.deepEqual(reads, [], 'a keyless photo must short-circuit before the blob store');

  // Control: a real key DOES reach the blob layer, so the assertion above is meaningful
  // and not just a spy that never fires.
  app.projects.getPhoto(photos[0].id).storageKey = `projects/${project.id}/src/photo0.png`;
  assert.equal((await call(app.baseUrl, `/api/projects/${project.id}/photos/${photos[0].id}/image`)).status, 200);
  assert.deepEqual(reads, [`projects/${project.id}/src/photo0.png`]);
});

test('photo bytes: a missing or empty blob is 404, not a 500', async () => {
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id, photoCount: 1 });
  const photo = app.projects.getPhoto(photos[0].id);

  // storage.read rejects (ENOENT) for a key that was never written.
  photo.storageKey = `projects/${project.id}/src/gone.png`;
  assert.equal((await call(app.baseUrl, `/api/projects/${project.id}/photos/${photo.id}/image`)).status, 404);

  // A zero-length blob is equally unservable — and must not become a 200.
  photo.storageKey = `projects/${project.id}/src/empty.png`;
  app.storage.blobs.set(photo.storageKey, Buffer.alloc(0));
  const empty = await call(app.baseUrl, `/api/projects/${project.id}/photos/${photo.id}/image`);
  assert.equal(empty.status, 404);
  assert.equal((await empty.json()).code, 'NOT_FOUND');
});

test('photo bytes: an unexpected storage failure returns a ref, never the exception text', async () => {
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id, photoCount: 1 });
  // Not a read rejection (that is a 404 above) — a synchronous blow-up inside the handler.
  app.deps.projects.getPhoto = () => { throw new Error('SQLITE_CORRUPT: /srv/data/auth-store.db'); };
  const res = await call(app.baseUrl, `/api/projects/${project.id}/photos/${photos[0].id}/image`);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.ref, /^[0-9a-f]{8}$/);
  assert.ok(!JSON.stringify(body).includes('SQLITE_CORRUPT'), 'the exception text must not reach the client');
  assert.ok(!JSON.stringify(body).includes('/srv/data'), 'nor an absolute server path');
});

test('render bytes: a missing blob is 404, not a 500', async () => {
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id });
  const render = app.projects.enqueueRender({ projectId: project.id, photoId: photos[0].id });
  render.storageKey = `projects/${project.id}/out/gone.webp`; // never written
  const res = await call(app.baseUrl, `/api/projects/${project.id}/renders/${render.id}/image`);
  assert.equal(res.status, 404);
});

// ── 5xx hygiene ──────────────────────────────────────────────────────────────

// ── The hero ROW, not a hero variable ────────────────────────────────────────
// The claim barrier lives in SQL and reads the PHOTO row (`p.frame_role = 'hero' OR
// r.bible_id IS NOT NULL`). Choosing a hero in JS and enqueueing it with a null bibleId
// therefore produced a render NOTHING could claim — /stage answered 200 and the listing sat
// at `queued: N, running: 0` until it was deleted, with the only escape (mark a hero, press
// Stage) refused as RENDERS_IN_FLIGHT. Four ordinary actions reached that state: "Move to a
// new room…", deleting the hero, demoting it, or every frame failing the upload gate.
//
// Every test below therefore DRAINS THE QUEUE instead of reading the status code.

test('/stage promotes a real hero ROW for a room with no hero, so the queue can claim it', async () => {
  app = await mountProjects({ user: USER_A });
  // hero: null is exactly what PATCH /photos/:photoId { roomKey } leaves behind — it sets
  // room_key only, and frame_role stays at its 'support' default.
  const { project, photos } = seedProject(app, { userId: USER_A.id, photoCount: 3, hero: null });
  assert.ok(photos.every((p) => app.projects.getPhoto(p.id).frameRole === 'support'), 'precondition: no hero');

  const res = await stage(app.baseUrl, project.id);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).queued, 3);

  const heroes = app.projects.listPhotos(project.id).filter((p) => p.frameRole === 'hero');
  assert.equal(heroes.length, 1, 'picking a hero in JS is not enough — the barrier reads the ROW');

  const claimed = app.projects.claimNextRender({ now: Date.now() });
  assert.ok(claimed, 'the queue must hand a worker something; before the fix NOTHING was claimable');
  assert.equal(claimed.photoId, heroes[0].id, 'and it must be the promoted hero');
});

test('/stage on a hero-less room drains completely instead of wedging at queued forever', async () => {
  app = await mountProjects({ user: USER_A });
  const { project } = seedProject(app, { userId: USER_A.id, photoCount: 3, hero: null });
  await stage(app.baseUrl, project.id, { variationCount: 2 });
  // 1 hero + 2 support photos x 2 variations.
  assert.equal(app.projects.progressFor(project.id).queued, 5);
  assert.equal(drainQueue(app.projects, project.id).length, 5, 'every row must eventually run');
  const after = app.projects.progressFor(project.id);
  assert.equal(after.queued, 0);
  assert.equal(after.ok, 5);
});

test('/stage refuses a listing whose every frame the upload gate rejected', async () => {
  app = await mountProjects({ user: USER_A });
  const { project } = seedProject(app, { userId: USER_A.id, photoCount: 2, hero: null, stageable: false });
  const res = await stage(app.baseUrl, project.id);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'NO_STAGEABLE_PHOTOS', 'a distinct code — there is nothing to wait for, unlike NO_ROOM_ASSIGNMENTS');
  assert.match(body.error, /rejected by the upload check/, 'the message must name the actual problem');
  assert.equal(app.projects.listRenders(project.id).length, 0, 'an unrunnable room must not be enqueued');
  assert.equal(app.projects.getProject(project.id).status, 'draft', 'nor may the listing be left in staging');
});

test('/stage never enqueues — never bills — a photo the upload gate rejected', async () => {
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id, photoCount: 3 });
  app.projects.updatePhoto(photos[2].id, { stageable: false, unstageableCode: 'PERSON_PORTRAIT' });
  const body = await (await stage(app.baseUrl, project.id)).json();
  assert.equal(body.queued, 2, 'the tray says "Cannot be staged" — staging it anyway is a charge for nothing');
  assert.ok(!app.projects.listRenders(project.id).some((r) => r.photoId === photos[2].id));
});

test('/stage promotes a stageable frame when the room\'s hero itself was rejected', async () => {
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id, photoCount: 2 });
  app.projects.updatePhoto(photos[0].id, { stageable: false, unstageableCode: 'FOOD' });
  const body = await (await stage(app.baseUrl, project.id)).json();
  assert.equal(body.queued, 1);
  assert.equal(app.projects.getPhoto(photos[1].id).frameRole, 'hero', 'the rejected hero must be replaced, not honoured');
  assert.equal(app.projects.getPhoto(photos[0].id).frameRole, 'support', 'and demoted in the same breath');
  assert.ok(app.projects.claimNextRender({ now: Date.now() }));
});

test('/stage still 409s NO_ROOM_ASSIGNMENTS when the labeller has simply not answered yet', async () => {
  // The two 409s must stay distinguishable: this one resolves itself, the other never does.
  app = await mountProjects({ user: USER_A });
  const { project } = seedProject(app, { userId: USER_A.id, roomKey: null });
  const res = await stage(app.baseUrl, project.id);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'NO_ROOM_ASSIGNMENTS');
});

// ── Cross-room ordering ──────────────────────────────────────────────────────

test('/stage enqueues EVERY room\'s hero ahead of every support frame', async () => {
  // One shared `now` collapsed FIFO to insertion order, so on a 5-room shoot the last
  // room's hero sat behind ~25 support renders — and a crash at 60% left the later rooms
  // with no design bible at all, which is the one artefact the feature exists to produce.
  app = await mountProjects({ user: USER_A });
  const { project } = seedProject(app, { userId: USER_A.id, photoCount: 3, roomKey: 'living-room-1' });
  seedRoom(app, project, { photoCount: 3, roomKey: 'bedroom-1' });

  const body = await (await stage(app.baseUrl, project.id)).json();
  assert.equal(body.queued, 6);
  assert.equal(body.rooms, 2);

  // The durable half of the guarantee: heroes sort ahead by created_at, which is what the
  // claim orders on and what survives a restart (insertion order alone would not).
  const rows = app.projects.listRenders(project.id);
  const roleOf = (r) => app.projects.getPhoto(r.photoId).frameRole;
  const heroAt = rows.filter((r) => roleOf(r) === 'hero').map((r) => r.createdAt);
  const supportAt = rows.filter((r) => roleOf(r) !== 'hero').map((r) => r.createdAt);
  assert.equal(heroAt.length, 2);
  assert.ok(Math.max(...heroAt) < Math.min(...supportAt), 'every hero row must be older than every support row');

  const order = drainQueue(app.projects, project.id).map(roleOf);
  assert.deepEqual(order, ['hero', 'hero', 'support', 'support', 'support', 'support'],
    'a deploy after two renders must still leave BOTH rooms with a bible');
});

// ── Regenerate: idempotent, and never a dead end ─────────────────────────────

test('regenerate retires the room\'s QUEUED rows instead of stacking a second generation', async () => {
  app = await mountProjects({ user: USER_A });
  const { project } = seedProject(app, { userId: USER_A.id, photoCount: 3 });
  await stage(app.baseUrl, project.id, { variationCount: 2 });
  assert.equal(app.projects.progressFor(project.id).queued, 5);

  const url = `/api/projects/${project.id}/rooms/living-room-1/bible/regenerate`;
  const first = await (await call(app.baseUrl, url, { method: 'POST', body: {} })).json();
  assert.equal(first.cancelled, 5, 'the stale queued rows must be retired, not left for the new bible to unblock');
  assert.equal(first.queued, 5);
  assert.equal(app.projects.progressFor(project.id).queued, 5, 'ONE generation in flight, not two');

  await call(app.baseUrl, url, { method: 'POST', body: {} });
  await call(app.baseUrl, url, { method: 'POST', body: {} });
  assert.equal(app.projects.progressFor(project.id).queued, 5, 'three clicks is still one generation, not fifteen rows');
  for (const r of app.projects.listRenders(project.id).filter((r) => r.status === 'failed')) {
    assert.equal(r.errorCode, CANCELLED_CODE, 'a retired row is distinguishable from a real generation failure');
  }
});

test('a regenerated room\'s new bible cannot unblock the superseded generation', async () => {
  // The doubled bill, end to end: supersedeRendersForRoom matches status='ok' ONLY, so the
  // old queued rows survived, and attachBibleToQueuedRenders later released BOTH sets —
  // 6 paid generations for 3 photos, and two live "current" renders per frame.
  app = await mountProjects({ user: USER_A });
  const { project } = seedProject(app, { userId: USER_A.id, photoCount: 3 });
  await stage(app.baseUrl, project.id, { variationCount: 1 });
  await call(app.baseUrl, `/api/projects/${project.id}/rooms/living-room-1/bible/regenerate`, { method: 'POST', body: {} });

  const ran = drainQueue(app.projects, project.id);
  assert.equal(ran.length, 3, '3 photos, 1 variation — three paid generations, not six');
  const live = app.projects.listRenders(project.id).filter((r) => r.status === 'ok');
  assert.equal(live.length, 3, 'and exactly one current render per frame');
});

test('regenerate 409s while a render of that room is running, and changes nothing', async () => {
  app = await mountProjects({ user: USER_A });
  const { project } = seedProject(app, { userId: USER_A.id, photoCount: 3 });
  await stage(app.baseUrl, project.id);
  const running = app.projects.claimNextRender({ now: Date.now() });
  const before = app.projects.progressFor(project.id);

  const res = await call(app.baseUrl, `/api/projects/${project.id}/rooms/living-room-1/bible/regenerate`, { method: 'POST', body: {} });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'ROOM_RENDER_RUNNING');
  assert.deepEqual(app.projects.progressFor(project.id), before, 'a refused regenerate must not retire or enqueue anything');
  assert.equal(app.projects.getRender(running.id).status, 'running', 'and must not race the worker for its row');
});

test('regenerate is NOT refused for a room whose support frames are blocked forever', async () => {
  // The escape hatch must stay open. /stage's blanket "anything queued → 409" applied here
  // would let a blocked-forever row bar its own only remedy — the original dead end.
  app = await mountProjects({ user: USER_A });
  const { project } = seedProject(app, { userId: USER_A.id, photoCount: 2 });
  await stage(app.baseUrl, project.id);
  // The hero renders but yields no bible (extraction failed), so its support frame is
  // queued with a null bibleId and can never be claimed.
  drainQueue(app.projects, project.id, { max: 1, withBible: false });
  const stuck = app.projects.progressFor(project.id);
  assert.equal(stuck.queued, 1);
  assert.equal(stuck.blocked, 1, 'precondition: one row waiting for something that will never arrive');
  assert.equal((await stage(app.baseUrl, project.id)).status, 409, 'and /stage is indeed refused');

  const res = await call(app.baseUrl, `/api/projects/${project.id}/rooms/living-room-1/bible/regenerate`, { method: 'POST', body: {} });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.cancelled, 1, 'the blocked row is retired');
  assert.equal(body.superseded, 1, 'and the stale hero render is retired too');
  assert.equal(body.queued, 2);
  assert.equal(drainQueue(app.projects, project.id).length, 2, 'the room runs again');
});

// ── Per-render retry ─────────────────────────────────────────────────────────

test('retry requeues ONE failed render, reusing its bible so the room keeps its look', async () => {
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id, photoCount: 2 });
  await stage(app.baseUrl, project.id);
  drainQueue(app.projects, project.id, { max: 1 }); // hero renders, bible attaches
  const support = app.projects.claimNextRender({ now: Date.now() });
  app.projects.failRender(support.id, { errorCode: 'NO_IMAGE_GENERATED' });
  assert.ok(support.bibleId, 'precondition: the failed support render is bible-conditioned');

  const res = await call(app.baseUrl, `/api/projects/${project.id}/renders/${support.id}/retry`, { method: 'POST', body: {} });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.retryOf, support.id);
  assert.equal(body.render.status, 'queued');
  assert.equal(body.render.bibleId, support.bibleId, 'the same bible — a retry must not author a competing look');
  assert.equal(body.render.photoId, photos[1].id);
  assert.equal(app.projects.progressFor(project.id).queued, 1, 'exactly one row requeued, not the whole room');
  assert.equal(app.projects.getProject(project.id).status, 'staging');
  assert.ok(app.projects.claimNextRender({ now: Date.now() }), 'and it is immediately claimable');
});

test('retry refuses a render that is not failed', async () => {
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id, photoCount: 1 });
  const render = app.projects.enqueueRender({ projectId: project.id, photoId: photos[0].id });
  for (const status of ['queued', 'running', 'ok', 'superseded']) {
    render.status = status;
    const res = await call(app.baseUrl, `/api/projects/${project.id}/renders/${render.id}/retry`, { method: 'POST', body: {} });
    assert.equal(res.status, 409, `${status} must not be retryable`);
    assert.equal((await res.json()).code, 'RENDER_NOT_FAILED');
  }
});

test('retry refuses a second click while the first attempt is still queued', async () => {
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id, photoCount: 1 });
  const render = app.projects.enqueueRender({ projectId: project.id, photoId: photos[0].id, variation: 1 });
  app.projects.failRender(render.id, { errorCode: 'BOOM' });
  const url = `/api/projects/${project.id}/renders/${render.id}/retry`;
  assert.equal((await call(app.baseUrl, url, { method: 'POST', body: {} })).status, 200);
  const second = await call(app.baseUrl, url, { method: 'POST', body: {} });
  assert.equal(second.status, 409);
  assert.equal((await second.json()).code, 'RENDERS_IN_FLIGHT');
  assert.equal(app.projects.progressFor(project.id).queued, 1, 'a double click must not double-bill the frame');
});

test('retry 404s for a render of another listing of the same user', async () => {
  app = await mountProjects({ user: USER_A });
  const mine = seedProject(app, { userId: USER_A.id, photoCount: 1 });
  const other = seedProject(app, { userId: USER_A.id, photoCount: 1 });
  const render = app.projects.enqueueRender({ projectId: other.project.id, photoId: other.photos[0].id });
  app.projects.failRender(render.id, { errorCode: 'BOOM' });
  const res = await call(app.baseUrl, `/api/projects/${mine.project.id}/renders/${render.id}/retry`, { method: 'POST', body: {} });
  assert.equal(res.status, 404);
});

// ── Cancel ───────────────────────────────────────────────────────────────────

test('cancel retires every queued render, keeps the finished ones, and settles the status', async () => {
  app = await mountProjects({ user: USER_A });
  const { project } = seedProject(app, { userId: USER_A.id, photoCount: 3 });
  await stage(app.baseUrl, project.id);
  const done = drainQueue(app.projects, project.id, { max: 1 })[0];

  const body = await (await call(app.baseUrl, `/api/projects/${project.id}/cancel`, { method: 'POST', body: {} })).json();
  assert.equal(body.cancelled, 2);
  assert.equal(body.kept, 1);
  assert.equal(body.running, 0);
  assert.equal(body.status, 'ready');
  assert.equal(app.projects.getRender(done.id).status, 'ok', 'a finished render is never thrown away');
  assert.ok(app.projects.getRender(done.id).storageKey, 'nor are its bytes orphaned');
  assert.equal(app.projects.progressFor(project.id).queued, 0);
  assert.equal(app.projects.claimNextRender({ now: Date.now() }), null, 'and nothing is left for a worker to pick up');
  for (const r of app.projects.listRenders(project.id).filter((r) => r.status === 'failed')) {
    assert.equal(r.errorCode, CANCELLED_CODE);
  }
});

test('cancel lets a running render finish and reports it, rather than pretending it stopped', async () => {
  app = await mountProjects({ user: USER_A });
  const { project } = seedProject(app, { userId: USER_A.id, photoCount: 3 });
  await stage(app.baseUrl, project.id);
  const running = app.projects.claimNextRender({ now: Date.now() });

  const body = await (await call(app.baseUrl, `/api/projects/${project.id}/cancel`, { method: 'POST', body: {} })).json();
  assert.equal(body.running, 1);
  assert.equal(body.status, 'staging', 'the listing stays staging until the in-flight generation lands');
  assert.equal(app.projects.getRender(running.id).status, 'running', 'a paid generation in flight is not discarded');
});

test('cancel on a listing with nothing finished settles it back to draft', async () => {
  app = await mountProjects({ user: USER_A });
  const { project } = seedProject(app, { userId: USER_A.id, photoCount: 2 });
  await stage(app.baseUrl, project.id);
  const body = await (await call(app.baseUrl, `/api/projects/${project.id}/cancel`, { method: 'POST', body: {} })).json();
  assert.equal(body.status, 'draft');
  assert.equal(app.projects.getProject(project.id).status, 'draft');
  // And the listing can be staged again — cancel must not leave a dead end of its own.
  assert.equal((await stage(app.baseUrl, project.id)).status, 200);
});

// ── The render archive ───────────────────────────────────────────────────────
// Before this route there was NO way to get the images out: every render reaches the page
// as an authenticated `blob:`, and the byte route 401s when its URL is opened directly.

/**
 * Parse a zip from its END, the way a real unpacker does: locate the
 * end-of-central-directory record, walk the central directory, and follow each entry's
 * stated offset to its local header. Independent of the writer, so a wrong offset, a wrong
 * count or a mis-sized directory fails here rather than in some other program.
 * @param {Buffer} buf - The whole archive.
 * @returns {Array<{ name: string, method: number, crc: number, csize: number, usize: number, bytes: Buffer }>}
 */
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, 'no end-of-central-directory record — this is not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, `central header ${i}`);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const csize = buf.readUInt32LE(p + 20);
    assert.equal(buf.readUInt32LE(offset), 0x04034b50, `local header for ${name}`);
    const dataAt = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    entries.push({
      name,
      method: buf.readUInt16LE(p + 10),
      crc: buf.readUInt32LE(p + 16),
      csize,
      usize: buf.readUInt32LE(p + 24),
      bytes: buf.subarray(dataAt, dataAt + csize),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  assert.equal(p - cdOffset, cdSize, 'the central directory size in the EOCD must match what is there');
  return entries;
}

/**
 * The archive's render entries, with the virtual-staging disclosure removed.
 *
 * Every archive now leads with DISCLOSURE.txt (see lib/staging/staging-disclosure.js), so
 * the tests below — which are about which RENDERS are delivered and in what order — say so
 * explicitly rather than each carrying an off-by-one. The disclosure has its own tests.
 * @param {ReturnType<typeof readZip>} entries - Everything in the archive.
 * @returns {ReturnType<typeof readZip>} Just the images.
 */
function renderEntries(entries) {
  return entries.filter((e) => e.name !== DISCLOSURE_ENTRY_NAME);
}

test('crc32 matches the standard CRC-32 check value', () => {
  // 0xCBF43926 for "123456789" is the published check value for CRC-32/ISO-HDLC. A
  // hand-rolled table that is subtly wrong produces an archive every unpacker rejects, and
  // nothing else in these tests would notice.
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('renders.zip streams every finished render as a STORE entry named by room, seq and variation', async () => {
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id, photoCount: 2, roomType: 'Living room', title: '12 Oak Avenue' });
  finishRender(app, app.projects.enqueueRender({ projectId: project.id, photoId: photos[0].id, variation: 1 }), Buffer.from('hero-pixels'));
  finishRender(app, app.projects.enqueueRender({ projectId: project.id, photoId: photos[1].id, variation: 2 }), Buffer.from('support-pixels'), 'png');

  const res = await call(app.baseUrl, `/api/projects/${project.id}/renders.zip`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="12-oak-avenue-staged.zip"');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

  const entries = renderEntries(readZip(Buffer.from(await res.arrayBuffer())));
  assert.deepEqual(entries.map((e) => e.name), ['living-room-00-v1.webp', 'living-room-01-v2.png'],
    'a meaningful name per render — the whole point is that the files are usable after unzipping');
  for (const entry of entries) {
    assert.equal(entry.method, 0, 'STORE: WebP/JPEG are already compressed, deflate only costs CPU');
    assert.equal(entry.csize, entry.usize, 'and stored size therefore equals uncompressed size');
    assert.equal(entry.crc, crc32(entry.bytes), 'the CRC must describe the bytes actually written');
  }
  assert.equal(entries[0].bytes.toString(), 'hero-pixels');
  assert.equal(entries[1].bytes.toString(), 'support-pixels');
});

test('renders.zip 404s when nothing has finished, rather than downloading an empty archive', async () => {
  // An empty zip looks like success: the operator gets a file, the studio cannot tell it
  // apart from "still rendering", and nobody learns anything.
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id, photoCount: 1 });
  app.projects.enqueueRender({ projectId: project.id, photoId: photos[0].id });
  const res = await call(app.baseUrl, `/api/projects/${project.id}/renders.zip`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'NO_RENDERS');
});

test('renders.zip includes only current, finished renders', async () => {
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id, photoCount: 1 });
  const good = finishRender(app, app.projects.enqueueRender({ projectId: project.id, photoId: photos[0].id, variation: 1 }));
  for (const [variation, status] of [[2, 'queued'], [3, 'failed'], [1, 'superseded']]) {
    const other = finishRender(app, app.projects.enqueueRender({ projectId: project.id, photoId: photos[0].id, variation }));
    other.status = status;
  }
  const entries = renderEntries(readZip(Buffer.from(await (await call(app.baseUrl, `/api/projects/${project.id}/renders.zip`)).arrayBuffer())));
  assert.equal(entries.length, 1, 'a superseded render is history, not delivery');
  assert.equal(entries[0].bytes.toString(), 'webp-render-bytes');
  assert.ok(good.storageKey);
});

test('renders.zip skips a render whose blob is gone instead of aborting the download', async () => {
  // A row can outlive its file (DELETE removes rows first, on purpose), and one missing
  // blob must not cost the operator the other 89 renders.
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id, photoCount: 2 });
  const kept = finishRender(app, app.projects.enqueueRender({ projectId: project.id, photoId: photos[0].id, variation: 1 }), Buffer.from('still-here'));
  const lost = finishRender(app, app.projects.enqueueRender({ projectId: project.id, photoId: photos[1].id, variation: 1 }), Buffer.from('gone'));
  app.storage.blobs.delete(lost.storageKey);

  const res = await call(app.baseUrl, `/api/projects/${project.id}/renders.zip`);
  assert.equal(res.status, 200);
  const entries = renderEntries(readZip(Buffer.from(await res.arrayBuffer())));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].bytes.toString(), 'still-here');
  assert.ok(kept.storageKey);
});

test('renders.zip 404s when EVERY blob is missing, because it checks before sending headers', async () => {
  // The stat pass exists for exactly this: once a byte of the archive is out there is no
  // status left to send, so "no bytes anywhere" has to be decided first.
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id, photoCount: 1 });
  const lost = finishRender(app, app.projects.enqueueRender({ projectId: project.id, photoId: photos[0].id }));
  app.storage.blobs.delete(lost.storageKey);
  const res = await call(app.baseUrl, `/api/projects/${project.id}/renders.zip`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'NO_RENDERS');
});

test('renders.zip disambiguates duplicate entry names', async () => {
  // Two 'ok' renders of the same (photo, variation) exist in every listing staged before
  // the double-enqueue fix, and most unpackers silently keep only one of two identical names.
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id, photoCount: 1 });
  finishRender(app, app.projects.enqueueRender({ projectId: project.id, photoId: photos[0].id, variation: 1 }), Buffer.from('first'));
  finishRender(app, app.projects.enqueueRender({ projectId: project.id, photoId: photos[0].id, variation: 1 }), Buffer.from('second'));
  const entries = renderEntries(readZip(Buffer.from(await (await call(app.baseUrl, `/api/projects/${project.id}/renders.zip`)).arrayBuffer())));
  assert.equal(entries.length, 2);
  assert.equal(new Set(entries.map((e) => e.name)).size, 2, 'both renders must survive the archive');
  assert.deepEqual(entries.map((e) => e.bytes.toString()).sort(), ['first', 'second']);
});

test('renders.zip cannot be talked into a header or a path by a listing title or room label', async () => {
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, {
    userId: USER_A.id,
    photoCount: 1,
    title: 'Flat 3"\r\nX-Injected: yes',
    roomType: '../../etc/passwd',
  });
  finishRender(app, app.projects.enqueueRender({ projectId: project.id, photoId: photos[0].id, variation: 1 }));
  const res = await call(app.baseUrl, `/api/projects/${project.id}/renders.zip`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-injected'), null, 'a title must never become a header');
  const disposition = res.headers.get('content-disposition');
  assert.match(disposition, /^attachment; filename="[a-z0-9-]+-staged\.zip"$/);
  const [entry] = renderEntries(readZip(Buffer.from(await res.arrayBuffer())));
  assert.match(entry.name, /^[a-z0-9-]+-\d\d-v\d+\.[a-z0-9]+$/, 'no dots, no slashes — the name is unpacked as a filename');
  assert.ok(!entry.name.includes('..'));
});

// ── The virtual-staging disclosure ───────────────────────────────────────────
// A broker who uploads an undisclosed staged photo to an MLS is the one who gets cited,
// so the disclosure ships WITH the pixels rather than as advice on a help page.

test('renders.zip leads with a DISCLOSURE.txt naming the listing', async () => {
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id, photoCount: 1, title: '12 Oak Avenue' });
  finishRender(app, app.projects.enqueueRender({ projectId: project.id, photoId: photos[0].id, variation: 1 }));

  const entries = readZip(Buffer.from(await (await call(app.baseUrl, `/api/projects/${project.id}/renders.zip`)).arrayBuffer()));
  assert.equal(entries[0].name, DISCLOSURE_ENTRY_NAME,
    'FIRST, not last — unpackers list in archive order and the point is that it is seen');

  const text = entries[0].bytes.toString('utf8');
  assert.ok(text.includes(STAGING_DISCLOSURE_ARCHIVE),
    'the file must carry the canonical sentence, not a paraphrase that can drift from it');
  assert.ok(text.includes('12 Oak Avenue'), 'a disclosure that does not name its listing cannot be acted on');
  assert.ok(text.includes('1 Main St'), 'and the address, so the file survives being copied out of its folder');
  assert.equal(entries[0].crc, crc32(entries[0].bytes), 'a synthesized entry gets the same CRC treatment as a blob');
  assert.equal(entries[0].method, 0);
  assert.equal(entries[0].csize, entries[0].usize);
});

test('an archive that would be empty stays a 404 rather than shipping only a disclosure', async () => {
  // The disclosure is unshifted AFTER the empty check on purpose: a 200 carrying nothing
  // but a legal notice is exactly the "looks like it worked" failure the 404 exists for.
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id, photoCount: 1 });
  app.projects.enqueueRender({ projectId: project.id, photoId: photos[0].id });
  const res = await call(app.baseUrl, `/api/projects/${project.id}/renders.zip`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'NO_RENDERS');
});

test('a listing title cannot forge a second disclosure entry', async () => {
  // The name is reserved through the same `uniqueEntryName` set as every render, so a room
  // label that slugifies toward the reserved name gets suffixed rather than shadowing it.
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id, photoCount: 1, roomType: DISCLOSURE_ENTRY_NAME });
  finishRender(app, app.projects.enqueueRender({ projectId: project.id, photoId: photos[0].id, variation: 1 }));
  const entries = readZip(Buffer.from(await (await call(app.baseUrl, `/api/projects/${project.id}/renders.zip`)).arrayBuffer()));
  assert.equal(entries.filter((e) => e.name === DISCLOSURE_ENTRY_NAME).length, 1);
  assert.equal(new Set(entries.map((e) => e.name)).size, entries.length, 'no duplicate names');
});

test('renders.zip orders entries by room, then position in the shoot, then variation', async () => {
  app = await mountProjects({ user: USER_A });
  const { project, photos } = seedProject(app, { userId: USER_A.id, photoCount: 2, roomKey: 'living-room-1', roomType: 'Living room' });
  const bedroom = seedRoom(app, project, { photoCount: 1, roomKey: 'bedroom-1', roomType: 'Bedroom' });
  // Enqueued deliberately out of order.
  finishRender(app, app.projects.enqueueRender({ projectId: project.id, photoId: bedroom[0].id, variation: 1 }));
  finishRender(app, app.projects.enqueueRender({ projectId: project.id, photoId: photos[1].id, variation: 2 }));
  finishRender(app, app.projects.enqueueRender({ projectId: project.id, photoId: photos[1].id, variation: 1 }));
  finishRender(app, app.projects.enqueueRender({ projectId: project.id, photoId: photos[0].id, variation: 1 }));
  const entries = renderEntries(readZip(Buffer.from(await (await call(app.baseUrl, `/api/projects/${project.id}/renders.zip`)).arrayBuffer())));
  assert.deepEqual(entries.map((e) => e.name), [
    'bedroom-02-v1.webp',
    'living-room-00-v1.webp',
    'living-room-01-v1.webp',
    'living-room-01-v2.webp',
  ]);
});

// ── Upload size limit ────────────────────────────────────────────────────────

test('the per-photo upload limit matches the single-photo stager\'s, so the client can trust one number', () => {
  // Three places used to disagree: 15 MB here, 25 MB in the browser, "25MB per photo" in
  // the dropzone copy. A 20 MB frame therefore passed client validation and then 413'd the
  // whole batch of 40. This guard fails the build if they drift apart again.
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'http', 'uploads.js'), 'utf8');
  const stagerBlock = src.slice(src.indexOf('stagingProcessUpload'), src.indexOf('chatUpload'));
  const match = /fileSize:\s*(\d+)\s*\*\s*1024\s*\*\s*1024/.exec(stagerBlock);
  assert.ok(match, 'could not find the stager\'s fileSize limit');
  assert.equal(MAX_PHOTO_BYTES, Number(match[1]) * 1024 * 1024,
    'the listing batch limit must equal the single-photo stager\'s, and must not exceed it');
});

test('a photo over the per-photo limit 413s with a code that names the FILE, not the batch', async () => {
  app = await mountProjects({ user: USER_A });
  const project = app.projects.createProject({ userId: USER_A.id, title: 'Big' });
  const tooBig = Buffer.alloc(MAX_PHOTO_BYTES + 1024, 0x41);
  const res = await postPhotos(app.baseUrl, project.id, [tooBig]).catch((e) => e);
  assert.ok(!(res instanceof Error), `the 413 must reach the client, got ${res}`);
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.code, 'PHOTO_TOO_LARGE', 'the old generic LIMIT_FILE_SIZE could not be told from a batch problem');
  assert.match(body.details, /per photo, not per batch/, 'the advice must be followable');
  assert.equal(app.projects.db.photos.length, 0);
});

test('an unexpected store failure returns a ref, never the exception text', async () => {
  app = await mountProjects({ user: USER_A });
  app.deps.projects.listProjects = () => { throw new Error('SQLITE_CORRUPT: table projects has no column named secret'); };
  const res = await call(app.baseUrl, '/api/projects');
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.ref, /^[0-9a-f]{8}$/, 'a random 8-char reference identifies the log line');
  assert.ok(!JSON.stringify(body).includes('SQLITE_CORRUPT'), 'the exception text must not reach the client');
});
