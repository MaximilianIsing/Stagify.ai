// The admin console's API-usage endpoint: one site-wide read of the public render
// API's traffic, its customers, and its prepaid credit economics.
//
// WHY IT IS A SEPARATE ROUTER FROM routes/admin.js. That file sits at its 650-line
// lint cap. The repo's answer to a full file is a sibling, not a raised ceiling — the
// same reason routes/admin-renders.js exists, and it is mounted the same way.
//
// WHAT IT DOES NOT RETURN. No key ids, no key prefixes, no idempotency keys and no
// request fingerprints. A key prefix is the half of a credential a support ticket
// quotes, and none of it is needed to answer "how busy is the API and who is using
// it"; the account email and its counts are. The aggregate never touches the
// `api_requests` rows individually, so there is no row here to leak field by field.

import { createAsyncRouter } from '../lib/http/async-router.js';
import { sendError } from '../lib/http/http-helpers.js';
import { reportError } from '../lib/http/error-ref.js';

/** Window bounds the console may ask for. The reader clamps too; this is the HTTP edge. */
const MIN_DAYS = 1;
const MAX_DAYS = 90;
const DEFAULT_DAYS = 30;

/**
 * Build the admin API-usage router.
 *
 * @param {{
 *   apiUsageStats: { summary: (opts?: { days?: number }) => object } | null,
 *   protectLogs: import('express').RequestHandler,
 *   setSensitiveHeaders: (res: import('express').Response) => void,
 * }} deps
 * @returns {import('express').Router} The mounted router.
 */
export function createAdminApiUsageRouter(deps) {
  const { apiUsageStats, protectLogs, setSensitiveHeaders } = deps;
  const router = createAsyncRouter();

  router.get('/api/admin/api-usage', protectLogs, (req, res) => {
    // Customer emails and spend. Not a credential, but not something to leave in a
    // shared cache either — the same treatment the render inspector's body gets.
    setSensitiveHeaders(res);
    res.set('Cache-Control', 'no-store');

    // Degrade, don't 503. A deployment whose database predates the API tables should
    // show a panel saying so rather than an error the operator has to interpret —
    // the same contract GET /api/admin/metrics offers for its own dependency.
    if (!apiUsageStats || typeof apiUsageStats.summary !== 'function') {
      return res.json({ usage: null, reason: 'unavailable' });
    }

    // Clamped, never rejected: a bad `days` is an operator typo in a URL, and the
    // useful response is the default window, not a 400. Same treatment as
    // GET /api/admin/referrals.
    const asked = Number(req.query.days);
    const days = Number.isFinite(asked)
      ? Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.round(asked)))
      : DEFAULT_DAYS;

    try {
      return res.json({ usage: apiUsageStats.summary({ days }) });
    } catch (error) {
      return sendError(res, 500, 'Failed to read API usage', {
        ref: reportError('admin.apiUsage', error),
      });
    }
  });

  return router;
}
