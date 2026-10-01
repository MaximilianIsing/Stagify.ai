// The admin console's Signals tab: SQL-only aggregates and the written brief.
// Mounted with the rest of the console in routes/admin/mount.js.

import express from 'express';
import { createAsyncRouter } from '../../lib/http/async-router.js';
import { sendError } from '../../lib/http/http-helpers.js';
import { reportError } from '../../lib/http/error-ref.js';

/**
 * Build the admin Signals router.
 *
 * @param {{
 *   adminMetrics?: ReturnType<typeof import('../../lib/analytics/admin-metrics.js').createAdminMetrics>,
 *   adminBrief?: ReturnType<typeof import('../../lib/services/admin-brief.js').createAdminBrief>,
 *   protectLogs: import('express').RequestHandler,
 * }} deps - Both readers are OPTIONAL: absent, their routes answer a null payload
 *   rather than 503, so the tab degrades to its deterministic half instead of erroring.
 * @returns {import('express').Router}
 */
export function createAdminSignalsRouter(deps) {
  const { adminMetrics, adminBrief, protectLogs } = deps;
  const router = createAsyncRouter();

  // The dashboard has deliberately had no backend — it downloads the CSV/JSON
  // exports and aggregates in the browser. These two are the exceptions, and each
  // earns it for a different reason:
  //
  //   - /metrics ships numbers that exist ONLY in SQL. Chiefly `staged_renders`,
  //     whose `user_id` comes from the validated session, unlike the render log's
  //     email (which is `unknown` whenever the client didn't send one). That is
  //     what turns the funnel's documented "floor, not a count" into a count.
  //   - /brief needs the OpenAI key, which obviously cannot go to the browser.
  //
  // Both fail OPEN. A missing dependency answers 200 with a null payload rather
  // than an error, because the Signals tab's findings are computed client-side and
  // must still render when these do not.

  // Read-only aggregates over the shared SQLite database. Every statement is a
  // GROUP BY prepared once at factory time — see the N+1 guard in
  // test/analytics/admin-metrics.test.js before adding a query here.
  router.get('/api/admin/metrics', protectLogs, (req, res) => {
    if (!adminMetrics || typeof adminMetrics.snapshot !== 'function') {
      return res.json({ metrics: null, reason: 'unavailable' });
    }
    try {
      return res.json({ metrics: adminMetrics.snapshot({}) });
    } catch (error) {
      return sendError(res, 500, 'Failed to read metrics', { ref: reportError('admin.metrics', error) });
    }
  });

  // The written brief. The body is the FINISHED findings the browser already
  // computed — titles, severities and numeric evidence — never raw log rows, and
  // never an email or an IP. The model restates; it does not compute. See
  // lib/services/admin-brief.js for the prompt contract and the redaction it
  // applies on the way in.
  //
  // protectLogs runs BEFORE express.json() so an unauthenticated request is
  // rejected without its body being parsed.
  router.post('/api/admin/brief', protectLogs, express.json({ limit: '256kb' }), async (req, res) => {
    if (!adminBrief || typeof adminBrief.generateBrief !== 'function') {
      return res.json({ summary: null, reason: 'unavailable' });
    }
    const findings = req.body && req.body.findings;
    if (!Array.isArray(findings)) {
      return sendError(res, 400, 'A findings array is required');
    }
    // generateBrief never throws — it reports its own failure as a reason, so a
    // model outage reads as "no brief" rather than a 500 on the whole tab.
    const result = await adminBrief.generateBrief(findings);
    return res.json(result);
  });

  return router;
}
