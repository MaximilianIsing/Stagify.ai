// Mounts the real admin router (routes/admin.js) on a bare Express app. Unlike the
// other harnesses this keeps the REAL protectLogs guard (built from the real
// createHttpGuards) so the access-key gate on every admin endpoint is genuinely
// exercised — that gate is the whole security story of this router. The stores,
// the hosted-image upload middleware, and the manifest/dir helpers are faked with
// an in-memory manifest and a temp dir so uploads/deletes touch real files without
// a real datastore. Listens on an ephemeral port; no full server boot.

import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import createAdminRouter from '../../routes/admin.js';
import { createHttpGuards } from '../../lib/http/http-guards.js';
import { setSensitiveHeaders } from '../../lib/http/http-helpers.js';

export const ADMIN_KEY = 'test-endpoint-key';

// Same constant-time comparator as lib/config/config.js#endpointKeyMatches.
function endpointKeyMatches(received, expected) {
  if (!received || !expected || typeof received !== 'string' || typeof expected !== 'string') return false;
  const a = crypto.createHash('sha256').update(received, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function makeSpy(impl) {
  const fn = (...args) => { fn.calls += 1; fn.lastArgs = args; return impl ? impl(...args) : undefined; };
  fn.calls = 0; fn.lastArgs = null;
  return fn;
}

/**
 * Mount the admin router. Options:
 *   - `logsAccessKey` (default ADMIN_KEY) → set '' to hit the "key not configured" 500,
 *   - `uploadFile`  → the req.file the faked upload middleware injects,
 *   - `uploadError` → make the upload middleware fail (400 branch),
 *   - `dataLogFiles` → { 'prompt_logs.csv': 'contents' } seeded into the data-log dir,
 *   - `grantResult` / `revokeResult` → what the faked comp-grant store calls return.
 * Returns { baseUrl, key, calls, getManifest, hostedImagesDir, close }.
 */
export async function mountAdmin(options = {}) {
  const {
    logsAccessKey = ADMIN_KEY, uploadFile, uploadError, dataLogFiles = {},
    grantResult = { ok: true, userId: 'u_1', email: 'granted@example.com', expiresAt: '2026-08-22T00:00:00.000Z' },
    revokeResult = { ok: true, userId: 'u_1', email: 'granted@example.com' },
  } = options;

  const hostedImagesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-hosted-'));
  const dataLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-logs-'));
  for (const [name, contents] of Object.entries(dataLogFiles)) {
    fs.writeFileSync(path.join(dataLogDir, name), contents);
  }

  // In-memory hosted-images manifest (the router mutates it via the injected fns).
  let manifest = [];
  const readHostedImagesManifest = () => manifest;
  const writeHostedImagesManifest = makeSpy((next) => { manifest = next; });

  const hostImageUpload = (req, res, cb) => {
    if (uploadError) return cb(new Error(uploadError));
    if (uploadFile) req.file = uploadFile;
    cb();
  };

  const exportAllMemories = makeSpy(() => ({ 'user-1': [{ id: 'm1', text: 'remember me' }] }));
  const resetAllMemories = makeSpy(() => {});
  const uptimeMonitor = { reset: makeSpy(() => ({ up: true, since: 'now' })) };
  const authStore = {
    exportStore: makeSpy(() => ({ users: [], sessions: [] })),
    grantProMonth: makeSpy(() => grantResult),
    revokeProGrant: makeSpy(() => revokeResult),
  };
  const enterpriseStore = { exportStore: makeSpy(() => ({ domains: [] })) };

  const { protectLogs } = createHttpGuards({ genAI: null, LOGS_ACCESS_KEY: logsAccessKey, endpointKeyMatches });

  const deps = {
    authStore,
    uptimeMonitor,
    enterpriseStore,
    hostImageUpload,
    DEBUG_MODE: false,
    setSensitiveHeaders,
    exportAllMemories,
    resetAllMemories,
    getDataLogDir: () => dataLogDir,
    getHostedImagesDir: () => hostedImagesDir,
    readHostedImagesManifest,
    writeHostedImagesManifest,
    protectLogs,
    __dirname: path.resolve('.'),
    HOSTED_IMAGE_MIME_EXT: { 'image/png': 'png', 'image/jpeg': 'jpg' },
  };

  const app = express();
  app.use(createAdminRouter(deps));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    key: logsAccessKey,
    calls: { exportAllMemories, resetAllMemories, uptimeReset: uptimeMonitor.reset, authExport: authStore.exportStore, enterpriseExport: enterpriseStore.exportStore, writeHostedImagesManifest, grantProMonth: authStore.grantProMonth, revokeProGrant: authStore.revokeProGrant },
    getManifest: () => manifest,
    hostedImagesDir,
    close: () =>
      new Promise((r) =>
        server.close(() => {
          fs.rmSync(hostedImagesDir, { recursive: true, force: true });
          fs.rmSync(dataLogDir, { recursive: true, force: true });
          r();
        }),
      ),
  };
}
