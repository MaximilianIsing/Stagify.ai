// The owner's own gallery: their staged history, and the links they mint from it.
//
// Everything here is authenticated. The public half is routes/share-public.js, and the
// two files deliberately share no handler — one is read by an anonymous stranger holding
// a token, the other by a signed-in account, and collapsing them would mean one guard
// protecting two very different threat models.
//
// OWNERSHIP IS KEYED ON THE VALIDATED SESSION, NEVER ON A BODY
// Every mutating route resolves the user with `getAuthUserFromRequest` and passes THAT id
// into the store, where it is part of the WHERE clause. A render id in the path is
// untrusted input: `remove` and the share routes all answer the same 404 for "does not
// exist" and "is not yours", so this surface cannot be used to probe which ids are real.
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
    // The URL rides along now, so reopening the gallery next week shows the link the
    // owner already sent instead of only the fact that one exists. `url` is empty for a
    // share minted before the token was retrievable — those cannot be read back at all.
    share: share
      ? {
        active: true,
        url: share.token ? `${shareOrigin}/s/${share.token}` : '',
        createdAt: share.createdAt,
        viewCount: share.viewCount,
        lastViewedAt: share.lastViewedAt,
        settings: share.settings,
      }
      : { active: false },
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
    const rows = stagedRenders.listForUser({ userId: user.id, limit: PAGE_SIZE, offset });
    const listOrigin = originFor(req);
    const entries = rows.map((render) => shapeEntry({
      render,
      blobs: stagedRenders.blobsFor(render.id),
      refs: renderRefs.forRender(render.id),
      share: shares.activeForRender(render.id),
      presign,
      shareOrigin: listOrigin,
    }));
    return res.json({
      entries,
      total: stagedRenders.countForUser(user.id),
      offset,
      pageSize: PAGE_SIZE,
      enabled: true,
      urlTtlMs: GALLERY_URL_TTL_MS,
    });
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

  // ── Mint or rotate a share link ────────────────────────────────────────────
  //
  // The plaintext token comes back EXACTLY ONCE, here. There is no read-back route: an
  // owner who loses the link calls this again, which rotates it — which is also the
  // behaviour you want from a "the seller forwarded it to the whole street" button.
  router.post('/api/gallery/:id/share', limiter, async (req, res) => {
    const user = userFor(req);
    if (!user) return unauthorized(res);
    const render = ownedRender(req, user);
    if (!render) return notFound(res);
    // A render whose bytes never landed has nothing to show; minting a link for it would
    // hand somebody a URL that 404s.
    if (render.status !== 'ok') return notFound(res);

    // ensureShare, not create: a render has ONE link for its lifetime, so pressing this
    // twice returns the same URL instead of invalidating one the owner already sent.
    const { token, share } = shares.ensureShare({
      renderId: render.id,
      userId: user.id,
      settings: req.body?.settings,
      expiresAt: Number.isFinite(Number(req.body?.expiresAt)) ? Number(req.body.expiresAt) : null,
    });
    return res.json({
      success: true,
      url: `${originFor(req)}/s/${token}`,
      token,
      share: { active: true, createdAt: share.createdAt, viewCount: 0, settings: share.settings },
    });
  });

  // ── Edit a live link's presentation, without rotating it ───────────────────
  router.patch('/api/gallery/:id/share', limiter, async (req, res) => {
    const user = userFor(req);
    if (!user) return unauthorized(res);
    const render = ownedRender(req, user);
    if (!render) return notFound(res);
    // An agent fixing a typo in their own phone number must not invalidate the link they
    // already sent, so this deliberately does not mint a new token.
    const share = shares.updateSettings({ renderId: render.id, settings: req.body?.settings });
    if (!share) return notFound(res);
    return res.json({ success: true, share: { active: true, createdAt: share.createdAt, viewCount: share.viewCount, settings: share.settings } });
  });

  // ── Revoke ─────────────────────────────────────────────────────────────────
  router.delete('/api/gallery/:id/share', limiter, async (req, res) => {
    const user = userFor(req);
    if (!user) return unauthorized(res);
    const render = ownedRender(req, user);
    if (!render) return notFound(res);
    shares.revoke(render.id);
    // Idempotent: "make sure this link is dead" is what the caller wants, so revoking a
    // link that was already revoked is a success, not a 404.
    return res.json({ success: true });
  });

  return router;
}
