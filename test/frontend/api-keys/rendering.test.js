// Tier: unit (fake elements, no jsdom) — the two render islands SHARED by api-keys.html
// and developers.html: api-keys/{credit-packs,ledger}.js.
//
// WHAT THIS COVERS
// Both write innerHTML, and both are the last places on these two pages where a number
// is turned into words:
//   - prices are formatted from minor units, and the per-image figure is the number a
//     developer actually compares between packs,
//   - a pack list that could not be loaded says so rather than rendering an empty grid
//     that reads as a broken page, and
//   - the ledger shows a refund as its own line, because the balance is DERIVED from
//     these rows and a customer counting their charges has to be able to reconcile.
//
// The dashboard's own islands — the inspector list and the two detail panes — are next
// door in inspector.test.js and detail.test.js. They used to be one flat key list
// covered here; the master/detail rebuild replaced it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPrice, formatUnitPrice, renderPacks, loadPacks } from '../../../public/scripts/api-keys/credit-packs.js';
import { renderLedger, reasonLabel } from '../../../public/scripts/api-keys/ledger.js';

/** The two properties every render target here needs. */
function host() {
  return {
    innerHTML: '',
    attrs: { 'data-loading': 'true' },
    removeAttribute(n) { delete this.attrs[n]; },
  };
}

const PACK = { id: 'api_100', credits: 100, amountCents: 1300, currency: 'usd' };

test('prices render from minor units, and the per-image figure is exact', () => {
  assert.equal(formatPrice(300, 'usd'), '$3.00');
  assert.equal(formatPrice(6000, 'usd'), '$60.00');
  assert.equal(formatUnitPrice(PACK), '$0.130 an image');
  assert.equal(formatUnitPrice({ credits: 500, amountCents: 6000 }), '$0.120 an image');
});

test('an unknown currency degrades instead of blanking the price', () => {
  const out = formatPrice(1300, 'zzz');
  assert.match(out, /13\.00/, 'the number must survive even when the code does not');
});

test('pack cards render the credits, the price and the unit price', () => {
  const h = host();
  renderPacks(h, [PACK], { buyable: false });

  assert.equal(h.attrs['data-loading'], undefined, 'the loading flag is cleared');
  assert.match(h.innerHTML, />100</);
  assert.match(h.innerHTML, /\$13\.00/);
  // Two nodes now, not one string: the noun carries data-lang so the docs page can
  // serve it in eleven languages, and it cannot be concatenated into the escaped
  // amount. The number is still the thing that has to be right.
  assert.match(h.innerHTML, /\$0\.130/);
  assert.match(h.innerHTML, /data-lang="developers\.packs\.each">an image</);
  assert.ok(!h.innerHTML.includes('data-buy-pack'), 'the docs page has no buy button');
});

test('the buyable variant carries a buy button keyed by pack id', () => {
  const h = host();
  renderPacks(h, [PACK], { buyable: true });
  assert.match(h.innerHTML, /data-buy-pack="api_100"/);
});

test('no packs says so, rather than rendering an empty grid that looks broken', () => {
  const h = host();
  renderPacks(h, [], { buyable: true });
  assert.match(h.innerHTML, /not available/i);
  assert.match(h.innerHTML, /contact\.html/, 'and offers a way out');
});

test('loadPacks returns [] on every failure shape rather than throwing into the page', async () => {
  assert.deepEqual(await loadPacks(async () => { throw new Error('offline'); }), []);
  assert.deepEqual(await loadPacks(async () => ({ ok: false, json: async () => ({}) })), []);
  assert.deepEqual(await loadPacks(async () => ({ ok: true, json: async () => ({}) })), []);
  assert.deepEqual(
    await loadPacks(async () => ({ ok: true, json: async () => ({ packs: [PACK] }) })),
    [PACK],
  );
});

test('ledger reasons are translated out of their storage codes', () => {
  assert.equal(reasonLabel('purchase'), 'Credits purchased');
  assert.equal(reasonLabel('debit'), 'Render');
  assert.match(reasonLabel('refund'), /refunded/i);
  assert.match(reasonLabel('clawback'), /reversed/i);
  // An unknown code must still render as something, not as "undefined".
  assert.equal(reasonLabel('something_new'), 'something_new');
});

test('the ledger signs each movement and shows the balance it produced', () => {
  const h = host();
  renderLedger(h, [
    { createdAt: 1700000000000, reason: 'refund', delta: 1, balanceAfter: 99 },
    { createdAt: 1700000000000, reason: 'debit', delta: -1, balanceAfter: 98 },
  ]);

  assert.match(h.innerHTML, /\+1/, 'a credit back must read as a gain');
  assert.match(h.innerHTML, /dev-pos/);
  assert.match(h.innerHTML, /-1/);
  assert.match(h.innerHTML, /dev-neg/);
  assert.match(h.innerHTML, />99</);
  assert.match(h.innerHTML, /Render failed/, 'a refund is its own visible line');
});

test('an empty ledger fills the table rather than collapsing it', () => {
  const h = host();
  renderLedger(h, []);
  assert.match(h.innerHTML, /colspan="4"/);
});

test('every renderer survives a missing host element', () => {
  // These run on two different pages; an element that exists on one and not the other
  // must be a no-op rather than a TypeError that kills the rest of the boot.
  assert.doesNotThrow(() => renderPacks(null, [PACK]));
  assert.doesNotThrow(() => renderLedger(null, []));
});
