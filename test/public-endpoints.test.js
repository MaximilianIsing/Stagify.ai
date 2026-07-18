// Cheap public-surface smoke test — no auth, no AI, no secrets.
//
// Boots the server once and hits every no-auth route to catch routing regressions,
// broken JSON shapes, static-serving breakage, and a missing security header. These
// are the pages/endpoints anonymous visitors hit, so a regression here is very visible.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

let server;
before(async () => { server = await startServer(); });
after(() => server?.close());

const get = (p) => fetch(`${server.baseUrl}${p}`);

test('public JSON endpoints return their expected shape', async () => {
  const health = await get('/api/health');
  assert.equal(health.status, 200);
  const h = await health.json();
  assert.equal(h.status, 'healthy');
  assert.ok('aiConfigured' in h, 'health should report aiConfigured');

  const cfg = await get('/api/auth/config');
  assert.equal(cfg.status, 200);
  const c = await cfg.json();
  assert.ok('googleClientId' in c, 'config should expose googleClientId');
  assert.equal(typeof c.isStaging, 'boolean', 'config should expose isStaging');

  // These counters can read as undefined on a fresh boot (no log files yet), and JSON
  // drops undefined keys — so assert the endpoints are wired and return an object,
  // rather than asserting a specific value type.
  const promptsRes = await get('/api/prompt-count');
  assert.equal(promptsRes.status, 200);
  assert.equal(typeof (await promptsRes.json()), 'object', 'prompt-count returns JSON');

  const contactsRes = await get('/api/contact-count');
  assert.equal(contactsRes.status, 200);
  assert.equal(typeof (await contactsRes.json()), 'object', 'contact-count returns JSON');
});

test('SEO and landing routes serve their files', async () => {
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type') || '', /text\/html/);
  assert.match((await home.text()).toLowerCase(), /<html/, 'GET / should serve the HTML page');

  const robots = await get('/robots.txt');
  assert.equal(robots.status, 200);
  assert.match((await robots.text()).toLowerCase(), /user-agent|sitemap/, 'robots.txt content');

  const sitemap = await get('/sitemap.xml');
  assert.equal(sitemap.status, 200);
  assert.match(await sitemap.text(), /<urlset/, 'sitemap.xml content');
});

test('blog hub and articles are served, and stay in sync with the sitemap', async () => {
  // The hub is served as a static directory index at /blog/; bare /blog 301-redirects to it.
  const bare = await fetch(`${server.baseUrl}/blog`, { redirect: 'manual' });
  assert.equal(bare.status, 301, '/blog should 301-redirect to /blog/');

  const hub = await get('/blog/');
  assert.equal(hub.status, 200);
  assert.match(await hub.text(), /The Stagify Blog/, 'GET /blog/ should serve the hub page');

  // Each article has an explicit clean, extensionless route in routes/public.js. A 404
  // here means a route was removed/renamed (the "Cannot GET /blog/<slug>" failure mode).
  const articles = [
    '/blog/is-virtual-staging-allowed-on-the-mls',
    '/blog/masking-studio-and-ai-designer',
    '/blog/does-virtual-staging-help-sell-homes',
  ];
  for (const p of articles) {
    const res = await get(p);
    assert.equal(res.status, 200, `${p} should serve 200 (route registered)`);
    assert.match(res.headers.get('content-type') || '', /text\/html/, `${p} content-type`);
    assert.match(await res.text(), /class="article-title"/, `${p} should serve the article page`);
  }

  // Guard against route/sitemap drift: every article route must also be listed in the sitemap.
  const map = await (await get('/sitemap.xml')).text();
  assert.ok(map.includes('https://stagify.ai/blog/'), 'sitemap should list the blog hub');
  for (const p of articles) {
    assert.ok(map.includes(`https://stagify.ai${p}`), `sitemap should list ${p}`);
  }
});

test('static assets are served with the right content type', async () => {
  const js = await get('/scripts/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') || '', /javascript/);

  const css = await get('/styles/styles.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') || '', /css/);
});

test('unknown routes 404, and /api/auth/me requires a session', async () => {
  assert.equal((await get('/definitely-not-a-real-path-xyz')).status, 404);

  const me = await get('/api/auth/me');
  assert.equal(me.status, 401);
  assert.equal((await me.json()).code, 'AUTH_REQUIRED');
});

test('a security header is applied (helmet)', async () => {
  const res = await get('/');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff', 'expected helmet nosniff header');
});
