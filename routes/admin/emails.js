// The admin console's Emails tab: the preview gallery of every user-facing email, and
// a live "send test to me". Mounted with the rest of the console in routes/admin/mount.js.

import express from 'express';
import { createAsyncRouter } from '../../lib/http/async-router.js';
import { sendError } from '../../lib/http/http-helpers.js';
import { logger } from '../../lib/logger.js';

/**
 * Build the admin Emails router.
 *
 * @param {{
 *   emailCatalog: ReturnType<typeof import('../../lib/services/email-catalog.js').createEmailCatalog>,
 *   sendTestEmail: ReturnType<typeof import('../../lib/services/email-catalog.js').createTestEmailSender>,
 *   protectLogs: import('express').RequestHandler,
 * }} deps
 * @returns {import('express').Router}
 */
export function createAdminEmailsRouter(deps) {
  const { emailCatalog, sendTestEmail, protectLogs } = deps;
  const router = createAsyncRouter();

  // Emails tab: the preview gallery. Returns every user-facing email (subject + HTML +
  // text) built from the same renderers the senders use, so a preview matches what
  // actually ships. Read-only; nothing is sent here.
  router.get('/api/admin/email-previews', protectLogs, (req, res) => {
    if (!emailCatalog || typeof emailCatalog.list !== 'function') {
      return sendError(res, 500, 'Email catalog not configured');
    }
    return res.json({ emails: emailCatalog.list() });
  });

  // Emails tab: send one catalog email as a live test to an admin-supplied address.
  // protectLogs runs BEFORE the body parser so an unauthenticated request is rejected
  // without parsing its body.
  router.post('/api/admin/email-test-send', protectLogs, express.json(), async (req, res) => {
    const { id, email } = req.body || {};
    if (!id || !email) {
      return sendError(res, 400, 'An email template id and a recipient email are required');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
      return sendError(res, 400, 'Enter a valid email address');
    }
    if (typeof sendTestEmail !== 'function') {
      return sendError(res, 500, 'Test send is not configured');
    }
    const out = await sendTestEmail({ id: String(id), toEmail: String(email).trim() });
    if (!out.ok) {
      return sendError(res, out.status || 500, out.error || 'Could not send the test email');
    }
    // Log the template but NOT the recipient address (PII).
    logger.info('[admin] test email sent:', String(id));
    return res.json({ ok: true });
  });

  return router;
}
