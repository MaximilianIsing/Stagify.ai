// The detail panel's focus behaviour.
//
// WHAT THIS COVERS
// The panel shipped with role="dialog" and aria-modal="true" and none of the behaviour
// those attributes promise. The attributes only describe the element; if focus never
// moves into it, a keyboard user activates a card and focus stays on the card BEHIND the
// overlay — the dialog is never announced, Tab walks the page underneath it, and Escape
// is the only way out that happens to work.
//
// test/frontend/dialog-a11y.test.js pins that the calls exist in the source. This pins
// what they DO, which is the half a source scan cannot see.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../../../public/scripts/gallery-app.js';
import { galleryDocument, fakeRoutes } from '../../helpers/gallery-dom.js';

const ENTRY = {
  id: 'r1',
  createdAt: Date.UTC(2026, 7, 1),
  roomType: 'Bedroom',
  urls: { after: '/a.webp', before: '/b.webp', thumb: '/t.webp' },
  share: { active: false },
};

const listing = (entries) => ({
  '/api/gallery': { status: 200, body: { entries, total: entries.length, enabled: true } },
});

/** Boot the page with one entry and open its card. Returns the card that opened it. */
async function openFirstCard(overrides = {}) {
  const ctx = galleryDocument();
  await start({ doc: ctx.document, fetchImpl: fakeRoutes(listing([{ ...ENTRY, ...overrides }])) });
  const card = ctx.byId('gal-grid').children[0];
  card.fire('click');
  return { ...ctx, card };
}

const tab = (doc, shiftKey = false) => doc.fire('keydown', { key: 'Tab', shiftKey, preventDefault() {} });

test('opening a card moves focus into the panel', async () => {
  const { document, byId } = await openFirstCard();

  assert.equal(byId('gal-detail').hidden, false);
  assert.equal(document.activeElement, byId('gal-detail-close'),
    'focus stayed on the page behind the overlay');
});

test('closing hands focus back to the card that opened it', async () => {
  const { document, byId, card } = await openFirstCard();

  byId('gal-detail-close').fire('click');
  assert.equal(byId('gal-detail').hidden, true);
  assert.equal(document.activeElement, card, 'focus was dropped rather than returned');
});

test('Escape restores focus too, not just the close button', async () => {
  const { document, card } = await openFirstCard();

  document.fire('keydown', { key: 'Escape' });
  assert.equal(document.activeElement, card);
});

test('dismissing by backdrop restores focus as well', async () => {
  const { document, byId, card } = await openFirstCard();

  const detail = byId('gal-detail');
  detail.fire('click', { target: detail });
  assert.equal(document.activeElement, card);
});

test('a card that is gone by close time does not get focus thrown at it', async () => {
  // Deleting a render closes the panel and re-renders the grid. Focusing a detached node
  // silently drops focus to <body>, which is worse than leaving it where it was.
  const { document, byId, card } = await openFirstCard();
  card.isConnected = false;
  const before = document.activeElement;

  byId('gal-detail-close').fire('click');
  assert.equal(document.activeElement, before, 'focus moved to a node no longer in the page');
});

test('Tab cycles the panel controls instead of escaping to the page behind', async () => {
  const { document, byId } = await openFirstCard();

  // close → the compare slider → create → delete, then back round. The share URL and the
  // revoke button ship hidden for an unshared entry and must be skipped.
  tab(document);
  assert.notEqual(document.activeElement, byId('gal-detail-close'), 'Tab did not move at all');
  assert.equal(document.activeElement.getAttribute('type'), 'range', 'the slider is next in the panel');

  tab(document);
  assert.equal(document.activeElement, byId('gal-share-create'));

  tab(document);
  assert.equal(document.activeElement, byId('gal-delete'));

  tab(document);
  assert.equal(document.activeElement, byId('gal-detail-close'), 'the last control must wrap to the first');
});

test('Shift+Tab from the first control wraps to the last', async () => {
  const { document, byId } = await openFirstCard();

  tab(document, true);
  assert.equal(document.activeElement, byId('gal-delete'));
});

test('hidden controls are skipped, and a revealed one joins the cycle', async () => {
  // The revoke button is the one control whose presence depends on the entry. A tab order
  // built once at open would strand it.
  const { document, byId } = await openFirstCard({ share: { active: true, viewCount: 2 } });
  assert.equal(byId('gal-share-revoke').hidden, false, 'fixture check: this entry has a live link');

  tab(document);
  tab(document);
  assert.equal(document.activeElement, byId('gal-share-create'));
  tab(document);
  assert.equal(document.activeElement, byId('gal-share-revoke'), 'a visible control was skipped');
});

test('an entry with no before image has no slider to tab to', async () => {
  // renderCompare degrades to the staged image alone, so the control simply is not there.
  const { document, byId } = await openFirstCard({ urls: { after: '/a.webp', before: '', thumb: '' } });

  tab(document);
  assert.equal(document.activeElement, byId('gal-share-create'), 'tabbed onto a control that was never rendered');
});

test('the modal marks the body so the page behind it stops scrolling', async () => {
  const { document, body, byId } = await openFirstCard();
  assert.equal(body.getAttribute('data-gal-modal'), 'open');

  byId('gal-detail-close').fire('click');
  assert.equal(body.getAttribute('data-gal-modal'), null, 'the scroll lock outlived the modal');
  assert.ok(document.activeElement);
});

test('Tab does nothing special while the panel is closed', async () => {
  // The trap is document-level; without the hidden check it would capture Tab for the
  // whole page, which is a worse bug than the one it fixes.
  const ctx = galleryDocument();
  await start({ doc: ctx.document, fetchImpl: fakeRoutes(listing([ENTRY])) });

  tab(ctx.document);
  assert.equal(ctx.document.activeElement, null, 'the trap ran with no dialog open');
});
