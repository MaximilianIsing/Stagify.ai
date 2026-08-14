// Unit tests for public/scripts/unstageable-cta.js — the one place that decides where a
// rejected upload can send the user next, and under which label.
//
// Two things here are cross-tier on purpose. The server's UNSTAGEABLE_CODES is imported
// directly so "EXTERIOR is the only category with a CTA" is asserted against the real
// taxonomy rather than a list copied into this file; and the real localizedTarget is
// exercised once, because the locale-prefix bug is invisible in English and wrong in ten
// languages.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { unstageableCta, EXTERIOR_CODE } from '../../public/scripts/unstageable-cta.js';
import { UNSTAGEABLE_CODES, GENERIC_UNSTAGEABLE_CODE } from '../../lib/staging/unstageable.js';

// The module reads the global `window` for the plan; give it one per test.
globalThis.window = /** @type {any} */ ({});
afterEach(() => {
  globalThis.window = /** @type {any} */ ({});
  delete (/** @type {any} */ (globalThis).location);
});

/** Sign in a user with the given plan, the way auth.js exposes it. */
function signedInAs(plan) {
  globalThis.window = /** @type {any} */ ({
    StagifyAuth: {
      user: { plan },
      isProUser() { return this.user.plan === 'pro'; },
    },
  });
}

/** A verdict shaped like /api/validate-image's rejection body. */
const verdict = (code) => ({ valid: false, code, reason: 'server English' });

// --- which categories get a CTA at all --------------------------------------

test('EXTERIOR is the ONLY server code that offers a follow-up action', () => {
  // The mutation guard. Driven off the server taxonomy, so adding an eighth category
  // cannot silently inherit a link to the Exterior Studio, and "only one" cannot drift
  // into "some" without this failing.
  const others = Object.values(UNSTAGEABLE_CODES)
    .map((e) => e.code)
    .filter((code) => code !== EXTERIOR_CODE);
  assert.ok(others.length >= 5, 'sanity: the taxonomy still has the other categories');
  signedInAs('pro');
  for (const code of [...others, GENERIC_UNSTAGEABLE_CODE]) {
    assert.equal(unstageableCta(verdict(code), { localize: (r) => r }), null, `${code} must not get a CTA`);
  }
});

test('EXTERIOR_CODE is a code the server can actually send', () => {
  // Renaming the category server-side would leave the sentence perfect and the button
  // gone, with nothing throwing anywhere. This is the only place that notices.
  const serverCodes = Object.values(UNSTAGEABLE_CODES).map((e) => e.code);
  assert.ok(serverCodes.includes(EXTERIOR_CODE), `${EXTERIOR_CODE} is no longer in UNSTAGEABLE_CODES`);
});

test('a missing, codeless or malformed verdict gets no CTA', () => {
  signedInAs('pro');
  for (const v of [null, undefined, {}, { code: null }, { code: '' }, { reason: 'x' }]) {
    assert.equal(unstageableCta(/** @type {any} */ (v), { localize: (r) => r }), null);
  }
});

// --- the two plan states ----------------------------------------------------

test('Stagify+ is sent to the Exterior Studio, and told so', () => {
  signedInAs('pro');
  const cta = unstageableCta(verdict('EXTERIOR'), { localize: (r) => r });
  assert.ok(cta);
  assert.equal(cta.href, 'exterior-studio.html');
  assert.equal(cta.labelKey, 'errors.unstageableCta.exteriorOpen');
  assert.equal(cta.upgrade, false);
  assert.ok(cta.fallbackLabel.length > 0, 'a pack-less page still needs a readable label');
});

test('a free account is sent to the Stagify+ page, and told THAT', () => {
  // The label has to match where the click lands. "Open the Exterior Studio" pointing at
  // a pricing table is the bait-and-switch this pairing exists to prevent.
  signedInAs('free');
  const cta = unstageableCta(verdict('EXTERIOR'), { localize: (r) => r });
  assert.ok(cta);
  assert.equal(cta.href, 'stagify-plus.html');
  assert.equal(cta.labelKey, 'errors.unstageableCta.exteriorUpgrade');
  assert.equal(cta.upgrade, true);
});

test('the two plans never share a href or a label', () => {
  signedInAs('pro');
  const pro = unstageableCta(verdict('EXTERIOR'), { localize: (r) => r });
  signedInAs('free');
  const free = unstageableCta(verdict('EXTERIOR'), { localize: (r) => r });
  assert.notEqual(pro.href, free.href);
  assert.notEqual(pro.labelKey, free.labelKey);
  assert.notEqual(pro.fallbackLabel, free.fallbackLabel);
});

// --- how the plan is read ---------------------------------------------------

test('an anonymous visitor is treated as free, not crashed on', () => {
  // Unreachable through /api/validate-image, which 401s without a session — but the
  // module must not assume that, because a fail-open verdict can be synthesised anywhere.
  globalThis.window = /** @type {any} */ ({});
  assert.equal(unstageableCta(verdict('EXTERIOR'), { localize: (r) => r }).upgrade, true);
  globalThis.window = /** @type {any} */ ({ StagifyAuth: { user: null } });
  assert.equal(unstageableCta(verdict('EXTERIOR'), { localize: (r) => r }).upgrade, true);
});

test('the plan is read through isProUser(), and falls back to the raw field', () => {
  // Both idioms, because auth.js publishes the object before the predicate is useful.
  globalThis.window = /** @type {any} */ ({ StagifyAuth: { user: { plan: 'free' }, isProUser: () => true } });
  assert.equal(unstageableCta(verdict('EXTERIOR'), { localize: (r) => r }).upgrade, false, 'predicate wins');

  globalThis.window = /** @type {any} */ ({ StagifyAuth: { user: { plan: 'pro' } } });
  assert.equal(unstageableCta(verdict('EXTERIOR'), { localize: (r) => r }).upgrade, false, 'raw field is the fallback');
});

test('an explicit isPro override beats the page, so callers can be tested in isolation', () => {
  signedInAs('free');
  assert.equal(unstageableCta(verdict('EXTERIOR'), { isPro: true, localize: (r) => r }).upgrade, false);
  signedInAs('pro');
  assert.equal(unstageableCta(verdict('EXTERIOR'), { isPro: false, localize: (r) => r }).upgrade, true);
});

// --- the locale prefix ------------------------------------------------------

test('the real localizedTarget keeps a localized visitor inside their locale', () => {
  // The whole reason this module owns the href instead of the markup. Under <base
  // href="/">, a bare 'exterior-studio.html' resolves to the ENGLISH page for an /es
  // visitor — a bug that passes every English test there is.
  /** @type {any} */ (globalThis).location = { pathname: '/es/index.html', hash: '' };
  signedInAs('pro');
  assert.equal(unstageableCta(verdict('EXTERIOR')).href, '/es/exterior-studio.html');
  signedInAs('free');
  assert.equal(unstageableCta(verdict('EXTERIOR')).href, '/es/stagify-plus.html');
});

test('the real localizedTarget leaves the English root alone', () => {
  /** @type {any} */ (globalThis).location = { pathname: '/index.html', hash: '' };
  signedInAs('pro');
  assert.equal(unstageableCta(verdict('EXTERIOR')).href, 'exterior-studio.html');
});
