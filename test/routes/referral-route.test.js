// Tier: route contract (real router + real limiter, real store) — routes/referrals.js.
//
// WHAT THIS COVERS
// The campaign short-URLs (/columbia, …). Links are operator-created data, so this
// router matches `/:slug` and resolves per request — which makes WHERE it is mounted
// a safety property, not a style choice. It is an UNAUTHENTICATED endpoint whose
// every hit appends a row to the SQLite file auth-store.db lives in, and whose only
// job is to get a stranger to the home page, so:
//   - a live link 302s to / and counts; a retired one and an unknown one are plain
//     404s that record nothing,
//   - the visitor ALWAYS reaches the home page, including when the write is skipped
//     for rate limiting — a 429 here is a stranger seeing an error where the site
//     should be,
//   - the response is uncacheable, or an intermediary would hide every later click
//     and keep sending people to a link that has since been retired,
//   - HEAD (link previewers, health probes) redirects without counting,
//   - unmatched traffic falls through WITHOUT consuming the rate-limit bucket: this
//     route sees every stray 404 in the app, so limiting before resolving would let
//     random crawling exhaust the budget that protects the real links.
//
// Plus the guard that keeps `RESERVED_ROUTE_ROOTS` honest — that list is what stops
// the dashboard minting a link which silently never fires.
//
// RL_REFERRAL is overridden BEFORE the first import of the limiter module — it is a
// module-level singleton built once from the env var — hence the dynamic import.

import { test, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReferralLinks, RESERVED_ROUTE_ROOTS } from '../../lib/data/referral-links.js';
import { closeDb } from '../../lib/data/db.js';

// 2 keeps the burst short; the production default is 120 per 15 minutes.
const RL_SNAPSHOT = process.env.RL_REFERRAL;
process.env.RL_REFERRAL = '2';

const { default: createReferralRouter } = await import('../../routes/referrals.js');

after(() => {
  if (RL_SNAPSHOT === undefined) delete process.env.RL_REFERRAL;
  else process.env.RL_REFERRAL = RL_SNAPSHOT;
});

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/**
 * Mount the real referral router over a REAL store on a temp data dir, with the
 * router LAST — the production arrangement, and the one the shadowing test needs.
 * `realLimiter: true` asks for production wiring (the router falls back to the
 * shared limiter); otherwise a pass-through is injected so unrelated cases don't
 * share one bucket.
 */
async function mount({ realLimiter = false, limiter } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-refroute-'));
  const referralLinks = createReferralLinks(dir, { seed: false });
  referralLinks.createLink({ slug: 'columbia', label: 'Columbia University' });

  const app = express();
  // Stand-ins for the real app's routes, mounted BEFORE the referral router exactly
  // as server.js does. `mounted-first` is deliberately NOT one of the names
  // createLink refuses, so the shadowing test exercises the mount ORDER rather than
  // the creation guard — those are two independent defences and only one of them is
  // the structural one.
  app.get('/', (req, res) => res.type('html').send('<h1>home</h1>'));
  app.get('/mounted-first', (req, res) => res.type('html').send('<h1>a real page</h1>'));

  app.use(createReferralRouter({
    referralLinks,
    referralLimiter: realLimiter ? null : (limiter || ((req, res, next) => next())),
  }));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    links: referralLinks,
    close: async () => {
      await new Promise((r) => server.close(r));
      closeDb(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

let app;
afterEach(async () => {
  if (app) { await app.close(); app = null; }
});

const open = (base, slug, extra = {}) =>
  fetch(`${base}/${slug}`, { redirect: 'manual', headers: { 'user-agent': CHROME, ...extra } });

// ---- The redirect ---------------------------------------------------------

test('a live link redirects to the home page and counts the arrival', async () => {
  app = await mount();
  const res = await open(app.baseUrl, 'columbia', { referer: 'https://columbia.edu/housing' });

  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/');
  const [row] = app.links.summary({});
  assert.equal(row.clicks, 1);
  assert.equal(row.referrers[0].source, 'columbia.edu/housing');
});

test('following the redirect lands on the real home page', async () => {
  app = await mount();
  const res = await fetch(app.baseUrl + '/columbia', { headers: { 'user-agent': CHROME } });
  assert.equal(res.status, 200);
  assert.equal(new URL(res.url).pathname, '/', 'the campaign slug leaves the address bar');
  assert.match(await res.text(), /home/);
});

test('the redirect is uncacheable', async () => {
  // A cached 302 makes the same visitor's later opens invisible, an intermediary
  // caching it hides everyone behind it, and either would keep sending people to a
  // link that has since been retired.
  app = await mount();
  const res = await open(app.baseUrl, 'columbia');
  assert.match(res.headers.get('cache-control') || '', /no-store/);
});

test('a link created at runtime works immediately, with no restart', async () => {
  // The whole point of making links data: no deploy between "create" and "live".
  app = await mount();
  assert.equal((await open(app.baseUrl, 'nyu')).status, 404, 'not a link yet');

  app.links.createLink({ slug: 'nyu', label: 'NYU' });
  const res = await open(app.baseUrl, 'nyu');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/');
  assert.equal(app.links.summary({}).find((l) => l.slug === 'nyu').clicks, 1);
});

test('a retired link stops resolving at once and records nothing more', async () => {
  app = await mount();
  await open(app.baseUrl, 'columbia');
  app.links.deactivateLink('columbia');

  const res = await open(app.baseUrl, 'columbia');
  assert.equal(res.status, 404, 'the URL is gone for visitors');
  assert.equal(app.links.summary({})[0].clicks, 1, 'but the click it already had is kept');
});

test('a deleted link is a 404 and its clicks are gone', async () => {
  app = await mount();
  await open(app.baseUrl, 'columbia');
  app.links.deleteLink('columbia');
  assert.equal((await open(app.baseUrl, 'columbia')).status, 404);
  assert.deepEqual(app.links.summary({}), []);
});

test('HEAD redirects without counting a visit', async () => {
  app = await mount();
  const res = await fetch(app.baseUrl + '/columbia', { method: 'HEAD', redirect: 'manual', headers: { 'user-agent': CHROME } });
  assert.equal(res.status, 302, 'previewers and probes still get their answer');
  assert.equal(app.links.summary({})[0].clicks, 0, 'nobody arrives at a page via HEAD');
});

test('an unregistered slug is a plain 404 and records nothing', async () => {
  app = await mount();
  const res = await open(app.baseUrl, 'harvard');
  assert.equal(res.status, 404);
  assert.equal(app.links.countAll(), 0);
});

// ---- Mounting position ----------------------------------------------------

test('the router never shadows a route mounted before it', async () => {
  // The safety property: `/:slug` matches anything, so this router is only safe
  // BECAUSE it is mounted last. Even with a link that has a real page's name, the
  // page must win. createLink refusing reserved names is the second, softer line of
  // defence — this test deliberately routes around it to prove the first one.
  app = await mount();
  const created = app.links.createLink({ slug: 'mounted-first', label: 'Should never win' });
  assert.equal(created.ok, true, 'precondition: this slug is not one createLink refuses');

  const res = await fetch(app.baseUrl + '/mounted-first', { redirect: 'manual', headers: { 'user-agent': CHROME } });
  assert.equal(res.status, 200, 'the real page answers, not the referral redirect');
  assert.match(await res.text(), /a real page/);
  assert.equal(app.links.summary({}).find((l) => l.slug === 'mounted-first').clicks, 0, 'and nothing is counted');
});

// ---- Rate limiting --------------------------------------------------------

test('past the rate limit the visitor still reaches the site but the row is dropped', async () => {
  app = await mount({ realLimiter: true });

  for (let i = 0; i < 2; i += 1) {
    assert.equal((await open(app.baseUrl, 'columbia')).status, 302);
  }
  assert.equal(app.links.summary({})[0].clicks, 2, 'RL_REFERRAL=2 requests record normally');

  for (let i = 0; i < 8; i += 1) {
    const res = await open(app.baseUrl, 'columbia');
    assert.equal(res.status, 302, 'never 429 — this is a stranger trying to open the site');
    assert.equal(res.headers.get('location'), '/');
  }
  assert.equal(app.links.summary({})[0].clicks, 2, 'no row is recorded past the limit');
});

test('unmatched paths never reach the rate limiter at all', async () => {
  // This route sees every stray single-segment 404 in the app. Limiting before
  // resolving would let a crawler hitting nonsense URLs exhaust the budget that
  // protects the real campaign links.
  //
  // Asserted by counting limiter invocations rather than by exhausting the real
  // limiter: that one is a module-level singleton keyed on IP, so a sibling test in
  // this file has already spent 127.0.0.1's budget for the window.
  let limiterRuns = 0;
  app = await mount({ limiter: (req, res, next) => { limiterRuns += 1; next(); } });

  for (let i = 0; i < 20; i += 1) {
    assert.equal((await open(app.baseUrl, `nonsense-${i}`)).status, 404);
  }
  assert.equal(limiterRuns, 0, '20 stray 404s cost the bucket nothing');

  for (let i = 0; i < 2; i += 1) {
    assert.equal((await open(app.baseUrl, 'columbia')).status, 302);
  }
  assert.equal(limiterRuns, 2, 'only real campaign traffic is counted against the limit');
  assert.equal(app.links.summary({})[0].clicks, 2);
});

// ---- Reserved-list drift guard --------------------------------------------

test('RESERVED_ROUTE_ROOTS covers every route root the app registers', () => {
  // Hand-maintained lists rot. A route root missing here is a slug the dashboard
  // would happily mint, producing a link that silently never counts — so the list
  // is checked against the routers themselves.
  const found = new Set();
  for (const file of ['public.js', 'admin.js', 'auth.js', 'billing.js', 'staging.js', 'chat.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'routes', file), 'utf8');
    for (const m of src.matchAll(/router\.(?:get|post|put|delete|all)\(\s*['"`]\/([^/'"`:)\s]+)/g)) {
      found.add(m[1].toLowerCase());
    }
  }

  assert.ok(found.size > 10, `precondition: the scan found only ${found.size} route roots — it is broken`);
  assert.ok(found.has('api') && found.has('admin'), 'precondition: the scan sees known roots');

  const missing = [...found].filter((root) => !RESERVED_ROUTE_ROOTS.includes(root)).sort();
  assert.deepEqual(missing, [], 'add these to RESERVED_ROUTE_ROOTS in lib/data/referral-links.js');
});
