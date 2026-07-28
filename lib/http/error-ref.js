// Error references — how a 5xx tells the caller "something broke" without telling
// them what.
//
// The pattern this replaces was `sendError(res, 500, 'X failed', { details: error.message })`
// at ~19 sites. That hands an arbitrary exception string to whoever made the request:
// `sharp` reports image internals, the Gemini/OpenAI SDKs echo model and quota state,
// `better-sqlite3` names tables and columns, `fs` prints absolute server paths, and
// Stripe returns its own prose. None of it is actionable for the caller — the AI
// Designer's SSE error handler does not even read the field, it renders a fixed
// localized apology — so it was pure downside.
//
// Instead: log the real error (with its stack, where the operator can see it) under a
// short random reference, and return only that reference. A user pasting "ref 3f9a1c02"
// into a bug report is enough to find the exact log line, which is strictly more than
// `details` ever gave support — a message with no request context could not be located
// in the logs at all.
//
// The reference is random, not derived from the error: it identifies one occurrence,
// leaks nothing about the failure, and cannot be probed for.

import crypto from 'crypto';
import { logger } from '../logger.js';

/**
 * Log a caught error under a fresh reference and return that reference for the
 * response body. Replaces the site's own `logger.error(...)` call — this logs, so
 * logging again beside it just duplicates the line.
 *
 * @param {string} context - Where it happened, for the operator (`'admin.promptlogs'`,
 *   `'chat'`, …). Appears in the log line, never in the response.
 * @param {unknown} err - The caught error. Logged whole, so the stack survives.
 * @returns {string} An 8-char hex reference, safe to hand to the client.
 */
export function reportError(context, err) {
  const ref = crypto.randomBytes(4).toString('hex');
  logger.error(`[${context}] failed (ref ${ref}):`, err);
  return ref;
}
