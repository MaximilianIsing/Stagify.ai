// Guard: nobody buffers a multipart body for a caller we have not authenticated.
//
// WHY THIS EXISTS
// multer reads the WHOLE multipart body into memory before any handler runs, and auth
// on these routes lives inside the handler (the repo-wide invariant). So an anonymous
// request made this deliberately single-instance process allocate ~150 MB
// (/api/process-image, /api/enhance-exterior: 25 MB x 6 files) or ~100 MB
// (/api/chat-upload: 20 MB x 5) and THEN get told to sign in. genLimiter bounds the
// RATE of those requests (60 per 5 min per IP), not the cost of one — and memory
// pressure is concurrency-bound, not rate-bound.
//
// THE FIX HAS TWO HALVES AND EITHER ONE ALONE IS A BUG
// A gate mounted ahead of multer can only read HEADERS: req.body does not exist until
// multer has read the whole body, which is the cost the gate exists to avoid. But
// getAuthUserFromRequest accepts the token from the header OR req.body.authToken, and
// two of these three clients used to send it ONLY as a form field. So:
//
//   - drop the client header  → every signed-in user is told to sign in;
//   - drop the form field     → the in-handler check (still the authority, and the
//                               transport documented for non-browser callers in
//                               docs/reference/endpoints.md) loses its input.
//
// Both halves are pinned below because neither loss is visible from the outside: the
// first looks like a login bug, the second like nothing at all until someone anonymous
// starts uploading.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Read a source file with comments removed.
 *
 * A source-scan guard must look at shipped code, never at prose about it — this
 * file's own header names the very transports it forbids, and the modules it scans
 * explain the pairing in comments too.
 * @param {string} rel - Repo-relative path.
 * @returns {string} File contents with block and line comments stripped.
 */
function readCode(rel) {
  return fs
    .readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

// `etch('` rather than `fetch('` so a wrapped caller counts too: the Exterior Studio
// posts through an injected `doFetch` seam, and matching only the bare global would
// report zero call sites on a file that has one.
const callToken = (url) => `etch('${url}'`;

/**
 * The fetch call for `url`, from its opening paren to the matching close.
 *
 * Scoped rather than swept: ai-designer-app.js posts to several endpoints and carries
 * an Authorization header on more than one of them, so a whole-file grep for "Bearer"
 * would pass on a file where THIS call lost its header.
 * @param {string} src - Comment-stripped source.
 * @param {string} url - The endpoint path as it appears in the fetch call.
 * @returns {string} The call's argument text.
 */
function fetchCallFor(src, url) {
  const start = src.indexOf(callToken(url));
  assert.notEqual(start, -1, `no fetch('${url}') call found`);
  let depth = 0;
  for (let i = src.indexOf('(', start); i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced parens in the fetch('${url}') call`);
}

/**
 * The header text a call actually sends, following one level of indirection.
 *
 * A call may spell the headers inline (`headers: { Authorization: … }`) or hand over a
 * binding built once and reused by several call sites — which is what staging-pipeline.js
 * does, because it posts the same request from two progress-UI branches. Resolving the
 * binding keeps the guard from forcing a copy-paste just to be checkable.
 * @param {string} src - Comment-stripped source of the whole module.
 * @param {string} call - The call text from fetchCallFor.
 * @returns {string} The headers expression, inlined or resolved.
 */
function headersOf(src, call) {
  const named = call.match(/headers:\s*([A-Za-z_$][\w$]*)\s*[,}]/);
  if (!named) return call;
  const decl = src.match(new RegExp(`\\b(?:const|let|var)\\s+${named[1]}\\s*=([^;]*);`));
  assert.ok(decl, `headers: ${named[1]} is passed but never declared in this module`);
  return decl[1];
}

// One entry per client that posts a multipart body to a route gated before multer.
// `field` is the module that appends the token to the FormData — the same file in
// both cases today, but named separately so a future split does not silently drop it.
const CLIENTS = [
  {
    file: 'public/scripts/app/staging-pipeline.js',
    url: '/api/process-image',
    // TWO call sites (the pro and free progress-UI branches), which is exactly how the
    // header gets half-applied: fix one, ship, and the other plan 401s.
    calls: 2,
  },
  {
    file: 'public/scripts/ai-designer-app.js',
    url: '/api/chat-upload',
    calls: 1,
  },
  {
    file: 'public/scripts/exterior-studio/enhance.js',
    url: '/api/enhance-exterior',
    calls: 1,
    // This one never had a form field — it has always been header-only.
    fieldOptional: true,
  },
];

for (const client of CLIENTS) {
  test(`${client.url} is posted with an Authorization header`, () => {
    const src = readCode(client.file);
    const occurrences = src.split(callToken(client.url)).length - 1;
    assert.equal(
      occurrences,
      client.calls,
      `${client.file} has ${occurrences} fetch('${client.url}') call(s), expected ${client.calls} — ` +
        'a new one needs the header too, and this guard only checks the first',
    );
    const headers = headersOf(src, fetchCallFor(src, client.url));
    assert.match(
      headers,
      /Authorization/,
      `${client.file}: the ${client.url} request carries no Authorization header, so the ` +
        'pre-multer gate cannot see the session and refuses a signed-in user',
    );
    assert.match(
      headers,
      /Bearer/,
      `${client.file}: the ${client.url} Authorization header must be a Bearer token`,
    );
  });

  if (!client.fieldOptional) {
    test(`${client.url} still sends the token in the body as well`, () => {
      // Belt AND braces on purpose: the header feeds the pre-multer gate, the field
      // feeds the in-handler check that is still the authority. Removing the field
      // breaks nothing a browser does, which is why it needs a guard.
      const src = readCode(client.file);
      assert.match(
        src,
        /formData\.append\(\s*'authToken'/,
        `${client.file} no longer appends authToken to the form body`,
      );
    });
  }
}
