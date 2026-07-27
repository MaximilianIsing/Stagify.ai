// Regression guard for the AI Designer's opening greeting request
// (public/scripts/ai-designer/welcome.js).
//
// THE BUG THIS PINS: /api/welcome-message is pro-gated, and the client used to send
// the session token as `?authToken=`. getAuthUserFromRequest deliberately ignores
// req.query (already pinned server-side in test/services/auth-helpers.test.js), so
// every call 401'd and the caller's `|| defaultWelcomeMessage()` silently produced
// the static greeting. The personalized-greeting feature never ran in production.
// Nothing failed, because the fetch lived in a DOM closure no test could reach.
//
// These tests assert the request itself — the header, and the absence of a token in
// the URL — so reverting to a query param fails the suite instead of degrading
// silently. No DOM and no network: fetch is injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchWelcomeMessage } from '../../../public/scripts/ai-designer/welcome.js';

// A fake fetch that records every call and replays a scripted response.
function stubFetch({ ok = true, status = 200, body = {} } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

test('sends the session token as an Authorization: Bearer header', async () => {
  const fetchImpl = stubFetch({ body: { message: 'Welcome back!', isReturning: true } });

  await fetchWelcomeMessage('tok-abc', { fetchImpl });

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(
    fetchImpl.calls[0].init.headers.Authorization,
    'Bearer tok-abc',
    'the token must travel in the Authorization header',
  );
});

test('NEVER puts the token in the URL (the bug that made this endpoint dead)', async () => {
  const fetchImpl = stubFetch({ body: { message: 'hi' } });

  await fetchWelcomeMessage('tok-abc', { fetchImpl });

  const { url } = fetchImpl.calls[0];
  assert.equal(url, '/api/welcome-message', 'no query string at all');
  assert.ok(!url.includes('authToken'), 'a token in a URL leaks via logs/history/Referer');
  assert.ok(!url.includes('tok-abc'), 'the token value must not appear in the URL');
});

test('returns the greeting text from the response body', async () => {
  const fetchImpl = stubFetch({ body: { message: 'Welcome back!', isReturning: true } });

  const result = await fetchWelcomeMessage('tok-abc', { fetchImpl });

  assert.equal(result, 'Welcome back!');
});

test('sends no Authorization header when signed out', async () => {
  const fetchImpl = stubFetch({ body: {} });

  await fetchWelcomeMessage(null, { fetchImpl });

  assert.deepEqual(fetchImpl.calls[0].init.headers, {}, 'no header rather than "Bearer null"');
});

test('returns null on a non-OK status so the caller falls back to the static greeting', async () => {
  const fetchImpl = stubFetch({ ok: false, status: 401, body: { error: 'AUTH_REQUIRED' } });

  const result = await fetchWelcomeMessage('tok-abc', { fetchImpl });

  assert.equal(result, null);
});

test('warns on a non-OK status WITH a token — the silent-failure mode that hid the bug', async () => {
  const fetchImpl = stubFetch({ ok: false, status: 401, body: {} });
  const warnings = [];

  await fetchWelcomeMessage('tok-abc', { fetchImpl, warn: (m) => warnings.push(m) });

  assert.equal(warnings.length, 1, 'a rejected session we believe is valid must not be silent');
  assert.match(warnings[0], /401/);
});

test('does NOT warn on a non-OK status when signed out (expected, not a defect)', async () => {
  const fetchImpl = stubFetch({ ok: false, status: 401, body: {} });
  const warnings = [];

  await fetchWelcomeMessage(null, { fetchImpl, warn: (m) => warnings.push(m) });

  assert.deepEqual(warnings, [], 'a signed-out 401 is routine — no noise');
});

test('returns null when the body carries no message', async () => {
  const fetchImpl = stubFetch({ body: { isReturning: false } });

  assert.equal(await fetchWelcomeMessage('tok-abc', { fetchImpl }), null);
});
