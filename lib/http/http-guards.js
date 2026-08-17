// Endpoint access guards + health check. The factory injects the access key, the
// constant-time comparator, and the Gemini client (health only reports whether it
// is configured). protectLogs and stagingEndpointKeyGuard are deliberately aligned:
// both are header-only (never ?key= — a key in the URL leaks via access logs,
// reverse-proxy logs, browser history, and Referer) and compare the secret with the
// constant-time endpointKeyMatches. Originally extracted from server.js.
//
// Both also share one per-IP ceiling on WRONG keys (endpointKeyLimiter). The gate is
// applied HERE rather than on the routers because this is the only place that knows
// whether a key was actually rejected, and because every route holding the secret
// passes through one of these two functions — a limiter bolted onto routes/admin.js
// would still leave the same secret guessable via /api/stage-by-endpoint-key.
import { setSensitiveHeaders, sendError } from './http-helpers.js';
import { endpointKeyLimiter as defaultEndpointKeyLimiter } from './rate-limiters.js';

/**
 * Reject a bad key, counting the attempt against the per-IP bucket FIRST. Over the
 * limit the limiter answers 429 itself and never calls back, so the 403 is skipped;
 * under it, the caller sees the same 403 as always. A store failure is forwarded to
 * Express rather than swallowed — a limiter that cannot count must not silently
 * become a pass-through.
 * @param {import('express').RequestHandler} limiter
 * @param {any} req
 * @param {any} res
 * @param {(err?: unknown) => void} next
 * @param {string} [details] - Optional `details` field on the 403 body.
 */
function rejectWith(limiter, req, res, next, details) {
  return limiter(req, res, (err) => {
    if (err) return next(err);
    return sendError(res, 403, 'Access denied', details ? { details } : undefined);
  });
}

/**
 * The same rejected-key path the two guards use, for the one route that compares the
 * key inline instead of going through them: `POST /api/getpro` (routes/auth.js). It
 * holds the SAME secret, so leaving it off this bucket would just move the guessing
 * one endpoint over — and that route grants Pro to whoever gets it right.
 * @param {any} req
 * @param {any} res
 * @param {(err?: unknown) => void} next
 */
export function rejectEndpointKey(req, res, next) {
  return rejectWith(defaultEndpointKeyLimiter, req, res, next);
}

/** Header carrying an admin-console session token (see lib/data/admin-sessions.js). */
export const ADMIN_SESSION_HEADER = 'X-Stagify-Admin-Session';

/**
 * @param {{
 *   genAI: unknown,
 *   LOGS_ACCESS_KEY: string | undefined,
 *   endpointKeyMatches: (received: string, expected: string) => boolean,
 *   endpointKeyLimiter?: import('express').RequestHandler | null,
 *   adminSessions?: { validate: (token: string, key: string) => { expiresAt: number } | null } | null,
 * }} deps - `endpointKeyLimiter` is a test-only seam: omitted (or null) it falls back
 *   to the shared limiter, so the key is never guarded unlimited. `adminSessions`
 *   omitted, `protectLogs` is key-only exactly as it was.
 */
export function createHttpGuards({ genAI, LOGS_ACCESS_KEY, endpointKeyMatches, endpointKeyLimiter, adminSessions }) {
  const keyLimiter = endpointKeyLimiter ?? defaultEndpointKeyLimiter;

  const rejectKey = (req, res, next) =>
    rejectWith(keyLimiter, req, res, next, 'Valid access key required in the X-Stagify-Endpoint-Key header');

  const healthHandler = (req, res) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      aiConfigured: !!genAI,
    });
  };

  /**
   * The raw key, header-only. Split out of `protectLogs` because minting an admin
   * session must require the KEY — letting a session token mint fresh sessions
   * would turn a single stolen token into an unrevocable one.
   *
   * `configuredKey` is passed in rather than closed over so callers have to have
   * done the not-configured check first: an empty expected value must never reach
   * the comparator.
   *
   * @param {any} req
   * @param {string} configuredKey
   * @returns {boolean}
   */
  function hasValidKey(req, configuredKey) {
    // Read the key from a header only — never the query string. A key in the URL
    // leaks via access logs, reverse-proxy logs, browser history, and Referer.
    const accessKey = req.get('X-Stagify-Endpoint-Key');
    return !!accessKey && endpointKeyMatches(accessKey, configuredKey);
  }

  /**
   * Key-only. Use for anything that hands out or escalates authority; everything
   * else the dashboard calls should take `protectLogs` so the operator is not asked
   * to re-enter the key.
   */
  function requireEndpointKey(req, res, next) {
    setSensitiveHeaders(res);
    if (!LOGS_ACCESS_KEY) {
      return sendError(res, 500, 'Server configuration error', { details: 'Logs access key not configured' });
    }
    if (hasValidKey(req, LOGS_ACCESS_KEY)) return next();
    return rejectKey(req, res, next);
  }

  // Middleware to protect logs endpoints with password — or with an admin-console
  // session token, which is the same authority scoped to these routes and nothing
  // else (lib/data/admin-sessions.js explains why the key itself is not persisted).
  //
  // STILL HEADER-ONLY, and that is a security property rather than a style: nothing
  // here is sent automatically by a browser, so a crawler, an <img> tag, a form post
  // from another origin or a pasted link cannot reach a single admin route. That is
  // what makes CSRF unreachable by construction, and it is exactly what a cookie
  // would have given up.
  function protectLogs(req, res, next) {
    setSensitiveHeaders(res);
    if (!LOGS_ACCESS_KEY) {
      return sendError(res, 500, 'Server configuration error', { details: 'Logs access key not configured' });
    }

    if (hasValidKey(req, LOGS_ACCESS_KEY)) return next();

    const sessionToken = req.get(ADMIN_SESSION_HEADER);
    // A bad token counts against the SAME per-IP bucket as a bad key. The tokens
    // are 256-bit CSPRNG values so guessing is not a real threat, but leaving one
    // credential rate-limited and the other unlimited is the kind of asymmetry that
    // only ever gets noticed after it matters.
    if (sessionToken && adminSessions && adminSessions.validate(sessionToken, LOGS_ACCESS_KEY)) {
      return next();
    }
    return rejectKey(req, res, next);
  }

  /** Same `LOGS_ACCESS_KEY` as `/promptlogs`, `/api/send-email`, etc. */
  function stagingEndpointKeyGuard(req, res, next) {
    setSensitiveHeaders(res);
    if (!LOGS_ACCESS_KEY) {
      return sendError(res, 500, 'Server configuration error', { details: 'Endpoint access key not configured' });
    }
    // Header-only + constant-time, mirroring protectLogs. A key supplied in ?key=
    // is refused — it would leak via access logs, reverse-proxy logs, browser
    // history, and Referer. (The header is trimmed for tolerance of padded values;
    // the hash-then-timingSafeEqual compare keeps that safe.)
    const accessKey = (req.get('X-Stagify-Endpoint-Key') || '').trim();
    if (accessKey && endpointKeyMatches(accessKey, LOGS_ACCESS_KEY)) {
      return next();
    }
    return rejectKey(req, res, next);
  }

  return { healthHandler, protectLogs, requireEndpointKey, stagingEndpointKeyGuard };
}
