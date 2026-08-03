// A failure is not an empty account.
//
// WHAT THIS COVERS
// gallery-app.js used to funnel every non-401 response into the `empty` state, so a 500,
// a dropped connection and a brand-new account all rendered the same sentence: "Nothing
// staged yet. Your rooms will appear here after you stage one." Told to someone who is
// on the page precisely because they are looking for work they know they did, that is
// not a degraded message — it is the wrong one, and the alarming direction of wrong.
//
// The pair that matters is here: an error must NOT be empty, and empty must NOT become
// an error now that the branch exists. A single-sided test would pass on a version that
// simply renamed the catch-all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../../../public/scripts/gallery-app.js';
import { galleryDocument, fakeRoutes, cards } from '../../helpers/gallery-dom.js';

const ENTRY = {
  id: 'r1',
  createdAt: Date.UTC(2026, 7, 1),
  roomType: 'Bedroom',
  urls: { after: '/a.webp', before: '/b.webp', thumb: '/t.webp' },
  share: { active: false },
};

/** A fetch that fails with `status` until `failures` calls have been made, then serves. */
function flaky({ status, failures, body }) {
  let seen = 0;
  return async () => {
    seen += 1;
    if (seen <= failures) return { ok: false, status, json: async () => null };
    return { ok: true, status: 200, json: async () => body };
  };
}

test('a 500 lands on the error state, not on "nothing staged yet"', async () => {
  const { document, body } = galleryDocument();
  const state = await start({
    doc: document,
    fetchImpl: fakeRoutes({ '/api/gallery': { status: 500, body: null } }),
  });

  assert.equal(state, 'error');
  assert.equal(body.getAttribute('data-state'), 'error');
});

test('a dropped connection says so, rather than blaming the account', async () => {
  // api.js turns a thrown fetch into status 0 so callers can branch instead of catching.
  const { document, byId } = galleryDocument();
  const state = await start({ doc: document, fetchImpl: async () => { throw new Error('offline'); } });

  assert.equal(state, 'error');
  assert.match(byId('gal-error-detail').textContent, /could not reach/i);
});

test('a rate limit gets its own copy — waiting is the fix, retrying harder is not', async () => {
  const { document, byId } = galleryDocument();
  await start({ doc: document, fetchImpl: fakeRoutes({ '/api/gallery': { status: 429, body: null } }) });

  assert.match(byId('gal-error-detail').textContent, /too many requests/i);
});

test('a server error reassures that the renders themselves are fine', async () => {
  const { document, byId } = galleryDocument();
  await start({ doc: document, fetchImpl: fakeRoutes({ '/api/gallery': { status: 503, body: null } }) });

  assert.match(byId('gal-error-detail').textContent, /renders are safe/i);
});

test('an account with no renders is STILL empty, not an error', async () => {
  // The other half of the pair. Without this, widening the failure branch to "anything
  // that is not a populated 200" would pass every assertion above while breaking the
  // one state this page had right to begin with.
  const { document, body } = galleryDocument();
  const state = await start({
    doc: document,
    fetchImpl: fakeRoutes({ '/api/gallery': { status: 200, body: { entries: [], total: 0, enabled: true } } }),
  });

  assert.equal(state, 'empty');
  assert.equal(body.getAttribute('data-state'), 'empty');
});

test('a switched-off deployment is still its own state, ahead of the error branch', async () => {
  // `enabled: false` arrives on a 200, so it must be checked after the failure branch
  // and before the empty one. Getting that order wrong is silent: the fixture is a
  // successful response carrying zero entries, which every other branch also matches.
  const { document } = galleryDocument();
  const state = await start({
    doc: document,
    fetchImpl: fakeRoutes({ '/api/gallery': { status: 200, body: { entries: [], total: 0, enabled: false } } }),
  });

  assert.equal(state, 'off');
});

test('a 401 still says signed out — the failure branch must not swallow it', async () => {
  const { document } = galleryDocument();
  const state = await start({
    doc: document,
    fetchImpl: fakeRoutes({ '/api/gallery': { status: 401, body: { code: 'AUTH_REQUIRED' } } }),
  });

  assert.equal(state, 'signed-out');
});

test('retrying after a transient failure recovers to the grid', async () => {
  // The button exists because most of these failures are transient. If it could not
  // actually recover the page, it would be decoration on a dead end.
  const { document, body, byId } = galleryDocument();
  const fetchImpl = flaky({
    status: 500,
    failures: 1,
    body: { entries: [ENTRY], total: 1, enabled: true },
  });

  assert.equal(await start({ doc: document, fetchImpl }), 'error');

  const recovered = await byId('gal-retry').fire('click');
  assert.equal(recovered, 'ready');
  assert.equal(body.getAttribute('data-state'), 'ready');
  assert.equal(cards(byId).length, 1);
});

// ---- announcing to assistive tech -------------------------------------------------------

test('the error text is written AFTER the section is shown', async () => {
  // #gal-error-detail is an aria-live region, and a live region whose content changes
  // while it is still display:none does not announce. paintError ran first, so the one
  // line describing the failure was silent by construction. The state attribute is what
  // reveals the section, so it has to be set first.
  const { document, byId } = galleryDocument();
  /** @type {string[]} */
  const order = [];
  const detail = byId('gal-error-detail');
  // A body whose data-state write is recorded, and a detail node whose text write is too.
  const realSet = document.body.setAttribute.bind(document.body);
  document.body.setAttribute = (name, value) => {
    if (name === 'data-state' && value === 'error') order.push('state');
    return realSet(name, value);
  };
  Object.defineProperty(detail, 'textContent', {
    configurable: true,
    get() { return this._text; },
    set(v) { if (v) order.push('text'); this._text = String(v); },
  });

  await start({ doc: document, fetchImpl: fakeRoutes({ '/api/gallery': { status: 500, body: null } }) });

  assert.deepEqual(order, ['state', 'text'], 'the live region was written while it was hidden');
});

test('the loading state says so out loud', async () => {
  // The spinner is decoration and stays aria-hidden; between page load and the first
  // #gal-count announcement a screen reader used to get nothing at all.
  const { document, byId } = galleryDocument();
  await start({ doc: document, fetchImpl: fakeRoutes({ '/api/gallery': { status: 200, body: { entries: [ENTRY], total: 1, enabled: true } } }) });
  assert.match(byId('gal-loading-label').textContent, /Loading your gallery/);
});

test('the retry button cannot be double-pressed into two listings', async () => {
  // Against a limiter that allows 120 requests per 15 minutes, and it is also the only
  // feedback a retry gives when it fails twice with identical wording — an aria-live
  // region cannot announce text it already holds.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const fetchImpl = Object.assign(async () => {
    calls.push(1);
    if (calls.length > 1) await gate;
    return { ok: false, status: 500, json: async () => null };
  }, { calls });

  const { document, byId } = galleryDocument();
  await start({ doc: document, fetchImpl });
  assert.equal(calls.length, 1);

  const first = byId('gal-retry').fire('click');
  const second = byId('gal-retry').fire('click');
  release();
  await Promise.all([first, second]);

  assert.equal(calls.length, 2, 'the second press must not stack another listing');
  assert.equal(byId('gal-retry').disabled, false, 're-enabled once the retry settled');
});
