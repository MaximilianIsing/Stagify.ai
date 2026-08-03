// The owner's gallery page (public/scripts/gallery-app.js + gallery/*).
//
// The behaviours worth pinning are the ones a screenshot would not catch: the page has
// one writer of its state so two cannot show at once, opening a card shows the link that
// came with the listing rather than negotiating for one, and the takedown copy tells the
// truth about presigned URLs expiring rather than claiming an instant cutoff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../../../public/scripts/gallery-app.js';
import {
  formatWhen, renderGrid, renderCompare, renderMeta, entryName, defaultName,
} from '../../../public/scripts/gallery/view.js';
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
  // Every entry arrives with its link — there is no create call for the page to make.
  share: { url: 'https://stagify.test/s/TOKEN', viewCount: 0 },
};

// Cloned, because the app MUTATES the entry it is given — minting writes the new link
// onto `entry.share`. Handing every test the same module-level ENTRY object made one
// test's link visible to the next, which is the sort of coupling that shows up as an
// unrelated assertion failing three tests later.
const listing = (entries, extra = {}) => ({
  '/api/gallery': {
    status: 200,
    body: { entries: entries.map((e) => structuredClone(e)), total: entries.length, enabled: true, ...extra },
  },
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

// ---- the link is simply there --------------------------------------------------------

test('opening a card shows its link, with nothing to press first', async () => {
  // The model in one assertion: no create step, no request of its own — the URL arrived
  // with the listing and the panel paints it.
  const { document, byId } = galleryDocument();
  const routes = fakeRoutes(listing([ENTRY]));
  await start({ doc: document, fetchImpl: routes });

  byId('gal-grid').children[0].fire('click');

  assert.equal(byId('gal-share-url').value, 'https://stagify.test/s/TOKEN');
  assert.equal(byId('gal-share-url').hidden, false);
  assert.equal(byId('gal-share-copy').hidden, false, 'the one control, and it is ready');
  assert.match(byId('gal-share-status').textContent, /not opened yet/i);
  assert.deepEqual(routes.calls.map((c) => c.method), ['GET'], 'opening a card asks the server for nothing');
});

test('the status counts visits without dressing them up as link state', async () => {
  // "Link is on · opened 3 times" said something when a link could be off. Now the only
  // news is whether anybody has been.
  const { document, byId } = galleryDocument();
  const seen = { ...ENTRY, share: { url: 'https://stagify.test/s/LIVE', viewCount: 3 } };
  await start({ doc: document, fetchImpl: fakeRoutes(listing([seen])) });

  byId('gal-grid').children[0].fire('click');
  assert.equal(byId('gal-share-url').value, 'https://stagify.test/s/LIVE');
  const status = byId('gal-share-status').textContent;
  assert.match(status, /opened 3 times/i);
  assert.ok(!/link is on/i.test(status), 'a link that is always on is not news');
});

test('an entry that came back without a URL says so instead of showing an empty box', async () => {
  // Not reachable by the owner doing anything — the listing mints for every finished
  // render — so it is a failure, and reporting it as "no link yet" would invite a wait
  // that never ends.
  const { document, byId } = galleryDocument();
  const broken = { ...ENTRY, share: null };
  await start({ doc: document, fetchImpl: fakeRoutes(listing([broken])) });

  byId('gal-grid').children[0].fire('click');
  assert.equal(byId('gal-share-url').hidden, true);
  assert.equal(byId('gal-share-copy').hidden, true, 'nothing to copy');
  assert.match(byId('gal-share-status').textContent, /could not be loaded/i);
});

test('the takedown copy does NOT claim an instant cutoff', () => {
  // Deleting the render is the only takedown, and image URLs are presigned — one already
  // handed out works until it expires. Copy saying "immediately" would be the actual bug,
  // not a rounding of the truth.
  const src = fs.readFileSync(path.join(ROOT, 'public', 'gallery.html'), 'utf8');
  assert.match(src, /within 15 minutes/i);
  assert.ok(!/stops (visits )?immediately/i.test(src));
});

test('nothing on the page offers to create or turn off a link', async () => {
  // The two controls this model removed. A page that still shipped them hidden would be
  // one CSS change away from offering an action the server no longer has a route for.
  const src = fs.readFileSync(path.join(ROOT, 'public', 'gallery.html'), 'utf8');
  assert.ok(!/id="gal-share-create"/.test(src));
  assert.ok(!/id="gal-share-revoke"/.test(src));

  const app = fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'gallery-app.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(!/mintShare|revokeShare/.test(app), 'the page can still call a route that is gone');
});

// ---- the detail panel ----------------------------------------------------------------

test('opening a card fills the detail panel with what was asked for', async () => {
  const { document, byId } = galleryDocument();
  await start({ doc: document, fetchImpl: fakeRoutes(listing([ENTRY])) });
  byId('gal-grid').children[0].fire('click');

  assert.equal(byId('gal-detail').hidden, false);
  assert.equal(byId('gal-detail-title').textContent, 'Modern Bedroom');
  const meta = byId('gal-meta').textContent;
  // The reason a gallery beats a downloads folder.
  assert.match(meta, /keep the desk/);
  // Capitalised, matching the heading. The stored value is the <select>'s slug, and the
  // panel used to print it raw — "Style: modern" under a heading saying "Modern Bedroom".
  assert.match(meta, /Modern/);
  assert.ok(!/(^|[^A-Za-z])modern([^A-Za-z]|$)/.test(meta), 'the raw slug must not survive');
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

test('a card carries no "link on" badge, because every card would have one', () => {
  // It marked the entries an agent had chosen to share. Now they all have a link, so the
  // badge said only that the gallery had tiles.
  const { document } = galleryDocument();
  const grid = document.createElement('div');
  renderGrid({ grid, doc: document, entries: [ENTRY], onOpen: () => {} });
  assert.ok(!/link on/i.test(grid.children[0].textContent));
  assert.match(grid.children[0].textContent, /Bedroom/, 'the room and date still label it');
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

test('the timestamp carries the time of day, not just the date', () => {
  // A date alone cannot separate the six renders of one listing that all happened on the
  // same Tuesday afternoon — variations, a retry, a second style — which is what a real
  // session with this product produces.
  const when = formatWhen(Date.UTC(2026, 7, 1, 15, 42));
  assert.match(when, /\d{1,2}:\d{2}/, `no clock time in ${when}`);
  assert.match(when, /2026/, 'and the date is still there');
  // Locale-formatted, so the exact string depends on the runner's zone and language —
  // asserting the digits is the part that must hold everywhere.
  assert.ok(!/Invalid/i.test(when));
});

// ---- what a render is called ----------------------------------------------------------

test('an unnamed render is called after its style and room type', () => {
  // "Luxury Bedroom" — the two things the owner actually chose, and the shortest phrase
  // that tells two renders of the same room apart.
  assert.equal(defaultName({ furnitureStyle: 'luxury', roomType: 'Bedroom' }), 'Luxury Bedroom');
  assert.equal(defaultName({ furnitureStyle: 'midcentury', roomType: 'Living room' }), 'Midcentury Living room');
});

test('the derived name degrades a term at a time rather than printing a gap', () => {
  assert.equal(defaultName({ furnitureStyle: '', roomType: 'Kitchen' }), 'Kitchen');
  assert.equal(defaultName({ furnitureStyle: 'coastal', roomType: '' }), 'Staged room');
  assert.equal(defaultName({}), 'Staged room');
  // The chat path stages with no room type at all, so this is a real row, not a hypothetical.
  assert.equal(defaultName({ furnitureStyle: 'custom' }), 'Staged room');
});

test("the owner's own name wins over the derived one", () => {
  assert.equal(entryName({ ...ENTRY, name: '412 Rosewood Lane' }), '412 Rosewood Lane');
  // Cleared, not renamed: '' is the reset, so the default comes back rather than a
  // render called "".
  assert.equal(entryName({ ...ENTRY, name: '' }), 'Modern Bedroom');
  assert.equal(entryName({ ...ENTRY, name: '   ' }), 'Modern Bedroom');
});

// ---- renaming --------------------------------------------------------------------------

/** Boot with one entry, open its card, and start editing the name. */
async function openRename(entry = ENTRY, rename = { status: 200, body: { success: true, name: 'Wilson viewing' } }) {
  const ctx = galleryDocument();
  const routes = fakeRoutes({ ...listing([entry]), '/api/gallery/r1': rename });
  await start({ doc: ctx.document, fetchImpl: routes });
  ctx.byId('gal-grid').children[0].fire('click');
  ctx.byId('gal-rename').fire('click');
  return { ...ctx, routes };
}

test('the rename box opens empty, with the derived name as its placeholder', async () => {
  // Seeding it with "Modern Bedroom" would make saving unchanged text convert a DERIVED
  // label into a stored one — the render would then keep that name after the default
  // changed. The placeholder says what it falls back to without claiming it is set.
  const { byId } = await openRename();
  assert.equal(byId('gal-rename-row').hidden, false);
  assert.equal(byId('gal-rename-input').value, '');
  assert.equal(byId('gal-rename-input').getAttribute('placeholder'), 'Modern Bedroom');
});

test('a render that already has a name opens with that name to edit', async () => {
  const { byId } = await openRename({ ...ENTRY, name: '412 Rosewood Lane' });
  assert.equal(byId('gal-rename-input').value, '412 Rosewood Lane');
});

test('saving repaints the heading and the card behind it', async () => {
  const { byId } = await openRename();
  byId('gal-rename-input').value = 'Wilson viewing';
  await byId('gal-rename-save').fire('click');

  assert.equal(byId('gal-detail-title').textContent, 'Wilson viewing');
  // The card carries the name too — and its alt text and aria-label are built from the
  // same string, which is why the tile is rebuilt rather than patched.
  assert.match(byId('gal-grid').children[0].textContent, /Wilson viewing/);
  assert.equal(byId('gal-rename-row').hidden, true, 'the box closes on success');
  assert.match(byId('gal-rename-status').textContent, /saved/i);
});

test('the name that lands is the SERVER\'s, not what was typed', async () => {
  // The store trims and clamps at 80. Painting the typed string would show a name the next
  // page load contradicts.
  const { byId } = await openRename(ENTRY, { status: 200, body: { success: true, name: 'Trimmed by the store' } });
  byId('gal-rename-input').value = '   Trimmed by the store   ';
  await byId('gal-rename-save').fire('click');
  assert.equal(byId('gal-detail-title').textContent, 'Trimmed by the store');
});

test('clearing the name goes back to the derived default, and says so', async () => {
  const { byId } = await openRename({ ...ENTRY, name: 'Wilson viewing' }, { status: 200, body: { success: true, name: '' } });
  byId('gal-rename-input').value = '';
  await byId('gal-rename-save').fire('click');

  assert.equal(byId('gal-detail-title').textContent, 'Modern Bedroom');
  assert.match(byId('gal-rename-status').textContent, /default/i);
});

test('Enter in the box saves, because the row is not a form', async () => {
  const { byId } = await openRename();
  byId('gal-rename-input').value = 'Wilson viewing';
  await byId('gal-rename-input').fire('keydown', { key: 'Enter', preventDefault() {} });
  assert.equal(byId('gal-detail-title').textContent, 'Wilson viewing');
});

test('a failed save keeps the box open with the text still in it', async () => {
  // Closing on failure would throw away what they typed and leave the old name on screen
  // with nothing saying the save did not happen.
  const { byId } = await openRename(ENTRY, { status: 500, body: null });
  byId('gal-rename-input').value = 'Wilson viewing';
  await byId('gal-rename-save').fire('click');

  assert.equal(byId('gal-rename-row').hidden, false, 'the box must not close on failure');
  assert.equal(byId('gal-rename-input').value, 'Wilson viewing', 'the typed name was discarded');
  assert.equal(byId('gal-detail-title').textContent, 'Modern Bedroom', 'the heading must not claim a save');
  assert.match(byId('gal-rename-status').textContent, /could not/i);
});

test('renaming sends a PATCH to the entry, not to its share', async () => {
  const { byId, routes } = await openRename();
  byId('gal-rename-input').value = 'Wilson viewing';
  await byId('gal-rename-save').fire('click');

  const patch = routes.calls.find((c) => c.method === 'PATCH');
  assert.ok(patch, 'no PATCH was sent');
  assert.equal(patch.url, '/api/gallery/r1');
});

test('cancelling leaves the name alone', async () => {
  const { byId } = await openRename();
  byId('gal-rename-input').value = 'Typed but abandoned';
  byId('gal-rename-cancel').fire('click');

  assert.equal(byId('gal-rename-row').hidden, true);
  assert.equal(byId('gal-detail-title').textContent, 'Modern Bedroom');
});

test('opening another card does not carry the last one\'s open rename box', async () => {
  const { document, byId } = galleryDocument();
  const second = { ...ENTRY, id: 'r2', roomType: 'Kitchen' };
  await start({ doc: document, fetchImpl: fakeRoutes(listing([ENTRY, second])) });

  byId('gal-grid').children[0].fire('click');
  byId('gal-rename').fire('click');
  assert.equal(byId('gal-rename-row').hidden, false);

  byId('gal-detail-close').fire('click');
  byId('gal-grid').children[1].fire('click');
  assert.equal(byId('gal-rename-row').hidden, true, 'one render\'s name box over another\'s photo');
  assert.equal(byId('gal-rename').hidden, false, 'and the trigger has to come back');
});

test('the card and its accessible name agree on what the render is called', () => {
  // A tile whose aria-label says something different from its visible text is the kind of
  // mismatch only a screen reader notices, which is why both go through entryName.
  const { document } = galleryDocument();
  const grid = document.createElement('div');
  renderGrid({ grid, doc: document, entries: [{ ...ENTRY, name: 'Wilson viewing' }], onOpen: () => {} });
  const card = grid.children[0];
  assert.match(card.textContent, /Wilson viewing/);
  assert.match(card.getAttribute('aria-label'), /Wilson viewing/);
  assert.ok(!/Modern Bedroom/.test(card.getAttribute('aria-label')), 'the default must not linger beside the name');
});
