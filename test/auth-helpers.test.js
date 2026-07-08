/**
 * Unit tests for `lib/services/auth-helpers.js`.
 *
 * WHAT'S UNDER TEST
 * -----------------
 * `createAuthHelpers({ authStore, enterpriseStore, stripe, enterpriseMeterEventName })`
 * is a factory that closes over four collaborators and returns six request/auth
 * helpers used by the Express layer:
 *
 *   - enhanceUserWithEnterprise(user)  — upgrades a non-pro user to pro when their
 *                                        email domain is an active enterprise domain.
 *   - getAuthUserFromRequest(req)      — resolves the session user from a request,
 *                                        then enterprise-enhances it.
 *   - toPublicAuthUser(user)           — enterprise-enhances, then runs through
 *                                        authStore.publicUser for API responses.
 *   - enterpriseDomainForUser(user)    — the enterprise domain a generation should
 *                                        be billed to (or null).
 *   - reportEnterpriseUsage(domain,n)  — records local usage + (optionally) emits a
 *                                        Stripe meter event.
 *   - requireProAccount(req,res)       — gate: 401 if unauthenticated, 403 if not
 *                                        pro, otherwise the user.
 *
 * TESTING APPROACH
 * ----------------
 * Every collaborator (authStore, enterpriseStore, stripe) is a hand-rolled fake —
 * there are NO real network, model, or datastore calls anywhere in this file. Each
 * fake records the arguments it received so we can assert not just on return values
 * but on the *exact* values the production code forwarded to its dependencies
 * (e.g. that a bearer token is stripped before validateSession sees it, that a
 * domain is lowercased before the enterprise lookup, that a Stripe meter payload
 * stringifies the quantity).
 *
 * Assertions were written against the ACTUAL source (return shapes, HTTP status
 * codes, error strings, `code` values, header/body field names), not assumptions.
 *
 * House style: node's built-in test runner + strict assert. Run with:
 *   node --test test/auth-helpers.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAuthHelpers } from '../lib/services/auth-helpers.js';

// ---------------------------------------------------------------------------
// Hand-rolled fakes
// ---------------------------------------------------------------------------

/**
 * Fake authStore. Every method is a stub whose behavior can be overridden and
 * whose calls are recorded on `calls` for assertion.
 */
function makeAuthStore(overrides = {}) {
  const calls = { validateSession: [], findUserByEmail: [], publicUser: [] };
  return {
    calls,
    validateSession(token) {
      calls.validateSession.push(token);
      return overrides.validateSession ? overrides.validateSession(token) : null;
    },
    findUserByEmail(email) {
      calls.findUserByEmail.push(email);
      return overrides.findUserByEmail ? overrides.findUserByEmail(email) : null;
    },
    publicUser(user) {
      calls.publicUser.push(user);
      return overrides.publicUser ? overrides.publicUser(user) : { public: true, user };
    },
  };
}

/**
 * Fake enterpriseStore. `activeDomains` is the set of domains treated as active;
 * recordUsage / getDomainEntry are recorded and overridable.
 */
function makeEnterpriseStore(overrides = {}) {
  const calls = { isActiveDomain: [], recordUsage: [], getDomainEntry: [] };
  return {
    calls,
    isActiveDomain(domain) {
      calls.isActiveDomain.push(domain);
      if (overrides.isActiveDomain) return overrides.isActiveDomain(domain);
      const active = overrides.activeDomains || [];
      return active.includes(domain);
    },
    recordUsage(domain, quantity) {
      calls.recordUsage.push({ domain, quantity });
    },
    getDomainEntry(domain) {
      calls.getDomainEntry.push(domain);
      return overrides.getDomainEntry ? overrides.getDomainEntry(domain) : null;
    },
  };
}

/** Fake Stripe client that records meter-event creations and resolves. */
function makeStripe() {
  const calls = { create: [] };
  return {
    calls,
    billing: {
      meterEvents: {
        create(args) {
          calls.create.push(args);
          return Promise.resolve({ id: 'mtr_fake' });
        },
      },
    },
  };
}

/** Minimal Express-style response double that records status + json calls. */
function makeRes() {
  const state = { statusCode: null, body: null, statusCalled: false, jsonCalled: false };
  const res = {
    state,
    status(code) {
      state.statusCode = code;
      state.statusCalled = true;
      return res;
    },
    json(body) {
      state.body = body;
      state.jsonCalled = true;
      return res;
    },
  };
  return res;
}

// ---------------------------------------------------------------------------
// requireProAccount
// ---------------------------------------------------------------------------

test('requireProAccount responds 401 AUTH_REQUIRED and returns null when the session is invalid', () => {
  const authStore = makeAuthStore({ validateSession: () => null });
  const enterpriseStore = makeEnterpriseStore();
  const { requireProAccount } = createAuthHelpers({
    authStore,
    enterpriseStore,
    stripe: null,
    enterpriseMeterEventName: 'meter',
  });

  const req = { headers: { authorization: 'Bearer bad-token' }, body: {} };
  const res = makeRes();

  const result = requireProAccount(req, res);

  assert.equal(result, null);
  assert.equal(res.state.statusCode, 401);
  assert.deepEqual(res.state.body, { error: 'Sign in required', code: 'AUTH_REQUIRED' });
});

test('requireProAccount responds 403 PRO_REQUIRED and returns null when the user is not on the pro plan', () => {
  const authStore = makeAuthStore({
    validateSession: () => ({ email: 'free@example.com', plan: 'free' }),
  });
  // Domain is NOT active, so the user stays non-pro through enhancement.
  const enterpriseStore = makeEnterpriseStore({ activeDomains: [] });
  const { requireProAccount } = createAuthHelpers({
    authStore,
    enterpriseStore,
    stripe: null,
    enterpriseMeterEventName: 'meter',
  });

  const req = { headers: { authorization: 'Bearer good-token' }, body: {} };
  const res = makeRes();

  const result = requireProAccount(req, res);

  assert.equal(result, null);
  assert.equal(res.state.statusCode, 403);
  assert.deepEqual(res.state.body, {
    error: 'Stagify+ subscription required',
    code: 'PRO_REQUIRED',
  });
});

test('requireProAccount returns the pro user and never touches the response', () => {
  const proUser = { email: 'pro@example.com', plan: 'pro' };
  const authStore = makeAuthStore({ validateSession: () => proUser });
  const enterpriseStore = makeEnterpriseStore();
  const { requireProAccount } = createAuthHelpers({
    authStore,
    enterpriseStore,
    stripe: null,
    enterpriseMeterEventName: 'meter',
  });

  const req = { headers: { authorization: 'Bearer good-token' }, body: {} };
  const res = makeRes();

  const result = requireProAccount(req, res);

  assert.equal(result, proUser);
  assert.equal(res.state.statusCalled, false);
  assert.equal(res.state.jsonCalled, false);
});

test('INTEGRATION: a free user on an active enterprise domain is upgraded and PASSES requireProAccount', () => {
  // Proves the enterprise grant flows THROUGH the gate end-to-end:
  // getAuthUserFromRequest enterprise-enhances the session user, so a domain member
  // with no personal pro plan is treated as pro by requireProAccount.
  const freeMember = { email: 'member@acme.com', plan: 'free' };
  const authStore = makeAuthStore({ validateSession: (t) => (t === 'tok' ? freeMember : null) });
  const enterpriseStore = makeEnterpriseStore({ activeDomains: ['acme.com'] });
  const { requireProAccount } = createAuthHelpers({
    authStore,
    enterpriseStore,
    stripe: null,
    enterpriseMeterEventName: 'meter',
  });

  const req = { headers: { authorization: 'Bearer tok' }, body: {} };
  const res = makeRes();

  const result = requireProAccount(req, res);

  assert.equal(res.state.statusCalled, false, 'no 401/403 — the active-domain grant satisfies the gate');
  assert.equal(result.plan, 'pro');
  assert.equal(result.enterpriseDomain, 'acme.com');
});

// ---------------------------------------------------------------------------
// getAuthUserFromRequest
// ---------------------------------------------------------------------------

test('getAuthUserFromRequest reads the bearer token from the Authorization header with "Bearer " stripped', () => {
  const proUser = { email: 'pro@example.com', plan: 'pro' };
  // Only the exact stripped token resolves to a user.
  const authStore = makeAuthStore({
    validateSession: (token) => (token === 'abc123' ? proUser : null),
  });
  const enterpriseStore = makeEnterpriseStore();
  const { getAuthUserFromRequest } = createAuthHelpers({
    authStore,
    enterpriseStore,
    stripe: null,
    enterpriseMeterEventName: 'meter',
  });

  const req = { headers: { authorization: 'Bearer abc123' }, body: {} };

  const result = getAuthUserFromRequest(req);

  assert.equal(result, proUser);
  // Assert the token that actually reached validateSession was the stripped value.
  assert.deepEqual(authStore.calls.validateSession, ['abc123']);
});

test('getAuthUserFromRequest falls back to req.body.authToken when no Authorization header is present', () => {
  const proUser = { email: 'pro@example.com', plan: 'pro' };
  const authStore = makeAuthStore({
    validateSession: (token) => (token === 'body-token' ? proUser : null),
  });
  const enterpriseStore = makeEnterpriseStore();
  const { getAuthUserFromRequest } = createAuthHelpers({
    authStore,
    enterpriseStore,
    stripe: null,
    enterpriseMeterEventName: 'meter',
  });

  const req = { headers: {}, body: { authToken: 'body-token' } };

  const result = getAuthUserFromRequest(req);

  assert.equal(result, proUser);
  assert.deepEqual(authStore.calls.validateSession, ['body-token']);
});

test('getAuthUserFromRequest IGNORES a token supplied only in req.query (validateSession is called with null)', () => {
  const authStore = makeAuthStore({
    // Would resolve a user if the query token were (incorrectly) read.
    validateSession: (token) => (token === 'query-token' ? { plan: 'pro' } : null),
  });
  const enterpriseStore = makeEnterpriseStore();
  const { getAuthUserFromRequest } = createAuthHelpers({
    authStore,
    enterpriseStore,
    stripe: null,
    enterpriseMeterEventName: 'meter',
  });

  const req = { headers: {}, body: {}, query: { authToken: 'query-token' } };

  const result = getAuthUserFromRequest(req);

  assert.equal(result, null);
  // The security guarantee: no token was ever extracted, so validateSession saw null.
  assert.deepEqual(authStore.calls.validateSession, [null]);
});

test('getAuthUserFromRequest prefers the Authorization header over req.body.authToken when both are present', () => {
  const authStore = makeAuthStore({ validateSession: (token) => ({ token, plan: 'pro' }) });
  const { getAuthUserFromRequest } = createAuthHelpers({
    authStore,
    enterpriseStore: makeEnterpriseStore(),
    stripe: null,
    enterpriseMeterEventName: 'meter',
  });

  const req = { headers: { authorization: 'Bearer header-token' }, body: { authToken: 'body-token' } };
  getAuthUserFromRequest(req);

  assert.deepEqual(authStore.calls.validateSession, ['header-token'], 'the header token wins over the body token');
});

// ---------------------------------------------------------------------------
// enhanceUserWithEnterprise
// ---------------------------------------------------------------------------

test('enhanceUserWithEnterprise returns null for a null user', () => {
  const { enhanceUserWithEnterprise } = createAuthHelpers({
    authStore: makeAuthStore(),
    enterpriseStore: makeEnterpriseStore(),
    stripe: null,
    enterpriseMeterEventName: 'meter',
  });

  assert.equal(enhanceUserWithEnterprise(null), null);
});

test('enhanceUserWithEnterprise returns an already-pro user unchanged without consulting the enterprise store', () => {
  const enterpriseStore = makeEnterpriseStore({ activeDomains: ['example.com'] });
  const { enhanceUserWithEnterprise } = createAuthHelpers({
    authStore: makeAuthStore(),
    enterpriseStore,
    stripe: null,
    enterpriseMeterEventName: 'meter',
  });

  const user = { email: 'someone@example.com', plan: 'pro' };
  const result = enhanceUserWithEnterprise(user);

  assert.equal(result, user);
  // Early-return before the domain check: the store was never queried.
  assert.equal(enterpriseStore.calls.isActiveDomain.length, 0);
});

test('enhanceUserWithEnterprise upgrades a non-pro user on an active (lowercased) domain to pro', () => {
  const enterpriseStore = makeEnterpriseStore({ activeDomains: ['acme.com'] });
  const { enhanceUserWithEnterprise } = createAuthHelpers({
    authStore: makeAuthStore(),
    enterpriseStore,
    stripe: null,
    enterpriseMeterEventName: 'meter',
  });

  // Mixed-case domain in the email — the helper must lowercase before lookup.
  const user = { email: 'Worker@ACME.com', plan: 'free' };
  const result = enhanceUserWithEnterprise(user);

  assert.deepEqual(result, { email: 'Worker@ACME.com', plan: 'pro', enterpriseDomain: 'acme.com' });
  // The domain forwarded to the store was lowercased.
  assert.deepEqual(enterpriseStore.calls.isActiveDomain, ['acme.com']);
  // Original object is not mutated (Object.assign into a fresh object).
  assert.equal(user.plan, 'free');
  assert.equal('enterpriseDomain' in user, false);
});

test('enhanceUserWithEnterprise leaves a non-pro user on an inactive domain unchanged', () => {
  const enterpriseStore = makeEnterpriseStore({ activeDomains: [] });
  const { enhanceUserWithEnterprise } = createAuthHelpers({
    authStore: makeAuthStore(),
    enterpriseStore,
    stripe: null,
    enterpriseMeterEventName: 'meter',
  });

  const user = { email: 'worker@notenterprise.com', plan: 'free' };
  const result = enhanceUserWithEnterprise(user);

  assert.equal(result, user);
  assert.deepEqual(enterpriseStore.calls.isActiveDomain, ['notenterprise.com']);
});

// ---------------------------------------------------------------------------
// enterpriseDomainForUser
// ---------------------------------------------------------------------------

test('enterpriseDomainForUser returns null for a null user', () => {
  const { enterpriseDomainForUser } = createAuthHelpers({
    authStore: makeAuthStore(),
    enterpriseStore: makeEnterpriseStore(),
    stripe: null,
    enterpriseMeterEventName: 'meter',
  });

  assert.equal(enterpriseDomainForUser(null), null);
});

test('enterpriseDomainForUser returns null for an individual pro subscriber with their own Stripe customer', () => {
  // Stored account is an individual Stagify+ subscriber, so usage is NOT billed
  // to the enterprise domain even though the domain is active.
  const authStore = makeAuthStore({
    findUserByEmail: () => ({ plan: 'pro', stripeCustomerId: 'cus_x' }),
  });
  const enterpriseStore = makeEnterpriseStore({ activeDomains: ['acme.com'] });
  const { enterpriseDomainForUser } = createAuthHelpers({
    authStore,
    enterpriseStore,
    stripe: null,
    enterpriseMeterEventName: 'meter',
  });

  const result = enterpriseDomainForUser({ email: 'worker@acme.com' });

  assert.equal(result, null);
});

test('enterpriseDomainForUser returns the active enterprise domain for a non-individual-subscriber', () => {
  // No stored individual account -> falls through to the domain check.
  const authStore = makeAuthStore({ findUserByEmail: () => null });
  const enterpriseStore = makeEnterpriseStore({ activeDomains: ['acme.com'] });
  const { enterpriseDomainForUser } = createAuthHelpers({
    authStore,
    enterpriseStore,
    stripe: null,
    enterpriseMeterEventName: 'meter',
  });

  const result = enterpriseDomainForUser({ email: 'Worker@ACME.com', plan: 'free' });

  assert.equal(result, 'acme.com');
});

test('enterpriseDomainForUser returns null when the domain is inactive', () => {
  const authStore = makeAuthStore({ findUserByEmail: () => null });
  const enterpriseStore = makeEnterpriseStore({ activeDomains: [] });
  const { enterpriseDomainForUser } = createAuthHelpers({
    authStore,
    enterpriseStore,
    stripe: null,
    enterpriseMeterEventName: 'meter',
  });

  const result = enterpriseDomainForUser({ email: 'worker@acme.com', plan: 'free' });

  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// reportEnterpriseUsage
// ---------------------------------------------------------------------------

test('reportEnterpriseUsage always records local usage even when Stripe is not configured', () => {
  const enterpriseStore = makeEnterpriseStore();
  const { reportEnterpriseUsage } = createAuthHelpers({
    authStore: makeAuthStore(),
    enterpriseStore,
    stripe: null,
    enterpriseMeterEventName: 'meter',
  });

  reportEnterpriseUsage('acme.com', 3);

  assert.deepEqual(enterpriseStore.calls.recordUsage, [{ domain: 'acme.com', quantity: 3 }]);
  // With no Stripe client, the domain entry is never looked up for metering.
  assert.equal(enterpriseStore.calls.getDomainEntry.length, 0);
});

test('reportEnterpriseUsage emits a Stripe meter event with the customer id and stringified quantity', async () => {
  const stripe = makeStripe();
  const enterpriseStore = makeEnterpriseStore({
    getDomainEntry: () => ({ stripeCustomerId: 'cus_x' }),
  });
  const { reportEnterpriseUsage } = createAuthHelpers({
    authStore: makeAuthStore(),
    enterpriseStore,
    stripe,
    enterpriseMeterEventName: 'staging_generations',
  });

  reportEnterpriseUsage('acme.com', 5);

  // Local usage still recorded.
  assert.deepEqual(enterpriseStore.calls.recordUsage, [{ domain: 'acme.com', quantity: 5 }]);
  // Exactly one meter event, shaped as the source builds it.
  assert.equal(stripe.calls.create.length, 1);
  assert.deepEqual(stripe.calls.create[0], {
    event_name: 'staging_generations',
    payload: {
      stripe_customer_id: 'cus_x',
      value: '5',
    },
  });

  // Let the resolved .then() microtask settle so there is no dangling promise.
  await Promise.resolve();
});

test('reportEnterpriseUsage records usage but skips the meter event when the domain has no Stripe customer', () => {
  const stripe = makeStripe();
  const enterpriseStore = makeEnterpriseStore({
    // Domain entry exists but has no stripeCustomerId.
    getDomainEntry: () => ({ stripeCustomerId: null }),
  });
  const { reportEnterpriseUsage } = createAuthHelpers({
    authStore: makeAuthStore(),
    enterpriseStore,
    stripe,
    enterpriseMeterEventName: 'meter',
  });

  reportEnterpriseUsage('acme.com', 1);

  assert.deepEqual(enterpriseStore.calls.recordUsage, [{ domain: 'acme.com', quantity: 1 }]);
  assert.equal(stripe.calls.create.length, 0);
});

// ---------------------------------------------------------------------------
// toPublicAuthUser
// ---------------------------------------------------------------------------

test('toPublicAuthUser returns null for a null user', () => {
  const { toPublicAuthUser } = createAuthHelpers({
    authStore: makeAuthStore(),
    enterpriseStore: makeEnterpriseStore(),
    stripe: null,
    enterpriseMeterEventName: 'meter',
  });

  assert.equal(toPublicAuthUser(null), null);
});

test('toPublicAuthUser runs the enterprise-enhanced user through authStore.publicUser', () => {
  // publicUser echoes just the fields we care about, so we can prove which user
  // object it received (the enhanced, upgraded-to-pro one).
  const authStore = makeAuthStore({
    publicUser: (u) => ({ email: u.email, plan: u.plan, enterpriseDomain: u.enterpriseDomain }),
  });
  const enterpriseStore = makeEnterpriseStore({ activeDomains: ['acme.com'] });
  const { toPublicAuthUser } = createAuthHelpers({
    authStore,
    enterpriseStore,
    stripe: null,
    enterpriseMeterEventName: 'meter',
  });

  const result = toPublicAuthUser({ email: 'worker@acme.com', plan: 'free' });

  // The user handed to publicUser was enterprise-enhanced to pro.
  assert.equal(authStore.calls.publicUser.length, 1);
  assert.equal(authStore.calls.publicUser[0].plan, 'pro');
  assert.equal(authStore.calls.publicUser[0].enterpriseDomain, 'acme.com');

  assert.deepEqual(result, { email: 'worker@acme.com', plan: 'pro', enterpriseDomain: 'acme.com' });
});
