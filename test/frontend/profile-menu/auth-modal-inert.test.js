// The auth modal takes the page behind it out of the tab order and the a11y tree.
//
// WHY: `aria-modal="true"` on the dialog claims modality and enforces none of it. On
// the live homepage, with the modal open, 8 controls are focusable inside it and 60
// are still tabbable behind it — and unlike the gallery panel this dialog has no Tab
// trap, so Tab simply left the dialog and walked the nav under a backdrop the user
// cannot see through. Mouse users never hit it: the full-viewport backdrop already
// swallows their clicks, which is why it went unnoticed for so long.
//
// The mechanism is shared with the gallery panel (public/scripts/inert-background.js).
// What is asserted here is the part that is specific to THIS dialog and genuinely
// dangerous to get wrong: that the page is handed back on every single close path, and
// that it is handed back BEFORE the staging hand-off reveals a dialog nested inside
// <main>. A page left inert is unusable until a reload and very hard to diagnose from
// the symptom — nothing is thrown, nothing is logged, the page simply stops responding.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installAuthModalDom } from '../../helpers/auth-modal-dom.js';
import { createAuthModal } from '../../../public/scripts/profile-menu/auth-modal.js';

let dom = null;
afterEach(() => { if (dom) { dom.restore(); dom = null; } });

/** Mount the modal with the shim installed and its listeners bound. */
function mount(opts = {}) {
  dom = installAuthModalDom(opts);
  const modal = createAuthModal({
    onRefresh: () => { dom.calls.refresh += 1; },
    onCloseDropdown: () => { dom.calls.closeDropdown += 1; },
  });
  modal.bindAuthOnce();
  return modal;
}

/** The inert attribute on each background landmark, as the browser would see it. */
function backgroundInert() {
  return {
    header: dom.background.header.getAttribute('inert'),
    main: dom.background.main.getAttribute('inert'),
    footer: dom.background.footer.getAttribute('inert'),
  };
}

const ALL_INERT = { header: '', main: '', footer: '' };
const NONE_INERT = { header: null, main: null, footer: null };

test('opening the modal makes every background sibling inert, and never the modal itself', () => {
  const modal = mount();
  assert.deepEqual(backgroundInert(), NONE_INERT, 'nothing is inert before it opens');

  modal.openAuthModal(false);

  assert.deepEqual(backgroundInert(), ALL_INERT, 'the page behind the dialog is out of the tree');
  // The exemption is the whole reason this cannot be "inert the body": a dialog that
  // inerts itself is invisible to a reader and impossible to type into, which is a
  // far worse bug than the one being fixed.
  assert.equal(
    dom.el('auth-modal').getAttribute('inert'),
    null,
    'the dialog stayed interactive',
  );
});

test('inert is written as a boolean attribute, not the string "true"', () => {
  // `inert="true"` and `inert=""` both LOOK set to a getAttribute assertion that only
  // checks truthiness, and both are inert in a browser — but `inert="false"` is also
  // inert, so writing a stringified boolean here is how the next person talks
  // themselves into `setAttribute('inert', String(on))`, which never un-inerts.
  const modal = mount();
  modal.openAuthModal(false);
  assert.equal(dom.background.main.getAttribute('inert'), '', 'the empty string, exactly');
});

test('every way out of the modal hands the page back', async () => {
  // The close funnel has five entrances. A release that sits behind any one of them
  // being missed leaves the page dead, so each is driven end to end rather than
  // trusting that they all reach closeAuthModal().
  const paths = {
    'the close button': async (modal) => {
      modal.openAuthModal(false);
      await dom.el('auth-modal-close').emit('click');
    },
    'the backdrop': async (modal) => {
      modal.openAuthModal(false);
      await dom.el('auth-modal-backdrop').emit('click');
    },
    'the Escape key': async (modal) => {
      modal.openAuthModal(false);
      await dom.emitDocument('keydown', { key: 'Escape' });
    },
  };

  for (const [name, drive] of Object.entries(paths)) {
    const modal = mount();
    await drive(modal);
    assert.deepEqual(backgroundInert(), NONE_INERT, `inert outlived the modal — closed via ${name}`);
    dom.restore();
    dom = null;
  }
});

test('a successful sign-in hands the page back too', async () => {
  const modal = mount({ fetchImpl: async () => ({ ok: true, json: async () => ({ token: 'tok_x' }) }) });
  modal.selectMode(false);
  modal.openAuthModal(false);
  assert.deepEqual(backgroundInert(), ALL_INERT, 'inert while the form is up');

  dom.el('auth-email').value = 'user@example.com';
  dom.el('auth-password').value = 'hunter22';
  await dom.el('auth-form').emit('submit');

  assert.deepEqual(backgroundInert(), NONE_INERT, 'signing in is a close path like any other');
});

test('the staging hand-off reveals #stage-modal only AFTER the page is handed back', async () => {
  // The regression this whole test file exists for. #stage-modal lives INSIDE <main>
  // on index.html, and inert is inherited — so a stage dialog revealed while <main> is
  // still inert appears on screen and is completely dead: no focus, no typing, no
  // clicks, nothing announced. The user signs in from "Stage this photo" and lands on
  // a frozen dialog.
  //
  // Asserting the ORDER, not just the end state: both are correct at the end of the
  // turn either way, so an end-state assertion passes even if the reveal happens first.
  const modal = mount({ fetchImpl: async () => ({ ok: true, json: async () => ({ token: 'tok_x' }) }) });
  modal.selectMode(false);

  const stageModal = globalThis.document.createElement('div');
  stageModal.classList.add('hidden');
  /** <main>'s inert state at the exact moment the stage dialog was un-hidden. */
  let inertWhenRevealed = 'never revealed';
  const realRemove = stageModal.classList.remove.bind(stageModal.classList);
  stageModal.classList.remove = (...names) => {
    if (names.includes('hidden')) inertWhenRevealed = dom.background.main.getAttribute('inert');
    return realRemove(...names);
  };
  const realGet = globalThis.document.getElementById;
  globalThis.document.getElementById = (id) => (id === 'stage-modal' ? stageModal : realGet(id));

  // Sign-in mode with the pending flag set by hand, not openForStaging(): that helper
  // switches the form to REGISTER, whose submit routes to the email-verification step
  // instead of completeSignIn(), so the hand-off under test would never run. Same
  // approach the existing hand-off spec in auth-modal.test.js takes.
  modal.openAuthModal(false);
  globalThis.window.__stagifyPendingStaging = true;
  assert.deepEqual(backgroundInert(), ALL_INERT, 'inert while the sign-in form is up');

  dom.el('auth-email').value = 'user@example.com';
  dom.el('auth-password').value = 'hunter22';
  await dom.el('auth-form').emit('submit');

  assert.equal(stageModal.hidden, false, 'the staging dialog the user came for is revealed');
  assert.equal(
    inertWhenRevealed,
    null,
    'the stage dialog was revealed while <main> was STILL inert — it would appear on ' +
      'screen and be completely dead. Un-inert must happen before the reveal.',
  );
});
