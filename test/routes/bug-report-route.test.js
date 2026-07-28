// Tier: route contract — POST /api/bug-report against a temp data dir.
//
// WHAT THIS COVERS
// This is the only UNAUTHENTICATED endpoint that appends to the persistent volume
// auth-store.db lives on, and `emailLimiter` (6 req / 15 min / IP) is its only other
// brake. So the two disk-safety properties are pinned here, at the level that
// actually writes the file: a giant body must produce a small row, and once the CSV
// hits its ceiling the route must refuse rather than keep eating the volume.
//
// The router is mounted on a bare Express app with __dirname pointed at a temp
// directory, so nothing here touches the real ./data.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import createPublicRouter from '../../routes/public.js';

const pass = (req, res, next) => next();

/** Mount the real public router with its data dir inside a throwaway temp folder. */
async function mountBugReport() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-bugreport-'));
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
      getPromptCount: () => 0, getContactCount: () => 0, incContactCount: () => {},
      __dirname: baseDir,
    }),
  );

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = /** @type {any} */ (server.address());
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    logFile: path.join(baseDir, 'data', 'bug_reports.csv'),
    close: () => new Promise((r) => {
      server.close(() => {
        // The route's append is async and Windows keeps the handle briefly, so a
        // plain rmSync races it with ENOTEMPTY. Retry, and never fail the test over
        // a leftover temp dir.
        try {
          fs.rmSync(baseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
        } catch { /* temp dir; the OS reaps it */ }
        r(undefined);
      });
    }),
  };
}

const post = (base, body) =>
  fetch(`${base}/api/bug-report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** The write is async (fs.appendFile) and the response does not wait on it. */
async function waitForFile(file, predicate) {
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(file) && predicate(fs.statSync(file).size)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${file}`);
}

let app;
const envCeiling = process.env.BUG_REPORT_LOG_MAX_BYTES;
afterEach(async () => {
  if (envCeiling === undefined) delete process.env.BUG_REPORT_LOG_MAX_BYTES;
  else process.env.BUG_REPORT_LOG_MAX_BYTES = envCeiling;
  if (app) {
    await app.close();
    app = null;
  }
});

test('the log gets one header and one row per report', async () => {
  app = await mountBugReport();

  const first = await post(app.baseUrl, {
    description: 'The mask editor freezes',
    steps: 'open it',
    email: 'user@example.com',
  });
  assert.equal(first.status, 200);
  await waitForFile(app.logFile, (size) => size > 0);
  const afterFirst = fs.statSync(app.logFile).size;

  const second = await post(app.baseUrl, { description: 'Second report' });
  assert.equal(second.status, 200);
  await waitForFile(app.logFile, (size) => size > afterFirst);

  const text = fs.readFileSync(app.logFile, 'utf8');
  assert.ok(text.startsWith('timestamp,description,stepsToReproduce'));
  // The header goes out with the first row only — appendFile creates the file, so a
  // re-emitted header would corrupt the CSV for every positional reader of it.
  assert.equal(text.split('timestamp,description,stepsToReproduce').length - 1, 1, 'header must appear exactly once');
  assert.ok(text.includes('The mask editor freezes'));
  assert.ok(text.includes('Second report'));
  assert.equal(text.trimEnd().split('\n').length, 3, 'header + two rows');
});

test('a body at the JSON limit still writes only a small row', async () => {
  app = await mountBugReport();

  // ~700KB of text — as much as the 1MB parser limit this route is scoped to allows.
  const big = 'x'.repeat(200 * 1024);
  const res = await post(app.baseUrl, {
    description: big,
    steps: big,
    url: big,
    conversationHistory: Array.from({ length: 100 }, () => ({ role: 'user', content: 'y'.repeat(1000) })),
  });
  assert.equal(res.status, 200);

  await waitForFile(app.logFile, (size) => size > 0);
  // The whole point: 900KB in, tens of KB on disk. Without the clamps this file
  // would be ~900KB per request, i.e. hundreds of MB per rate-limit window.
  const size = fs.statSync(app.logFile).size;
  assert.ok(size < 100 * 1024, `wrote ${size} bytes for a ~900KB body`);
});

test('once the log hits its ceiling the route refuses instead of growing it', async () => {
  app = await mountBugReport();

  await post(app.baseUrl, { description: 'first' });
  await waitForFile(app.logFile, (size) => size > 0);
  const sizeBefore = fs.statSync(app.logFile).size;

  // Drop the ceiling below what is already on disk.
  process.env.BUG_REPORT_LOG_MAX_BYTES = String(sizeBefore);

  const res = await post(app.baseUrl, { description: 'second' });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'Bug reporting is temporarily unavailable');

  // Give the (absent) async append a chance to land before asserting it did not.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.statSync(app.logFile).size, sizeBefore, 'nothing may be appended past the ceiling');
  assert.ok(!fs.readFileSync(app.logFile, 'utf8').includes('second'));
});

test('a missing description is rejected before anything is written', async () => {
  app = await mountBugReport();

  for (const body of [{}, { description: '   ' }, { description: 12345 }]) {
    const res = await post(app.baseUrl, body);
    assert.equal(res.status, 400, `body ${JSON.stringify(body)} should be a 400`);
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.existsSync(app.logFile), false, 'a rejected report must not create the log');
});
