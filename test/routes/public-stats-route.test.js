// Tier: route contract — GET /api/stats, and its parity with the two older endpoints.
//
// WHAT THIS COVERS
// /api/stats is the number llms.txt points an answer engine at, so it is the figure that
// gets quoted back to people. It must agree with what the homepage shows, and the homepage
// is driven by /api/prompt-count and /api/contact-count. Three endpoints computing the
// same two numbers is exactly the shape that drifts, and drift here means the site says
// one thing in its HTML and another in its JSON.
//
// So the parity tests below are the point of this file: whatever the inputs, the three
// endpoints must agree — including under the STATS_DEBUG overrides, which exist precisely
// to make the figures lie for a screenshot and would be worthless if they only fooled two
// of the three.
//
// The router is mounted on a bare Express app with stubbed counters; nothing here touches
// SQLite or the CSV logs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import createPublicRouter from '../../routes/public.js';
import { STAT_DEFINITIONS } from '../../lib/data/public-stats.js';

const pass = (req, res, next) => next();

/**
 * Mount the real public router over fake counters.
 *
 * @param {{promptCount?: number, contactCount?: number, userCount?: number,
 *          STATS_DEBUG?: boolean, DEBUG_ROOMS?: number, DEBUG_USERS?: number,
 *          readPublicStats?: (() => {roomsStaged: number, usersServed: number}) | null}} opts
 */
async function mount(opts = {}) {
  const {
    promptCount = 4200,
    contactCount = 300,
    userCount = 67,
    STATS_DEBUG = false,
    DEBUG_ROOMS = NaN,
    DEBUG_USERS = NaN,
    readPublicStats = null,
  } = opts;

  const app = express();
  app.use(express.json());
  app.use(
    createPublicRouter({
      authStore: { getUserCount: () => userCount },
      readPublicStats,
      uptimeMonitor: { getSnapshot: () => ({}) },
      serviceHealth: {},
      resend: null,
      LOGS_ACCESS_KEY: 'k',
      endpointKeyMatches: () => true,
      emailLimiter: pass,
      emailPixelLimiter: pass,
      RESEND_FROM_EMAIL: 'test@example.com',
      DEBUG_MODE: false,
      EMAIL_DEBUG_MODE: false,
      DEBUG_EMAIL: '',
      STATS_DEBUG,
      DEBUG_ROOMS,
      DEBUG_USERS,
      hostedImages: null,
      email: null,
      healthHandler: (req, res) => res.json({ ok: true }),
      getPromptCount: () => promptCount,
      getContactCount: () => contactCount,
      incContactCount: () => {},
      blogViews: null,
      emailOptOut: null,
      __dirname: process.cwd(),
    }),
  );

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();

  return {
    close: () => server.close(),
    async get(pathname) {
      const res = await fetch(`http://127.0.0.1:${port}${pathname}`);
      return { status: res.status, cacheControl: res.headers.get('cache-control'), body: await res.json() };
    },
  };
}

test('/api/stats reports both figures with a sentence saying what each counts', async (t) => {
  const api = await mount();
  t.after(api.close);

  const { status, body, cacheControl } = await api.get('/api/stats');

  assert.equal(status, 200);
  assert.equal(body.roomsStaged, 4200);
  assert.equal(body.usersServed, 367, 'usersServed is contactCount + userCount');
  assert.deepEqual(body.definitions, STAT_DEFINITIONS);
  assert.equal(body.source, 'https://stagify.ai/llms.txt');
  assert.ok(!Number.isNaN(Date.parse(body.generatedAt)), 'generatedAt must be a real timestamp');
  // Never cached: it is a live figure, and a cached one is worse than no figure.
  assert.equal(cacheControl, 'no-store');
});

test('/api/stats agrees with the two endpoints the homepage actually calls', async (t) => {
  const api = await mount();
  t.after(api.close);

  const stats = (await api.get('/api/stats')).body;
  const prompts = (await api.get('/api/prompt-count')).body;
  const contacts = (await api.get('/api/contact-count')).body;

  assert.equal(stats.roomsStaged, prompts.promptCount);
  assert.equal(stats.usersServed, contacts.usersServed);
});

test('the STATS_DEBUG overrides fool all three endpoints, not two of them', async (t) => {
  const api = await mount({ STATS_DEBUG: true, DEBUG_ROOMS: 50000, DEBUG_USERS: 900 });
  t.after(api.close);

  const stats = (await api.get('/api/stats')).body;
  assert.equal(stats.roomsStaged, 50000);
  assert.equal(stats.usersServed, 900);
  assert.equal(stats.roomsStaged, (await api.get('/api/prompt-count')).body.promptCount);
  assert.equal(stats.usersServed, (await api.get('/api/contact-count')).body.usersServed);
});

test('a blank or non-numeric override falls back to the real count, never to zero', async (t) => {
  // parseStatOverride yields NaN for an unset/blank DEBUG_ROOMS; treating that as 0 would
  // put "0 Rooms Staged" on the homepage of a live site.
  const api = await mount({ STATS_DEBUG: true, DEBUG_ROOMS: NaN, DEBUG_USERS: NaN });
  t.after(api.close);

  const stats = (await api.get('/api/stats')).body;
  assert.equal(stats.roomsStaged, 4200);
  assert.equal(stats.usersServed, 367);
});

test('when the shared reader is injected, /api/stats reads through it', async (t) => {
  // server.js passes one readPublicStats to the router, the HTML injector and llms.txt, so
  // this is the path that actually runs in production.
  const api = await mount({ readPublicStats: () => ({ roomsStaged: 7, usersServed: 8 }) });
  t.after(api.close);

  const stats = (await api.get('/api/stats')).body;
  assert.equal(stats.roomsStaged, 7);
  assert.equal(stats.usersServed, 8);
});
