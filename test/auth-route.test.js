// Tier: route contract (real store, faked email/Google) — routes/auth.js.
//
// WHAT THIS COVERS
// The auth handlers are thin glue over the auth store, so this suite drives them
// over HTTP against a REAL temp-dir store (see test/helpers/auth-app.js) and asserts
// the ROUTE layer the store's own unit tests can't reach:
//   - the happy register → verify → login → me → logout round-trip, including the
//     verification code travelling through the (captured) email sender,
//   - status-code mapping for the store's { ok:false } results (400 on bad
//     register/verify, 401 on bad login),
//   - the auth gate on GET /api/auth/me (401 AUTH_REQUIRED without a token),
//   - the staging Google gate (403 STAGING_DISABLED) and the "not configured" 503,
//   - a scripted Google sign-in minting a session,
//   - /api/auth/config reflecting IS_STAGING (client id withheld on staging).
// Nothing here sends email or contacts Google; both are faked in the harness.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mountAuth } from './helpers/auth-app.js';

const PASSWORD = 'CorrectHorse9!';
const post = (base, url, body, headers = {}) =>
  fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const get = (base, url, headers = {}) => fetch(base + url, { headers });

let app;
afterEach(async () => {
  if (app) { await app.close(); app = null; }
});

test('register → verify → login → me → logout round-trips a real account', async () => {
  app = await mountAuth();
  const email = 'buyer@example.com';

  // Register: the router hands the store's code to the (captured) email sender.
  const reg = await post(app.baseUrl, '/api/auth/register', { email, password: PASSWORD });
  assert.equal(reg.status, 200);
  assert.equal(app.sentEmails.length, 1, 'exactly one verification email queued');
  assert.equal(app.sentEmails[0].toEmail, email);
  const code = app.sentEmails[0].code;
  assert.match(code, /^\d{6}$/, 'a 6-digit code was generated');

  // Verify: returns a session token + the public user.
  const ver = await post(app.baseUrl, '/api/auth/register/verify', { email, code });
  assert.equal(ver.status, 200);
  const verBody = await ver.json();
  assert.equal(verBody.success, true);
  assert.ok(verBody.token, 'verification yields a session token');
  assert.equal(verBody.user.email, email);
  assert.ok(!('passwordHash' in verBody.user), 'never leaks the password hash');

  // Login with the now-verified credentials.
  const login = await post(app.baseUrl, '/api/auth/login', { email, password: PASSWORD });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  assert.ok(loginBody.token);

  // /me resolves the bearer token to the same account.
  const me = await get(app.baseUrl, '/api/auth/me', { Authorization: `Bearer ${loginBody.token}` });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.email, email);

  // Logout invalidates the session; /me then rejects it.
  const out = await post(app.baseUrl, '/api/auth/logout', { authToken: loginBody.token });
  assert.equal(out.status, 200);
  const meAfter = await get(app.baseUrl, '/api/auth/me', { Authorization: `Bearer ${loginBody.token}` });
  assert.equal(meAfter.status, 401, 'session no longer valid after logout');
});

test('login with wrong password → 401, and no token leaks', async () => {
  app = await mountAuth();
  const email = 'wrongpass@example.com';
  const reg = await post(app.baseUrl, '/api/auth/register', { email, password: PASSWORD });
  await reg.json();
  await post(app.baseUrl, '/api/auth/register/verify', { email, code: app.sentEmails[0].code });

  const res = await post(app.baseUrl, '/api/auth/login', { email, password: 'not-the-password' });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.ok(!body.token, 'no token on a failed login');
  assert.ok(body.error, 'an error message is returned');
});

test('register with a too-short password → 400 and queues no email', async () => {
  app = await mountAuth();
  const res = await post(app.baseUrl, '/api/auth/register', { email: 'short@example.com', password: 'x' });
  assert.equal(res.status, 400);
  assert.equal(app.sentEmails.length, 0, 'a rejected registration never triggers an email');
});

test('verify with a wrong code → 400', async () => {
  app = await mountAuth();
  const email = 'badcode@example.com';
  await (await post(app.baseUrl, '/api/auth/register', { email, password: PASSWORD })).json();
  const res = await post(app.baseUrl, '/api/auth/register/verify', { email, code: '000000' });
  assert.equal(res.status, 400);
});

test('registering a taken email is indistinguishable from a fresh sign-up', async () => {
  app = await mountAuth();
  const email = 'dupe@example.com';

  // Create the account (register → verify).
  await post(app.baseUrl, '/api/auth/register', { email, password: PASSWORD });
  assert.equal(app.sentEmails.length, 1);
  await post(app.baseUrl, '/api/auth/register/verify', { email, code: app.sentEmails[0].code });

  // Register the SAME email again: must still be 200 (no tell-tale 400) …
  const dup = await post(app.baseUrl, '/api/auth/register', { email, password: 'Different0ne!' });
  assert.equal(dup.status, 200, 'a taken email must not surface a distinguishable error');
  const dupBody = await dup.json();
  assert.equal(dupBody.needsVerification, true);

  // … and it sends the "account exists" notice, NOT a second verification code.
  assert.equal(app.sentEmails.length, 1, 'no verification code is issued for a taken email');
  assert.equal(app.sentAccountExistsNotices.length, 1, 'the address gets an account-exists notice');
  assert.equal(app.sentAccountExistsNotices[0].toEmail, email);

  // A genuinely new email returns the exact same status and body.
  const fresh = await post(app.baseUrl, '/api/auth/register', { email: 'newbie@example.com', password: PASSWORD });
  assert.equal(fresh.status, dup.status, 'same status for taken vs brand-new email');
  assert.deepEqual(await fresh.json(), dupBody, 'same response body for taken vs brand-new email');
});

test('forgot-password returns one neutral body for existing and unknown emails', async () => {
  const sent = [];
  const resend = {
    emails: {
      send: async (msg) => {
        sent.push(msg);
        return { data: { id: 'sent' }, error: null };
      },
    },
  };
  app = await mountAuth({ resend });

  const email = 'reset-me@example.com';
  await post(app.baseUrl, '/api/auth/register', { email, password: PASSWORD });
  await post(app.baseUrl, '/api/auth/register/verify', { email, code: app.sentEmails[0].code });

  const existing = await post(app.baseUrl, '/api/auth/forgot-password', { email });
  const unknown = await post(app.baseUrl, '/api/auth/forgot-password', { email: 'no-such@example.com' });

  assert.equal(existing.status, 200);
  assert.equal(unknown.status, 200);
  assert.deepEqual(
    await unknown.json(),
    await existing.json(),
    'identical response body regardless of whether the account exists',
  );

  // Only the real account actually triggers an outbound reset email.
  assert.equal(sent.length, 1, 'a reset email is sent only for the account that exists');
  assert.equal(sent[0].to, email);
});

test('GET /api/auth/me without a token → 401 AUTH_REQUIRED', async () => {
  app = await mountAuth();
  const res = await get(app.baseUrl, '/api/auth/me');
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'AUTH_REQUIRED');
});

test('config withholds the Google client id and flags staging when IS_STAGING', async () => {
  app = await mountAuth({ IS_STAGING: true, SHOW_STAGING_BANNER: true });
  const res = await get(app.baseUrl, '/api/auth/config');
  const body = await res.json();
  assert.equal(body.isStaging, true);
  assert.equal(body.googleClientId, null, 'staging never renders the Google button');
  assert.equal(body.showStagingBanner, true);
});

test('config exposes the Google client id off staging', async () => {
  app = await mountAuth();
  const body = await (await get(app.baseUrl, '/api/auth/config')).json();
  assert.equal(body.isStaging, false);
  assert.equal(body.googleClientId, 'test-google-client-id');
});

test('Google sign-in is refused on staging with STAGING_DISABLED', async () => {
  app = await mountAuth({ IS_STAGING: true });
  const res = await post(app.baseUrl, '/api/auth/google', { credential: 'anything' });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'STAGING_DISABLED');
});

test('Google sign-in → 503 when no OAuth client is configured', async () => {
  app = await mountAuth({ googleOAuthClient: null });
  const res = await post(app.baseUrl, '/api/auth/google', { credential: 'anything' });
  assert.equal(res.status, 503);
});

test('a valid Google credential mints a session for the verified email', async () => {
  const googleOAuthClient = {
    verifyIdToken: async () => ({
      getPayload: () => ({ email: 'guser@example.com', sub: 'google-sub-123', email_verified: true }),
    }),
  };
  app = await mountAuth({ googleOAuthClient });
  const res = await post(app.baseUrl, '/api/auth/google', { credential: 'valid-jwt' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.token, 'Google sign-in issues a session token');
  assert.equal(body.user.email, 'guser@example.com');
});

test('Google sign-in with a missing credential → 400', async () => {
  const googleOAuthClient = { verifyIdToken: async () => ({ getPayload: () => ({}) }) };
  app = await mountAuth({ googleOAuthClient });
  const res = await post(app.baseUrl, '/api/auth/google', {});
  assert.equal(res.status, 400);
});
