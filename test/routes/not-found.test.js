// The terminal 404 handler (lib/http/not-found.js).
//
// Boots the REAL server.js via the shared harness rather than mounting a bare
// express() app the way most test/routes specs do. That is deliberate: this handler
// is defined by its position — dead last, after express.static, after every router,
// after routes/referrals.js's `/:slug`. A hand-built app with one middleware in it
// would pass these assertions while proving nothing about the pipeline that ships.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server.js';
import { LOCALES } from '../../lib/i18n/locales.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', '..', 'public');

/** A path no route claims and no static file matches, at each depth that matters. */
const MISSING = '/definitely-not-a-real-page-9f3a';

/** @param {string} lang */
function pack(lang) {
  return JSON.parse(fs.readFileSync(path.join(PUBLIC, 'languages', `${lang}.json`), 'utf8'));
}

let server;
before(async () => { server = await startServer(); });
after(() => server?.close());

/** @param {string} p @param {RequestInit} [opts] */
const get = (p, opts) => fetch(`${server.baseUrl}${p}`, opts);

// ── The HTML page ───────────────────────────────────────────────────────────

test('an unknown path returns a 404 with the branded HTML page', async () => {
  const res = await get(MISSING);
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') || '', /text\/html/);

  const html = await res.text();
  assert.ok(html.includes(pack('english').notFound.heading), 'the English 404 copy is missing');
  assert.match(html, /<header class="site-header">/, 'the 404 page lost the site nav');
});

test('the status is 404 at every path depth, not just the top level', async () => {
  // The handler is reached differently at each depth: a single segment passes
  // through routes/referrals.js's /:slug first, two segments look like a locale
  // page, and /blog/… sits under a real directory.
  for (const p of [MISSING, `/blog${MISSING}`, `/a/b/c${MISSING}`]) {
    const res = await get(p);
    assert.equal(res.status, 404, `${p} should 404`);
    assert.match(res.headers.get('content-type') || '', /text\/html/, `${p} should be HTML`);
  }
});

test('the page carries <base href="/"> so its relative assets resolve at any depth', async () => {
  // 404.html's asset URLs are relative (styles/styles.css, scripts/…), copied from
  // status.html. Without the base tag a 404 at /blog/nope resolves them against
  // /blog/ and the page renders unstyled and scriptless. This is the whole reason
  // the English response goes through renderLocalizedPage instead of sendFile.
  const html = await get(`/blog${MISSING}`).then((r) => r.text());
  assert.ok(html.includes('<base href="/">'), 'the base tag is gone — nested 404s will render unstyled');
  assert.ok(html.includes('href="styles/not-found.css"'), 'precondition: the sheet is still linked relatively');
});

test('the 404 page advertises no canonical and no hreflang alternates', async () => {
  // A dead end has no canonical address, and eleven localized variants of one is
  // worse than useless. test/i18n/delocalized-pages.test.js guards the source file;
  // this guards what the renderer actually emits, which is where the cluster would
  // be injected if someone added a canonical tag back.
  for (const p of [MISSING, `/es${MISSING}`]) {
    const html = await get(p).then((r) => r.text());
    assert.ok(!/rel="alternate"\s+hreflang/i.test(html), `${p} emits hreflang alternates`);
    assert.ok(!/<link\s+rel="canonical"/i.test(html), `${p} emits a canonical URL`);
  }
});

test('the page is noindex', async () => {
  const html = await get(MISSING).then((r) => r.text());
  assert.match(html, /<meta name="robots" content="noindex/i);
});

// ── Localization ────────────────────────────────────────────────────────────

test('every locale prefix serves the 404 page in that language', async () => {
  // Every locale, not a sampled one — the prefix→locale resolution is a lookup over
  // the whole LOCALES table and a table with one bad row is exactly what a
  // spot-check misses.
  for (const locale of LOCALES) {
    const res = await get(`/${locale.prefix}${MISSING}`);
    assert.equal(res.status, 404, `/${locale.prefix}${MISSING} should 404`);

    const html = await res.text();
    assert.match(html, new RegExp(`<html[^>]*\\blang="${locale.bcp47}"`),
      `/${locale.prefix}${MISSING}: wrong <html lang>`);
    assert.ok(html.includes(pack(locale.lang).notFound.heading),
      `/${locale.prefix}${MISSING}: the page is not in ${locale.lang}`);
  }
});

test('a first segment that merely starts like a prefix stays English', async () => {
  // 'es' is a locale; 'esperanto' is not. A startsWith() check instead of an exact
  // segment match would serve Spanish here.
  const html = await get('/esperanto-not-a-locale/x').then((r) => r.text());
  assert.ok(html.includes(pack('english').notFound.heading), 'a non-prefix segment was treated as a locale');
});

// ── The JSON branch ─────────────────────────────────────────────────────────

test('an unknown /api/ route returns JSON, not a page of markup', async () => {
  const res = await get('/api/definitely-not-a-route');
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  assert.deepEqual(await res.json(), { error: 'Not found' });
});

test('a client that does not accept HTML gets JSON even off /api', async () => {
  const res = await get(MISSING, { headers: { Accept: 'application/json' } });
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
});

test('a non-GET request to an unknown path 404s rather than hanging', async () => {
  const res = await get(MISSING, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 404);
});

// ── Regressions: the handler must not shadow anything ───────────────────────

test('real pages, localized pages and static files are unaffected', async () => {
  // The failure mode of a terminal catch-all is not that it 404s too little, it is
  // that a mount-order slip puts it in front of something real.
  for (const p of ['/', '/status', '/guides.html', '/es', '/es/guides.html', '/styles/styles.css']) {
    const res = await get(p);
    assert.equal(res.status, 200, `${p} should still be served, got ${res.status}`);
  }
});

test('the retired localized legal URLs still 301 rather than hitting the 404', async () => {
  // routes/i18n.js redirects these precisely because there was no custom 404. Now
  // that there is one, a lost redirect would fail silently as a nice-looking page.
  const res = await get('/de/terms.html', { redirect: 'manual' });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/terms.html');
});
