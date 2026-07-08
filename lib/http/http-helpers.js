// Small, pure request/response helpers extracted verbatim from server.js.
// No module dependencies — safe to import anywhere.

/**
 * Marks a response as sensitive: no caching and no Referer leakage. Used on
 * endpoints that return user/session data so intermediaries don't cache them and
 * the URL/Referer doesn't leak onward to third parties.
 */
export function setSensitiveHeaders(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
}

/** Client IP for rate limits (honors X-Forwarded-For when behind a proxy). */
export function getStagingClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim().slice(0, 128);
  }
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
