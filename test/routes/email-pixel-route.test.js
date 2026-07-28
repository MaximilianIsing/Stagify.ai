// GET /email/logo.png — the email open-tracking pixel, end to end through the real
// public router and the real open-tracking service.
//
// WHY ITS OWN FILE: this is an UNAUTHENTICATED endpoint that writes to the persistent
// volume auth-store.db lives on, and its `?email=` is attacker-controlled. It had no
// rate limiter at all, and the only thing standing between a caller and a row per
// arbitrary address was the proxy-UA check. `emailPixelLimiter` is a module-level
// singleton built ONCE, at import time, from `RL_EMAIL_PIXEL` — so a small
// deterministic ceiling only exists if the env var is set BEFORE
// lib/http/rate-limiters.js is first imported. Hence the override + dynamic import
// below, and hence a separate file from public-email-route.test.js.
//
// Unlike the other limiters this one does NOT answer 429: the URL serves the logo the
// recipient actually sees, so the image must keep flowing and only the disk write is
// dropped. Both halves are asserted here.
//
// Nothing is mailed and ./data is never touched: the router runs on a bare Express app
// and the open-tracking service is pointed at a temp directory.

import { test, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEmail } from '../../lib/services/email.js';

// 2 keeps the burst short; the production default is 120 per 15 minutes.
const RL_SNAPSHOT = process.env.RL_EMAIL_PIXEL;
process.env.RL_EMAIL_PIXEL = '2';

// Dynamic import taken AFTER the override, so the router's fallback limiter is the
// limit=2 one. A static import at the top of the file would run first and freeze the
// default in.
const { default: createPublicRouter } = await import('../../routes/public.js');

after(() => {
  if (RL_SNAPSHOT === undefined) delete process.env.RL_EMAIL_PIXEL;
  else process.env.RL_EMAIL_PIXEL = RL_SNAPSHOT;
});

const esc = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Mount the real public router with the REAL open-tracking service writing into a
 * throwaway directory. `emailPixelLimiter: null` asks for production wiring (the
 * router falls back to the shared limiter); a pass-through is injected otherwise so
 * the UA cases don't share one bucket.
 */
async function mountPixel({ realLimiter = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-pixel-'));
  const email = createEmail({
    resend: null,
    RESEND_FROM_EMAIL: 'no-reply@stagify.ai',
    EMAIL_DEBUG_MODE: false,
    DEBUG_EMAIL: 'debug@stagify.ai',
    escapeCsvField: esc,
    getDataLogDir: () => dataDir,
  });

  const app = express();
  app.use(
    createPublicRouter({
      resend: null,
      LOGS_ACCESS_KEY: 'k',
      endpointKeyMatches: (received, expected) => received === expected,
      emailLimiter: (req, res, next) => next(),
      emailPixelLimiter: realLimiter ? null : (req, res, next) => next(),
      RESEND_FROM_EMAIL: 'no-reply@stagify.ai',
      DEBUG_MODE: false,
      EMAIL_DEBUG_MODE: false,
      DEBUG_EMAIL: 'debug@stagify.ai',
      STATS_DEBUG: false,
      DEBUG_ROOMS: 0,
      DEBUG_USERS: 0,
      authStore: {},
      uptimeMonitor: {},
      getHostedImagesDir: () => '',
      readHostedImagesManifest: () => [],
      logEmailOpenToFile: email.logEmailOpenToFile,
      isConfirmedEmailClientOpen: email.isConfirmedEmailClientOpen,
      healthHandler: (req, res) => res.json({ ok: true }),
      getPromptCount: () => 0,
      getContactCount: () => 0,
      incContactCount: () => {},
      // The route sends public/Logo Full.png from here.
      __dirname: process.cwd(),
    }),
  );

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    dataDir,
    logFile: path.join(dataDir, 'email_open_logs.csv'),
    hasOpened: email.hasEmailEverOpened,
    close: async () => {
      await new Promise((r) => server.close(r));
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

let app;
afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

const fetchPixel = (base, email, ua) =>
  fetch(`${base}/email/logo.png?email=${encodeURIComponent(email)}`, {
    headers: { 'user-agent': ua },
  });

/** appendFile is async; give a row a moment to land before declaring it absent. */
async function settle(logFile, expected) {
  for (let i = 0; i < 100; i += 1) {
    const rows = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, 'utf8').trim().split('\n').length - 1
      : 0;
    if (rows >= expected) return rows;
    await new Promise((r) => setTimeout(r, 10));
  }
  return fs.existsSync(logFile)
    ? fs.readFileSync(logFile, 'utf8').trim().split('\n').length - 1
    : 0;
}

test('a spoofed `User-Agent: outlook` gets the image but records no open', async () => {
  app = await mountPixel();

  const res = await fetchPixel(app.baseUrl, 'victim@example.com', 'outlook');
  assert.equal(res.status, 200, 'the logo is still served — this is a real image in the email');
  assert.equal(res.headers.get('content-type'), 'image/png');

  // The abuse shape: one request per address, each of which used to append a row and
  // mark a stranger's mailbox as having opened our mail.
  for (let i = 0; i < 5; i += 1) {
    await fetchPixel(app.baseUrl, `spoof${i}@example.com`, 'outlook');
  }
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(fs.existsSync(app.logFile), false, 'no CSV is created at all');
  assert.equal(fs.existsSync(path.join(app.dataDir, 'email_opened.json')), false);
  assert.equal(app.hasOpened('victim@example.com'), false, 'no address was poisoned');
});

test('a genuine provider proxy still records the open', async () => {
  app = await mountPixel();

  await fetchPixel(app.baseUrl, 'real@example.com', 'Mozilla/5.0 GoogleImageProxy');
  assert.equal(await settle(app.logFile, 1), 1, 'Gmail still counts');

  await fetchPixel(app.baseUrl, 'desk@example.com', 'Mozilla/4.0 (compatible; ms-office; MSOffice 16)');
  assert.equal(await settle(app.logFile, 2), 2, 'Outlook desktop still counts');

  const csv = fs.readFileSync(app.logFile, 'utf8');
  assert.ok(csv.startsWith('timestamp,email,ipAddress,userAgent'));
  assert.ok(csv.includes('real@example.com'));
  assert.ok(csv.includes('desk@example.com'));
});

test('past the rate limit the image still flows but the write is dropped', async () => {
  app = await mountPixel({ realLimiter: true });
  const UA = 'Mozilla/5.0 GoogleImageProxy';

  // The first RL_EMAIL_PIXEL (=2) requests record normally.
  await fetchPixel(app.baseUrl, 'a@example.com', UA);
  await fetchPixel(app.baseUrl, 'b@example.com', UA);
  assert.equal(await settle(app.logFile, 2), 2);

  // Past the ceiling the response is still the logo — a 429 would show a broken
  // image to a real recipient behind a shared corporate IP — but nothing is written.
  for (let i = 0; i < 10; i += 1) {
    const res = await fetchPixel(app.baseUrl, `over${i}@example.com`, UA);
    assert.equal(res.status, 200, 'the logo is never withheld');
  }
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(await settle(app.logFile, 3), 2, 'no row is appended past the limit');
  assert.equal(app.hasOpened('over0@example.com'), false);
});
