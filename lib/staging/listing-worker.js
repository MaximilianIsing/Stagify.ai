// Listing-staging job worker — the engine behind the multi-photo "listing" feature.
//
// WHY SERIAL, AND WHY IN-PROCESS
// One listing is 20–40 photos and, at 3 variations, ~90 paid image generations. That
// cannot run inside a request, so it is a queue. It is NOT a separate service, and it
// processes exactly ONE render per tick, because:
//   * Single-instance SQLite is a documented known limitation of this repo — one shared
//     better-sqlite3 connection in lib/data/db.js, one web process. A second process or
//     a parallel fan-out would contend on that single writer for no throughput win,
//     since the real bottleneck is the upstream image model, not us.
//   * Serial keeps the cost ceiling legible: at most one generation in flight per
//     instance, so a runaway listing cannot fan out into an unbounded model bill.
// Nothing is held in memory between ticks. ALL job state — the queue, the claim, the
// design bible, the output blob key — lives in the database, so the work is resumable:
// a deploy, a crash, or an OOM kill loses at most the one render that was in flight.
//
// WHY THE LEASE + RECLAIM EXISTS
// `claimNextRender` leases a row (status 'running' + `claimed_at`); it does not remove
// it. If this process dies mid-render — and Render restarts it on every deploy — that
// row would otherwise stay 'running' forever and the listing would stall one frame
// short, with no error anywhere. So every tick calls `reclaimStaleClaims` FIRST: a claim
// older than `leaseMs` goes back to 'queued' and is retried. The lease is what makes
// "resumable" true rather than aspirational, and it is why the claim is a DB write
// instead of an in-memory set.
//
// CONSISTENCY IS THE PRODUCT
// The hero frame of each room renders first, and its result is distilled into a design
// bible (the pieces, materials and palette actually placed). Support frames of the same
// room render ONLY once that bible exists, conditioned on it plus the hero image itself.
// If the bible cannot be extracted the support frames stay blocked — see the comment at
// that branch for why that is the correct failure.

import { logger } from '../logger.js';
import { PLUS_MODEL } from '../config/model-config.js';
import { DEFAULT_LEASE_MS } from '../data/project-renders.js';

/**
 * How long a claimed render may sit before another tick may reclaim it — RE-EXPORTED from
 * the store, never redeclared. The store owns this number because it owns the consequence
 * (its comment: generous on purpose, a duplicate render costs a paid API call), and the
 * worker's value is the one that actually governs, since it is what gets passed to
 * `reclaimStaleClaims`. Two declarations meant the tighter one silently won and the store's
 * stated policy was fiction.
 */
export { DEFAULT_LEASE_MS };
/** How often `start()` polls the queue. */
export const DEFAULT_INTERVAL_MS = 2000;

/**
 * Total generations one render row may consume before it is failed for good — the worker
 * budget, counted in `renders.gen_attempts`. Bounded because every attempt is a paid model
 * call: unbounded retry turns one poisoned photo into an unbounded bill.
 */
export const MAX_RENDER_ATTEMPTS = 3;

/**
 * Failures no retry can fix, so they are failed immediately instead of consuming the budget.
 * Each one is a missing INPUT, not a flaky call: the photo row or its bytes are gone, the
 * bible the frame must match does not exist, or the render row itself was deleted mid-flight.
 * Retrying any of them re-reads the same absence and bills for the privilege.
 *
 * A DENYLIST rather than an allowlist of retryable codes, on purpose. The transient set is
 * open-ended — every upstream 5xx, refusal, socket reset and SQLITE_BUSY the pipeline can
 * surface — so an allowlist would be permanently incomplete, and its failure mode is the
 * defect this exists to fix: a frame silently lost while the UI reports success. The failure
 * mode of guessing wrong here is bounded instead, at MAX_RENDER_ATTEMPTS tries.
 */
export const TERMINAL_ERROR_CODES = Object.freeze([
  'PHOTO_MISSING', 'SOURCE_MISSING', 'BIBLE_MISSING', 'RENDER_GONE', 'ENOENT',
]);

/**
 * Is this failure worth another attempt?
 * @param {string} errorCode - The stable code recorded on the render row.
 * @returns {boolean} False for a missing input, true for anything that looks transient.
 */
export function isRetryableFailure(errorCode) {
  return !TERMINAL_ERROR_CODES.includes(String(errorCode));
}

// `processStaging` resolves to a delivery data URL — WebP normally, the model's PNG when
// the delivery upscale failed open. Both the bytes and the real mime type come from here.
const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/;

const MIME_EXT = /** @type {Record<string, string>} */ ({
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
});

/**
 * @typedef {Object} ListingWorkerStats
 * @property {number} ticks Ticks that claimed a render (empty polls excluded).
 * @property {number} completed
 * @property {number} failed
 * @property {number} blockedByMissingBible PROCESS-WIDE, SINCE BOOT: heroes that rendered but
 *   yielded no bible, across every listing of every customer, reset by any deploy. It is an
 *   operator diagnostic ("bible extraction is failing more than usual"), NOT a per-listing
 *   number — do not surface it as one. The per-project truth is in the database:
 *   `progressFor().blocked` for work that is still barred, and failed rows carrying
 *   `BIBLE_MISSING` for the rooms this settled.
 */

/**
 * @typedef {Object} ListingTickResult
 * @property {boolean} done False when the queue was empty (nothing was claimed).
 * @property {string} [renderId]
 * @property {'hero'|'support'} [kind]
 * @property {'ok'|'failed'|'retrying'} [status] 'retrying' is a transient failure that went
 *   back on the queue with budget left; 'failed' is terminal.
 * @property {string} [errorCode]
 * @property {boolean} [bibleCreated] Hero path only: did a bible land (and unblock support)?
 * @property {number} [blockedFailed] Hero path only: queued support rows this tick settled as
 *   BIBLE_MISSING because their room's bible never materialised.
 * @property {number} blockedByMissingBible SINCE-BOOT, PROCESS-WIDE count (see
 *   ListingWorkerStats) — a diagnostic, not this listing's number.
 */

/**
 * @typedef {ReturnType<typeof import('../data/projects.js').createProjects>
 *   & Pick<ReturnType<typeof import('../data/project-renders.js').createProjectRenders>,
 *     'requeueRenderForRetry' | 'failBlockedRendersForRoom'>} ProjectStore
 *   The composed store. `createProjects` builds its API by naming each render-queue export
 *   EXPLICITLY, so a queue function can exist and still not reach this worker. The `Pick` is
 *   the drift guard for the two the retry and blocked-row paths depend on: drop either from
 *   the destructuring or the returned object in lib/data/projects.js and the typecheck fails
 *   here, instead of the worker taking a TypeError at 3am on the one path that only runs
 *   when something has already gone wrong.
 */

/**
 * @typedef {Object} ListingWorkerDeps
 * @property {ProjectStore} projects Project/photo/render/bible store.
 * @property {ReturnType<typeof import('../data/project-storage.js').createProjectStorage>} storage Blob store for source photos and render outputs.
 * @property {ReturnType<typeof import('./staging-generation.js').createStagingGeneration>['processStaging']} processStaging
 *   Called with `req: null` — there is no request behind a queued render, so nothing
 *   here meters per-request usage; the audit fields come back via the `outcome` arg.
 * @property {ReturnType<typeof import('./design-bible.js').createDesignBible>['extractBible']} extractBible
 *   Resolves null when it cannot describe the room — which blocks that room's support frames.
 * @property {typeof import('../config/model-config.js').getGeminiImageModel} getGeminiImageModel
 * @property {((userId: string, quantity: number) => void) | null} [reportListingUsage] Meters
 *   one completed render against the owner's enterprise domain, if they are on one. Optional
 *   and best-effort: see the note at the call site in `storeRender`.
 * @property {((userId: string) => string) | null} [resolveOwnerEmail] Resolves a listing
 *   owner's email for the CSV render log. Optional: without it rows say 'unknown', which is
 *   the pre-existing behaviour and the reason GDPR erasure could not match them.
 * @property {boolean} [DEBUG_MODE]
 * @property {number} [leaseMs]
 * @property {number} [intervalMs]
 */

/**
 * Split a delivery data URL into its mime type and bytes.
 * @param {unknown} dataUrl - Whatever the staging pipeline resolved to.
 * @returns {{ mimeType: string, buffer: Buffer }|null} Null when it is not a non-empty base64 image data URL.
 */
function decodeImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = DATA_URL_RE.exec(dataUrl.trim());
  if (!match) return null;
  const buffer = Buffer.from(match[2], 'base64');
  return buffer.length ? { mimeType: match[1].toLowerCase(), buffer } : null;
}

/**
 * Read the operator's job settings off the project's `extra` bag, falling back to values
 * that are safe to render with. A missing or hand-edited `extra_json` must never strand a
 * listing — it degrades to a plain staging request. (`getProject` has already parsed the
 * column and hands back null when it was unparseable.)
 * @param {import('../types/projects.js').Project|null} project - Project row.
 * @param {import('../types/projects.js').ProjectPhoto|null} photo - The photo being rendered; its own roomType wins.
 * @returns {{ roomType: string, furnitureStyle: string, additionalPrompt: string, removeFurniture: boolean, ownerEmail?: string }} Resolved staging inputs. `ownerEmail` is filled in by the caller when a resolver is wired.
 */
export function readJobSettings(project, photo) {
  const raw = project?.extra?.jobSettings;
  const settings = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  return {
    roomType: photo?.roomType || 'Living room',
    furnitureStyle: typeof settings.furnitureStyle === 'string' && settings.furnitureStyle ? settings.furnitureStyle : 'standard',
    additionalPrompt: typeof settings.additionalPrompt === 'string' ? settings.additionalPrompt : '',
    removeFurniture: settings.removeFurniture === true,
  };
}

/**
 * An Error carrying a stable `code`, so `failRender` records a category rather than prose
 * (and nothing exception-derived can ever reach a response body).
 * @param {string} message - Operator-facing message; logged, never returned.
 * @param {string} code - Stable error code stored on the render row.
 * @returns {Error & { code: string }} The tagged error.
 */
function withCode(message, code) {
  const err = /** @type {Error & { code: string }} */ (new Error(message));
  err.code = code;
  return err;
}

/**
 * Build the listing-staging worker. `tick()` is the unit: it processes at most one queued
 * render and never throws, so one poisoned photo cannot strand a whole listing.
 * @param {ListingWorkerDeps} deps - Injected store, blob storage, staging pipeline, bible extractor, model resolver, and timing knobs.
 * @returns {{ start: () => void, stop: () => void, tick: () => Promise<ListingTickResult>, isRunning: () => boolean, stats: () => ListingWorkerStats }} The worker API.
 */
export function createListingWorker(deps) {
  const {
    projects,
    storage,
    processStaging,
    extractBible,
    getGeminiImageModel,
    // Resolves a listing owner's email so the CSV render log is attributable to a person.
    // Optional: omitted, rows fall back to 'unknown' exactly as before, which is why it is
    // a seam rather than a hard dependency (every existing test builds this worker without
    // it). See the ownerEmail note in staging-generation.js for why the attribution matters.
    resolveOwnerEmail = null,
    // Meters a completed render against the owner's enterprise domain. Optional for the
    // same reason as resolveOwnerEmail — the worker has no `req`, every existing test
    // builds it without one, and a missing meter must not stop a render.
    reportListingUsage = null,
    DEBUG_MODE = false,
    leaseMs = DEFAULT_LEASE_MS,
    intervalMs = DEFAULT_INTERVAL_MS,
  } = deps;

  // Listing staging is Stagify+ only, so it always renders on the plus-tier image model
  // rather than the free-tier default `getGeminiImageModel()` would return.
  const geminiModel = getGeminiImageModel(PLUS_MODEL);

  /** @type {ListingWorkerStats} */
  const counters = { ticks: 0, completed: 0, failed: 0, blockedByMissingBible: 0 };
  /** @type {NodeJS.Timeout|null} */
  let timer = null;
  // Ticks must never overlap: the whole design is one render in flight per instance, and
  // a real generation easily outlives the poll interval.
  let inFlight = false;

  const debug = (...args) => {
    if (DEBUG_MODE) logger.debug('[listing-worker]', ...args);
  };

  /**
   * @param {Partial<ListingTickResult>} fields - Result fields for this tick.
   * @returns {ListingTickResult} The result, with the running blocked count folded in.
   */
  const result = (fields) => ({ done: false, ...fields, blockedByMissingBible: counters.blockedByMissingBible });

  /**
   * Persist a finished render's bytes plus its audit trail.
   * @param {import('../types/projects.js').Render} render - The claimed render row.
   * @param {unknown} raw - The staging pipeline's return value (a data URL).
   * @param {import('../types/staging.js').StagingOutcome} outcome - Out-parameter the pipeline filled in.
   * @param {number} startedAt - Epoch ms when this tick began, for durationMs.
   * @returns {Promise<string>} The stored data URL (the bible extractor needs it).
   */
  async function storeRender(render, raw, outcome, startedAt) {
    const decoded = decodeImageDataUrl(raw);
    if (!decoded) throw withCode('staging result was not a base64 image data URL', 'NO_IMAGE_GENERATED');
    // Derive the extension from the bytes we actually got rather than hardcoding `webp`:
    // the delivery upscale fails open to the model's PNG, and a PNG stored under a .webp
    // key would be served with the wrong content-type by the byte-serve route.
    const ext = MIME_EXT[decoded.mimeType] || 'webp';
    const storageKey = storage.keyFor({ projectId: render.projectId, kind: 'out', id: render.id, ext });
    await storage.write(storageKey, decoded.buffer);
    const completed = projects.completeRender(render.id, {
      storageKey,
      // Prompt / model / attempts / scores are the compliance audit trail for a paid
      // render, not debug noise: they are what lets us answer "what produced this
      // image, on which model, after how many tries?" months later.
      promptText: outcome.promptText,
      model: outcome.model || geminiModel,
      genAttempts: outcome.attempts,
      qualityScore: outcome.qualityScore ?? undefined,
      consistencyScore: outcome.consistencyScore ?? undefined,
      // The slots that drifted from the bible — the reason behind a low consistency score.
      // The pipeline computes it per render and it used to be dropped on the floor, leaving
      // the UI able to say "88" but not "the sofa and the rug drifted".
      extra: Array.isArray(outcome.mismatchedSlots) ? { mismatchedSlots: [...outcome.mismatchedSlots] } : undefined,
      durationMs: Date.now() - startedAt,
      now: Date.now(),
    });
    if (!completed) {
      // The row stopped being live work while we were generating — overwhelmingly: the user
      // deleted the listing mid-render. `storage.write` above did a mkdir -p, so it just
      // RECREATED the project directory that DELETE removed and put a staged photo of a
      // deleted listing back on disk. Nothing references it, so no sweep would ever find it:
      // remove it here or it is an orphan blob of user content, forever.
      const removed = await storage.remove(storageKey).catch((err) => {
        logger.error(`[listing-worker] could not remove orphan render blob ${storageKey}:`, err);
        return false;
      });
      logger.warn(`[listing-worker] render ${render.id} vanished mid-flight (project ${render.projectId} deleted or superseded); orphan blob ${removed ? 'removed' : 'LEFT BEHIND'}`);
      throw withCode('render row was gone when the result landed', 'RENDER_GONE');
    }
    counters.completed += 1;
    meterRender(render, outcome);
    return /** @type {string} */ (raw);
  }

  /**
   * Bill one completed render to the owner's enterprise domain.
   *
   * WHY THIS IS HERE AND NOT IN THE ROUTE. Every other paid path meters inside its request
   * handler, off `req`'s user (virtual-staging-handler.js, mask-edit.js). The Listing Studio
   * has no such moment: `/stage` only ENQUEUES, and the renders happen minutes later in this
   * worker, with no request in scope. That gap is why listing renders were metering NOTHING
   * — enterprise-domain accounts are promoted to `plan: 'pro'` by `enhanceUserWithEnterprise`,
   * so they passed the pro gate and rendered whole listings with no meter event at all. The
   * highest-volume tier was the one getting the feature free.
   *
   * QUANTITY IS `attempts`, NOT 1, matching the single-photo path: a quality-gate retry is a
   * real generation that really cost money. It falls back to 1 rather than 0 so a pipeline
   * that forgot to fill in the outcome under-reports by a little instead of billing nothing.
   *
   * BEST-EFFORT BY CONSTRUCTION. This runs AFTER `completeRender` has committed, and it
   * swallows its own errors: a Stripe meter call that fails must not turn a delivered render
   * into a failed one and re-queue a paid image. The consequence is that a metering outage
   * loses events rather than double-billing, which is the right direction to be wrong in.
   * @param {import('../types/projects.js').Render} render - The render just completed.
   * @param {import('../types/staging.js').StagingOutcome} outcome - Its pipeline outcome.
   * @returns {void}
   */
  function meterRender(render, outcome) {
    if (typeof reportListingUsage !== 'function') return;
    try {
      const project = projects.getProject(render.projectId);
      if (!project || !project.userId) return;
      const quantity = Number.isFinite(outcome.attempts) && Number(outcome.attempts) > 0
        ? Math.trunc(Number(outcome.attempts))
        : 1;
      reportListingUsage(project.userId, quantity);
    } catch (err) {
      logger.warn(`[listing-worker] usage metering failed for render ${render.id}:`, err && err.message ? err.message : err);
    }
  }

  /**
   * Hero frame: render it, then distil the design bible every support frame of the same
   * room is conditioned on.
   * @param {import('../types/projects.js').Render} render - The claimed hero render.
   * @param {import('../types/projects.js').ProjectPhoto} photo - Its photo row.
   * @param {Buffer} buf - The source photo bytes.
   * @param {ReturnType<typeof readJobSettings>} settings - Resolved job settings.
   * @param {number} startedAt - Epoch ms when this tick began.
   * @returns {Promise<{ bibleCreated: boolean, blockedFailed: number }>} Whether a bible
   *   landed (i.e. support frames were unblocked) and, when it did not, how many support rows
   *   were settled as BIBLE_MISSING instead of being left queued forever.
   */
  async function runHero(render, photo, buf, settings, startedAt) {
    /** @type {import('../types/staging.js').StagingOutcome} */
    const outcome = {};
    const raw = await processStaging(buf, { ...settings, frameRole: 'hero' }, null, null, geminiModel, outcome);
    const dataUrl = await storeRender(render, raw, outcome, startedAt);

    const roomKey = photo.roomKey || 'room';
    const doc = await extractBible(dataUrl, {
      roomKey,
      roomType: settings.roomType,
      furnitureStyle: settings.furnitureStyle,
    });
    if (!doc) {
      // No bible means NO SUPPORT RENDERS — never "support renders unconditioned". Rendering
      // them blind would produce a differently-furnished room at every angle, which is
      // precisely what this feature exists to prevent.
      //
      // But blocked is not the same as left hanging. Those rows are queued with no bible on a
      // non-hero frame, i.e. structurally unclaimable: leaving them there kept `queued`
      // non-zero forever, so the listing never read as finished, the browser polled every
      // 2.5s indefinitely and /stage answered 409 "already queued" with no way out. So they
      // are FAILED with a code — the queue drains, the UI can name the room that lost its
      // consistency pass, and the operator can regenerate it.
      counters.blockedByMissingBible += 1;
      logger.warn(`[listing-worker] no design bible for project ${render.projectId} room ${roomKey}; its support frames stay blocked`);
      const blockedFailed = projects.failBlockedRendersForRoom(render.projectId, roomKey, {
        errorCode: 'BIBLE_MISSING', now: Date.now(),
      });
      if (blockedFailed) logger.warn(`[listing-worker] ${blockedFailed} support render(s) in room ${roomKey} failed as BIBLE_MISSING`);
      return { bibleCreated: false, blockedFailed };
    }
    // ONE store call, not createBible + attachBibleToQueuedRenders: attaching is what lifts
    // the claim barrier, and a crash in the gap between the two leaves a room that HAS a
    // bible whose support frames are still barred forever. The store owns that transaction.
    const { bible, unblocked } = projects.createBibleAndUnblockRoom({
      projectId: render.projectId,
      roomKey,
      heroRenderId: render.id,
      doc,
      roomType: settings.roomType,
      furnitureStyle: settings.furnitureStyle,
      now: Date.now(),
    });
    debug(`bible ${bible.id} attached to ${unblocked} queued render(s) in room ${roomKey}`);
    return { bibleCreated: true, blockedFailed: 0 };
  }

  /**
   * Support frame: same room, another angle, the same pieces. Conditioned on the room's
   * bible plus the hero render itself.
   * @param {import('../types/projects.js').Render} render - The claimed support render (its bibleId is set).
   * @param {import('../types/projects.js').ProjectPhoto} photo - Its photo row.
   * @param {Buffer} buf - The source photo bytes.
   * @param {ReturnType<typeof readJobSettings>} settings - Resolved job settings.
   * @param {number} startedAt - Epoch ms when this tick began.
   * @returns {Promise<void>} Resolves once the render is stored.
   */
  async function runSupport(render, photo, buf, settings, startedAt) {
    const bible = render.bibleId ? projects.getBible(render.bibleId) : null;
    if (!bible || !bible.doc) throw withCode('design bible row is missing or unparseable', 'BIBLE_MISSING');

    // The hero render rides the existing extra-image ("furniture reference") channel;
    // staging-generation.js sees `designBible` and reads that slot as "the same room
    // already staged, from another angle" instead of as loose inspiration.
    const heroRender = bible.heroRenderId ? projects.getRender(bible.heroRenderId) : null;
    /** @type {Buffer|null} */
    let heroBuffer = null;
    if (heroRender?.storageKey) {
      heroBuffer = await storage.read(heroRender.storageKey).catch(() => null);
    }
    if (!heroBuffer || !heroBuffer.length) {
      // Degraded but still CONDITIONED: the bible is a structured text description of the
      // locked pieces, and the pipeline appends it whether or not a reference image came
      // with it. So a lost hero blob costs fidelity, not consistency — unlike a missing
      // bible, which would make this a blind re-stage and is a hard failure above.
      heroBuffer = null;
      logger.warn(`[listing-worker] hero render bytes unavailable for render ${render.id}; conditioning on the bible text alone`);
    }

    /** @type {import('../types/staging.js').StagingOutcome} */
    const outcome = {};
    const raw = await processStaging(
      buf,
      {
        ...settings,
        roomType: photo.roomType || settings.roomType,
        designBible: bible.doc,
        frameRole: 'support',
      },
      null,
      heroBuffer ? [heroBuffer] : null,
      geminiModel,
      outcome,
    );
    await storeRender(render, raw, outcome, startedAt);
  }

  /**
   * Move a listing off 'staging' once nothing is claimable and nothing is running — the only
   * thing that ever writes 'ready', so without it every finished listing stayed 'staging'
   * forever. It runs after a FAILURE too, and after a room's blocked rows have been settled:
   * a listing whose last remaining work was structurally blocked must come to rest at 'ready'
   * with failed frames rather than hang, which is the state the operator can actually act on.
   *
   * Only 'staging' is promoted. A 'draft' listing is still being assembled and an 'archived'
   * one was retired deliberately; a stray render finishing must not drag either into 'ready'.
   * Never throws — settling a status must not turn a completed render into a failed tick.
   * @param {string} projectId - The listing the finished render belonged to.
   * @returns {boolean} True when this call promoted the project to 'ready'.
   */
  function settleProject(projectId) {
    try {
      if (projects.hasPendingWork(projectId)) return false;
      const project = projects.getProject(projectId);
      if (!project || project.status !== 'staging') return false;
      projects.updateProject(projectId, { status: 'ready', now: Date.now() });
      debug(`project ${projectId} has no pending work left; status -> ready`);
      return true;
    } catch (err) {
      logger.error(`[listing-worker] could not settle project ${projectId}:`, err);
      return false;
    }
  }

  /**
   * Record a failed attempt: back on the queue when the failure looks transient and the row
   * still has budget, terminal otherwise. A transient error used to be terminal at the first
   * occurrence, so one 503 on frame 2 of 3 lost that frame while `isProgressComplete` went
   * true and the operator was told staging had finished.
   * @param {import('../types/projects.js').Render} render - The claimed render that failed.
   * @param {string} errorCode - Stable code for the failure.
   * @param {number} startedAt - Epoch ms when this tick began, for durationMs.
   * @returns {'failed'|'retrying'} What the row ended up as.
   */
  function recordFailure(render, errorCode, startedAt) {
    const arg = { errorCode, durationMs: Date.now() - startedAt, now: Date.now() };
    if (isRetryableFailure(errorCode)) {
      const requeued = projects.requeueRenderForRetry(render.id, { ...arg, maxAttempts: MAX_RENDER_ATTEMPTS });
      if (requeued) {
        logger.warn(`[listing-worker] render ${render.id} requeued after ${errorCode} (attempt ${requeued.genAttempts} of ${MAX_RENDER_ATTEMPTS})`);
        return 'retrying';
      }
    }
    // Either the failure is one no retry can fix, or the budget is spent. A requeue that
    // declined did not count the attempt, so `failRender` counting it here is exactly once.
    projects.failRender(render.id, arg);
    return 'failed';
  }

  /**
   * Process at most one queued render. Never throws.
   * @returns {Promise<ListingTickResult>} `{ done: false }` when the queue was empty.
   */
  async function tick() {
    const startedAt = Date.now();
    /** @type {import('../types/projects.js').Render|null} */
    let render;
    try {
      // First, always: a process killed mid-render left its lease behind, and only this
      // sweep puts that row back in the queue.
      projects.reclaimStaleClaims({ now: Date.now(), leaseMs });
      render = projects.claimNextRender({ now: Date.now(), leaseMs });
    } catch (err) {
      logger.error('[listing-worker] queue poll failed:', err);
      return result({ done: false });
    }
    if (!render) return result({ done: false });

    counters.ticks += 1;
    // Provisional, for the failure log below: the real role comes off the PHOTO, which we
    // have not read yet. It is only ever 'hero' here so a pre-photo failure is not mislabelled
    // as a support frame.
    /** @type {'hero'|'support'} */
    let kind = 'hero';
    try {
      const photo = projects.getPhoto(render.photoId);
      if (!photo) throw withCode('photo row is missing', 'PHOTO_MISSING');
      // THE ROLE IS THE PHOTO'S, not `render.bibleId`'s. Deriving it from the bible column
      // made a row's bible the thing that decided which pipeline ran it, so a hero that had
      // been stamped with a bible (which `attachBible` used to do) was dispatched down the
      // SUPPORT path and staged against a bible extracted from a different frame — with the
      // backstop below unable to fire, because `kind` was already 'support'. The photo's
      // frame_role is the same column the store's claim barrier reads, so worker and queue
      // now agree by construction on what a frame is.
      kind = photo.frameRole === 'hero' ? 'hero' : 'support';
      if (kind === 'support' && !render.bibleId) {
        // The store's claim barrier (`frame_role = 'hero' OR bible_id IS NOT NULL`)
        // should make this unreachable. If it ever fires, failing is the correct
        // outcome: a support frame with no bible must not be rendered at all.
        throw withCode('non-hero frame claimed with no design bible', 'BIBLE_MISSING');
      }
      const buf = await storage.read(photo.storageKey);
      if (!buf || !buf.length) throw withCode('source photo bytes are unreadable', 'SOURCE_MISSING');
      const project = projects.getProject(render.projectId);
      const settings = readJobSettings(project, photo);
      // Attribution for the CSV render log. Resolved per tick rather than threaded through
      // the queue so no email is ever written into a `renders` row or into `extra_json` —
      // the log is the one place it belongs, because that is the place erasure knows how to
      // redact. Never allowed to break a render: a resolver that throws just means the row
      // says 'unknown', which is the pre-existing behaviour.
      if (resolveOwnerEmail && project && project.userId) {
        try {
          const email = resolveOwnerEmail(project.userId);
          if (typeof email === 'string' && email) settings.ownerEmail = email;
        } catch (err) {
          logger.warn('[listing-worker] could not resolve the listing owner for the render log:', err && err.message ? err.message : err);
        }
      }
      debug(`claimed ${kind} render ${render.id} (photo ${photo.id}, room ${photo.roomKey || '?'})`);

      /** @type {{ bibleCreated: boolean, blockedFailed: number }|null} */
      let hero = null;
      if (kind === 'hero') hero = await runHero(render, photo, buf, settings, startedAt);
      else await runSupport(render, photo, buf, settings, startedAt);
      // AFTER the render is recorded (and after a hero's blocked rows are settled), because
      // that is what makes "nothing left to do" true or false.
      settleProject(render.projectId);
      // Spread rather than two `: undefined` fields, so a support tick's result has no
      // hero-only keys at all.
      return result({ done: true, renderId: render.id, kind, status: 'ok', ...(hero || {}) });
    } catch (err) {
      const errorCode = String(err?.code || err?.name || 'ERROR');
      counters.failed += 1;
      logger.error(`[listing-worker] ${kind} render ${render.id} failed (${errorCode}):`, err);
      /** @type {'ok'|'failed'|'retrying'} */
      let status = 'failed';
      try {
        status = recordFailure(render, errorCode, startedAt);
      } catch (failErr) {
        // The row keeps its lease, so the reclaim sweep will retry it rather than
        // stranding it — but the operator needs to know the write itself broke.
        logger.error(`[listing-worker] could not mark render ${render.id} failed:`, failErr);
      }
      // A terminal failure can be the last work a listing had; a requeue is not, so the
      // project must stay 'staging' — `settleProject` re-reads the queue rather than trusting
      // that distinction, so a retry it just queued keeps it out of 'ready' on its own.
      settleProject(render.projectId);
      return result({ done: true, renderId: render.id, kind, status, errorCode });
    }
  }

  return {
    /** Begin polling the queue. Idempotent. */
    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (inFlight) return;
        inFlight = true;
        // tick() never rejects, but .finally() keeps the flag honest even if that ever
        // stops being true — a stuck flag would silently halt the worker forever.
        tick().finally(() => { inFlight = false; });
      }, intervalMs);
      // unref() so this timer never holds the event loop open: an un-unref'd interval
      // hangs `node --test` (and a graceful shutdown) indefinitely.
      timer.unref();
      logger.info(`[listing-worker] started (interval ${intervalMs}ms, lease ${leaseMs}ms)`);
    },
    /** Stop polling. A render already in flight finishes on its own. */
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    tick,
    /** @returns {boolean} Is the poll timer armed? */
    isRunning() {
      return timer !== null;
    },
    /** @returns {ListingWorkerStats} Counters since boot — in-memory diagnostics, not persisted state. */
    stats() {
      return { ...counters };
    },
  };
}
