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
