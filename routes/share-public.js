// The PUBLIC share surface — the only part of the gallery reachable without a Stagify
// account, and therefore the highest-risk file in the feature.
//
// Adapted from routes/share-public.js on origin/experimental/listing-studio. The subject
// is one staged render rather than a whole listing, and the byte routes are gone (see
// below), but every security property below came across deliberately unchanged.
//
// WHO IS ON THE OTHER END
// An agent mints a link (lib/data/gallery-shares.js) and texts it to the seller deciding
// whether to stage, or drops it in a listing email a buyer opens on a phone. Neither
// person has an account, so THE TOKEN IS THE ONLY CREDENTIAL. Everything here follows.
//
// ONE 404, ALWAYS, FOR EVERYTHING
// `resolveShare` answers unknown / revoked / expired, and this file throws that
// distinction away on purpose: a caller who can tell "revoked" from "never existed" has
// learned that a token was once real, which is a slow oracle over a keyspace we otherwise
// never leak. The same 404 covers a render that is gone, a render belonging to somebody
// else, a render that failed, and an evicted one. `notFound()` is the ONLY refusal in
// this file and every route funnels through it, body and headers alike — if you ever need
// a second refusal shape, you are building the oracle back.
//
// THE MANIFEST IS AN ALLOWLIST BY CONSTRUCTION
// `buildManifest` copies field by field and NEVER spreads a row. A staged_renders row
// carries `user_id`, storage keys, the model name, the internal prompt and timestamps —
// none of which a buyer may see, and all of which a `...row` would publish the day
// somebody adds a column. Adding a field here has to be a deliberate line of code.
//
// FOUR OF THOSE LINES DESCRIBE THE PHOTO: `name`, `roomType`, `furnitureStyle` and
// `stagedAt`. They are here so the page can head itself with the SAME label the owner sees
// in their own gallery and print what was made, when — a share page that says only "Staged
// room" makes the recipient ask the questions the page exists to answer.
//
// `name` is the owner's own label, and publishing it is a deliberate reversal: it used to
// be gallery-only, on the reasoning that somebody might file a render under "Wilson
// viewing, redo the lighting". Whoever opens the link already has the link, the OG tags
// stay generic so no unfurl crawler sees any of it, and a name the owner typed onto a photo
// they are sending to a client is a caption more often than a note. The prompt behind the
// render — the other free-text field on the row — stays out.
//
// NO BYTES PASS THROUGH THIS PROCESS
// The parked version served blobs from disk. Here the manifest carries short-TTL
// PRESIGNED URLs and the browser fetches R2 directly — which is the entire reason the
// bytes are in a bucket (see lib/data/object-store-r2.js). Two consequences worth
// stating: the tenancy check happens once, here, before any URL is minted; and
// REVOCATION IS EVENTUAL, because a URL already handed out keeps working until it
// expires. The hard revoke is deleting the entry, which tombstones the object.
//
// THE SOURCE PHOTO IS NEVER PUBLISHED. `before` exists for the owner's private gallery
// only. A URL for it is not minted here, so no amount of guessing at the manifest shape
// produces one — the omission is structural, not a flag someone can flip.
//
// CROSS-TENANT: NEVER TRUST AN ID
// The render is servable only after the token resolves to a share AND the row's user_id
// matches that share's. A single missing `===` is the whole tenancy boundary.
//
// HEADERS ARE PART OF THE SECURITY, NOT DECORATION
// The token sits in the PATH, so `Referrer-Policy: no-referrer` on every route is what
// stops an outbound link or a third-party image load from mailing the live credential to
// somebody else in a `Referer` header. It matters more here than it did on the parked
// branch, because the page now loads images from an R2 origin. `X-Robots-Tag: noindex,
// nofollow` keeps a seller's house out of Google when the link gets forwarded, and
// nothing is ever `public`-cacheable.
import path from 'path';
import { createAsyncRouter } from '../lib/http/async-router.js';
import { sendError } from '../lib/http/http-helpers.js';
import { reportError } from '../lib/http/error-ref.js';
import { shareLimiter as defaultShareLimiter } from '../lib/http/rate-limiters.js';
import { STAGING_DISCLOSURE } from '../lib/staging/staging-disclosure.js';
import { readRenderExtra } from '../lib/data/render-extra.js';
import { logger } from '../lib/logger.js';

/** The static shell served at `/s/:token`; it fetches its own data from the manifest. */
export const SHARE_PAGE_FILE = 'listing-share.html';

/**
 * Cache policy for everything this router sends — including EVERY 404, so the refusal is
 * identical across routes. `private` (never `public`) keeps a shared proxy from retaining
 * a copy of a page meant for one recipient.
 */
export const SHARE_NO_STORE = 'private, no-store';

/** How long a presigned image URL in the manifest stays valid. */
export const SHARE_URL_TTL_MS = 15 * 60 * 1000;

const MAX_LABEL = 80;

/**
 * Trim and hard-clamp anything on its way into the public payload.
 *
 * The store already clamps the share's settings, so this is belt-and-braces — but this is
 * the one response an anonymous stranger reads, and an unbounded string here is an
 * unbounded string there.
 * @param {unknown} value @param {number} max @returns {string} '' when not a string.
 */
function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Is this render publishable to someone holding the link?
 *
 * THE single definition, used by the manifest and by nothing else — because nothing else
 * serves bytes. Three independent reasons to say no: the render is not `ok` (queued,
 * failed, or still uploading is internal state, not something to publish); it has been
 * evicted by the free-tier cap or deleted by its owner; or it belongs to somebody else.
 *
 * @param {any} render - The staged_renders row.
 * @param {{ userId: string }} share - The resolved share.
 * @returns {boolean}
 */
export function isPublishable(render, share) {
  if (!render || !share) return false;
  if (render.status !== 'ok') return false;
  if (render.evicted_at) return false;
  // The tenancy boundary. Without this comparison ANY live link would serve ANY
  // customer's pixels.
  if (render.user_id !== share.userId) return false;
  return true;
}

/**
 * Build the public payload.
 *
 * The `rooms[].frames[]` shape is deliberately the parked branch's, carrying exactly one
 * room and one frame. Keeping it means "share several entries as one link" is later a
 * store change rather than a page rewrite.
 *
 * @param {{ render: any, blobs: { role: string, storage_key: string }[], share: any,
 *   presign: (key: string) => string }} arg
 * @returns {any} The manifest.
 */
export function buildManifest({ render, blobs, share, presign }) {
  const after = blobs.find((b) => b.role === 'after');
  const thumb = blobs.find((b) => b.role === 'thumb');
  // NOTE: `before` is deliberately not looked up. See the header.
  const settings = share.settings ?? {};
  const extra = readRenderExtra(render);

  return {
    headline: text(settings.headline, 120),
    note: text(settings.note, 600),
    // What the photo is, in the owner's own words and the studio's. The page heads itself
    // with `name` when there is one and derives "<Style> <Room type>" when there is not —
    // the same rule, from the same module, as the owner's gallery.
    name: text(render.custom_name, MAX_LABEL),
    roomType: text(render.room_type, MAX_LABEL),
    furnitureStyle: text(render.furniture_style, MAX_LABEL),
    // Which studio made it, and the one setting worth naming it by. Published because they
    // are OUR vocabulary — four tool ids and our own preset labels — with no customer data
    // in them, and because without them this page would head an exterior render "Staged
    // room" where its owner sees "Exterior — Golden hour". The two pages agreeing is the
    // whole reason public/scripts/render-name.js exists.
    //
    // `sourceName` — the source photo's filename — is DELIBERATELY NOT HERE, and the
    // omission is structural rather than a flag someone can flip. Listing photos are named
    // "412-rosewood-ln-master.jpg" or "smith-listing-REDO", so publishing the stem hands
    // the property address and the agent's private filing to whoever holds the link. This
    // is the same line the header draws for the prompt: `custom_name` goes out because it
    // is typed AS a caption, and nobody names a file for an audience. The derived name
    // simply appends nothing when the entry carries no stem, so the page needs no branch.
    source: text(extra.source, MAX_LABEL),
    qualifier: text(extra.qualifier, MAX_LABEL),
    // Milliseconds, formatted in the reader's own locale by the page. A date formatted
    // here would be formatted in the SERVER's, which is nobody's.
    stagedAt: Number.isFinite(render.created_at) ? render.created_at : null,
    agent: {
      name: text(settings.agentName, 120),
      email: text(settings.agentEmail, 120),
      phone: text(settings.agentPhone, 120),
    },
    rooms: [{
      key: 'room',
      label: text(render.room_type, MAX_LABEL) || 'Staged room',
      frames: [{
        renderId: render.id,
        url: after ? presign(after.storage_key) : '',
        thumbUrl: thumb ? presign(thumb.storage_key) : '',
        width: render.width ?? null,
        height: render.height ?? null,
      }],
    }],
    frameCount: 1,
    // Shipped WITH the pixels, from the one shared constant, because an MLS/NAR
    // disclosure that lives only in the owner's UI is a disclosure the buyer never sees.
    disclosure: STAGING_DISCLOSURE,
    urlTtlMs: SHARE_URL_TTL_MS,
  };
}

/**
 * Build the public share router.
 *
 * @param {{ shares: ReturnType<typeof import('../lib/data/gallery-shares.js').createGalleryShares>,
 *   stagedRenders: ReturnType<typeof import('../lib/data/staged-renders.js').createStagedRenders>,
 *   objectStore: import('../lib/data/object-store.js').ObjectStore,
 *   shareLimiter?: import('express').RequestHandler, __dirname: string }} deps
 * @returns {import('express').Router}
 */
export default function createSharePublicRouter(deps) {
  const { shares, stagedRenders, objectStore, __dirname } = deps;
  // Imported directly rather than taken from the bag, so an omitted dep cannot leave this
  // unauthenticated surface unlimited. Tests still override it.
  const limiter = deps.shareLimiter ?? defaultShareLimiter;
  const router = createAsyncRouter();
  const pagePath = path.join(__dirname, 'public', SHARE_PAGE_FILE);

  /**
   * THE refusal. Every rejection on this surface answers with exactly this: same status,
   * same body, same headers.
   * @param {import('express').Response} res @returns {any}
   */
  const notFound = (res) => sendError(res, 404, 'Not found', { code: 'NOT_FOUND' });

  /**
   * The headers every response carries, set BEFORE any lookup so a 404 cannot be told
   * apart from a 200 by its header set either.
   * @param {import('express').Response} res
   */
  function publicHeaders(res) {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Cache-Control', SHARE_NO_STORE);
  }

  /**
   * Wrap a handler so an unexpected throw becomes a 500 carrying only a log reference —
   * never `err.message`, which on this surface would hand internals to an anonymous
   * caller.
   * @param {string} context @param {(req: any, res: any) => Promise<unknown>} fn
   * @returns {import('express').RequestHandler}
   */
  const guard = (context, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      const ref = reportError(context, err);
      if (!res.headersSent) sendError(res, 500, 'Request failed', { ref });
    }
  };

  // ── The page ───────────────────────────────────────────────────────────────
  //
  // NO LOOKUP HAPPENS HERE, on purpose. The shell is byte-identical for every token,
  // including junk, so this route cannot be used to sort real tokens from invented ones —
  // not because the comparison is careful, but because there is no comparison. The page
  // then fetches the manifest and renders "no longer available" for the one 404 it can get.
  router.get('/s/:token', limiter, guard('share.page', async (req, res) => {
    publicHeaders(res);
    await new Promise((resolve) => {
      res.sendFile(pagePath, (err) => {
        if (err && !res.headersSent) {
          // A missing shell is a broken deploy, not a token problem — logged for the
          // operator, and still the uniform 404 so this route never grows a second shape.
          logger.error('[share] could not send the share page shell:', err);
          notFound(res);
        }
        resolve(undefined);
      });
    });
  }));

  // ── The manifest ───────────────────────────────────────────────────────────
  router.get('/api/share/:token', limiter, guard('share.manifest', async (req, res) => {
    publicHeaders(res);
    const token = String(req.params.token || '');
    const outcome = shares.resolveShare(token);
    // The reason is deliberately dropped on the floor — see the header.
    if (!outcome.ok) return notFound(res);

    const share = outcome.share;
    const render = stagedRenders.get(share.renderId);
    if (!isPublishable(render, share)) return notFound(res);

    const blobs = stagedRenders.blobsFor(render.id);
    // Minted AFTER the tenancy check, never before: a presigned URL is a bearer
    // credential for the bytes, so building one for a render we have not authorized
    // would leak it into a log or an error path.
    const manifest = buildManifest({
      render,
      blobs,
      share,
      presign: (key) => objectStore.presignGet(key, { ttlMs: SHARE_URL_TTL_MS }),
    });
    if (!manifest.rooms[0].frames[0].url) return notFound(res);

    // Counted after the manifest is known-good, so a refused request is not a "view".
    // Debounced in the store, so a tab left open all afternoon is one visit.
    shares.recordView(token);
    return res.json(manifest);
  }));

  return router;
}
