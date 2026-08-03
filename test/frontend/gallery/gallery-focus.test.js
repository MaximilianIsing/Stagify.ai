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
import { galleryDocument, fakeRoutes, cards } from '../../helpers/gallery-dom.js';

const ENTRY = {
  id: 'r1',
  createdAt: Date.UTC(2026, 7, 1),
  roomType: 'Bedroom',
  urls: { after: '/a.webp', before: '/b.webp', thumb: '/t.webp' },
  share: { url: 'https://stagify.test/s/TOKEN', viewCount: 0 },
};

const listing = (entries) => ({
  '/api/gallery': { status: 200, body: { entries, total: entries.length, enabled: true } },
});

/** Boot the page with one entry and open its card. Returns the card that opened it. */
async function openFirstCard(overrides = {}) {
  const ctx = galleryDocument();
  await start({ doc: ctx.document, fetchImpl: fakeRoutes(listing([{ ...ENTRY, ...overrides }])) });
  const card = cards(ctx.byId)[0];
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

  // close → rename → the compare slider → the link box → copy → delete, then back round.
  tab(document);
  assert.notEqual(document.activeElement, byId('gal-detail-close'), 'Tab did not move at all');
  assert.equal(document.activeElement, byId('gal-rename'));

  tab(document);
  assert.equal(document.activeElement.getAttribute('type'), 'range', 'the slider is next in the panel');

  tab(document);
  assert.equal(document.activeElement, byId('gal-share-url'));

  tab(document);
  assert.equal(document.activeElement, byId('gal-share-copy'));

  tab(document);
  assert.equal(document.activeElement, byId('gal-delete'));

  tab(document);
  assert.equal(document.activeElement, byId('gal-detail-close'), 'the last control must wrap to the first');
});

test('the rename box joins the cycle only while it is open', async () => {
  // The two modes are exclusive — the trigger hides while the row is open — so a tab order
  // that included both would always walk onto something not on screen.
  const { document, byId } = await openFirstCard();
  byId('gal-rename').fire('click');

  assert.equal(byId('gal-rename').hidden, true, 'the trigger is replaced, not duplicated');
  assert.equal(document.activeElement, byId('gal-rename-input'), 'opening puts the caret in the box');

  tab(document);
  assert.equal(document.activeElement, byId('gal-rename-save'));
  tab(document);
  assert.equal(document.activeElement, byId('gal-rename-cancel'));
  tab(document);
  assert.equal(document.activeElement.getAttribute('type'), 'range', 'and out into the rest of the panel');
});

test('Shift+Tab from the first control wraps to the last', async () => {
  const { document, byId } = await openFirstCard();

  tab(document, true);
  assert.equal(document.activeElement, byId('gal-delete'));
});

test('controls hidden for this entry are skipped rather than stranding the cycle', async () => {
  // The link box and copy button are the pair whose presence depends on the entry: an
  // entry that came back without a URL hides both. A tab order built once at open would
  // walk onto them anyway.
  const { document, byId } = await openFirstCard({ share: null });
  assert.equal(byId('gal-share-copy').hidden, true, 'fixture check: this entry has no link to copy');

  tab(document);
  tab(document);
  tab(document);
  assert.equal(document.activeElement, byId('gal-delete'), 'tabbed onto a control that is not on screen');
});

test('an entry with no before image has no slider to tab to', async () => {
  // renderCompare degrades to the staged image alone, so the control simply is not there.
  const { document, byId } = await openFirstCard({ urls: { after: '/a.webp', before: '', thumb: '' } });

  tab(document);
  tab(document);
  assert.equal(document.activeElement, byId('gal-share-url'), 'tabbed onto a control that was never rendered');
});

test('Escape backs out of the rename box before it closes the panel', async () => {
  // Otherwise one key throws away both what was typed AND the render they were looking at,
  // when all they asked for was to stop renaming.
  const { document, byId } = await openFirstCard();
  byId('gal-rename').fire('click');

  document.fire('keydown', { key: 'Escape' });
  assert.equal(byId('gal-rename-row').hidden, true, 'the box stayed open');
  assert.equal(byId('gal-detail').hidden, false, 'the panel must survive the first Escape');
  assert.equal(document.activeElement, byId('gal-rename'), 'focus was left in a hidden box');

  document.fire('keydown', { key: 'Escape' });
  assert.equal(byId('gal-detail').hidden, true, 'the second Escape closes the panel');
});

test('the modal marks the body so the page behind it stops scrolling', async () => {
  const { document, body, byId } = await openFirstCard();
  assert.equal(body.getAttribute('data-gal-modal'), 'open');

  byId('gal-detail-close').fire('click');
  assert.equal(body.getAttribute('data-gal-modal'), null, 'the scroll lock outlived the modal');
  assert.ok(document.activeElement);
});

test('the page behind the panel is inert, not merely untabbable', async () => {
  // aria-modal only tells a screen reader the dialog is modal. Without inert, its virtual
  // cursor still reads the grid and the nav underneath — so the panel was modal to a
  // keyboard and porous to a reader. The manual Tab trap is exactly why nobody noticed.
  const { byId } = await openFirstCard();
  assert.equal(byId('gal-nav').getAttribute('inert'), '', 'the nav is still readable behind the overlay');
  assert.equal(byId('gal-main').getAttribute('inert'), '');

  byId('gal-detail-close').fire('click');
  assert.equal(byId('gal-nav').getAttribute('inert'), null, 'inert outlived the panel');
  assert.equal(byId('gal-main').getAttribute('inert'), null);
});

test('every way out of the panel lifts inert again', async () => {
  // Three dismissals, one of which (the backdrop) does not go through the close button.
  // A page left permanently inert is unusable in a way that is very hard to diagnose.
  for (const dismiss of [
    (byId, doc) => doc.fire('keydown', { key: 'Escape' }),
    (byId) => byId('gal-detail').fire('click', { target: byId('gal-detail') }),
    (byId) => byId('gal-detail-close').fire('click'),
  ]) {
    const { document, byId } = await openFirstCard();
    assert.equal(byId('gal-main').getAttribute('inert'), '');
    dismiss(byId, document);
    assert.equal(byId('gal-main').getAttribute('inert'), null);
    assert.equal(byId('gal-nav').getAttribute('inert'), null);
  }
});

test('Tab does nothing special while the panel is closed', async () => {
  // The trap is document-level; without the hidden check it would capture Tab for the
  // whole page, which is a worse bug than the one it fixes.
  const ctx = galleryDocument();
  await start({ doc: ctx.document, fetchImpl: fakeRoutes(listing([ENTRY])) });

  tab(ctx.document);
  assert.equal(ctx.document.activeElement, null, 'the trap ran with no dialog open');
});
