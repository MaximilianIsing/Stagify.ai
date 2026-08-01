// Tier: route contract (REAL share store on temp SQLite, fake project store/blobs) —
// routes/share-public.js, the completely unauthenticated client-share surface.
//
// WHY THIS FILE IS THE PARANOID ONE
// Every other route in the Listing Studio is behind `requireProAccount`. These four are
// behind a 43-character token in a URL that a broker texts to a seller, so the router IS
// the access-control system. The tests that matter are therefore not "does it render":
//
//   * CROSS-TENANT. A render id from a DIFFERENT project must 404 even with a perfectly
//     valid token. It is asserted FIRST because a missing `render.projectId === ...`
//     serves every customer's pixels to anyone holding any live link, and nothing else in
//     this file would notice.
//   * ONE 404 FOR EVERYTHING. Revoked, expired, garbage and blank tokens are compared to
//     EACH OTHER, byte for byte, body and headers — asserting "each is 404" would pass a
//     router whose bodies said "revoked"/"expired", which is a working oracle telling an
//     attacker which of their guesses were once real tokens.
//   * THE MANIFEST IS AN ALLOWLIST. Asserted against the raw serialized JSON, not against
//     hand-picked keys, so a spread row (`...project`) fails here rather than shipping
//     userId, storage keys, prompt text and quality scores to a stranger.
//   * WHAT IS NOT PUBLISHED IS NOT SERVABLE. A failed/superseded/excluded frame must be
//     absent from the manifest AND 404 on the byte route — one predicate, both surfaces.
//
// The share store is REAL (a throwaway SQLite dir) so REVOKED/EXPIRED come from the actual
// resolver rather than from a mock that agrees with the router by construction. The
// project store and blob storage are the in-memory fakes from test/helpers/projects-app.js.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createFakeProjects, createFakeStorage, PNG_1X1 } from '../helpers/projects-app.js';
import { createProjectShares } from '../../lib/data/project-shares.js';
import { closeDb } from '../../lib/data/db.js';
import { STAGING_DISCLOSURE } from '../../lib/staging/staging-disclosure.js';
import createSharePublicRouter, { SHARE_BYTE_CACHE, SHARE_NO_STORE, SHARE_PAGE_FILE, roomLabel, OTHER_ROOM_LABEL } from '../../routes/share-public.js';
import { OTHER_ROOM_TYPE } from '../../lib/staging/room-clustering.js';

const SHELL_HTML = '<!doctype html><title>Shared listing</title><div id="app"></div>';

/** @type {any} */
let app = null;
/** @type {string[]} */
const dirs = [];

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  while (dirs.length) {
    const dir = dirs.pop();
    // Windows cannot unlink the .db/-wal/-shm files while the shared handle is open.
    closeDb(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Mount the real router on a bare Express app: real share store on a throwaway data dir,
 * fake project store and blob storage, a pass-through rate limiter (overridable), and a
 * `__dirname` whose `public/` holds a stand-in share page.
 * @param {Record<string, any>} [overrides] - Dep-bag overrides (e.g. a spying shareLimiter).
 * @returns {Promise<any>} `{ baseUrl, shares, projects, storage, deps, dir, close }`.
 */
async function mountShare(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-share-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'public', SHARE_PAGE_FILE), SHELL_HTML);

  /** @type {string[]} */
  const calls = [];
  const projects = overrides.projects || createFakeProjects(calls);
  const storage = overrides.storage || createFakeStorage(calls);
  const shares = overrides.shares || createProjectShares(dir);
  const deps = {
    shares,
    projects,
    storage,
    shareLimiter: (/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ next) => next(),
    __dirname: dir,
    ...overrides,
  };

  const server = express();
  server.use(createSharePublicRouter(deps));
  // Catch-all, as in server.js — without it Express renders a stack trace as HTML.
  server.use((/** @type {any} */ err, /** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ _next) => {
    if (res.headersSent) return;
    res.status(500).json({ error: 'Server error', code: err?.code || 'ERROR' });
  });

  const listening = await new Promise((resolve) => {
    const s = server.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = /** @type {any} */ (listening).address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    shares, projects, storage, deps, dir, calls,
    close: () => new Promise((r) => /** @type {any} */ (listening).close(() => r(undefined))),
  };
}

/**
 * Seed one listing: `photoCount` photos in one room (photo 0 the hero), each with source
 * bytes on disk and, unless told otherwise, a finished render.
 * @param {any} harness - What mountShare resolved to.
 * @param {{ userId?: string, photoCount?: number, roomKey?: string, roomType?: string|null, render?: boolean, title?: string }} [opts]
 * @returns {any} `{ project, photos, renders }`.
 */
function seedListing(harness, {
  userId = 'u_broker', photoCount = 2, roomKey = 'living-room-1', roomType = 'Living room',
  render = true, title = '12 Oak St',
} = {}) {
  const project = harness.projects.createProject({ userId, title, address: '12 Oak St, Denver' });
  const photos = [];
  const renders = [];
  for (let i = 0; i < photoCount; i += 1) {
    const key = `projects/${project.id}/src/photo${i}.png`;
    harness.storage.blobs.set(key, PNG_1X1);
    const { photo } = harness.projects.addPhoto({ projectId: project.id, storageKey: key, sha256: `sha-${project.id}-${i}`, seq: i, width: 1200, height: 800 });
    harness.projects.updatePhoto(photo.id, { roomKey, roomType, stageable: true, frameRole: i === 0 ? 'hero' : 'support' });
    photos.push(harness.projects.getPhoto(photo.id));
    if (render) renders.push(finish(harness, project, photo));
  }
  return { project, photos, renders };
}

/**
 * Mark a render finished with bytes on disk — the only state this surface publishes.
 * @param {any} harness - What mountShare resolved to.
 * @param {any} project - The project row.
 * @param {any} photo - The photo row.
 * @param {string} [body] - Blob contents, so a test can prove WHICH bytes came back.
 * @returns {any} The render row.
 */
function finish(harness, project, photo, body = `staged-${photo.id}`) {
  const row = harness.projects.enqueueRender({ projectId: project.id, photoId: photo.id });
  row.storageKey = `projects/${project.id}/out/${row.id}.webp`;
  row.status = 'ok';
  harness.storage.blobs.set(row.storageKey, Buffer.from(body));
  return row;
}

/** Mint a live link for a listing. @returns {string} The one-time plaintext token. */
function share(harness, project, settings = {}, over = {}) {
  return harness.shares.createShare({ projectId: project.id, userId: project.userId, settings, ...over }).token;
}

const get = (base, route) => fetch(`${base}${route}`);

/**
 * The full observable shape of a response, for the "every refusal is identical" test.
 * @param {Response} res - A fetch response.
 * @returns {Promise<any>} Status, the security headers, and the raw body text.
 */
async function shapeOf(res) {
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    cacheControl: res.headers.get('cache-control'),
    referrerPolicy: res.headers.get('referrer-policy'),
    robots: res.headers.get('x-robots-tag'),
    body: await res.text(),
  };
}

// ── Cross-tenant: the one that matters ───────────────────────────────────────

test('a render id from ANOTHER project 404s even with a perfectly valid token', async () => {
  // The whole tenancy boundary of this surface is `render.projectId === share.projectId`.
  // Without it, one live link serves every customer's pixels.
  app = await mountShare();
  const mine = seedListing(app, { userId: 'u_broker', title: 'Mine' });
  const theirs = seedListing(app, { userId: 'u_rival', title: 'Theirs' });
  const token = share(app, mine.project);

  const res = await get(app.baseUrl, `/api/share/${token}/render/${theirs.renders[0].id}`);
  assert.equal(res.status, 404, 'another project\'s render must never be servable');
  assert.equal((await res.json()).code, 'NOT_FOUND');

  // Control: the SAME token does serve its own render, so the 404 above is the tenancy
  // check firing and not a broken route.
  const own = await get(app.baseUrl, `/api/share/${token}/render/${mine.renders[0].id}`);
  assert.equal(own.status, 200);
  assert.equal(await own.text(), `staged-${mine.photos[0].id}`);
});

test('a photo id from ANOTHER project 404s even with a valid token and showBefore on', async () => {
  app = await mountShare();
  const mine = seedListing(app, { userId: 'u_broker' });
  const theirs = seedListing(app, { userId: 'u_rival' });
  const token = share(app, mine.project, { showBefore: true });

  const res = await get(app.baseUrl, `/api/share/${token}/photo/${theirs.photos[0].id}`);
  assert.equal(res.status, 404);
  const own = await get(app.baseUrl, `/api/share/${token}/photo/${mine.photos[0].id}`);
  assert.equal(own.status, 200, 'control: the share\'s own original is reachable');
});

test('the photo route\'s tenancy check stands ALONE, not on the published-render test', async () => {
  // Mutation-testing found the plain cross-project case above cannot distinguish the two
  // guards: a foreign photo has no render in THIS project either, so deleting
  // `photo.projectId === share.projectId` still 404s. That makes the tenancy check look
  // dead code to the next reader — and it is the only guard left the moment the "is it
  // published" test stops implying same-project (e.g. a refactor to the store's
  // rendersForPhoto(photo.id), which keys on the PHOTO and not on the share's listing).
  // So: a render row in MY listing that points at THEIR photo. The row is synthetic; the
  // guard it isolates is not.
  app = await mountShare();
  const mine = seedListing(app, { userId: 'u_broker' });
  const theirs = seedListing(app, { userId: 'u_rival' });
  const crossLinked = app.projects.enqueueRender({ projectId: mine.project.id, photoId: theirs.photos[0].id });
  crossLinked.storageKey = `projects/${mine.project.id}/out/${crossLinked.id}.webp`;
  crossLinked.status = 'ok';
  app.storage.blobs.set(crossLinked.storageKey, Buffer.from('cross-linked'));
  const token = share(app, mine.project, { showBefore: true });

  const res = await get(app.baseUrl, `/api/share/${token}/photo/${theirs.photos[0].id}`);
  assert.equal(res.status, 404, 'the photo row must belong to the share\'s listing, full stop');
  assert.notEqual(
    app.storage.blobs.get(theirs.photos[0].storageKey), undefined,
    'precondition: the rival\'s original really is on disk, so this is a refusal and not an absence',
  );
});

test('a token for a DELETED listing 404s rather than 500ing', async () => {
  app = await mountShare();
  const { project, renders } = seedListing(app);
  const token = share(app, project);
  app.projects.deleteProject(project.id);
  assert.equal((await get(app.baseUrl, `/api/share/${token}`)).status, 404);
  assert.equal((await get(app.baseUrl, `/api/share/${token}/render/${renders[0].id}`)).status, 404);
});

// ── One indistinguishable refusal ────────────────────────────────────────────

test('revoked, expired, garbage and blank tokens all answer the IDENTICAL 404', async () => {
  // Asserting "each is 404" would pass a router whose bodies said REVOKED vs NOT_FOUND.
  // The point is that the four answers are indistinguishable from EACH OTHER.
  app = await mountShare();
  const { project } = seedListing(app);

  const revoked = share(app, project);
  app.shares.revokeSharesFor(project.id);
  const expired = share(app, project, {}, { expiresAt: Date.now() - 60_000 });
  const unknown = 'A'.repeat(43); // well-formed, simply never minted
  const blank = '%20';

  const shapes = [];
  for (const token of [revoked, expired, unknown, blank, 'not-a-token']) {
    shapes.push(await shapeOf(await get(app.baseUrl, `/api/share/${token}`)));
  }
  for (const shape of shapes.slice(1)) {
    assert.deepEqual(shape, shapes[0], 'every rejection must be byte-identical, headers included');
  }
  assert.equal(shapes[0].status, 404);
  for (const shape of shapes) {
    assert.ok(!/revok|expir|unknown/i.test(shape.body), `the refusal must not name a reason: ${shape.body}`);
  }
});

test('the byte routes answer the same refusal for a dead token as for an unknown id', async () => {
  app = await mountShare();
  const { project, renders } = seedListing(app);
  const live = share(app, project);
  const dead = share(app, project); // minting rotates: `live` is now revoked
  app.shares.revokeSharesFor(project.id); // and so is `dead`

  const withDeadToken = await shapeOf(await get(app.baseUrl, `/api/share/${dead}/render/${renders[0].id}`));
  const withRotatedToken = await shapeOf(await get(app.baseUrl, `/api/share/${live}/render/${renders[0].id}`));
  const unknownId = await shapeOf(await get(app.baseUrl, `/api/share/${'B'.repeat(43)}/render/r_nope`));
  assert.deepEqual(withDeadToken, withRotatedToken);
  assert.deepEqual(withDeadToken, unknownId);
  assert.equal(withDeadToken.status, 404);
});

test('a revoked link stops serving bytes it served a moment ago', async () => {
  app = await mountShare();
  const { project, renders } = seedListing(app);
  const token = share(app, project);
  assert.equal((await get(app.baseUrl, `/api/share/${token}/render/${renders[0].id}`)).status, 200);
  app.shares.revokeSharesFor(project.id);
  assert.equal((await get(app.baseUrl, `/api/share/${token}/render/${renders[0].id}`)).status, 404);
  assert.equal((await get(app.baseUrl, `/api/share/${token}`)).status, 404);
});

// ── Happy path ───────────────────────────────────────────────────────────────

test('a live token returns the listing, its rooms in photo order, hero frame first', async () => {
  app = await mountShare();
  const { project, photos } = seedListing(app, { photoCount: 3, roomKey: 'living-room-1', roomType: 'Living room' });
  // A second room, seeded AFTER the first, whose photos carry higher seq values.
  const bedroom = [];
  for (let i = 0; i < 2; i += 1) {
    const seq = 3 + i;
    const key = `projects/${project.id}/src/bed${i}.png`;
    app.storage.blobs.set(key, PNG_1X1);
    const { photo } = app.projects.addPhoto({ projectId: project.id, storageKey: key, sha256: `bed-${i}`, seq, width: 900, height: 600 });
    app.projects.updatePhoto(photo.id, { roomKey: 'bedroom-1', roomType: 'Bedroom', stageable: true, frameRole: i === 1 ? 'hero' : 'support' });
    bedroom.push(finish(app, project, photo));
  }
  const token = share(app, project, { headline: 'Just listed', note: 'Tell me what you think.', agentName: 'Dana', agentEmail: 'dana@example.com', agentPhone: '555-0100' });

  const res = await get(app.baseUrl, `/api/share/${token}`);
  assert.equal(res.status, 200);
  const { listing } = await res.json();

  assert.equal(listing.title, '12 Oak St');
  assert.equal(listing.address, '12 Oak St, Denver');
  assert.equal(listing.headline, 'Just listed');
  assert.equal(listing.note, 'Tell me what you think.');
  assert.deepEqual(listing.agent, { name: 'Dana', email: 'dana@example.com', phone: '555-0100' });
  assert.equal(listing.frameCount, 5);
  assert.equal(listing.disclosure, STAGING_DISCLOSURE, 'the disclosure ships with the pixels, from one definition');

  assert.deepEqual(listing.rooms.map((/** @type {any} */ r) => r.key), ['living-room-1', 'bedroom-1'], 'rooms follow the operator\'s photo order');
  assert.deepEqual(listing.rooms.map((/** @type {any} */ r) => r.label), ['Living room', 'Bedroom']);
  assert.equal(listing.rooms[0].frames[0].renderId, app.projects.listRenders(project.id)[0].id);
  assert.equal(listing.rooms[0].frames[0].photoId, photos[0].id, 'the hero frame leads its room');
  // The bedroom's hero is its SECOND photo by seq, so hero-first must beat seq order.
  assert.equal(listing.rooms[1].frames[0].renderId, bedroom[1].id);
  assert.deepEqual(listing.rooms[0].frames[0], {
    renderId: listing.rooms[0].frames[0].renderId,
    photoId: photos[0].id,
    width: 1200,
    height: 800,
    arLabel: null,
  }, 'a frame carries ids and geometry — nothing else');
});

test('a room with no roomType falls back to a humanized key, never a blank heading', async () => {
  app = await mountShare();
  const { project } = seedListing(app, { photoCount: 1, roomKey: 'primary-bath-2', roomType: null });
  const token = share(app, project);
  const { listing } = await (await get(app.baseUrl, `/api/share/${token}`)).json();
  assert.equal(listing.rooms[0].label, 'Primary bath 2');
});

test('the share page is served for ANY token, so the HTML route is not an oracle', async () => {
  // No lookup happens there at all: a real, a revoked and an invented token get the same
  // shell, which is what makes the route impossible to probe with.
  app = await mountShare();
  const { project } = seedListing(app);
  const token = share(app, project);
  app.shares.revokeSharesFor(project.id);

  for (const candidate of [token, 'utter-nonsense', 'C'.repeat(43)]) {
    const res = await get(app.baseUrl, `/s/${candidate}`);
    assert.equal(res.status, 200, `/s/${candidate} must serve the shell`);
    assert.equal(await res.text(), SHELL_HTML);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  }
});

test('a missing share page answers the uniform 404 rather than a stack trace', async () => {
  app = await mountShare();
  fs.rmSync(path.join(app.dir, 'public', SHARE_PAGE_FILE));
  const res = await get(app.baseUrl, '/s/anything');
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'NOT_FOUND');
});

// ── The manifest is an allowlist ─────────────────────────────────────────────

test('the manifest leaks no internals — asserted against the raw JSON, not picked keys', async () => {
  // A `...project` / `...render` spread is the failure this catches: it would publish the
  // owner's id, the storage keys, the prompt, the model and the reviewer's scores.
  app = await mountShare();
  const { project, photos, renders } = seedListing(app);
  const row = app.projects.getRender(renders[0].id);
  row.promptText = 'Stage this living room in mid-century modern, warm light';
  row.model = 'gemini-2.5-flash-image-preview';
  row.qualityScore = 0.91;
  row.consistencyScore = 0.77;
  row.errorCode = 'GEN_TIMEOUT';
  row.bibleId = 'b_secret';
  app.projects.updateProject(project.id, { extraJson: JSON.stringify({ jobSettings: { furnitureStyle: 'mid-century' } }) });
  const token = share(app, project);

  const raw = await (await get(app.baseUrl, `/api/share/${token}`)).text();
  for (const forbidden of [
    'userId', 'u_broker', 'storageKey', 'projects/', 'promptText', 'mid-century',
    'gemini', 'model', 'qualityScore', 'consistencyScore', 'errorCode', 'GEN_TIMEOUT',
    'bibleId', 'b_secret', 'sha256', 'sha-', 'createdAt', 'updatedAt', 'claimedAt',
    'genAttempts', 'durationMs', 'extra', token,
  ]) {
    assert.ok(!raw.includes(forbidden), `the public manifest must not contain ${forbidden}: ${raw}`);
  }
  // And the ids it DOES carry are the two the byte routes take, nothing more.
  assert.ok(raw.includes(renders[0].id));
  assert.ok(raw.includes(photos[0].id));
});

test('the manifest is no-store, no-referrer and noindex', async () => {
  app = await mountShare();
  const { project } = seedListing(app);
  const token = share(app, project);
  const res = await get(app.baseUrl, `/api/share/${token}`);
  assert.equal(res.headers.get('cache-control'), SHARE_NO_STORE, 'never `public` — no shared proxy may keep a listing');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer', 'the token is in the path');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
});

// ── showBefore ───────────────────────────────────────────────────────────────

test('showBefore:false nulls every photoId AND makes the photo byte route 404', async () => {
  // Both halves matter: a null in the manifest with a live byte route would still hand
  // over the seller's unstaged rooms to anyone who guessed the (listed) render ids.
  app = await mountShare();
  const { project, photos } = seedListing(app);
  const token = share(app, project, { showBefore: false });

  const { listing } = await (await get(app.baseUrl, `/api/share/${token}`)).json();
  assert.equal(listing.showBefore, false);
  const ids = listing.rooms.flatMap((/** @type {any} */ r) => r.frames.map((/** @type {any} */ f) => f.photoId));
  assert.deepEqual(ids, [null, null]);

  const res = await get(app.baseUrl, `/api/share/${token}/photo/${photos[0].id}`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'NOT_FOUND');
  // The staged output is still served — only the ORIGINAL is withheld.
  assert.equal((await get(app.baseUrl, `/api/share/${token}/render/${listing.rooms[0].frames[0].renderId}`)).status, 200);
});

test('showBefore:true serves the ORIGINAL bytes, byte for byte', async () => {
  app = await mountShare();
  const { project, photos } = seedListing(app);
  const token = share(app, project, { showBefore: true });
  const res = await get(app.baseUrl, `/api/share/${token}/photo/${photos[0].id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG_1X1);
});

test('showBefore does not expose an original whose frame is not published', async () => {
  // The seller's excluded junk room is not part of what the broker chose to publish, so
  // its original stays private even though before/after is on.
  app = await mountShare();
  const { project, photos } = seedListing(app, { photoCount: 3 });
  app.projects.updatePhoto(photos[2].id, { frameRole: 'excluded' });
  const token = share(app, project, { showBefore: true });

  const { listing } = await (await get(app.baseUrl, `/api/share/${token}`)).json();
  assert.equal(listing.frameCount, 2, 'an excluded frame leaves the gallery immediately');
  assert.equal((await get(app.baseUrl, `/api/share/${token}/photo/${photos[2].id}`)).status, 404);
  assert.equal((await get(app.baseUrl, `/api/share/${token}/photo/${photos[1].id}`)).status, 200, 'control');
});

test('a photo with no render at all is never servable, published or not', async () => {
  app = await mountShare();
  const { project, photos } = seedListing(app, { photoCount: 2, render: false });
  const token = share(app, project, { showBefore: true });
  const { listing } = await (await get(app.baseUrl, `/api/share/${token}`)).json();
  assert.deepEqual(listing.rooms, [], 'a room with no published frame is not listed');
  assert.equal(listing.frameCount, 0);
  assert.equal((await get(app.baseUrl, `/api/share/${token}/photo/${photos[0].id}`)).status, 404);
});

// ── Only finished renders are public ─────────────────────────────────────────

test('failed, superseded and queued renders are absent from the manifest AND 404 on bytes', async () => {
  app = await mountShare();
  const { project, photos, renders } = seedListing(app, { photoCount: 1 });
  const failed = finish(app, project, photos[0], 'half-baked');
  failed.status = 'failed';
  failed.errorCode = 'GEN_FAILED';
  const superseded = finish(app, project, photos[0], 'old-bible');
  superseded.status = 'superseded';
  const queued = app.projects.enqueueRender({ projectId: project.id, photoId: photos[0].id });
  const token = share(app, project);

  const raw = await (await get(app.baseUrl, `/api/share/${token}`)).text();
  const { listing } = JSON.parse(raw);
  assert.equal(listing.frameCount, 1, 'only the one `ok` render is public');
  assert.equal(listing.rooms[0].frames[0].renderId, renders[0].id);
  for (const hidden of [failed, superseded, queued]) {
    assert.ok(!raw.includes(`"${hidden.id}"`), `${hidden.status} renders must not appear in the manifest`);
    const res = await get(app.baseUrl, `/api/share/${token}/render/${hidden.id}`);
    assert.equal(res.status, 404, `${hidden.status} renders must not be servable`);
  }
  // The failed render's bytes DO exist on disk — so this pins the status check, not a
  // missing blob.
  assert.equal(app.storage.blobs.get(failed.storageKey).toString(), 'half-baked');
});

test('an ok render whose blob is gone is a 404, not a 500 or an empty 200', async () => {
  app = await mountShare();
  const { project, renders } = seedListing(app);
  app.storage.blobs.delete(renders[0].storageKey);
  const res = await get(app.baseUrl, `/api/share/${share(app, project)}/render/${renders[0].id}`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'NOT_FOUND');
});

test('render bytes carry nosniff and a private immutable policy, never `public`', async () => {
  app = await mountShare();
  const { project, renders } = seedListing(app);
  const res = await get(app.baseUrl, `/api/share/${share(app, project)}/render/${renders[0].id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/webp');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cache-control'), SHARE_BYTE_CACHE);
  assert.ok(!/public/.test(String(res.headers.get('cache-control'))));
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
});

// ── View counting ────────────────────────────────────────────────────────────

test('the manifest counts one view, and a second immediate request does not double-count', async () => {
  app = await mountShare();
  const { project } = seedListing(app);
  const tok = share(app, project);
  assert.equal(app.shares.activeShareFor(project.id).viewCount, 0);

  await get(app.baseUrl, `/api/share/${tok}`);
  assert.equal(app.shares.activeShareFor(project.id).viewCount, 1);
  await get(app.baseUrl, `/api/share/${tok}`);
  assert.equal(app.shares.activeShareFor(project.id).viewCount, 1, 'the store debounces; a re-opened tab is one visit');
});

test('the BYTE routes never count a view — one gallery page is not forty visits', async () => {
  app = await mountShare();
  const { project, photos, renders } = seedListing(app, { photoCount: 2 });
  const tok = share(app, project, { showBefore: true });
  for (const render of renders) await get(app.baseUrl, `/api/share/${tok}/render/${render.id}`);
  for (const photo of photos) await get(app.baseUrl, `/api/share/${tok}/photo/${photo.id}`);
  assert.equal(app.shares.activeShareFor(project.id).viewCount, 0);
  assert.equal((await get(app.baseUrl, `/s/${tok}`)).status, 200);
  assert.equal(app.shares.activeShareFor(project.id).viewCount, 0, 'nor does the page shell');
});

test('a rejected token never counts a view', async () => {
  app = await mountShare();
  const { project } = seedListing(app);
  const tok = share(app, project);
  app.shares.revokeSharesFor(project.id);
  await get(app.baseUrl, `/api/share/${tok}`);
  const rows = app.shares.listSharesFor(project.id);
  assert.equal(rows[0].viewCount, 0);
});

// ── Rate limiting ────────────────────────────────────────────────────────────

test('the injected shareLimiter runs on all four routes', async () => {
  // Unauthenticated + reads blobs off disk: an unlimited route here is a free CDN and a
  // free brute-force budget in one.
  /** @type {string[]} */
  const seen = [];
  app = await mountShare({
    shareLimiter: (/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ next) => {
      seen.push(req.path);
      next();
    },
  });
  const { project, photos, renders } = seedListing(app);
  const tok = share(app, project, { showBefore: true });
  await get(app.baseUrl, `/s/${tok}`);
  await get(app.baseUrl, `/api/share/${tok}`);
  await get(app.baseUrl, `/api/share/${tok}/render/${renders[0].id}`);
  await get(app.baseUrl, `/api/share/${tok}/photo/${photos[0].id}`);
  assert.equal(seen.length, 4, `every route must be limited, saw: ${seen.join(', ')}`);
});

// ── 5xx hygiene ──────────────────────────────────────────────────────────────

test('an unexpected store failure returns a ref, never the exception text', async () => {
  app = await mountShare();
  const { project } = seedListing(app);
  const tok = share(app, project);
  app.deps.projects.getProject = () => { throw new Error('SQLITE_CORRUPT: /srv/data/auth-store.db'); };
  const res = await get(app.baseUrl, `/api/share/${tok}`);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.ref, /^[0-9a-f]{8}$/);
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('SQLITE_CORRUPT'), 'the exception text must not reach an anonymous caller');
  assert.ok(!raw.includes('/srv/data'), 'nor an absolute server path');
});

// ── The heading a buyer reads ────────────────────────────────────────────────

test('the not-a-room token never reaches the page as a heading', async () => {
  // `Other` is the clusterer's internal word for an exterior/garage/stairwell. It was being
  // used verbatim as a section heading on the page a seller and their buyers read — an
  // internal vocabulary value leaking onto the most customer-facing surface in the app.
  // Found by walking the real page, not by a test.
  assert.equal(roomLabel(OTHER_ROOM_TYPE, 'other-1'), OTHER_ROOM_LABEL);
  assert.notEqual(OTHER_ROOM_LABEL, OTHER_ROOM_TYPE);
  assert.match(OTHER_ROOM_LABEL, /^[A-Z][a-z]/, 'it reads as English, not as an enum');

  // The key alone is enough: a frame can carry `other-1` with the type since cleared, and
  // humanizing that key would produce "Other 1" — the same leak by another route.
  assert.equal(roomLabel('', 'other-1'), OTHER_ROOM_LABEL);
  assert.equal(roomLabel('', 'other'), OTHER_ROOM_LABEL);
});

test('a real room keeps its own name, and an unlabelled one is humanized', () => {
  assert.equal(roomLabel('Living room', 'living-room-1'), 'Living room');
  assert.equal(roomLabel('', 'living-room-1'), 'Living room 1');
  // 'Otherwise' must not be caught by the not-a-room check.
  assert.equal(roomLabel('Otherwise', 'otherwise-1'), 'Otherwise');
  assert.equal(roomLabel('', 'otherwise-1'), 'Otherwise 1');
});
