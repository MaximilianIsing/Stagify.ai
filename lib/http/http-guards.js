// Endpoint access guards + health check. The factory injects the access key, the
// constant-time comparator, and the Gemini client (health only reports whether it
// is configured). protectLogs and stagingEndpointKeyGuard are deliberately aligned:
// both are header-only (never ?key= — a key in the URL leaks via access logs,
// reverse-proxy logs, browser history, and Referer) and compare the secret with the
// constant-time endpointKeyMatches.
//
// Both also share one per-IP ceiling on WRONG keys (endpointKeyLimiter). The gate is
// applied HERE rather than on the routers because this is the only place that knows
// whether a key was actually rejected, and because every route holding the secret
// passes through one of these two functions — a limiter bolted onto routes/admin/index.js
// would still leave the same secret guessable via /api/stage-by-endpoint-key.
import { setSensitiveHeaders, sendError, getStagingClientIp } from './http-helpers.js';
import { endpointKeyLimiter as defaultEndpointKeyLimiter } from './rate-limiters.js';

/** Header carrying an admin-console session token (see lib/data/admin-sessions.js). */
export const ADMIN_SESSION_HEADER = 'X-Stagify-Admin-Session';

/**
 * The admin access log, or null. PROCESS-WIDE by design: `rejectEndpointKey` below
 * is a module-level export with no factory closure (POST /api/getpro holds the same
 * secret and reaches it directly), so the only way to instrument every refusal in
 * one place is a module binding that `createHttpGuards` sets at boot. Null until
 * then — and in the specs that never pass one — which makes recording a strict
 * no-op rather than a crash.
 * @type {{ record: (ev: object) => unknown } | null}
 */
let accessLog = null;

/**
 * Note a refused request. Every rejection in the app funnels through `rejectWith`,
 * so this is the ONE place that sees a wrong key, a dead session token and a
 * missing credential alike — instrumenting anywhere else would either miss cases
 * or double-count them.
 *
 * Which credential was offered is recorded; the credential itself never is, not
 * even a prefix. Knowing someone tried a key is the point; storing the key they
 * tried would make this table a place to go looking for secrets.
 *
 * @param {any} req
 */
function recordDenied(req) {
  if (!accessLog) return;
  try {
    accessLog.record({
      ip: getStagingClientIp(req),
      outcome: 'denied',
      reason: req.get('X-Stagify-Endpoint-Key') ? 'bad-key'
        : req.get(ADMIN_SESSION_HEADER) ? 'bad-session'
          : 'no-credential',
      path: req.originalUrl || req.path || '',
      userAgent: req.get('user-agent'),
    });
  } catch {
    // A guard must never fail because a counter did.
  }
}

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
  recordDenied(req);
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

/**
 * @param {{
 *   genAI: unknown,
 *   LOGS_ACCESS_KEY: string | undefined,
 *   endpointKeyMatches: (received: string, expected: string) => boolean,
 *   endpointKeyLimiter?: import('express').RequestHandler | null,
 *   adminSessions?: { validate: (token: string, key: string) => { expiresAt: number } | null } | null,
 *   adminAccess?: { record: (ev: object) => unknown } | null,
 *   healthFlags?: () => Record<string, unknown>,
 * }} deps - `endpointKeyLimiter` is a test-only seam: omitted (or null) it falls back
 *   to the shared limiter, so the key is never guarded unlimited. `adminSessions`
 *   omitted, `protectLogs` is key-only exactly as it was. `adminAccess` omitted,
 *   refusals are not recorded — it is optional so every existing caller (and every
 *   spec that builds guards without a database) keeps working untouched.
 *
 *   NOTE that `adminAccess` is installed PROCESS-WIDE, not per-instance: see the
 *   `accessLog` binding above for why `rejectEndpointKey` leaves no other option.
 *   A spec that needs isolation should pass its own store rather than assume the
 *   last factory call did not win.
 *
 *   `healthFlags` is optional and cheap-by-contract: omitted, /health answers with
 *   exactly the body it always did.
 */
export function createHttpGuards({ genAI, LOGS_ACCESS_KEY, endpointKeyMatches, endpointKeyLimiter, adminSessions, adminAccess, healthFlags }) {
  const keyLimiter = endpointKeyLimiter ?? defaultEndpointKeyLimiter;
  if (adminAccess) accessLog = adminAccess;

  const rejectKey = (req, res, next) =>
    rejectWith(keyLimiter, req, res, next, 'Valid access key required in the X-Stagify-Endpoint-Key header');

  /**
   * Liveness plus a flat set of configuration booleans.
   *
   * `status` and `aiConfigured` keep their exact names and meanings — this is what an
   * external monitor polls, and renaming a field here breaks somebody's alert. Everything
   * `healthFlags` adds is a PROPERTY READ: no probe, no cache, nothing that can block or
   * fail. "Is the bucket actually answering" is a different question with a different
   * cost, and it is answered on /api/status (lib/health/service-health.js).
   */
  const healthHandler = (req, res) => {
    let extra = {};
    if (typeof healthFlags === 'function') {
      try {
        extra = healthFlags() || {};
      } catch {
        // A health endpoint that 500s because a boolean threw is worse than one that
        // reports a little less.
        extra = {};
      }
    }
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      aiConfigured: !!genAI,
      ...extra,
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
