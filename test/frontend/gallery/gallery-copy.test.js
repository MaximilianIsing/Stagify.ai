// Copying the share link.
//
// WHAT THIS COVERS
// Copy is the only control the share panel has left: every entry arrives with a link, so
// there is nothing to create and nothing to switch off. Two properties follow and neither
// is cosmetic:
//
//   1. The button exists only while a link is on screen. Offering "copy" when there is
//      nothing to copy invites a click that silently does nothing.
//   2. It reports what ACTUALLY happened. Clipboard writes are refused outside a secure
//      context and in some webviews; saying "Copied" anyway sends the agent off to paste
//      an empty clipboard into a message to their client.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { start } from '../../../public/scripts/gallery-app.js';
import { copyText } from '../../../public/scripts/clipboard.js';
import { renderGrid } from '../../../public/scripts/gallery/view.js';
import { galleryDocument, fakeRoutes, cards } from '../../helpers/gallery-dom.js';

const LINK = 'https://stagify.test/s/TOKEN';

const ENTRY = {
  id: 'r1',
  createdAt: Date.UTC(2026, 7, 1),
  roomType: 'Bedroom',
  urls: { after: '/a.webp', before: '/b.webp', thumb: '/t.webp' },
  share: { url: LINK, viewCount: 0 },
};

// Cloned: the app holds onto the entry it is given, so a shared fixture object would
// carry one test's state into the next.
const routes = (entry = ENTRY) => fakeRoutes({
  '/api/gallery': { status: 200, body: { entries: [structuredClone(entry)], total: 1, enabled: true } },
});

/** Boot, open the card, and hand back the context. */
async function openCard(entry) {
  const ctx = galleryDocument();
  await start({ doc: ctx.document, fetchImpl: routes(entry) });
  cards(ctx.byId)[0].fire('click');
  return ctx;
}

// ---- the primitive --------------------------------------------------------------------

test('copyText uses the async clipboard when there is one', async () => {
  const written = [];
  const nav = { clipboard: { writeText: async (t) => { written.push(t); } } };
  assert.equal(await copyText('hello', { nav, doc: /** @type {any} */ ({}) }), true);
  assert.deepEqual(written, ['hello']);
});

test('a refused clipboard write falls back rather than throwing', async () => {
  // Denied permission is the common case on http and inside embedded webviews.
  const nav = { clipboard: { writeText: async () => { throw new Error('denied'); } } };
  const doc = fakeCopyDoc({ execCommandResult: true });
  assert.equal(await copyText('hello', { nav, doc }), true);
  assert.equal(doc.copied, 'hello', 'the fallback must copy the same text');
  assert.equal(doc.leftBehind, 0, 'the throwaway textarea must be removed');
});

test('copyText reports false when neither path works', async () => {
  const nav = { clipboard: { writeText: async () => { throw new Error('denied'); } } };
  assert.equal(await copyText('hello', { nav, doc: fakeCopyDoc({ execCommandResult: false }) }), false);
  assert.equal(await copyText('', { nav, doc: fakeCopyDoc({}) }), false, 'nothing to copy is not a success');
});

/** A document just real enough for the execCommand fallback. */
function fakeCopyDoc({ execCommandResult = true }) {
  const state = {
    copied: null,
    leftBehind: 0,
    createElement: () => ({ style: {}, value: '', setAttribute() {}, focus() {}, select() { state.copied = state.pending; } }),
    execCommand: () => execCommandResult,
    body: {
      appendChild: (n) => { state.leftBehind += 1; state.pending = n.value; },
      removeChild: () => { state.leftBehind -= 1; },
    },
  };
  return /** @type {any} */ (state);
}

// ---- the button -----------------------------------------------------------------------

test('the link and its button are both there the moment a card opens', async () => {
  const ctx = await openCard();
  assert.equal(ctx.byId('gal-share-url').value, LINK);
  assert.equal(ctx.byId('gal-share-url').hidden, false);
  assert.equal(ctx.byId('gal-share-copy').hidden, false);
});

test('an entry that came back without a URL offers no copy button', async () => {
  // The listing mints for every finished render, so this is the server having failed
  // rather than a state the owner put the render in. A copy button would copy an empty
  // box and report success.
  const ctx = await openCard({ ...ENTRY, share: null });

  assert.equal(ctx.byId('gal-share-copy').hidden, true, 'nothing to copy');
  assert.equal(ctx.byId('gal-share-url').hidden, true);
});

test('a copy that did not happen says so, instead of claiming success', async () => {
  // The stand-in document has no clipboard and no execCommand, so both paths fail —
  // which is exactly the situation the honest message exists for.
  const ctx = await openCard();
  await ctx.byId('gal-share-copy').fire('click');

  const status = ctx.byId('gal-share-status').textContent;
  assert.match(status, /could not copy/i);
  assert.ok(!/copied/i.test(status), 'must not claim the link is on the clipboard');
});

test('a thumbnail that will not load falls back to the full render', async () => {
  // Distinct objects in the store, so one can be missing while the other is fine.
  const { document } = galleryDocument();
  const grid = document.createElement('div');
  const [card] = renderGrid({
    grid,
    doc: document,
    entries: [{ ...ENTRY, urls: { thumb: '/gone.webp', after: '/there.webp', before: '' } }],
    onOpen: () => {},
  });

  const img = card.children[0];
  assert.equal(img.getAttribute('src'), '/gone.webp');
  img.fire('error');
  assert.equal(img.getAttribute('src'), '/there.webp', 'it should try the full render');
});

test('and when that fails too it degrades quietly instead of printing its alt text', async () => {
  // The failure the user saw: a broken tile filled with "Bedroom, staged".
  const { document } = galleryDocument();
  const grid = document.createElement('div');
  const [card] = renderGrid({
    grid,
    doc: document,
    entries: [{ ...ENTRY, urls: { thumb: '/gone.webp', after: '/also-gone.webp', before: '' } }],
    onOpen: () => {},
  });

  const img = card.children[0];
  img.fire('error');
  img.fire('error');

  assert.equal(img.getAttribute('alt'), '', 'no sprawling alt text');
  assert.match(img.className, /gal-card__img--missing/);
  assert.match(img.getAttribute('src'), /^data:image\/gif/, 'a valid src, or the browser draws its own broken glyph');
  // The room is still identifiable — the card, not the image, carries the name.
  assert.match(card.getAttribute('aria-label'), /Bedroom/);
});

test('the copy button is reachable by keyboard inside the panel', async () => {
  // It sits between the link box and delete, so tabbing from the close button reaches it
  // without leaving the dialog.
  const ctx = await openCard();

  const tab = () => ctx.document.fire('keydown', { key: 'Tab', preventDefault() {} });
  ctx.byId('gal-detail-close').focus();
  const seen = [];
  for (let i = 0; i < 6; i++) { tab(); seen.push(ctx.document.activeElement); }

  assert.ok(seen.includes(ctx.byId('gal-share-copy')), 'the copy button is not in the tab cycle');
});
