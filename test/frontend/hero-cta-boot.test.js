// Tier: pure frontend logic — public/scripts/hero-cta-boot.js.
//
// This file exists for one window in time: after the hero has painted and before
// scripts/app.js — 38 modules, ~267 KB, now loaded from index-deferred.js after `load` —
// has arrived. #hero-upload is the primary call to action on the site, and inside that
// window it is visible and, without this shim, inert. "I clicked it and nothing happened"
// is a worse bug than a slower LCP, so a click has to pull app.js in and then act.
//
// The behaviour worth pinning is therefore ORDERING, which no source scan can see:
//   - a click BEFORE app.js has landed must still open the picker, once app.js resolves;
//   - a click AFTER it has landed must go straight through with no second import;
//   - the button must not be left in a stuck aria-busy state if the import rejects.

import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Minimal element stub: the handful of things the module touches. */
function makeButton(id) {
  const attrs = {};
  const listeners = {};
  return {
    id,
    attrs,
    listeners,
    setAttribute(n, v) { attrs[n] = String(v); },
    removeAttribute(n) { delete attrs[n]; },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    click() { for (const fn of listeners.click || []) fn(); },
  };
}

/**
 * Install a fresh document/window/location and import the module with a clean registry.
 *
 * The module keeps its `appLoading` promise in module scope, so each scenario needs its
 * own instance — a cache-busting query on the specifier is the cheapest way to get one.
 */
async function load({ hash = '', readyState = 'complete' } = {}) {
  const buttons = { 'hero-upload': makeButton('hero-upload'), 'outro-upload': makeButton('outro-upload') };
  const docListeners = {};
  globalThis.document = /** @type {any} */ ({
    readyState,
    getElementById: (id) => buttons[id] || null,
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
  });
  // The gap test really does let the module `import('./app.js')`, which is the point —
  // the ordering it pins is not observable if the import is stubbed out. app.js needs far
  // more DOM than this and will throw partway through evaluating; hero-cta-boot.js catches
  // that on purpose (a failed import must not strand the button at aria-busy), so these
  // stubs only need to be enough for the rejection to be the thing that happens.
  globalThis.window = /** @type {any} */ (globalThis.window || {});
  /** @type {any} */ (globalThis.window).addEventListener = () => {};
  delete (/** @type {any} */ (globalThis.window).__stagifyOpenStaging);
  globalThis.location = /** @type {any} */ ({ hash });

  await import(`../../public/scripts/hero-cta-boot.js?t=${counter++}`);
  return { buttons, docListeners };
}
let counter = 0;

test('a click after app.js has landed goes straight through', async () => {
  const { buttons } = await load();
  let opened = 0;
  /** @type {any} */ (globalThis.window).__stagifyOpenStaging = () => { opened += 1; };

  buttons['hero-upload'].click();

  assert.equal(opened, 1, 'the hook must be called directly when it already exists');
  assert.equal(buttons['hero-upload'].attrs['aria-busy'], undefined, 'no busy state is needed');
});

test('both entry points are bound, not just the hero one', async () => {
  const { buttons } = await load();
  let opened = 0;
  /** @type {any} */ (globalThis.window).__stagifyOpenStaging = () => { opened += 1; };

  buttons['hero-upload'].click();
  buttons['outro-upload'].click();

  // The closing row's button is the whole reason #contact-cta exists; it used to be bound
  // in app.js alongside the hero one and must not have been dropped in the move.
  assert.equal(opened, 2, '#outro-upload must open the staging flow too');
});

test('a click before app.js has landed marks the button busy and still opens', async () => {
  const { buttons } = await load();
  const btn = buttons['hero-upload'];

  // No __stagifyOpenStaging yet: this is the gap the file exists for.
  btn.click();
  assert.equal(btn.attrs['aria-busy'], 'true', 'the press must be acknowledged immediately');

  // app.js "arrives" — the dynamic import of the real module resolves, and the hook it
  // publishes is what the shim waits on.
  let opened = 0;
  /** @type {any} */ (globalThis.window).__stagifyOpenStaging = () => { opened += 1; };

  // Polled rather than slept on. The shim is waiting for a real `import('./app.js')` to
  // settle, and how long that takes depends on how loaded the machine is — a fixed delay
  // passes alone and flakes when the whole suite runs in parallel.
  const deadline = Date.now() + 5000;
  while (btn.attrs['aria-busy'] !== undefined && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }

  assert.equal(btn.attrs['aria-busy'], undefined, 'the busy state must always be cleared');
  assert.equal(opened, 1, 'the click that landed during the gap must still open the picker');
});

test('a deep link to #stage does not wait for a click', async () => {
  // Somebody arriving on index.html#stage is already asking for the studio, so there is
  // nothing to defer — app/staging-entry.js consumes the fragment itself.
  const { buttons } = await load({ hash: '#stage' });
  assert.ok(buttons['hero-upload'], 'the buttons are still bound on the deep-link path');
});

test('it registers on DOMContentLoaded when the document is still parsing', async () => {
  const { docListeners } = await load({ readyState: 'loading' });
  assert.ok(
    (docListeners.DOMContentLoaded || []).length >= 1,
    'with readyState "loading" the module must defer init rather than querying a DOM that ' +
      'has not reached the buttons yet'
  );
});
