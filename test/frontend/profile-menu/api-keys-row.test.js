// Tier: unit (pure functions + a fake fetch, no DOM) —
// public/scripts/profile-menu/api-keys-row.js.
//
// WHAT THIS COVERS
// The rule that keeps the API row out of the account menu of everybody who does not use
// the API, and the one-shot fetch behind it. The row is a convenience, so every failure
// mode here must degrade to "no row" rather than to a broken menu:
//   - unfetched (null) reads as NO, so the row never flashes in and out,
//   - any of a live key, a balance, or a past purchase is enough to show it,
//   - the summary is fetched at most once per page, even under repeated menu opens,
//   - a signed-out visitor never fetches at all, and
//   - a rejected fetch or a non-2xx is swallowed and not retried.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiRowVisible,
  apiKeysRowHtml,
  stagifyApiRowHtml,
  createApiSummary,
} from '../../../public/scripts/profile-menu/api-keys-row.js';

test('an account with no API presence gets no row', () => {
  assert.equal(apiRowVisible(null), false, 'unfetched must read as no');
  assert.equal(apiRowVisible({}), false);
  assert.equal(apiRowVisible({ keyCount: 0, balance: 0, lifetimePurchased: 0 }), false);
});

test('any sign of real use shows the row', () => {
  assert.equal(apiRowVisible({ keyCount: 1 }), true, 'a live key');
  assert.equal(apiRowVisible({ balance: 25 }), true, 'credits in hand');
  // Spent down to zero but has bought before — still their surface, and the row is how
  // they get back to it to top up.
  assert.equal(apiRowVisible({ keyCount: 0, balance: 0, lifetimePurchased: 500 }), true);
});

test('the row points at the dashboard and escapes its label', () => {
  const html = apiKeysRowHtml((k, fallback) => fallback, (s) => String(s).replace(/&/g, '&amp;'));
  assert.match(html, /href="api-keys\.html"/);
  assert.match(html, /API keys &amp; credits/, 'the ampersand must be escaped');
  assert.match(html, /class="profile-menu__link desktop-only"/, 'it should look like the other rows');
  // `desktop-only` is HALF of the PC-only rule — api-keys-gate.js is the other half, and
  // this row is the one entrance the markup sweep in
  // test/frontend/desktop-only-gates.test.js cannot see, because the menu is built in JS
  // rather than shipped as a tag. Dropping the class would advertise the dashboard on a
  // phone that its own gate then bounces to the home page.
  assert.match(html, /\bdesktop-only\b/, 'the dashboard is PC-only — see api-keys-gate.js');
});

test('a translated label is used when the pack has one', () => {
  const html = apiKeysRowHtml((k) => (k === 'profile.apiKeys' ? 'Claves de API' : 'WRONG KEY'), (s) => s);
  assert.match(html, /Claves de API/);
});

test('the summary is fetched at most once, however many times the menu opens', async () => {
  let calls = 0;
  const summary = createApiSummary({ getToken: () => 'tok' }, async () => {
    calls += 1;
    return { ok: true, json: async () => ({ keyCount: 2, balance: 10 }) };
  });

  assert.equal(summary.read(), null, 'nothing before the first load');
  await summary.load();
  await summary.load();
  await summary.load();

  assert.equal(calls, 1, 'a dropdown the user clicks repeatedly must not re-request');
  assert.equal(summary.read().keyCount, 2);
  assert.equal(apiRowVisible(summary.read()), true);
});

test('the request carries the session token as a header', async () => {
  let seen = null;
  const summary = createApiSummary({ getToken: () => 'my-token' }, async (url, opts) => {
    seen = { url, opts };
    return { ok: true, json: async () => ({ keyCount: 1 }) };
  });
  await summary.load();

  assert.equal(seen.url, '/api/api-credits');
  assert.equal(seen.opts.headers.Authorization, 'Bearer my-token');
});

test('a signed-out visitor never fetches', async () => {
  let calls = 0;
  const summary = createApiSummary({ getToken: () => null }, async () => { calls += 1; });
  assert.equal(await summary.load(), null);
  assert.equal(calls, 0);
  assert.equal(apiRowVisible(summary.read()), false);
});

test('a failed request degrades to no row and is not retried', async () => {
  for (const failing of [
    async () => { throw new Error('offline'); },
    async () => ({ ok: false, status: 500, json: async () => ({}) }),
  ]) {
    let calls = 0;
    const summary = createApiSummary({ getToken: () => 'tok' }, async (...a) => {
      calls += 1;
      return failing(...a);
    });

    assert.equal(await summary.load(), null);
    await summary.load();
    assert.equal(calls, 1, 'a flaky network must not turn the menu into a request loop');
    assert.equal(apiRowVisible(summary.read()), false);
  }
});

test('the Stagify API row is UNGATED and goes to the dashboard', () => {
  // Still not behind apiRowVisible — that part of the old rule stands, and for the same
  // reason: a door that only opens from the inside is no door. What CHANGED is where it
  // opens onto. It used to point at developers.html as the ungated counterpart to a
  // use-gated dashboard row; the menu now carries one API entry and it is this one, so
  // it goes to api-keys.html for every signed-in visitor. The docs keep their footer link.
  const html = stagifyApiRowHtml((k, fallback) => fallback, (s) => s);
  assert.match(html, /href="api-keys\.html"/);
  assert.match(html, /Stagify API/);
  assert.match(html, /class="profile-menu__link desktop-only"/, 'it should look like the other rows');
});

test('the Stagify API row is desktop-only, because its page turns phones away', () => {
  // Not cosmetic, and not covered by the assertion above drifting: api-keys-gate.js
  // answers a phone-sized viewport by replacing the location with the home page, so an
  // unhidden row advertises a page that undoes the tap. Pinned here as its own case so
  // that deleting the class fails with the reason rather than as a markup mismatch.
  // test/frontend/desktop-only-gates.test.js owns the other half — that the page really
  // does gate, at the same breakpoint the class hides at.
  assert.match(
    stagifyApiRowHtml((k, fallback) => fallback, (s) => s),
    /\bdesktop-only\b/,
    'api-keys.html redirects phones — the row must not offer it to one',
  );
});

test('the Stagify API row reads its own key, and escapes what comes back', () => {
  // The label is a product name, so every pack carries the same string — but the row
  // must still go through the translator rather than hard-coding it, or a pack could
  // never correct it.
  assert.match(
    stagifyApiRowHtml((k) => (k === 'profile.stagifyApi' ? 'Stagify API' : 'WRONG KEY'), (s) => s),
    /Stagify API/,
  );
  assert.match(
    stagifyApiRowHtml(() => 'A & B', (s) => String(s).replace(/&/g, '&amp;')),
    /A &amp; B/,
  );
});

test('a missing auth global is survivable', async () => {
  const summary = createApiSummary(undefined, async () => { throw new Error('must not be called'); });
  assert.equal(await summary.load(), null);
});
