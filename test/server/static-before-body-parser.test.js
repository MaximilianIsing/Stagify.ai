// Tier: drift guard — middleware ORDER in lib/http/app-middleware.js, and the cache
// header on the HTML routes that bypass express.static.
//
// WHY THIS EXISTS.
//
// 1. STATIC BEFORE THE BODY PARSER. applyBodyAndStatic() mounts express.static first
//    and express.json second. Every request for a .css/.webp/.woff2/.mp4 would
//    otherwise walk the JSON body parser and the limitKey() regex before reaching the
//    file, on a path where there is never a JSON body to parse — and static assets are
//    most of this site's traffic. Swapping the two back is invisible: every test stays
//    green, every response is byte-identical, and the only symptom is per-asset work
//    nobody sees. That is exactly the kind of regression a source-order guard is for.
//
// 2. THE sendFile ROUTES SET A CACHE HEADER. The `setHeaders` callback in
//    app-middleware.js only runs for files express.static itself serves. routes/public.js
//    reaches around it with res.sendFile for `/`, `/privacy`, `/status`, the sitemap,
//    robots.txt and all ten blog articles — those fell back to sendFile's default,
//    `Cache-Control: public, max-age=0`, rather than the `no-cache` that
//    docs/reference/caching.md documents for every .html response. `/` is the homepage.
//
// Both scans run over COMMENT-STRIPPED source: both facts are explained in prose right
// next to the code that implements them, so a naive text scan would match the
// explanation and keep passing after the code was deleted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripJsComments as stripComments } from '../helpers/strip-js-comments.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const middleware = stripComments(
  fs.readFileSync(path.join(ROOT, 'lib', 'http', 'app-middleware.js'), 'utf8'),
);
const publicRoutes = stripComments(
  fs.readFileSync(path.join(ROOT, 'routes', 'public.js'), 'utf8'),
);

test('express.static is mounted before the JSON body parser', () => {
  const staticAt = middleware.indexOf('express.static(');
  const jsonAt = middleware.indexOf('express.json(');

  assert.notEqual(staticAt, -1, 'express.static( not found — did applyBodyAndStatic move?');
  assert.notEqual(jsonAt, -1, 'express.json( not found — did applyBodyAndStatic move?');
  assert.ok(
    staticAt < jsonAt,
    'express.static must be mounted BEFORE express.json, so static assets skip body parsing',
  );
});

test('the static handler still sets the documented Cache-Control policy', () => {
  // Reordering is only safe if it was a pure move. These are the four buckets
  // docs/reference/caching.md describes; losing one during a refactor would silently
  // drop a year of caching on every image or font.
  assert.match(middleware, /\\.\(html\|css\|js\|json\)/, 'the no-cache bucket must survive');
  assert.match(middleware, /woff2\?\|ttf/, 'the font bucket must survive');
  assert.match(middleware, /png\|jpe\?g\|webp/, 'the image bucket must survive');
  assert.match(middleware, /mp4\|webm/, 'the media bucket must survive');
  assert.equal(
    (middleware.match(/max-age=31536000, immutable/g) || []).length,
    3,
    'all three immutable buckets must survive the reorder',
  );
});

test('every HTML/document route in routes/public.js goes through sendPage', () => {
  // sendPage sets Cache-Control before delegating to res.sendFile. A bare res.sendFile
  // for a document is the bug this guards: it silently reverts that route to
  // `public, max-age=0`.
  assert.match(
    publicRoutes,
    /const sendPage = \(res, file\) => \{\s*res\.setHeader\('Cache-Control', 'no-cache'\);/,
    'sendPage must set no-cache before sending',
  );

  // The eleven blog articles plus /, /privacy, /status, robots.txt and sitemap.xml.
  const sendPageCalls = (publicRoutes.match(/sendPage\(res,/g) || []).length;
  assert.equal(sendPageCalls, 16, `expected 16 sendPage() call sites, found ${sendPageCalls}`);

  // The remaining bare res.sendFile calls are deliberate, and each one is a NON-document
  // response that already owns its caching:
  //   1. inside sendPage itself — the one that sets the header
  //   2. /bimi-logo.svg   — an image; express.static shadows this route anyway
  //   3. /i/:id           — hosted images, which set their own headers
  //   4. /email/logo.png  — the open-tracking pixel, explicitly no-store/must-revalidate
  // A fifth means a new document route probably skipped sendPage and silently reverted
  // to sendFile's `public, max-age=0`.
  const bare = (publicRoutes.match(/res\.sendFile\(/g) || []).length;
  assert.equal(
    bare,
    4,
    `${bare} bare res.sendFile calls in routes/public.js (expected 4) — a new document route should use sendPage`,
  );
});

test('the /getpro and /admin pages keep their stricter no-store policy', () => {
  // These two deliberately do NOT use the no-cache path: setSensitiveHeaders() sets
  // no-store, which is stronger, and downgrading them to no-cache would let a grant
  // page and the admin shell be stored. Pinned so a well-meaning "make it consistent"
  // sweep cannot quietly relax them.
  for (const [file, route] of [['auth.js', '/getpro'], ['admin.js', '/admin']]) {
    const src = stripComments(fs.readFileSync(path.join(ROOT, 'routes', file), 'utf8'));
    const at = src.indexOf(`router.get('${route}'`);
    assert.notEqual(at, -1, `${route} route not found in routes/${file}`);
    const body = src.slice(at, at + 240);
    assert.match(body, /setSensitiveHeaders\(res\)/, `${route} must keep setSensitiveHeaders`);
    assert.doesNotMatch(body, /'no-cache'/, `${route} must not be downgraded to no-cache`);
  }
});
