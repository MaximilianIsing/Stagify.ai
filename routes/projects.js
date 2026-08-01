// Listing-staging API — projects (a real-estate listing), their photos, the per-room
// design bibles, and the render queue. Stagify+ only.
//
// RESPONSE SHAPE: IDS AND URLS, NEVER IMAGE DATA
// /api/process-image answers with a `data:image/webp;base64,…` string because it stages
// exactly one photo for a browser that is waiting on it. That shape does not scale here:
// a 30-photo listing at 3 variations is ~90 multi-megabyte images, and a single JSON
// body carrying them would be hundreds of MB, un-cacheable, and would have to be
// re-sent in full on every poll. So every endpoint below returns render *ids* and the
// browser fetches bytes one at a time from the two session-gated, immutably cacheable
// byte routes:
//   GET /api/projects/:id/renders/:renderId/image  — a staged output
//   GET /api/projects/:id/photos/:photoId/image    — the original upload (tray thumbnails
//                                                    and the "before" comparison pane)
// This is a deliberate break from the single-photo endpoint's contract, not an oversight.
//
// OWNERSHIP: 404, NOT 403
// Every project/photo/render lookup is re-keyed on the VALIDATED session user's id
// (`requireProAccount`'s return value) — never on anything from req.body or req.params.
// A row that exists but belongs to someone else answers 404, identically to a row that
// does not exist, so none of these endpoints can be used to enumerate other people's
// listings. (Auth is checked INSIDE each handler, so reading the middleware chain will not
// tell you whether a route is guarded. ONE route also carries a pre-filter in the chain —
// the batch photo upload, because multer buffers ~1 GB into memory before any handler runs;
// see `requireProUpload`. That is a pre-filter, not a second auth model: its handler still
// calls `requireProAccount` itself, and that call is the authority.)
//
// WHERE THE REST OF THE FEATURE LIVES
// This file owns listings, photos and the two image byte routes. Two siblings register
// their routes on the same router and share the helpers below:
//   routes/projects-queue.js    — /stage, /progress, /regenerate, /cancel, /retry.
//   routes/projects-download.js — /renders.zip, the bulk delivery archive.
//   routes/projects-share.js    — /share, the owner's controls for the public client link.
//   routes/share-feedback.js    — seller sign-off. NOTE: that module also registers TWO
//                                 PUBLIC routes on this router (see the note at its call
//                                 site) — the one exception to the rule above.
//   routes/projects-shared.js   — the pure clamps/filters all three use.

import crypto from 'crypto';
import multer from 'multer';
import sharp from 'sharp';
import { createAsyncRouter } from '../lib/http/async-router.js';
import { sendError } from '../lib/http/http-helpers.js';
import { reportError } from '../lib/http/error-ref.js';
import { downscaleImage, nearestGeminiAspectRatio } from '../lib/image/image-primitives.js';
import { logger } from '../lib/logger.js';
import { clampInt, clampText, groupByRoom, serveContentType } from './projects-shared.js';
import { registerQueueRoutes } from './projects-queue.js';
import { registerRenderArchiveRoute } from './projects-download.js';
import { registerShareRoutes } from './projects-share.js';
import { registerFeedbackRoutes } from './share-feedback.js';

/**
 * Statuses a caller may PATCH a project to. Mirrors the CHECK constraint in
 * lib/data/projects.js (and `ProjectStatus` in lib/types/projects.d.ts) — the store would
 * throw on anything else, and a constraint violation is a 500, so this turns it into 400.
 */
export const PROJECT_STATUSES = ['draft', 'staging', 'ready', 'archived'];

/** Frame roles an operator may set by hand. 'hero' routes through setHero instead. */
export const ASSIGNABLE_FRAME_ROLES = ['hero', 'support', 'excluded'];

const MAX_PHOTOS_PER_BATCH = 40;

/**
 * Per-photo upload ceiling, in bytes.
 *
 * 25 MB, matching `stagingProcessUpload` in lib/http/uploads.js (the single-photo stager)
 * and the "25MB per photo" the dropzone advertises. It used to be 15 MB here, which the
 * client never knew: a 20 MB frame passed the browser's own check, then multer aborted
 * the WHOLE batch of 40 with LIMIT_FILE_SIZE. Three limits for one rule is how that
 * happens, so this one is pinned to the stager's and must not exceed it.
 */
export const MAX_PHOTO_BYTES = 25 * 1024 * 1024;

/** Vision calls per batch upload. 40 at once would burst the model quota and the RAM. */
const LABEL_CONCURRENCY = 3;
const MAX_TITLE = 120;
const MAX_ADDRESS = 200;

const PHOTO_MIME_EXT = /** @type {Record<string, string>} */ ({
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
});

/**
 * `err.code` on the rejection `fileFilter` raises for a disallowed mimetype.
 *
 * It needs a code of its own because multer hands a fileFilter rejection to `next(err)` as
 * whatever object was passed — NOT as a `MulterError`. A plain `new Error(...)` therefore
 * sailed past the router's `err instanceof multer.MulterError` branch, fell through to the
 * app-level catch-all, and answered **500**. So an anonymous caller POSTing a `.txt` got a
 * server error, the client got no code to act on, and every such request burned Sentry quota
 * reporting a rejection that was working exactly as designed.
 */
export const UNSUPPORTED_PHOTO_CODE = 'UNSUPPORTED_PHOTO_TYPE';

// Batch photo upload. Defined here rather than in lib/http/uploads.js because it is
// specific to this feature: 40 files x 25 MB caps one request at ~1 GB of buffered RAM in
// theory, but multer enforces `files` too, and real listing photos are 2–6 MB.
//
// THAT ~1 GB IS WHY THE PRO GATE RUNS BEFORE THIS, not inside the handler like every other
// route in this file — see `requireProUpload` below.
const photoBatchUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: MAX_PHOTOS_PER_BATCH },
  fileFilter: (req, file, cb) => {
    if (PHOTO_MIME_EXT[file.mimetype]) return cb(null, true);
    const err = new Error('Only PNG, JPG, JPEG, and WebP photos are allowed');
    // @ts-expect-error — augmenting an Error with a code is how multer's own errors travel.
    err.code = UNSUPPORTED_PHOTO_CODE;
    return cb(err);
  },
}).array('photos', MAX_PHOTOS_PER_BATCH);

/** @typedef {import('../lib/types/projects.js').Project} Project */
/** @typedef {import('../lib/types/projects.js').ProjectPhoto} ProjectPhoto */

/**
 * @typedef {Object} ProjectsRouterDeps
 * @property {ReturnType<typeof import('../lib/data/projects.js').createProjects>} projects Project/photo/render/bible store.
 * @property {ReturnType<typeof import('../lib/data/project-storage.js').createProjectStorage>} storage Blob store for source photos and render outputs.
 * @property {ReturnType<typeof import('../lib/staging/room-clustering.js').createRoomClustering>} roomClustering Vision room labeller.
 * @property {typeof import('../lib/staging/room-clustering.js').assignRoomKeys} assignRoomKeys Groups labelled photos into stable room keys.
 * @property {typeof import('../lib/staging/room-clustering.js').pickHero} pickHero Chooses the frame that defines a room's design bible.
 * @property {ReturnType<typeof import('../lib/staging/listing-worker.js').createListingWorker>} listingWorker Queue worker; only `stats()` is read here, so the API can report the honest state.
 * @property {(req: import('express').Request) => any} getAuthUserFromRequest Unused by the handlers (every route needs the stricter pro gate) but kept in the bag so a future read-only endpoint has it.
 * @property {(req: import('express').Request, res: import('express').Response) => any} requireProAccount Responds 401/403 and returns null when the caller is not Stagify+.
 * @property {(imageBuffer: Buffer) => Promise<{ valid: boolean, code: string|null, reason: string }>} validateStageableImage
 * @property {(res: import('express').Response) => void} setSensitiveHeaders
 * @property {import('express').RequestHandler} genLimiter
 * @property {string} [appUrl] Absolute site origin, used to build the client share URL.
 * @property {boolean} [DEBUG_MODE]
 */

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving input order.
 * @template T, R
 * @param {T[]} items - Work items.
 * @param {number} limit - Maximum concurrent calls.
 * @param {(item: T, index: number) => Promise<R>} fn - Per-item worker.
 * @returns {Promise<R[]>} Results in input order.
 */
async function mapLimit(items, limit, fn) {
  const out = /** @type {R[]} */ (new Array(items.length));
  let cursor = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (let i = cursor; i < items.length; i = cursor) {
      cursor += 1;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(lanes);
  return out;
}

/**
 * Build the listing-staging router.
 * @param {ProjectsRouterDeps} deps - Injected store, blob storage, room clustering, hero picker, worker handle, auth gates, upload validator, header helper, and rate limiter.
 * @returns {import('express').Router} The mounted router.
 */
export default function createProjectsRouter(deps) {
  const {
    projects,
    storage,
    roomClustering,
    assignRoomKeys,
    pickHero,
    listingWorker,
    requireProAccount,
    validateStageableImage,
    setSensitiveHeaders,
    genLimiter,
    appUrl = '',
    DEBUG_MODE = false,
  } = deps;
  const router = createAsyncRouter();

  const debug = (...args) => {
    if (DEBUG_MODE) logger.debug('[projects]', ...args);
  };

  /**
   * Wrap a handler so an unexpected throw becomes a 500 carrying only a log reference.
   * @param {string} context - Log context for reportError.
   * @param {(req: import('express').Request, res: import('express').Response) => Promise<unknown>} fn - The handler.
   * @returns {import('express').RequestHandler} The guarded handler.
   */
  const guard = (context, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      const ref = reportError(context, err);
      if (!res.headersSent) sendError(res, 500, 'Request failed', { ref });
    }
  };

  /** @param {import('express').Response} res - Response. @returns {import('express').Response} A uniform 404. */
  const notFound = (res) => sendError(res, 404, 'Not found', { code: 'NOT_FOUND' });

  /**
   * The pro gate, as MIDDLEWARE, for the one route that must not reach its handler unguarded.
   *
   * THE ONLY PLACE IN THIS FILE WHERE AUTH RUNS IN THE CHAIN, and it is deliberate. Multer
   * buffers the whole multipart body into memory BEFORE the handler runs, so with the gate
   * only inside the handler an anonymous request could make this single-instance process
   * allocate up to `MAX_PHOTOS_PER_BATCH × MAX_PHOTO_BYTES` — about a gigabyte — and be told
   * "sign in" afterwards, having already paid the RAM. `genLimiter` bounds the RATE of that,
   * not the cost of one request, so it is not the answer.
   *
   * IT DOES NOT REPLACE THE IN-HANDLER CHECK. The handler still calls `requireProAccount`
   * itself, and that call remains the authority — this is a pre-filter that stops the buffer,
   * not a new auth model. Deleting the in-handler line because "the middleware covers it"
   * would make the file's stated invariant false and put this route one middleware-ordering
   * mistake from being open. Both, on purpose.
   * @param {import('express').Request} req - Request.
   * @param {import('express').Response} res - Response; already answered 401/403 on refusal.
   * @param {import('express').NextFunction} next - Continue to multer.
   * @returns {void}
   */
  const requireProUpload = (req, res, next) => {
    // `requireProAccount` sends its own 401/403 and returns null; there is nothing to add.
    if (!requireProAccount(req, res)) return;
    next();
  };

  /**
   * Load the project named by `:id`, but only if this session owns it.
   * @param {import('express').Request} req - Request (reads `req.params.id`).
   * @param {{ id: string }} user - The VALIDATED session user.
   * @returns {Project|null} The project, or null when absent OR owned by someone else.
   */
  function ownedProject(req, user) {
    const project = projects.getProject(String(req.params.id));
    // Same answer for "absent" and "someone else's" — otherwise this is an oracle
    // telling a caller which project ids exist.
    if (!project || project.userId !== user.id) return null;
    return project;
  }

  // ── Projects ───────────────────────────────────────────────────────────────

  router.post('/api/projects', guard('projects.create', async (req, res) => {
    const user = requireProAccount(req, res);
    if (!user) return;
    const project = projects.createProject({
      userId: user.id,
      title: clampText(req.body?.title, MAX_TITLE) || 'Untitled listing',
      address: clampText(req.body?.address, MAX_ADDRESS),
      now: Date.now(),
    });
    setSensitiveHeaders(res);
    res.json({ project });
  }));

  router.get('/api/projects', guard('projects.list', async (req, res) => {
    const user = requireProAccount(req, res);
    if (!user) return;
    const limit = clampInt(req.query?.limit, 1, 100, 50);
    const offset = clampInt(req.query?.offset, 0, 100000, 0);
    setSensitiveHeaders(res);
    res.json({ projects: projects.listProjects(user.id, { limit, offset }) });
  }));

  router.get('/api/projects/:id', guard('projects.get', async (req, res) => {
    const user = requireProAccount(req, res);
    if (!user) return;
    const project = ownedProject(req, user);
    if (!project) return notFound(res);
    setSensitiveHeaders(res);
    res.json({
      project,
      photos: projects.listPhotos(project.id),
      renders: projects.listRenders(project.id),
      bibles: projects.listBibles(project.id),
      progress: projects.progressFor(project.id),
    });
  }));

  router.patch('/api/projects/:id', guard('projects.patch', async (req, res) => {
    const user = requireProAccount(req, res);
    if (!user) return;
    const project = ownedProject(req, user);
    if (!project) return notFound(res);
    /** @type {Record<string, unknown>} */
    const patch = {};
    if (req.body?.title !== undefined) patch.title = clampText(req.body.title, MAX_TITLE);
    if (req.body?.address !== undefined) patch.address = clampText(req.body.address, MAX_ADDRESS);
    if (req.body?.status !== undefined) {
      const status = clampText(req.body.status, 32);
      if (!PROJECT_STATUSES.includes(status)) {
        return sendError(res, 400, 'Unknown project status', { code: 'BAD_STATUS', details: `status must be one of: ${PROJECT_STATUSES.join(', ')}` });
      }
      patch.status = status;
    }
    if (!Object.keys(patch).length) return sendError(res, 400, 'Nothing to update', { code: 'EMPTY_PATCH' });
    projects.updateProject(project.id, patch);
    setSensitiveHeaders(res);
    res.json({ project: projects.getProject(project.id) });
  }));

  router.delete('/api/projects/:id', guard('projects.delete', async (req, res) => {
    const user = requireProAccount(req, res);
    if (!user) return;
    const project = ownedProject(req, user);
    if (!project) return notFound(res);
    // DB FIRST, blobs second, and the order is load-bearing: if the unlink fails after
    // the rows are gone the user sees the listing disappear and we leak disk — which the
    // orphan sweep in lib/data/project-blob-gc.js then reclaims (POST /api/admin/blob-gc).
    // That sweep is what makes this comment true; for a long time it said "sweepable" and
    // nothing swept. Reversed, a failed unlink would leave rows the user can still see
    // pointing at files we already deleted — broken images with no way back.
    const deleted = projects.deleteProject(project.id);
    await storage.removeProject(project.id);
    setSensitiveHeaders(res);
    res.json({ ok: true, id: project.id, deleted });
  }));

  // ── Photos ─────────────────────────────────────────────────────────────────

  // requireProUpload runs BEFORE multer — see its note. The in-handler check below stays.
  router.post('/api/projects/:id/photos', genLimiter, requireProUpload, photoBatchUpload, guard('projects.photos.upload', async (req, res) => {
    const user = requireProAccount(req, res);
    if (!user) return;
    const project = ownedProject(req, user);
    if (!project) return notFound(res);
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) return sendError(res, 400, 'No photos provided', { code: 'NO_PHOTOS' });

    let seq = projects.listPhotos(project.id).length;
    /** @type {ProjectPhoto[]} */
    const added = [];
    let duplicates = 0;

    for (const file of files) {
      // THE HASH IS OF THE ORIGINAL BYTES, always — it is the dedup key, and re-dragging the
      // same folder must keep matching the row it matched last time. Everything below stores
      // a NORMALIZED copy; only this identity is taken from what the operator actually sent.
      const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');

      // NORMALIZE BEFORE STORING. `processStaging` already runs `downscaleImage` on its
      // input (staging-generation.js), so anything above 1920x1080 on disk is never seen by
      // the model — and source photos WERE 82–85% of this volume's footprint at 2–6 MB each,
      // up to the 25 MB per-photo ceiling. Storing them full-size bought nothing and was the
      // single largest consumer of a disk that also holds SQLite's WAL, so a full volume took
      // auth and Stripe webhooks down with the renders. `render.yaml` has claimed this
      // downscale existed for some time; now it does.
      //
      // The stored copy is still the "before" image in the client share gallery and the tray
      // thumbnail, and 1920x1080 is comfortably beyond what either needs.
      //
      // FAIL OPEN: `downscaleImage` throws on an input sharp cannot process. A photo that
      // cannot be normalized is stored as it arrived rather than dropped — the operator's
      // upload is worth more than the bytes saved.
      const normalized = await downscaleImage(file.buffer).catch((err) => {
        logger.warn('[projects] could not normalize an upload; storing it as sent:', err && err.message ? err.message : err);
        return null;
      });
      const bytes = normalized || file.buffer;
      // `downscaleImage` returns JPEG in every branch it does not pass through, and it only
      // passes through an image that was ALREADY JPEG — so a normalized buffer is jpg by
      // construction. Getting this wrong would store JPEG bytes under a `.png` key, and the
      // byte routes derive Content-Type from the key: with `nosniff` the browser would
      // simply refuse to render the operator's photo.
      const ext = normalized ? 'jpg' : (PHOTO_MIME_EXT[file.mimetype] || 'jpg');

      // Dimensions describe what was STORED, not what was sent: the studio and the share
      // gallery set width/height attributes from these to reserve layout space, and numbers
      // that do not match the served bytes are a guaranteed layout shift.
      const meta = await sharp(bytes).metadata().catch(() => null);
      const width = meta?.width || 0;
      const height = meta?.height || 0;
      const ar = nearestGeminiAspectRatio(width, height);
      // The key is built by the storage module from the project id and the content hash —
      // no caller-supplied string (filename, mimetype) ever reaches a filesystem path.
      const storageKey = storage.keyFor({ projectId: project.id, kind: 'src', id: sha256.slice(0, 32), ext });
      await storage.write(storageKey, bytes);
      seq += 1;
      const outcome = projects.addPhoto({
        projectId: project.id,
        storageKey,
        seq,
        sha256,
        width,
        height,
        arLabel: ar?.label || '',
        now: Date.now(),
      });
      // A rejected insert (the project vanished mid-upload) is skipped, not fatal: the
      // rest of the batch is still worth keeping.
      if (!outcome.ok) continue;
      if (outcome.duplicate) duplicates += 1;
      else added.push(outcome.photo);
    }
    debug(`stored ${added.length} photo(s) (${duplicates} duplicate) for project ${project.id}`);

    // Vision passes, bounded: the room label and the stageability pre-check per photo.
    // Both are per-photo and independent, so they ride the same concurrency budget.
    /** @type {Array<{ photoId: string, roomType: string|null, roomLabel: string|null }>} */
    const labels = [];
    await mapLimit(added, LABEL_CONCURRENCY, async (photo) => {
      const buf = await storage.read(photo.storageKey).catch(() => null);
      if (!buf) return;
      const [label, verdict] = await Promise.all([
        Promise.resolve(roomClustering.labelPhoto(buf)).catch(() => null),
        Promise.resolve(validateStageableImage(buf)).catch(() => null),
      ]);
      if (label) labels.push({ photoId: photo.id, roomType: label.roomType, roomLabel: label.roomLabel });
      // A failed pre-check fails OPEN (stageable: true) — the same posture
      // /api/validate-image takes, so a flaky reviewer can't block a real listing.
      projects.updatePhoto(photo.id, {
        stageable: verdict ? verdict.valid : true,
        unstageableCode: verdict && !verdict.valid ? verdict.code : null,
      });
    });
    debug(`labelled ${labels.length}/${added.length} photo(s) for project ${project.id}`);

    const roomKeys = assignRoomKeys(labels);
    for (const label of labels) {
      // A null key means the label failed; leaving it unassigned (rather than guessing a
      // room) is deliberate — assignRoomKeys documents why a wrong group is worse.
      const roomKey = roomKeys.get(label.photoId);
      if (roomKey) projects.updatePhoto(label.photoId, { roomKey, roomType: label.roomType });
    }

    // Hero per room: the frame whose render defines that room's design bible.
    for (const [roomKey, roomPhotos] of groupByRoom(projects.listPhotos(project.id))) {
      const heroId = pickHero(roomPhotos);
      if (heroId !== null) projects.setHero(project.id, roomKey, String(heroId));
    }

    setSensitiveHeaders(res);
    res.json({ photos: projects.listPhotos(project.id), duplicates });
  }));

  router.patch('/api/projects/:id/photos/:photoId', guard('projects.photos.patch', async (req, res) => {
    const user = requireProAccount(req, res);
    if (!user) return;
    const project = ownedProject(req, user);
    if (!project) return notFound(res);
    const photo = projects.getPhoto(String(req.params.photoId));
    if (!photo || photo.projectId !== project.id) return notFound(res);

    /** @type {Record<string, unknown>} */
    const patch = {};
    const roomKey = clampText(req.body?.roomKey, 64);
    if (roomKey) patch.roomKey = roomKey;
    const roomType = clampText(req.body?.roomType, 64);
    if (roomType) patch.roomType = roomType;
    if (req.body?.seq !== undefined) patch.seq = clampInt(req.body.seq, 0, 10000, photo.seq ?? 0);
    const frameRole = clampText(req.body?.frameRole, 16);
    if (frameRole && !ASSIGNABLE_FRAME_ROLES.includes(frameRole)) {
      return sendError(res, 400, 'Unknown frame role', { code: 'BAD_FRAME_ROLE', details: `frameRole must be one of: ${ASSIGNABLE_FRAME_ROLES.join(', ')}` });
    }
    if (frameRole && frameRole !== 'hero') patch.frameRole = frameRole;

    if (Object.keys(patch).length) projects.updatePhoto(photo.id, patch);
    // setHero is the only writer that can promote a frame: it has to demote the room's
    // previous hero in the same breath, which a plain updatePhoto would not do.
    if (frameRole === 'hero') {
      const room = roomKey || photo.roomKey;
      if (!room) return sendError(res, 400, 'Assign a room before promoting a hero', { code: 'NO_ROOM_KEY' });
      projects.setHero(project.id, room, photo.id);
    }
    setSensitiveHeaders(res);
    res.json({ photo: projects.getPhoto(photo.id) });
  }));

  router.delete('/api/projects/:id/photos/:photoId', guard('projects.photos.delete', async (req, res) => {
    const user = requireProAccount(req, res);
    if (!user) return;
    const project = ownedProject(req, user);
    if (!project) return notFound(res);
    const photo = projects.getPhoto(String(req.params.photoId));
    if (!photo || photo.projectId !== project.id) return notFound(res);
    // DB first — same ordering rationale as DELETE /api/projects/:id. The store returns
    // every orphaned key (the source plus each render of it) precisely so the blobs can
    // be unlinked afterwards; dropping only `photo.storageKey` would leak the renders.
    const removal = projects.deletePhoto(photo.id);
    const keys = removal.ok ? removal.storageKeys : [photo.storageKey];
    await Promise.all(keys.map((key) => storage.remove(key).catch(() => false)));
    setSensitiveHeaders(res);
    res.json({ ok: true, deleted: photo.id, blobs: keys.length });
  }));

  // ── Queue ──────────────────────────────────────────────────────────────────
  // /stage, /progress, /regenerate, /cancel and /retry, in routes/projects-queue.js —
  // everything that spends money or stops spending it. The invariants they share (a room
  // needs a real hero ROW; heroes before support frames; re-enqueueing is idempotent) are
  // written up in that file's header.

  registerQueueRoutes({
    router, projects, pickHero, listingWorker,
    requireProAccount, guard, notFound, ownedProject, setSensitiveHeaders, genLimiter,
  });

  // ── Bulk delivery ──────────────────────────────────────────────────────────
  // GET /api/projects/:id/renders.zip, in routes/projects-download.js. Same auth and
  // ownership rules as the byte routes below; it is the only way output leaves the app.

  registerRenderArchiveRoute({ router, projects, storage, requireProAccount, guard, notFound, ownedProject });

  // ── Client share links ─────────────────────────────────────────────────────
  // /api/projects/:id/share, in routes/projects-share.js — the OWNER's controls for the
  // one public surface this feature has. The public half (what the seller or buyer
  // actually opens) is routes/share-public.js, mounted separately in server.js because it
  // is unauthenticated and must not inherit anything from this router.
  //
  // The share store is reached through `projects.shares` rather than injected on its own,
  // because it is composed into the project store precisely so a listing and its links
  // die in one transaction (see lib/data/projects.js).

  registerShareRoutes({
    router, shares: projects.shares,
    requireProAccount, guard, notFound, ownedProject, setSensitiveHeaders, appUrl,
  });

  // ── Seller sign-off ────────────────────────────────────────────────────────
  // routes/share-feedback.js: the owner's inbox (`GET /api/projects/:id/feedback`) AND the
  // two PUBLIC routes a share viewer answers on (`POST|GET /api/share/:token/feedback`).
  //
  // ⚠️ THIS IS THE ONE EXCEPTION TO THIS FILE'S "every route is Stagify+ gated" RULE, and it
  // is deliberate. Registering the pair here rather than on the public router is what lets
  // them reuse `ownedProject` — the single implementation of "does this session own this
  // listing" — instead of a second copy, and a second copy of an ownership check is how IDOR
  // bugs are actually written. The cost is this comment; do not read the surrounding file
  // and conclude that everything mounted on this router is authenticated.
  //
  // The two public routes carry their own limiter, their own no-referrer/noindex headers and
  // their own uniform 404, all inside that module. They inherit nothing from here — this
  // router has no middleware chain to inherit.

  registerFeedbackRoutes({
    router, shares: projects.shares, feedback: projects.feedback, projects,
    requireProAccount, guard, notFound, ownedProject, setSensitiveHeaders,
  });

  // ── Image bytes ────────────────────────────────────────────────────────────

  router.get('/api/projects/:id/photos/:photoId/image', guard('projects.photo.image', async (req, res) => {
    const user = requireProAccount(req, res);
    if (!user) return;
    const project = ownedProject(req, user);
    if (!project) return notFound(res);
    const photo = projects.getPhoto(String(req.params.photoId));
    // Unknown, another account's, another project's, and "no bytes stored" all answer the
    // same 404 — the ORIGINAL photos are as private as the renders (they are someone's
    // unstaged house), so this route is session-gated exactly like the render route below
    // and deliberately NOT public like /i/:id.
    if (!photo || photo.projectId !== project.id || !photo.storageKey) return notFound(res);

    // storage.read rejects (ENOENT) rather than resolving null when the blob is gone.
    const bytes = await storage.read(photo.storageKey).catch(() => null);
    if (!bytes || !bytes.length) return notFound(res);
    res.set('Content-Type', serveContentType(photo.storageKey));
    // The key embeds the photo's content hash, so these bytes can never change under the
    // same URL — but PRIVATE, so no shared proxy keeps a copy of someone's listing.
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.set('X-Content-Type-Options', 'nosniff');
    res.end(bytes);
  }));

  router.get('/api/projects/:id/renders/:renderId/image', guard('projects.render.image', async (req, res) => {
    const user = requireProAccount(req, res);
    if (!user) return;
    const project = ownedProject(req, user);
    if (!project) return notFound(res);
    const render = projects.getRender(String(req.params.renderId));
    // Unknown, not-ours, and not-yet-rendered are all 404 — this route is the only
    // thing standing between a session and another account's pixels, so it is
    // deliberately NOT public like /i/:id (which serves unguessable admin uploads).
    if (!render || render.projectId !== project.id || !render.storageKey) return notFound(res);

    // storage.read rejects (ENOENT) rather than resolving null when the blob is gone.
    const bytes = await storage.read(render.storageKey).catch(() => null);
    if (!bytes || !bytes.length) return notFound(res);
    res.set('Content-Type', serveContentType(render.storageKey));
    // A render id names immutable bytes (a re-render gets a new row), so it is safe to
    // cache hard — but PRIVATE, so no shared proxy keeps a copy of someone's listing.
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.set('X-Content-Type-Options', 'nosniff');
    res.end(bytes);
  }));

  // ── Upload-limit errors ────────────────────────────────────────────────────
  // Router-scoped, so it only ever sees errors raised by the routes above. multer aborts
  // the whole request when ONE file trips `limits.fileSize`, and the generic 413 the app
  // handler produces carried no way to tell that apart from "the batch is too big" — the
  // studio's advice ("try a smaller batch") was therefore unfollowable, because the limit
  // is per photo. A distinct code plus the per-photo limit in `details` is what lets the
  // client name the offending file instead of blaming the batch.
  //
  // Nothing exception-derived reaches the body: multer's own `err.message` is a fixed
  // table, but these are fixed strings written here, so the question does not arise.
  router.use(/** @type {import('express').ErrorRequestHandler} */ ((err, req, res, next) => {
    // A fileFilter rejection is NOT a MulterError — multer forwards whatever object the
    // callback was given — so it has to be matched on its own code, before the instanceof
    // below. Without this branch it fell through to the app catch-all as a 500: a server
    // error for a request that was refused exactly as intended, with no code for the client
    // and a Sentry report for every one.
    if (err && err.code === UNSUPPORTED_PHOTO_CODE) {
      return sendError(res, 415, 'That file is not a supported photo', {
        code: UNSUPPORTED_PHOTO_CODE,
        details: 'Upload PNG, JPG, JPEG or WebP photos.',
      });
    }
    if (!(err instanceof multer.MulterError)) return next(err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return sendError(res, 413, 'One of those photos is larger than the per-photo limit', {
        code: 'PHOTO_TOO_LARGE',
        details: `Each photo must be ${Math.round(MAX_PHOTO_BYTES / (1024 * 1024))}MB or smaller. The limit is per photo, not per batch.`,
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return sendError(res, 413, 'Too many photos in one upload', {
        code: 'TOO_MANY_PHOTOS',
        details: `Upload at most ${MAX_PHOTOS_PER_BATCH} photos at a time.`,
      });
    }
    return sendError(res, 400, 'That upload could not be read', { code: 'UPLOAD_REJECTED' });
  }));

  return router;
}
