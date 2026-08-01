// Tier: route contract (REAL share + feedback stores on a throwaway SQLite dir, fake project
// ownership) — routes/share-feedback.js, the seller sign-off loop.
//
// WHY THIS FILE IS THE PARANOID ONE
// `POST /api/share/:token/feedback` is the only endpoint in the product where an ANONYMOUS
// caller writes FREE TEXT to the volume the database and every customer's photographs live
// on. The router IS the access-control system, so the tests that matter are not "does it
// save":
//
//   * THE IDS COME FROM THE SHARE, NEVER THE BODY. Asserted with a deliberately hostile
//     body carrying another tenant's `projectId`/`userId`. Without that rule anyone holding
//     ANY live link could file rows onto somebody else's listing, and nothing else here
//     would notice.
//   * A REVOKED LINK CANNOT WRITE. Revoked, expired, garbage and blank tokens are compared
//     to EACH OTHER byte for byte — asserting "each is 404" would pass a router whose
//     bodies said REVOKED vs NOT_FOUND, which is a working oracle over the token keyspace.
//     And each rejection is asserted to have written NOTHING, because a refusal that still
//     inserts is the actual failure being guarded against.
//   * THE PUBLIC PROJECTION LEAKS NOTHING. Asserted against the raw serialized JSON, not
//     hand-picked keys, so a `...row` spread fails here rather than shipping the broker's
//     account id to a stranger.
//   * THE READ-BACK IS PER LINK, NOT PER LISTING. After a rotation the new link must see
//     none of the previous viewer's notes about somebody's house.
//   * THE CEILING REFUSES CALMLY. A seller hitting a cap they cannot see gets a coded 409,
//     not a crash, and the row count does not move.
//   * A RESPONSE IS ABOUT A ROOM THE VIEWER COULD SEE. The load-bearing case is not the
//     invented room key — it is the room that EXISTS in the database and is absent from the
//     gallery (an excluded frame, a failed render), because that is where the route's rule
//     and `isPublishableFrame` could quietly drift apart.
//
// Both share/feedback stores are REAL (one throwaway data dir, one shared connection)
// because REVOKED / EXPIRED, the text clamps and the per-share ceiling are exactly the
// behaviours under test — a fake would be re-asserting the fake. The project store is the
// in-memory fake from test/helpers/projects-app.js, since routes/projects.js owns ownership
// resolution and injects it.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createAsyncRouter } from '../../lib/http/async-router.js';
import { sendError, setSensitiveHeaders } from '../../lib/http/http-helpers.js';
import { reportError } from '../../lib/http/error-ref.js';
import { createFakeProjects } from '../helpers/projects-app.js';
import { createProjectShares } from '../../lib/data/project-shares.js';
import { createShareFeedback, MAX_NOTE, MAX_PER_SHARE, MAX_VIEWER_LABEL } from '../../lib/data/share-feedback.js';
import { closeDb } from '../../lib/data/db.js';
import { SHARE_NO_STORE } from '../../routes/share-public.js';
import { registerFeedbackRoutes, publicFeedback, OWNER_FEEDBACK_LIMIT } from '../../routes/share-feedback.js';

const USER_A = { id: 'u_broker', email: 'broker@example.com', plan: 'pro' };
const USER_B = { id: 'u_rival', email: 'rival@example.com', plan: 'pro' };

/** @type {string[]} */
const dirs = [];
/** @type {any} */
let app = null;

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
 * Give a listing one room: a photo grouped under `roomKey` plus, unless told otherwise, a
 * finished render — which is the ONLY state routes/share-public.js publishes, and therefore
 * the only state that makes a room commentable.
 *
 * The non-default shapes are the point: `render: 'none'|'failed'|'queued'`, `frameRole:
 * 'excluded'` and `stageable: false` each produce a room that EXISTS in the database and is
 * absent from the gallery.
 * @param {any} projects - The fake project store.
 * @param {any} project - The project row.
 * @param {string|Record<string, any>} spec - A room key, or the full shape.
 * @returns {any} The photo row.
 */
function addRoom(projects, project, spec) {
  const { roomKey, render = 'ok', frameRole = 'hero', stageable = true } =
    typeof spec === 'string' ? { roomKey: spec } : /** @type {any} */ (spec);
  const { photo } = projects.addPhoto({
    projectId: project.id,
    storageKey: `projects/${project.id}/src/${roomKey}.png`,
    sha256: `sha-${project.id}-${roomKey}`,
  });
  projects.updatePhoto(photo.id, { roomKey, roomType: null, stageable, frameRole });
  if (render === 'none') return photo;
  const row = projects.enqueueRender({ projectId: project.id, photoId: photo.id });
  row.status = render;
  if (render === 'ok') row.storageKey = `projects/${project.id}/out/${row.id}.webp`;
  return photo;
}

/**
 * Mount the three routes on a bare Express app with both REAL stores and the same
 * `guard`/`notFound`/`ownedProject` helpers routes/projects.js injects.
 * @param {{ user?: any, feedbackLimiter?: any, feedbackReadLimiter?: any }} [overrides] - `user` installs a
 *   requireProAccount that returns it (the authorized case); otherwise the gate 401s.
 * @returns {Promise<any>} `{ baseUrl, shares, feedback, calls, limited, limitedReads, seed, close }`.
 */
async function mountFeedback(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-feedback-'));
  dirs.push(dir);
  const shares = createProjectShares(dir);
  const store = createShareFeedback(dir);

  // Every feedback-store call is logged by name so "the store was never touched" is
  // assertable. The wrapper dispatches through `store[name]` on each call rather than
  // capturing the function, so a test can swap one method out afterwards to inject a failure.
  /** @type {string[]} */
  const calls = [];
  /** @type {any} */
  const feedback = {};
  for (const name of Object.keys(store)) {
    feedback[name] = (/** @type {any[]} */ ...args) => {
      calls.push(name);
      return store[name](...args);
    };
  }

  // The in-memory project/photo/render fake, so the route can derive which rooms a share
  // actually publishes. Its own call log is separate from `calls`, which is the FEEDBACK
  // store's and is asserted to be empty on refused requests.
  const projects = createFakeProjects([]);

  /** Paths the limiter saw, in order. @type {string[]} */
  const limited = [];
  const limitedReads = [];

  const router = createAsyncRouter();
  registerFeedbackRoutes({
    router,
    shares,
    feedback,
    projects,
    requireProAccount: overrides.user
      ? () => overrides.user
      : (/** @type {any} */ _req, /** @type {any} */ res) => {
        res.status(401).json({ error: 'Sign in required', code: 'AUTH_REQUIRED' });
        return null;
      },
    // Verbatim from routes/projects.js — a 500 carries a ref, never the exception text.
    guard: (context, fn) => async (req, res) => {
      try {
        await fn(req, res);
      } catch (err) {
        const ref = reportError(context, err);
        if (!res.headersSent) sendError(res, 500, 'Request failed', { ref });
      }
    },
    notFound: (res) => sendError(res, 404, 'Not found', { code: 'NOT_FOUND' }),
    ownedProject: (req, u) => {
      const project = projects.getProject(String(req.params.id));
      // Same answer for "absent" and "someone else's".
      if (!project || project.userId !== u.id) return null;
      return project;
    },
    setSensitiveHeaders,
    feedbackLimiter: overrides.feedbackLimiter || ((/** @type {any} */ req, /** @type {any} */ _res, /** @type {any} */ next) => {
      limited.push(`${req.method} ${req.path}`);
      next();
    }),
    feedbackReadLimiter: overrides.feedbackReadLimiter || ((/** @type {any} */ req, /** @type {any} */ _res, /** @type {any} */ next) => {
      limitedReads.push(`${req.method} ${req.path}`);
      next();
    }),
  });

  const server = express();
  server.use(express.json({ limit: '1mb' }));
  server.use(router);
  // Catch-all, as in server.js — without it Express renders a stack trace as HTML.
  server.use((/** @type {any} */ err, /** @type {any} */ _req, /** @type {any} */ res, /** @type {any} */ _next) => {
    if (res.headersSent) return;
    res.status(500).json({ error: 'Server error', code: err?.code || 'ERROR' });
  });

  const listening = await new Promise((resolve) => {
    const s = server.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = /** @type {any} */ (listening).address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    shares,
    feedback: store,
    projects,
    calls,
    limited,
    limitedReads,
    /**
     * A listing owned by `userId`, optionally with rooms. Each room spec is a key (a normal
     * published room) or `{ roomKey, render, frameRole, stageable }` for the unpublishable
     * shapes — see `addRoom`.
     * @param {string} userId - Owner.
     * @param {Array<string|Record<string, any>>} [rooms] - Rooms to seed.
     * @returns {any} The project row.
     */
    seed: (userId, rooms = []) => {
      const project = projects.createProject({ userId, title: '12 Oak St' });
      for (const room of rooms) addRoom(projects, project, room);
      return project;
    },
    close: () => new Promise((r) => /** @type {any} */ (listening).close(() => r(undefined))),
  };
}

/**
 * @param {string} base - Server origin.
 * @param {string} route - Path.
 * @param {{ method?: string, body?: any }} [opts] - Verb and JSON body.
 * @returns {Promise<Response>} The response.
 */
const call = (base, route, { method = 'GET', body } = {}) =>
  fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** POST a response through a share token. */
const answer = (base, token, body) => call(base, `/api/share/${token}/feedback`, { method: 'POST', body });
/** Read back what a share token has said. */
const readBack = (base, token) => call(base, `/api/share/${token}/feedback`);
/** The owner's panel. */
const ownerView = (base, projectId) => call(base, `/api/projects/${projectId}/feedback`);

/** Mint a live link for a listing. @returns {string} The one-time plaintext token. */
const link = (harness, project, over = {}) =>
  harness.shares.createShare({ projectId: project.id, userId: project.userId, ...over }).token;

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

// ── Happy path: the loop closes ──────────────────────────────────────────────

test('a live token records a response, and the OWNER sees it in their listing', async () => {
  app = await mountFeedback({ user: USER_A });
  const project = app.seed(USER_A.id, ['living-room-1']);
  const token = link(app, project);

  const res = await answer(app.baseUrl, token, {
    roomKey: 'living-room-1', verdict: 'changes', note: 'Could the sofa be warmer?', viewerLabel: 'Dana (seller)',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.feedback, {
    verdict: 'changes',
    roomKey: 'living-room-1',
    note: 'Could the sofa be warmer?',
    viewerLabel: 'Dana (seller)',
    createdAt: body.feedback.createdAt,
  });
  assert.equal(typeof body.feedback.createdAt, 'number');
  assert.deepEqual(body.allowance, { used: 1, limit: MAX_PER_SHARE, full: false });

  const owner = await ownerView(app.baseUrl, project.id);
  assert.equal(owner.status, 200);
  const { feedback } = await owner.json();
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].verdict, 'changes');
  assert.equal(feedback[0].roomKey, 'living-room-1');
  assert.equal(feedback[0].note, 'Could the sofa be warmer?');
  // The OWNER's copy carries the internal ids — that is the difference between the two
  // surfaces, and it is what the studio joins on.
  assert.equal(feedback[0].projectId, project.id);
  assert.equal(feedback[0].userId, USER_A.id);
  assert.equal(feedback[0].shareId, app.shares.activeShareFor(project.id).id);
});

test('a whole-listing response (no roomKey) stores a null room and reads back as null', async () => {
  app = await mountFeedback({ user: USER_A });
  const project = app.seed(USER_A.id);
  const token = link(app, project);

  const res = await answer(app.baseUrl, token, { verdict: 'approved', note: 'All good, list it.' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).feedback.roomKey, null);
  assert.equal(app.feedback.listForProject(project.id)[0].roomKey, null);
});

test('the owner GET returns the append-only HISTORY, newest first, not just the latest', async () => {
  // The note that said "make it warmer" is the answer to "why did I re-render this room",
  // so the owner side must not be reduced the way the public read-back is.
  app = await mountFeedback({ user: USER_A });
  const project = app.seed(USER_A.id, ['den-1']);
  const token = link(app, project);

  await answer(app.baseUrl, token, { roomKey: 'den-1', verdict: 'changes', note: 'warmer please' });
  await answer(app.baseUrl, token, { roomKey: 'den-1', verdict: 'approved', note: 'perfect now' });

  const { feedback } = await (await ownerView(app.baseUrl, project.id)).json();
  assert.equal(feedback.length, 2, 'both answers survive; nothing is updated in place');
  assert.deepEqual(feedback.map((/** @type {any} */ f) => f.verdict), ['approved', 'changes'], 'newest first');
  // The public read-back of the SAME link reduces to the current answer per room.
  const { responses } = await (await readBack(app.baseUrl, token)).json();
  assert.equal(responses.length, 1);
  assert.equal(responses[0].verdict, 'approved');
});

// ── THE ONE THAT MATTERS: the ids come from the share, never the body ────────

test('a hostile body cannot redirect a response onto ANOTHER tenant\'s listing', async () => {
  // Without `projectId`/`userId` coming from the RESOLVED SHARE, anyone holding any live
  // link could file rows onto somebody else's listing — and the owner of that listing would
  // read a stranger's text in their workspace. This is the most important test in the file.
  app = await mountFeedback({ user: USER_B });
  const mine = app.seed(USER_A.id);
  const theirs = app.seed(USER_B.id);
  const token = link(app, mine);
  const myShareId = app.shares.activeShareFor(mine.id).id;
  const theirShareId = app.shares.createShare({ projectId: theirs.id, userId: USER_B.id }).share.id;

  const res = await answer(app.baseUrl, token, {
    verdict: 'approved',
    note: 'planted',
    // Every id the store takes, supplied by the caller. All of them must be ignored.
    projectId: theirs.id,
    userId: USER_B.id,
    shareId: theirShareId,
    id: 'f_planted',
    createdAt: 0,
  });
  assert.equal(res.status, 200, 'the write itself succeeds — the ids are simply not the caller\'s to choose');

  const rows = app.feedback.listForProject(mine.id);
  assert.equal(rows.length, 1, 'the row landed on the SHARE\'s listing');
  assert.equal(rows[0].projectId, mine.id);
  assert.equal(rows[0].userId, USER_A.id, 'filed under the share\'s owner, not the body\'s');
  assert.equal(rows[0].shareId, myShareId, 'attributed to the link it came through');
  assert.notEqual(rows[0].id, 'f_planted', 'the row id is minted by the store');
  assert.notEqual(rows[0].createdAt, 0, 'and so is the timestamp');

  assert.deepEqual(app.feedback.listForProject(theirs.id), [], 'the targeted listing collected nothing');
  // And the rival owner — who IS the authenticated user here — sees an empty panel.
  const { feedback } = await (await ownerView(app.baseUrl, theirs.id)).json();
  assert.deepEqual(feedback, []);
});

// ── One indistinguishable refusal, and it writes nothing ────────────────────

test('revoked, expired, garbage and blank tokens all answer the IDENTICAL 404 on POST', async () => {
  // Comparing each rejection to 404 would pass a router whose bodies said "revoked" vs
  // "not found". The point is that the answers are indistinguishable from EACH OTHER.
  app = await mountFeedback({ user: USER_A });
  const project = app.seed(USER_A.id);

  const revoked = link(app, project);
  app.shares.revokeSharesFor(project.id);
  const expired = link(app, project, { expiresAt: Date.now() - 60_000 });
  const unknown = 'A'.repeat(43); // well-formed, simply never minted

  const shapes = [];
  for (const token of [revoked, expired, unknown, '%20', 'not-a-token']) {
    shapes.push(await shapeOf(await answer(app.baseUrl, token, { verdict: 'approved', note: 'let me in' })));
  }
  for (const shape of shapes.slice(1)) {
    assert.deepEqual(shape, shapes[0], 'every rejection must be byte-identical, headers included');
  }
  assert.equal(shapes[0].status, 404);
  for (const shape of shapes) {
    assert.ok(!/revok|expir|unknown/i.test(shape.body), `the refusal must not name a reason: ${shape.body}`);
  }
  // The whole point: none of them wrote.
  assert.equal(app.feedback.count(), 0, 'a refused token must not leave a row behind');
});

test('a REVOKED link cannot write a row it could have written a moment ago', async () => {
  // Revocation is the reason this check is in the route at all: the broker killed the link,
  // and the person holding it must stop being able to put text in their database.
  app = await mountFeedback({ user: USER_A });
  const project = app.seed(USER_A.id);
  const token = link(app, project);

  assert.equal((await answer(app.baseUrl, token, { verdict: 'approved' })).status, 200);
  assert.equal(app.feedback.count(), 1);

  app.shares.revokeSharesFor(project.id);
  const after = await answer(app.baseUrl, token, { verdict: 'changes', note: 'still here' });
  assert.equal(after.status, 404);
  assert.equal((await after.json()).code, 'NOT_FOUND');
  assert.equal(app.feedback.count(), 1, 'the revoked link wrote nothing');
});

test('an EXPIRED link cannot write, and neither read route leaks that it once existed', async () => {
  app = await mountFeedback({ user: USER_A });
  const project = app.seed(USER_A.id);
  const token = link(app, project, { expiresAt: Date.now() - 1 });

  const post = await shapeOf(await answer(app.baseUrl, token, { verdict: 'approved' }));
  const get = await shapeOf(await readBack(app.baseUrl, token));
  const junkPost = await shapeOf(await answer(app.baseUrl, 'B'.repeat(43), { verdict: 'approved' }));
  const junkGet = await shapeOf(await readBack(app.baseUrl, 'B'.repeat(43)));

  assert.deepEqual(post, junkPost);
  assert.deepEqual(get, junkGet);
  assert.deepEqual(post, get, 'the two public routes share one refusal, verb included');
  assert.equal(post.status, 404);
  assert.equal(app.feedback.count(), 0);
});

// ── The public projection leaks nothing ──────────────────────────────────────

test('the anonymous responses carry no owner, no listing and no internal id — raw JSON', async () => {
  // A `...row` spread is the failure this catches: `ShareFeedback` carries the LISTING
  // OWNER's account id, the share id and the project id, none of which a stranger holding a
  // forwarded link may see. Asserted against the whole body, because a leak arrives as a
  // key nobody wrote an assertion for.
  app = await mountFeedback({ user: USER_A });
  const project = app.seed(USER_A.id, ['kitchen-1']);
  const token = link(app, project);
  const shareId = app.shares.activeShareFor(project.id).id;

  const posted = await (await answer(app.baseUrl, token, {
    roomKey: 'kitchen-1', verdict: 'approved', note: 'love it', viewerLabel: 'Dana',
  })).text();
  const listed = await (await readBack(app.baseUrl, token)).text();
  const rowId = app.feedback.listForProject(project.id)[0].id;

  for (const raw of [posted, listed]) {
    for (const forbidden of [
      'userId', 'u_broker', 'projectId', project.id, 'shareId', shareId,
      '"id"', rowId, 'token', token, 'user_id', 'share_id',
    ]) {
      assert.ok(!raw.includes(forbidden), `the public projection must not contain ${forbidden}: ${raw}`);
    }
  }
  // Control: it does carry the four fields the client renders, so the assertions above are
  // not passing on an empty body.
  for (const present of ['kitchen-1', 'approved', 'love it', 'Dana', 'createdAt']) {
    assert.ok(posted.includes(present), `the projection must carry ${present}`);
  }
});

test('publicFeedback is an allowlist: an extra column on a row is not published', async () => {
  // The projection is built field by field. If it ever becomes a spread, this fails.
  const projected = publicFeedback(/** @type {any} */ ({
    id: 'f_1', shareId: 's_1', projectId: 'p_1', userId: 'u_1',
    roomKey: 'den-1', verdict: 'approved', note: 'n', viewerLabel: 'v', createdAt: 7,
    somethingAddedLater: 'secret',
  }));
  assert.deepEqual(Object.keys(projected).sort(), ['createdAt', 'note', 'roomKey', 'verdict', 'viewerLabel']);
  assert.ok(!JSON.stringify(projected).includes('secret'));
});

// ── The read-back is per LINK, not per listing ──────────────────────────────

test('after a rotation the NEW link sees none of the previous viewer\'s notes', async () => {
  // `listForProject` here instead of `latestByRoom(share.id)` would hand the next person the
  // broker sends a link to the last person's opinions about somebody's house.
  app = await mountFeedback({ user: USER_A });
  const project = app.seed(USER_A.id, ['den-1']);
  const first = link(app, project);
  await answer(app.baseUrl, first, { roomKey: 'den-1', verdict: 'changes', note: 'the seller hated the rug' });

  // Minting rotates: `first` is revoked in the same transaction.
  const second = link(app, project);
  const res = await readBack(app.baseUrl, second);
  assert.equal(res.status, 200);
  const raw = await res.text();
  assert.deepEqual(JSON.parse(raw).responses, [], 'a rotated-in viewer starts from nothing');
  assert.ok(!raw.includes('rug'), 'and cannot read the previous viewer\'s text at all');

  // The row is not gone — it is the OWNER's, and only the owner still sees it.
  const { feedback } = await (await ownerView(app.baseUrl, project.id)).json();
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].note, 'the seller hated the rug');
});

test('the read-back shows only THIS link\'s rows even while both links are live', async () => {
  // Two shares on one listing cannot happen through the owner API (minting rotates), so the
  // rows are seeded directly — the guard under test keys on the share, and this is the only
  // way to prove it is not accidentally keying on the project.
  app = await mountFeedback({ user: USER_A });
  const project = app.seed(USER_A.id);
  const mine = link(app, project);
  const mineId = app.shares.activeShareFor(project.id).id;
  app.feedback.addFeedback({
    shareId: 's_someone_else', projectId: project.id, userId: USER_A.id,
    roomKey: 'den-1', verdict: 'changes', note: 'a different viewer said this',
  });
  app.feedback.addFeedback({
    shareId: mineId, projectId: project.id, userId: USER_A.id,
    roomKey: 'kitchen-1', verdict: 'approved', note: 'mine',
  });

  const raw = await (await readBack(app.baseUrl, mine)).text();
  const { responses, allowance } = JSON.parse(raw);
  assert.deepEqual(responses.map((/** @type {any} */ r) => r.roomKey), ['kitchen-1']);
  assert.ok(!raw.includes('a different viewer'), 'the other link\'s note must not be readable');
  assert.equal(allowance.used, 1, 'the allowance is per link too, not per listing');
});

test('the read-back is empty (not a 404) for a live link nobody has answered through', async () => {
  app = await mountFeedback({ user: USER_A });
  const project = app.seed(USER_A.id);
  const res = await readBack(app.baseUrl, link(app, project));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { responses: [], allowance: { used: 0, limit: MAX_PER_SHARE, full: false } });
});

// ── Validation: refused, not coerced; clamped, not rejected ─────────────────

test('an unknown verdict is a coded 400, never coerced to a default', async () => {
  // Silently recording "approved" because the client sent "aproved" would put a sign-off the
  // seller never gave in front of the broker.
  app = await mountFeedback({ user: USER_A });
  const project = app.seed(USER_A.id);
  const token = link(app, project);

  for (const verdict of ['aproved', 'APPROVED', 'maybe', '', null, 42, { verdict: 'approved' }]) {
    const res = await answer(app.baseUrl, token, { verdict, note: 'n' });
    assert.equal(res.status, 400, `verdict ${JSON.stringify(verdict)} must be refused`);
    assert.equal((await res.json()).code, 'BAD_VERDICT');
  }
  // A body-less POST is the same refusal, not a crash.
  const bare = await call(app.baseUrl, `/api/share/${token}/feedback`, { method: 'POST' });
  assert.equal(bare.status, 400);
  assert.equal((await bare.json()).code, 'BAD_VERDICT');
  assert.equal(app.feedback.count(), 0, 'nothing was stored by any of them');
});

test('both allowed verdicts round-trip', async () => {
  app = await mountFeedback({ user: USER_A });
  const project = app.seed(USER_A.id, ['room-approved', 'room-changes']);
  const token = link(app, project);
  for (const verdict of ['approved', 'changes']) {
    const res = await answer(app.baseUrl, token, { roomKey: `room-${verdict}`, verdict });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).feedback.verdict, verdict);
  }
});

test('an over-long note is CLAMPED and stored, not rejected', async () => {
  // A seller who pasted three paragraphs must not lose their sign-off to a 400 they cannot
  // fix from a phone. The store clamps; the route does not second-guess it.
  app = await mountFeedback({ user: USER_A });
  const project = app.seed(USER_A.id);
  const token = link(app, project);

  const res = await answer(app.baseUrl, token, {
    verdict: 'changes',
    note: 'x'.repeat(MAX_NOTE + 500),
    viewerLabel: 'y'.repeat(MAX_VIEWER_LABEL + 100),
  });
  assert.equal(res.status, 200);
  const { feedback } = await res.json();
  assert.equal(feedback.note.length, MAX_NOTE);
  assert.equal(feedback.viewerLabel.length, MAX_VIEWER_LABEL);
  assert.equal(app.feedback.listForProject(project.id)[0].note.length, MAX_NOTE);
});

test('a non-string note/label/roomKey is dropped, never coerced into "[object Object]"', async () => {
  app = await mountFeedback({ user: USER_A });
  const project = app.seed(USER_A.id);
  const token = link(app, project);
  const res = await answer(app.baseUrl, token, { verdict: 'approved', note: { a: 1 }, viewerLabel: 7, roomKey: ['x'] });
  assert.equal(res.status, 200);
  const { feedback } = await res.json();
  assert.deepEqual(
    { note: feedback.note, viewerLabel: feedback.viewerLabel, roomKey: feedback.roomKey },
    { note: '', viewerLabel: '', roomKey: null },
  );
});

// ── The room has to be one the viewer could see ─────────────────────────────

test('a roomKey that names no room in the listing is a coded 400 and writes nothing', async () => {
  app = await mountFeedback({ user: USER_A });
  const project = app.seed(USER_A.id, ['living-room-1']);
  const token = link(app, project);

  const res = await answer(app.baseUrl, token, { roomKey: 'not-a-real-room', verdict: 'approved', note: 'junk' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'UNKNOWN_ROOM');
  assert.equal(app.feedback.count(), 0, 'an unknown room must not reach the broker\'s inbox');

  // Control: the room that IS published takes the same request.
  const ok = await answer(app.baseUrl, token, { roomKey: 'living-room-1', verdict: 'approved', note: 'junk' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).feedback.roomKey, 'living-room-1');
});

test('an omitted, empty or null roomKey is still whole-listing feedback, not an unknown room', async () => {
  // The response a seller gives from the bottom of the page. Refusing it because "no such
  // room" would break the most common answer there is.
  app = await mountFeedback({ user: USER_A });
  const project = app.seed(USER_A.id, ['living-room-1']);
  const token = link(app, project);

  for (const body of [{ verdict: 'approved' }, { roomKey: '', verdict: 'approved' }, { roomKey: null, verdict: 'approved' }]) {
    const res = await answer(app.baseUrl, token, body);
    assert.equal(res.status, 200, `${JSON.stringify(body)} must be accepted`);
    assert.equal((await res.json()).feedback.roomKey, null);
  }
  assert.equal(app.feedback.count(), 3);
});

test('a room that EXISTS but the gallery does not publish is refused too', async () => {
  // THE case worth getting right. Each of these rooms is in the photo table and absent from
  // `/s/:token`, so a viewer could not have been looking at it. If this route ever checks
  // "does a photo carry this room key" instead of reusing `isPublishableFrame`, only this
  // test fails — and the two rules will have drifted in the direction that lets comments in
  // on frames the broker retracted.
  app = await mountFeedback({ user: USER_A });
  const project = app.seed(USER_A.id, [
    'shown-1',
    { roomKey: 'excluded-1', frameRole: 'excluded' },
    { roomKey: 'unstageable-1', stageable: false },
    { roomKey: 'never-rendered-1', render: 'none' },
    { roomKey: 'failed-1', render: 'failed' },
    { roomKey: 'queued-1', render: 'queued' },
  ]);
  const token = link(app, project);

  for (const roomKey of ['excluded-1', 'unstageable-1', 'never-rendered-1', 'failed-1', 'queued-1']) {
    const res = await answer(app.baseUrl, token, { roomKey, verdict: 'changes', note: 'about a room I cannot see' });
    assert.equal(res.status, 400, `${roomKey} is not published, so it is not commentable`);
    assert.equal((await res.json()).code, 'UNKNOWN_ROOM');
    // Precondition: the room really is in the database — this is a refusal, not an absence.
    assert.ok(app.projects.listPhotos(project.id).some((/** @type {any} */ p) => p.roomKey === roomKey));
  }
  assert.equal(app.feedback.count(), 0);
  assert.equal((await answer(app.baseUrl, token, { roomKey: 'shown-1', verdict: 'changes' })).status, 200, 'control');
});

test('a room that becomes unpublished stops accepting responses immediately', async () => {
  // The broker excludes a frame AFTER the seller opened the link. The gallery retracts it on
  // the next load; this route must retract it on the next POST.
  app = await mountFeedback({ user: USER_A });
  const project = app.seed(USER_A.id, ['den-1']);
  const token = link(app, project);
  assert.equal((await answer(app.baseUrl, token, { roomKey: 'den-1', verdict: 'approved' })).status, 200);

  const photo = app.projects.listPhotos(project.id).find((/** @type {any} */ p) => p.roomKey === 'den-1');
  app.projects.updatePhoto(photo.id, { frameRole: 'excluded' });
  const after = await answer(app.baseUrl, token, { roomKey: 'den-1', verdict: 'changes', note: 'too late' });
  assert.equal(after.status, 400);
  assert.equal((await after.json()).code, 'UNKNOWN_ROOM');
  assert.equal(app.feedback.count(), 1);
});

test('the room check runs only AFTER the token resolves, so it is not an oracle', async () => {
  // A dead token must not be able to tell a caller which room keys a listing has: every
  // refusal that precedes resolution is the one uniform 404, UNKNOWN_ROOM included.
  app = await mountFeedback({ user: USER_A });
  const project = app.seed(USER_A.id, ['living-room-1']);
  const token = link(app, project);
  app.shares.revokeSharesFor(project.id);

  const real = await shapeOf(await answer(app.baseUrl, token, { roomKey: 'living-room-1', verdict: 'approved' }));
  const invented = await shapeOf(await answer(app.baseUrl, token, { roomKey: 'no-such-room', verdict: 'approved' }));
  assert.deepEqual(real, invented, 'a dead token learns nothing about the listing\'s rooms');
  assert.equal(real.status, 404);
});

// ── The ceiling refuses calmly ──────────────────────────────────────────────

test('the per-share ceiling answers a coded 409 and does not grow the table', async () => {
  app = await mountFeedback({ user: USER_A });
  const project = app.seed(USER_A.id, ['r-last', 'r-over']);
  const token = link(app, project);
  const shareId = app.shares.activeShareFor(project.id).id;

  // Fill to one short of the cap through the store, then take the last slot over HTTP so
  // the boundary itself is exercised by the route.
  for (let i = 0; i < MAX_PER_SHARE - 1; i += 1) {
    app.feedback.addFeedback({ shareId, projectId: project.id, userId: USER_A.id, roomKey: `r-${i}`, verdict: 'approved' });
  }
  const last = await answer(app.baseUrl, token, { roomKey: 'r-last', verdict: 'approved' });
  assert.equal(last.status, 200, 'the final slot is still writable');
  assert.deepEqual((await last.json()).allowance, { used: MAX_PER_SHARE, limit: MAX_PER_SHARE, full: true });

  const before = app.feedback.count();
  const refused = await answer(app.baseUrl, token, { roomKey: 'r-over', verdict: 'changes', note: 'one too many' });
  assert.equal(refused.status, 409, 'a permanent cap is a conflict, not a 429 the client would retry');
  const body = await refused.json();
  assert.equal(body.code, 'FEEDBACK_FULL');
  assert.ok(!('ref' in body), 'a cap is an expected answer, not a logged 500');
  assert.equal(app.feedback.count(), before, 'and the refusal wrote nothing');
  assert.equal(app.feedback.allowanceFor(shareId).used, MAX_PER_SHARE);
});

// ── The owner side is gated ─────────────────────────────────────────────────

test('the owner GET is 401 unauthenticated, and never touches the feedback store', async () => {
  // A store reached before the gate is a store that can be probed.
  app = await mountFeedback();
  const project = app.seed(USER_A.id);
  const res = await ownerView(app.baseUrl, project.id);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'AUTH_REQUIRED');
  assert.deepEqual(app.calls, []);
});

test('someone else\'s listing is 404, never 403 — the API is not an existence oracle', async () => {
  app = await mountFeedback({ user: USER_B });
  const mine = app.seed(USER_A.id);
  const shareId = app.shares.createShare({ projectId: mine.id, userId: USER_A.id }).share.id;
  // Seeded through the raw store rather than over HTTP, so `calls` below records only what
  // the refused request itself touched.
  app.feedback.addFeedback({ shareId, projectId: mine.id, userId: USER_A.id, verdict: 'approved', note: 'private' });

  const foreign = await ownerView(app.baseUrl, mine.id);
  const absent = await ownerView(app.baseUrl, 'p_does_not_exist');
  assert.equal(foreign.status, 404, 'a 403 would confirm the listing id exists');
  assert.deepEqual(await shapeOf(foreign), await shapeOf(absent), 'absent and not-yours are one answer');
  assert.deepEqual(app.calls, [], 'and no row was read on the way to refusing');
});

test('the owner GET asks the store for the listing it validated, under the stated limit', async () => {
  app = await mountFeedback({ user: USER_A });
  const project = app.seed(USER_A.id);
  /** @type {any[]} */
  const seen = [];
  const real = app.feedback.listForProject;
  app.feedback.listForProject = (/** @type {any} */ ...args) => {
    seen.push(args);
    return real(...args);
  };
  await ownerView(app.baseUrl, project.id);
  assert.deepEqual(seen, [[project.id, OWNER_FEEDBACK_LIMIT]]);
});

// ── Headers and rate limiting ───────────────────────────────────────────────

test('both public routes are no-referrer, noindex and private no-store — on 200 AND on 404', async () => {
  app = await mountFeedback({ user: USER_A });
  const project = app.seed(USER_A.id);
  const token = link(app, project);

  const responses = [
    await answer(app.baseUrl, token, { verdict: 'approved' }),
    await readBack(app.baseUrl, token),
    await answer(app.baseUrl, 'D'.repeat(43), { verdict: 'approved' }),
    await readBack(app.baseUrl, 'D'.repeat(43)),
  ];
  for (const res of responses) {
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', 'the token is in the path');
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.ok(!/public/.test(String(res.headers.get('cache-control'))));
  }
  // Drift guard: the public share surface has ONE cache policy, defined in
  // routes/share-public.js. If that constant changes, this file must change with it.
  assert.equal(SHARE_NO_STORE, 'private, no-store');
});

test('both public routes are limited, but on SEPARATE budgets, and the owner route on neither', async () => {
  // Both must be bounded — an anonymous write to the volume the database lives on is a free
  // write budget otherwise, and the owner route is already behind a session, so limiting it
  // would only throttle a paying customer's own dashboard.
  //
  // What this pins beyond that is the SPLIT, and it is not tidiness. They shared one budget,
  // so spending it on WRITES made the next GET 429 — and the share page treats a failed read
  // as "this link has no reply feature" (public/scripts/share/signoff.js: `state.ok !== true`
  // → `{ enabled: false }`). A seller who answered a lot of rooms would reload to find the
  // whole reply UI gone, their submitted notes with it. Verified against the running server:
  // with the write budget exhausted, POST 429s while GET still answers 200.
  app = await mountFeedback({ user: USER_A });
  const project = app.seed(USER_A.id);
  const token = link(app, project);

  await answer(app.baseUrl, token, { verdict: 'approved' });
  await readBack(app.baseUrl, token);
  await ownerView(app.baseUrl, project.id);

  assert.deepEqual(app.limited, [`POST /api/share/${token}/feedback`],
    `the write budget must see the write and NOTHING else, saw: ${app.limited.join(', ')}`);
  assert.deepEqual(app.limitedReads, [`GET /api/share/${token}/feedback`],
    `the read budget must see the read and NOTHING else, saw: ${app.limitedReads.join(', ')}`);
});

test('exhausting the WRITE budget leaves the read — and so the reply UI — working', async () => {
  // The regression this exists to catch is re-pointing the GET back at `limiter`. That is a
  // one-word edit and it silently removes the seller's whole reply channel; nothing else in
  // the suite would notice, because every other test spends at most one write.
  app = await mountFeedback({
    user: USER_A,
    feedbackLimiter: (/** @type {any} */ _req, /** @type {any} */ res) => res.status(429).json({ error: 'Too many responses.' }),
  });
  const project = app.seed(USER_A.id);
  const token = link(app, project);

  assert.equal((await answer(app.baseUrl, token, { verdict: 'approved' })).status, 429, 'writes are spent');
  const read = await readBack(app.baseUrl, token);
  assert.equal(read.status, 200, 'but the seller can still see the page');
  const body = await read.json();
  assert.ok(Array.isArray(body.responses), 'with a real payload, not an error body');
});

test('a limiter that refuses stops the write before the store is reached', async () => {
  app = await mountFeedback({
    user: USER_A,
    feedbackLimiter: (/** @type {any} */ _req, /** @type {any} */ res) => res.status(429).json({ error: 'Too many responses.' }),
  });
  const project = app.seed(USER_A.id);
  const res = await answer(app.baseUrl, link(app, project), { verdict: 'approved', note: 'flood' });
  assert.equal(res.status, 429);
  assert.equal(app.feedback.count(), 0);
  assert.deepEqual(app.calls, [], 'the limiter runs BEFORE the handler, not inside it');
});

// ── 5xx hygiene ─────────────────────────────────────────────────────────────

test('an unexpected store failure returns a ref, never the exception text', async () => {
  app = await mountFeedback({ user: USER_A });
  const project = app.seed(USER_A.id);
  const token = link(app, project);
  app.feedback.addFeedback = () => { throw new Error('SQLITE_CORRUPT: /srv/data/auth-store.db'); };

  const res = await answer(app.baseUrl, token, { verdict: 'approved' });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.ref, /^[0-9a-f]{8}$/);
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('SQLITE_CORRUPT'), 'the exception text must not reach an anonymous caller');
  assert.ok(!raw.includes('/srv/data'), 'nor an absolute server path');
});
