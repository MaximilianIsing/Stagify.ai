// Express rate limiters, extracted verbatim from server.js. Pure config with no
// server-state deps — each limit reads its env override once at module load (after
// load-env.js has populated process.env) and the constructed limiter is handed to
// the routers that mount it: authLimiter/emailLimiter → auth + public routes,
// genLimiter → staging + chat routes.
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
