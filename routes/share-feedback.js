// Seller sign-off — the answer that comes BACK through a client share link.
//
// WHAT THIS CLOSES
// routes/share-public.js made the staging visible to the seller. It did not make the
// seller's answer visible to the broker, so the actual workflow still happened in a text
// message the listing knows nothing about ("bedroom's great, can the living room be
// warmer?"), which the broker then had to translate into which room, which frame, and
// re-run from memory. These three routes are that answer, attached to the room it is about.
//
// TWO HALVES, ONE FILE, AND THE ASYMMETRY IS THE POINT
//   * `POST|GET /api/share/:token/feedback` — PUBLIC. No account, no session, no cookie.
//     The 43-character token in the path is the entire credential.
//   * `GET /api/projects/:id/feedback` — the listing OWNER, behind `requireProAccount` +
//     `ownedProject`, exactly like every other route in the Listing Studio.
// They live together because they are two ends of one loop and reading them apart is how
// the loop drifts; they share NO handler and no helper that reaches a store, so "is this
// endpoint authenticated?" is still answerable by looking at the four lines of the route.
//
// THIS IS THE ONLY ANONYMOUS *WRITE* IN THE PRODUCT besides `referral_hits`, and it is a
// category harder than that one: it accepts FREE TEXT and it lands on the volume the SQLite
// database and every customer's photographs live on. Four things bound it, and only the
// first two are in this file:
//   1. `feedbackLimiter` — per-IP, per-window. The outer bound; a distributed flood walks
//      straight past it, which is why it is never the guarantee.
//   2. the token must RESOLVE LIVE before anything is read off the body at all;
//   3. `MAX_NOTE` / `MAX_VIEWER_LABEL` clamp the text — in the STORE, so a second route
//      cannot write an unbounded row;
//   4. `MAX_PER_SHARE` caps rows per link INSIDE the insert's transaction — the only one
//      of the four that actually bounds total growth.
// 3 and 4 are deliberately NOT re-implemented here. Re-clamping in the route would create a
// second set of numbers to drift, and a route-level ceiling can be raced by two concurrent
// requests in a way a transaction cannot.
//
// ONE 404, ALWAYS, FOR EVERY REJECTION — the same posture as routes/share-public.js, and
// for the same reason: `resolveShare` distinguishes NOT_FOUND / REVOKED / EXPIRED, and a
// caller who can tell those apart has learned that a token was once real. The revoked case
// matters most HERE and not there: a link the broker killed must not still be able to put
// rows in their database. `notFound()` is the only refusal on the public surface, body and
// headers alike.
//
// A RESPONSE MUST BE ABOUT A ROOM THE VIEWER COULD SEE. `roomKey` is caller-supplied and
// the store only clamps its length, so the route checks it against the rooms this share
// actually publishes — derived through `isPublishableFrame`, the same predicate the manifest
// and the byte route use, so a frame the gallery retracted cannot be commented on either.
// That is not a security boundary (the write is already confined to this share's listing);
// it is what keeps an anonymous caller from filling a paying customer's workspace with notes
// about rooms they cannot find.
//
// NOTHING ABOUT THE VIEWER IS RECORDED beyond an optional display name they typed. No IP,
// no user-agent, no cookie — these people never agreed to anything, they were sent a link.
//
// 5xx HYGIENE is the injected `guard`: an unexpected throw becomes a 500 carrying only a
// `reportError` reference (lib/http/error-ref.js). No `err.message` reaches a body on this
// surface — an anonymous caller learning that `better-sqlite3` names a table is strictly
// worse here than anywhere else in the app.
import { sendError } from '../lib/http/http-helpers.js';
import { feedbackLimiter as defaultFeedbackLimiter, feedbackReadLimiter as defaultFeedbackReadLimiter } from '../lib/http/rate-limiters.js';
import { SHARE_NO_STORE, isPublishableFrame } from './share-public.js';

/** @typedef {import('../lib/types/projects.js').Project} Project */
/** @typedef {import('../lib/types/projects.js').ProjectPhoto} ProjectPhoto */
/** @typedef {import('../lib/types/projects.js').ProjectShare} ProjectShare */
/** @typedef {import('../lib/types/projects.js').ShareFeedback} ShareFeedback */
/** @typedef {ReturnType<typeof import('../lib/data/project-shares.js').createProjectShares>} SharesStore */
/** @typedef {ReturnType<typeof import('../lib/data/projects.js').createProjects>} ProjectsStore */
/** @typedef {ReturnType<typeof import('../lib/data/share-feedback.js').createShareFeedback>} FeedbackStore */

/**
 * One response as an ANONYMOUS caller may see it.
 *
 * @typedef {Object} PublicFeedback
 * @property {'approved'|'changes'} verdict What the viewer answered.
 * @property {string|null} roomKey The room it is about; null for the whole listing.
 * @property {string} note Their free text, already clamped by the store.
 * @property {string} viewerLabel The display name they typed, or ''.
 * @property {number} createdAt Epoch ms, so the client can say "you answered this earlier".
 */

/**
 * Rows the owner's panel gets in one call. The store clamps its own limit to MAX_PER_SHARE,
 * so this is the ceiling the API states rather than a second, looser one.
 */
export const OWNER_FEEDBACK_LIMIT = 200;

/**
 * Row → the public projection, built FIELD BY FIELD and never by spreading a `ShareFeedback`.
 *
 * WHAT IS DELIBERATELY ABSENT: `id`, `shareId`, `projectId` and `userId`. The first three
 * are internal ids an anonymous stranger has no use for; the fourth is the LISTING OWNER —
 * publishing it would hand whoever holds a forwarded link the broker's account id. A
 * `...row` here would leak all four the day somebody adds a column, so adding a field to
 * this surface has to be a deliberate line of code.
 *
 * No client-side id is emitted at all. The client keys on `roomKey`, which is the only
 * identifier it needs and the only one it already knows from the manifest.
 * @param {ShareFeedback} row - A stored response.
 * @returns {PublicFeedback} The projection.
 */
export function publicFeedback(row) {
  return {
    verdict: row.verdict,
    roomKey: row.roomKey ?? null,
    note: row.note || '',
    viewerLabel: row.viewerLabel || '',
    createdAt: row.createdAt,
  };
}

/**
 * Read one caller-supplied string off a request body without coercing it.
 *
 * `String(value)` would turn `{}` into `'[object Object]'` and `null` into `'null'`, both of
 * which would then be stored as somebody's answer. A non-string field is simply absent.
 * @param {unknown} value - Raw body field.
 * @returns {string} The string, or '' when the field was not one.
 */
function asText(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Stable order for the public GET: oldest first, then by room, so a client that renders the
 * list twice renders it the same way. `latestByRoom` returns a Map in first-seen order,
 * which is *usually* this order but is not guaranteed to stay so.
 * @param {PublicFeedback} a - Left.
 * @param {PublicFeedback} b - Right.
 * @returns {number} Comparator result.
 */
function byTimeThenRoom(a, b) {
  return a.createdAt - b.createdAt || String(a.roomKey ?? '').localeCompare(String(b.roomKey ?? ''));
}

/**
 * @typedef {Object} FeedbackRouteContext
 * @property {import('express').Router} router The router these three routes are registered on.
 * @property {SharesStore} shares Share-token store; `resolveShare` is the ONLY door into the public half.
 * @property {FeedbackStore} feedback Seller sign-off store (lib/data/share-feedback.js).
 * @property {ProjectsStore} projects Project/photo/render store — read ONLY to work out which rooms the share actually publishes.
 * @property {(req: import('express').Request, res: import('express').Response) => any} requireProAccount Responds 401/403 and returns null when the caller is not Stagify+. Owner route only.
 * @property {(context: string, fn: (req: import('express').Request, res: import('express').Response) => Promise<unknown>) => import('express').RequestHandler} guard Wraps a handler so an unexpected throw becomes a 500 carrying only a log reference.
 * @property {(res: import('express').Response) => import('express').Response} notFound The uniform 404 — the ONLY refusal on the public half, and the same answer for "absent" and "not yours" on the owner half.
 * @property {(req: import('express').Request, user: { id: string }) => Project|null} ownedProject Loads `:id` only when this session owns it.
 * @property {(res: import('express').Response) => void} setSensitiveHeaders Marks the OWNER response no-store / no-referrer.
 * @property {import('express').RequestHandler} [feedbackLimiter] Rate limiter for the PUBLIC write. Defaults to the real one, so an omitted dep cannot leave an anonymous write unlimited; tests override it.
 * @property {import('express').RequestHandler} [feedbackReadLimiter] Rate limiter for the PUBLIC read, on its own
 *   budget so a write flood cannot 429 the read and make the whole reply UI disappear.
 */

/**
 * Register the seller sign-off routes.
 *
 * `POST|GET /api/share/:token/feedback` (public) and `GET /api/projects/:id/feedback` (owner).
 * @param {FeedbackRouteContext} ctx - Router, both stores, the auth gate, the 404/guard helpers and the limiter.
 * @returns {void}
 */
export function registerFeedbackRoutes(ctx) {
  const {
    router, shares, feedback, projects, requireProAccount, guard, notFound, ownedProject, setSensitiveHeaders,
  } = ctx;
  // Imported directly and only OVERRIDDEN by the bag (rather than read from it), so
  // forgetting the dep at the wiring site cannot silently leave an anonymous write
  // unlimited — the same posture as the enterprise checkout limiter.
  const limiter = ctx.feedbackLimiter || defaultFeedbackLimiter;
  // Same posture, separate budget: spending the WRITE allowance must not be able to take
  // the reply UI away on the next read. See lib/http/rate-limiters.js for why.
  const readLimiter = ctx.feedbackReadLimiter || defaultFeedbackReadLimiter;

  /**
   * The headers every PUBLIC response carries, set BEFORE any lookup so a 404 cannot be
   * told apart from a 200 by its header set either.
   * @param {import('express').Response} res - Response.
   * @returns {void}
   */
  function publicHeaders(res) {
    // The token sits in the PATH: without this, one outbound click or third-party image
    // load hands the live credential to a stranger in a Referer header.
    res.set('Referrer-Policy', 'no-referrer');
    // A seller's home — and now their opinion of it — must not land in a search index
    // because the link got forwarded.
    res.set('X-Robots-Tag', 'noindex, nofollow');
    // One definition, shared with routes/share-public.js. Never `public`: no shared proxy
    // may retain a copy of a private listing's sign-off.
    res.set('Cache-Control', SHARE_NO_STORE);
  }

  /**
   * Resolve `:token` to a LIVE share, discarding WHY it failed.
   *
   * Called FIRST in both public handlers, before a single field is read off the body. A
   * revoked or expired link must not be able to write — and the caller must not be able to
   * tell which of the three rejections it hit.
   * @param {import('express').Request} req - Request (reads `req.params.token`).
   * @param {number} now - Clock, for the expiry check.
   * @returns {ProjectShare|null} The share, or null for every rejection alike.
   */
  function liveShare(req, now) {
    const outcome = shares.resolveShare(String(req.params.token || ''), now);
    // `outcome.code` is dropped on the floor on purpose. NOT_FOUND / REVOKED / EXPIRED must
    // be indistinguishable to the caller — see the header.
    return outcome.ok ? outcome.share : null;
  }

  /**
   * The room keys this listing actually PUBLISHES — i.e. exactly the rooms the gallery at
   * `/s/:token` shows.
   *
   * WHY THE SET IS DERIVED AND NOT LISTED. The obvious version of this check is "does any
   * photo of this project carry that room key", and it is wrong in the direction that
   * matters: a room whose frames the broker excluded, or whose renders failed, is IN the
   * photo table and NOT on the page. A viewer cannot see it, so a response about it is by
   * definition not something they typed — and it would land in the broker's inbox looking
   * like a room they cannot find.
   *
   * So the set is built with `isPublishableFrame`, the SAME predicate the manifest and the
   * render byte route use (routes/share-public.js), by the same grouping loop as
   * `buildSharedListing`. Three copies of that rule would drift, and the drifted copy would
   * be this one — silently letting comments in on frames the gallery retracted.
   * @param {string} projectId - The share's listing (from the share, never the body).
   * @returns {Set<string>} Room keys a viewer can actually see.
   */
  function publishableRoomKeys(projectId) {
    /** @type {Map<string, ProjectPhoto>} */
    const photoById = new Map(projects.listPhotos(projectId).map((photo) => [photo.id, photo]));
    /** @type {Set<string>} */
    const keys = new Set();
    for (const render of projects.listRenders(projectId)) {
      const photo = photoById.get(render.photoId) ?? null;
      if (!isPublishableFrame(render, photo)) continue;
      keys.add(String(/** @type {ProjectPhoto} */ (photo).roomKey));
    }
    return keys;
  }

  // ── The write: an anonymous seller answering ────────────────────────────────

  router.post('/api/share/:token/feedback', limiter, guard('share.feedback.create', async (req, res) => {
    publicHeaders(res);
    const now = Date.now();
    const share = liveShare(req, now);
    if (!share) return notFound(res);

    const body = req.body && typeof req.body === 'object' ? /** @type {Record<string, unknown>} */ (req.body) : {};

    // An EMPTY room key means "the whole listing" and is always valid — that is the
    // response a seller gives from the bottom of the page. A NON-empty one has to name a
    // room the gallery actually shows, or the broker's workspace fills with notes about
    // rooms that do not exist, written by somebody who could not have been looking at them.
    //
    // This 400 is not an oracle: it is only reachable with a LIVE token, and the manifest
    // that token already fetches lists these exact keys. Every refusal that happens BEFORE
    // the token resolves is still the one uniform 404.
    const roomKey = asText(body.roomKey);
    if (roomKey && !publishableRoomKeys(share.projectId).has(roomKey)) {
      return sendError(res, 400, 'That room is not part of this listing', { code: 'UNKNOWN_ROOM' });
    }

    const outcome = feedback.addFeedback({
      // ── THE TENANCY BOUNDARY ─────────────────────────────────────────────────
      // These three ids come from the RESOLVED SHARE and are NEVER read off the body. A
      // body-supplied `projectId` would let anybody holding ANY live link write rows onto
      // somebody else's listing, and a body-supplied `userId` would file them under a
      // stranger's account — one missing line here is the whole multi-tenancy of this
      // surface. Note that the caller's fields below are read INDIVIDUALLY rather than
      // spread: an extra key on the body is inert, and must stay inert.
      shareId: share.id,
      projectId: share.projectId,
      userId: share.userId,
      // Already validated against the rooms this share publishes, just above.
      roomKey,
      verdict: asText(body.verdict),
      note: body.note,
      viewerLabel: body.viewerLabel,
      now,
    });

    if (!outcome.ok) {
      // An unknown verdict is REFUSED, never coerced to a default. Silently recording
      // "approved" because the client sent `verdict: "aproved"` would put a sign-off the
      // seller never gave in front of the broker.
      if (outcome.code === 'BAD_VERDICT') {
        return sendError(res, 400, 'Choose whether this is approved or needs changes', { code: 'BAD_VERDICT' });
      }
      // 409, not a 500 and not a bare 200. The cap is a state of the resource ("this link
      // has collected all it will"), and it is PERMANENT for this link — so 429, whose
      // whole meaning is "retry after a while", would be a lie the client would act on. A
      // 200 would be worse still: the UI would say "thanks, we have your notes" about a row
      // that does not exist.
      //
      // THE STATUS IS THE ONLY SIGNAL, and deliberately so. `sendError` emits a fixed
      // `{ error, code, details, ref }` shape — the single funnel every error body in this
      // app goes through — so there is nowhere for an `allowance` object to ride along, and
      // widening that helper for one caller would be the wrong trade. A client must
      // therefore treat 409 itself as "full" rather than reading a field: parsing an absent
      // allowance into `full: false` is how a page ends up re-offering a form that is
      // guaranteed to 409 again.
      if (outcome.code === 'FULL') {
        return sendError(res, 409, 'This link has collected all the responses it can hold', { code: 'FEEDBACK_FULL' });
      }
      // MISSING_SHARE is unreachable: `share` resolved a line ago, so it has both ids. If
      // it ever happens the share vanished mid-request, which is the uniform 404 like every
      // other absence on this surface — never a 500.
      return notFound(res);
    }

    res.json({
      ok: true,
      feedback: publicFeedback(outcome.feedback),
      // The viewer's own link's allowance, so the form can stop offering itself BEFORE the
      // refusal rather than after it. It says nothing about any other link or listing.
      allowance: feedback.allowanceFor(share.id),
    });
  }));

  // ── The read-back: what THIS link has already said ──────────────────────────

  router.get('/api/share/:token/feedback', readLimiter, guard('share.feedback.list', async (req, res) => {
    publicHeaders(res);
    const share = liveShare(req, Date.now());
    if (!share) return notFound(res);

    // KEYED ON THE SHARE, NEVER ON THE PROJECT. `listForProject` would return every
    // response the LISTING has ever collected, so the moment a broker rotates the link (one
    // POST — see routes/projects-share.js) the next viewer would open the page and read the
    // previous viewer's notes about somebody's house. `latestByRoom` reduces one link's own
    // append-only history to the current answer per room, which is exactly what the form
    // needs to pre-fill itself.
    const responses = [...feedback.latestByRoom(share.id).values()].map(publicFeedback).sort(byTimeThenRoom);
    res.json({ responses, allowance: feedback.allowanceFor(share.id) });
  }));

  // ── The owner's side ───────────────────────────────────────────────────────

  router.get('/api/projects/:id/feedback', guard('projects.feedback.list', async (req, res) => {
    // Gate INSIDE the handler and ownership re-keyed on the VALIDATED session user's id,
    // exactly as in routes/projects.js. A foreign or unknown listing answers the SAME 404,
    // never a 403: a 403 would confirm which listing ids exist, and every listing id is one
    // POST away from a public URL.
    const user = requireProAccount(req, res);
    if (!user) return;
    const project = ownedProject(req, user);
    if (!project) return notFound(res);

    setSensitiveHeaders(res);
    // The FULL rows here, not the public projection: this is the owner of the listing the
    // rows are about, reading their own workspace. They get the append-only history (not
    // just the latest per room) because the note that said "make it warmer" is the answer
    // to "why did I re-render this room".
    res.json({ feedback: feedback.listForProject(project.id, OWNER_FEEDBACK_LIMIT) });
  }));
}
