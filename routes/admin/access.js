// The admin console's access log: who opened this console, from where, and what
// was refused. Backed by lib/data/admin-access.js.
//
// WHY IT IS A SEPARATE ROUTER FROM routes/admin/index.js. That file sits at its 650-line
// lint cap; the repo's answer to a full file is a sibling, not a raised ceiling —
// the same reason routes/admin/renders.js, routes/admin/api-usage.js and
// routes/admin/blog.js exist, and it is mounted the same way.
//
// THIS FILE ALSO OWNS THE 'open' EVENT, and does it by falling through. The console
// already fires GET /api/admin/ping exactly once per page load, before it reveals
// the dashboard (public/scripts/admin/admin.js#restoreSession) — and deliberately does NOT
// fire it after a fresh sign-in, which the mint records instead. So the probe that
// already exists is precisely the "someone opened the dashboard" signal, and adding
// a second endpoint would have meant a second client call for an event we were
// already being told about.
//
// It is instrumented HERE rather than in routes/admin/index.js's handler because that file
// has three lines of headroom left. This router is mounted BEFORE the main admin
// router (server.js), so a GET /api/admin/ping matches this handler first; it records
// and calls next(), and Express carries the request on to the real handler in
// routes/admin/index.js, which answers it exactly as before. The only cost is that
// protectLogs runs twice — two hashed-token reads against SQLite, which is cheaper
// than the write it is guarding.

import { createAsyncRouter } from '../../lib/http/async-router.js';
import { sendError, getStagingClientIp } from '../../lib/http/http-helpers.js';
import { reportError } from '../../lib/http/error-ref.js';

/** Event-feed bounds the console may ask for. The rollup always covers everything. */
const MIN_LIMIT = 50;
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 200;

/**
 * Build the admin access-log router.
 *
 * @param {{
 *   adminAccess: ReturnType<typeof import('../../lib/data/admin-access.js').createAdminAccess> | null,
 *   protectLogs: import('express').RequestHandler,
 * }} deps - `adminAccess` is OPTIONAL: absent, the log answers `configured: false`
 *   with empty rows rather than 503, so the tab says the recorder is off instead of
 *   showing an error. Same contract as GET /api/admin/blog-views.
 * @returns {import('express').Router}
 */
export function createAdminAccessRouter(deps) {
  const { adminAccess, protectLogs } = deps;
  const router = createAsyncRouter();

  // Pass-through recorder for the page-load probe — see the header. Always calls
  // next(), including when the store is missing or the write fails: this must never
  // be able to turn the console's own sign-in probe into an error.
  router.get('/api/admin/ping', protectLogs, (req, res, next) => {
    try {
      if (adminAccess) {
        adminAccess.record({
          ip: getStagingClientIp(req),
          outcome: 'open',
          // The PAGE that was opened, not the API path that told us so. The operator
          // reading this row cares that someone opened the dashboard.
          path: '/admin',
          userAgent: req.get('user-agent'),
        });
      }
    } catch {
      // Swallowed on purpose, and not because a throw is expected — the store's
      // record() handles its own errors. This sits in front of the console's OWN
      // sign-in probe, so any failure here that reached the async router would be
      // a 500 on /api/admin/ping, which locks every operator out at the login
      // screen. Losing one telemetry row is strictly the cheaper failure.
    }
    return next();
  });

  router.get('/api/admin/access-log', protectLogs, (req, res) => {
    // Clamped, never rejected — an out-of-range `limit` is an operator typo in a
    // URL, and the useful answer is the default window, not a 400. Same treatment
    // as GET /api/admin/blog-views.
    const asked = Number(req.query.limit);
    const limit = Number.isFinite(asked)
      ? Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.round(asked)))
      : DEFAULT_LIMIT;

    try {
      if (!adminAccess || typeof adminAccess.summary !== 'function') {
        return res.json({
          configured: false,
          generatedAt: Date.now(),
          limit,
          rows: [],
          summary: {
            totalEvents: 0, opens: 0, signins: 0, denied: 0,
            distinctIps: 0, deniedIps: 0, visitors: [],
          },
        });
      }

      const payload = adminAccess.summary({ limit });
      res.json({ configured: adminAccess.enabled !== false, ...payload });

      // AFTER the response, never before: resolving a location is a third-party
      // network call, and no operator should wait on ipwho.is to see their own
      // access log. Fire-and-forget, and it cannot reject (see the store).
      // .catch for the same reason as the try above: the store swallows its own
      // errors, but an unhandled rejection here would crash the process over a
      // city name. The response has already been sent; nothing can be done with it.
      Promise.resolve(adminAccess.resolvePendingGeo()).catch(() => {});
      return undefined;
    } catch (error) {
      return sendError(res, 500, 'Failed to retrieve the access log', {
        ref: reportError('admin.accessLog', error),
      });
    }
  });

  return router;
}

export default createAdminAccessRouter;
