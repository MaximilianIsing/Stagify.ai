// Tier: route (routes/admin/blog.js) — the console's blog-readership endpoint.
//
// The counting itself is covered by test/data/blog-views.test.js and the article
// scan by test/content/blog-posts.test.js. What is at stake HERE is the HTTP edge:
//
//   - **The guard.** Readership is operator data on a private console; every request
//     without the credential must be refused, before the store is touched.
//   - **A bad window is not an error.** `days` is an operator typing in a URL bar;
//     the useful answer is the default window, not a 400 they have to interpret.
//   - **A missing counter degrades, it does not 503.** The tab should still list the
//     articles and say the counter is off, rather than showing an error.
//   - **The two halves are joined here** — the catalog scanned from public/blog and
//     the counts from the store — so the endpoint is where "every article appears,
//     even one nobody has read" is actually guaranteed.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdminBlogRouter } from '../../routes/admin/blog.js';

const KEY = 'test-endpoint-key';
const auth = { 'X-Stagify-Endpoint-Key': KEY };
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every server opened by a test, so none is left holding the runner open. */
const servers = [];
afterEach(() => { while (servers.length) servers.pop().close(); });

/** A stand-in store that records the options it was handed. */
function makeViews(payload) {
  const calls = [];
  return {
    calls,
    summary(opts) {
      calls.push(opts);
      return typeof payload === 'function' ? payload(opts) : payload;
    },
  };
}

/** The shape lib/data/blog-views.js returns, reduced to what the route passes through. */
const shaped = (opts) => ({
  generatedAt: 1750000000000,
  days: opts.days,
  totals: { posts: opts.posts.length, views: 12, botHits: 4, windowViews: 5, unread: 1, series: [] },
  posts: opts.posts.map((p) => ({ ...p, views: 6, windowViews: 3 })),
});

async function mount({ blogViews = makeViews(shaped) } = {}) {
  const app = express();
  const protectLogs = (req, res, next) => (
    req.get('X-Stagify-Endpoint-Key') === KEY ? next() : res.status(403).json({ error: 'Forbidden' })
  );
  app.use(createAdminBlogRouter({ blogViews, protectLogs, __dirname: REPO_ROOT }));
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  servers.push(srv);
  return { base: `http://127.0.0.1:${srv.address().port}`, views: blogViews };
}

// ── The guard ───────────────────────────────────────────────────────────────

test('without the operator credential the endpoint refuses, and never reaches the store', async () => {
  const views = makeViews(shaped);
  const { base } = await mount({ blogViews: views });

  const res = await fetch(`${base}/api/admin/blog-views`);
  assert.equal(res.status, 403);
  assert.equal(views.calls.length, 0, 'the guard runs before anything is read');
});

// ── The payload ─────────────────────────────────────────────────────────────

test('with the credential it answers the real article catalog joined to the counts', async () => {
  const { base, views } = await mount();
  const res = await fetch(`${base}/api/admin/blog-views`, { headers: auth });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.configured, true);
  assert.equal(body.days, 30, 'the default window');
  // The catalog is scanned from the real public/blog, so every published article is
  // a row whether or not anyone has opened it.
  const handed = views.calls[0].posts;
  assert.ok(handed.length >= 14, `expected the real articles, got ${handed.length}`);
  assert.ok(handed.every((p) => p.slug && p.title && p.path.startsWith('/blog/')));
  assert.equal(body.posts.length, handed.length);
});

test('a window can be asked for, and a nonsense one is clamped rather than refused', async () => {
  const { base, views } = await mount();

  for (const [asked, expected] of [['7', 7], ['90', 90], ['9999', 365], ['0', 7], ['banana', 30]]) {
    const res = await fetch(`${base}/api/admin/blog-views?days=${asked}`, { headers: auth });
    assert.equal(res.status, 200, `days=${asked} must not be an error`);
    const body = await res.json();
    assert.equal(body.days, expected, `days=${asked}`);
  }
  assert.equal(views.calls.length, 5);
});

// ── Degradation ─────────────────────────────────────────────────────────────

test('with no counter configured it still lists the articles and says so', async () => {
  const { base } = await mount({ blogViews: null });
  const res = await fetch(`${base}/api/admin/blog-views`, { headers: auth });
  const body = await res.json();

  assert.equal(res.status, 200, 'a missing counter is not a server error');
  assert.equal(body.configured, false);
  assert.ok(body.totals.posts >= 14, 'the catalog is still reported');
  assert.equal(body.totals.views, 0);
  assert.equal(body.totals.unread, body.totals.posts);
});

test('a store that throws becomes a 500 with a reference, not a stack trace', async () => {
  const { base } = await mount({ blogViews: { summary: () => { throw new Error('db is gone'); } } });
  const res = await fetch(`${base}/api/admin/blog-views`, { headers: auth });
  const body = await res.json();

  assert.equal(res.status, 500);
  assert.match(body.error, /blog readership/i);
  assert.equal(String(JSON.stringify(body)).includes('db is gone'), false, 'the internal message stays internal');
});
