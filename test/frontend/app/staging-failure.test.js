// scripts/app/staging-failure.js — what the main tool shows when staging throws.
//
// This pins a bug that shipped for as long as the pro version existed: the catch in
// stageImage() handled AUTH_REQUIRED only when isMobileStagingViewport() was true, so a
// DESKTOP user whose session expired mid-stage watched the progress bar vanish and got
// nothing — no message, no sign-in prompt. Three other paths were silent on every
// viewport, because staging-pipeline.js throws them bare and nothing surfaced them:
// FILE_TOO_LARGE, "no image data received", and a dropped connection.
//
// The two directions matter equally, so both are asserted here: an unmarked error MUST
// produce a message, and an error the pipeline already painted MUST NOT get a second
// one stacked on top.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createStagingFailure } from '../../../public/scripts/app/staging-failure.js';

/** Build the handler with recording collaborators. */
function harness({ menu = undefined, openAuthForStaging = undefined, text = {} } = {}) {
  const calls = { errors: [], registerMode: [], openedModal: [], openedForStaging: 0 };
  const { handleStagingFailure } = createStagingFailure({
    showStagingError: (m) => calls.errors.push(m),
    getProfileMenu: () => (menu === undefined ? null : menu),
    openAuthForStaging: openAuthForStaging
      ? () => {
          calls.openedForStaging += 1;
          openAuthForStaging();
        }
      : undefined,
    getText: (k) => text[k],
  });
  return { handleStagingFailure, calls };
}

/** The profile menu the page normally provides, recording what it was asked to do. */
function fakeMenu(calls) {
  return {
    setAuthModeRegister: (v) => calls.registerMode.push(v),
    openAuthModal: (forStaging) => calls.openedModal.push(forStaging),
  };
}

const authError = () => Object.assign(new Error('Please sign in to stage images.'), { code: 'AUTH_REQUIRED' });

test('an expired session opens the sign-in prompt — on desktop, not just mobile', () => {
  const calls = { errors: [], registerMode: [], openedModal: [], openedForStaging: 0 };
  const { handleStagingFailure } = createStagingFailure({
    showStagingError: (m) => calls.errors.push(m),
    getProfileMenu: () => fakeMenu(calls),
    getText: () => undefined,
  });

  // No viewport is consulted at all now — there is no matchMedia in this environment,
  // and the handler must still open the prompt. That absence IS the regression test:
  // the old code called window.matchMedia and took the silent branch without it.
  const outcome = handleStagingFailure(authError());

  assert.equal(outcome, 'auth');
  assert.deepEqual(calls.openedModal, [true], 'the modal opens in staging mode');
  assert.deepEqual(calls.registerMode, [true], 'and lands on Create account');
  assert.deepEqual(calls.errors, [], 'the prompt replaces the message, it does not stack with it');
});

test('with no profile menu it falls back to the staging auth hook', () => {
  let opened = 0;
  const { handleStagingFailure, calls } = harness({ menu: null, openAuthForStaging: () => { opened += 1; } });

  assert.equal(handleStagingFailure(authError()), 'auth');
  assert.equal(opened, 1);
  assert.deepEqual(calls.errors, [], 'the hook handled it, so no message');
});

test('with no auth UI at all it still says why staging failed', () => {
  // A page can embed the staging dialog without the profile menu. Silence was the old
  // behaviour on EVERY page; here the message is the last resort, not the default.
  const { handleStagingFailure, calls } = harness({ menu: null });

  assert.equal(handleStagingFailure(authError()), 'message');
  assert.deepEqual(calls.errors, ['Please sign in to stage images.']);
});

test('a failure the pipeline already painted does not get a second message', () => {
  // DAILY_LIMIT and NO_IMAGE_GENERATED put their own copy on screen and then throw
  // only to unwind. Stacking a generic message on top is the failure mode in the
  // other direction, and is why this is a mark rather than a list of codes.
  const { handleStagingFailure, calls } = harness();
  const painted = Object.assign(new Error('You have used your 3 free rooms today.'), {
    code: 'DAILY_LIMIT',
    stagingMessageShown: true,
  });

  assert.equal(handleStagingFailure(painted), 'message');
  assert.deepEqual(calls.errors, [], 'the pipeline already said it');
});

test('the paths that throw bare are surfaced, not swallowed', () => {
  // Each of these reaches the catch with nothing on screen. Before the fix all three
  // ended in silence regardless of viewport.
  for (const [code, message] of [
    ['FILE_TOO_LARGE', 'File is too large. Please upload an image smaller than 100MB.'],
    [undefined, 'No image data received'],
    [undefined, 'Failed to fetch'],
  ]) {
    const { handleStagingFailure, calls } = harness();
    handleStagingFailure(Object.assign(new Error(message), code ? { code } : {}));
    assert.deepEqual(calls.errors, [message], `${code || 'bare error'} must reach the user`);
  }
});

test('an error with nothing to say still produces localized copy', () => {
  const { handleStagingFailure, calls } = harness({ text: { 'errors.processingFailed': 'No se pudo procesar' } });

  handleStagingFailure(new Error(''));
  assert.deepEqual(calls.errors, ['No se pudo procesar'], 'the pack wins over the English default');
});

test('a thrown non-Error, or nothing at all, is still reported', () => {
  // `throw e` re-throws whatever fetch rejected with; it is not guaranteed to be an
  // Error, and a null must not take the handler down with it.
  const { handleStagingFailure, calls } = harness();

  handleStagingFailure(null);
  handleStagingFailure(undefined);

  assert.deepEqual(calls.errors, ['Processing failed', 'Processing failed']);
});
