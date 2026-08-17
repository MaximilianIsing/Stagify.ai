// Tier: frontend island logic — the plan cache in public/scripts/auth.js.
//
// `stagifyPlan` exists for the render-blocking scripts that have to choose a page shape
// BEFORE the first paint — scripts/preview-gate.js on all four preview pages, and the copy
// of its body inside ai-designer-gate.js — while the only authority on the plan
// (/api/auth/me) is still a round trip away. Everything worth
// testing here is about the cache staying honest, because a stale one is invisible: the
// page simply paints the wrong shape for a moment and then corrects itself.
//
//   • it must be WRITTEN when the plan is learned, or the fix never engages;
//   • it must be DROPPED on sign-out and on a rejected token, or a signed-out visitor
//     pre-paints a studio they cannot use;
//   • it must survive storage throwing, because it is an optimization and losing it costs
//     a flash — never a sign-in.
//
// It is never an authorization. requireProAccount on POST /api/enhance-exterior answers
// 403 whatever this key says, and no code may branch on it except to choose a paint.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

/** @type {Record<string, string>} */
let store = {};
let storageThrows = false;
/** @type {{ ok: boolean, body: any }} */
let meResponse = { ok: true, body: { user: { id: 'u1', plan: 'pro' } } };

before(async () => {
  store = {};
  globalThis.localStorage = /** @type {any} */ ({
    getItem: (k) => {
      if (storageThrows) throw new Error('storage unavailable');
      return k in store ? store[k] : null;
    },
    setItem: (k, v) => {
      if (storageThrows) throw new Error('storage unavailable');
      store[k] = String(v);
    },
    removeItem: (k) => {
      if (storageThrows) throw new Error('storage unavailable');
      delete store[k];
    },
  });
  globalThis.window = /** @type {any} */ ({});
  globalThis.document = /** @type {any} */ ({
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  });
  globalThis.fetch = /** @type {any} */ ((url) => {
    // The module fires /api/auth/config on evaluation for the staging banner; answering
    // "not staging" keeps it from touching the DOM.
    if (String(url).includes('/api/auth/config')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({
      ok: meResponse.ok,
      json: () => Promise.resolve(meResponse.body),
    });
  });

  await import('../../public/scripts/auth.js');
});

/** @returns {any} */
const auth = () => globalThis.window.StagifyAuth;

// ---- writing ---------------------------------------------------------------

test('fetchMe caches the plan the server reported', async () => {
  store.stagifyAuthToken = 'tok';
  meResponse = { ok: true, body: { user: { id: 'u1', plan: 'pro' } } };

  await auth().fetchMe();
  assert.equal(store.stagifyPlan, 'pro');

  meResponse = { ok: true, body: { user: { id: 'u1', plan: 'free' } } };
  await auth().fetchMe();
  assert.equal(store.stagifyPlan, 'free', 'a downgrade has to land too, or the tool pre-paints forever');
});

test('applyUserToUI re-mirrors the plan, so a direct assignment cannot leave it stale', () => {
  // exterior-studio-app.js and app/staging-pipeline.js both set `StagifyAuth.user` from a
  // render response and call straight through to applyUserToUI. Nothing forces them
  // through setUser, so this is what keeps them honest.
  store.stagifyAuthToken = 'tok';
  store.stagifyPlan = 'free';
  auth().user = { id: 'u1', plan: 'pro' };
  auth().applyUserToUI();
  assert.equal(store.stagifyPlan, 'pro');
});

// ---- dropping --------------------------------------------------------------

test('clear() takes the cached plan with the token', () => {
  store.stagifyAuthToken = 'tok';
  store.stagifyPlan = 'pro';
  auth().clear();
  assert.equal(store.stagifyAuthToken, undefined);
  assert.equal(store.stagifyPlan, undefined, 'a plan outliving sign-out pre-paints the studio for a stranger');
  assert.equal(auth().user, null);
});

test('a rejected token clears the cache — the expiry path, not just the sign-out button', async () => {
  store.stagifyAuthToken = 'tok';
  store.stagifyPlan = 'pro';
  meResponse = { ok: false, body: {} };

  assert.equal(await auth().fetchMe(), null);
  assert.equal(store.stagifyPlan, undefined);
  assert.equal(store.stagifyAuthToken, undefined);
});

test('signing out through setUser(null) drops it as well', () => {
  store.stagifyPlan = 'pro';
  auth().setUser(null);
  assert.equal(store.stagifyPlan, undefined);
  assert.equal(auth().user, null);
});

test('a user with no plan field caches nothing rather than caching "undefined"', () => {
  store.stagifyPlan = 'pro';
  auth().setUser({ id: 'u1' });
  assert.equal(store.stagifyPlan, undefined, 'the gate only ever arms on a literal "pro"');
});

// ---- storage that will not cooperate ---------------------------------------

test('unusable storage costs the cache, never the sign-in', () => {
  // Safari private mode, a blocked third-party context. The page simply falls back to the
  // shape it ships with.
  storageThrows = true;
  try {
    assert.doesNotThrow(() => auth().setUser({ id: 'u1', plan: 'pro' }));
    assert.deepEqual(auth().user, { id: 'u1', plan: 'pro' }, 'the live plan is still set');
  } finally {
    storageThrows = false;
  }
});
