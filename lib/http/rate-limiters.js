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
