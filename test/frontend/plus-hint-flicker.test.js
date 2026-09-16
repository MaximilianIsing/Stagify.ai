// Tier: frontend island logic + shipped markup — the pre-paint half of the Stagify+
// checkout hint (public/stagify-plus.html, styles/stagify-plus.css, scripts/stagify-plus.js).
//
// WHY THIS EXISTS
// #plus-checkout-hint ships with the SIGNED-OUT copy ("Create a free account first…"),
// because that is the right no-JS default and the only state a crawler can be shown. Which
// hint actually belongs there is knowable only from /api/auth/me, a round trip after
// DOMContentLoaded — so a subscriber read the sign-up advice for a few hundred ms and then
// watched the pricing card jump up as applyStripeCheckout() removed the paragraph.
//
// The page already loads scripts/session-class.js, which sets html.has-session from the
// stored token BEFORE the first paint, so the fix is one CSS rule over a marker class and
// one line of JS that surrenders the guess. All three pieces fail silently on their own —
// a dropped class leaves the flash, a dropped rule leaves it too, and a JS render that
// forgets to remove the class hides the hint from the signed-out visitors it is FOR — so
// each is pinned here. Same guess-then-correct bargain as scripts/preview-gate.js, and the
// class is never an authorization: no checkout is reachable without a client_reference_id
// (test/frontend/plus-checkout-requires-account.test.js).

import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mountPlusPage, fakeProfileMenu, pageHtml } from '../helpers/plus-page-dom.js';

const PENDING = 'sp-hint--pending';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const css = fs.readFileSync(path.join(ROOT, 'public', 'styles', 'stagify-plus.css'), 'utf8');

const PRO_USER = { id: 'u_abc123', email: 'pro@example.com', plan: 'pro', canManageSubscription: true };
const FREE_USER = { id: 'u_0123456789abcdef01234567', email: 'buyer@example.com', plan: 'free' };

mountPlusPage({ profileMenu: fakeProfileMenu() });
const { applyStripeCheckout } = await import('../../public/scripts/stagify-plus.js');

/** Mount the page with the hint in the state the markup ships it in. */
function mountPending(opts) {
  const mounted = mountPlusPage(opts);
  mounted.hint.classList.add(PENDING);
  return mounted;
}

// ---- the three pieces, each useless alone ----------------------------------

test('the hint ships with the pending class', () => {
  const html = pageHtml();
  const at = html.indexOf('id="plus-checkout-hint"');
  assert.notEqual(at, -1, 'the hint moved');
  const tag = html.slice(html.lastIndexOf('<p', at), html.indexOf('>', at) + 1);
  assert.ok(tag.includes(PENDING), `without ${PENDING} the hint paints for subscribers again:\n${tag}`);
  assert.ok(!tag.includes('hidden'), 'it must NOT ship hidden — signed-out visitors need it from the first frame');
});

test('the page still loads the script that sets html.has-session before paint', () => {
  // The CSS rule below is inert without it, and nothing else on this page uses the class.
  assert.ok(pageHtml().includes('scripts/session-class.js'), 'session-class.js is what arms the pre-paint guess');
});

test('the stylesheet hides the pending hint only for a visitor with a session', () => {
  const flat = css.replace(/\s+/g, ' ');
  assert.match(
    flat,
    new RegExp(`html\\.has-session \\.${PENDING} \\{[^}]*display: none`),
    'the rule that beats the flash is gone, or no longer keyed on the pre-paint session class',
  );
  // …and nothing else may key on the class: an unqualified rule would hide the hint from
  // the signed-out visitors it is written for, with no session class to switch it back on.
  const uses = flat.split(`.${PENDING}`).length - 1;
  const guarded = flat.split(`html.has-session .${PENDING}`).length - 1;
  assert.equal(uses, guarded, `every .${PENDING} rule must sit behind html.has-session`);
});

// ---- the guess is surrendered on every path --------------------------------

for (const [name, user] of [
  ['an existing subscriber', PRO_USER],
  ['a signed-in free account', FREE_USER],
  ['a signed-out visitor', null],
]) {
  test(`the first render hands the hint over: ${name}`, () => {
    const { hint } = mountPending({ profileMenu: fakeProfileMenu() });
    applyStripeCheckout(user);
    assert.ok(!hint.classList.contains(PENDING), 'a branch that keeps the class hides the hint for good');
  });
}

test('the guess is surrendered even with no profile-menu island', () => {
  // This branch shows the "sign in from the profile menu first" hint — to somebody the
  // stored token says is signed in, which is exactly when the CSS would be suppressing it.
  const { hint } = mountPending({ profileMenu: undefined });
  applyStripeCheckout(null);
  assert.ok(!hint.classList.contains(PENDING));
  assert.ok(hint.textContent.length > 0, 'and the hint it wrote must be visible');
});

test('an expired token still gets the signed-out hint back', () => {
  // fetchMe() clears the session and renders with null: the pre-paint guess was wrong, and
  // showing the advice a round trip late beats never showing it.
  const { hint } = mountPending({ profileMenu: fakeProfileMenu() });
  applyStripeCheckout(null);
  assert.ok(!hint.classList.contains(PENDING));
  assert.ok(!hint.classList.contains('hidden'));
  assert.ok(hint.textContent.length > 0);
});
