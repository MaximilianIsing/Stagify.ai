// The Listing Studio's staging QUEUE — everything that spends money or stops spending it.
//
// Split out of routes/projects.js (which owns listings, photos and the image byte routes)
// because these five endpoints share one set of invariants that the CRUD half does not
// care about at all:
//
//   1. A ROOM IS ONLY ENQUEUEABLE IF IT HAS A REAL HERO ROW.
//      The store's claim barrier reads the PHOTO row — `p.frame_role = 'hero' OR
//      r.bible_id IS NOT NULL` in claimNextRender (lib/data/project-renders.js). Picking a
//      hero in JS and enqueueing it with a null bibleId therefore produces a render that
//      NOTHING can ever claim: the row is not a hero in the database, and no bible exists
//      to unblock it — so the whole room stays queued forever while /stage answers a
//      cheerful 200 and progress reads `queued: N, running: 0` until the listing is
//      deleted. `resolveRoomHero` below writes the promotion with `setHero` before a
//      single row is enqueued. That write is the fix; choosing well in JS is not.
//
//   2. EVERY ROOM'S HERO GOES IN BEFORE ANY SUPPORT FRAME.
//      The claim is FIFO (`created_at ASC, rowid ASC`), so one shared `now` across a
//      5-room shoot means room E's hero sits behind ~25 support renders of rooms A–D. A
//      crash or a deploy at 60% then leaves the later rooms with no design bible at all —
//      the one artefact the whole feature is built to produce. Two passes, heroes at
//      `now` and support frames at `now + 1`, make every bible exist early and the
//      listing degrade evenly. See `enqueuePlan`.
//
//   3. RE-ENQUEUEING IS IDEMPOTENT, NOT ADDITIVE.
//      `/stage` and `/regenerate` both re-queue work for photos that may already have
//      queued rows. Adding to them double-bills every frame — and worse, once a second
//      bible lands, `attachBibleToQueuedRenders` unblocks BOTH generations, so the room
//      renders twice and ends with two live "current" images. Both routes retire the
//      rows they are replacing (`retireQueuedRenders`) before enqueueing.
//
//   4. NOTHING HERE MAY BE A DEAD END.
//      `/stage` refuses a listing whose queue is still draining, so `/cancel` and
//      `/regenerate` must NOT apply that same blanket refusal — a blocked-forever queued
//      row would then bar its own escape hatch. `/regenerate` refuses only while a render
//      of THAT room is `running` (the one state we cannot retire without racing the
//      worker for a paid generation); `/cancel` refuses nothing.
//
// Auth: `requireProAccount` runs INSIDE every handler and ownership is re-keyed on the
// validated session user's id, exactly as in routes/projects.js — see the header there.

import { sendError } from '../lib/http/http-helpers.js';
import {
  asBool, clampInt, clampText, groupByRoom, mergeExtraJson, storedVariationCount,
  skipReasonFor, SKIP_REASONS,
} from './projects-shared.js';

/** @typedef {import('../lib/types/projects.js').Project} Project */
/** @typedef {import('../lib/types/projects.js').ProjectPhoto} ProjectPhoto */
/** @typedef {import('../lib/types/projects.js').Render} Render */
/** @typedef {ReturnType<typeof import('../lib/data/projects.js').createProjects>} ProjectsStore */

/** Render states that mean "this listing is already being worked on". */
export const ACTIVE_RENDER_STATUSES = new Set(['queued', 'running']);

/**
 * `error_code` stamped on a render row that was retired without being run. Distinct from a
 * real generation failure so the studio (and any later analysis of the CSV render log) can
 * tell "the operator stopped this" apart from "the model refused it".
 */
export const CANCELLED_CODE = 'CANCELLED';

/** Support variations per photo. 1 is the hero's fixed count — it defines the bible. */
const MAX_VARIATIONS = 3;

/**
 * @typedef {Object} QueueRouteContext
 * @property {import('express').Router} router The router these five routes are registered on.
 * @property {ProjectsStore} projects Project/photo/render/bible store.
 * @property {typeof import('../lib/staging/room-clustering.js').pickHero} pickHero Chooses the frame that defines a room's design bible.
 * @property {ReturnType<typeof import('../lib/staging/listing-worker.js').createListingWorker>} listingWorker Queue worker; only `stats()` is read, so the API can report the honest state.
 * @property {(req: import('express').Request, res: import('express').Response) => any} requireProAccount Responds 401/403 and returns null when the caller is not Stagify+.
 * @property {(context: string, fn: (req: import('express').Request, res: import('express').Response) => Promise<unknown>) => import('express').RequestHandler} guard Wraps a handler so an unexpected throw becomes a 500 carrying only a log reference.
 * @property {(res: import('express').Response) => import('express').Response} notFound The uniform 404 (see the ownership note in routes/projects.js).
 * @property {(req: import('express').Request, user: { id: string }) => Project|null} ownedProject Loads `:id` only when this session owns it.
 * @property {(res: import('express').Response) => void} setSensitiveHeaders
 * @property {import('express').RequestHandler} genLimiter
 */

/**
 * Resolve one room's hero AND make the database agree.
 *
 * `pickHero` already prefers an existing 'hero' frame and skips excluded/unstageable
 * candidates, so it is the single arbiter — but its answer is only advisory until it is
 * written. When the chosen frame is not already the room's hero, `setHero` promotes it
 * (demoting the previous holder in the same transaction), which is what lifts the store's
 * claim barrier for that row. Returns null when the room has no eligible frame at all,
 * which is the signal to REFUSE the room rather than enqueue work nothing can run.
 * @param {ProjectsStore} projects - The store.
 * @param {typeof import('../lib/staging/room-clustering.js').pickHero} pickHero - Hero picker.
 * @param {string} projectId - Owning project.
 * @param {string} roomKey - The room being enqueued.
 * @param {ProjectPhoto[]} roomPhotos - The room's stageable photos (already filtered by groupByRoom).
 * @returns {ProjectPhoto|null} The photo that IS now the room's hero row, or null.
 */
export function resolveRoomHero(projects, pickHero, projectId, roomKey, roomPhotos) {
  const chosenId = pickHero(roomPhotos);
  if (chosenId === null || chosenId === undefined || chosenId === '') return null;
  const chosen = roomPhotos.find((p) => p.id === String(chosenId));
  if (!chosen) return null;
  if (chosen.frameRole === 'hero') return chosen;
  const promoted = projects.setHero(projectId, roomKey, chosen.id);
  // A failed promotion (the row vanished mid-request) refuses the room: enqueueing it
  // would recreate exactly the unclaimable-forever state this function exists to prevent.
  return promoted.ok ? promoted.photo : null;
}

/**
 * Build the enqueue plan for a set of rooms, promoting each room's hero on the way.
 * Rooms with no eligible frame are dropped, so the caller can refuse before it writes
 * anything to the project row.
 * @param {ProjectsStore} projects - The store.
 * @param {typeof import('../lib/staging/room-clustering.js').pickHero} pickHero - Hero picker.
 * @param {string} projectId - Owning project.
 * @param {Map<string, ProjectPhoto[]>} rooms - groupByRoom's output.
 * @returns {{ plan: Array<{ roomKey: string, hero: ProjectPhoto, roomPhotos: ProjectPhoto[] }>, refusedRooms: number }}
 */
export function planRooms(projects, pickHero, projectId, rooms) {
  /** @type {Array<{ roomKey: string, hero: ProjectPhoto, roomPhotos: ProjectPhoto[] }>} */
  const plan = [];
  let refusedRooms = 0;
  for (const [roomKey, roomPhotos] of rooms) {
    const hero = resolveRoomHero(projects, pickHero, projectId, roomKey, roomPhotos);
    if (!hero) {
      refusedRooms += 1;
      continue;
    }
    plan.push({ roomKey, hero, roomPhotos });
  }
  return { plan, refusedRooms };
}

/**
 * Enqueue a plan: EVERY hero first, then every support frame — see invariant 2 in the
 * header. The two `now` values are what encode that order durably; the queue sorts on
 * `created_at`, so it survives a restart in a way "we inserted them in a nice order"
 * would not (rowid alone would, but only while the rows are untouched).
 * @param {ProjectsStore} projects - The store.
 * @param {string} projectId - Owning project.
 * @param {Array<{ roomKey: string, hero: ProjectPhoto, roomPhotos: ProjectPhoto[] }>} plan - From planRooms.
 * @param {number} variationCount - Support variations (1–3). The hero is always 1 — it defines the bible.
 * @param {number} now - Epoch ms for the hero rows; support rows go in at `now + 1`.
 * @returns {number} Rows enqueued.
 */
export function enqueuePlan(projects, projectId, plan, variationCount, now) {
  let queued = 0;
  for (const { hero } of plan) {
    projects.enqueueRender({ projectId, photoId: hero.id, bibleId: null, variation: 1, now });
    queued += 1;
  }
  const supportNow = now + 1;
  for (const { hero, roomPhotos } of plan) {
    for (const photo of roomPhotos) {
      if (photo.id === hero.id) continue;
      for (let v = 1; v <= variationCount; v += 1) {
        projects.enqueueRender({ projectId, photoId: photo.id, bibleId: null, variation: v, now: supportNow });
        queued += 1;
      }
    }
  }
  return queued;
}

/**
 * Move a project's QUEUED renders to a terminal state, optionally only those belonging to
 * one room. This is what makes re-enqueueing idempotent (invariant 3) and what `/cancel`
 * does for the whole listing.
 *
 * `failRender` is used because it is the only transition the store exposes out of
 * 'queued'; the rows land in 'failed' carrying `error_code: 'CANCELLED'`, which is a
 * terminal state the claim ignores. A 'running' row is deliberately NOT touched — the
 * paid generation is already in flight upstream and cannot be recalled.
 * @param {ProjectsStore} projects - The store.
 * @param {Render[]} renders - The project's renders (already loaded by the caller).
 * @param {{ now: number, photoIds?: Set<string> }} opts - `photoIds` restricts the sweep to one room.
 * @returns {number} Rows retired.
 */
export function retireQueuedRenders(projects, renders, { now, photoIds }) {
  let retired = 0;
  for (const render of renders) {
    if (render.status !== 'queued') continue;
    if (photoIds && !photoIds.has(render.photoId)) continue;
    if (projects.failRender(render.id, { errorCode: CANCELLED_CODE, durationMs: 0, now })) retired += 1;
  }
  return retired;
}

/**
 * The status a listing should hold once nothing more is queued for it.
 *
 * A 'running' row keeps the project in 'staging': it is allowed to finish and its output
 * is KEPT, because the upstream generation has already been paid for and discarding the
 * image would waste the operator's money without saving any.
 * @param {{ running: number, ok: number }} progress - From `progressFor`.
 * @returns {'staging'|'ready'|'draft'} The settled status.
 */
export function settledStatus(progress) {
  if (progress.running > 0) return 'staging';
  return progress.ok > 0 ? 'ready' : 'draft';
}

/**
 * Register the queue routes on the Listing Studio router.
 * @param {QueueRouteContext} ctx - Router, store, hero picker, worker handle, auth gates, error/404 helpers and the rate limiter.
 * @returns {void}
 */
export function registerQueueRoutes(ctx) {
  const {
    router, projects, pickHero, listingWorker,
    requireProAccount, guard, notFound, ownedProject, setSensitiveHeaders, genLimiter,
  } = ctx;

  /**
   * The 409 for a listing where nothing can be staged. Distinct from NO_ROOM_ASSIGNMENTS
   * (which means "wait for the labeller") because there is nothing to wait for: the
   * operator has to un-exclude a frame or upload a usable photo.
   * @param {import('express').Response} res - Response.
   * @returns {import('express').Response} The 409.
   */
  const noStageablePhotos = (res) => sendError(res, 409, 'None of these photos can be staged — every frame is either excluded or was rejected by the upload check', { code: 'NO_STAGEABLE_PHOTOS' });

  /**
   * The 409 for a shoot that is entirely exteriors. Distinct from NO_STAGEABLE_PHOTOS
   * because the operator's next move is completely different — and ACTIONABLE, which the
   * generic message is not: nothing is wrong with these photos, they simply are not rooms,
   * and one dropdown per frame fixes it. Answering "none of these can be staged" here would
   * read as a rejection of perfectly good photography.
   * @param {import('express').Response} res - Response.
   * @returns {import('express').Response} The 409.
   */
  const onlyExteriors = (res) => sendError(res, 409, 'These all look like exteriors or other non-room shots, so nothing was staged. Set a room type on the frames you want staged.', { code: 'NO_INTERIOR_ROOMS' });

  router.post('/api/projects/:id/stage', genLimiter, guard('projects.stage', async (req, res) => {
    const user = requireProAccount(req, res);
    if (!user) return;
    const project = ownedProject(req, user);
    if (!project) return notFound(res);

    const photos = projects.listPhotos(project.id);
    if (!photos.length) return sendError(res, 409, 'Add photos before staging this listing', { code: 'NO_PHOTOS' });
    const rooms = groupByRoom(photos);
    if (!rooms.size) {
      // Two very different dead ends look alike here, and the message is the only thing
      // that tells the operator which one they are in: no room assignments yet (the
      // labeller has not answered) versus every assigned frame being unstageable.
      // THREE dead ends look alike here, and the message is the only thing that tells the
      // operator which one they are in. The exterior case is checked FIRST because it is
      // both the most common on a real shoot and the only one with a one-click fix.
      if (photos.some((p) => skipReasonFor(p) === SKIP_REASONS.NOT_A_ROOM)) return onlyExteriors(res);
      const assigned = photos.some((p) => p.roomKey && p.frameRole !== 'excluded');
      return assigned ? noStageablePhotos(res) : sendError(res, 409, 'These photos have no room assignments yet', { code: 'NO_ROOM_ASSIGNMENTS' });
    }
    // Re-staging a listing whose queue is still draining would double-bill every frame
    // and race the worker for the same rows, so it is refused rather than merged.
    if (projects.listRenders(project.id).some((r) => ACTIVE_RENDER_STATUSES.has(String(r.status)))) {
      return sendError(res, 409, 'This listing is already being staged', { code: 'RENDERS_IN_FLIGHT' });
    }

    // Hero promotion happens BEFORE the project row is touched, so a listing that turns
    // out to be unstageable is not left sitting in 'staging' with an empty queue.
    const { plan, refusedRooms } = planRooms(projects, pickHero, project.id, rooms);
    if (!plan.length) return noStageablePhotos(res);

    const variationCount = clampInt(req.body?.variationCount, 1, MAX_VARIATIONS, 1);
    const jobSettings = {
      furnitureStyle: clampText(req.body?.furnitureStyle, 64) || 'standard',
      additionalPrompt: clampText(req.body?.additionalPrompt, 500),
      removeFurniture: asBool(req.body?.removeFurniture),
      variationCount,
    };
    // The worker has no request to read settings from, so they are persisted with the
    // project and re-read per render.
    projects.updateProject(project.id, { status: 'staging', extraJson: mergeExtraJson(project, { jobSettings }) });
    const queued = enqueuePlan(projects, project.id, plan, variationCount, Date.now());

    setSensitiveHeaders(res);
    res.json({ ok: true, queued, rooms: plan.length, refusedRooms });
  }));

  router.get('/api/projects/:id/progress', guard('projects.progress', async (req, res) => {
    const user = requireProAccount(req, res);
    if (!user) return;
    const project = ownedProject(req, user);
    if (!project) return notFound(res);
    // Polled continuously while a listing renders, so it must never be cached — and it
    // reads nothing but two cheap aggregates.
    res.set('Cache-Control', 'no-store');
    res.json({
      progress: projects.progressFor(project.id),
      status: project.status,
      blockedByMissingBible: listingWorker.stats().blockedByMissingBible,
    });
  }));

  router.post('/api/projects/:id/rooms/:roomKey/bible/regenerate', genLimiter, guard('projects.bible.regenerate', async (req, res) => {
    const user = requireProAccount(req, res);
    if (!user) return;
    const project = ownedProject(req, user);
    if (!project) return notFound(res);
    const roomKey = clampText(req.params.roomKey, 64);
    const photos = projects.listPhotos(project.id);
    const roomPhotos = roomKey ? groupByRoom(photos).get(roomKey) : undefined;
    if (!roomPhotos?.length) return notFound(res);

    // Every photo of the room, INCLUDING the ones groupByRoom dropped: an excluded or
    // unstageable frame can still own a queued render from an earlier run, and leaving it
    // behind is what let a superseded generation come back to life once the new bible
    // attached to it.
    const roomPhotoIds = new Set(photos.filter((p) => p.roomKey === roomKey).map((p) => p.id));
    const renders = projects.listRenders(project.id);
    // Deliberately NOT /stage's blanket in-flight refusal — a room whose support frames
    // are blocked forever is precisely the case regenerate exists to escape, and queued
    // rows are retired below rather than refused. A 'running' row is the one thing we
    // cannot retire: the generation is already in flight and paid for.
    if (renders.some((r) => r.status === 'running' && roomPhotoIds.has(r.photoId))) {
      return sendError(res, 409, 'A render of this room is still in progress — wait for it to finish, then regenerate', { code: 'ROOM_RENDER_RUNNING' });
    }

    const now = Date.now();
    // Retire BOTH generations of the old work: the finished renders (kept on disk as
    // 'superseded' history) and the queued ones (terminal, so the new bible cannot
    // unblock them into a second paid render of every support frame).
    const superseded = projects.supersedeRendersForRoom(project.id, roomKey, { now });
    const cancelled = retireQueuedRenders(projects, renders, { now, photoIds: roomPhotoIds });

    const { plan } = planRooms(projects, pickHero, project.id, new Map([[roomKey, roomPhotos]]));
    if (!plan.length) return noStageablePhotos(res);
    const queued = enqueuePlan(projects, project.id, plan, storedVariationCount(project), now);
    projects.updateProject(project.id, { status: 'staging' });
    setSensitiveHeaders(res);
    res.json({ ok: true, superseded, cancelled, queued });
  }));

  router.post('/api/projects/:id/cancel', guard('projects.cancel', async (req, res) => {
    const user = requireProAccount(req, res);
    if (!user) return;
    const project = ownedProject(req, user);
    if (!project) return notFound(res);
    // No pre-conditions and no rate limit on purpose: this is the STOP button on a
    // ~90-generation job, and anything that can refuse it is a way to keep spending.
    const now = Date.now();
    const cancelled = retireQueuedRenders(projects, projects.listRenders(project.id), { now });
    const progress = projects.progressFor(project.id);
    const status = settledStatus(progress);
    projects.updateProject(project.id, { status });
    setSensitiveHeaders(res);
    // `running` is reported because it is the honest answer to "is it stopped?": that one
    // render finishes and is kept. `kept` is every finished render, untouched.
    res.json({ ok: true, cancelled, running: progress.running, kept: progress.ok, status });
  }));

  router.post('/api/projects/:id/renders/:renderId/retry', genLimiter, guard('projects.render.retry', async (req, res) => {
    const user = requireProAccount(req, res);
    if (!user) return;
    const project = ownedProject(req, user);
    if (!project) return notFound(res);
    const render = projects.getRender(String(req.params.renderId));
    if (!render || render.projectId !== project.id) return notFound(res);
    if (render.status !== 'failed') {
      return sendError(res, 409, 'Only a failed render can be retried', { code: 'RENDER_NOT_FAILED' });
    }
    const photo = projects.getPhoto(render.photoId);
    if (!photo) return notFound(res);

    // One retry per (photo, variation) at a time: without this a double-click enqueues
    // two paid generations of the same frame, and both would complete.
    const inFlight = projects.listRenders(project.id).some((r) => r.photoId === render.photoId
      && r.variation === render.variation && ACTIVE_RENDER_STATUSES.has(String(r.status)));
    if (inFlight) return sendError(res, 409, 'That frame is already queued to render again', { code: 'RENDERS_IN_FLIGHT' });

    // Reuse the SAME bible, so the retry is conditioned on the look its room already
    // committed to rather than authoring a competing one. A support frame that failed
    // before any bible attached falls back to the room's latest — still that room's look.
    // A hero keeps a null bibleId: it is claimable on its `frame_role` alone, and it is
    // the render that AUTHORS the bible.
    let bibleId = render.bibleId;
    if (!bibleId && photo.frameRole !== 'hero') {
      bibleId = projects.latestBible(project.id, photo.roomKey || '')?.id ?? null;
    }
    const requeued = projects.enqueueRender({
      projectId: project.id,
      photoId: photo.id,
      bibleId,
      variation: clampInt(render.variation, 1, MAX_VARIATIONS, 1),
      now: Date.now(),
    });
    projects.updateProject(project.id, { status: 'staging' });
    setSensitiveHeaders(res);
    // The failed row is left as history; `retryOf` is what lets the studio replace its
    // card with the new attempt instead of showing both.
    res.json({ ok: true, render: requeued, retryOf: render.id });
  }));
}
