// Tier 2 (E-lite) — staging endpoint contracts, without any AI call.
//
// The core upload surface, asserted against the REAL booted server: both paid entry
// points (/api/validate-image and /api/process-image) refuse an anonymous caller.
//
// This tier can't hold a session — registration needs a mailed code — so the
// validator's *behaviour* (400 shapes, the category code/reason relay, fail-open)
// is asserted one layer down in routes/staging-routes.test.js, where the auth helper
// is faked. What only a real boot can prove is that the gate is actually wired into
// the running app, which is what these tests cover.
//
// Both AI keys are still blanked as a belt-and-braces guard: if the gate ever
// regressed, these requests would reach a disabled reviewer rather than a live API.
// GOOGLE_AI_API_KEY='' is the one that matters — the stageability grader is Gemini,
// not GPT, and an empty value also skips the key.txt / gpt-key.txt fallbacks, so a
// real local key can't sneak in and make this test bill a live call.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.js';

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

test('/api/validate-image requires a session (no anonymous paid vision calls)', async () => {
  // The pre-flight spends a Gemini call per request, so it is gated like the staging
  // it precedes. genLimiter caps a single IP; only this check bounds an anonymous
  // caller who rotates addresses.
  const res = await postJson('/api/validate-image', { image: PNG_DATA_URL });
  assert.equal(res.status, 401, 'a well-formed anonymous request → 401');
  assert.equal((await res.json()).code, 'AUTH_REQUIRED', 'the code both studios already handle');
});

test('/api/validate-image gates before it inspects the body', async () => {
  // With a session these are 400s. Anonymously they must not be: a body-shape reply
  // means the handler ran, which is the ordering the gate exists to prevent.
  assert.equal((await postJson('/api/validate-image', {})).status, 401, 'no image, no session → 401');
  assert.equal(
    (await postJson('/api/validate-image', { image: 'not-a-data-url' })).status,
    401,
    'a malformed data URL from an anonymous caller → 401',
  );
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
