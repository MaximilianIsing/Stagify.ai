// Mounts the real auth router (routes/auth.js) on a bare Express app, backed by a
// REAL temp-dir auth store (better-sqlite3) and the REAL auth helpers, then listens
// on an ephemeral port. Only the external clients are faked: the verification-email
// sender (captured, never sent) and the Google OAuth client. This exercises the
// actual handlers AND their wiring to the store — a genuine register → verify →
// login → me → logout flow over HTTP — with no network, no SMTP, no Google call.
//
// Mirrors test/helpers/staging-app.js / chat-app.js, but keeps the store real
// because the auth handlers are thin glue over it: faking the store would only
// re-assert "the handler forwards to the store" tautologically. The store itself is
// unit-tested in auth-store*.test.js; here we cover the ROUTE layer (status mapping,
// response shaping, the staging Google gate, the email-code round-trip).

import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import createAuthRouter from '../../routes/auth.js';
import { createAuthStore } from '../../lib/data/auth-store.js';
import { createAuthHelpers } from '../../lib/services/auth-helpers.js';
import { setSensitiveHeaders } from '../../lib/http/http-helpers.js';

const pass = (req, res, next) => next();

// Same constant-time comparator shape as lib/config/config.js#endpointKeyMatches,
// inlined so the harness doesn't boot the file-reading config factory.
function endpointKeyMatches(received, expected) {
  if (!received || !expected || typeof received !== 'string' || typeof expected !== 'string') return false;
  const a = crypto.createHash('sha256').update(received, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

// Enterprise store is only touched by the auth helpers' enterprise enhancement;
// for these tests no domain is ever active, so every user keeps its own plan.
const inertEnterpriseStore = {
  isActiveDomain: () => false,
  getDomainEntry: () => null,
  recordUsage: () => {},
};

/**
 * Mount the auth router with a real store. `overrides` merges over the default deps
 * (e.g. `IS_STAGING: true`, a scripted `googleOAuthClient`, `googleClientId: null`).
 * Returns { baseUrl, store, sentEmails, close }. `sentEmails` collects every
 * { toEmail, code } the router asked to send, so a test can read back the
 * verification code without a mailbox.
 */
export async function mountAuth(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-auth-'));
  const store = createAuthStore(dir);
  const helpers = createAuthHelpers({
    authStore: store,
    enterpriseStore: inertEnterpriseStore,
    stripe: null,
    enterpriseMeterEventName: 'test_meter',
  });

  const sentEmails = [];
  const sendRegistrationVerificationEmail = async ({ toEmail, code }) => {
    sentEmails.push({ toEmail, code });
    return { ok: true, body: { ok: true, message: 'Verification code sent', email: toEmail } };
  };

  const baseDeps = {
    authStore: store,
    googleOAuthClient: null,
    resend: null,
    LOGS_ACCESS_KEY: 'test-endpoint-key',
    authLimiter: pass,
    emailLimiter: pass,
    RESEND_FROM_EMAIL: 'noreply@test.stagify',
    EMAIL_DEBUG_MODE: false,
    DEBUG_EMAIL: '',
    IS_STAGING: false,
    SHOW_STAGING_BANNER: false,
    endpointKeyMatches,
    setSensitiveHeaders,
    getAuthUserFromRequest: helpers.getAuthUserFromRequest,
    toPublicAuthUser: helpers.toPublicAuthUser,
    sendRegistrationVerificationEmail,
    __dirname: path.resolve('.'),
    googleClientId: 'test-google-client-id',
  };

  const app = express();
  app.use(createAuthRouter({ ...baseDeps, ...overrides }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    store,
    sentEmails,
    close: () =>
      new Promise((r) =>
        server.close(() => {
          try { store.close(); } catch { /* already closed */ }
          fs.rmSync(dir, { recursive: true, force: true });
          r();
        }),
      ),
  };
}
