// Tier: frontend island logic (DOM-stubbed) — public/scripts/app/staging-entry.js.
//
// How the top nav's Staging dropdown reaches the two screens that live only on
// the home page. Two halves, and each has a failure mode worth pinning:
//
//   - the WINDOW HOOKS are what the dropdown uses when the visitor is already on
//     the home page. They must not exist anywhere else, because their absence is
//     exactly how staging-menu.js decides to navigate instead;
//   - the FRAGMENT is the arrival path. It has to be stripped once consumed (or
//     every refresh reopens a screen the visitor just closed) and, for Basic
//     Mask, re-checked against the plan — the row is locked in the menu, but the
//     URL is typeable and survives a middle-click, so the menu is not a gate.
//
// The plan re-check has a race the naive version gets wrong: at DOMContentLoaded
// /api/auth/me has not answered yet, so "not Pro yet" must not be read as "not
// Pro" and bounce a paying customer off their own home page.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { hashAction, initStagingEntry } = await import('../../../public/scripts/app/staging-entry.js');

// ---- The pure mapping ------------------------------------------------------

test('hashAction maps the two fragments the dropdown links to', () => {
  assert.equal(hashAction('#stage'), 'stage');
  assert.equal(hashAction('#basic-mask'), 'basic-mask');
});

test('hashAction ignores every other fragment', () => {
  // #ai-designer-demo is a real fragment on this page, handled by index-inline.js.
  for (const h of ['', '#', '#ai-designer-demo', '#stagey', 'stage', '#stage-modal', undefined, null]) {
    assert.equal(hashAction(/** @type {any} */ (h)), null, JSON.stringify(h));
  }
});

test('hashAction is case-insensitive, since a fragment survives being retyped', () => {
  assert.equal(hashAction('#Stage'), 'stage');
  assert.equal(hashAction('#Basic-Mask'), 'basic-mask');
});

// ---- The initialiser -------------------------------------------------------

/** @param {{ hash?: string, plan?: string, token?: string|null, meFails?: boolean }} opts */
function mount({ hash = '', plan, token = null, meFails = false } = {}) {
  const calls = { staging: 0, basicMask: 0, replaced: [], pushed: [], fetchMe: 0 };
  const location = {
    pathname: '/',
    search: '',
    hash,
    replace: (url) => calls.replaced.push(url),
  };
  globalThis.location = /** @type {any} */ (location);
  globalThis.history = /** @type {any} */ ({
    replaceState: (_s, _t, url) => { calls.pushed.push(url); location.hash = ''; },
  });
  /** @type {Record<string, Function[]>} */
  const listeners = {};
  globalThis.window = /** @type {any} */ ({
    location,
    addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
    StagifyAuth: {
      user: null,
      getToken: () => token,
      fetchMe() {
        calls.fetchMe += 1;
        if (meFails) return Promise.reject(new Error('offline'));
        this.user = plan ? { plan } : null;
        return Promise.resolve(this.user);
      },
    },
  });

  const deps = {
    openStaging: () => { calls.staging += 1; },
    openBasicMask: () => { calls.basicMask += 1; },
    // Reads live state, exactly as app.js's isProUser does.
    isPro: () => globalThis.window.StagifyAuth.user?.plan === 'pro',
  };
  return { calls, deps, listeners, location };
}

/** The initialiser's fragment handling is async (it may await /api/auth/me). */
const settle = () => new Promise((r) => setTimeout(r, 0));

test('initStagingEntry publishes both hooks', () => {
  // Their PRESENCE is the signal staging-menu.js uses to open in place instead
  // of navigating, so this is load-bearing, not bookkeeping.
  const { deps } = mount();
  initStagingEntry(deps);
  assert.equal(typeof globalThis.window.__stagifyOpenStaging, 'function');
  assert.equal(typeof globalThis.window.__stagifyOpenBasicMask, 'function');
  globalThis.window.__stagifyOpenStaging();
  globalThis.window.__stagifyOpenBasicMask();
});

test('initStagingEntry opens nothing without a fragment', async () => {
  const { calls, deps } = mount({ hash: '' });
  initStagingEntry(deps);
  await settle();
  assert.equal(calls.staging, 0);
  assert.equal(calls.basicMask, 0);
  assert.deepEqual(calls.pushed, [], 'an untouched URL must not be rewritten');
});

test('#stage opens the staging screen for anyone', async () => {
  // No plan check: openStaging is app.js's openFilePicker, which carries the
  // anonymous sign-in prompt itself.
  const { calls, deps } = mount({ hash: '#stage' });
  initStagingEntry(deps);
  await settle();
  assert.equal(calls.staging, 1);
  assert.equal(calls.fetchMe, 0, 'the staging screen does not need the plan first');
});

test('the fragment is stripped once consumed', async () => {
  // Otherwise a refresh — or Back — reopens the screen they just closed.
  const { calls, deps } = mount({ hash: '#stage' });
  initStagingEntry(deps);
  await settle();
  assert.deepEqual(calls.pushed, ['/']);
});

test('#basic-mask opens the editor for a Pro user, after the plan resolves', async () => {
  const { calls, deps } = mount({ hash: '#basic-mask', plan: 'pro', token: 't' });
  initStagingEntry(deps);
  await settle();
  assert.equal(calls.fetchMe, 1, 'the plan is unknown at load — it must be awaited');
  assert.equal(calls.basicMask, 1);
  assert.deepEqual(calls.replaced, []);
});

test('#basic-mask sends a signed-in free user to Stagify+', async () => {
  const { calls, deps } = mount({ hash: '#basic-mask', plan: 'free', token: 't' });
  initStagingEntry(deps);
  await settle();
  assert.equal(calls.basicMask, 0, 'Basic Mask is Stagify+ only');
  assert.deepEqual(calls.replaced, ['stagify-plus.html']);
});

test('#basic-mask sends an anonymous visitor to Stagify+ without calling /me', async () => {
  const { calls, deps } = mount({ hash: '#basic-mask', token: null });
  initStagingEntry(deps);
  await settle();
  assert.equal(calls.fetchMe, 0, 'no token, nothing to ask about');
  assert.equal(calls.basicMask, 0);
  assert.deepEqual(calls.replaced, ['stagify-plus.html']);
});

test('#basic-mask fails closed when /api/auth/me errors', async () => {
  const { calls, deps } = mount({ hash: '#basic-mask', plan: 'pro', token: 't', meFails: true });
  initStagingEntry(deps);
  await settle();
  assert.equal(calls.basicMask, 0, 'an unverifiable plan is not a Pro plan');
  assert.deepEqual(calls.replaced, ['stagify-plus.html']);
});

test('#basic-mask keeps a non-English visitor in their language', async () => {
  // A bare 'stagify-plus.html' under <base href="/"> would drop them to the
  // English page; localizedTarget re-prefixes it.
  const { calls, deps, location } = mount({ hash: '#basic-mask', plan: 'free', token: 't' });
  location.pathname = '/de';
  initStagingEntry(deps);
  await settle();
  assert.deepEqual(calls.replaced, ['/de/stagify-plus.html']);
});

test('a later hashchange is honoured too', async () => {
  // The dropdown is on this page as well, and clicking a row while already here
  // can land as a hashchange rather than a load.
  const { calls, deps, listeners, location } = mount({ hash: '' });
  initStagingEntry(deps);
  await settle();
  location.hash = '#stage';
  listeners.hashchange.forEach((fn) => fn());
  await settle();
  assert.equal(calls.staging, 1);
});
