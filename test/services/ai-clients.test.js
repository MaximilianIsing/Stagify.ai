// AI/email client boot factory (lib/services/ai-clients.js). This pins the exact
// key-resolution contract createAiClients relies on: each of the three clients
// (genAI / openai / resend) is constructed once from its env var (only resend keeps
// a resendkey.txt file fallback), and the factory NEVER throws even when a key is
// missing — a failed lookup leaves that client absent. Internally the client is
// left `undefined`, but createAiClients normalizes absent → `null` at the return
// (every consumer gates on `if (!client)`, and its dep typedefs spell absence as
// `null`), so callers — and these tests — observe `null`.
//
// Why there is no real API, model, or email call here: constructing a
// Gemini adapter / OpenAI / Resend SDK object only stores the key string; the
// SDKs are lazy and make no network request until a method (generateContent,
// chat.completions.create, emails.send, …) is actually invoked. This suite only
// ever inspects truthiness of the returned handles and NEVER calls a method on
// them, so it costs nothing and touches no network — no key needs to be real.
//
// Isolation: every test runs against an EMPTY temp dir as __dirname (so the
// resendkey.txt file fallback finds nothing) and snapshots
// + restores process.env.{GOOGLE_AI_API_KEY,GPT_KEY,RESEND_API_KEY} in an
// afterEach hook, because those may already be set on a dev machine and must not
// leak into (or out of) other test files.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAiClients } from '../../lib/services/ai-clients.js';

// --- env snapshot/restore -------------------------------------------------
const KEYS = ['GOOGLE_AI_API_KEY', 'GPT_KEY', 'RESEND_API_KEY'];
const snapshot = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

function setEnv(values) {
  for (const k of KEYS) {
    if (Object.prototype.hasOwnProperty.call(values, k)) {
      if (values[k] === undefined) delete process.env[k];
      else process.env[k] = values[k];
    } else {
      delete process.env[k];
    }
  }
}

// --- empty temp dir as __dirname (no key files exist inside) ---------------
const tmps = [];
function emptyDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-ai-clients-'));
  tmps.push(dir);
  return dir;
}

afterEach(() => {
  // Restore env exactly as it was before this file ran, so no other test file
  // (or the dev machine) is affected by our mutations.
  for (const k of KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
  while (tmps.length) {
    try { fs.rmSync(tmps.pop(), { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('all three env keys present (empty __dirname) constructs genAI, openai and resend', () => {
  setEnv({ GOOGLE_AI_API_KEY: 'g-test', GPT_KEY: 'sk-test', RESEND_API_KEY: 're-test' });
  const { genAI, openai, resend } = createAiClients({ __dirname: emptyDir(), DEBUG_MODE: false });

  // All three are constructed SDK instances. We only assert truthiness — never
  // call a method, so no network/model/email traffic and no cost.
  assert.ok(genAI, 'genAI is constructed from GOOGLE_AI_API_KEY');
  assert.ok(openai, 'openai is constructed from GPT_KEY');
  assert.ok(resend, 'resend is constructed from RESEND_API_KEY');
});

test('all three env keys unset with no key files leaves every client null and throws nothing', () => {
  setEnv({ GOOGLE_AI_API_KEY: undefined, GPT_KEY: undefined, RESEND_API_KEY: undefined });

  let clients;
  assert.doesNotThrow(() => {
    clients = createAiClients({ __dirname: emptyDir(), DEBUG_MODE: false });
  });

  assert.equal(clients.genAI, null, 'no GOOGLE_AI_API_KEY → genAI null');
  assert.equal(clients.openai, null, 'no GPT_KEY → openai null');
  assert.equal(clients.resend, null, 'no resendkey.txt and no env → resend null');
});

test('key.txt and gpt-key.txt are ignored; only resendkey.txt is still a file fallback', () => {
  // The Gemini and OpenAI file fallbacks were removed: a stale key.txt kept a revoked
  // key on disk long after .env held the live one. A leftover file must not revive them.
  setEnv({ GOOGLE_AI_API_KEY: undefined, GPT_KEY: undefined, RESEND_API_KEY: undefined });
  const dir = emptyDir();
  fs.writeFileSync(path.join(dir, 'key.txt'), 'g-file');
  fs.writeFileSync(path.join(dir, 'gpt-key.txt'), 'sk-file');
  fs.writeFileSync(path.join(dir, 'resendkey.txt'), 're-file');
  const { genAI, openai, resend } = createAiClients({ __dirname: dir, DEBUG_MODE: false });

  assert.equal(genAI, null, 'key.txt is not read');
  assert.equal(openai, null, 'gpt-key.txt is not read');
  assert.ok(resend, 'resend constructed from resendkey.txt file fallback');
});

test('a whitespace-only key counts as unset', () => {
  setEnv({ GOOGLE_AI_API_KEY: '   ', GPT_KEY: ' \n', RESEND_API_KEY: undefined });
  const { genAI, openai } = createAiClients({ __dirname: emptyDir(), DEBUG_MODE: false });
  assert.equal(genAI, null);
  assert.equal(openai, null);
});

test('an empty key leaves its client null — same rule for all three, no empty-string asymmetry', () => {
  // Both keys are defined-but-empty, so both fail their truthiness guard (resend also
  // skips its `=== undefined` file fallback; an empty __dirname has nothing anyway). GPT_KEY is a fake non-empty key here only so its block isn't under test.
  //
  // genAI used to be the odd one out: it passed '' straight to
  // new GoogleGenerativeAI('') (the old SDK), which constructs a TRUTHY handle that 400s on every
  // call. That read as "configured" to every `if (!genAI)` guard in the codebase, so
  // an empty key produced failing network round-trips instead of a clean no-op — and
  // it made "disable the AI" impossible to express in tests. It now matches the
  // openai/resend blocks, which is what lets the staging tests switch the grader off.
  setEnv({ GOOGLE_AI_API_KEY: '', GPT_KEY: 'sk-test', RESEND_API_KEY: '' });
  const { genAI, resend } = createAiClients({ __dirname: emptyDir(), DEBUG_MODE: false });

  assert.equal(genAI, null, 'empty GOOGLE_AI_API_KEY is falsy → genAI not constructed');
  assert.equal(resend, null, 'empty RESEND_API_KEY fails the if(resendApiKey) guard → resend null');
});

test('empty-string GPT_KEY disables the OpenAI client while genAI and resend still construct', () => {
  // GPT_KEY defined-but-empty: the `if (gptApiKey)` truthiness guard fails, so openai
  // is deliberately left
  // absent (null). This pins the "empty GPT_KEY disables the chat/reviewer client"
  // contract distinct from an unset key.
  setEnv({ GOOGLE_AI_API_KEY: 'g-test', GPT_KEY: '', RESEND_API_KEY: 're-test' });
  const { genAI, openai, resend } = createAiClients({ __dirname: emptyDir(), DEBUG_MODE: false });

  assert.equal(openai, null, 'empty GPT_KEY is falsy → openai not constructed');
  assert.ok(genAI, 'genAI still constructed from its own non-empty key');
  assert.ok(resend, 'resend still constructed from its own non-empty key');
});
