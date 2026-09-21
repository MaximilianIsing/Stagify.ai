// Tier: integration — the two places live counts reach a response.
//
// lib/seo/live-stats.js is tested on its own next door; this file tests that it is
// actually WIRED, on both surfaces, and that wiring it did not break caching:
//
//   - lib/http/text-assets.js, which is what answers English `/` and `/index.html`
//     (express.static never sees them, and routes/public.js's `/` is dead code).
//   - lib/http/llms-txt-asset.js, which substitutes the placeholders in llms.txt.
//
// The ETag assertions are the load-bearing ones. These middlewares send with res.send(),
// so Express derives the ETag from the body it is handed — which is the whole reason the
// injection is safe to do here. If a future refactor moved to sendFile or set an ETag from
// the file's stat, two different bodies would share one ETag and every cache in front of
// the site would serve a stale figure. That is a silent, days-long bug; these two tests
// are what stop it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import express from 'express';
import { createTextAssetMiddleware } from '../../lib/http/text-assets.js';
import { createLlmsTxtMiddleware } from '../../lib/http/llms-txt-asset.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');

/** Boot a throwaway express app on a random port, as the other tests in this folder do. */
function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ port, close: () => server.close() });
    });
  });
}

/**
 * GET over node:http so the request carries exactly the headers the test asked for.
 *
 * @param {number} port
 * @param {string} pathname
 * @param {Record<string, string>} headers
 */
function rawGet(port, pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        text += c;
      });
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          etag: res.headers.etag || null,
          cacheControl: res.headers['cache-control'] || null,
          contentType: res.headers['content-type'] || null,
          text,
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * A throwaway server with a MUTABLE stat reader, so a test can move the counts between
 * two requests — which is the only way to test the ETag behaviour that matters.
 *
 * @param {{roomsStaged: number, usersServed: number} | null} stats null mounts both
 *   middlewares without a reader, i.e. the pre-live-counts behaviour.
 */
async function serve(stats, t) {
  const current = stats ? { ...stats } : null;
  const deps = current ? { readPublicStats: () => ({ ...current }) } : {};

  const app = express();
  app.use(createTextAssetMiddleware(PUBLIC, deps));
  app.use(createLlmsTxtMiddleware(PUBLIC, deps));
  app.use(express.static(PUBLIC));

  const { port, close } = await listen(app);
  t.after(close);

  return {
    set: (next) => Object.assign(current, next),
    // Raw http, not fetch(): undici silently attaches `Cache-Control: no-cache` to any
    // request carrying a manual If-None-Match, and express's req.fresh honours that header
    // by returning false — so every conditional request would come back 200 and the 304
    // assertions below would be vacuous.
    get: (pathname, headers = {}) => rawGet(port, pathname, headers),
  };
}

const heroFigure = (body, key) =>
  new RegExp(`<span[^>]*data-stat="${key}"[^>]*>([^<]*)</span>`).exec(body)?.[1];

test('GET / serves the homepage with both counts already in the markup', async (t) => {
  const site = await serve({ roomsStaged: 12345, usersServed: 678 }, t);
  const res = await site.get('/');

  assert.equal(res.status, 200);
  assert.equal(heroFigure(res.text, 'roomsStaged'), '12,345');
  assert.equal(heroFigure(res.text, 'usersServed'), '678');
  assert.equal(res.cacheControl, 'no-cache');
});

test('GET /index.html gets the same treatment as GET /', async (t) => {
  const site = await serve({ roomsStaged: 12345, usersServed: 678 }, t);
  const res = await site.get('/index.html');
  assert.equal(heroFigure(res.text, 'roomsStaged'), '12,345');
});

test('a page without hero stats is untouched and still served', async (t) => {
  const site = await serve({ roomsStaged: 1, usersServed: 2 }, t);
  const res = await site.get('/about.html');
  assert.equal(res.status, 200);
  assert.ok(!res.text.includes('hp-stat__num'), 'fixture assumption: /about has no hero stats');
});

test('the ETag tracks the counts, so a moved figure is never served from cache', async (t) => {
  const site = await serve({ roomsStaged: 100, usersServed: 10 }, t);

  const first = await site.get('/');
  assert.ok(first.etag, 'no ETag on the homepage response');

  // Same counts -> same body -> a conditional request is correctly a 304.
  const unchanged = await site.get('/', { 'If-None-Match': first.etag });
  assert.equal(unchanged.status, 304);

  site.set({ roomsStaged: 101 });
  const moved = await site.get('/');
  assert.notEqual(moved.etag, first.etag, 'ETag did not change when the count did');
  assert.equal(heroFigure(moved.text, 'roomsStaged'), '101');

  // And the now-stale validator must NOT win.
  const stale = await site.get('/', { 'If-None-Match': first.etag });
  assert.equal(stale.status, 200);
});

test('GET /llms.txt substitutes both figures and leaves no placeholder behind', async (t) => {
  const site = await serve({ roomsStaged: 12345, usersServed: 678 }, t);
  const res = await site.get('/llms.txt');

  assert.equal(res.status, 200);
  assert.match(res.text, /Rooms staged to date: 12,345/);
  assert.match(res.text, /People served[^:]*: 678/);
  assert.ok(!res.text.includes('{{'), 'a placeholder reached the response');
  assert.equal(res.cacheControl, 'no-cache');
  assert.match(res.contentType, /text\/plain/);
});

test('llms.txt ETag tracks the counts too', async (t) => {
  const site = await serve({ roomsStaged: 100, usersServed: 10 }, t);
  const first = await site.get('/llms.txt');
  site.set({ usersServed: 11 });
  const second = await site.get('/llms.txt');
  assert.notEqual(second.etag, first.etag);
});

test('without a stats reader both middlewares behave exactly as before', async (t) => {
  // The optional-dependency contract: lib/http/not-found.js and the older route tests
  // mount these without a reader and must keep working.
  const site = await serve(null, t);

  const home = await site.get('/');
  assert.equal(home.status, 200);
  assert.match(heroFigure(home.text, 'roomsStaged') ?? '', /&nbsp;|^$/);

  const llms = await site.get('/llms.txt');
  assert.ok(llms.text.includes('{{ROOMS_STAGED}}'), 'static file should still carry the token');
});
