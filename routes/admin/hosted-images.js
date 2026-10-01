// The admin console's Hosted images tab: upload an image, list what is hosted, unhost
// one. Bytes live on the persistent disk under an unguessable id, served publicly at
// /i/<id> by routes/public.js; a manifest (lib/image/hosted-images.js) records the
// metadata. Mounted with the rest of the console in routes/admin/mount.js.

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { createAsyncRouter } from '../../lib/http/async-router.js';
import { sendError, resolveAppOrigin } from '../../lib/http/http-helpers.js';
import { logger } from '../../lib/logger.js';

/**
 * Build the admin hosted-images router.
 *
 * @param {{
 *   hostImageUpload: import('express').RequestHandler,
 *   hostedImages: import('../../lib/types/deps.js').HostedImagesDeps,
 *   HOSTED_IMAGE_MIME_EXT: Record<string, string>,
 *   protectLogs: import('express').RequestHandler,
 * }} deps
 * @returns {import('express').Router}
 */
export function createAdminHostedImagesRouter(deps) {
  const { hostImageUpload, hostedImages, HOSTED_IMAGE_MIME_EXT, protectLogs } = deps;
  const router = createAsyncRouter();

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
        fs.writeFileSync(path.join(hostedImages.getHostedImagesDir(), file), req.file.buffer);
        const entry = {
          id,
          file,
          mime: req.file.mimetype,
          ext,
          originalName: req.file.originalname || file,
          size: req.file.size || req.file.buffer.length,
          uploadedAt: new Date().toISOString(),
        };
        const manifest = /** @type {import('../../lib/types/image.js').HostedImageEntry[]} */ (hostedImages.readHostedImagesManifest());
        manifest.push(entry);
        hostedImages.writeHostedImagesManifest(manifest);
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
    const images = /** @type {import('../../lib/types/image.js').HostedImageEntry[]} */ (hostedImages.readHostedImagesManifest())
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
    const manifest = /** @type {import('../../lib/types/image.js').HostedImageEntry[]} */ (hostedImages.readHostedImagesManifest());
    const idx = manifest.findIndex((e) => e && e.id === id);
    if (idx === -1) {
      return sendError(res, 404, 'Not found');
    }
    const [entry] = manifest.splice(idx, 1);
    try {
      const filePath = path.join(hostedImages.getHostedImagesDir(), entry.file);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {
      logger.error('[host-image] file delete failed', e);
    }
    hostedImages.writeHostedImagesManifest(manifest);
    logger.info('[host-image] unhosted', entry.file);
    return res.json({ ok: true });
  });

  return router;
}
