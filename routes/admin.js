// admin routes, extracted verbatim from server.js.
import express from 'express';
import { createAsyncRouter } from '../lib/http/async-router.js';
import { sendError } from '../lib/http/http-helpers.js';
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
 *   getDataLogDir: ReturnType<typeof import('../lib/services/logging.js').createLogging>['getDataLogDir'],
 *   getHostedImagesDir: Function,
 *   readHostedImagesManifest: Function,
 *   writeHostedImagesManifest: Function,
 *   protectLogs: import('express').RequestHandler,
 *   __dirname: string,
 *   HOSTED_IMAGE_MIME_EXT: Record<string, string>,
 * }} deps - Stores, the hosted-image upload middleware + log-access guard, data-dir
 *   and manifest helpers, memory/uptime admin actions, and the mime→ext map.
 */
export default function createAdminRouter(deps) {
  const { authStore, uptimeMonitor, enterpriseStore, hostImageUpload, DEBUG_MODE, setSensitiveHeaders, exportAllMemories, resetAllMemories, getDataLogDir, getHostedImagesDir, readHostedImagesManifest, writeHostedImagesManifest, protectLogs , __dirname, HOSTED_IMAGE_MIME_EXT } = deps;
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
      const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https')
        .split(',')[0]
        .trim();
      const url = proto + '://' + req.get('host') + '/i/' + id;
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

router.get('/authstore', protectLogs, (req, res) => {
  try {
    // Serve a LIVE snapshot rebuilt from SQLite in the legacy auth-store.json
    // shape. This keeps the admin backup download working after the move off
    // flat files, and the output is a valid rollback/re-import payload.
    const snapshot = authStore.exportStore();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="auth-store.json"');
    res.send(JSON.stringify(snapshot, null, 2));
  } catch (error) {
    logger.error('Error serving auth store snapshot:', error);
    sendError(res, 500, 'Failed to retrieve auth store', { details: error.message });
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
    logger.error('Error serving prompt log file:', error);
    sendError(res, 500, 'Failed to retrieve prompt logs', { details: error.message });
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
    logger.error('Error serving contact log file:', error);
    sendError(res, 500, 'Failed to retrieve contact logs', { details: error.message });
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
    logger.error('Error serving email open log file:', error);
    sendError(res, 500, 'Failed to retrieve email open logs', { details: error.message });
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
    logger.error('Error serving memories file:', error);
    sendError(res, 500, 'Failed to retrieve memories', { details: error.message });
  }
});

router.get('/resetmemories', protectLogs, (req, res) => {
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
    logger.error('Error resetting memories:', error);
    sendError(res, 500, 'Failed to reset memories', { details: error.message });
  }
});

// Wipe all recorded uptime/incident history (admin "reset server status" button).
router.post('/api/status/reset', protectLogs, (req, res) => {
  try {
    const snapshot = uptimeMonitor.reset();
    if (DEBUG_MODE) logger.debug('✓ Server status (uptime) history reset');
    res.status(200).json({ success: true, message: 'Server status history reset; monitoring restarted.', snapshot });
  } catch (error) {
    logger.error('Error resetting server status:', error);
    sendError(res, 500, error.message);
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
    logger.error('Error serving chat log file:', error);
    sendError(res, 500, 'Failed to retrieve chat logs', { details: error.message });
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
    logger.error('Error serving bug reports file:', error);
    sendError(res, 500, 'Failed to retrieve bug reports', { details: error.message });
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
    logger.error('Error serving mask logs file:', error);
    sendError(res, 500, 'Failed to retrieve mask logs', { details: error.message });
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

router.get('/enterprise-domains', protectLogs, (req, res) => {
  try {
    // Live snapshot rebuilt from SQLite in the legacy { domains: [...] } shape.
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="enterprise-domains.json"');
    res.send(JSON.stringify(enterpriseStore.exportStore(), null, 2));
  } catch (error) {
    logger.error('Error serving enterprise domains file:', error);
    sendError(res, 500, 'Failed to retrieve enterprise domains', { details: error.message });
  }
});

  return router;
}
