// Tier: integration — the WHOLE client-share journey, across both routers and the real
// stores, over real HTTP.
//
// WHY THIS FILE EXISTS ALONGSIDE THE TWO UNIT SUITES
// routes/projects-share.js is tested against its own store, and routes/share-public.js is
// tested against its own. Both pass with a token that never crosses between them. The
// thing a customer actually does — a broker mints a link in the studio, texts it to their
// seller, and the seller opens it on a phone with no account — touches TWO routers, TWO
// auth models and ONE database, and every defect worth having here lives in that seam:
//
//   * the minted token has to hash to the digest the public resolver looks up (two modules
//     agreeing on `hashToken` is an assumption, not a fact, until a token travels);
//   * the URL the studio hands the broker has to be a URL the public router serves;
//   * revoking in the studio has to kill the link the seller already has, on the NEXT
//     request rather than the next restart;
//   * deleting the listing has to kill it too, through a cascade neither suite can see.
//
// So this suite mints through the authenticated API and consumes through the public one,
// with nothing shared but the database and the token string. Real SQLite in a temp dir;
// blobs in an in-memory fake, since the bytes are incidental here.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createProjects } from '../../lib/data/projects.js';
import { closeDb } from '../../lib/data/db.js';
import { createAsyncRouter } from '../../lib/http/async-router.js';
import { sendError } from '../../lib/http/http-helpers.js';
import { registerShareRoutes } from '../../routes/projects-share.js';
import { registerFeedbackRoutes } from '../../routes/share-feedback.js';
import createSharePublicRouter from '../../routes/share-public.js';
import { STAGING_DISCLOSURE } from '../../lib/staging/staging-disclosure.js';

const T0 = Date.UTC(2026, 6, 30, 12);
const APP_URL = 'https://stagify.test';
const OWNER = { id: 'u_broker', email: 'broker@example.com', plan: 'pro' };

/** @type {{ close: () => Promise<unknown>, dir: string } | null} */
let live = null;

afterEach(async () => {
  if (!live) return;
  const { close, dir } = live;
  live = null;
  await close();
  // Windows cannot unlink the .db/-wal/-shm files while the shared handle is open.
  closeDb(dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** An in-memory blob store with the two methods both routers use. */
function fakeStorage() {
  /** @type {Map<string, Buffer>} */
  const blobs = new Map();
  return {
    blobs,
    /** @param {string} key @returns {Promise<Buffer>} */
    read: (key) => (blobs.has(key) ? Promise.resolve(/** @type {Buffer} */ (blobs.get(key))) : Promise.reject(new Error('ENOENT'))),
    /** @param {string} key @returns {Promise<{ bytes: number } | null>} */
    stat: (key) => Promise.resolve(blobs.has(key) ? { bytes: /** @type {Buffer} */ (blobs.get(key)).length } : null),
  };
}

/**
 * Boot ONE express app carrying both routers over one real database — the arrangement
 * server.js produces, minus everything irrelevant to sharing.
 * @param {{ signedIn?: boolean }} [opts] - Whether the studio half sees a Stagify+ session.
 */
async function boot({ signedIn = true } = {}) {
  const session = { signedIn };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-shareflow-'));
  const projects = createProjects(dir);
  const storage = fakeStorage();

  const app = express();
  app.use(express.json());

  // The studio half, wired exactly as routes/projects.js wires it.
  const owner = createAsyncRouter();
  registerShareRoutes({
    router: owner,
    shares: projects.shares,
    requireProAccount: (req, res) => {
      if (session.signedIn) return OWNER;
      sendError(res, 401, 'Sign in required', { code: 'AUTH_REQUIRED' });
      return null;
    },
    guard: (context, fn) => async (req, res) => {
      try {
        await fn(req, res);
      } catch {
        if (!res.headersSent) sendError(res, 500, 'Request failed', { ref: context });
      }
    },
    notFound: (res) => sendError(res, 404, 'Not found', { code: 'NOT_FOUND' }),
    ownedProject: (req, user) => {
      const project = projects.getProject(String(req.params.id));
      return !project || project.userId !== user.id ? null : project;
    },
    setSensitiveHeaders: () => {},
    appUrl: APP_URL,
  });
  // Seller sign-off rides on the same router as the owner controls — that is where
  // `ownedProject` lives, and routes/projects.js registers it the same way. Its two PUBLIC
  // routes come along with it, which is exactly the arrangement worth testing here.
  registerFeedbackRoutes({
    router: owner,
    shares: projects.shares,
    feedback: projects.feedback,
    projects,
    requireProAccount: (req, res) => {
      if (session.signedIn) return OWNER;
      sendError(res, 401, 'Sign in required', { code: 'AUTH_REQUIRED' });
      return null;
    },
    guard: (context, fn) => async (req, res) => {
      try {
        await fn(req, res);
      } catch {
        if (!res.headersSent) sendError(res, 500, 'Request failed', { ref: context });
      }
    },
    notFound: (res) => sendError(res, 404, 'Not found', { code: 'NOT_FOUND' }),
    ownedProject: (req, user) => {
      const project = projects.getProject(String(req.params.id));
      return !project || project.userId !== user.id ? null : project;
    },
    setSensitiveHeaders: () => {},
    feedbackLimiter: (req, res, next) => next(),
  });
  app.use(owner);

  // The public half. No auth of any kind — that is the point of it.
  app.use(createSharePublicRouter({
    shares: projects.shares,
    projects,
    storage,
    shareLimiter: (req, res, next) => next(),
    __dirname: process.cwd(),
  }));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = /** @type {any} */ (server.address());
  const baseUrl = `http://127.0.0.1:${port}`;
  live = { dir, close: () => new Promise((r) => server.close(() => r(undefined))) };
  // `session` is mutable so ONE app can be driven signed-in and then anonymous. Booting a
  // second app inside a test would leak the first server and hang the runner.
  return { baseUrl, projects, storage, dir, session };
}

/**
 * A listing with one staged room: a hero and a support frame, both with an `ok` render
 * whose blob exists. The shape a broker would actually share.
 * @param {Awaited<ReturnType<typeof boot>>} app - The booted app.
 */
function stagedListing(app) {
  const project = app.projects.createProject({ userId: OWNER.id, title: '12 Oak Avenue', address: '12 Oak Ave, Denver', now: T0 });
  const photos = ['hero', 'support'].map((role, i) => {
    const added = app.projects.addPhoto({
      projectId: project.id,
      storageKey: `projects/${project.id}/src/photo${i}.webp`,
      sha256: `sha-${i}`, seq: i, width: 1536, height: 1024, arLabel: '3:2',
      roomKey: 'living-room-1', roomType: 'Living room', frameRole: role, now: T0,
    });
    assert.equal(added.ok, true, 'precondition: photo added');
    const photo = /** @type {any} */ (added).photo;
    app.storage.blobs.set(photo.storageKey, Buffer.from(`before-${i}`));
    return photo;
  });
  const renders = photos.map((photo, i) => {
    const render = app.projects.enqueueRender({ projectId: project.id, photoId: photo.id, variation: 1, now: T0 });
    const key = `projects/${project.id}/out/${render.id}.webp`;
    app.storage.blobs.set(key, Buffer.from(`after-${i}`));
    app.projects.claimNextRender({ now: T0 });
    app.projects.completeRender(render.id, { storageKey: key, qualityScore: 9, now: T0 });
    return app.projects.getRender(render.id);
  });
  return { project, photos, renders };
}

/**
 * Mint a link through the AUTHENTICATED API — never by calling the store directly, which
 * is what makes this an integration test rather than a second unit test.
 * @param {string} baseUrl - The app's origin.
 * @param {string} projectId - Listing to share.
 * @param {Record<string, unknown>} [body] - Settings/expiry.
 */
async function mint(baseUrl, projectId, body = {}) {
  const res = await fetch(`${baseUrl}/api/projects/${projectId}/share`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, `precondition: minting failed with ${res.status}`);
  return res.json();
}

/** The path a share URL resolves to on this origin — i.e. what the broker pastes. */
function pathOf(url) {
  return new URL(url).pathname;
}

// ── The journey ─────────────────────────────────────────────────────────────

test('a link minted in the studio opens, with no session, on the URL the studio handed over', async () => {
  const app = await boot();
  const { project } = stagedListing(app);

  const { url, token } = await mint(app.baseUrl, project.id, { settings: { agentName: 'Dana Reyes' } });
  assert.equal(url, `${APP_URL}/s/${token}`, 'the broker is handed an absolute, sendable URL');

  // The seller opens the page. No cookie, no Authorization header — a different origin's
  // path, resolved against this test server.
  const page = await fetch(`${app.baseUrl}${pathOf(url)}`);
  assert.equal(page.status, 200, 'the gallery shell must serve to an anonymous visitor');

  const manifest = await fetch(`${app.baseUrl}/api/share/${token}`);
  assert.equal(manifest.status, 200);
  const { listing } = await manifest.json();
  assert.equal(listing.title, '12 Oak Avenue');
  assert.equal(listing.agent.name, 'Dana Reyes');
  assert.equal(listing.frameCount, 2);
  assert.equal(listing.rooms.length, 1);
  assert.equal(listing.disclosure, STAGING_DISCLOSURE,
    'the page must carry the disclosure the broker is legally relying on');

  // And the pixels themselves resolve, which is the part a manifest test cannot prove.
  const frame = listing.rooms[0].frames[0];
  const after = await fetch(`${app.baseUrl}/api/share/${token}/render/${frame.renderId}`);
  assert.equal(after.status, 200);
  assert.equal(Buffer.from(await after.arrayBuffer()).toString(), 'after-0');
  const before = await fetch(`${app.baseUrl}/api/share/${token}/photo/${frame.photoId}`);
  assert.equal(before.status, 200);
  assert.equal(Buffer.from(await before.arrayBuffer()).toString(), 'before-0');
});

test('the studio never hands back a token it can read again', async () => {
  const app = await boot();
  const { project } = stagedListing(app);
  const { token } = await mint(app.baseUrl, project.id);

  const status = await fetch(`${app.baseUrl}/api/projects/${project.id}/share`);
  const body = await status.text();
  assert.equal(status.status, 200);
  assert.equal(body.includes(token), false,
    'a read-back path would make hashing the token at rest pointless');
  // But it must still be able to SAY there is a live link, or the studio cannot render its
  // own state after a reload.
  assert.equal(JSON.parse(body).share?.revokedAt, null);
});

test('revoking in the studio kills the link the seller already has, on the next request', async () => {
  const app = await boot();
  const { project } = stagedListing(app);
  const { token } = await mint(app.baseUrl, project.id);
  const frame = (await (await fetch(`${app.baseUrl}/api/share/${token}`)).json()).listing.rooms[0].frames[0];

  const revoked = await fetch(`${app.baseUrl}/api/projects/${project.id}/share`, { method: 'DELETE' });
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json()).revoked, 1);

  // No restart, no cache flush — the check is per request, which is the only version of
  // "revoke" that means anything to the person who clicked it.
  assert.equal((await fetch(`${app.baseUrl}/api/share/${token}`)).status, 404);
  assert.equal((await fetch(`${app.baseUrl}/api/share/${token}/render/${frame.renderId}`)).status, 404,
    'the bytes must go dark too, not just the manifest');
  assert.equal((await fetch(`${app.baseUrl}/api/share/${token}/photo/${frame.photoId}`)).status, 404);
});

test('rotating hands out a new link and kills the old one in the same call', async () => {
  const app = await boot();
  const { project } = stagedListing(app);
  const first = await mint(app.baseUrl, project.id);
  const second = await mint(app.baseUrl, project.id);

  assert.equal(second.replaced, 1);
  assert.equal((await fetch(`${app.baseUrl}/api/share/${first.token}`)).status, 404,
    'the link the broker over-shared must be dead the moment they rotate it');
  assert.equal((await fetch(`${app.baseUrl}/api/share/${second.token}`)).status, 200);
});

test('editing settings does not break the link already in the seller\'s messages', async () => {
  const app = await boot();
  const { project } = stagedListing(app);
  const { token } = await mint(app.baseUrl, project.id, { settings: { headline: 'Coming soon' } });

  const patched = await fetch(`${app.baseUrl}/api/projects/${project.id}/share`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { headline: 'Just listed', showBefore: false } }),
  });
  assert.equal(patched.status, 200);

  const { listing } = await (await fetch(`${app.baseUrl}/api/share/${token}`)).json();
  assert.equal(listing.headline, 'Just listed', 'the change must be live on the same URL');
  assert.equal(listing.showBefore, false);
  assert.equal(listing.rooms[0].frames[0].photoId, null,
    'turning before/after off must withdraw the originals, not merely hide them');
});

test('turning before/after off closes the original-photo route, not just the manifest field', async () => {
  const app = await boot();
  const { project, photos } = stagedListing(app);
  const { token } = await mint(app.baseUrl, project.id, { settings: { showBefore: false } });
  const res = await fetch(`${app.baseUrl}/api/share/${token}/photo/${photos[0].id}`);
  assert.equal(res.status, 404,
    'a client that remembers the id from a previous visit must not still get the unstaged room');
});

test('deleting the listing kills its link, through the cascade', async () => {
  const app = await boot();
  const { project } = stagedListing(app);
  const { token } = await mint(app.baseUrl, project.id);
  assert.equal((await fetch(`${app.baseUrl}/api/share/${token}`)).status, 200, 'precondition');

  // Straight through the store, as DELETE /api/projects/:id does.
  app.projects.deleteProject(project.id);
  assert.equal((await fetch(`${app.baseUrl}/api/share/${token}`)).status, 404,
    'a link outliving its listing is a live URL into deleted data');
});

test('erasing the account kills every link it ever minted', async () => {
  const app = await boot();
  const a = stagedListing(app);
  const b = stagedListing(app);
  const tokens = [
    (await mint(app.baseUrl, a.project.id)).token,
    (await mint(app.baseUrl, b.project.id)).token,
  ];

  app.projects.deleteProjectsForUser(OWNER.id);
  for (const token of tokens) {
    assert.equal((await fetch(`${app.baseUrl}/api/share/${token}`)).status, 404,
      'the subject asked for their home to be gone from the internet');
  }
});

test('an expired link stops working without anyone touching it', async () => {
  const app = await boot();
  const { project } = stagedListing(app);
  // 1 day is the shortest the API accepts; the store's clock is what decides, so drive it
  // through the real route and then read the row's own expiry back.
  const { token, share } = await mint(app.baseUrl, project.id, { expiresInDays: 1 });
  assert.ok(share.expiresAt > Date.now(), 'precondition: it is live now');
  assert.equal((await fetch(`${app.baseUrl}/api/share/${token}`)).status, 200);

  // Expire it the way time would, then confirm the door is shut with no other action.
  app.projects.shares.updateShare(share.id, { settings: share.settings, expiresAt: Date.now() - 1 });
  assert.equal((await fetch(`${app.baseUrl}/api/share/${token}`)).status, 404);
});

// ── Seller sign-off ─────────────────────────────────────────────────────────

/**
 * Answer as the seller would, through the PUBLIC route only.
 * @param {string} baseUrl - Origin.
 * @param {string} token - The share token they were sent.
 * @param {Record<string, unknown>} body - The response.
 */
async function answer(baseUrl, token, body) {
  const res = await fetch(`${baseUrl}/api/share/${token}/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test("the seller's answer reaches the broker's inbox, with no account on either side of the send", async () => {
  const app = await boot();
  const { project } = stagedListing(app);
  const { token } = await mint(app.baseUrl, project.id);

  const sent = await answer(app.baseUrl, token, {
    roomKey: 'living-room-1',
    verdict: 'changes',
    note: 'Sofa is too big for that wall',
    viewerLabel: 'Dana',
  });
  assert.equal(sent.status, 200, 'an anonymous seller must be able to answer');

  const inbox = await (await fetch(`${app.baseUrl}/api/projects/${project.id}/feedback`)).json();
  assert.equal(inbox.feedback.length, 1);
  assert.equal(inbox.feedback[0].note, 'Sofa is too big for that wall');
  assert.equal(inbox.feedback[0].roomKey, 'living-room-1');
  assert.equal(inbox.feedback[0].projectId, project.id, 'filed against the right listing');
  assert.equal(inbox.feedback[0].userId, OWNER.id, 'and the right account');
});

test("a hostile body cannot file a response against somebody else's listing", async () => {
  // The single most important test on this surface: the listing and the account come from
  // the RESOLVED SHARE, so the body's opinion about them has to be inert.
  const app = await boot();
  const mine = stagedListing(app);
  const theirs = app.projects.createProject({ userId: 'u_victim', title: 'Not mine', now: T0 });
  const { token } = await mint(app.baseUrl, mine.project.id);

  const sent = await answer(app.baseUrl, token, {
    verdict: 'approved',
    projectId: theirs.id,
    userId: 'u_victim',
    shareId: 'anything',
  });
  assert.equal(sent.status, 200);

  assert.equal(app.projects.feedback.listForProject(theirs.id).length, 0,
    'a body-supplied projectId must be inert');
  const stored = app.projects.feedback.listForProject(mine.project.id);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].userId, OWNER.id, 'and a body-supplied userId too');
});

test('the anonymous read never carries the owner or any internal id', async () => {
  const app = await boot();
  const { project } = stagedListing(app);
  const { token } = await mint(app.baseUrl, project.id);
  await answer(app.baseUrl, token, { roomKey: 'living-room-1', verdict: 'approved' });

  const raw = await (await fetch(`${app.baseUrl}/api/share/${token}/feedback`)).text();
  for (const secret of [OWNER.id, project.id, 'userId', 'projectId', 'shareId']) {
    assert.equal(raw.includes(secret), false, `the public projection leaked ${secret}`);
  }
  assert.equal(JSON.parse(raw).responses[0].verdict, 'approved', 'but the answer itself comes back');
});

test('a viewer cannot comment on a room the gallery does not show them', async () => {
  const app = await boot();
  const { project } = stagedListing(app);
  const { token } = await mint(app.baseUrl, project.id);

  const invented = await answer(app.baseUrl, token, { roomKey: 'no-such-room', verdict: 'approved' });
  assert.equal(invented.status, 400, "an invented room must not land in the broker's inbox");
  assert.equal(app.projects.feedback.listForProject(project.id).length, 0, 'and must write nothing');

  // Whole-listing feedback stays valid with no room at all.
  assert.equal((await answer(app.baseUrl, token, { verdict: 'approved' })).status, 200);
  assert.equal(app.projects.feedback.listForProject(project.id)[0].roomKey, null);
});

test('revoking the link stops the seller answering, not just looking', async () => {
  const app = await boot();
  const { project } = stagedListing(app);
  const { token } = await mint(app.baseUrl, project.id);
  assert.equal((await answer(app.baseUrl, token, { verdict: 'approved' })).status, 200);

  await fetch(`${app.baseUrl}/api/projects/${project.id}/share`, { method: 'DELETE' });

  const after = await answer(app.baseUrl, token, { verdict: 'changes', note: 'still here' });
  assert.equal(after.status, 404, 'a revoked link is a dead credential for writes too');
  assert.equal(app.projects.feedback.listForProject(project.id).length, 1, 'and wrote nothing');
});

test("rotating the link hides the previous holder's notes from the new one, but not from the broker", async () => {
  const app = await boot();
  const { project } = stagedListing(app);
  const first = await mint(app.baseUrl, project.id);
  await answer(app.baseUrl, first.token, { roomKey: 'living-room-1', verdict: 'changes', note: 'First holder' });

  const second = await mint(app.baseUrl, project.id);
  const fresh = await (await fetch(`${app.baseUrl}/api/share/${second.token}/feedback`)).json();
  assert.deepEqual(fresh.responses, [], "whoever holds today's link must not read yesterday's notes");

  const inbox = await (await fetch(`${app.baseUrl}/api/projects/${project.id}/feedback`)).json();
  assert.equal(inbox.feedback.length, 1, 'the broker keeps their own history');
  assert.equal(inbox.feedback[0].note, 'First holder');
});

test("the owner inbox is gated, and 404s (never 403) for another account's listing", async () => {
  const app = await boot();
  const { project } = stagedListing(app);
  const { token } = await mint(app.baseUrl, project.id);
  await answer(app.baseUrl, token, { verdict: 'approved', note: 'private' });

  app.session.signedIn = false;
  const anon = await fetch(`${app.baseUrl}/api/projects/${project.id}/feedback`);
  assert.equal(anon.status, 401);
  assert.equal((await anon.text()).includes('private'), false);

  app.session.signedIn = true;
  const foreign = app.projects.createProject({ userId: 'u_someone_else', title: 'Theirs', now: T0 });
  const res = await fetch(`${app.baseUrl}/api/projects/${foreign.id}/feedback`);
  assert.equal(res.status, 404);
  assert.notEqual(res.status, 403);
});

test("deleting the listing takes the seller's notes with it", async () => {
  const app = await boot();
  const { project } = stagedListing(app);
  const { token } = await mint(app.baseUrl, project.id);
  await answer(app.baseUrl, token, { verdict: 'changes', note: 'a private remark about this home' });

  app.projects.deleteProject(project.id);
  assert.equal(app.projects.feedback.listForProject(project.id).length, 0);
  assert.equal((await answer(app.baseUrl, token, { verdict: 'approved' })).status, 404,
    'and the link cannot be used to write more');
});

test('an anonymous visitor cannot reach the studio half of the same listing', async () => {
  // The two routers sit on ONE app. The public one has no auth by design, so the test that
  // matters is that mounting it did not make the authenticated one reachable too.
  const app = await boot();
  const { project } = stagedListing(app);
  const { token } = await mint(app.baseUrl, project.id);
  app.session.signedIn = false;

  for (const [method, route] of [
    ['GET', `/api/projects/${project.id}/share`],
    ['POST', `/api/projects/${project.id}/share`],
    ['PATCH', `/api/projects/${project.id}/share`],
    ['DELETE', `/api/projects/${project.id}/share`],
  ]) {
    const res = await fetch(`${app.baseUrl}${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : '{}',
    });
    assert.equal(res.status, 401, `${method} ${route} must stay gated`);
  }
  // And holding a token buys nothing on that side.
  const withToken = await fetch(`${app.baseUrl}/api/projects/${project.id}/share`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(withToken.status, 401, 'a share token is not a session');
});
