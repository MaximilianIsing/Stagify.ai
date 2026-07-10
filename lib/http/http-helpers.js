// Small, pure request/response helpers extracted verbatim from server.js.
// No module dependencies — safe to import anywhere.

/**
 * Standard JSON error response for the route layer. Every error body flows
 * through here so the shape is predictable across endpoints:
 *   { error }                         — always present; human-readable summary
 *   { error, code }                   — `code` is machine-readable; the client
 *                                       switches on it (AUTH_REQUIRED,
 *                                       NO_IMAGE_GENERATED, STRIPE_DISABLED, …)
 *   { error, details }                — `details` is a diagnostic string (an
 *                                       exception message or operator hint); the
 *                                       client never keys on it, so it's safe to
 *                                       expose without becoming a contract.
 *   { error, response }               — `response` is a user-facing fallback
 *                                       message the client renders directly in the
 *                                       chat transcript (distinct from `details`,
 *                                       which the client never displays). Used by
 *                                       the AI endpoints so a 500 still shows the
 *                                       user a polite reply instead of nothing.
 * `code`, `details`, and `response` are omitted when falsy so simple errors stay
 * `{ error }`. The client detects failure from the HTTP status, not the body, so
 * callers pass the real status here rather than relying on a body-level ok/success flag.
 */
export function sendError(res, status, error, { code, details, response } = /** @type {{ code?: string, details?: string, response?: string }} */ ({})) {
  const body = { error };
  if (code) body.code = code;
  if (details) body.details = details;
  if (response) body.response = response;
  return res.status(status).json(body);
}

/**
 * Marks a response as sensitive: no caching and no Referer leakage. Used on
 * endpoints that return user/session data so intermediaries don't cache them and
 * the URL/Referer doesn't leak onward to third parties.
 */
export function setSensitiveHeaders(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
}

/**
 * Client IP for the anonymous free-tier cap. Trust `req.ip`, which Express derives
 * from the proxy chain according to the `trust proxy` setting (server.js pins it to
 * 1 for Render's single proxy) — i.e. the right-most, non-forgeable hop. We must NOT
 * parse X-Forwarded-For ourselves: its left-most entry is client-supplied, so reading
 * it directly would let a caller spoof/rotate the header to slip past the per-IP cap.
 */
export function getStagingClientIp(req) {
  const ip = req.ip || req.socket?.remoteAddress || '';
  return String(ip).replace(/^::ffff:/, '').slice(0, 128) || 'unknown';
}

/** Heuristic: anonymous mobile browsers may use IP-based free tier instead of signing in. */
export function isLikelyMobileStagingRequest(req) {
  const ua = req.headers['user-agent'];
  if (!ua || typeof ua !== 'string') return false;
  return /Mobile|Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
}

/** Stable identifier for a request: explicit userId/email if present, else an IP-derived id. */
export function getUserIdentifier(req) {
  // Try to get userId from request body
  if (req.body && req.body.userId) {
    return req.body.userId;
  }

  // Try to get email from request body
  if (req.body && req.body.userEmail && req.body.userEmail !== 'unknown') {
    return req.body.userEmail;
  }

  // Generate a user ID based on IP address (for anonymous users)
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  // Create a simple hash-like identifier from IP
  return `user_${ip.replace(/\./g, '_').replace(/:/g, '_')}`;
}
