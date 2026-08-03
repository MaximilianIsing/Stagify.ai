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
// THE `before` PHOTO IS OWNER-ONLY. It is included here and deliberately absent from the
// public manifest — the agent gets the before/after comparison in their private gallery,
// the buyer sees the staged result. That asymmetry is the reason the two manifests are
// built by two functions rather than one with a flag.
import { createAsyncRouter } from '../lib/http/async-router.js';
import { sendError, resolveAppOrigin } from '../lib/http/http-helpers.js';
import { galleryLimiter as defaultGalleryLimiter } from '../lib/http/rate-limiters.js';

/** How long a presigned URL in the owner's manifest stays valid. */
export const GALLERY_URL_TTL_MS = 15 * 60 * 1000;

/** Entries per page. The grid is thumbnails, so this is a screenful or three. */
export const PAGE_SIZE = 60;

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

    const offset = Math.max(0, Number(req.query.offset) || 0);
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
    const entries = rows.map((render) => shapeEntry({
      render,
      blobs: stagedRenders.blobsFor(render.id),
      refs: renderRefs.forRender(render.id),
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
