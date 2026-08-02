// POST /api/log-contact — the second UNAUTHENTICATED writer onto the volume that
// auth-store.db lives on.
//
// WHY THIS EXISTS: /api/bug-report documents this exact threat model in
// lib/http/bug-report-row.js ("an unclamped row let one IP append tens of MB per
// request and fill the disk out from under SQLite") and defends against it with
// per-field clamps plus an absolute file ceiling. /api/log-contact had NEITHER,
// while emailLimiter allows 6 requests / 15 min / IP against a 1 MB JSON parser —
// so a handful of IPs could fill the volume and take auth, sessions and memories
// down with it. These tests pin both defences.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import createPublicRouter from '../../routes/public.js';

const pass = (req, res, next) => next();

async function mountContact() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-contactlog-'));
  let contactCount = 0;
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(
    createPublicRouter({
      resend: { emails: { send: async () => ({ data: { id: 'x' }, error: null }) } },
      LOGS_ACCESS_KEY: 'k',
      endpointKeyMatches: (received, expected) => received === expected,
      emailLimiter: pass,
      RESEND_FROM_EMAIL: 'noreply@stagify.ai',
      DEBUG_MODE: false,
      EMAIL_DEBUG_MODE: false,
      DEBUG_EMAIL: 'debug@stagify.ai',
      authStore: {}, uptimeMonitor: {}, STATS_DEBUG: false, DEBUG_ROOMS: 0, DEBUG_USERS: 0,
      getHostedImagesDir: () => '', readHostedImagesManifest: () => ({}),
      logEmailOpenToFile: () => {}, isConfirmedEmailClientOpen: () => false,
      healthHandler: (req, res) => res.json({ ok: true }),
      getPromptCount: () => 0,
      getContactCount: () => contactCount,
      incContactCount: () => { contactCount += 1; },
      __dirname: baseDir,
    }),
  );

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = /** @type {any} */ (server.address());
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    logFile: path.join(baseDir, 'data', 'contact_logs.csv'),
    dataDir: path.join(baseDir, 'data'),
    getContactCount: () => contactCount,
    close: () => new Promise((r) => {
      server.close(() => {
        try {
          fs.rmSync(baseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
        } catch { /* temp dir; the OS reaps it */ }
        r(undefined);
      });
    }),
  };
}

const post = (base, body) =>
  fetch(`${base}/api/log-contact`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

let app;
afterEach(async () => {
  if (app) { await app.close(); app = null; }
  delete process.env.BUG_REPORT_LOG_MAX_BYTES;
});

test('a normal submission is written with its header, in column order', async () => {
  app = await mountContact();
  const res = await post(app.baseUrl, {
    userRole: 'agent', referralSource: 'google', email: 'a@b.com', userAgent: 'UA/1.0',
  });
  assert.equal(res.status, 200);

  const lines = fs.readFileSync(app.logFile, 'utf8').trim().split('\n');
  assert.equal(lines[0], 'timestamp,userRole,referralSource,email,userAgent,ipAddress');
  const cols = lines[1].split(',');
  assert.equal(cols[1], 'agent');
  assert.equal(cols[2], 'google');
  assert.equal(cols[3], 'a@b.com');
});

test('an oversized field is clamped instead of landing on disk whole', async () => {
  app = await mountContact();
  // Sized to sit just under the 1 MB JSON parser across all four fields, so this is
  // a payload a single request can really deliver.
  const huge = 'x'.repeat(200_000);
  const res = await post(app.baseUrl, {
    userRole: huge, referralSource: huge, email: huge, userAgent: huge,
  });
  assert.equal(res.status, 200, 'a fat submission is still accepted, just not stored whole');

  const size = fs.statSync(app.logFile).size;
  assert.ok(size < 5000, `the row must be clamped, but the log is ${size} bytes`);
  const body = fs.readFileSync(app.logFile, 'utf8');
  assert.ok(body.includes('[truncated]'), 'the loss is marked, not silent');
});

test('many fat submissions cannot grow the log without bound', async () => {
  app = await mountContact();
  const huge = 'y'.repeat(200_000);
  for (let i = 0; i < 6; i += 1) {
    await post(app.baseUrl, { userRole: huge, referralSource: huge, email: huge, userAgent: huge });
  }
  const size = fs.statSync(app.logFile).size;
  // Unclamped this would be ~4.8 MB from six requests — one rate-limit window's worth.
  assert.ok(size < 30_000, `six abusive requests must stay small, but the log is ${size} bytes`);
});

test('past the absolute ceiling the write is refused rather than eating the volume', async () => {
  app = await mountContact();
  // Seed a log already at the ceiling, the same backstop /api/bug-report uses.
  fs.mkdirSync(app.dataDir, { recursive: true });
  fs.writeFileSync(app.logFile, 'timestamp,userRole,referralSource,email,userAgent,ipAddress\n');
  fs.appendFileSync(app.logFile, 'x'.repeat(5000));
  process.env.BUG_REPORT_LOG_MAX_BYTES = '1000';

  const before = fs.statSync(app.logFile).size;
  const res = await post(app.baseUrl, { userRole: 'agent', email: 'a@b.com' });
  assert.equal(res.status, 503, 'the endpoint reports unavailable rather than appending');
  assert.equal(fs.statSync(app.logFile).size, before, 'not one byte was added');
  assert.equal(app.getContactCount(), 0, 'a dropped row must not inflate the public counter');
});

test('the header is written once even when the very first writes race', async () => {
  app = await mountContact();
  // Fire concurrently at a FRESH file: the old exists-then-write shape truncated
  // one row away here, because every writer believed it was the first.
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      post(app.baseUrl, { userRole: `role${i}`, referralSource: 'r', email: `u${i}@x.com`, userAgent: 'UA' })),
  );

  const lines = fs.readFileSync(app.logFile, 'utf8').trim().split('\n');
  const headers = lines.filter((l) => l.startsWith('timestamp,'));
  assert.equal(headers.length, 1, 'exactly one header');
  assert.equal(lines.length, 9, `8 rows + 1 header, got ${lines.length}`);
  for (let i = 0; i < 8; i += 1) {
    assert.ok(lines.some((l) => l.includes(`u${i}@x.com`)), `submission ${i} must survive`);
  }
});
