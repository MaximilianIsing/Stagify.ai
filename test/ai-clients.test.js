// AI/email client boot factory (lib/services/ai-clients.js). This pins the exact
// key-resolution contract createAiClients relies on: each of the three clients
// (genAI / openai / resend) is constructed once from an env var (Render) or a
// local *-key.txt fallback (dev), and the factory NEVER throws even when a key is
// missing — a failed lookup just leaves that client `undefined`.
//
// Why there is no real API, model, or email call here: constructing a
// GoogleGenerativeAI / OpenAI / Resend SDK object only stores the key string; the
// SDKs are lazy and make no network request until a method (generateContent,
// chat.completions.create, emails.send, …) is actually invoked. This suite only
// ever inspects truthiness of the returned handles and NEVER calls a method on
// them, so it costs nothing and touches no network — no key needs to be real.
//
// Isolation: every test runs against an EMPTY temp dir as __dirname (so the
// key.txt / gpt-key.txt / resendkey.txt file fallback finds nothing) and snapshots
// + restores process.env.{GOOGLE_AI_API_KEY,GPT_KEY,RESEND_API_KEY} in an
// afterEach hook, because those may already be set on a dev machine and must not
// leak into (or out of) other test files.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAiClients } from '../lib/services/ai-clients.js';

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

test('all three env keys unset with no key files leaves every client undefined and throws nothing', () => {
  setEnv({ GOOGLE_AI_API_KEY: undefined, GPT_KEY: undefined, RESEND_API_KEY: undefined });

  let clients;
  assert.doesNotThrow(() => {
    // genAI's fallback reads key.txt directly (no existsSync) so a missing file
    // throws inside its try/catch; openai/resend use readKeyFile which returns
    // undefined for a missing file. Either way the factory must not throw.
    clients = createAiClients({ __dirname: emptyDir(), DEBUG_MODE: false });
  });

  assert.equal(clients.genAI, undefined, 'missing key.txt read throws and is caught → genAI undefined');
  assert.equal(clients.openai, undefined, 'no gpt-key.txt and no env → openai undefined');
  assert.equal(clients.resend, undefined, 'no resendkey.txt and no env → resend undefined');
});

test('positive file fallback: all env keys unset, real *-key.txt files present → genAI, openai and resend all construct', () => {
  // Env unset for all three so each init block takes its local-file branch. We
  // write real key files into the temp __dirname: genAI reads key.txt directly,
  // openai/resend read gpt-key.txt/resendkey.txt via readKeyFile. All three
  // resolve a non-empty key and construct. Still no method is ever called.
  setEnv({ GOOGLE_AI_API_KEY: undefined, GPT_KEY: undefined, RESEND_API_KEY: undefined });
  const dir = emptyDir();
  fs.writeFileSync(path.join(dir, 'key.txt'), 'g-file');
  fs.writeFileSync(path.join(dir, 'gpt-key.txt'), 'sk-file');
  fs.writeFileSync(path.join(dir, 'resendkey.txt'), 're-file');
  const { genAI, openai, resend } = createAiClients({ __dirname: dir, DEBUG_MODE: false });

  assert.ok(genAI, 'genAI constructed from key.txt file fallback');
  assert.ok(openai, 'openai constructed from gpt-key.txt file fallback');
  assert.ok(resend, 'resend constructed from resendkey.txt file fallback');
});

test('empty-string asymmetry: defined-empty GOOGLE_AI_API_KEY still constructs genAI, but defined-empty RESEND_API_KEY leaves resend undefined', () => {
  // Both keys are defined-but-empty, so BOTH skip the `=== undefined` file
  // fallback (empty __dirname would have nothing anyway). The divergence is in
  // what each block does with the empty string afterward: genAI passes '' straight
  // to new GoogleGenerativeAI('') (no truthiness guard) which still constructs a
  // truthy SDK handle, while resend is gated behind `if (resendApiKey)` so the
  // empty string is falsy and resend is deliberately left undefined. GPT_KEY is a
  // fake non-empty key here only so its block isn't the one under test.
  setEnv({ GOOGLE_AI_API_KEY: '', GPT_KEY: 'sk-test', RESEND_API_KEY: '' });
  const { genAI, resend } = createAiClients({ __dirname: emptyDir(), DEBUG_MODE: false });

  assert.ok(genAI, 'empty GOOGLE_AI_API_KEY skips file fallback yet still constructs genAI');
  assert.equal(resend, undefined, 'empty RESEND_API_KEY fails the if(resendApiKey) guard → resend undefined');
});

test('empty-string GPT_KEY disables the OpenAI client while genAI and resend still construct', () => {
  // GPT_KEY defined-but-empty: the `=== undefined` file fallback is skipped, then
  // the `if (gptApiKey)` truthiness guard fails, so openai is deliberately left
  // undefined. This pins the "empty GPT_KEY disables the chat/reviewer client"
  // contract distinct from an unset key.
  setEnv({ GOOGLE_AI_API_KEY: 'g-test', GPT_KEY: '', RESEND_API_KEY: 're-test' });
  const { genAI, openai, resend } = createAiClients({ __dirname: emptyDir(), DEBUG_MODE: false });

  assert.equal(openai, undefined, 'empty GPT_KEY is falsy → openai not constructed');
  assert.ok(genAI, 'genAI still constructed from its own non-empty key');
  assert.ok(resend, 'resend still constructed from its own non-empty key');
});
