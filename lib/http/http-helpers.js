// Small, pure request/response helpers extracted verbatim from server.js.
// No module dependencies — safe to import anywhere.

/**
 * Standard JSON error response for the route layer. Every error body flows
 * through here so the shape is predictable across endpoints:
 *   { error }                         — always present; human-readable summary
 *   { error, code }                   — `code` is machine-readable; the client
 *                                       switches on it (AUTH_REQUIRED,
 *                                       NO_IMAGE_GENERATED, STRIPE_DISABLED, …)
 *   { error, details }                — `details` is a diagnostic string the client
 *                                       never keys on. It must be a **fixed string
 *                                       written here in the source** (an operator
 *                                       hint like 'Endpoint access key not
 *                                       configured', or a validation reason). It is
 *                                       NOT a channel for exception text — see
 *                                       `ref` below.
 *   { error, ref }                    — `ref` identifies one logged failure
 *                                       (`lib/http/error-ref.js`). This is what a
 *                                       5xx returns instead of the caught error's
 *                                       message: the client learns nothing about
 *                                       the internals, and the operator can find
 *                                       the exact log line.
 *   { error, response }               — `response` is a user-facing fallback
 *                                       message the client renders directly in the
 *                                       chat transcript (distinct from `details`,
 *                                       which the client never displays). Used by
 *                                       the AI endpoints so a 500 still shows the
 *                                       user a polite reply instead of nothing.
 * `code`, `details`, `ref`, and `response` are omitted when falsy so simple errors
 * stay `{ error }`. The client detects failure from the HTTP status, not the body, so
 * callers pass the real status here rather than relying on a body-level ok/success flag.
 *
 * Putting a caught exception's message in `error` or `details` is a leak, and
 * `test/http/error-leak.test.js` fails the build for it. Pass `{ ref:
 * reportError(context, err) }` instead.
 */
export function sendError(res, status, error, { code, details, ref, response } = /** @type {{ code?: string, details?: string, ref?: string, response?: string }} */ ({})) {
  const body = { error };
  if (code) body.code = code;
  if (details) body.details = details;
  if (ref) body.ref = ref;
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
