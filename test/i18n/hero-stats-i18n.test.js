// Tier: integration — live hero counts on the server-rendered locale pages.
//
// The English homepage and the ten localized ones reach the browser by completely
// different paths (lib/http/text-assets.js vs routes/i18n.js), so "the numbers are in the
// HTML" has to be established twice. This is the second half.
//
// The load-bearing test is the LAST one. lib/i18n/page-renderer.js memoizes each rendered
// page for the process lifetime — that is its documented contract and the reason locale
// pages are cheap. Inject the counts inside the renderer and they are frozen at whatever
// they were on the first request after boot and stay wrong until the next deploy, silently,
// while every other test in the suite still passes. Asserting that a SECOND request picks
// up a MOVED count is the only thing that pins the injection outside that memo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import createI18nRouter from '../../routes/i18n.js';
import { LOCALES } from '../../lib/i18n/locales.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Boot the i18n router alone, with a stat reader the test can move. */
async function serve(t, stats = { roomsStaged: 12345, usersServed: 678 }) {
  const current = { ...stats };
  const app = express();
  app.use(
    createI18nRouter({
      __dirname: ROOT,
      DEBUG_MODE: false,
      blogViews: null,
      readPublicStats: () => ({ ...current }),
    }),
  );

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const { port } = server.address();

  return {
    set: (next) => Object.assign(current, next),
    get: (pathname) =>
      new Promise((resolve, reject) => {
        http
          .get({ hostname: '127.0.0.1', port, path: pathname }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => {
              text += c;
            });
            res.on('end', () => resolve({ status: res.statusCode, etag: res.headers.etag, text }));
          })
          .on('error', reject);
      }),
  };
}

const heroFigure = (body, key) =>
  new RegExp(`<span[^>]*data-stat="${key}"[^>]*>([^<]*)</span>`).exec(body)?.[1];

test('every localized homepage carries both counts', async (t) => {
  const site = await serve(t);
  for (const locale of LOCALES) {
    const res = await site.get(`/${locale.prefix}`);
    assert.equal(res.status, 200, `/${locale.prefix} should render`);
    assert.equal(heroFigure(res.text, 'roomsStaged'), '12,345', `/${locale.prefix}`);
    assert.equal(heroFigure(res.text, 'usersServed'), '678', `/${locale.prefix}`);
  }
});

test('the figures are grouped the same way in every locale', async (t) => {
  // count-up.js formats en-US on every locale; a server-rendered "12.345" in German would
  // flip to "12,345" the moment the animation ran.
  const site = await serve(t);
  const de = await site.get('/de');
  assert.equal(heroFigure(de.text, 'roomsStaged'), '12,345');
});

test('the localized label is still translated around the injected number', async (t) => {
  // The injector edits the figure span; the label span next to it is the renderer's job.
  // This catches an injection that swallowed more markup than it should have.
  const site = await serve(t);
  const es = await site.get('/es');
  assert.match(es.text, /data-lang="hero\.stats\.roomsStaged"[^>]*>[^<]+</);
  assert.doesNotMatch(es.text, /Rooms Staged<\/span>/, '/es still shows the English label');
});

test('a moved count reaches the next request — injection is outside the render memo', async (t) => {
  const site = await serve(t, { roomsStaged: 100, usersServed: 10 });

  const first = await site.get('/es');
  assert.equal(heroFigure(first.text, 'roomsStaged'), '100');

  site.set({ roomsStaged: 101, usersServed: 11 });

  const second = await site.get('/es');
  assert.equal(
    heroFigure(second.text, 'roomsStaged'),
    '101',
    'the page-renderer memo froze the count — inject in serve(), not in the renderer',
  );
  assert.equal(heroFigure(second.text, 'usersServed'), '11');
  assert.notEqual(second.etag, first.etag, 'ETag must move with the body');
});

test('without a stats reader the locale pages render as they did before', async (t) => {
  const app = express();
  app.use(createI18nRouter({ __dirname: ROOT, DEBUG_MODE: false, blogViews: null }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const { port } = server.address();

  const text = await new Promise((resolve, reject) => {
    http
      .get({ hostname: '127.0.0.1', port, path: '/es' }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => resolve(body));
      })
      .on('error', reject);
  });

  assert.match(heroFigure(text, 'roomsStaged') ?? '', /&nbsp;|^$/);
});
