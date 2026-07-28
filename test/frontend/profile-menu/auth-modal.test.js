// Characterization tests for the auth modal (public/scripts/profile-menu/auth-modal.js).
//
// WHY THESE EXIST: this file is the sign-in / create-account / forgot-password /
// verify-email surface — the flagship auth path — and it had **no unit coverage at
// all**. It was then modernized (ES5 extraction artifacts → const/let, and the
// per-toggle re-query of ~20 elements replaced by a cached lookup). A refactor of
// untested code is a rewrite with extra steps, so these were written FIRST, against
// the ES5 version, and had to keep passing unchanged afterwards. That is the whole
// point of them: they encode the behaviour, not the implementation.
//
// They deliberately assert on OBSERVABLE state — which panels are hidden, what the
// title/labels say, which element is readOnly, what got POSTed — never on internals
// like how many times getElementById was called. A cache that returns the right
// element is indistinguishable from a re-query that returns the right element, and
// that is exactly the property being protected.
//
// The DOM is a hand-rolled shim seeded from the real template; see
// test/helpers/auth-modal-dom.js. No jsdom, no network, no Google script.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installAuthModalDom, templateIds } from '../../helpers/auth-modal-dom.js';
import { createAuthModal } from '../../../public/scripts/profile-menu/auth-modal.js';

let dom = null;
afterEach(() => { if (dom) { dom.restore(); dom = null; } });

/** Mount the modal with the shim installed, returning both. */
function mount(opts = {}) {
  dom = installAuthModalDom(opts);
  const modal = createAuthModal({
    onRefresh: () => { dom.calls.refresh += 1; },
    onCloseDropdown: () => { dom.calls.closeDropdown += 1; },
  });
  return modal;
}

test('the shim covers the real template — every id the modal looks up exists', () => {
  // Guards the fixture itself: if the template drops an id the modal still queries,
  // the spec below would be asserting against nulls and quietly prove nothing.
  const ids = templateIds();
  for (const required of [
    'auth-modal', 'auth-modal-title', 'auth-modal-sub', 'auth-submit-label',
    'auth-standard-panel', 'auth-forgot-panel', 'auth-verify-panel',
    'auth-password-confirm-row', 'auth-toggle-label', 'auth-mode-toggle',
  ]) {
    assert.ok(ids.includes(required), `the template no longer has #${required}`);
  }
});

test('register mode: confirm-password shown, register copy, forgot link hidden', () => {
  const modal = mount();
  modal.selectMode(true);

  assert.equal(dom.el('auth-modal-title').textContent, 'Create your free account');
  assert.equal(dom.el('auth-modal-sub').textContent, 'Sign up to upload and stage images.');
  assert.equal(dom.el('auth-submit-label').textContent, 'Continue');
  assert.equal(dom.el('auth-toggle-label').textContent, 'Already have an account?');
  assert.equal(dom.el('auth-mode-toggle').textContent, 'Sign in');

  assert.equal(dom.el('auth-password-confirm-row').hidden, false, 'confirm row is shown to register');
  assert.equal(dom.el('auth-password-confirm').required, true, 'and is required');
  assert.equal(dom.el('auth-password').getAttribute('autocomplete'), 'new-password');
  assert.equal(dom.el('auth-forgot-link').hidden, true, 'nothing to recover before an account exists');
  assert.equal(dom.el('auth-terms-notice').hidden, false, 'terms apply when creating an account');
});

test('sign-in mode: confirm-password hidden and cleared, sign-in copy, forgot link shown', () => {
  const modal = mount();
  modal.selectMode(true);
  dom.el('auth-password-confirm').value = 'left-over-secret';

  modal.selectMode(false);

  assert.equal(dom.el('auth-modal-title').textContent, 'Sign in');
  assert.equal(dom.el('auth-submit-label').textContent, 'Sign in');
  assert.equal(dom.el('auth-toggle-label').textContent, 'New here?');
  assert.equal(dom.el('auth-mode-toggle').textContent, 'Create account');

  assert.equal(dom.el('auth-password-confirm-row').hidden, true);
  assert.equal(dom.el('auth-password-confirm').required, false, 'a hidden field must not block submit');
  assert.equal(dom.el('auth-password-confirm').value, '', 'and its value is cleared, not just hidden');
  assert.equal(dom.el('auth-password').getAttribute('autocomplete'), 'current-password');
  assert.equal(dom.el('auth-forgot-link').hidden, false);
  assert.equal(dom.el('auth-terms-notice').hidden, true);
});

test('toggling back and forth lands on the same state each time', () => {
  // The mode toggle is the operation the caching refactor touched, so pin that
  // repeating it is idempotent rather than accumulating state.
  const modal = mount();
  for (let i = 0; i < 3; i += 1) {
    modal.selectMode(true);
    assert.equal(dom.el('auth-password-confirm-row').hidden, false, `register pass ${i}`);
    assert.equal(dom.el('auth-modal-title').textContent, 'Create your free account');
    modal.selectMode(false);
    assert.equal(dom.el('auth-password-confirm-row').hidden, true, `sign-in pass ${i}`);
    assert.equal(dom.el('auth-modal-title').textContent, 'Sign in');
  }
});

test('cached handles rebuild if the modal element is replaced', () => {
  // The element handles are cached, keyed on the modal root. If anything ever
  // swaps the modal out, the cache must follow it — otherwise every later write
  // lands on a detached tree and the visible modal silently stops updating, which
  // is the failure mode a plain module-scope cache would have.
  const modal = mount();
  modal.selectMode(true);
  const staleTitle = dom.el('auth-modal-title');
  assert.equal(staleTitle.textContent, 'Create your free account');

  const fresh = new Map();
  globalThis.document.getElementById = (id) => {
    if (!fresh.has(id)) fresh.set(id, globalThis.document.createElement('div'));
    return fresh.get(id);
  };

  modal.selectMode(false);

  assert.equal(fresh.get('auth-modal-title').textContent, 'Sign in', 'the live tree is updated');
  assert.equal(staleTitle.textContent, 'Create your free account', 'the replaced tree is left alone');
});

test('forgot-password mode swaps the panels and hides the mode toggle', () => {
  const modal = mount();
  modal.selectMode(false);
  modal.bindAuthOnce();

  dom.el('auth-forgot-link').emit('click');

  assert.equal(dom.el('auth-forgot-panel').hidden, false, 'the reset panel is shown');
  assert.equal(dom.el('auth-standard-panel').hidden, true, 'the email/password panel is hidden');
  assert.equal(dom.el('auth-submit-row').hidden, true, 'the main submit is out of the way');
  assert.equal(dom.toggleEl.hidden, true, 'no register/sign-in switch mid-reset');
  assert.equal(dom.el('auth-modal-title').textContent, 'Reset password');
  assert.equal(dom.el('auth-email').readOnly, false, 'the address stays editable while resetting');
});

test('leaving forgot mode restores the standard panel and clears its feedback', () => {
  const modal = mount();
  modal.selectMode(false);
  modal.bindAuthOnce();

  dom.el('auth-forgot-link').emit('click');
  dom.el('auth-forgot-feedback').textContent = 'If that email has an account…';
  dom.el('auth-forgot-feedback').classList.add('auth-forgot-feedback--success');

  dom.el('auth-forgot-back').emit('click');

  assert.equal(dom.el('auth-standard-panel').hidden, false);
  assert.equal(dom.el('auth-forgot-panel').hidden, true);
  assert.equal(dom.el('auth-forgot-feedback').textContent, '', 'stale feedback must not survive');
  assert.equal(dom.el('auth-forgot-feedback').classList.contains('auth-forgot-feedback--success'), false);
  assert.equal(dom.toggleEl.hidden, false, 'the mode switch is back');
});

test('a registration needing verification switches to the code panel and locks the email', async () => {
  const modal = mount({
    fetchImpl: async () => ({ ok: true, json: async () => ({ needsVerification: true, message: 'Check your email.' }) }),
  });
  modal.selectMode(true);
  modal.bindAuthOnce();

  dom.el('auth-email').value = 'new@example.com';
  dom.el('auth-password').value = 'CorrectHorse9!';
  dom.el('auth-password-confirm').value = 'CorrectHorse9!';
  await dom.el('auth-form').emit('submit');

  assert.equal(dom.el('auth-verify-panel').hidden, false, 'the code panel is shown');
  assert.equal(dom.el('auth-standard-panel').hidden, true);
  assert.equal(dom.el('auth-modal-title').textContent, 'Verify your email');
  assert.equal(dom.el('auth-email').readOnly, true, 'the address is locked to the one that was mailed');
  assert.equal(dom.el('auth-verify-feedback').textContent, 'Check your email.');
  assert.match(dom.el('auth-verify-copy').textContent, /new@example\.com/, 'the copy names the address');
  assert.equal(dom.calls.setToken.length, 0, 'no session before the code is entered');
});

test('mismatched passwords are refused before any request is made', async () => {
  // Counts only the auth endpoints: binding also fetches /api/auth/config for the
  // Google panel, which is unrelated to the submit path under test.
  const authPosts = [];
  const modal = mount({
    fetchImpl: async (url) => {
      if (String(url).startsWith('/api/auth/register') || String(url).startsWith('/api/auth/login')) {
        authPosts.push(url);
      }
      return { ok: true, json: async () => ({}) };
    },
  });
  modal.selectMode(true);
  modal.bindAuthOnce();

  dom.el('auth-email').value = 'new@example.com';
  dom.el('auth-password').value = 'CorrectHorse9!';
  dom.el('auth-password-confirm').value = 'CorrectHorse8!';
  await dom.el('auth-form').emit('submit');

  assert.equal(dom.el('auth-error').textContent, 'Passwords do not match.');
  assert.deepEqual(authPosts, [], 'the browser must not POST a password pair the user mistyped');
});

test('a successful sign-in stores the token, refreshes the UI, and closes the modal', async () => {
  const posted = [];
  const modal = mount({
    fetchImpl: async (url, init) => {
      posted.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ token: 'tok_123' }) };
    },
  });
  modal.selectMode(false);
  modal.bindAuthOnce();

  dom.el('auth-email').value = '  User@Example.com  ';
  dom.el('auth-password').value = 'hunter22';
  await dom.el('auth-form').emit('submit');

  assert.deepEqual(posted.map((p) => p.url), ['/api/auth/login']);
  assert.equal(posted[0].body.email, 'User@Example.com', 'the email is trimmed');
  assert.equal(posted[0].body.password, 'hunter22');
  assert.deepEqual(dom.calls.setToken, ['tok_123']);
  assert.equal(dom.calls.fetchMe, 1);
  assert.equal(dom.calls.applyUserToUI, 1);
  assert.equal(dom.calls.refresh, 1, 'the dropdown re-renders with the new plan');
  assert.equal(dom.el('auth-modal').hidden, true, 'the modal closes itself');
  assert.equal(dom.el('auth-modal').getAttribute('aria-hidden'), 'true');
});

test('a rejected sign-in shows the server error and keeps the modal open', async () => {
  const modal = mount({
    fetchImpl: async () => ({ ok: false, json: async () => ({ error: 'Invalid email or password' }) }),
  });
  modal.selectMode(false);
  modal.bindAuthOnce();

  dom.el('auth-email').value = 'user@example.com';
  dom.el('auth-password').value = 'wrong';
  await dom.el('auth-form').emit('submit');

  assert.equal(dom.el('auth-error').textContent, 'Invalid email or password');
  assert.deepEqual(dom.calls.setToken, [], 'no token on a failed attempt');
  assert.equal(dom.el('auth-modal').hidden, false, 'the user stays where they can retry');
});

test('a network failure reports it rather than throwing out of the handler', async () => {
  const modal = mount({ fetchImpl: async () => { throw new Error('offline'); } });
  modal.selectMode(false);
  modal.bindAuthOnce();

  dom.el('auth-email').value = 'user@example.com';
  dom.el('auth-password').value = 'hunter22';
  await dom.el('auth-form').emit('submit');

  assert.equal(dom.el('auth-error').textContent, 'Network error. Please try again.');
});

test('the pending-staging hand-off reveals the stage modal after signing in', async () => {
  // The one cross-module effect of a successful login, and the branch where a
  // stray `stageModal = …` assignment used to rely on `var` hoisting reaching it
  // from an earlier branch — exactly what a naive const/let conversion breaks.
  const modal = mount({
    fetchImpl: async () => ({ ok: true, json: async () => ({ token: 'tok_x' }) }),
  });
  modal.selectMode(false);
  modal.bindAuthOnce();
  globalThis.window.__stagifyPendingStaging = true;

  const stageModal = globalThis.document.createElement('div');
  stageModal.classList.add('hidden');
  const realGet = globalThis.document.getElementById;
  globalThis.document.getElementById = (id) => (id === 'stage-modal' ? stageModal : realGet(id));

  dom.el('auth-email').value = 'user@example.com';
  dom.el('auth-password').value = 'hunter22';
  await dom.el('auth-form').emit('submit');

  assert.equal(stageModal.hidden, false, 'the staging dialog the user came for is revealed');
  assert.equal(globalThis.window.__stagifyPendingStaging, false, 'and the flag is consumed');
});

test('openForStaging opens in register mode and closes the dropdown', () => {
  const modal = mount();
  modal.openForStaging();

  assert.equal(dom.el('auth-modal').hidden, false);
  assert.equal(dom.el('auth-modal').getAttribute('aria-hidden'), 'false');
  assert.equal(dom.el('auth-modal-title').textContent, 'Create your free account');
  assert.equal(globalThis.window.__stagifyPendingStaging, true, 'the staging intent is remembered');
  assert.equal(dom.calls.closeDropdown, 1);
});
