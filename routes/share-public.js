// The PUBLIC client-share surface — the only part of the Listing Studio reachable without
// a Stagify account, and therefore the highest-risk file in the feature.
//
// WHO IS ON THE OTHER END
// A broker mints a link (lib/data/project-shares.js) and texts it to the seller who has to
// approve the staging, or drops it in a listing email a buyer opens on a phone. Neither
// person has an account, so THE TOKEN IS THE ONLY CREDENTIAL. Everything below follows
// from that.
//
// ONE 404, ALWAYS, FOR EVERYTHING
// `resolveShare` answers NOT_FOUND / REVOKED / EXPIRED, and this file throws that
// distinction away on purpose: a caller who can tell "revoked" from "never existed" has
// learned that a token was once real, which is a slow oracle over a keyspace we otherwise
// never leak. The same 404 also covers a share whose listing is gone, a render id from
// somebody else's project, a render that failed, and a blob missing off disk. `notFound()`
// is the ONLY refusal in this file and every route funnels through it, body and headers
// alike — if you ever need a second refusal shape, you are building the oracle back.
//
// THE MANIFEST IS AN ALLOWLIST BY CONSTRUCTION
// `buildSharedListing` copies field by field and NEVER spreads a `Project`, `ProjectPhoto`
// or `Render` row. Those rows carry `userId`, storage keys, prompt text, model names,
// quality/consistency scores, error codes, bible ids and internal timestamps — none of
// which a buyer may see, and all of which a `...row` would publish the day somebody adds a
// column. Adding a field here has to be a deliberate line of code.
//
// ONE PREDICATE DECIDES WHAT IS PUBLIC
// `isPublishableFrame` gates BOTH the manifest and the render byte route, so the bytes you
// can fetch are exactly the bytes the manifest lists. Two copies of that rule would drift,
// and the drifted copy would be the one serving pixels: a failed, superseded or
// still-queued render, or a frame the broker has since excluded, must vanish from both at
// the same instant.
//
// CROSS-TENANT: NEVER TRUST AN ID IN THE PATH
// A render/photo id is servable only after the token resolves to a share and the row's
// `projectId` matches that share's. Without that comparison, ANY live link would serve ANY
// customer's pixels — a single missing `===` is the whole tenancy boundary here.
//
// HEADERS ARE PART OF THE SECURITY, NOT DECORATION
// The token sits in the PATH, so `Referrer-Policy: no-referrer` on every route is what
// stops an outbound link or a third-party image load from mailing the live credential to
// somebody else in a `Referer` header. `X-Robots-Tag: noindex, nofollow` keeps a seller's
// house out of Google when the link gets tweeted. Nothing is ever `public`-cacheable: a
// shared proxy must not retain a copy of a private listing.
import path from 'path';
import { createAsyncRouter } from '../lib/http/async-router.js';
import { sendError } from '../lib/http/http-helpers.js';
import { reportError } from '../lib/http/error-ref.js';
import { STAGING_DISCLOSURE } from '../lib/staging/staging-disclosure.js';
import { serveContentType } from './projects-shared.js';
import { OTHER_ROOM_TYPE } from '../lib/staging/room-clustering.js';

/** @typedef {import('../lib/types/projects.js').Project} Project */
/** @typedef {import('../lib/types/projects.js').ProjectPhoto} ProjectPhoto */
/** @typedef {import('../lib/types/projects.js').Render} Render */
/** @typedef {import('../lib/types/projects.js').ProjectShare} ProjectShare */
/** @typedef {import('../lib/types/projects.js').ShareSettings} ShareSettings */
/** @typedef {import('../lib/types/projects.js').SharedFrame} SharedFrame */
/** @typedef {import('../lib/types/projects.js').SharedRoom} SharedRoom */
/** @typedef {import('../lib/types/projects.js').SharedListing} SharedListing */

/** The static shell served at `/s/:token`; it fetches its own data from the manifest route. */
export const SHARE_PAGE_FILE = 'listing-share.html';

/**
 * Cache policy for everything that is not immutable bytes — including EVERY 404, so the
 * refusal is identical across the four routes. `private` (never `public`) keeps a shared
 * proxy from retaining a copy of a listing that is only meant for one recipient.
 */
export const SHARE_NO_STORE = 'private, no-store';

/**
 * Cache policy for the byte routes. A render id names immutable bytes (a re-render gets a
 * new row) and a photo key embeds the content hash, so a year is safe — but `private`, for
 * the same reason as above.
 */
export const SHARE_BYTE_CACHE = 'private, max-age=31536000, immutable';

const MAX_LABEL = 80;
const MAX_TITLE = 120;
const MAX_ADDRESS = 200;
const MAX_HEADLINE = 120;
const MAX_NOTE = 600;
const MAX_CONTACT = 120;

/**
 * Trim and hard-clamp anything on its way into the public payload.
 *
 * The store already clamps the share's own settings and routes/projects.js clamps the
 * title/address, so this is belt-and-braces — but this is the one response an anonymous
 * stranger reads, and an unbounded string here is an unbounded string there.
 * @param {unknown} value - Raw field from a row.
 * @param {number} max - Maximum characters kept.
 * @returns {string} The clamped string; '' when the field was not a string.
 */
function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Is this render publishable to someone holding the link?
 *
 * THE single definition, used by the manifest AND by the render byte route (see the
 * header). Four independent reasons to say no:
 *   * the render is not `ok`, or has no bytes — queued/running/failed/superseded work is
 *     internal, and a `superseded` row is a render a NEWER design bible retired, i.e. an
 *     image the broker has already replaced;
 *   * its photo row is gone;
 *   * the frame is not grouped into a room yet — the gallery is organised by room, and a
 *     frame with nowhere to sit is a frame nobody chose to publish;
 *   * the broker excluded the frame, or the upload gate rejected it. Both mean "kept in
 *     the shoot, never shown", and excluding a frame AFTER staging must retract its render
 *     from the public page immediately.
 * @param {Render|null} render - The render row.
 * @param {ProjectPhoto|null} photo - Its photo row, already looked up.
 * @returns {boolean} Whether the bytes may leave the building.
 */
export function isPublishableFrame(render, photo) {
  if (!render || !photo) return false;
  if (render.status !== 'ok' || !render.storageKey) return false;
  if (!photo.roomKey) return false;
  return photo.frameRole !== 'excluded' && photo.stageable !== false;
}

/**
 * A human room label from a grouping key, for the rooms whose photos never got a
 * `roomType` off the vision labeller. `living-room-1` → `Living room 1`.
 * @param {unknown} key - The room key.
 * @returns {string} A bounded, displayable label ('Room' when nothing survives).
 */
/**
 * The heading an 'Other' room gets on the PUBLIC page.
 *
 * `Other` is the clusterer's internal token for "not a room" — an exterior facade, a garage,
 * a stairwell (see room-clustering.js). It is a vocabulary value, not English, and it was
 * being used verbatim as a section heading on the page a seller and their buyers read. Those
 * frames are no longer staged at all, so this only arises for a listing staged before that
 * rule, or one whose frames the operator reclassified afterwards — in both cases a real
 * staged image exists, so it is relabelled rather than hidden: discarding a render the broker
 * paid for would be the worse of the two mistakes.
 */
export const OTHER_ROOM_LABEL = 'More photos';

/**
 * The viewer-facing heading for one room.
 *
 * Prefers the operator/model-supplied room type, EXCEPT when it is the not-a-room token —
 * and the key is checked too, because a frame can carry `other-1` with the type since
 * cleared, and `humanizeRoomKey('other-1')` would cheerfully render "Other 1".
 * @param {string} roomType - The photo's room type.
 * @param {string} key - The room key.
 * @returns {string} What the page shows.
 */
export function roomLabel(roomType, key) {
  if (roomType === OTHER_ROOM_TYPE) return OTHER_ROOM_LABEL;
  if (!roomType && /^other(-|$)/i.test(String(key ?? ''))) return OTHER_ROOM_LABEL;
  return roomType || humanizeRoomKey(key);
}

export function humanizeRoomKey(key) {
  const words = String(key ?? '').replace(/[^a-zA-Z0-9]+/g, ' ').trim().toLowerCase().slice(0, MAX_LABEL);
  if (!words) return 'Room';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Sort key for one frame within its room: the hero first (it is the frame the room's
 * design bible was authored from, so it is the one that reads as the room's "cover"),
 * then by the photo's `seq` — the operator's own ordering — then by variation so a
 * multi-variation frame is stable rather than however the rows came back.
 * @param {{ photo: ProjectPhoto, render: Render }} entry - A photo/render pair.
 * @returns {number[]} Ranks compared left to right.
 */
function frameRank(entry) {
  return [
    entry.photo.frameRole === 'hero' ? 0 : 1,
    Number(entry.photo.seq) || 0,
    Number(entry.render.variation) || 0,
  ];
}

/**
 * @param {{ photo: ProjectPhoto, render: Render }} a - Left entry.
 * @param {{ photo: ProjectPhoto, render: Render }} b - Right entry.
 * @returns {number} Comparator result, with the render id as the final tiebreak so the
 *   order is total (two identical ranks would otherwise sort unstably across engines).
 */
function compareFrames(a, b) {
  const left = frameRank(a);
  const right = frameRank(b);
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return String(a.render.id).localeCompare(String(b.render.id));
}

/**
 * Build the public manifest — field by field, never by spreading a row (see the header).
 *
 * WHAT IS DELIBERATELY ABSENT: the share token, `userId`, every `storageKey`, `promptText`,
 * `model`, `qualityScore`, `consistencyScore`, `errorCode`, `genAttempts`, `bibleId`,
 * `claimedAt`, `durationMs`, `createdAt`/`updatedAt`, `sha256`, `status`, and the project's
 * `extra` bag. A buyer gets ids they can fetch bytes with, and the words the broker chose.
 *
 * `photoId` is null unless the share publishes before/after AND the photo actually has
 * bytes — the byte route enforces the same two conditions, so a null here means the
 * original is genuinely unreachable rather than merely unmentioned.
 * @param {{ project: Project, photos: ProjectPhoto[], renders: Render[], settings: ShareSettings }} arg
 *   The listing's rows plus the owner's publication settings.
 * @returns {SharedListing} The whole `GET /api/share/:token` payload.
 */
export function buildSharedListing({ project, photos, renders, settings }) {
  /** @type {Map<string, ProjectPhoto>} */
  const photoById = new Map(photos.map((photo) => [photo.id, photo]));
  /** @type {Map<string, { key: string, label: string, entries: Array<{ photo: ProjectPhoto, render: Render }> }>} */
  const grouped = new Map();
  const showBefore = settings.showBefore === true;
  let frameCount = 0;

  for (const render of renders) {
    const photo = photoById.get(render.photoId) ?? null;
    if (!isPublishableFrame(render, photo)) continue;
    const row = /** @type {ProjectPhoto} */ (photo);
    const key = String(row.roomKey);
    let room = grouped.get(key);
    if (!room) {
      room = { key, label: '', entries: [] };
      grouped.set(key, room);
    }
    if (!room.label) room.label = text(row.roomType, MAX_LABEL);
    room.entries.push({ photo: row, render });
    frameCount += 1;
  }

  // A room with no publishable frame is not listed at all — an empty room heading would
  // advertise a part of the shoot the broker did not publish.
  const rooms = [...grouped.values()]
    .map((room) => {
      const entries = room.entries.slice().sort(compareFrames);
      return {
        // Rooms follow the operator's photo order, keyed off the room's earliest frame.
        order: Math.min(...entries.map((entry) => Number(entry.photo.seq) || 0)),
        room: /** @type {SharedRoom} */ ({
          key: room.key,
          label: roomLabel(room.label, room.key),
          frames: entries.map(({ photo, render }) => /** @type {SharedFrame} */ ({
            renderId: render.id,
            photoId: showBefore && photo.storageKey ? photo.id : null,
            width: photo.width ?? null,
            height: photo.height ?? null,
            arLabel: photo.arLabel ?? null,
          })),
        }),
      };
    })
    .sort((a, b) => a.order - b.order)
    .map((entry) => entry.room);

  return {
    title: text(project.title, MAX_TITLE),
    address: text(project.address, MAX_ADDRESS),
    headline: text(settings.headline, MAX_HEADLINE),
    note: text(settings.note, MAX_NOTE),
    showBefore,
    agent: {
      name: text(settings.agentName, MAX_CONTACT),
      email: text(settings.agentEmail, MAX_CONTACT),
      phone: text(settings.agentPhone, MAX_CONTACT),
    },
    rooms,
    frameCount,
    // One definition, shared with the archive's DISCLOSURE.txt — see
    // lib/staging/staging-disclosure.js for why publishing without it is a real problem
    // for the licensed agent whose name is on the listing.
    disclosure: STAGING_DISCLOSURE,
  };
}

/**
 * @typedef {Object} SharePublicDeps
 * @property {ReturnType<typeof import('../lib/data/project-shares.js').createProjectShares>} shares Share-token store; `resolveShare` is the ONLY door in.
 * @property {ReturnType<typeof import('../lib/data/projects.js').createProjects>} projects Project/photo/render store.
 * @property {ReturnType<typeof import('../lib/data/project-storage.js').createProjectStorage>} storage Blob store for photo and render bytes.
 * @property {import('express').RequestHandler} shareLimiter Rate limiter applied to all four routes — this surface is unauthenticated and reads blobs off disk.
 * @property {string} __dirname Repo root, for locating `public/listing-share.html`.
 */

/**
 * Build the unauthenticated client-share router.
 * @param {SharePublicDeps} deps - Share store, project store, blob storage, rate limiter, repo root.
 * @returns {import('express').Router} The mounted router.
 */
export default function createSharePublicRouter(deps) {
  const { shares, projects, storage, shareLimiter, __dirname } = deps;
  const router = createAsyncRouter();
  const pagePath = path.join(__dirname, 'public', SHARE_PAGE_FILE);

  /**
   * THE refusal. Every rejection on this surface — unknown token, revoked token, expired
   * token, deleted listing, someone else's render id, a render that failed, a blob that is
   * not on disk — answers with exactly this: same status, same body, same headers.
   * @param {import('express').Response} res - Response.
   * @returns {import('express').Response} The uniform 404.
   */
  const notFound = (res) => sendError(res, 404, 'Not found', { code: 'NOT_FOUND' });

  /**
   * The headers every response from this router carries, set BEFORE any lookup so a 404
   * cannot be told apart from a 200 by its header set either.
   * @param {import('express').Response} res - Response.
   * @returns {void}
   */
  function publicHeaders(res) {
    // The token is in the path: without this, one outbound click or third-party image load
    // hands the live credential to a stranger in a Referer header.
    res.set('Referrer-Policy', 'no-referrer');
    // A seller's home must not land in a search index because the link got forwarded.
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Cache-Control', SHARE_NO_STORE);
  }

  /**
   * Wrap a handler so an unexpected throw becomes a 500 carrying only a log reference —
   * never `err.message`, which on this surface would be handing internals to an anonymous
   * caller (see lib/http/error-ref.js).
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

  /**
   * Resolve `:token` to a live share, discarding WHY it failed.
   * @param {import('express').Request} req - Request (reads `req.params.token`).
   * @param {number} now - Clock, for the expiry check.
   * @returns {ProjectShare|null} The share, or null for every rejection alike.
   */
  function liveShare(req, now) {
    const outcome = shares.resolveShare(String(req.params.token || ''), now);
    // `outcome.code` is deliberately dropped on the floor. NOT_FOUND / REVOKED / EXPIRED
    // must be indistinguishable to the caller — see the header.
    return outcome.ok ? outcome.share : null;
  }

  /**
   * The photo/render rows of the share's listing, or null when the listing is gone (a
   * share can outlive nothing — `deleteProject` cascades — but a race is a 404, not a 500).
   * @param {ProjectShare} share - The resolved share.
   * @returns {{ project: Project, photos: ProjectPhoto[], renders: Render[] }|null} The bundle.
   */
  function listingFor(share) {
    const project = projects.getProject(share.projectId);
    if (!project) return null;
    return {
      project,
      photos: projects.listPhotos(share.projectId),
      renders: projects.listRenders(share.projectId),
    };
  }

  /**
   * Serve one stored blob under the byte-route cache policy.
   * @param {import('express').Response} res - Response.
   * @param {string} storageKey - The blob's key.
   * @returns {Promise<unknown>} The sent response (or the uniform 404).
   */
  async function serveBlob(res, storageKey) {
    // storage.read REJECTS (ENOENT) rather than resolving null when the blob is gone; a row
    // that outlived its file is a 404 like everything else here, never a 500.
    const bytes = await storage.read(storageKey).catch(() => null);
    if (!bytes || !bytes.length) return notFound(res);
    res.set('Content-Type', serveContentType(storageKey));
    // nosniff + a type derived from the key's own extension: a mislabelled blob becomes a
    // download rather than something the browser is willing to interpret.
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', SHARE_BYTE_CACHE);
    return res.end(bytes);
  }

  // ── The page ───────────────────────────────────────────────────────────────
  //
  // NO LOOKUP HAPPENS HERE, on purpose. The shell is byte-identical for every token,
  // including junk, so this route cannot be used to sort real tokens from invented ones —
  // not because the comparison is careful, but because there is no comparison. The page
  // then fetches the manifest below and renders "this link is no longer available" for the
  // one 404 that route can answer.

  router.get('/s/:token', shareLimiter, guard('share.page', async (req, res) => {
    publicHeaders(res);
    await new Promise((resolve) => {
      res.sendFile(pagePath, (err) => {
        // A missing shell is a broken deploy, not a token problem — logged for the
        // operator, and still the uniform 404 so this route never grows a second shape.
        if (err && !res.headersSent) {
          reportError('share.page.sendfile', err);
          notFound(res);
        }
        resolve(undefined);
      });
    });
  }));

  // ── The manifest ───────────────────────────────────────────────────────────

  router.get('/api/share/:token', shareLimiter, guard('share.manifest', async (req, res) => {
    publicHeaders(res);
    const now = Date.now();
    const share = liveShare(req, now);
    if (!share) return notFound(res);
    const listing = listingFor(share);
    if (!listing) return notFound(res);

    // Counted HERE and nowhere else. The byte routes fire once per image, so counting
    // there would report a 40-photo gallery as 40 visits; the store debounces this call in
    // turn, so re-opening the tab all afternoon is still the one visit it is.
    shares.recordView(share.id, now, share.lastViewedAt);

    res.json({ listing: buildSharedListing({ ...listing, settings: share.settings }) });
  }));

  // ── Bytes ──────────────────────────────────────────────────────────────────

  router.get('/api/share/:token/render/:renderId', shareLimiter, guard('share.render', async (req, res) => {
    publicHeaders(res);
    const share = liveShare(req, Date.now());
    if (!share) return notFound(res);

    const render = projects.getRender(String(req.params.renderId));
    // THE tenancy boundary: the id in the path is never trusted on its own. The row has to
    // belong to the project this token resolved to, or one valid link would serve every
    // customer's pixels.
    if (!render || render.projectId !== share.projectId) return notFound(res);
    const photo = projects.getPhoto(render.photoId);
    // The same predicate the manifest used, so the servable set and the listed set are one
    // set — a failed, superseded or since-excluded frame 404s here too.
    if (!isPublishableFrame(render, photo)) return notFound(res);

    return serveBlob(res, String(render.storageKey));
  }));

  router.get('/api/share/:token/photo/:photoId', shareLimiter, guard('share.photo', async (req, res) => {
    publicHeaders(res);
    const share = liveShare(req, Date.now());
    if (!share) return notFound(res);
    // The ORIGINAL upload — someone's real, unstaged home. It leaves the building only
    // when the owner switched before/after ON.
    if (!share.settings.showBefore) return notFound(res);

    const photo = projects.getPhoto(String(req.params.photoId));
    if (!photo || photo.projectId !== share.projectId || !photo.storageKey) return notFound(res);
    // And only for a frame whose STAGED render is published: the before/after pair is the
    // point, so an original with no public "after" is just a room the broker chose not to
    // show — an excluded frame, an unstageable one, or one whose render failed.
    const staged = projects.listRenders(share.projectId)
      .some((render) => render.photoId === photo.id && isPublishableFrame(render, photo));
    if (!staged) return notFound(res);

    return serveBlob(res, photo.storageKey);
  }));

  return router;
}
