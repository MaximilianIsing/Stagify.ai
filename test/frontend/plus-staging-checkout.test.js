// Tier: frontend island logic (DOM-stubbed) — the IS_STAGING branch of
// public/scripts/stagify-plus.js.
//
// WHY THIS EXISTS
// The staging branch disables checkout, and the cheapest way to make a button look
// disabled was to borrow the subscriber's class, `sp-gradient-checkout-btn--subscribed`.
// That class is not a style: public/scripts/stagify-plus-blackhole.js reads it as
// "this viewer is already Stagify+" and pins the black-hole lens to zero for them. So
// staging — the one place the page is actually looked at before it ships — was the one
// place the effect never ran, and nobody could see they had broken it.
//
// The rule now is: only a real subscriber gets `--subscribed`. Staging gets `--inert`,
// which touches nothing but the cursor. This pins both halves, because each is silent
// on its own:
//   - staging must NOT carry the subscriber class (or the lens is dead again),
//   - a Stagify+ subscriber ON staging must still get it (that branch runs first).
// It also pins the absence of the old "Subscriptions are disabled on the staging site."
// paragraph: staging is meant to read as the live page, and the button label is the
// only tell it needs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountPlusPage, fakeProfileMenu } from '../helpers/plus-page-dom.js';

const SUBSCRIBED = 'sp-gradient-checkout-btn--subscribed';
const INERT = 'sp-gradient-checkout-btn--inert';
const PRO_USER = { id: 'u_abc123', email: 'pro@example.com', plan: 'pro', canManageSubscription: true };
const FREE_USER = { id: 'u_0123456789abcdef01234567', email: 'buyer@example.com', plan: 'free' };

// IS_STAGING is module-private and only ever set from /api/auth/config inside the
// module's own DOMContentLoaded handler — so the only honest way to reach this branch
// is to boot the module the way the browser does. Capture that handler at import time.
mountPlusPage({ profileMenu: fakeProfileMenu() });
/** @type {Array<Function>} */
const ready = [];
globalThis.document.addEventListener = (type, fn) => {
  if (type === 'DOMContentLoaded') ready.push(fn);
};
const { applyStripeCheckout } = await import('../../public/scripts/stagify-plus.js');
assert.equal(ready.length, 1, 'stagify-plus.js no longer boots from DOMContentLoaded');

/**
 * Boot the page as the staging site would, then hand back its elements.
 * @param {any} user
 */
async function bootStaging(user) {
  const mounted = mountPlusPage({ profileMenu: fakeProfileMenu() });
  globalThis.window.StagifyAuth = {
    user,
    fetchConfig: () => Promise.resolve({ googleClientId: null, isStaging: true }),
    fetchMe: () => Promise.resolve(user),
  };
  await ready[0]();
  // The handler renders inside a .then(); let that microtask run.
  await Promise.resolve();
  await Promise.resolve();
  return mounted;
}

test('staging does not borrow the subscriber class, so the black hole still runs', async () => {
  const { link } = await bootStaging(FREE_USER);

  assert.equal(
    link.classList.contains(SUBSCRIBED),
    false,
    `${SUBSCRIBED} means "already Stagify+" to stagify-plus-blackhole.js — it kills the lens on staging`,
  );
  assert.equal(link.classList.contains(INERT), true, 'the button is still dead, it just looks alive');
});

test('staging says so on the button and nowhere else', async () => {
  const { link, hint } = await bootStaging(FREE_USER);

  assert.ok(link.innerHTML.includes('Unavailable on staging'), link.innerHTML);
  assert.equal(hint.textContent, '', 'the explanatory paragraph is gone — the label is the whole tell');
  assert.equal(hint.classList.contains('hidden'), true);
});

test('the staging button cannot reach Stripe', async () => {
  const { link } = await bootStaging(FREE_USER);

  assert.equal(link.getAttribute('href'), null);
  assert.equal(link.getAttribute('target'), null);
  assert.equal(link.getAttribute('aria-disabled'), 'true');
  assert.equal(link.getAttribute('tabindex'), '-1');
});

test('a Stagify+ subscriber on staging is still shown as subscribed, with no lens', async () => {
  // The plan === 'pro' branch runs BEFORE the staging one, which is the only reason a
  // subscriber keeps the class that turns the effect off. Reorder them and this fails.
  const { link, els } = await bootStaging(PRO_USER);

  assert.ok(link.innerHTML.includes('Subscribed'), link.innerHTML);
  assert.equal(link.classList.contains(SUBSCRIBED), true);
  assert.equal(link.classList.contains(INERT), false);
  assert.equal(els['sp-manage-subscription-wrap'].classList.contains('hidden'), false);
});

test('leaving the staging state clears the inert class', async () => {
  // A language switch re-renders through applyStripeCheckout; so does signing out of a
  // pro session. Neither may strand a class from the branch it left.
  const { link } = await bootStaging(FREE_USER);
  assert.equal(link.classList.contains(INERT), true);

  applyStripeCheckout(PRO_USER);
  assert.equal(link.classList.contains(INERT), false, 'a stale --inert would outlive its branch');
  assert.equal(link.classList.contains(SUBSCRIBED), true);
});
