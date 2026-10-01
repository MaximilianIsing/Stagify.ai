// The admin console's Referrals tab: CRUD over campaign short-URLs (/columbia, …).
// The public side, which counts a click and redirects, is routes/referrals.js.
// Mounted with the rest of the console in routes/admin/mount.js.
//
// Links are operator-created data, so this is full CRUD rather than a read-only
// rollup. Retiring a link DEACTIVATES it (the URL stops resolving, the history
// stays); DELETE is the separate, explicit wipe.

import express from 'express';
import { createAsyncRouter } from '../../lib/http/async-router.js';
import { sendError } from '../../lib/http/http-helpers.js';
import { reportError } from '../../lib/http/error-ref.js';
import { logger } from '../../lib/logger.js';

/**
 * Build the admin Referrals router.
 *
 * @param {{
 *   referralLinks?: ReturnType<typeof import('../../lib/data/referral-links.js').createReferralLinks>,
 *   protectLogs: import('express').RequestHandler,
 * }} deps - `referralLinks` absent answers 500 on every endpoint, not an empty list.
 * @returns {import('express').Router}
 */
export function createAdminReferralsRouter(deps) {
  const { referralLinks, protectLogs } = deps;
  const router = createAsyncRouter();

  /**
   * Guard shared by every referral endpoint: a missing store is a 500, not an empty list.
   * @param {import('express').Response} res
   */
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
    const result = store.deactivateLink(String(req.params.slug || ''));
    if (!result.ok) return sendError(res, 404, result.error || 'Not found', { code: result.code });
    logger.info('[admin] retired referral link /' + result.link.slug);
    return res.json({ ok: true, link: result.link });
  });

  router.post('/api/admin/referrals/:slug/activate', protectLogs, (req, res) => {
    const store = referralStoreOr500(res);
    if (!store) return undefined;
    const result = store.activateLink(String(req.params.slug || ''));
    if (!result.ok) return sendError(res, 404, result.error || 'Not found', { code: result.code });
    logger.info('[admin] restored referral link /' + result.link.slug);
    return res.json({ ok: true, link: result.link });
  });

  // The irreversible one: drops the link AND every click it ever recorded.
  router.delete('/api/admin/referrals/:slug', protectLogs, (req, res) => {
    const store = referralStoreOr500(res);
    if (!store) return undefined;
    const result = store.deleteLink(String(req.params.slug || ''));
    if (!result.ok) return sendError(res, 404, result.error || 'Not found', { code: result.code });
    logger.info('[admin] deleted referral link /' + result.slug + ' and its ' + result.hitsDeleted + ' recorded hits');
    return res.json({ ok: true, slug: result.slug, hitsDeleted: result.hitsDeleted });
  });

  return router;
}
