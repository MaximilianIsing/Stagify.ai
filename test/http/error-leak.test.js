// Tier: drift guard (source scan, no server) — every response-building call site.
//
// WHAT THIS COVERS
// Exception text must not reach a client. `sendError(res, 500, 'X failed',
// { details: error.message })` was the house style at ~19 sites, and it handed the
// caller whatever `sharp`, the Gemini/OpenAI SDKs, `better-sqlite3`, `fs`, or Stripe
// happened to put in `.message` — absolute server paths, table names, model and quota
// state, upstream prose. 5xx bodies now carry a `ref` from lib/http/error-ref.js
// instead, which identifies the logged failure without describing it.
//
// The dedup was a one-time edit; THIS is the part that keeps holding, because the old
// form is the natural thing to write in the next catch block. The scan reads the source
// of every response-building call and fails on `.message` / `.stack` inside it.
//
// Adding a genuinely-safe exception-derived string means adding it to ALLOWED below
// with the reason — deliberately annoying, so it stays a decision rather than a habit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Call sites that build a response body. The third pattern matches a `res`-rooted
// chain — `res.json(`, `res.send(`, and crucially `res.status(400).send(`, which is how
// the Stripe webhook answers. Matching a bare `res.send(` prefix missed that one, and a
// mutation proved it: the original `Webhook Error: ${err.message}` slipped straight
// through. `\bres` cannot match inside `resend.emails.send(` — the chain requires a dot
// immediately after `res`.
const RESPONSE_CALLS = [
  /\bsendError\(/g,
  /\bwriteChatSseEvent\(/g,
  /\bres(?:\.\w+\([^()]*\))*\.(?:send|json)\(/g,
];

// Exception-derived text that is allowed out, keyed by the exact source snippet so a
// nearby edit re-opens the question. Both entries are multer's own fixed message table
// ('File too large', 'Unexpected field', …) or our own fileFilter string, on a 400 that
// describes the caller's own upload — a bounded set written in this repo, not an
// arbitrary runtime exception.
const ALLOWED = [
  "sendError(res, 400, err.message || 'Upload failed')",
  "sendError(res, 400, err.message || 'Upload error', { code: err.code })",
];

/** @returns {string[]} Every .js file under routes/ and lib/, plus server.js. */
function sourceFiles() {
  const out = [path.join(ROOT, 'server.js')];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.js')) out.push(p);
    }
  };
  walk(path.join(ROOT, 'routes'));
  walk(path.join(ROOT, 'lib'));
  return out;
}

/**
 * Pull the full argument text of every response-building call in `src`, brace/paren
 * balanced so a multi-line call is captured whole. Comment lines are dropped first —
 * lib/http/error-ref.js documents the banned pattern in prose, and a doc comment is
 * not a call site.
 * @param {string} src - File contents.
 * @returns {string[]} One entry per call, the text between its parentheses.
 */
function responseCalls(src) {
  const code = src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

  const calls = [];
  for (const pattern of RESPONSE_CALLS) {
    pattern.lastIndex = 0;
    for (let m = pattern.exec(code); m; m = pattern.exec(code)) {
      // Walk from the call's LAST '(' — a `res.status(400).send(` match already
      // contains a balanced pair, and counting from the first would stop early.
      let depth = 0;
      let end = m.index + m[0].length - 1;
      for (; end < code.length; end += 1) {
        if (code[end] === '(') depth += 1;
        else if (code[end] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      calls.push(code.slice(m.index, end + 1));
      pattern.lastIndex = m.index + m[0].length;
    }
  }
  return calls;
}

/** @param {string} call - A captured call's source. @returns {boolean} Does it carry exception text? */
function leaksExceptionText(call) {
  if (ALLOWED.some((ok) => call.includes(ok))) return false;
  // `.message` / `.stack` off any identifier — err, error, e, result.error, aiError.
  return /\b[A-Za-z_$][\w$]*(\.[\w$]+)*\.(message|stack)\b/.test(call);
}

test('no response body is built from an exception message or stack', () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    for (const call of responseCalls(src)) {
      if (leaksExceptionText(call)) {
        offenders.push(`${path.relative(ROOT, file)}: ${call.replace(/\s+/g, ' ').slice(0, 140)}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'a response is being built from exception text — return { ref: reportError(context, err) } instead ' +
      '(lib/http/error-ref.js), or add the snippet to ALLOWED here with a reason:\n' +
      offenders.join('\n'),
  );
});

// A guard that cannot fail is not a guard. These pin the detector itself: it must catch
// each shape the codebase actually used, and must not fire on the replacements.
test('the detector catches the shapes this codebase actually had', () => {
  const bad = [
    "sendError(res, 500, 'Failed to retrieve prompt logs', { details: error.message });",
    'sendError(res, 500, error.message);',
    "sendError(res, 502, 'Failed to send email', { details: errMsg, raw: result.error.message });",
    "writeChatSseEvent(res, 'error', {\n  error: 'Chat processing failed',\n  details: error.message,\n});",
    "sendError(res, 500, 'x', { details: e.stack });",
    // The Stripe webhook answers through a status chain, not sendError. A bare
    // `res.send(` prefix missed this exact line, so it stays pinned here.
    'return res.status(400).send(`Webhook Error: ${err.message}`);',
  ];
  for (const src of bad) {
    const calls = responseCalls(src);
    assert.ok(calls.length > 0, `nothing captured from: ${src}`);
    assert.ok(calls.some(leaksExceptionText), `detector missed a real leak: ${src}`);
  }
});

test('the detector does not fire on the safe replacements', () => {
  const good = [
    "sendError(res, 500, 'Failed to retrieve prompt logs', { ref: reportError('admin.promptlogs', error) });",
    "writeChatSseEvent(res, 'error', { error: 'Chat processing failed', ref });",
    "sendError(res, 400, 'Missing required fields', { details: 'All fields are required' });",
    "sendError(res, 413, 'Request entity too large', { details: `limit ${err.limit} bytes` });",
    "res.json({ success: true, message: 'All memories have been reset successfully' });",
    'return res.status(400).send(`Webhook Error (ref ${ref})`);',
    // Not a response at all: the Resend client's own send method must not be mistaken
    // for `res.send` by the chain pattern.
    'const result = await resend.emails.send(emailData);',
  ];
  for (const src of good) {
    assert.ok(
      !responseCalls(src).some(leaksExceptionText),
      `detector fired on a safe call: ${src}`,
    );
  }
});

test('a doc comment describing the banned pattern is not mistaken for a call site', () => {
  // lib/http/error-ref.js explains what it replaced, in prose. If comment stripping
  // regressed, that file alone would fail the scan above — this says so directly.
  const src = "// was: sendError(res, 500, 'X failed', { details: error.message })\nres.json({ ok: true });";
  assert.equal(responseCalls(src).filter(leaksExceptionText).length, 0);
});
