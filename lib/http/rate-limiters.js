// Express rate limiters, extracted verbatim from server.js. Pure config with no
// server-state deps — each limit reads its env override once at module load (after
// load-env.js has populated process.env) and the constructed limiter is handed to
// the routers that mount it: authLimiter/emailLimiter → auth + public routes,
// genLimiter → staging + chat routes. The limiters guarding an UNAUTHENTICATED or
// paid endpoint (checkoutLimiter, emailPixelLimiter, validateImageLimiter) are instead
// imported directly by their router, with the dep bag as a test-only override, so a
// forgotten dep cannot silently mount that endpoint unlimited.
import { rateLimit } from 'express-rate-limit';

// `@type {const}` keeps 'draft-7' a string literal so it satisfies express-rate-limit's
// `standardHeaders` union type rather than widening to `string`.
const rlOpts = /** @type {const} */ ({ standardHeaders: 'draft-7', legacyHeaders: false });

// ── Recording who got turned away ────────────────────────────────────────────
// A 429 is a user hitting a wall, and until now not one of them was written down
// anywhere: the request is refused by middleware, so it never reaches a handler that
// logs. That made "people are bouncing off the rate limiter" unfalsifiable.
//
// server.js installs the real writer once at boot via setRateLimitRejectionLogger.
// It stays a module-level hook rather than a constructor arg because these limiters
// are module singletons constructed at import time, before the logging factory exists.
/** @type {(kind: string, code: string, detail?: string, who?: any) => void} */
let recordRejection = () => {};

/**
 * Install the rejection-log writer used by every limiter built here.
 * @param {(kind: string, code: string, detail?: string, who?: any) => void} fn - Typically logRejectionToFile from createLogging.
 * @returns {void}
 */
export function setRateLimitRejectionLogger(fn) {
  recordRejection = typeof fn === 'function' ? fn : () => {};
}

/**
 * Build a limiter that RECORDS each refusal before answering.
 *
 * The reply is byte-for-byte what express-rate-limit's default handler would send
 * (its `statusCode`, its configured `message`), so adding the log changes what we
 * KNOW, never what the caller receives. The body is read from the closure rather
 * than off `options` so the message literal is still declared exactly once.
 * @param {{ name: string, windowMs: number, limit: number, message: object }} spec - Limiter id recorded as the rejection code, window, ceiling, and the JSON body sent when it trips.
 * @returns {import('express').RequestHandler} The configured limiter middleware.
 */
function rejectingLimiter({ name, windowMs, limit, message }) {
  return rateLimit({
    ...rlOpts,
    windowMs,
    limit,
    message,
    handler: (req, res, _next, options) => {
      // Never let a logging failure turn a clean 429 into a 500.
      try {
        recordRejection('rate_limit', name, req.originalUrl || req.url || '', { req });
      } catch { /* best-effort */ }
      res.status(options.statusCode).json(message);
    },
  });
}

// Sign-in / account actions: blunt brute-force protection.
export const authLimiter = rejectingLimiter({
  name: 'auth',
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.RL_AUTH || 40),
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

// Anything that sends an email: keep tight to prevent spam/abuse.
export const emailLimiter = rejectingLimiter({
  name: 'email',
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.RL_EMAIL || 6),
  message: { error: 'Too many requests. Please wait a few minutes and try again.' },
});

// Paid AI generation: a generous backstop against cost abuse (humans stay well under).
export const genLimiter = rejectingLimiter({
  name: 'gen',
  windowMs: 5 * 60 * 1000,
  limit: Number(process.env.RL_GEN || 60),
  message: { error: 'You are generating too quickly. Please wait a moment and try again.' },
});

// Enterprise self-serve checkout: unauthenticated by design (a company buys before
// anyone has an account), and every accepted request mints a REAL Stripe Checkout
// Session. Tight per-IP ceiling — a genuine buyer fills the form once or twice —
// so both session spam and bulk probing of which domains are already customers
// (the duplicate-domain branch answers differently) stay impractical.
// Applied by routes/billing.js, which imports this directly rather than taking it
// from the server.js injection bag, so the endpoint cannot end up unlimited by an
// omitted dep. Tests override it via the router's `checkoutLimiter` dep.
export const checkoutLimiter = rejectingLimiter({
  name: 'checkout',
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.RL_CHECKOUT || 10),
  message: { error: 'Too many checkout attempts. Please wait a while and try again.' },
});

// Email open-tracking pixel (GET /email/logo.png): unauthenticated by construction —
// the caller is a mail client's image proxy, never a signed-in browser — and its
// `?email=` is attacker-controlled. A first-ever open for an address APPENDS a row to
// email_open_logs.csv and rewrites email_opened.json, both on the volume auth-store.db
// lives on, so an unlimited pixel is an unbounded anonymous write.
//
// Over the limit this does NOT reject: the URL serves the full-size logo PNG, not a
// 1x1 beacon, so a 429 renders as a broken image wherever it is embedded — and a
// shared corporate egress IP legitimately carries a whole company's opens.
// Instead the handler flags the request in `res.locals` and lets it through, so the
// route serves the image and skips only the disk write. That makes this a ceiling on
// unauthenticated WRITES per IP; lib/services/email.js enforces the absolute
// file/entry ceilings, which is what bounds a distributed flood.
//
// Imported directly by routes/public.js (as routes/billing.js does with checkoutLimiter)
// so an omitted dep cannot leave the pixel unlimited; tests override it via the
// router's `emailPixelLimiter` dep.
// No loggingHandler here or on referralLimiter below: neither one REFUSES a request,
// so there is no rejection to record. Their handlers flag the request and call next(),
// which is what makes them write-ceilings rather than rate limits.
export const EMAIL_PIXEL_RATE_LIMITED = 'emailPixelRateLimited';
export const emailPixelLimiter = rateLimit({
  ...rlOpts,
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.RL_EMAIL_PIXEL || 120),
  handler: (req, res, next) => {
    res.locals[EMAIL_PIXEL_RATE_LIMITED] = true;
    next();
  },
});

// Referral / campaign links (GET /columbia, …): unauthenticated by construction —
// the whole point is that a stranger opens the URL — and every hit APPENDS a row to
// referral_hits, in the same SQLite file auth-store.db lives in. Unlimited, the
// public campaign URL is an anonymous write loop.
//
// Like the email pixel, and for the same reason, this does NOT reject over the
// limit: the response is a redirect to the home page, so a 429 would be a stranger
// seeing an error where the site should be — and one university's NAT gateway is a
// single IP carrying a whole campus's clicks. The handler flags the request and the
// route serves the redirect anyway, dropping only the row. That makes this a ceiling
// on unauthenticated WRITES per IP; lib/data/referral-links.js enforces the absolute
// row cap, which is what bounds a distributed flood.
//
// Imported directly by routes/referrals.js (as routes/billing.js does with
// checkoutLimiter) so an omitted dep cannot leave the endpoint unlimited; tests
// override it via the router's `referralLimiter` dep.
export const REFERRAL_RATE_LIMITED = 'referralRateLimited';
export const referralLimiter = rateLimit({
  ...rlOpts,
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.RL_REFERRAL || 120),
  handler: (req, res, next) => {
    res.locals[REFERRAL_RATE_LIMITED] = true;
    next();
  },
});

// Endpoint-access-key guesses (every /promptlogs, /authstore, /api/admin/* route and
// POST /api/stage-by-endpoint-key). The whole admin surface — the CSV log dumps, the
// user list, comp grants, GDPR erasure — is gated by ONE shared static secret with no
// accounts behind it, so the only way in is to guess that secret, and until this
// existed there was nothing bounding how fast. The dashboard shows a lockout after a
// few bad tries, but that counter lives in the browser (public/scripts/admin.js), so
// it protects nobody who skips the page and posts the header directly.
//
// Counts ONLY rejected attempts: lib/http/http-guards.js runs this limiter on its
// failure path alone, so a request carrying the right key never touches the bucket
// and an operator working in the dashboard can never rate-limit themselves. That is
// what lets the ceiling be this low — 10 wrong keys per IP per 15 minutes leaves a
// real fat-finger plenty of room while making online guessing pointless.
//
// ONE limiter instance is shared by both guards on purpose. Two buckets would hand an
// attacker double the budget for alternating between an admin route and the staging
// endpoint, which check the same secret.
//
// Imported directly by lib/http/http-guards.js (as routes/billing.js does with
// checkoutLimiter) so an omitted dep cannot leave the key unlimited; tests override it
// via the factory's `endpointKeyLimiter` dep.
export const endpointKeyLimiter = rejectingLimiter({
  name: 'endpoint_key',
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.RL_ENDPOINT_KEY || 10),
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

// Upload pre-check (POST /api/validate-image): every accepted request spends a paid
// Gemini vision call, and it is the cheapest paid endpoint to drive — a single JSON
// POST, where staging itself needs a multipart upload and burns a daily quota. It sat
// behind genLimiter alone, whose 60/5min is sized for a whole staging session; a real
// caller runs this ONCE per image they pick. Tighter dedicated ceiling so a stolen or
// throwaway session can't turn the pre-check into free vision calls. Both studios treat
// any non-2xx as "valid" (fail open), so a 429 here never blocks a legitimate upload —
// it just skips the pre-check and meets the real gate one request later.
// Imported directly by routes/staging.js for the same reason as above; tests override it
// via the router's `validateImageLimiter` dep.
export const validateImageLimiter = rejectingLimiter({
  name: 'validate_image',
  windowMs: 5 * 60 * 1000,
  limit: Number(process.env.RL_VALIDATE_IMAGE || 20),
  message: { error: 'Too many image checks. Please wait a moment and try again.' },
});

// Public share pages (/s/:token and its manifest). The ONLY unauthenticated read surface
// the gallery has, and the token in the path is the whole credential — so this is the
// bucket that bounds guessing at it.
//
// It can be genuinely tight because bytes do NOT come through this process: the manifest
// hands back presigned R2 URLs and the browser fetches those directly, so one viewer
// costs one request here no matter how many images they scroll. A limiter sized for a
// gallery's worth of byte requests would have been far looser for no benefit.
//
// Imported directly by routes/share-public.js — same rule as checkoutLimiter and
// validateImageLimiter: an omitted dep must never be able to leave an unauthenticated
// endpoint unlimited. Tests override it via the router's `shareLimiter` dep.
export const shareLimiter = rejectingLimiter({
  name: 'share_public',
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.RL_SHARE || 60),
  message: { error: 'Too many requests. Please wait a moment and try again.' },
});

// The owner's own gallery. Authenticated, so this is a cost backstop rather than an
// access control: a manifest page mints one presigned URL per blob, which is cheap but
// not free, and nothing else stops a script from paging the list in a loop.
export const galleryLimiter = rejectingLimiter({
  name: 'gallery',
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.RL_GALLERY || 120),
  message: { error: 'Too many requests. Please wait a moment and try again.' },
});
