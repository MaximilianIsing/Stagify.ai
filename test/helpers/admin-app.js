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
import { createEmailCatalog } from '../../lib/services/email-catalog.js';
import { createReferralLinks } from '../../lib/data/referral-links.js';
import { createAdminSessions } from '../../lib/data/admin-sessions.js';
import { createUptimeMonitor } from '../../lib/data/uptime-monitor.js';
// The PRODUCTION multer instance, for `realUpload: true` — the point is to exercise
// the real fileFilter and size limit, so this must not be rebuilt here.
import {
  hostImageUpload as realHostImageUpload,
  HOSTED_IMAGE_MIME_EXT as REAL_HOSTED_IMAGE_MIME_EXT,
} from '../../lib/http/uploads.js';
import { closeDb } from '../../lib/data/db.js';

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
 *   - `grantResult` / `revokeResult` → what the faked comp-grant store calls return,
 *   - `deleteUserResult` → what the faked GDPR-erasure helper returns,
 *   - `withReferrals` (default true) → mount a REAL referral store on a temp data
 *     dir; `false` omits the dep entirely to hit the "not configured" 500 branch,
 *   - `withAdminSessions` (default true) → mount a REAL admin-session store on a temp
 *     data dir; `false` omits it, which hits the 503 branch on the session endpoints
 *     and makes protectLogs key-only,
 *   - `realUptime` (default false) → mount the REAL uptime monitor on a temp data dir
 *     instead of the `reset`-only stub, for the server-status and incident endpoints,
 *   - `realKeyLimiter` (default false) → wire the SHARED endpoint-key limiter, i.e.
 *     production; by default a pass-through is injected so unrelated 403 cases in one
 *     file don't share a bucket. `endpointKeyLimiter` injects a specific one.
 *   - `metricsSnapshot` → what the faked Signals metrics reader returns; `null`
 *     (or `withMetrics: false`) omits the dep, which is the "unavailable" branch,
 *   - `metricsError` → make the metrics reader throw, for the 500 branch,
 *   - `briefResult` → what the faked brief generator resolves to; `withBrief: false`
 *     omits the dep entirely (the no-key branch).
 * Returns { baseUrl, key, calls, getManifest, hostedImagesDir, referrals, close }.
 */
export async function mountAdmin(options = {}) {
  const {
    logsAccessKey = ADMIN_KEY, uploadFile, uploadError, dataLogFiles = {},
    withReferrals = true, withAdminSessions = true, realUptime = false,
    realKeyLimiter = false, endpointKeyLimiter, realUpload = false,
    withMetrics = true, metricsSnapshot = { generatedAt: 0, renders: { total: 0 } }, metricsError,
    withBrief = true, briefResult = { summary: 'All quiet.', model: 'gpt-4o-mini' },
    grantResult = { ok: true, userId: 'u_1', email: 'granted@example.com', expiresAt: '2026-08-22T00:00:00.000Z' },
    revokeResult = { ok: true, userId: 'u_1', email: 'granted@example.com' },
    testSendResult = { ok: true },
    deleteUserResult = { ok: true, userId: 'u_1', email: 'gone@example.com', rows: { users: 1, sessions: 2, memories: 1 }, logs: [] },
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

  // By default the upload middleware is faked, which keeps the many non-upload admin
  // tests from having to build multipart bodies. That default HID a real gap: nothing
  // asserted the production multer instance still carries `fileFilter:
  // hostedImageFileFilter`, so deleting that line kept the whole suite green — and the
  // route does not re-check the mime (routes/admin.js saves an unknown type as .bin
  // and routes/public.js serves it back INLINE with that Content-Type). Pass
  // `realUpload: true` to drive lib/http/uploads.js itself; see
  // test/routes/admin-upload-filter.test.js.
  const hostImageUpload = realUpload
    ? realHostImageUpload
    : (req, res, cb) => {
      if (uploadError) return cb(new Error(uploadError));
      if (uploadFile) req.file = uploadFile;
      cb();
    };

  const exportAllMemories = makeSpy(() => ({ 'user-1': [{ id: 'm1', text: 'remember me' }] }));
  const resetAllMemories = makeSpy(() => {});
  const deleteUser = makeSpy(() => deleteUserResult);
  // Default: a stub with just `reset`, which is all the older suites need and keeps
  // their snapshot assertion a fixed literal. `realUptime: true` mounts the REAL
  // monitor on a throwaway dir instead — the incident endpoints are CRUD over
  // persisted state, and a stub would agree with whatever the route did.
  const uptimeDir = realUptime ? fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-adm-uptime-')) : null;
  const realMonitor = uptimeDir ? createUptimeMonitor(uptimeDir) : null;
  if (realMonitor) realMonitor.start();
  const uptimeMonitor = realMonitor
    ? { ...realMonitor, reset: makeSpy((...a) => realMonitor.reset(...a)) }
    : { reset: makeSpy(() => ({ up: true, since: 'now' })) };
  const authStore = {
    // exportStore (the credential-bearing backup shape) is deliberately NOT wired
    // to any route — if a future edit points /authstore back at it, the spy stays
    // at 0 calls and test/routes/admin-route.test.js fails.
    exportStore: makeSpy(() => ({ users: [], sessions: [] })),
    exportRedacted: makeSpy(() => ({ users: [] })),
    grantProMonth: makeSpy(() => grantResult),
    revokeProGrant: makeSpy(() => revokeResult),
  };
  const enterpriseStore = { exportStore: makeSpy(() => ({ domains: [] })) };

  // Real (pure) email catalog + a spied test-send so the Emails-tab endpoints are
  // exercised without touching Resend.
  const emailCatalog = createEmailCatalog({ appUrl: 'https://stagify.ai' });
  const sendTestEmail = makeSpy(async () => testSendResult);

  // REAL campaign-link store on a throwaway data dir — the referral endpoints are
  // CRUD over SQLite, so a fake would assert nothing about what actually persists.
  // `withReferrals: false` leaves the dep off the bag, which is how the
  // "not configured" branch is reached.
  const referralDir = withReferrals ? fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-adm-ref-')) : null;
  const referralLinks = referralDir ? createReferralLinks(referralDir, { seed: false }) : undefined;

  // A pass-through key limiter by default: this harness mounts a fresh app per test
  // but the SHARED limiter is a module-level singleton, so the real one would carry
  // one bucket across every 403 case in a file and they would start 429ing each other.
  // `realKeyLimiter: true` (or an injected `endpointKeyLimiter`) opts a test back in.
  // REAL admin-session store on a throwaway data dir, for the same reason the
  // referral store is real: these endpoints are CRUD over SQLite, and a fake would
  // assert nothing about what actually persists — least of all the key-fingerprint
  // check, which is the part most likely to break. `withAdminSessions: false` leaves
  // the dep off the bag, which is how the 503 branch is reached and, separately, how
  // protectLogs falls back to being key-only.
  const adminSessionDir = withAdminSessions ? fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-adm-sess-')) : null;
  const adminSessions = adminSessionDir ? createAdminSessions(adminSessionDir) : undefined;

  // Signals tab. Both are FAKED rather than real: admin-metrics.js is covered
  // against real SQLite in test/analytics/admin-metrics.test.js, and admin-brief.js
  // against a stub client in test/services/admin-brief.test.js. What the ROUTE
  // contract needs to prove is the gate, the shapes, and the degradation — so the
  // deps are spies whose absence is itself a case (`withMetrics`/`withBrief: false`).
  const adminMetrics = withMetrics
    ? { snapshot: makeSpy(() => { if (metricsError) throw new Error(metricsError); return metricsSnapshot; }) }
    : undefined;
  const adminBrief = withBrief
    ? { generateBrief: makeSpy(async () => briefResult) }
    : undefined;

  const { protectLogs, requireEndpointKey } = createHttpGuards({
    genAI: null,
    LOGS_ACCESS_KEY: logsAccessKey,
    endpointKeyMatches,
    endpointKeyLimiter: realKeyLimiter ? null : (endpointKeyLimiter ?? ((req, res, next) => next())),
    adminSessions,
  });

  const deps = {
    authStore,
    uptimeMonitor,
    enterpriseStore,
    hostImageUpload,
    DEBUG_MODE: false,
    setSensitiveHeaders,
    exportAllMemories,
    resetAllMemories,
    deleteUser,
    getDataLogDir: () => dataLogDir,
    hostedImages: {
      getHostedImagesDir: () => hostedImagesDir,
      readHostedImagesManifest,
      writeHostedImagesManifest,
    },
    protectLogs,
    requireEndpointKey,
    adminSessions,
    __dirname: path.resolve('.'),
    // The REAL map, not a two-entry stand-in. server.js injects lib/http/uploads.js's
    // export; the trimmed copy that used to sit here disagreed with the filter beside
    // it, so a webp or gif that multer ACCEPTS was saved as `.bin` under test while
    // production named it correctly — a divergence that can only ever hide bugs.
    HOSTED_IMAGE_MIME_EXT: REAL_HOSTED_IMAGE_MIME_EXT,
    emailCatalog,
    sendTestEmail,
    referralLinks,
    adminMetrics,
    adminBrief,
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
    calls: { exportAllMemories, resetAllMemories, uptimeReset: uptimeMonitor.reset, authExport: authStore.exportStore, authExportRedacted: authStore.exportRedacted, enterpriseExport: enterpriseStore.exportStore, writeHostedImagesManifest, grantProMonth: authStore.grantProMonth, revokeProGrant: authStore.revokeProGrant, sendTestEmail, deleteUser, metricsSnapshot: adminMetrics && adminMetrics.snapshot, generateBrief: adminBrief && adminBrief.generateBrief },
    getManifest: () => manifest,
    hostedImagesDir,
    referrals: referralLinks,
    uptime: realMonitor,
    close: () =>
      new Promise((r) =>
        server.close(() => {
          fs.rmSync(hostedImagesDir, { recursive: true, force: true });
          fs.rmSync(dataLogDir, { recursive: true, force: true });
          if (referralDir) {
            // Close the shared connection first so Windows can unlink the .db files.
            closeDb(referralDir);
            fs.rmSync(referralDir, { recursive: true, force: true });
          }
          if (adminSessionDir) {
            closeDb(adminSessionDir);
            fs.rmSync(adminSessionDir, { recursive: true, force: true });
          }
          if (uptimeDir) {
            // close() stops the heartbeat timer as well as the connection — left
            // running it would keep the test runner alive after the suite finished.
            realMonitor.close();
            fs.rmSync(uptimeDir, { recursive: true, force: true });
          }
          r();
        }),
      ),
  };
}
