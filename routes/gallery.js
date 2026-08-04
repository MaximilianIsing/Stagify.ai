// The owner's own gallery: their staged history, and the link that comes with every
// entry in it.
//
// THERE IS NO CREATE STEP AND NO OFF SWITCH. A link is not a thing the owner makes for a
// chosen render; every finished render has one, minted by the LISTING below and carried on
// the entry, so opening a card and pressing copy is the whole interaction. That is why a
// GET here writes: the alternative is a panel that has to round-trip before it can show
// the one thing it exists to show. Deleting the render is the takedown, and it is a better
// one than revoking was — it tombstones the bytes too.
//
// Everything here is authenticated. The public half is routes/share-public.js, and the
// two files deliberately share no handler — one is read by an anonymous stranger holding
// a token, the other by a signed-in account, and collapsing them would mean one guard
// protecting two very different threat models.
//
// OWNERSHIP IS KEYED ON THE VALIDATED SESSION, NEVER ON A BODY
// Every mutating route resolves the user with `getAuthUserFromRequest` and passes THAT id
// into the store, where it is part of the WHERE clause. A render id in the path is
// untrusted input: `remove` and the share route answer the same 404 for "does not exist"
// and "is not yours", so this surface cannot be used to probe which ids are real. The
// listing does not take an id at all — it mints for the rows the store handed back for
// THIS session, so no caller can steer it at a render they do not own.
//
// THE MANIFEST MINTS PRESIGNED URLS
// Bytes never pass through this process — the browser fetches R2 directly. That is the
// whole reason the bytes are in a bucket, and it is why the limiter here can be sized for
// page loads rather than for image requests. URLs are minted AFTER the ownership check,
// never before.
//
// A full page mints 180 of them (60 entries x after/before/thumb) and that is FINE — 1.46 ms
// and ~65 KB of body, measured 2026-08-04; see the note in lib/data/s3-presign.js. The
// obvious trim is to leave `before` out of the listing and fetch it when a card opens, since
// the grid only ever paints `thumb`. Deliberately not done: it saves 0.5 ms and 22 KB and
// costs a network round-trip every time a card opens, where the detail panel currently
// paints instantly from data the page already holds. That is a worse product for a saving
// nothing is asking for. Caching the URLs instead is not on the table at all — s3-presign.js
// explains why a cached presigned URL is a revocation bug.
//
// THE `before` PHOTO IS OWNER-ONLY. It is included here and deliberately absent from the
// public manifest — the agent gets the before/after comparison in their private gallery,
// the buyer sees the staged result. That asymmetry is the reason the two manifests are
// built by two functions rather than one with a flag.
import { createAsyncRouter } from '../lib/http/async-router.js';
import { sendError, resolveAppOrigin, setSensitiveHeaders } from '../lib/http/http-helpers.js';
import { galleryLimiter as defaultGalleryLimiter } from '../lib/http/rate-limiters.js';
import { readRenderExtra } from '../lib/data/render-extra.js';
import { logger } from '../lib/logger.js';

/** How long a presigned URL in the owner's manifest stays valid. */
export const GALLERY_URL_TTL_MS = 15 * 60 * 1000;

/** Entries per page. The grid is thumbnails, so this is a screenful or three. */
export const PAGE_SIZE = 60;

/**
 * The deepest page this endpoint will look at.
 *
 * A larger number is overwhelmingly a typo or a probe rather than a deeper page, and
 * clamping rather than refusing keeps the shape of the answer the same for every input: a
 * page, possibly empty.
 *
 * This USED to be justified by "no account can have a row out here" — PRO_GALLERY_LIMIT
 * was 200. It now defaults to Infinity, so that is no longer a guarantee: an account past
 * 100,000 renders would have its oldest entries unreachable through this endpoint. That is
 * an acceptable trade at a hundred thousand photos (deep OFFSET paging is the wrong tool
 * long before then, and search reaches them), but it is a real edge now rather than an
 * impossible one, so it is written down rather than assumed away.
 */
export const MAX_OFFSET = 100_000;

/**
 * The page offset, in a form SQLite will actually bind.
 *
 * `Math.max(0, Number(raw) || 0)` was not enough. better-sqlite3 binds `LIMIT ? OFFSET ?`
 * straight through and REFUSES a non-integer or out-of-range number from inside the
 * statement ("datatype mismatch"), so `?offset=1.5` and `?offset=1e21` were a 500 on an
 * authenticated endpoint rather than a bad page. Floor, finite-check and clamp.
 *
 * Forgiving rather than a 400, matching how the rest of this route treats its query
 * string: junk means the first page. Note `?offset=1&offset=2` reaches Express as an
 * array, and `Number([...])` is NaN, which lands on the same first page.
 *
 * @param {unknown} raw - Whatever arrived in the query string.
 * @returns {number} A non-negative safe integer at or below MAX_OFFSET.
 */
export function parseOffset(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_OFFSET, Math.floor(n));
}

/**
 * Shape one gallery row for the owner.
 *
 * Field by field, never a spread: the row carries `user_id`, storage keys and internal
 * timestamps, and a `...row` would publish whatever column somebody adds next.
 *
 * @param {{ render: any, blobs: { role: string, storage_key: string }[], refs: any[],
 *   share: any, presign: (key: string) => string, shareOrigin?: string }} arg
 * @returns {any}
 */
export function shapeEntry({ render, blobs, refs, share, presign, shareOrigin = '' }) {
  const byRole = Object.fromEntries(blobs.map((b) => [b.role, b.storage_key]));
  const extra = readRenderExtra(render);
  return {
    id: render.id,
    createdAt: render.created_at,
    width: render.width ?? null,
    height: render.height ?? null,
    roomType: render.room_type ?? '',
    furnitureStyle: render.furniture_style ?? '',
    // The owner's own label, or '' when they have not given one. Deliberately NOT
    // defaulted here: the page derives `<Style> <Room type>` from the two fields above,
    // so an unnamed render picks up the reader's own copy of that wording rather than a
    // string frozen into the row on the day it was staged.
    //
    // It is also owner-only. The public share page has its own `settings.headline`, and
    // collapsing the two would publish whatever private note an agent filed a render
    // under ("Wilson viewing, redo the lighting") to whoever holds the link.
    name: render.custom_name ?? '',
    // Which studio made this, the one setting worth naming it by, and the stem of the photo
    // it came from — lib/data/render-extra.js. Unpacked here rather than published as a raw
    // `extraJson` blob so this function keeps its promise: every field the owner receives is
    // one somebody chose to send. A row written before this shipped, or one whose JSON is
    // damaged, yields three empty strings and the name falls back to `<Style> <Room type>`.
    source: extra.source,
    qualifier: extra.qualifier,
    sourceName: extra.sourceName,
    // The prompt is what makes the gallery useful rather than decorative: it is the
    // answer to "what did I actually ask for", and the seed for running it again.
    additionalPrompt: render.additional_prompt ?? '',
    removeFurniture: !!render.remove_furniture,
    variation: render.variation ?? 0,
    urls: {
      after: byRole.after ? presign(byRole.after) : '',
      before: byRole.before ? presign(byRole.before) : '',
      thumb: byRole.thumb ? presign(byRole.thumb) : '',
    },
    references: (refs ?? []).map((r) => ({ url: presign(r.storage_key) })),
    // The URL itself, not a flag saying one exists: the panel's job is to hand it over,
    // and it has nowhere else to get it from. There is no `active` — every entry has a
    // link, so a boolean would be true on every row ever serialized here. `url` is empty
    // only for a share minted before the token was retrievable, which the mint on the
    // listing replaces the moment it sees one.
    share: share
      ? {
        url: share.token ? `${shareOrigin}/s/${share.token}` : '',
        createdAt: share.createdAt,
        viewCount: share.viewCount,
        lastViewedAt: share.lastViewedAt,
        settings: share.settings,
      }
      : null,
  };
}

/**
 * Build the owner gallery router.
 *
 * @param {{ stagedRenders: any, renderRefs: any, shares: any,
 *   objectStore: import('../lib/data/object-store.js').ObjectStore,
 *   getAuthUserFromRequest: (req: any) => any,
 *   galleryLimiter?: import('express').RequestHandler,
 *   appOrigin?: string }} deps
 * @returns {import('express').Router}
 */
export default function createGalleryRouter(deps) {
  const { stagedRenders, renderRefs, shares, objectStore, getAuthUserFromRequest, appOrigin } = deps;
  const limiter = deps.galleryLimiter ?? defaultGalleryLimiter;
  const router = createAsyncRouter();

  // Every response from this router carries either a presigned R2 URL or a live
  // /s/<token>, and both are bearer credentials that happen to live in a URL. `no-store`
  // keeps them out of intermediaries and out of the browser's back/forward cache, where a
  // replayed 15-minute-old page would be a screenful of 404s; `no-referrer` stops the
  // gallery URL travelling onward. The share routes have said this since they shipped —
  // this was the one surface handling the same class of data that said nothing at all.
  //
  // Mounted ON THE PATH, deliberately not bare: server.js mounts this router with
  // `app.use(createGalleryRouter(...))` and no prefix, so an unpathed use() here would
  // decorate every response the app sends. The prefix still covers /api/gallery/:id and
  // /api/gallery/:id/share, and it runs before the handlers, so the 401 and the 404 carry
  // the headers too — they must not depend on reaching a handler body.
  router.use('/api/gallery', (req, res, next) => {
    setSensitiveHeaders(res);
    next();
  });

  const presign = (key) => objectStore.presignGet(key, { ttlMs: GALLERY_URL_TTL_MS });

  /**
   * The origin every share URL this router emits is built on. An injected appOrigin wins;
   * otherwise it resolves from config or the request — which is the fix for links that
   * used to come back as a bare `/s/<token>` path.
   * @param {any} req
   */
  const originFor = (req) => (appOrigin ? String(appOrigin).trim().replace(/\/+$/, '') : '') || resolveAppOrigin(req);

  /**
   * The signed-in account, or null.
   *
   * The auth gate lives INSIDE each handler rather than as middleware — the house pattern
   * (see routes/staging.js), and the reason a route's middleware chain here does not tell
   * you whether it is authenticated.
   * @param {any} req @returns {any}
   */
  const userFor = (req) => getAuthUserFromRequest(req);

  /** @param {any} res @returns {any} The uniform refusal for "not yours" and "not there". */
  const notFound = (res) => sendError(res, 404, 'Not found', { code: 'NOT_FOUND' });

  /** @param {any} res @returns {any} */
  const unauthorized = (res) => sendError(res, 401, 'Please sign in', { code: 'AUTH_REQUIRED' });

  /**
   * Resolve a render id from the path to a row the caller actually owns.
   * @param {any} req @param {{ id: string }} user @returns {any} The row, or null.
   */
  function ownedRender(req, user) {
    const render = stagedRenders.get(String(req.params.id || ''));
    // "Not yours" and "does not exist" are the same answer, so this cannot be used to
    // learn which render ids are real.
    if (!render || render.user_id !== user.id || render.evicted_at) return null;
    return render;
  }

  // ── The owner's history ────────────────────────────────────────────────────
  router.get('/api/gallery', limiter, async (req, res) => {
    const user = userFor(req);
    if (!user) return unauthorized(res);
    if (!objectStore.configured) {
      // The gallery is off (no R2 on Render). An empty list with a flag beats a 500: the
      // page renders its empty state and says why.
      return res.json({ entries: [], total: 0, enabled: false });
    }

    const offset = parseOffset(req.query.offset);
    // Searching is a Stagify+ feature, so the SERVER decides whether the query counts —
    // and says so in the response rather than trusting the page to have hidden the box.
    // A free account's `q` is dropped, not refused: the listing itself is theirs, and a
    // 403 for a parameter they cannot even see on screen would be a worse answer than
    // their own gallery.
    const isPro = user.plan === 'pro';
    const q = isPro ? String(req.query.q ?? '') : '';
    const rows = stagedRenders.listForUser({ userId: user.id, limit: PAGE_SIZE, offset, q });
    const listOrigin = originFor(req);
    // The mint. `listForUser` returns finished renders only, which is the same bar the
    // old create button enforced — a link to bytes that never landed would 404 for
    // whoever received it. One transaction for the page, and a no-op for every render
    // that already has a link, so this is a read in the steady state.
    const links = shares.ensureForRenders({ renders: rows });
    // ONE STATEMENT PER TABLE FOR THE PAGE, NOT ONE PER ROW. These two used to be
    // `blobsFor(render.id)` and `forRender(render.id)` inside the map below, which made a
    // listing cost three statements per tile — around 180 synchronous better-sqlite3 calls
    // for a full page, every one of them blocking the event loop against every other
    // request. The shape was the problem rather than the number: it grew with the page,
    // and it has no ceiling now that PRO_GALLERY_LIMIT defaults to Infinity.
    //
    // Hoisted here rather than pushed into the store's listForUser because the mint above
    // needs the rows first, and because a listing that joined everything in SQL would go
    // back to being one query nobody can read.
    const ids = rows.map((r) => r.id);
    const blobsByRender = stagedRenders.blobsForRenders(ids);
    const refsByRender = renderRefs.forRenders(ids);
    const entries = rows.map((render) => shapeEntry({
      render,
      // The `?? []` is load-bearing on BOTH, for different reasons. Most renders have no
      // reference photos, so they are legitimately absent from that map. A render absent
      // from the BLOB map is the rarer case — its objects were tombstoned out from under a
      // row still marked `ok` — and defaulting it means that entry paints with empty URLs
      // instead of throwing inside shapeEntry and 500ing the whole page for it.
      blobs: blobsByRender.get(render.id) ?? [],
      refs: refsByRender.get(render.id) ?? [],
      share: links.get(render.id) ?? null,
      presign,
      shareOrigin: listOrigin,
    }));
    return res.json({
      entries,
      // The MATCHING total while a search is on, never the account's whole count: the
      // page prints this above the grid, and "3 of 47" over three tiles is the listing
      // contradicting itself.
      total: stagedRenders.countForUser(user.id, { q }),
      offset,
      pageSize: PAGE_SIZE,
      enabled: true,
      urlTtlMs: GALLERY_URL_TTL_MS,
      // `enabled` is what reveals the box — one source of truth for a paid feature, so
      // the page cannot offer a search the server would then ignore. `q` echoes what was
      // actually applied, which is '' for a free caller who sent one anyway.
      search: { enabled: isPro, q },
    });
  });

  // ── One entry's pixels, served by US ───────────────────────────────────────
  //
  // Exists for exactly one caller: "Refine in Masking Studio". That studio draws the photo
  // onto a canvas and then calls `toDataURL` on it, and
  //
  //     DRAWING A CROSS-ORIGIN IMAGE TAINTS A CANVAS, AND toDataURL ON A TAINTED CANVAS
  //     THROWS SecurityError.
  //
  // A presigned R2 URL is cross-origin, so handing one to the studio would break every
  // generate and every export it does. Worse, it would pass every test and every local
  // check: dev and CI serve blobs from routes/object-local.js, same-origin. This is a
  // production-only failure, which is why the bytes come back through here instead — a
  // same-origin fetch, whose blob URL does not taint anything.
  //
  // It also carries a bearer token, which an <img src> cannot, so the client fetches and
  // makes an object URL rather than pointing an element at this path.
  //
  // This DOES put render bytes through the process, which this file's header otherwise
  // avoids. The cost that header is about is a buyer's browser pulling share images over
  // and over; this is one ~110KB WebP, once, for the authenticated owner, on a click. The
  // exception is deliberate — do not widen it into a general "serve my render" route.
  router.get('/api/gallery/:id/source', limiter, async (req, res) => {
    const user = userFor(req);
    if (!user) return unauthorized(res);
    if (!objectStore.configured) return notFound(res);
    const render = ownedRender(req, user);
    // Ownership is checked before a single byte is read, and "not yours" is the same 404 as
    // "does not exist", so this cannot be used to enumerate render ids.
    if (!render) return notFound(res);
    // The finished render, not the source photo: the studio refines what is already staged.
    const blob = stagedRenders.blobsFor(render.id).find((b) => b.role === 'after');
    if (!blob) return notFound(res);
    try {
      // Both adapters REJECT on a missing object rather than resolving null, so the catch
      // below is the real "gone" path; the falsy check is belt and braces.
      const bytes = await objectStore.get(blob.storage_key);
      if (!bytes) return notFound(res);
      res.setHeader('Content-Type', 'image/webp');
      return res.end(bytes);
    } catch (error) {
      logger.error(`[gallery] could not read render ${render.id} for handoff:`, error);
      return notFound(res);
    }
  });

  // ── Name one entry ─────────────────────────────────────────────────────────
  //
  // The only field of a render the owner can edit. `name: ''` is a RESET, not a rejection:
  // it stores NULL and the page goes back to deriving `<Style> <Room type>`, so there is
  // one control rather than a rename box plus a "use the default" button.
  //
  // The trimming and the 80-character ceiling are in the store, not here — every writer
  // goes through `rename`, so a second caller cannot skip them. This handler's own job is
  // to refuse a body that is not a string at all, which is the difference between "clear
  // it" and a client sending an object by mistake.
  router.patch('/api/gallery/:id', limiter, async (req, res) => {
    const user = userFor(req);
    if (!user) return unauthorized(res);
    if (typeof req.body?.name !== 'string') {
      return sendError(res, 400, 'A name is required', { code: 'INVALID_NAME' });
    }
    // No ownedRender() call first: the id and the user id go into the UPDATE's WHERE
    // together, so a check-then-write cannot disagree with the write, and "not yours"
    // answers the same 404 as "does not exist".
    const { ok, name } = stagedRenders.rename({ id: String(req.params.id || ''), userId: user.id, name: req.body.name });
    if (!ok) return notFound(res);
    // The stored value, not the submitted one — it may have been trimmed or truncated,
    // and the page paints what it gets back so the two cannot drift apart on screen.
    return res.json({ success: true, name });
  });

  // ── Delete one entry ───────────────────────────────────────────────────────
  //
  // This is the HARD revoke: it tombstones the bytes, so an outstanding presigned URL
  // starts 404ing as soon as the reaper runs. Revoking a share (below) only stops NEW
  // URLs being minted.
  router.delete('/api/gallery/:id', limiter, async (req, res) => {
    const user = userFor(req);
    if (!user) return unauthorized(res);
    if (!stagedRenders.remove({ id: String(req.params.id || ''), userId: user.id })) return notFound(res);
    return res.json({ success: true });
  });

  // ── Edit a live link's presentation, without rotating it ───────────────────
  //
  // The only write left on a share. There is no POST minting one — the listing does that
  // for every render — and no DELETE turning one off; both were removed with the buttons
  // that called them, rather than left mounted for nothing.
  router.patch('/api/gallery/:id/share', limiter, async (req, res) => {
    const user = userFor(req);
    if (!user) return unauthorized(res);
    const render = ownedRender(req, user);
    if (!render) return notFound(res);
    // An agent fixing a typo in their own phone number must not invalidate the link they
    // already sent, so this deliberately does not mint a new token.
    const share = shares.updateSettings({ renderId: render.id, settings: req.body?.settings });
    if (!share) return notFound(res);
    return res.json({ success: true, share: { createdAt: share.createdAt, viewCount: share.viewCount, settings: share.settings } });
  });

  return router;
}
