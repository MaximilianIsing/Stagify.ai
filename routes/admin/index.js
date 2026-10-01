// The admin console's core router: the console page itself, sign-in (ping + sessions),
// the raw data exports and CSV logs the dashboard aggregates in the browser, and the
// per-account actions (grant/revoke Stagify+, sign out everywhere, GDPR erasure).
// Each other tab has its own sibling router in this folder; routes/admin/mount.js
// mounts the whole family.
import express from 'express';
import { createAsyncRouter } from '../../lib/http/async-router.js';
import { sendError, getStagingClientIp } from '../../lib/http/http-helpers.js';
import { ADMIN_SESSION_HEADER } from '../../lib/http/http-guards.js';
import { reportError } from '../../lib/http/error-ref.js';
import path from 'path';
import fs from 'fs';
import { logger } from '../../lib/logger.js';

/**
 * Build the core admin router. `deps` is the injection bag from routes/admin/mount.js.
 *
 * @param {{
 *   authStore: any,
 *   enterpriseStore: any,
 *   DEBUG_MODE: boolean,
 *   setSensitiveHeaders: (res: import('express').Response) => void,
 *   exportAllMemories: Function,
 *   resetAllMemories: Function,
 *   deleteUser: ReturnType<typeof import('../../lib/data/user-deletion.js').createUserDeletion>['deleteUser'],
 *   getDataLogDir: ReturnType<typeof import('../../lib/services/logging.js').createLogging>['getDataLogDir'],
 *   protectLogs: import('express').RequestHandler,
 *   requireEndpointKey: import('express').RequestHandler,
 *   adminSessions?: ReturnType<typeof import('../../lib/data/admin-sessions.js').createAdminSessions>,
 *   __dirname: string,
 *   adminAccess?: ReturnType<typeof import('../../lib/data/admin-access.js').createAdminAccess> | null,
 * }} deps - `adminSessions` absent answers 503 on the session endpoints; `adminAccess`
 *   absent means a sign-in simply is not recorded.
 */
export default function createAdminRouter(deps) {
  const { authStore, enterpriseStore, DEBUG_MODE, setSensitiveHeaders, exportAllMemories, resetAllMemories, deleteUser, getDataLogDir, protectLogs, requireEndpointKey, adminSessions, __dirname, adminAccess } = deps;
  const router = createAsyncRouter();

router.get('/admin', (req, res) => {
  setSensitiveHeaders(res);
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Cheap credential check for the admin sign-in screen. It exists so the login probe
// does NOT have to fetch a data endpoint just to learn whether the key is valid —
// the old flow probed /authstore, pulling the whole user table on every sign-in.
// It is also what the console calls on load to see whether a stored session token
// is still good, so it must accept either credential.
router.get('/api/admin/ping', protectLogs, (req, res) => {
  return res.json({ ok: true });
});

// ── Admin console sessions ────────────────────────────────────────────────
//
// Trade the master key for a scoped, expiring, revocable token so the operator
// types the key once rather than on every page load. See
// lib/data/admin-sessions.js for why the key itself is never persisted.

// requireEndpointKey, NOT protectLogs: minting must cost the KEY. Behind
// protectLogs a stolen token could mint an endless supply of fresh ones, and
// revoking the one you knew about would achieve nothing.
router.post('/api/admin/session', requireEndpointKey, (req, res) => {
  if (!adminSessions) return sendError(res, 503, 'Sessions unavailable');
  const { token, expiresAt } = adminSessions.create(req.get('X-Stagify-Endpoint-Key') || '');
  // The one moment the master key is actually typed. Page opens are recorded
  // separately, off /api/admin/ping (routes/admin/access.js).
  if (adminAccess) adminAccess.record({ ip: getStagingClientIp(req), outcome: 'signin', path: '/admin', userAgent: req.get('user-agent') });
  logger.info('[admin] session issued, expires ' + new Date(expiresAt).toISOString());
  return res.json({ token, expiresAt });
});

// Sign out. Takes either credential: normally the console revokes the very token
// it is presenting, but signing out with the key (`all: true`) drops every device,
// which is the lever to pull if a laptop goes missing.
router.delete('/api/admin/session', protectLogs, express.json(), (req, res) => {
  if (!adminSessions) return sendError(res, 503, 'Sessions unavailable');
  if (req.body && req.body.all === true) {
    const removed = adminSessions.revokeAll();
    logger.info('[admin] all sessions revoked (' + removed + ')');
    return res.json({ ok: true, revoked: removed });
  }
  const removed = adminSessions.revoke(req.get(ADMIN_SESSION_HEADER) || '');
  return res.json({ ok: true, revoked: removed });
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

// Sign one account out of every device, leaving the password alone.
//
// Reversible in the only sense that matters — the owner signs in again — so it sits
// beside the grant controls rather than in a danger zone. Deliberately does NOT
// invalidate a live password-reset link: that is the owner's way back in, and an
// operator clearing a stranger's stolen session must not also break the mail the
// owner is holding. See lib/data/session-revocation.js.
router.post('/api/admin/revoke-sessions', protectLogs, express.json(), (req, res) => {
  const { userId } = req.body || {};
  if (!userId) {
    return sendError(res, 400, 'A userId is required');
  }
  const result = authStore.revokeUserSessions(String(userId));
  if (!result.ok) {
    return sendError(res, result.code === 'NOT_FOUND' ? 404 : 400, result.error || 'Could not revoke the sessions', {
      code: result.code,
    });
  }
  // The count, not just the act: revoking zero sessions is a legitimate outcome
  // and the operator has to be able to tell it from a successful one.
  logger.info('[admin] revoked', result.revoked, 'session(s) for', result.userId);
  return res.json({ ok: true, userId: result.userId, email: result.email, revoked: result.revoked });
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
