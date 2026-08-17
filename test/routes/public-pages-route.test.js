// The public router's document and counter routes — the ~23 handlers nothing exercised.
//
// WHY THESE ARE WORTH TESTING, beyond the coverage floor they were dragging down:
//
//   • THE BLOG ROUTES ARE HAND-WRITTEN URL→FILE MAPPINGS. Every article is a separate
//     `router.get('/blog/slug', … sendPage(…, 'slug.html'))` pair, and the two halves are
//     typed independently. A typo, or a renamed/deleted HTML file, is a 404 on a live,
//     indexed article — and it fails in production only, because nothing here or in
//     express.static would notice at boot. `docs` calls adding an article a 5-step
//     checklist; this is the step that checks the other four landed.
//
//   • `sendPage` EXISTS TO SET A HEADER. Its own comment explains that these routes bypass
//     the `setHeaders` hook in app-middleware.js (that hook only runs for files
//     express.static itself serves), so without it they fall back to `max-age=0`, which a
//     shared cache may serve without revalidating — on the homepage. A regression here is
//     invisible to every other test in the suite.
//
//   • `/i/:id` SERVES USER-UPLOADED BYTES from a filesystem path built out of a manifest
//     lookup. Its id guard is the thing standing between a request and path traversal.
//
// Driven through a REAL express app on a real socket, matching contact-log-route.test.js —
// route params, query parsing and header handling all behave as they do in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createPublicRouter from '../../routes/public.js';

const pass = (req, res, next) => next();
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Mount the public router on a real server.
 * @param {{ __dirname?: string, hostedDir?: string, manifest?: any[], stats?: object }} [opts]
 */
async function mount(opts = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(
    createPublicRouter({
      resend: { emails: { send: async () => ({ data: { id: 'x' }, error: null }) } },
      LOGS_ACCESS_KEY: 'k',
      endpointKeyMatches: (a, b) => a === b,
      emailLimiter: pass,
      emailPixelLimiter: pass,
      RESEND_FROM_EMAIL: 'noreply@stagify.ai',
      DEBUG_MODE: false,
      EMAIL_DEBUG_MODE: false,
      DEBUG_EMAIL: 'debug@stagify.ai',
      authStore: { getUserCount: () => 7 },
      uptimeMonitor: { getSnapshot: () => ({ up: true, checks: 3 }) },
      STATS_DEBUG: false,
      DEBUG_ROOMS: 0,
      DEBUG_USERS: 0,
      getHostedImagesDir: () => opts.hostedDir || '',
      readHostedImagesManifest: () => opts.manifest || [],
      logEmailOpenToFile: () => {},
      isConfirmedEmailClientOpen: () => false,
      healthHandler: (req, res) => res.json({ ok: true }),
      getPromptCount: () => 42,
      getContactCount: () => 11,
      incContactCount: () => {},
      // Real repo root by default, so `res.sendFile` resolves the ACTUAL public/ documents
      // and a missing file surfaces as a 404 rather than passing against a stub.
      __dirname: opts.__dirname || REPO_ROOT,
      ...(opts.stats || {}),
    }),
  );
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const { port } = /** @type {any} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => r(undefined))),
  };
}

// Every URL this router maps to a document, paired with the file it must resolve to.
// Kept as data so a new blog article is one row here, and so the two assertions below
// (route answers 200 / file exists on disk) read off the same list.
const DOCUMENT_ROUTES = [
  ['/robots.txt', 'robots.txt', 'text/plain'],
  ['/sitemap.xml', 'sitemap.xml', 'application/xml'],
  ['/', 'index.html', 'text/html'],
  ['/privacy', 'privacy.html', 'text/html'],
  ['/status', 'status.html', 'text/html'],
  ['/blog/is-virtual-staging-allowed-on-the-mls', 'blog/is-virtual-staging-allowed-on-the-mls.html', 'text/html'],
  ['/blog/masking-studio-and-ai-designer', 'blog/masking-studio-and-ai-designer.html', 'text/html'],
  ['/blog/does-virtual-staging-help-sell-homes', 'blog/does-virtual-staging-help-sell-homes.html', 'text/html'],
  ['/blog/stagify-vs-other-virtual-staging-tools', 'blog/stagify-vs-other-virtual-staging-tools.html', 'text/html'],
  ['/blog/top-10-ai-virtual-staging-sites-2026', 'blog/top-10-ai-virtual-staging-sites-2026.html', 'text/html'],
  ['/blog/dorm-room-design-ai-college-freshmen', 'blog/dorm-room-design-ai-college-freshmen.html', 'text/html'],
  ['/blog/prepare-your-listing-for-the-fall-market', 'blog/prepare-your-listing-for-the-fall-market.html', 'text/html'],
  ['/blog/curb-appeal-real-estate-photos', 'blog/curb-appeal-real-estate-photos.html', 'text/html'],
  ['/blog/free-virtual-staging', 'blog/free-virtual-staging.html', 'text/html'],
  ['/blog/virtual-staging-disclosure-laws-by-state', 'blog/virtual-staging-disclosure-laws-by-state.html', 'text/html'],
  ['/blog/fsbo-listing-photos', 'blog/fsbo-listing-photos.html', 'text/html'],
  ['/blog/new-construction-listing-photos', 'blog/new-construction-listing-photos.html', 'text/html'],
];

test('every document route serves its file, with the no-cache policy sendPage exists for', async (t) => {
  const srv = await mount();
  t.after(() => srv.close());

  for (const [url, , type] of DOCUMENT_ROUTES) {
    const res = await fetch(srv.url + url);
    assert.equal(res.status, 200, `${url} must serve a document (got ${res.status})`);
    assert.match(res.headers.get('content-type') || '', new RegExp(type.replace('+', '\\+')), `${url} content-type`);
    // The whole reason sendPage is a function rather than a bare res.sendFile.
    assert.equal(
      res.headers.get('cache-control'), 'no-cache',
      `${url} must carry the documented no-cache policy, not sendFile's max-age=0 default`,
    );
    await res.arrayBuffer();
  }
});

test('every blog route points at an HTML file that actually exists', async () => {
  // The route table and the filesystem are edited independently, so this is the only place
  // the two are compared. A renamed article passes every other test in the suite and 404s
  // for real readers, on a URL search engines have already indexed.
  const missing = DOCUMENT_ROUTES
    .map(([url, file]) => ({ url, file, abs: path.join(REPO_ROOT, 'public', file) }))
    .filter(({ abs }) => !fs.existsSync(abs));
  assert.deepEqual(missing.map((m) => `${m.url} -> public/${m.file}`), [], 'routes pointing at files that do not exist');
});

test('the BIMI logo route serves an SVG', async (t) => {
  // Reachable only if express.static has not already answered — which in production it has.
  // Tested anyway because the handler exists and is mounted; if it is ever deliberately
  // removed, this fails and says so out loud rather than the route rotting in place.
  const srv = await mount();
  t.after(() => srv.close());
  const res = await fetch(srv.url + '/bimi-logo.svg');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /image\/svg\+xml/);
  await res.arrayBuffer();
});

// ---- /i/:id — hosted images -------------------------------------------------

test('/i/:id rejects any id that is not a plain hex handle', async (t) => {
  // The guard runs BEFORE the manifest lookup and before any path is built, which is what
  // keeps a traversal attempt from ever reaching path.join.
  const srv = await mount({ manifest: [{ id: 'a'.repeat(32), file: 'x.png', mime: 'image/png' }] });
  t.after(() => srv.close());

  for (const bad of ['../../etc/passwd', 'short', 'NOTHEX' + 'a'.repeat(26), 'a'.repeat(65), '']) {
    const res = await fetch(srv.url + '/i/' + encodeURIComponent(bad));
    assert.equal(res.status, 404, `"${bad}" must be refused`);
    await res.text();
  }
});

test('/i/:id 404s on a well-formed id that is not in the manifest', async (t) => {
  const srv = await mount({ manifest: [] });
  t.after(() => srv.close());
  const res = await fetch(srv.url + '/i/' + 'b'.repeat(32));
  assert.equal(res.status, 404);
  await res.text();
});

test('/i/:id 404s when the manifest names a file that is gone', async (t) => {
  // The manifest is a JSON file on the same volume; an entry can outlive its bytes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-hosted-'));
  const srv = await mount({ hostedDir: dir, manifest: [{ id: 'c'.repeat(32), file: 'missing.png', mime: 'image/png' }] });
  t.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const res = await fetch(srv.url + '/i/' + 'c'.repeat(32));
  assert.equal(res.status, 404);
  await res.text();
});

test('/i/:id serves a hosted image immutably, with nosniff and inline disposition', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-hosted-'));
  fs.writeFileSync(path.join(dir, 'shot.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const id = 'd'.repeat(40);
  const srv = await mount({ hostedDir: dir, manifest: [{ id, file: 'shot.png', mime: 'image/png' }] });
  t.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const res = await fetch(srv.url + '/i/' + id);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  // These URLs are content-addressed, so the bytes behind one can never change.
  assert.match(res.headers.get('cache-control') || '', /immutable/);
  // Served bytes are user-supplied: the browser must not be allowed to re-sniff the type,
  // and must not be talked into downloading it as something executable.
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-disposition'), 'inline');
  await res.arrayBuffer();
});

test('/i/:id falls back to a neutral content type when the manifest entry has none', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-hosted-'));
  fs.writeFileSync(path.join(dir, 'blob.bin'), 'bytes');
  const id = 'e'.repeat(32);
  const srv = await mount({ hostedDir: dir, manifest: [{ id, file: 'blob.bin' }] });
  t.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const res = await fetch(srv.url + '/i/' + id);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  await res.arrayBuffer();
});

// ---- The counter + status endpoints ----------------------------------------

test('/api/status returns the uptime snapshot and is never cached', async (t) => {
  const srv = await mount();
  t.after(() => srv.close());
  const res = await fetch(srv.url + '/api/status');
  assert.equal(res.headers.get('cache-control'), 'no-store', 'a cached status page reports the wrong thing');
  assert.deepEqual(await res.json(), { up: true, checks: 3 });
});

test('/health and /api/health both reach the injected health handler', async (t) => {
  const srv = await mount();
  t.after(() => srv.close());
  for (const url of ['/health', '/api/health']) {
    assert.deepEqual(await (await fetch(srv.url + url)).json(), { ok: true }, `${url} is mounted`);
  }
});

test('/api/prompt-count and /api/contact-count report the real counters', async (t) => {
  const srv = await mount();
  t.after(() => srv.close());

  assert.deepEqual(await (await fetch(srv.url + '/api/prompt-count')).json(), { promptCount: 42 });
  // usersServed is the sum the homepage renders — pinned because it is derived, so a change
  // to either half silently moves a number the marketing copy quotes.
  assert.deepEqual(await (await fetch(srv.url + '/api/contact-count')).json(), {
    contactCount: 11, userCount: 7, usersServed: 18,
  });
});

test('the STATS_DEBUG overrides replace the counters, and only when finite', async () => {
  const on = await mount({ stats: { STATS_DEBUG: true, DEBUG_ROOMS: 9000, DEBUG_USERS: 1234 } });
  assert.deepEqual(await (await fetch(on.url + '/api/prompt-count')).json(), { promptCount: 9000 });
  assert.deepEqual(await (await fetch(on.url + '/api/contact-count')).json(), { usersServed: 1234 });
  await on.close();

  // A non-finite override must fall through to the real counters rather than emitting NaN
  // into the JSON, where it would serialize as null and render as a blank stat.
  const bad = await mount({ stats: { STATS_DEBUG: true, DEBUG_ROOMS: NaN, DEBUG_USERS: NaN } });
  assert.deepEqual(await (await fetch(bad.url + '/api/prompt-count')).json(), { promptCount: 42 });
  assert.equal((await (await fetch(bad.url + '/api/contact-count')).json()).usersServed, 18);
  await bad.close();
});
