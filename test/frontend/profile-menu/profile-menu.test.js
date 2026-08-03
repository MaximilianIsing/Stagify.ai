// The profile dropdown's rendering (public/scripts/profile-menu.js).
//
// Companion to auth-modal.test.js: both files were ES5 extraction artifacts that
// got modernized (`var` → `const`/`let`), and a keyword swap is not as safe as it
// looks — `var` is function-scoped and hoisted, so a mechanical conversion can
// introduce a temporal-dead-zone throw or silently narrow a variable's scope. The
// module is also an IIFE that runs on import, so a TDZ error would surface as a
// blank dropdown on every page, not as a test failure. Hence: cover what it
// renders, then convert.
//
// IMPORT ORDER MATTERS: profile-menu.js runs its IIFE at import time and touches
// `document`/`window` immediately, so the shim is installed at module scope and the
// module is pulled in with a dynamic `import()` afterwards. ESM caches modules per
// process, so the IIFE runs exactly once for this file — the tests then drive the
// exported `refresh()` rather than re-importing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installAuthModalDom } from '../../helpers/auth-modal-dom.js';

const dom = installAuthModalDom({
  extraIds: ['profile-menu-btn', 'profile-menu-dropdown'],
});

await import('../../../public/scripts/profile-menu.js');

const menu = globalThis.window.StagifyProfileMenu;
const dropdown = dom.el('profile-menu-dropdown');

/** Re-render the dropdown for a given signed-in user (null = signed out). */
function renderFor(user) {
  globalThis.window.StagifyAuth.user = user;
  menu.refresh();
  return dropdown.innerHTML;
}

test('the module boots and publishes its API without throwing', () => {
  // The TDZ check: if the const/let conversion had broken hoisting, importing the
  // module above would have thrown and this file would fail at load.
  assert.equal(typeof menu.refresh, 'function');
  assert.equal(typeof menu.closeDropdown, 'function');
  assert.equal(typeof menu.openAuthModal, 'function');
  assert.equal(typeof menu.setAuthModeRegister, 'function');
  assert.equal(typeof globalThis.window.__stagifyOpenAuthForStaging, 'function');
});

test('signed out: sign-in and create-account actions, marked as the guest menu', () => {
  const html = renderFor(null);

  assert.ok(html.includes('data-profile-action="signin"'));
  assert.ok(html.includes('data-profile-action="signup"'));
  assert.ok(!html.includes('data-profile-action="signout"'), 'nothing to sign out of');
  assert.equal(dropdown.classList.contains('profile-menu-dropdown--guest'), true);
});

test('free plan: shows the upgrade row, not the manage-subscription row', () => {
  const html = renderFor({ email: 'free@example.com', plan: 'free' });

  assert.ok(html.includes('free@example.com'), 'the account is named');
  assert.ok(html.includes('Free Plan'));
  assert.ok(html.includes('profile-menu__link--plus'), 'upgrade path is offered');
  assert.ok(!html.includes('data-profile-action="manage-subscription"'), 'nothing to manage yet');
  assert.ok(html.includes('data-profile-action="signout"'));
  assert.equal(dropdown.classList.contains('profile-menu-dropdown--guest'), false);
});

test('every signed-in menu offers the bug channel, in the row above Sign out', () => {
  // /api/bug-report was reachable from ONE control in the app (the AI Designer's bug
  // button), so a problem anywhere else had nowhere to go. Position is part of the
  // fix: the report row has to sit above Sign out, or it is the row people hit while
  // reaching for the destructive one — and vice versa.
  for (const user of [
    { email: 'free@example.com', plan: 'free' },
    { email: 'pro@example.com', plan: 'pro' },
    { email: 'pro@example.com', plan: 'pro', canManageSubscription: true },
  ]) {
    const html = renderFor(user);
    const report = html.indexOf('data-profile-action="report-issue"');
    const signout = html.indexOf('data-profile-action="signout"');
    assert.notEqual(report, -1, `no report row for ${JSON.stringify(user)}`);
    assert.ok(report < signout, 'the report row belongs directly above Sign out');
    // From just past the report row's own marker, so only a THIRD row trips this.
    assert.ok(!html.slice(report + 1, signout).includes('data-profile-action='),
      'nothing may come between them');
    assert.ok(html.includes('Report an issue'));
  }
});

test('the report row is a plain item, not styled as the destructive one', () => {
  // .profile-menu__item--danger is red — reserved for Sign out. A red "Report an
  // issue" reads as "delete my account", which is a click nobody wants to guess at.
  const html = renderFor({ email: 'free@example.com', plan: 'free' });
  const row = html.slice(html.indexOf('data-profile-action="report-issue"') - 200,
    html.indexOf('data-profile-action="report-issue"'));
  assert.ok(!row.includes('profile-menu__item--danger'));
});

test('pro plan: shows the plan badge and hides the upgrade row', () => {
  const html = renderFor({ email: 'pro@example.com', plan: 'pro' });

  assert.ok(html.includes('profile-menu__plan--plus'), 'the Stagify+ badge');
  assert.ok(!html.includes('profile-menu__link--plus'), 'a subscriber is not asked to upgrade');
  assert.ok(!html.includes('data-profile-action="manage-subscription"'),
    'manage appears only when the account can actually manage a subscription');
});

test('pro plan with a manageable subscription: the manage row appears', () => {
  const html = renderFor({ email: 'pro@example.com', plan: 'pro', canManageSubscription: true });

  assert.ok(html.includes('data-profile-action="manage-subscription"'));
  assert.ok(html.includes('profile-menu__portal-help'), 'the Stripe help link rides along off staging');
});

test('the rendered email is escaped, not interpolated raw', () => {
  // The address is server-supplied data landing in an innerHTML string; the
  // dedicated scan in test/frontend/escape-html.test.js covers the lang() values,
  // this covers the one genuinely user-controlled field.
  const html = renderFor({ email: '<img src=x onerror=alert(1)>@example.com', plan: 'free' });

  assert.ok(!html.includes('<img src=x'), 'no raw tag survives into the dropdown');
  assert.ok(html.includes('&lt;img src=x'), 'it is rendered as visible text');
});

test('refresh is a no-op when the dropdown is missing rather than throwing', () => {
  // Every page loads this module, including ones with no profile menu markup.
  const realGet = globalThis.document.getElementById;
  globalThis.document.getElementById = (id) => (id === 'profile-menu-dropdown' ? null : realGet(id));
  try {
    assert.doesNotThrow(() => menu.refresh());
  } finally {
    globalThis.document.getElementById = realGet;
  }
});
