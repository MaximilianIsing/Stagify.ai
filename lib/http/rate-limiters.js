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

// Sign-in / account actions: blunt brute-force protection.
export const authLimiter = rateLimit({
  ...rlOpts,
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.RL_AUTH || 40),
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

// Anything that sends an email: keep tight to prevent spam/abuse.
export const emailLimiter = rateLimit({
  ...rlOpts,
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.RL_EMAIL || 6),
  message: { error: 'Too many requests. Please wait a few minutes and try again.' },
});

// Paid AI generation: a generous backstop against cost abuse (humans stay well under).
export const genLimiter = rateLimit({
  ...rlOpts,
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
export const checkoutLimiter = rateLimit({
  ...rlOpts,
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
export const endpointKeyLimiter = rateLimit({
  ...rlOpts,
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
export const validateImageLimiter = rateLimit({
  ...rlOpts,
  windowMs: 5 * 60 * 1000,
  limit: Number(process.env.RL_VALIDATE_IMAGE || 20),
  message: { error: 'Too many image checks. Please wait a moment and try again.' },
});

// Client share links (GET /s/:token and the three /api/share/:token routes): the only
// UNAUTHENTICATED surface of the Listing Studio, and the only one that reads image blobs
// off the volume without a session. Two distinct abuses to bound, and one legitimate
// pattern that must not be caught:
//   * TOKEN GUESSING — a 32-byte token is unguessable, so this is not the real defence,
//     but an unlimited endpoint invites the attempt and the misses each cost a hash and
//     an index probe;
//   * BANDWIDTH — a share is a link a broker deliberately publishes, so the "attacker"
//     may simply be a popular listing; the ceiling therefore bounds a scraping loop
//     rather than punishing a busy open house.
// The legitimate pattern is the expensive-looking one: opening a 40-frame gallery fetches
// the manifest once and then up to 80 images, which is why this is far looser than the
// authenticated limiters and windowed over 5 minutes rather than 15.
// Imported directly by routes/share-public.js (as checkoutLimiter and the pixel limiter
// are) so an omitted dep cannot leave the public surface unlimited; tests override it via
// the router's `shareLimiter` dep.
export const shareLimiter = rateLimit({
  ...rlOpts,
  windowMs: 5 * 60 * 1000,
  limit: Number(process.env.RL_SHARE || 400),
  message: { error: 'Too many requests. Please wait a moment and try again.' },
});

// Seller sign-off (POST/GET /api/share/:token/feedback): the only endpoint in this app
// where an ANONYMOUS caller can write FREE TEXT to the volume the SQLite database and every
// customer's photographs live on. `referral_hits` is the only other anonymous write and it
// stores no caller-supplied string at all, so this is a category harder.
//
// Deliberately far tighter than `shareLimiter`, because the traffic shape is the opposite:
// opening a gallery legitimately fetches ~80 images, while a seller signing off on a
// 12-room house submits a dozen times in a sitting and then stops. A ceiling sized for the
// reading is no ceiling at all for the writing, which is why these are two limiters and not
// one.
//
// This is the OUTER bound only. The real guarantee is in lib/data/share-feedback.js, which
// caps rows per share link inside the insert's transaction — a limiter is per IP and per
// window, so it cannot bound total growth on its own, and a distributed flood would walk
// straight past it. Both, on purpose.
//
// Imported directly by routes/share-feedback.js (as checkoutLimiter and the pixel limiter
// are) so an omitted dep cannot leave an anonymous write unlimited; tests override it via
// the router's `feedbackLimiter` dep.
export const feedbackLimiter = rateLimit({
  ...rlOpts,
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.RL_SHARE_FEEDBACK || 30),
  message: { error: 'Too many responses. Please wait a few minutes and try again.' },
});

// The READ side of the same loop, deliberately on its own budget.
//
// It used to share `feedbackLimiter`, and that was a real defect rather than a tidy reuse:
// spending the budget on WRITES made the next GET 429, and the share page treats a failed
// read as "this link has no reply feature" — so the reply UI vanished ENTIRELY, taking the
// seller's already-submitted notes out of view with it. A seller who simply answered a lot
// of rooms would reload and conclude their feedback had been lost. Found by driving the
// real page after a flood, not by a test.
//
// Nothing in the write's reasoning applies here: this read is idempotent, returns only what
// that same link already submitted, and cannot grow the volume. So it is bounded against
// scraping and nothing else — high enough that a human reloading a page can never reach it,
// which is the property that matters.
export const feedbackReadLimiter = rateLimit({
  ...rlOpts,
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.RL_SHARE_FEEDBACK_READ || 300),
  message: { error: 'Too many requests. Please wait a few minutes and try again.' },
});
