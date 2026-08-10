// Tier: frontend island logic (DOM-stubbed) — public/scripts/stagify-plus.js.
//
// WHY THIS EXISTS
// The individual plan has no server-side Checkout Session. It is a public Stripe
// Payment Link, and the ONLY thing that reliably maps a completed checkout back onto an
// account is the `client_reference_id` this script appends. A signed-out visitor has no
// id to append — so while the button stayed live for them, the webhook reached
// activateProFromStripeCheckout() with nothing but whatever address the buyer typed at
// Stripe. If it matched no account — the ordinary case for somebody who found the
// pricing page before ever signing up — the result was `no_user`: money in, no plan, one
// logger.warn and no notification to anyone. The most motivated visitor on the site was
// the one the flow lost.
//
// So the rule is: no id, no Stripe. This pins BOTH halves, because each fails silently
// on its own:
//   - the signed-out button must not carry the payment link (nor let a click reach it),
//   - the signed-in button must still carry `client_reference_id`, or the gate has
//     bought nothing.
//
// It also pins the SHIPPED MARKUP, which is the half a DOM test would otherwise miss:
// stagify-plus.html used to hard-code the Payment Link in the href, leaving it clickable
// for the whole gap between "page is interactive" and "fetchMe() resolved". Re-adding it
// would reopen the hole with every assertion below still green.
//
// The deliberate exception is the last test: with no profile-menu island there is nobody
// to sign the visitor up, and a button that can neither check out nor register is worse
// than an unmapped checkout. That fallback is a decision, not an oversight, so it is
// written down here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountPlusPage, fakeProfileMenu, checkoutAnchorTag, pageHtml } from '../helpers/plus-page-dom.js';

const PAYMENT_HOST = 'buy.stripe.com';
const PRO_USER = { id: 'u_abc123', email: 'pro@example.com', plan: 'pro', canManageSubscription: true };
const FREE_USER = { id: 'u_0123456789abcdef01234567', email: 'buyer@example.com', plan: 'free' };

// The module wires up `languagechange` / `DOMContentLoaded` at import time, so the
// globals have to exist before it loads.
mountPlusPage({ profileMenu: fakeProfileMenu() });
const { applyStripeCheckout } = await import('../../public/scripts/stagify-plus.js');

/** Everything the element could expose to a click, as one searchable string. */
function surfaceOf(link) {
  return [link.href, link.getAttribute('href') ?? '', link.innerHTML].join(' ');
}

// ---- the shipped markup ----------------------------------------------------

test('stagify-plus.html ships the checkout button with no href', () => {
  const tag = checkoutAnchorTag();
  assert.ok(
    !/\shref=/.test(tag),
    `the checkout anchor ships an href again — that is clickable before fetchMe() resolves:\n${tag}`,
  );
  assert.ok(!pageHtml().includes(PAYMENT_HOST), 'the Payment Link belongs in stagify-plus.js, not the markup');
});

// ---- signed out: no id, no Stripe ------------------------------------------

test('a signed-out visitor cannot reach Stripe from the checkout button', () => {
  const { link, hint } = mountPlusPage({ profileMenu: fakeProfileMenu() });
  applyStripeCheckout(null);

  assert.equal(link.getAttribute('href'), null, 'signed-out checkout must not carry an href');
  assert.ok(!surfaceOf(link).includes(PAYMENT_HOST), 'the payment link leaked to a visitor with no account id');
  assert.equal(link.getAttribute('target'), null, 'a stale target would survive a re-added href');
  assert.ok(hint.textContent.length > 0, 'the visitor must be told why the button does something else');
});

test('the signed-out button is an actionable control, not a disabled one', () => {
  const { link } = mountPlusPage({ profileMenu: fakeProfileMenu() });
  applyStripeCheckout(null);

  // It still ACTS — it opens the sign-up modal — so aria-disabled would be a lie to
  // exactly the users who most need the label. Same call as the locked Staging rows.
  assert.equal(link.getAttribute('role'), 'button');
  assert.equal(link.getAttribute('tabindex'), '0', 'an <a> with no href is not focusable on its own');
  assert.equal(link.getAttribute('aria-disabled'), null, 'the control is not disabled, it is redirected');
  assert.ok(link.innerHTML.includes('Start free trial'), 'the offer itself is unchanged');
});

test('clicking it asks for an account and remembers the intent', () => {
  const pm = fakeProfileMenu();
  const { link } = mountPlusPage({ profileMenu: pm });
  applyStripeCheckout(null);

  const e = link.fire('click');
  assert.equal(e.defaultPrevented, true);
  assert.equal(pm.calls.openAuthModal, 1);
  assert.equal(pm.calls.registerMode, true, 'they have no account — open the modal in register mode');
  // The flag both sign-in paths already resume (profile-menu/auth-modal.js,
  // profile-menu/google-signin.js) by navigating back to this page.
  assert.equal(globalThis.window.__stagifyPendingPlusRedirect, true);
});

test('keyboard activation works, and only on the keys that should activate', () => {
  const pm = fakeProfileMenu();
  const { link } = mountPlusPage({ profileMenu: pm });
  applyStripeCheckout(null);

  link.fire('keydown', { key: 'Tab' });
  assert.equal(pm.calls.openAuthModal, 0, 'Tab must move focus, not open the modal');
  link.fire('keydown', { key: 'Enter' });
  link.fire('keydown', { key: ' ' });
  assert.equal(pm.calls.openAuthModal, 2);
});

test('re-rendering does not stack duplicate listeners', () => {
  const pm = fakeProfileMenu();
  const { link } = mountPlusPage({ profileMenu: pm });
  applyStripeCheckout(null);
  applyStripeCheckout(null); // e.g. a mid-session language switch
  applyStripeCheckout(null);

  link.fire('click');
  assert.equal(pm.calls.openAuthModal, 1, 'one click, one modal');
});

test('a listener bound while signed out goes quiet once the button is a real link', () => {
  const pm = fakeProfileMenu();
  const { link } = mountPlusPage({ profileMenu: pm });
  applyStripeCheckout(null);
  applyStripeCheckout(FREE_USER); // they signed in without a reload

  const e = link.fire('click');
  assert.equal(e.defaultPrevented, false, 'the click must now follow the href to Stripe');
  assert.equal(pm.calls.openAuthModal, 0);
});

// ---- signed in: the gate has to be worth something --------------------------

test('a signed-in free account gets a checkout link that can be mapped back', () => {
  const { link, hint } = mountPlusPage({ profileMenu: fakeProfileMenu() });
  applyStripeCheckout(FREE_USER);

  assert.ok(link.href.startsWith(`https://${PAYMENT_HOST}/`), link.href);
  assert.ok(
    link.href.includes(`client_reference_id=${FREE_USER.id}`),
    'without this the webhook falls back to an unverified email — the whole point of the gate',
  );
  assert.ok(link.href.includes(`prefilled_email=${encodeURIComponent(FREE_USER.email)}`));
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(link.getAttribute('role'), null, 'a real link is not a role="button"');
  assert.equal(hint.textContent, '', 'nothing left to warn them about');
});

test('an existing subscriber is still shown as subscribed, with no link', () => {
  const { link } = mountPlusPage({ profileMenu: fakeProfileMenu() });
  applyStripeCheckout(PRO_USER);

  assert.equal(link.getAttribute('href'), null);
  assert.ok(link.innerHTML.includes('Subscribed'));
  assert.equal(link.getAttribute('aria-disabled'), 'true', 'this one really is inert');
  assert.equal(link.getAttribute('role'), null, 'the signed-out role must not survive the state change');
});

// ---- the deliberate fallback ------------------------------------------------

test('with no profile-menu island the payment link comes back', () => {
  // Nobody to sign them up with, so a dead button would cost every sale on the page.
  // An unmapped checkout is recoverable by hand; a button that does nothing is not.
  const { link, hint } = mountPlusPage({ profileMenu: undefined });
  applyStripeCheckout(null);

  assert.ok(link.href.includes(PAYMENT_HOST), 'the fallback is deliberate — see the header');
  assert.ok(hint.textContent.length > 0, 'they still need telling to sign in first');
});
