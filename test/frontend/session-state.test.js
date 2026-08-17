// Tier: frontend island logic — public/scripts/session-state.js.
//
// Four lines, and both of the site's pre-paint tricks depend on getting them right:
//
//   • exterior-studio-gate.js pre-paints the Pro page shape from the cached plan;
//   • session-class.js pre-paints the nav's Gallery tab from the stored token.
//
// Each is a GUESS made before /api/auth/me can answer, and each is undone by a writer that
// asks this predicate whether the answer has arrived. Both failure modes are silent:
//
//   too eager  → the guess is undone during the in-flight window, which is precisely the
//                flash both mechanisms exist to remove. Nothing errors; the UI just blinks.
//   too slow   → a signed-out or downgraded visitor keeps UI the writer believes it has
//                already taken away, because the pre-paint CSS still outranks it.
//
// The trap it exists to avoid is reading "no user" as "signed out". Before the request has
// even been sent that is exactly what `window.StagifyAuth` looks like.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { authSettled } from '../../public/scripts/session-state.js';

test('an answered request is settled, whatever the answer was', () => {
  assert.equal(authSettled({ user: { plan: 'pro' }, getToken: () => 'tok' }), true);
  assert.equal(authSettled({ user: { plan: 'free' }, getToken: () => 'tok' }), true);
  assert.equal(authSettled({ user: { id: 'u1' }, getToken: () => 'tok' }), true, 'any user object counts');
});

test('no token is settled too — there is nothing to wait for', () => {
  // The half that is easy to miss. This is also the sign-out branch: clear() drops the
  // token and the user together, and the pre-painted UI has to go with them.
  assert.equal(authSettled({ user: null, getToken: () => null }), true);
  assert.equal(authSettled({ user: null, getToken: () => '' }), true, 'an empty token is no token');
  assert.equal(authSettled({ user: null }), true, 'no getToken at all means no token');
});

test('a token with no answer yet is the ONE unsettled state', () => {
  // The whole window the pre-paint guesses cover. If this ever returns true, both of them
  // stop working and nothing fails.
  assert.equal(authSettled({ user: null, getToken: () => 'tok' }), false);
  assert.equal(authSettled({ user: undefined, getToken: () => 'tok' }), false);
});

test('a missing auth object is settled, not in flight', () => {
  // auth.js may not have evaluated yet, and admin.html never loads it. Unsettled here
  // would strand a guess forever on a page with no plan check to wait for.
  assert.equal(authSettled(null), true);
  assert.equal(authSettled(undefined), true);
});

test('it asks about the ANSWER, never about whether the visitor is signed in', () => {
  // Both callers already know how to read the plan; what they cannot work out for
  // themselves is whether the reading is trustworthy yet. A signed-out visitor is
  // perfectly well known — and collapsing "unknown" into "signed out" is the bug.
  const signedOut = { user: null, getToken: () => null };
  const inFlight = { user: null, getToken: () => 'tok' };
  assert.notEqual(
    authSettled(signedOut),
    authSettled(inFlight),
    'these two look identical through `user` alone, and must not be treated alike',
  );
});
