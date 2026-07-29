// Tier: drift guard — the router mount ORDER in server.js.
//
// WHY THIS EXISTS: routes/referrals.js matches `/:slug`. That pattern would match
// every single-segment path in the app, and the ONLY reason an operator-created
// campaign link cannot shadow a real page is that this router is mounted after all
// the others — so it only ever sees paths nothing else claimed.
//
// test/routes/referral-route.test.js proves the router behaves correctly WHEN
// mounted last. Nothing proved that server.js actually mounts it last, which is the
// half that a refactor breaks: move the `app.use(createReferralRouter(…))` line up
// three lines and a link named `pro`, `guides` or `es` silently takes that page off
// the site, answering 302 to the home page instead. Every other test stays green.
//
// The scan runs over COMMENT-STRIPPED source. server.js documents this rule in prose
// directly above the mount, so a naive text scan would match the explanation and
// pass with the call deleted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER_JS = path.join(ROOT, 'server.js');

/**
 * Replace comment bodies with nothing, leaving string/template literals intact so a
 * URL like 'https://x' inside a string is never mistaken for a line comment.
 * Mis-stripping fails safe: it can only lose a real call, which trips the
 * "found too few routers" assertion loudly rather than hiding a reordering.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i += 1; continue;
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; out += c; i += 1; continue; }
    if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c; i += 1;
  }
  return out;
}

/** Router factories INVOKED in server.js, in source order. */
function mountedRouters() {
  const code = stripComments(fs.readFileSync(SERVER_JS, 'utf8'));
  return [...code.matchAll(/\bcreate(\w+)Router\s*\(/g)]
    .map((m) => `create${m[1]}Router`)
    // createAsyncRouter is the shared factory each router builds itself with; it is
    // never called here, but excluded so this guard can't be confused by it later.
    .filter((name) => name !== 'createAsyncRouter');
}

test('the comment stripper actually removes prose', () => {
  // The assertion below is only meaningful if stripping works. server.js explains
  // the mount rule in a comment right above the call it protects.
  const raw = fs.readFileSync(SERVER_JS, 'utf8');
  assert.match(raw, /MOUNTED LAST/, 'precondition: server.js documents the rule in prose');
  assert.equal(
    /MOUNTED LAST/.test(stripComments(raw)),
    false,
    'the stripper left comment prose behind — the scan below would match documentation',
  );
});

test('the referral router is mounted LAST in server.js', () => {
  const routers = mountedRouters();

  // A broken scan is the failure mode this guard cannot afford to have silently:
  // an empty or tiny list would make the ordering assertion vacuously true.
  assert.ok(
    routers.length >= 6,
    `the scan found only ${routers.length} router(s) (${routers.join(', ')}) — it is broken, not the mount order`,
  );
  assert.ok(routers.includes('createPublicRouter'), 'precondition: the scan sees the other routers');

  const referralMounts = routers.filter((r) => r === 'createReferralRouter');
  assert.equal(referralMounts.length, 1, 'the referral router is mounted exactly once');

  assert.equal(
    routers[routers.length - 1],
    'createReferralRouter',
    'routes/referrals.js matches /:slug — mounted anywhere but last, a campaign link can shadow a real page.\n'
      + `Current order: ${routers.join(' → ')}`,
  );
});
