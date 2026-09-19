// Tier: unit — the short vanity URLs in lib/http/vanity-redirects.js.
//
// WHAT THIS IS REALLY GUARDING
// Not the redirect itself, which is four lines — the ORDER it is mounted in. /brand is
// a vanity alias for a section of /about, but public/brand/ is also a real directory
// full of downloadable files, so express.static answers directory requests with its own
// 301 to /brand/ before any router runs. Mounted after the static middleware this
// feature is dead code that 404s, and it would look correct in review. The last test
// below pins the mount point in server.js for exactly that reason.
//
// The other half is that claiming /brand must not claim the files underneath it. A
// glob or a `startsWith` here would send /brand/stagify-brand-kit.zip to an HTML page.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VANITY_REDIRECTS, vanityRedirect } from '../../lib/http/vanity-redirects.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Minimal req/res pair: records what the middleware did instead of doing it. */
function call(method, reqPath) {
  const result = { headers: {}, status: null, location: null, nexted: false };
  vanityRedirect(
    { method, path: reqPath },
    {
      set: (k, v) => { result.headers[k] = v; },
      redirect: (code, url) => { result.status = code; result.location = url; },
    },
    () => { result.nexted = true; },
  );
  return result;
}

test('/brand sends you to the brand kit, with or without the trailing slash', () => {
  for (const reqPath of ['/brand', '/brand/']) {
    const res = call('GET', reqPath);
    assert.equal(res.status, 301, `${reqPath} should redirect permanently`);
    assert.equal(res.location, '/about.html#brand-kit');
    assert.equal(res.nexted, false);
  }
});

test('the fragment is part of the Location, or the alias lands on the wrong section', () => {
  // /about is a long page; without #brand-kit the reader arrives at the hero and has
  // to scroll past the FAQ to find what they followed the link for.
  for (const target of Object.values(VANITY_REDIRECTS)) {
    assert.match(target, /#/, `${target} has no fragment`);
  }
});

test('a HEAD is redirected too, a POST is not', () => {
  assert.equal(call('HEAD', '/brand').status, 301);

  const posted = call('POST', '/brand');
  assert.equal(posted.nexted, true, 'a POST should fall through, not be turned into a GET');
  assert.equal(posted.status, null);
});

test('the files under public/brand/ are left alone', () => {
  // Only exact paths are claimed. Anything deeper has to reach express.static.
  for (const reqPath of ['/brand/stagify-brand-kit.zip', '/brand/stagify-icon.svg', '/brand/README.txt', '/branding']) {
    const res = call('GET', reqPath);
    assert.equal(res.nexted, true, `${reqPath} must fall through to the static middleware`);
    assert.equal(res.status, null);
  }
});

test('the redirect is cached, but not forever', () => {
  // A bare 301 is cached by browsers indefinitely; if /brand ever becomes its own
  // page, anybody who followed the alias once would keep being bounced to /about.
  const res = call('GET', '/brand');
  assert.match(res.headers['Cache-Control'], /max-age=\d+/);
  const maxAge = Number(res.headers['Cache-Control'].match(/max-age=(\d+)/)[1]);
  assert.ok(maxAge > 0 && maxAge <= 86400, `expected a short cache, got ${maxAge}s`);
});

test('it is mounted ahead of the static middleware in server.js', () => {
  // The whole feature depends on this ordering — see the header of this file.
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const vanity = server.indexOf('applyVanityRedirects(app)');
  const statics = server.indexOf('applyBodyAndStatic(app)');
  assert.ok(vanity > 0, 'server.js no longer mounts the vanity redirects');
  assert.ok(statics > 0, 'server.js no longer mounts the static middleware');
  assert.ok(
    vanity < statics,
    'applyVanityRedirects must run BEFORE applyBodyAndStatic, or express.static answers /brand first',
  );
});

test('every target resolves to something that exists', () => {
  for (const target of Object.values(VANITY_REDIRECTS)) {
    const file = target.split('#')[0].replace(/^\//, '');
    assert.ok(
      fs.existsSync(path.join(ROOT, 'public', file)),
      `${target} points at public/${file}, which does not exist`,
    );
  }
});

test('the anchor a vanity URL points at is really on the page', () => {
  for (const target of Object.values(VANITY_REDIRECTS)) {
    const [file, fragment] = target.replace(/^\//, '').split('#');
    if (!fragment) continue;
    const html = fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
    assert.ok(html.includes(`id="${fragment}"`), `public/${file} has no #${fragment} to land on`);
  }
});
