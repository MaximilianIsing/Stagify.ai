// admin routes, extracted verbatim from server.js.
import express from 'express';
import { createAsyncRouter } from '../lib/http/async-router.js';
import { sendError, resolveAppOrigin } from '../lib/http/http-helpers.js';
import { reportError } from '../lib/http/error-ref.js';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { logger } from '../lib/logger.js';

/**
 * Build the admin router (dashboard, hosted-image upload/list/delete, CSV log
 * downloads, memory + uptime resets). `deps` is the injection bag from server.js.
 *
 * @param {{
 *   authStore: any,
 *   uptimeMonitor: any,
 *   enterpriseStore: any,
 *   hostImageUpload: import('express').RequestHandler,
 *   DEBUG_MODE: boolean,
 *   setSensitiveHeaders: (res: import('express').Response) => void,
 *   exportAllMemories: Function,
 *   resetAllMemories: Function,
 *   deleteUser: ReturnType<typeof import('../lib/data/user-deletion.js').createUserDeletion>['deleteUser'],
 *   getDataLogDir: ReturnType<typeof import('../lib/services/logging.js').createLogging>['getDataLogDir'],
 *   getHostedImagesDir: Function,
 *   readHostedImagesManifest: Function,
 *   writeHostedImagesManifest: Function,
 *   protectLogs: import('express').RequestHandler,
 *   __dirname: string,
 *   HOSTED_IMAGE_MIME_EXT: Record<string, string>,
 *   emailCatalog: ReturnType<typeof import('../lib/services/email-catalog.js').createEmailCatalog>,
 *   sendTestEmail: (arg: { id: string, toEmail: string }) => Promise<{ ok: boolean, status?: number, error?: string }>,
 *   referralLinks?: ReturnType<typeof import('../lib/data/referral-links.js').createReferralLinks>,
 * }} deps - Stores, the hosted-image upload middleware + log-access guard, data-dir
 *   and manifest helpers, memory/uptime admin actions, the mime→ext map, the
 *   user-facing email catalog + test-send helper for the Emails tab, and the
 *   campaign-link hit store behind the Referrals tab.
 */
export default function createAdminRouter(deps) {
  const { authStore, uptimeMonitor, enterpriseStore, hostImageUpload, DEBUG_MODE, setSensitiveHeaders, exportAllMemories, resetAllMemories, deleteUser, getDataLogDir, getHostedImagesDir, readHostedImagesManifest, writeHostedImagesManifest, protectLogs , __dirname, HOSTED_IMAGE_MIME_EXT, emailCatalog, sendTestEmail, referralLinks } = deps;
  const router = createAsyncRouter();

router.get('/admin', (req, res) => {
  setSensitiveHeaders(res);
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

router.post('/api/host-image', protectLogs, (req, res) => {
  hostImageUpload(req, res, (err) => {
    if (err) {
      return sendError(res, 400, err.message || 'Upload failed');
    }
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return sendError(res, 400, 'No image file provided');
    }
    try {
      const ext = HOSTED_IMAGE_MIME_EXT[req.file.mimetype] || 'bin';
      const id = crypto.randomBytes(16).toString('hex'); // 32 hex chars, unguessable
      const file = id + '.' + ext;
      fs.writeFileSync(path.join(getHostedImagesDir(), file), req.file.buffer);
      const entry = {
        id,
        file,
        mime: req.file.mimetype,
        ext,
        originalName: req.file.originalname || file,
        size: req.file.size || req.file.buffer.length,
        uploadedAt: new Date().toISOString(),
      };
      const manifest = readHostedImagesManifest();
      manifest.push(entry);
      writeHostedImagesManifest(manifest);
      // Was hand-parsing x-forwarded-proto. `trust proxy` (server.js:132) already
      // resolves that into req.protocol, and doing it by hand is the same mistake
      // getStagingClientIp warns about for X-Forwarded-For.
      const url = resolveAppOrigin(req) + '/i/' + id;
      logger.info('[host-image] hosted', file, '(' + entry.size + ' bytes)');
      return res.json({ ok: true, id, path: '/i/' + id, url, entry });
    } catch (e) {
      logger.error('[host-image] save failed', e);
      return sendError(res, 500, 'Failed to save image');
    }
  });
});

router.get('/api/hosted-images', protectLogs, (req, res) => {
  const images = readHostedImagesManifest()
    .slice()
    .sort((a, b) => new Date(b.uploadedAt || 0).getTime() - new Date(a.uploadedAt || 0).getTime())
    .map((e) => Object.assign({}, e, { path: '/i/' + e.id }));
  return res.json({ images });
});

router.delete('/api/hosted-images/:id', protectLogs, (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[a-f0-9]{16,64}$/.test(id)) {
    return sendError(res, 400, 'Invalid id');
  }
  const manifest = readHostedImagesManifest();
  const idx = manifest.findIndex((e) => e && e.id === id);
  if (idx === -1) {
    return sendError(res, 404, 'Not found');
  }
  const [entry] = manifest.splice(idx, 1);
  try {
    const filePath = path.join(getHostedImagesDir(), entry.file);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    logger.error('[host-image] file delete failed', e);
  }
  writeHostedImagesManifest(manifest);
  logger.info('[host-image] unhosted', entry.file);
  return res.json({ ok: true });
});

// Cheap key check for the admin sign-in screen. It exists so the login probe does
// NOT have to fetch a data endpoint just to learn whether the key is valid — the
// old flow probed /authstore, pulling the whole user table on every sign-in.
router.get('/api/admin/ping', protectLogs, (req, res) => {
  return res.json({ ok: true });
});

router.get('/authstore', protectLogs, (req, res) => {
  try {
    // REDACTED by design. This served exportStore() — password hashes, live
    // session tokens, and password-reset tokens — behind nothing but the static
    // process-wide endpoint key, so a single leak of that key was full account
    // takeover for every user. The dashboard never read any of those fields.
    // Backup/rollback is the SQLite file itself (Litestream → R2), not this route.
    const snapshot = authStore.exportRedacted();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="auth-store.json"');
    res.send(JSON.stringify(snapshot, null, 2));
  } catch (error) {
    sendError(res, 500, 'Failed to retrieve auth store', { ref: reportError('admin.authstore', error) });
  }
});

router.get('/promptlogs', protectLogs, (req, res) => {
  try {
    const logFile = path.join(getDataLogDir(), 'prompt_logs.csv');

    if (fs.existsSync(logFile)) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'inline; filename="prompt_logs.csv"');
      res.sendFile(logFile);
    } else {
      sendError(res, 404, 'Log file not found', { details: 'No prompt logs are available yet' });
    }
  } catch (error) {
    sendError(res, 500, 'Failed to retrieve prompt logs', { ref: reportError('admin.promptlogs', error) });
  }
});

router.get('/contactlogs', protectLogs, (req, res) => {
  try {
    const logFile = path.join(getDataLogDir(), 'contact_logs.csv');

    if (fs.existsSync(logFile)) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'inline; filename="contact_logs.csv"');
      res.sendFile(logFile);
    } else {
      sendError(res, 404, 'Log file not found', { details: 'No contact logs are available yet' });
    }
  } catch (error) {
    sendError(res, 500, 'Failed to retrieve contact logs', { ref: reportError('admin.contactlogs', error) });
  }
});

router.get('/email-open-logs', protectLogs, (req, res) => {
  try {
    const logFile = path.join(getDataLogDir(), 'email_open_logs.csv');

    if (fs.existsSync(logFile)) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'inline; filename="email_open_logs.csv"');
      res.sendFile(logFile);
    } else {
      sendError(res, 404, 'Log file not found', { details: 'No email open logs are available yet' });
    }
  } catch (error) {
    sendError(res, 500, 'Failed to retrieve email open logs', { ref: reportError('admin.email-open-logs', error) });
  }
});

router.get('/memories', protectLogs, (req, res) => {
  try {
    // Live snapshot rebuilt from SQLite in the legacy { userId: [...] } shape.
    const memories = exportAllMemories();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="memories.json"');
    res.send(JSON.stringify(memories, null, 2));
  } catch (error) {
    sendError(res, 500, 'Failed to retrieve memories', { ref: reportError('admin.memories', error) });
  }
});

// POST, not GET: this wipes every user's memories, and a GET that mutates is one
// retry away from doing it twice. `protectLogs` is header-only, so a crawler or link
// prefetch could never have reached it — but anything that legitimately replays an
// idempotent GET (an HTTP client's retry-on-reset, a devtools "replay request", a
// future proxy) would. Matches the sibling wipe, POST /api/status/reset.
router.post('/resetmemories', protectLogs, (req, res) => {
  try {
    resetAllMemories();

    if (DEBUG_MODE) {
      logger.debug('✓ Successfully reset all memories');
    }

    res.status(200).json({
      success: true,
      message: 'All memories have been reset successfully'
    });
  } catch (error) {
    sendError(res, 500, 'Failed to reset memories', { ref: reportError('admin.resetmemories', error) });
  }
});

// The old GET verb, kept as an explicit 405 so an operator running a stale command
// gets told what changed instead of a bare 404 — and so a GET here stays SAFE
// (no reset) rather than falling through to some other handler. Still behind
// protectLogs: an unkeyed caller sees the same 403 as before, learning nothing.
router.get('/resetmemories', protectLogs, (req, res) => {
  res.set('Allow', 'POST');
  sendError(res, 405, 'Method Not Allowed', {
    details: 'Resetting memories is a POST — it mutates state. Retry with -X POST.',
  });
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

router.get('/chatlogs', protectLogs, (req, res) => {
  try {
    const logFile = path.join(getDataLogDir(), 'chat_logs.csv');

    if (fs.existsSync(logFile)) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'inline; filename="chat_logs.csv"');
      res.sendFile(logFile);
    } else {
      sendError(res, 404, 'Log file not found', { details: 'No chat logs are available yet' });
    }
  } catch (error) {
    sendError(res, 500, 'Failed to retrieve chat logs', { ref: reportError('admin.chatlogs', error) });
  }
});

router.get('/bugreports', protectLogs, (req, res) => {
  try {
    const logFile = path.join(getDataLogDir(), 'bug_reports.csv');

    if (fs.existsSync(logFile)) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'inline; filename="bug_reports.csv"');
      res.sendFile(logFile);
    } else {
      sendError(res, 404, 'Log file not found', { details: 'No bug reports are available yet' });
    }
  } catch (error) {
    sendError(res, 500, 'Failed to retrieve bug reports', { ref: reportError('admin.bugreports', error) });
  }
});

router.get('/masklogs', protectLogs, (req, res) => {
  try {
    const logFile = path.join(getDataLogDir(), 'mask_logs.csv');

    if (fs.existsSync(logFile)) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'inline; filename="mask_logs.csv"');
      res.sendFile(logFile);
    } else {
      sendError(res, 404, 'Log file not found', { details: 'No mask logs are available yet' });
    }
  } catch (error) {
    sendError(res, 500, 'Failed to retrieve mask logs', { ref: reportError('admin.masklogs', error) });
  }
});

// Requests turned away BEFORE any render — refused uploads, free accounts at their
// daily cap, rate-limited callers. Its own file, not rows in prompt_logs.csv, because
// the dashboard counts every prompt-log row as a generation.
router.get('/rejectionlogs', protectLogs, (req, res) => {
  try {
    const logFile = path.join(getDataLogDir(), 'rejection_logs.csv');

    if (fs.existsSync(logFile)) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'inline; filename="rejection_logs.csv"');
      res.sendFile(logFile);
    } else {
      sendError(res, 404, 'Log file not found', { details: 'No rejection logs are available yet' });
    }
  } catch (error) {
    sendError(res, 500, 'Failed to retrieve rejection logs', { ref: reportError('admin.rejectionlogs', error) });
  }
});

// Comp Stagify+: hand a currently-free account one month of pro with no Stripe
// subscription behind it (see lib/data/pro-grants.js). protectLogs runs BEFORE the
// body parser so an unauthenticated request is rejected without parsing its body.
router.post('/api/admin/grant-plus', protectLogs, express.json(), (req, res) => {
  const { email, userId } = req.body || {};
  if (!email && !userId) {
    return sendError(res, 400, 'An email or userId is required');
  }
  const result = authStore.grantProMonth({ userId, email });
  if (!result.ok) {
    return sendError(res, 400, result.error || 'Could not grant Stagify+');
  }
  logger.info('[admin] granted 1 month of Stagify+ to', result.userId, '— expires', result.expiresAt);
  return res.json({ ok: true, userId: result.userId, email: result.email, expiresAt: result.expiresAt });
});

// GDPR erasure. Wipes the account row AND everything keyed to it (sessions, reset
// tokens, memories, a pending registration for the same address) in one transaction,
// then redacts the identifying cells of that person's rows in the CSV logs. There
// are no foreign keys in this database, so nothing cascades on its own — the table
// list lives in lib/data/user-deletion.js and is drift-tested.
//
// Irreversible, so it is POST-only, key-gated, and refuses an account that still has
// a Stripe subscription unless `force` is passed.
router.post('/api/admin/delete-user', protectLogs, express.json(), (req, res) => {
  const { userId, email, force } = req.body || {};
  if (!userId && !email) {
    return sendError(res, 400, 'An email or userId is required');
  }
  const result = deleteUser({ userId, email, force: force === true });
  if (!result.ok) {
    return sendError(res, result.code === 'NOT_FOUND' ? 404 : 400, result.error || 'Could not delete the user', {
      code: result.code,
    });
  }
  return res.json({ ok: true, userId: result.userId, email: result.email, rows: result.rows, logs: result.logs });
});

// End a running comp grant early. Paying subscribers are refused — they have to be
// cancelled in Stripe, not here.
router.post('/api/admin/revoke-plus', protectLogs, express.json(), (req, res) => {
  const { userId } = req.body || {};
  if (!userId) {
    return sendError(res, 400, 'A userId is required');
  }
  const result = authStore.revokeProGrant(String(userId));
  if (!result.ok) {
    return sendError(res, 400, result.error || 'Could not revoke the grant');
  }
  logger.info('[admin] revoked the Stagify+ grant for', result.userId);
  return res.json({ ok: true, userId: result.userId, email: result.email });
});

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

// ── Referrals tab: campaign short-URLs (/columbia, …) ──────────────────────
// Links are operator-created data, so this is full CRUD rather than a read-only
// rollup. Retiring a link DEACTIVATES it (the URL stops resolving, the history
// stays); DELETE is the separate, explicit wipe.

/** Guard shared by every referral endpoint: a missing store is a 500, not an empty list. */
function referralStoreOr500(res) {
  if (!referralLinks || typeof referralLinks.summary !== 'function') {
    sendError(res, 500, 'Referral tracking is not configured');
    return null;
  }
  return referralLinks;
}

router.get('/api/admin/referrals', protectLogs, (req, res) => {
  const store = referralStoreOr500(res);
  if (!store) return undefined;
  const requested = Number(req.query.days);
  // Clamped, not validated-and-rejected: `days` only sizes a chart, and the query
  // reads every row in the window, so an unbounded value is a scan the caller picks.
  const days = Number.isFinite(requested) ? Math.min(365, Math.max(7, Math.round(requested))) : 30;
  try {
    return res.json({ days, links: store.summary({ days }) });
  } catch (error) {
    return sendError(res, 500, 'Failed to retrieve referral stats', {
      ref: reportError('admin.referrals', error),
    });
  }
});

// Create a link. The store owns validation (slug shape, reserved names, duplicates)
// and returns a `code` per rejection so the dashboard can say what is wrong; 409 for
// a name already in use, 400 for anything malformed.
router.post('/api/admin/referrals', protectLogs, express.json(), (req, res) => {
  const store = referralStoreOr500(res);
  if (!store) return undefined;
  const { slug, label, note } = req.body || {};
  const result = store.createLink({ slug, label, note });
  if (!result.ok) {
    const conflict = result.code === 'SLUG_TAKEN' || result.code === 'SLUG_RESERVED';
    return sendError(res, conflict ? 409 : 400, result.error || 'Could not create the link', { code: result.code });
  }
  logger.info('[admin] created referral link /' + result.link.slug);
  return res.json({ ok: true, link: result.link });
});

// Retire / restore. POST because both mutate; separate paths so a retire can never
// be misread as a delete.
router.post('/api/admin/referrals/:slug/deactivate', protectLogs, (req, res) => {
  const store = referralStoreOr500(res);
  if (!store) return undefined;
  const result = store.deactivateLink(req.params.slug);
  if (!result.ok) return sendError(res, 404, result.error || 'Not found', { code: result.code });
  logger.info('[admin] retired referral link /' + result.link.slug);
  return res.json({ ok: true, link: result.link });
});

router.post('/api/admin/referrals/:slug/activate', protectLogs, (req, res) => {
  const store = referralStoreOr500(res);
  if (!store) return undefined;
  const result = store.activateLink(req.params.slug);
  if (!result.ok) return sendError(res, 404, result.error || 'Not found', { code: result.code });
  logger.info('[admin] restored referral link /' + result.link.slug);
  return res.json({ ok: true, link: result.link });
});

// The irreversible one: drops the link AND every click it ever recorded.
router.delete('/api/admin/referrals/:slug', protectLogs, (req, res) => {
  const store = referralStoreOr500(res);
  if (!store) return undefined;
  const result = store.deleteLink(req.params.slug);
  if (!result.ok) return sendError(res, 404, result.error || 'Not found', { code: result.code });
  logger.info('[admin] deleted referral link /' + result.slug + ' and its ' + result.hitsDeleted + ' recorded hits');
  return res.json({ ok: true, slug: result.slug, hitsDeleted: result.hitsDeleted });
});

router.get('/enterprise-domains', protectLogs, (req, res) => {
  try {
    // Live snapshot rebuilt from SQLite in the legacy { domains: [...] } shape.
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="enterprise-domains.json"');
    res.send(JSON.stringify(enterpriseStore.exportStore(), null, 2));
  } catch (error) {
    sendError(res, 500, 'Failed to retrieve enterprise domains', { ref: reportError('admin.enterprise-domains', error) });
  }
});

  return router;
}
