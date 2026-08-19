// The operator's view of one account's renders: what we actually produced for
// this person, and what it was produced from.
//
// WHY THIS EXISTS. Every other account surface on the dashboard is text. A bug
// report arrives as prose in a table, and the one question it always raises —
// "what did the render actually look like?" — could not be answered from the
// console at all. `staged_renders` has held the parameters and `render_blobs` the
// bytes since the gallery shipped; nothing operator-facing ever read them.
//
// WHY IT IS A SEPARATE ROUTER FROM routes/admin.js. That file sits at its 650-line
// lint cap. The repo's answer to a full file is a sibling, not a raised ceiling —
// the same reason lib/data/session-revocation.js is its own module.
//
// WHY IT SHOWS ROWS THE OWNER'S GALLERY HIDES. `stagedRenders.listForUser` filters
// to `ok AND evicted_at IS NULL`, because a customer should never meet a broken
// tile. "It failed", "it is stuck pending" and "it was reaped" are precisely the
// states a support question is about, so this reads `listAllForUser`, which
// filters nothing, and labels each state instead of hiding it.
//
// THE BODY CARRIES BEARER URLS. Presigned URLs are credentials with a clock on
// them: anyone holding one can fetch those bytes until it expires. So the response
// is `no-store` behind `setSensitiveHeaders`, exactly as the owner gallery's
// manifest is, and the URLs are minted AFTER the guard rather than before. The raw
// `storage_key` and the owner's `user_id` never appear in the body — this router
// shapes its output field by field and never spreads a database row.

import { createAsyncRouter } from '../lib/http/async-router.js';
import { readRenderExtra } from '../lib/data/render-extra.js';

/**
 * How long an admin-minted URL stays good.
 *
 * Deliberately short, and shorter than the owner gallery's: a drawer left open on
 * a shared operator screen should stop being able to fetch customer photographs
 * fairly quickly. The panel re-fetches whenever the section is expanded, so the
 * cost of a short TTL is nothing — and caching these instead is not an option at
 * all, for the reason lib/data/s3-presign.js gives: a cached presigned URL is a
 * revocation bug.
 */
export const ADMIN_URL_TTL_MS = 5 * 60 * 1000;

/** Most renders one request will return, however large a `limit` is asked for. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 24;

/**
 * Shape one row for the console.
 *
 * Field by field, never `...row`: the row carries `user_id`, and the blob rows
 * carry `storage_key`. Neither has any business in a response body, and a spread
 * would publish both the first time a column is added.
 *
 * @param {{ render: any, blobs: any[], presign: (key: string) => string }} arg
 * @returns {object}
 */
export function shapeAdminRender({ render, blobs, presign }) {
  const byRole = Object.fromEntries((blobs || []).map((b) => [b.role, b.storage_key]));
  const evicted = render.evicted_at != null;
  // Which tool made it. Read through readRenderExtra rather than off the raw column so a
  // damaged or retired value degrades to '' here exactly as it does in the owner's gallery
  // — the console and the customer must not disagree about what a row says.
  //
  // This is the one field that separates the paid API from studio usage. It is also the
  // field that spent this feature's first weeks silently empty: an unregistered source id
  // made buildRenderExtra null the whole column (lib/data/render-extra.js).
  const extra = readRenderExtra(render);
  // An evicted row still exists and still answers "what did they ask for" — only
  // its bytes are gone. Minting URLs for keys that were tombstoned would produce
  // links that 404, which reads as a broken viewer rather than as a reaped render.
  const url = (role) => (!evicted && byRole[role] ? presign(byRole[role]) : '');
  return {
    id: render.id,
    createdAt: render.created_at,
    status: render.status ?? '',
    evicted,
    evictedAt: render.evicted_at ?? null,
    width: render.width ?? null,
    height: render.height ?? null,
    roomType: render.room_type ?? '',
    furnitureStyle: render.furniture_style ?? '',
    additionalPrompt: render.additional_prompt ?? '',
    removeFurniture: !!render.remove_furniture,
    model: render.model ?? '',
    variation: render.variation ?? 0,
    batchId: render.batch_id ?? '',
    name: render.custom_name ?? '',
    source: extra.source,
    sourceName: extra.sourceName,
    bytes: (blobs || []).reduce((sum, b) => sum + (Number(b.bytes) || 0), 0),
    urls: { after: url('after'), before: url('before'), thumb: url('thumb') },
  };
}

/**
 * Build the admin render-inspector router.
 *
 * @param {{
 *   stagedRenders: any,
 *   objectStore: import('../lib/data/object-store.js').ObjectStore,
 *   protectLogs: import('express').RequestHandler,
 *   setSensitiveHeaders: (res: import('express').Response) => void,
 * }} deps
 * @returns {import('express').Router} The mounted router.
 */
export function createAdminRendersRouter(deps) {
  const { stagedRenders, objectStore, protectLogs, setSensitiveHeaders } = deps;
  const router = createAsyncRouter();

  router.get('/api/admin/renders', protectLogs, (req, res) => {
    setSensitiveHeaders(res);
    res.set('Cache-Control', 'no-store');

    const userId = String(req.query.userId || '').trim();
    if (!userId) {
      return res.status(400).json({ error: 'A userId is required' });
    }

    // Without a configured object store there are no bytes to show. Fail OPEN with
    // an explicit flag rather than 503ing, matching the owner gallery: the console
    // must keep working on a deployment that simply has no R2 configured, and a
    // panel saying "the gallery is off" is more use than one that errored.
    if (!objectStore || objectStore.configured === false) {
      return res.json({ enabled: false, total: 0, entries: [] });
    }

    const asked = Number(req.query.limit);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(asked) ? Math.floor(asked) : DEFAULT_LIMIT));
    const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));

    const rows = stagedRenders.listAllForUser({ userId, limit, offset });
    // ONE blob read for the whole page, never one per row: this endpoint is
    // pointed at the production database, and the per-row shape is the N+1 that
    // routes/gallery.js was refactored away from.
    const blobsByRender = rows.length
      ? stagedRenders.blobsForRenders(rows.map((r) => r.id))
      : new Map();

    const presign = (key) => objectStore.presignGet(key, { ttlMs: ADMIN_URL_TTL_MS });
    const entries = rows.map((render) => shapeAdminRender({
      render,
      // A row can legitimately have no blobs — tombstoned out from under a status
      // still reading `ok`. Default rather than throw, or one reaped render 500s
      // the whole panel.
      blobs: blobsByRender.get(render.id) ?? [],
      presign,
    }));

    return res.json({
      enabled: true,
      total: stagedRenders.countAllForUser(userId),
      limit,
      offset,
      entries,
    });
  });

  return router;
}
