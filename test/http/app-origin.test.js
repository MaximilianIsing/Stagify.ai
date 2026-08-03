// Tier: unit + drift guard — resolveAppOrigin (lib/http/http-helpers.js).
//
// WHY THIS EXISTS
// The origin a user-facing link is built on was derived at five sites. Four of them
// (auth ×2, billing ×2) agreed on `PUBLIC_APP_URL || APP_URL || <request>`; the fifth,
// routes/gallery.js, invented APP_ORIGIN — a name set in no environment and no config
// file — and fell back to the empty string. So every gallery share link came back as a
// bare `/s/<token>` path instead of a URL. The token is displayed exactly once and has
// no read-back, so an owner who copied one had to rotate the link to recover.
//
// The one-time consolidation is not the deliverable; the drift guard at the bottom is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveAppOrigin } from '../../lib/http/http-helpers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** An express-ish request stub. */
const reqOf = (host, protocol = 'https') => ({ protocol, get: (h) => (h.toLowerCase() === 'host' ? host : undefined) });

/** Run `fn` with the three origin vars set exactly as given. */
function withEnv(vars, fn) {
  const names = ['PUBLIC_APP_URL', 'APP_URL', 'APP_ORIGIN'];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  try {
    for (const n of names) delete process.env[n];
    for (const [k, v] of Object.entries(vars)) process.env[k] = v;
    return fn();
  } finally {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  }
}

test('configuration wins over the request, in a stable order', () => {
  const req = reqOf('internal.local');
  withEnv({ PUBLIC_APP_URL: 'https://a.test', APP_URL: 'https://b.test', APP_ORIGIN: 'https://c.test' },
    () => assert.equal(resolveAppOrigin(req), 'https://a.test'));
  withEnv({ APP_URL: 'https://b.test', APP_ORIGIN: 'https://c.test' },
    () => assert.equal(resolveAppOrigin(req), 'https://b.test'));
  // APP_ORIGIN is kept only so an operator who set it on the strength of the old
  // gallery code is not broken by the consolidation.
  withEnv({ APP_ORIGIN: 'https://c.test' },
    () => assert.equal(resolveAppOrigin(req), 'https://c.test'));
});

test('a trailing slash never doubles up in the link', () => {
  withEnv({ PUBLIC_APP_URL: 'https://a.test/' }, () => {
    assert.equal(resolveAppOrigin(reqOf('h')), 'https://a.test');
    assert.equal(`${resolveAppOrigin(reqOf('h'))}/s/tok`, 'https://a.test/s/tok');
  });
  withEnv({ PUBLIC_APP_URL: '  https://a.test///  ' },
    () => assert.equal(resolveAppOrigin(reqOf('h')), 'https://a.test'));
});

test('with nothing configured it falls back to the request, absolutely', () => {
  withEnv({}, () => {
    assert.equal(resolveAppOrigin(reqOf('stagify.ai')), 'https://stagify.ai');
    assert.equal(resolveAppOrigin(reqOf('127.0.0.1:4599', 'http')), 'http://127.0.0.1:4599');
  });
});

test('req.protocol is trusted rather than the raw header', () => {
  // server.js pins `trust proxy` to 1, so Express has already resolved
  // X-Forwarded-Proto into req.protocol. Reading the header by hand is the mistake
  // getStagingClientIp exists to warn about.
  withEnv({}, () => {
    const req = { protocol: 'https', headers: { 'x-forwarded-proto': 'http,https' }, get: () => 'stagify.ai' };
    assert.equal(resolveAppOrigin(req), 'https://stagify.ai');
  });
});

test('a request with no host yields an empty origin rather than "undefined"', () => {
  // The caller can then decide; what must never happen is the string "https://undefined".
  withEnv({}, () => {
    assert.equal(resolveAppOrigin({ protocol: 'https', get: () => undefined }), '');
    assert.equal(resolveAppOrigin(null), '');
    assert.equal(resolveAppOrigin(undefined), '');
  });
});

test('it reads headers.host when the request has no get()', () => {
  withEnv({}, () => assert.equal(resolveAppOrigin({ protocol: 'http', headers: { host: 'x.test' } }), 'http://x.test'));
});

// ── the drift guard ──────────────────────────────────────────────────────────

/** Every .js under a directory, recursively. */
function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Source with comments blanked, so prose about the rule cannot satisfy the scan. */
function code(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('no route derives the app origin by hand', () => {
  // This is the shape that drifted: five copies, one of which was wrong in a way that
  // only showed up in a link a user had already copied.
  const offenders = [];
  const files = [...jsFiles(path.join(ROOT, 'routes')), ...jsFiles(path.join(ROOT, 'lib'))]
    .filter((f) => !f.endsWith(path.join('http', 'http-helpers.js')));

  for (const file of files) {
    const src = code(file);
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (/req\.get\(\s*['"]host['"]\s*\)/i.test(src)) offenders.push(`${rel}: builds an origin from req.get('host')`);
    if (/headers\[\s*['"]x-forwarded-proto['"]\s*\]/i.test(src)) offenders.push(`${rel}: parses x-forwarded-proto by hand`);
    if (/process\.env\.APP_ORIGIN/.test(src)) offenders.push(`${rel}: reads APP_ORIGIN directly`);
    if (/process\.env\.PUBLIC_APP_URL/.test(src)) offenders.push(`${rel}: reads PUBLIC_APP_URL directly`);
  }
  assert.deepEqual(offenders, [],
    `resolveAppOrigin(req) is the one place this is decided:\n${offenders.join('\n')}`);
});

test('sanity: the guard would actually notice a re-derivation', () => {
  // A scan that matches nothing passes for the wrong reason forever.
  const sample = "const url = `${req.protocol}://${req.get('host')}/x`;";
  assert.match(sample, /req\.get\(\s*['"]host['"]\s*\)/i);
  assert.doesNotMatch(code(path.join(ROOT, 'routes', 'gallery.js')), /req\.get\(\s*['"]host['"]\s*\)/i);
});
