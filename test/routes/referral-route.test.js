// Tier: route contract (real router + real limiter, faked store) — routes/referrals.js.
//
// WHAT THIS COVERS
// The campaign short-URLs (/columbia, …). This is an UNAUTHENTICATED endpoint whose
// every hit appends a row to the SQLite file auth-store.db lives in, and whose only
// job is to get a stranger to the home page, so the suite pins both halves:
//   - the visitor ALWAYS reaches the home page (302 → /), including when the write
//     is skipped for rate limiting — a 429 here is a stranger seeing an error where
//     the site should be,
//   - the response is uncacheable, or an intermediary would hide every later click,
//   - HEAD (link previewers, health probes) redirects without counting,
//   - an unregistered slug is a plain 404, not a counted hit.
//
// Plus a drift guard on the registry: a slug must not shadow an existing page,
// locale prefix, or API route. `/es` or `/pro` as a campaign slug would take the
// real page off the internet, and nothing else in the app would notice.
//
// RL_REFERRAL is overridden BEFORE the first import of the limiter module — it is a
// module-level singleton built once from the env var — hence the dynamic imports.

import { test, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REFERRAL_LINKS } from '../../lib/data/referral-links.js';
import { LOCALES } from '../../lib/i18n/locales.js';

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
 * Mount the real referral router over an in-memory hit recorder.
 * `realLimiter: true` asks for production wiring (the router falls back to the
 * shared limiter); otherwise a pass-through is injected so unrelated cases don't
 * share one bucket.
 */
async function mount({ realLimiter = false } = {}) {
  /** @type {Array<{slug: string, referer?: string, userAgent?: string}>} */
  const hits = [];
  const referralLinks = {
    links: [{ slug: 'columbia', label: 'Columbia University', note: 'Campus outreach' }],
    recordHit: (arg) => { hits.push(arg); return { ok: true, isBot: false }; },
  };

  const app = express();
  app.use(createReferralRouter({
    referralLinks,
    referralLimiter: realLimiter ? null : (req, res, next) => next(),
  }));
  // Stand-in for the home page, so a followed redirect proves where it lands.
  app.get('/', (req, res) => res.type('html').send('<h1>home</h1>'));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise((r) => server.close(r)),
  };
}

let app;
afterEach(async () => {
  if (app) { await app.close(); app = null; }
});

// ---- The redirect ---------------------------------------------------------

test('/columbia redirects to the home page and counts the arrival', async () => {
  app = await mount();
  const res = await fetch(app.baseUrl + '/columbia', {
    redirect: 'manual',
    headers: { 'user-agent': CHROME, referer: 'https://columbia.edu/housing' },
  });

  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/');
  assert.equal(app.hits.length, 1);
  assert.equal(app.hits[0].slug, 'columbia');
  assert.equal(app.hits[0].referer, 'https://columbia.edu/housing');
  assert.equal(app.hits[0].userAgent, CHROME);
});

test('following the redirect lands on the real home page', async () => {
  app = await mount();
  const res = await fetch(app.baseUrl + '/columbia', { headers: { 'user-agent': CHROME } });
  assert.equal(res.status, 200);
  assert.equal(new URL(res.url).pathname, '/', 'the campaign slug leaves the address bar');
  assert.match(await res.text(), /home/);
});

test('the redirect is uncacheable', async () => {
  // A cached 302 makes the same visitor's later opens invisible, and an
  // intermediary caching it hides everyone behind that intermediary.
  app = await mount();
  const res = await fetch(app.baseUrl + '/columbia', { redirect: 'manual', headers: { 'user-agent': CHROME } });
  assert.match(res.headers.get('cache-control') || '', /no-store/);
});

test('HEAD redirects without counting a visit', async () => {
  app = await mount();
  const res = await fetch(app.baseUrl + '/columbia', { method: 'HEAD', redirect: 'manual', headers: { 'user-agent': CHROME } });
  assert.equal(res.status, 302, 'previewers and probes still get their answer');
  assert.equal(app.hits.length, 0, 'nobody arrives at a page via HEAD');
});

test('an unregistered slug is a plain 404 and records nothing', async () => {
  app = await mount();
  const res = await fetch(app.baseUrl + '/harvard', { redirect: 'manual', headers: { 'user-agent': CHROME } });
  assert.equal(res.status, 404);
  assert.equal(app.hits.length, 0);
});

test('past the rate limit the visitor still reaches the site but the row is dropped', async () => {
  app = await mount({ realLimiter: true });

  for (let i = 0; i < 2; i += 1) {
    const res = await fetch(app.baseUrl + '/columbia', { redirect: 'manual', headers: { 'user-agent': CHROME } });
    assert.equal(res.status, 302);
  }
  assert.equal(app.hits.length, 2, 'RL_REFERRAL=2 requests record normally');

  for (let i = 0; i < 8; i += 1) {
    const res = await fetch(app.baseUrl + '/columbia', { redirect: 'manual', headers: { 'user-agent': CHROME } });
    assert.equal(res.status, 302, 'never 429 — this is a stranger trying to open the site');
    assert.equal(res.headers.get('location'), '/');
  }
  assert.equal(app.hits.length, 2, 'no row is recorded past the limit');
});

// ---- Registry drift guards ------------------------------------------------

test('every configured link gets a route', async () => {
  // Mounts the router over the REAL registry, so a link added to
  // lib/data/referral-links.js without a working route fails here.
  const hits = [];
  const server = express();
  server.use(createReferralRouter({
    referralLinks: { links: REFERRAL_LINKS, recordHit: (a) => { hits.push(a); return { ok: true }; } },
    referralLimiter: (req, res, next) => next(),
  }));
  const listening = await new Promise((resolve) => {
    const s = server.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${listening.address().port}`;
  try {
    for (const link of REFERRAL_LINKS) {
      const res = await fetch(`${base}/${link.slug}`, { redirect: 'manual', headers: { 'user-agent': CHROME } });
      assert.equal(res.status, 302, `/${link.slug} should redirect`);
    }
    assert.equal(hits.length, REFERRAL_LINKS.length, 'each one counted exactly once');
  } finally {
    await new Promise((r) => listening.close(r));
  }
});

test('no slug shadows a static page, a locale prefix, or an existing route', () => {
  // A referral route that shadows a real URL takes that page off the site while
  // still answering 302, so nothing else in the suite would notice.
  const taken = new Set();

  // Anything express.static serves off the root of public/.
  for (const entry of fs.readdirSync(path.join(ROOT, 'public'))) {
    taken.add(entry.toLowerCase());
    taken.add(entry.toLowerCase().replace(/\.html$/, ''));
  }
  // Localized URL prefixes (/es, /fr, …).
  for (const locale of LOCALES) taken.add(locale.prefix);
  // First path segment of every route the other routers register.
  for (const file of ['public.js', 'admin.js', 'auth.js', 'billing.js', 'staging.js', 'chat.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'routes', file), 'utf8');
    for (const m of src.matchAll(/router\.(?:get|post|put|delete|all)\(\s*['"`]\/([^/'"`:)\s]+)/g)) {
      taken.add(m[1].toLowerCase());
    }
  }

  assert.ok(taken.has('index.html') && taken.has('pro') && taken.has('es'), 'precondition: the collision set was actually populated');
  for (const link of REFERRAL_LINKS) {
    assert.equal(taken.has(link.slug), false, `/${link.slug} already means something else on this site`);
  }
});
