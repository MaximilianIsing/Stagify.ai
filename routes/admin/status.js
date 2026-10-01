// The admin console's Status tab: the operator's view of /status, plus the manual
// incident log and the history reset. Mounted with the rest of the console in
// routes/admin/mount.js.

import express from 'express';
import { createAsyncRouter } from '../../lib/http/async-router.js';
import { sendError } from '../../lib/http/http-helpers.js';
import { reportError } from '../../lib/http/error-ref.js';
import { logger } from '../../lib/logger.js';
import { statusPayload } from '../../lib/health/service-health.js';

/**
 * Build the admin status router.
 *
 * @param {{
 *   uptimeMonitor: any,
 *   serviceHealth?: ReturnType<typeof import('../../lib/health/service-health.js').createServiceHealth> | null,
 *   DEBUG_MODE: boolean,
 *   protectLogs: import('express').RequestHandler,
 * }} deps - `serviceHealth` is OPTIONAL: absent, the status payload is exactly the
 *   uptime view it was before per-subsystem checks existed.
 * @returns {import('express').Router}
 */
export function createAdminStatusRouter(deps) {
  const { uptimeMonitor, serviceHealth, DEBUG_MODE, protectLogs } = deps;
  const router = createAsyncRouter();

  // The public /api/status payload is fetched by every visitor to /status on a timer,
  // so the extra depth the console wants — the 30-day graph, the manual entries as
  // their own list, the monitor's configuration — hangs off a separate admin route
  // rather than being added to it.

  // includeDetail, unlike the public route: the operator is the one person who needs the
  // R2 error body, the SQLite message and the probe latencies to act on a red pill.
  router.get('/api/admin/status', protectLogs, (req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.json(statusPayload(uptimeMonitor.getAdminSnapshot(), serviceHealth, { includeDetail: true }));
  });

  // Post an incident by hand. The heartbeat can only see the process dying, so this is
  // the only way an outage the server SURVIVED — a dead upstream, a bad deploy, an
  // expired key — reaches the status page at all. `affectsUptime` decides whether it
  // also moves the percentages, which is why an informational notice and a real outage
  // can both live here.
  router.post('/api/admin/incidents', protectLogs, express.json(), (req, res) => {
    const result = uptimeMonitor.addIncident(req.body || {});
    // The message is written for the operator reading the form, so it goes back
    // verbatim — it is the only thing telling them what to type instead.
    if (!result.ok) return sendError(res, 400, result.error);
    logger.info('[status] incident posted: ' + result.incident.title);
    return res.status(201).json({ ok: true, incident: result.incident });
  });

  router.post('/api/admin/incidents/:id/resolve', protectLogs, (req, res) => {
    const result = uptimeMonitor.resolveIncident(String(req.params.id || ''));
    if (!result.ok) return sendError(res, 404, result.error);
    return res.json({ ok: true, incident: result.incident });
  });

  router.delete('/api/admin/incidents/:id', protectLogs, (req, res) => {
    const result = uptimeMonitor.deleteIncident(String(req.params.id || ''));
    if (!result.ok) return sendError(res, 404, result.error);
    return res.json({ ok: true });
  });

  // Wipe all recorded uptime/incident history (admin "reset server status" button).
  router.post('/api/status/reset', protectLogs, (req, res) => {
    try {
      const snapshot = uptimeMonitor.reset();
      if (DEBUG_MODE) logger.debug('✓ Server status (uptime) history reset');
      res.status(200).json({ success: true, message: 'Server status history reset; monitoring restarted.', snapshot });
    } catch (error) {
      sendError(res, 500, 'Failed to reset server status', { ref: reportError('admin.status-reset', error) });
    }
  });

  return router;
}
