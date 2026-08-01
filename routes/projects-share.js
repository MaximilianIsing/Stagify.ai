// The OWNER side of client share links — the four controls a broker has over the single
// public URL a listing may have. The PUBLIC read side lives in routes/share-public.js and
// shares no handler with this file: everything here is behind `requireProAccount`, and
// everything there is behind a token. Keeping them apart is what makes "is this endpoint
// authenticated?" answerable by looking at one file.
//
// WHAT THE OWNER ACTUALLY CONTROLS
//   GET    — the live link (or null) plus the audit trail of every link this listing has
//            ever had. Read-only, and it is the response that must NOT carry a token.
//   POST   — mint. Also ROTATE: `createShare` revokes the previous link in the same
//            transaction, so "the seller forwarded it to the whole street" is one button.
//   PATCH  — re-word the page (and optionally re-date it) WITHOUT rotating the token, so
//            the link the broker already texted keeps working.
//   DELETE — revoke. Idempotent: a second click reports 0 revoked and still 200s, because
//            a kill switch that errors is a kill switch people stop trusting.
//
// THE PLAINTEXT TOKEN APPEARS IN EXACTLY ONE RESPONSE BODY IN THIS FILE — the POST's, and
// it is the only place it can appear anywhere, because the store keeps nothing but a
// sha256 digest and `ProjectShare` has no token field to leak. So: never log it, never put
// it in an error body, never echo it from GET or PATCH. If you add a route here that reads
// a token, that route belongs in the public file, not this one.
//
// OWNERSHIP IS RE-KEYED ON THE VALIDATED SESSION USER, exactly as in routes/projects.js:
// `requireProAccount` runs INSIDE each handler and `ownedProject` answers the SAME 404 for
// "no such listing" and "someone else's listing". A 403 here would confirm which listing
// ids exist — and each of those ids is one POST away from a public URL.
//
// EXPIRY IS EXPRESSED IN DAYS ON THE WIRE (`expiresInDays`), not as an epoch. The client
// is a date-picker/preset control, the store column is epoch ms, and doing the conversion
// here means a caller can never hand the store a timestamp in the past (which would mint a
// link that is dead on arrival) or one in the year 12000.

import { sendError } from '../lib/http/http-helpers.js';
import { logger } from '../lib/logger.js';
import { asBool, clampInt, clampText } from './projects-shared.js';

/** @typedef {import('../lib/types/projects.js').Project} Project */
/** @typedef {import('../lib/types/projects.js').ProjectShare} ProjectShare */
/** @typedef {ReturnType<typeof import('../lib/data/project-shares.js').createProjectShares>} SharesStore */

/** Shortest link the API will mint. Below a day the control is a footgun, not a feature. */
export const MIN_EXPIRY_DAYS = 1;
/** Longest link the API will mint. A year is already well past any listing's shelf life. */
export const MAX_EXPIRY_DAYS = 365;
/** Days → ms. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows returned in the GET's audit trail. The store caps its own limit at 100. */
export const SHARE_HISTORY_LIMIT = 20;

/**
 * Boundary clamp for every text field of the settings bag.
 *
 * Deliberately ONE generous ceiling rather than a copy of the store's five per-field
 * limits: `normalizeShareSettings` (lib/data/project-shares.js) is the authority on what
 * each field may be and which keys exist at all, and duplicating those numbers here would
 * be five places to drift. This bound exists only so a multi-megabyte string never reaches
 * the store, and it is wider than the widest field so it truncates nothing the store would
 * have kept.
 */
const MAX_SETTING_FIELD = 600;

/**
 * @typedef {{ ok: true, present: boolean, expiresAt: number|null } | { ok: false }} ExpiryResult
 * `present` distinguishes "the caller did not mention expiry" (PATCH leaves it alone) from
 * "the caller asked for never" (`expiresInDays: null`), which the store treats differently.
 */

/**
 * Read the caller's requested expiry off a request body and convert it to an epoch.
 *
 * Absent key → not present, no expiry. Explicit `null` → present, never expires. A whole
 * number of days in [MIN_EXPIRY_DAYS, MAX_EXPIRY_DAYS] → present, `now + days`. Anything
 * else is REFUSED rather than coerced, which is the whole reason this is not a bare
 * `clampInt`: silently rounding `expiresInDays: 3650` down to 365 (or `0` up to 1) would
 * hand the owner a link with an expiry date they never chose, on a page showing photos of
 * a client's home.
 * @param {unknown} body - The raw request body.
 * @param {number} now - Epoch ms the offset is measured from.
 * @returns {ExpiryResult} The parsed expiry, or `{ ok: false }` for the caller to 400 on.
 */
export function readExpiry(body, now) {
  const bag = body && typeof body === 'object' ? /** @type {Record<string, unknown>} */ (body) : {};
  if (!Object.prototype.hasOwnProperty.call(bag, 'expiresInDays')) return { ok: true, present: false, expiresAt: null };
  const raw = bag.expiresInDays;
  if (raw === null) return { ok: true, present: true, expiresAt: null };
  // Only a number or a numeric string. Without this, `true` would coerce to 1 day.
  if (typeof raw !== 'number' && typeof raw !== 'string') return { ok: false };
  const days = Number(raw);
  if (!Number.isInteger(days)) return { ok: false };
  // clampInt is used as the RANGE ORACLE, not as the value source: if clamping would have
  // changed the number, the number was out of range and the request is refused.
  if (clampInt(days, MIN_EXPIRY_DAYS, MAX_EXPIRY_DAYS, 0) !== days) return { ok: false };
  return { ok: true, present: true, expiresAt: now + (days * DAY_MS) };
}

/**
 * Read the presentation settings off a request body.
 *
 * The bag may arrive nested (`{ settings: {…} }`) or flat on the body; both are accepted
 * because the two writing routes have different natural shapes and an ignored headline is
 * a silent bug. Unknown keys are NOT filtered here — `normalizeShareSettings` in the store
 * is the allowlist, so there is exactly one place that decides what a share may publish.
 *
 * `showBefore` is only forwarded when the caller actually sent it: it is TRI-state on the
 * wire (absent means "use the store's default", which is true), and a bare `asBool` on an
 * absent key would silently turn the before/after pair — the entire persuasive point of
 * the page — off for every client that omits the field.
 * @param {unknown} body - The raw request body.
 * @returns {Record<string, unknown>} A clamped bag for `createShare`/`updateShare`.
 */
export function readShareSettings(body) {
  const raw = body && typeof body === 'object' ? /** @type {Record<string, unknown>} */ (body) : {};
  const nested = raw.settings;
  const bag = nested && typeof nested === 'object' ? /** @type {Record<string, unknown>} */ (nested) : raw;
  /** @type {Record<string, unknown>} */
  const settings = {
    headline: clampText(bag.headline, MAX_SETTING_FIELD),
    note: clampText(bag.note, MAX_SETTING_FIELD),
    agentName: clampText(bag.agentName, MAX_SETTING_FIELD),
    agentEmail: clampText(bag.agentEmail, MAX_SETTING_FIELD),
    agentPhone: clampText(bag.agentPhone, MAX_SETTING_FIELD),
  };
  if (bag.showBefore !== undefined) settings.showBefore = asBool(bag.showBefore);
  return settings;
}

/**
 * The absolute origin share URLs are built on, with any trailing slash removed.
 *
 * Falls back to the production origin rather than to '' for the same reason
 * lib/services/email.js does: the result is pasted into a text message to somebody's
 * client, and a relative `/s/<token>` is a link that cannot be opened. A wrong-but-absolute
 * origin is recoverable; a broken link handed to a seller is not.
 * @param {string|undefined} appUrl - Configured origin (server.js's APP_URL).
 * @returns {string} Origin with no trailing slash.
 */
export function shareOrigin(appUrl) {
  return String(appUrl || 'https://stagify.ai').replace(/\/+$/, '');
}

/**
 * @typedef {Object} ShareRouteContext
 * @property {import('express').Router} router The router these four routes are registered on.
 * @property {SharesStore} shares Share store (lib/data/project-shares.js).
 * @property {(req: import('express').Request, res: import('express').Response) => any} requireProAccount Responds 401/403 and returns null when the caller is not Stagify+.
 * @property {(context: string, fn: (req: import('express').Request, res: import('express').Response) => Promise<unknown>) => import('express').RequestHandler} guard Wraps a handler so an unexpected throw becomes a 500 carrying only a log reference.
 * @property {(res: import('express').Response) => import('express').Response} notFound The uniform 404 — the SAME answer for "absent" and "not yours".
 * @property {(req: import('express').Request, user: { id: string }) => Project|null} ownedProject Loads `:id` only when this session owns it.
 * @property {(res: import('express').Response) => void} setSensitiveHeaders Marks a response no-store / no-referrer.
 * @property {string} appUrl Absolute site origin the share URL is built on.
 */

/**
 * Register the owner-side share routes on the Listing Studio router.
 *
 * `GET|POST|PATCH|DELETE /api/projects/:id/share`.
 * @param {ShareRouteContext} ctx - Router, share store, auth gate, error/404 helpers and the site origin.
 * @returns {void}
 */
export function registerShareRoutes(ctx) {
  const { router, shares, requireProAccount, guard, notFound, ownedProject, setSensitiveHeaders } = ctx;
  const origin = shareOrigin(ctx.appUrl);

  /**
   * The 400 for an unparseable or out-of-range `expiresInDays`.
   * @param {import('express').Response} res - Response.
   * @returns {import('express').Response} The 400.
   */
  const badExpiry = (res) => sendError(
    res,
    400,
    `expiresInDays must be null, or a whole number of days between ${MIN_EXPIRY_DAYS} and ${MAX_EXPIRY_DAYS}`,
    { code: 'BAD_EXPIRY' },
  );

  router.get('/api/projects/:id/share', guard('projects.share.get', async (req, res) => {
    const user = requireProAccount(req, res);
    if (!user) return;
    const project = ownedProject(req, user);
    if (!project) return notFound(res);

    setSensitiveHeaders(res);
    // NO TOKEN IN THIS BODY, and none is reachable: `ProjectShare` has no token field and
    // the store holds only a digest. An owner who lost the link rotates it (POST).
    res.json({
      share: shares.activeShareFor(project.id),
      history: shares.listSharesFor(project.id, SHARE_HISTORY_LIMIT),
    });
  }));

  router.post('/api/projects/:id/share', guard('projects.share.create', async (req, res) => {
    const user = requireProAccount(req, res);
    if (!user) return;
    const project = ownedProject(req, user);
    if (!project) return notFound(res);

    const now = Date.now();
    const expiry = readExpiry(req.body, now);
    if (!expiry.ok) return badExpiry(res);

    // `userId` comes from the VALIDATED session, never from the body or the project row —
    // same rule as every other write in this feature.
    const { share, token, replaced } = shares.createShare({
      projectId: project.id,
      userId: user.id,
      settings: readShareSettings(req.body),
      expiresAt: expiry.expiresAt,
      now,
    });

    // The log line names the listing and how many links were rotated out, and NOT the
    // token — a share token is a bearer credential, so a log file that carries one is a
    // log file that grants access to a customer's home.
    logger.info(`[projects] share minted for ${project.id} (rotated out ${replaced})`);

    setSensitiveHeaders(res);
    // THE ONE AND ONLY RESPONSE THAT CARRIES THE PLAINTEXT TOKEN. There is no read-back:
    // if this body is lost, the owner must mint a new link.
    res.json({ share, token, url: `${origin}/s/${token}`, replaced });
  }));

  router.patch('/api/projects/:id/share', guard('projects.share.patch', async (req, res) => {
    const user = requireProAccount(req, res);
    if (!user) return;
    const project = ownedProject(req, user);
    if (!project) return notFound(res);

    // PATCH edits the LIVE link only. Editing a revoked one would silently re-word a page
    // nobody can open, and there is no "which share" in the URL to disambiguate — so a
    // listing with no live link is a 400 telling the client to mint one, not a 404 (the
    // listing itself is real and owned; only the share is missing).
    const current = shares.activeShareFor(project.id);
    if (!current) return sendError(res, 400, 'This listing has no live share link to update', { code: 'NO_SHARE' });

    const expiry = readExpiry(req.body, Date.now());
    if (!expiry.ok) return badExpiry(res);

    /** @type {{ settings: Record<string, unknown>, expiresAt?: number|null }} */
    const patch = { settings: readShareSettings(req.body) };
    // Only forward `expiresAt` when the caller mentioned it: the store leaves the column
    // untouched for an absent key, so a settings-only save cannot un-expire a link the
    // owner time-boxed.
    if (expiry.present) patch.expiresAt = expiry.expiresAt;

    const share = shares.updateShare(current.id, patch);
    // The row was there a statement ago; if it is gone the listing was deleted mid-request.
    if (!share) return notFound(res);

    setSensitiveHeaders(res);
    // No token: PATCH does not rotate, so there is no new one — and the existing one is
    // unreadable by design.
    res.json({ share });
  }));

  router.delete('/api/projects/:id/share', guard('projects.share.revoke', async (req, res) => {
    const user = requireProAccount(req, res);
    if (!user) return;
    const project = ownedProject(req, user);
    if (!project) return notFound(res);

    // Revocation is a read-time flag, not a DELETE: the row stays so the owner keeps the
    // view count of the link they just killed. Idempotent — `revoked: 0` on the second
    // call, still a 200, because this is the "stop showing my client's house" button.
    const revoked = shares.revokeSharesFor(project.id, Date.now());
    setSensitiveHeaders(res);
    res.json({ ok: true, revoked });
  }));
}
