// Tier 2 (E-lite) — staging endpoint contracts, without any AI call.
//
// The core upload surface. We boot with BOTH AI keys blank so /api/validate-image
// takes its documented FAIL-OPEN path (deterministic, no real API call) and we can
// assert /api/process-image's auth gate.
//
// GOOGLE_AI_API_KEY='' is the one that matters for the validator — the stageability
// grader is Gemini, not GPT. It used to be enough to blank GPT_KEY, because the route
// short-circuited on the `openai` client; that guard is gone (it was disabling a
// Gemini check on an OpenAI key), so the reviewer's OWN client has to be the one
// switched off. An empty value also skips the key.txt / gpt-key.txt fallbacks, so a
// real local key can't sneak in and make this test call a live API.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// A valid 1x1 PNG data URL — content is irrelevant here (the disabled reviewer
// returns before decoding), it just has to look like a data URL.
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let server;
before(async () => { server = await startServer({ GPT_KEY: '', GOOGLE_AI_API_KEY: '' }); });
after(() => server?.close());

const postJson = (p, body) =>
  fetch(`${server.baseUrl}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('/api/validate-image rejects a missing or malformed image with 400', async () => {
  assert.equal((await postJson('/api/validate-image', {})).status, 400, 'no image → 400');
  assert.equal(
    (await postJson('/api/validate-image', { image: 'not-a-data-url' })).status,
    400,
    'a string that is not a data URL → 400',
  );
});

test('/api/validate-image fails open (200, valid) when the reviewer is disabled', async () => {
  const res = await postJson('/api/validate-image', { image: PNG_DATA_URL });
  assert.equal(res.status, 200, 'validate-image always answers 200');
  const body = await res.json();
  assert.equal(body.valid, true, 'no reviewer configured → fail open (valid: true)');
  assert.equal(body.code, null, 'an approved upload carries no rejection code');
  assert.equal(body.reason, '', 'and no rejection copy');
});

test('/api/process-image requires a session for desktop (no anonymous desktop staging)', async () => {
  const res = await fetch(`${server.baseUrl}/api/process-image`, {
    method: 'POST',
    headers: { 'user-agent': DESKTOP_UA },
  });
  assert.equal(res.status, 401, 'desktop with no session → 401');
  const body = await res.json();
  assert.equal(body.code, 'AUTH_REQUIRED');
});
