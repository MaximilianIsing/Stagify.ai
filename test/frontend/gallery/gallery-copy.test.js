// Copying the share link.
//
// WHAT THIS COVERS
// The share token is returned by the server exactly once and has no read-back, so the
// copy button guards the only moment the link exists in a form a person can take away.
// Two properties follow from that and neither is cosmetic:
//
//   1. The button exists only while the link is on screen. Offering "copy" when there is
//      nothing to copy invites a click that silently does nothing.
//   2. It reports what ACTUALLY happened. Clipboard writes are refused outside a secure
//      context and in some webviews; saying "Copied" anyway would cost the agent the
//      link outright, since there is no second chance to read the token.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { start } from '../../../public/scripts/gallery-app.js';
import { copyText } from '../../../public/scripts/clipboard.js';
import { renderGrid } from '../../../public/scripts/gallery/view.js';
import { galleryDocument, fakeRoutes } from '../../helpers/gallery-dom.js';

const ENTRY = {
  id: 'r1',
  createdAt: Date.UTC(2026, 7, 1),
  roomType: 'Bedroom',
  urls: { after: '/a.webp', before: '/b.webp', thumb: '/t.webp' },
  share: { active: false },
};

const LINK = 'https://stagify.test/s/TOKEN';

// Cloned: minting writes the new link onto `entry.share`, so a shared fixture object
// would carry one test's link into the next.
const routes = (extra = {}) => fakeRoutes({
  '/api/gallery': { status: 200, body: { entries: [structuredClone(ENTRY)], total: 1, enabled: true } },
  '/api/gallery/r1/share': { status: 200, body: { url: LINK, share: { active: true, viewCount: 0 } } },
  ...extra,
});

/** Boot, open the card, and hand back the context. */
async function openCard() {
  const ctx = galleryDocument();
  await start({ doc: ctx.document, fetchImpl: routes() });
  ctx.byId('gal-grid').children[0].fire('click');
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

test('there is nothing to copy until a link has been minted', async () => {
  const ctx = await openCard();
  assert.equal(ctx.byId('gal-share-copy').hidden, true);
  assert.equal(ctx.byId('gal-share-url').hidden, true);
});

test('minting reveals the link and the button together', async () => {
  const ctx = await openCard();
  await ctx.byId('gal-share-create').fire('click');

  assert.equal(ctx.byId('gal-share-url').value, LINK);
  assert.equal(ctx.byId('gal-share-url').hidden, false);
  assert.equal(ctx.byId('gal-share-copy').hidden, false);
});

test('an entry with a live link but no token on screen offers no copy button', async () => {
  // Reopening a shared render shows THAT it is shared without showing the link, because
  // the server cannot hand the token back. A copy button there would copy an empty box.
  const ctx = galleryDocument();
  const shared = { ...ENTRY, share: { active: true, viewCount: 3 } };
  await start({
    doc: ctx.document,
    fetchImpl: fakeRoutes({ '/api/gallery': { status: 200, body: { entries: [shared], total: 1, enabled: true } } }),
  });
  ctx.byId('gal-grid').children[0].fire('click');

  assert.equal(ctx.byId('gal-share-copy').hidden, true, 'nothing to copy — the token is not re-issued');
  assert.equal(ctx.byId('gal-share-url').hidden, true);
});

test('a copy that did not happen says so, instead of claiming success', async () => {
  // The stand-in document has no clipboard and no execCommand, so both paths fail —
  // which is exactly the situation the honest message exists for.
  const ctx = await openCard();
  await ctx.byId('gal-share-create').fire('click');
  await ctx.byId('gal-share-copy').fire('click');

  const status = ctx.byId('gal-share-status').textContent;
  assert.match(status, /could not copy/i);
  assert.ok(!/copied\./i.test(status), 'must not claim the link is on the clipboard');
});

test('a thumbnail that will not load falls back to the full render', async () => {
  // Distinct objects in the store, so one can be missing while the other is fine.
  const { document } = galleryDocument();
  const grid = document.createElement('div');
  renderGrid({
    grid,
    doc: document,
    entries: [{ ...ENTRY, urls: { thumb: '/gone.webp', after: '/there.webp', before: '' } }],
    onOpen: () => {},
  });

  const img = grid.children[0].children[0];
  assert.equal(img.getAttribute('src'), '/gone.webp');
  img.fire('error');
  assert.equal(img.getAttribute('src'), '/there.webp', 'it should try the full render');
});

test('and when that fails too it degrades quietly instead of printing its alt text', async () => {
  // The failure the user saw: a broken tile filled with "Bedroom, staged".
  const { document } = galleryDocument();
  const grid = document.createElement('div');
  renderGrid({
    grid,
    doc: document,
    entries: [{ ...ENTRY, urls: { thumb: '/gone.webp', after: '/also-gone.webp', before: '' } }],
    onOpen: () => {},
  });

  const img = grid.children[0].children[0];
  img.fire('error');
  img.fire('error');

  assert.equal(img.getAttribute('alt'), '', 'no sprawling alt text');
  assert.match(img.className, /gal-card__img--missing/);
  assert.match(img.getAttribute('src'), /^data:image\/gif/, 'a valid src, or the browser draws its own broken glyph');
  // The room is still identifiable — the card, not the image, carries the name.
  assert.match(grid.children[0].getAttribute('aria-label'), /Bedroom/);
});

test('the copy button is reachable by keyboard inside the panel', async () => {
  // It sits between the link box and "create", so tabbing from the close button reaches
  // it without leaving the dialog.
  const ctx = await openCard();
  await ctx.byId('gal-share-create').fire('click');

  const tab = () => ctx.document.fire('keydown', { key: 'Tab', preventDefault() {} });
  ctx.byId('gal-detail-close').focus();
  const seen = [];
  for (let i = 0; i < 6; i++) { tab(); seen.push(ctx.document.activeElement); }

  assert.ok(seen.includes(ctx.byId('gal-share-copy')), 'the copy button is not in the tab cycle');
});
