// The owner's gallery page (public/scripts/gallery-app.js + gallery/*).
//
// The behaviours worth pinning are the ones a screenshot would not catch: the page has
// one writer of its state so two cannot show at once, the share token is displayed
// exactly once and never re-fetched, and the revoke copy tells the truth about presigned
// URLs expiring rather than claiming an instant cutoff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../../../public/scripts/gallery-app.js';
import { formatWhen, renderGrid, renderCompare, renderMeta } from '../../../public/scripts/gallery/view.js';
import { galleryDocument, fakeRoutes } from '../../helpers/gallery-dom.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const ENTRY = {
  id: 'r1',
  createdAt: Date.UTC(2026, 7, 1),
  width: 1024,
  height: 683,
  roomType: 'Bedroom',
  furnitureStyle: 'modern',
  additionalPrompt: 'keep the desk',
  removeFurniture: true,
  urls: { after: '/a.webp?sig=1', before: '/b.webp?sig=1', thumb: '/t.webp?sig=1' },
  references: [{ url: '/ref.webp?sig=1' }],
  share: { active: false },
};

const listing = (entries, extra = {}) => ({
  '/api/gallery': { status: 200, body: { entries, total: entries.length, enabled: true, ...extra } },
});

// ---- the state machine --------------------------------------------------------------

test('a populated gallery settles on ready and renders a card per entry', async () => {
  const { document, byId } = galleryDocument();
  const state = await start({ doc: document, fetchImpl: fakeRoutes(listing([ENTRY, { ...ENTRY, id: 'r2' }])) });
  assert.equal(state, 'ready');
  assert.equal(document.body.getAttribute('data-state'), 'ready');
  assert.equal(byId('gal-grid').children.length, 2);
  assert.match(byId('gal-count').textContent, /2 staged rooms/);
});

test('one entry is described in the singular', async () => {
  const { document, byId } = galleryDocument();
  await start({ doc: document, fetchImpl: fakeRoutes(listing([ENTRY])) });
  assert.match(byId('gal-count').textContent, /1 staged room$/);
});

test('an empty gallery is not the same state as a switched-off one', async () => {
  // "Nothing here yet" and "this deployment cannot save renders" mean very different
  // things to somebody wondering where their work went.
  const { document: a } = galleryDocument();
  assert.equal(await start({ doc: a, fetchImpl: fakeRoutes(listing([])) }), 'empty');

  const { document: b } = galleryDocument();
  const off = { '/api/gallery': { status: 200, body: { entries: [], total: 0, enabled: false } } };
  assert.equal(await start({ doc: b, fetchImpl: fakeRoutes(off) }), 'off');
});

test('a 401 says signed out rather than showing an empty gallery', async () => {
  const { document } = galleryDocument();
  const state = await start({ doc: document, fetchImpl: fakeRoutes({ '/api/gallery': { status: 401, body: { code: 'AUTH_REQUIRED' } } }) });
  assert.equal(state, 'signed-out');
});

// ---- the share token is shown ONCE ---------------------------------------------------

test('minting shows the link once and says so', async () => {
  const { document, byId } = galleryDocument();
  const routes = fakeRoutes({
    ...listing([ENTRY]),
    '/api/gallery/r1/share': { status: 200, body: { url: 'https://stagify.test/s/TOKEN', share: { active: true, viewCount: 0 } } },
  });
  await start({ doc: document, fetchImpl: routes });

  byId('gal-grid').children[0].fire('click');
  await byId('gal-share-create').fire('click');

  assert.equal(byId('gal-share-url').value, 'https://stagify.test/s/TOKEN');
  assert.equal(byId('gal-share-url').hidden, false);
  assert.match(byId('gal-share-status').textContent, /only shown once/i);
});

test('an entry that already has a live link shows that, but not the link', async () => {
  // The server hands the token back once and has no read-back. A "copy link" button that
  // could not work would be worse than telling the agent to create a new one.
  const { document, byId } = galleryDocument();
  const shared = { ...ENTRY, share: { active: true, viewCount: 3 } };
  await start({ doc: document, fetchImpl: fakeRoutes(listing([shared])) });

  byId('gal-grid').children[0].fire('click');
  assert.equal(byId('gal-share-url').hidden, true, 'no link is displayed');
  assert.match(byId('gal-share-status').textContent, /opened 3 times/);
  assert.equal(byId('gal-share-create').textContent, 'Create a new link');
  assert.equal(byId('gal-share-revoke').hidden, false);
});

test('the revoke copy does NOT claim an instant cutoff', async () => {
  // Image URLs are presigned, so one already handed out works until it expires. Copy
  // saying "immediately" would be the actual bug, not a rounding of the truth.
  const { document, byId } = galleryDocument();
  const shared = { ...ENTRY, share: { active: true, viewCount: 1 } };
  const routes = fakeRoutes({ ...listing([shared]), '/api/gallery/r1/share': { status: 200, body: { success: true } } });
  await start({ doc: document, fetchImpl: routes });

  byId('gal-grid').children[0].fire('click');
  await byId('gal-share-revoke').fire('click');

  const status = byId('gal-share-status').textContent;
  assert.match(status, /within 15 minutes/i);
  assert.ok(!/immediately/i.test(status), 'must not promise an instant cutoff');
});

test('the shipped page repeats that caveat where the agent will read it', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'gallery.html'), 'utf8');
  assert.match(src, /within 15 minutes/i);
  assert.ok(!/stops (visits )?immediately/i.test(src));
});

test('a failed mint reports it instead of showing a blank link box', async () => {
  const { document, byId } = galleryDocument();
  const routes = fakeRoutes({ ...listing([ENTRY]), '/api/gallery/r1/share': { status: 500, body: null } });
  await start({ doc: document, fetchImpl: routes });

  byId('gal-grid').children[0].fire('click');
  await byId('gal-share-create').fire('click');
  assert.match(byId('gal-share-status').textContent, /could not create/i);
  assert.equal(byId('gal-share-url').hidden, true);
});

// ---- the detail panel ----------------------------------------------------------------

test('opening a card fills the detail panel with what was asked for', async () => {
  const { document, byId } = galleryDocument();
  await start({ doc: document, fetchImpl: fakeRoutes(listing([ENTRY])) });
  byId('gal-grid').children[0].fire('click');

  assert.equal(byId('gal-detail').hidden, false);
  assert.equal(byId('gal-detail-title').textContent, 'Bedroom');
  const meta = byId('gal-meta').textContent;
  // The reason a gallery beats a downloads folder.
  assert.match(meta, /keep the desk/);
  assert.match(meta, /modern/);
});

test('the backdrop closes the panel, the panel itself does not', async () => {
  const { document, byId } = galleryDocument();
  await start({ doc: document, fetchImpl: fakeRoutes(listing([ENTRY])) });
  byId('gal-grid').children[0].fire('click');

  const detail = byId('gal-detail');
  detail.fire('click', { target: byId('gal-detail-title') });
  assert.equal(detail.hidden, false, 'a click inside must not dismiss it');

  detail.fire('click', { target: detail });
  assert.equal(detail.hidden, true);
});

// ---- the comparison --------------------------------------------------------------------

test('a render with no before degrades to the staged image, with no control to drag', () => {
  const { document } = galleryDocument();
  const container = document.createElement('div');
  renderCompare({ container, doc: document, entry: { ...ENTRY, urls: { after: '/a.webp', before: '', thumb: '' } } });
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].tagName, 'IMG');
});

test('a render with a before gets a slider', () => {
  const { document } = galleryDocument();
  const container = document.createElement('div');
  renderCompare({ container, doc: document, entry: ENTRY });
  assert.equal(container.children.length, 3, 'before, after, range');
  assert.equal(container.children[2].getAttribute('type'), 'range');
});

// ---- misc ------------------------------------------------------------------------------

test('a shared entry is marked in the grid', () => {
  // Shared entries behave differently — the free-tier cap protects them — so the agent
  // needs to be able to see which ones they are.
  const { document } = galleryDocument();
  const grid = document.createElement('div');
  renderGrid({ grid, doc: document, entries: [{ ...ENTRY, share: { active: true } }], onOpen: () => {} });
  assert.match(grid.children[0].textContent, /link on/);
});

test('meta skips the fields that are empty rather than printing blanks', () => {
  const { document } = galleryDocument();
  const container = document.createElement('dl');
  renderMeta({ container, doc: document, entry: { ...ENTRY, additionalPrompt: '', furnitureStyle: '', removeFurniture: false } });
  const text = container.textContent;
  assert.ok(!text.includes('Extra prompt'));
  assert.ok(!text.includes('Removed furniture'));
  assert.match(text, /Bedroom/);
});

test('an unparseable date renders as empty, not "Invalid Date"', () => {
  assert.equal(formatWhen(NaN), '');
  assert.equal(formatWhen(undefined), '');
  assert.ok(formatWhen(Date.UTC(2026, 7, 1)).length > 0);
});
