// Bearer-key authentication for /api/v1/*.
//
// The session equivalent is getAuthUserFromRequest (lib/services/auth-helpers.js); this
// is its machine counterpart, and the differences are deliberate:
//
//   * HEADER ONLY, never ?key= and never a body field. A credential in a URL leaks
//     via access logs, reverse-proxy logs, browser history and Referer — the same rule
//     http-guards.js states for the admin key, and the reason getAuthUserFromRequest
//     reads `req.body.authToken` but pointedly not `req.query`.
//   * NO CORS, which is enforced by absence: /api/v1/* is not in ALLOWED_ORIGINS in
//     lib/http/app-middleware.js and must not be added. A key reachable from browser
//     JavaScript is a leaked key, and having no CORS headers is the cheapest way to
//     say so to anyone who tries.
//   * REJECTIONS ARE RATE LIMITED, valid calls are not. apiKeyRejectLimiter is applied
//     here rather than on the router because this is the only place that knows an
//     attempt actually failed — the same argument, and the same rejectWith shape, as
//     http-guards.js. A busy integration must not be able to lock itself out.
//
// A REVOKED key gets its own code rather than being folded into "invalid": the caller
// has already proved they hold it, so there is nothing left to protect by being vague,
// and "revoked" is the one answer that tells an on-call engineer what to actually do.

import { setSensitiveHeaders, sendError } from './http-helpers.js';
import { apiKeyRejectLimiter as defaultRejectLimiter } from './rate-limiters.js';

/** Prefix on every key we mint — used only to reject obvious non-keys early. */
const KEY_PREFIX = 'stg_live_';

/**
 * Pull the bearer credential out of the Authorization header.
 * @param {any} req - The request.
 * @returns {string} The raw key, or '' when absent/malformed.
 */
export function readBearerKey(req) {
  const h = req.headers?.authorization;
  if (!h || typeof h !== 'string') return '';
  if (!h.startsWith('Bearer ')) return '';
  return h.slice(7).trim();
}

/**
 * Build the `requireApiKey` middleware.
 * @param {{
 *   apiKeys: { findByKey: (key: string) => any, touchLastUsed: (id: string) => void },
 *   authStore: { findUserById: (id: string) => any },
 *   apiBilling: { getBalance: (userId: string) => { balance: number, suspendedAt: number | null } },
 *   rejectLimiter?: import('express').RequestHandler | null,
 * }} deps - The key store, the account store, the credit store, and a test-only
 *   limiter seam (omitted, the shared limiter is used, so the key is never unguarded).
 * @returns {{ requireApiKey: import('express').RequestHandler }} The middleware.
 */
export function createApiKeyAuth({ apiKeys, authStore, apiBilling, rejectLimiter }) {
  const limiter = rejectLimiter ?? defaultRejectLimiter;

  /**
   * Refuse a bad credential, counting it against the per-IP bucket FIRST. Over the
   * limit the limiter answers 429 itself and never calls back; under it the caller
   * gets the 401. A limiter store failure is forwarded to Express rather than
   * swallowed — a limiter that cannot count must not become a pass-through.
   * @param {any} req @param {any} res @param {(err?: unknown) => void} next
   * @param {string} code @param {string} message
   */
  function refuse(req, res, next, code, message) {
    return limiter(req, res, (err) => {
      if (err) return next(err);
      return sendError(res, 401, message, { code });
    });
  }

  /** @type {import('express').RequestHandler} */
  function requireApiKey(req, res, next) {
    setSensitiveHeaders(res);

    const raw = readBearerKey(req);
    if (!raw || !raw.startsWith(KEY_PREFIX)) {
      return refuse(
        req, res, next,
        'API_KEY_MISSING',
        'Provide your API key as: Authorization: Bearer stg_live_...',
      );
    }

    const row = apiKeys.findByKey(raw);
    if (!row) {
      return refuse(req, res, next, 'API_KEY_INVALID', 'Invalid API key');
    }
    if (row.revoked_at) {
      return refuse(req, res, next, 'API_KEY_REVOKED', 'This API key has been revoked');
    }

    // The key outlived its account — an erased user, or a restore that brought the key
    // table back without the users table. Answer as INVALID rather than inventing a
    // fourth code: from the caller's side the key genuinely no longer identifies anyone.
    const user = authStore.findUserById(row.user_id);
    if (!user) {
      return refuse(req, res, next, 'API_KEY_INVALID', 'Invalid API key');
    }

    // Suspension is a 403, not a 401: the credential is good and re-issuing it would
    // not help. Checked here so every /api/v1 route inherits it, including the read-only
    // ones — a clawed-back account should not keep browsing its usage either.
    const balance = apiBilling.getBalance(row.user_id);
    if (balance.suspendedAt) {
      return sendError(res, 403, 'This account is suspended. Contact support@stagify.ai.', {
        code: 'ACCOUNT_SUSPENDED',
      });
    }

    req.apiKey = { id: row.id, userId: row.user_id, prefix: row.key_prefix };
    req.apiUser = user;
    // Best-effort: a failed timestamp write must never fail the render the caller paid for.
    try { apiKeys.touchLastUsed(row.id); } catch { /* non-essential telemetry */ }
    return next();
  }

  return { requireApiKey };
}
