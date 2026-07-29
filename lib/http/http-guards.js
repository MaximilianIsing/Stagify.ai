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

/**
 * @param {{
 *   genAI: unknown,
 *   LOGS_ACCESS_KEY: string | undefined,
 *   endpointKeyMatches: (received: string, expected: string) => boolean,
 *   endpointKeyLimiter?: import('express').RequestHandler | null,
 * }} deps - `endpointKeyLimiter` is a test-only seam: omitted (or null) it falls back
 *   to the shared limiter, so the key is never guarded unlimited.
 */
export function createHttpGuards({ genAI, LOGS_ACCESS_KEY, endpointKeyMatches, endpointKeyLimiter }) {
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

  // Middleware to protect logs endpoints with password
  function protectLogs(req, res, next) {
    setSensitiveHeaders(res);
    if (!LOGS_ACCESS_KEY) {
      return sendError(res, 500, 'Server configuration error', { details: 'Logs access key not configured' });
    }

    // Read the key from a header only — never the query string. A key in the URL
    // leaks via access logs, reverse-proxy logs, browser history, and Referer.
    const accessKey = req.get('X-Stagify-Endpoint-Key');
    if (accessKey && endpointKeyMatches(accessKey, LOGS_ACCESS_KEY)) {
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

  return { healthHandler, protectLogs, stagingEndpointKeyGuard };
}
