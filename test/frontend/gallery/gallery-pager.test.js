// The count line has to be backed by the grid underneath it.
//
// WHAT THIS COVERS
// routes/gallery.js pages at PAGE_SIZE = 60 while lib/data/staged-renders.js caps a Pro
// account at PRO_GALLERY_LIMIT = 200. The page printed `total` and rendered one page, so
// a heavy user read "200 staged rooms" above exactly 60 cards and had no way to reach
// the other 140 — the number was not merely unhelpful, it contradicted what was on
// screen and implied the rest had been lost.
//
// The regression guarded here is the bare total: whenever fewer rooms are shown than
// exist, the line must say so, and the pager must be able to close the gap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../../../public/scripts/gallery-app.js';
import { galleryDocument, cards } from '../../helpers/gallery-dom.js';

const PAGE_SIZE = 60;

/**
 * `n` entries numbered from `from`. The room type carries the number too, because it is
 * what reaches the card's aria-label — identical labels would make "the second page is
 * really different rooms" unprovable.
 */
const page = (n, from = 0) => Array.from({ length: n }, (_, i) => ({
  id: `r${from + i}`,
  createdAt: Date.UTC(2026, 7, 1),
  roomType: `Room ${from + i}`,
  urls: { after: '/a.webp', before: '/b.webp', thumb: '/t.webp' },
  share: { active: false },
}));

/** A server that pages at PAGE_SIZE, honouring ?offset= the way routes/gallery.js does. */
function pagingServer({ total, pageSize = PAGE_SIZE }) {
  const calls = [];
  const impl = async (url) => {
    const offset = Number(new URL(String(url), 'https://stagify.test').searchParams.get('offset') ?? 0);
    calls.push(offset);
    const n = Math.max(0, Math.min(pageSize, total - offset));
    return { ok: true, status: 200, json: async () => ({ entries: page(n, offset), total, enabled: true }) };
  };
  return Object.assign(impl, { calls });
}

test('a partial gallery names both numbers instead of only the larger one', async () => {
  const { document, byId } = galleryDocument();
  await start({ doc: document, fetchImpl: pagingServer({ total: 200 }) });

  assert.equal(byId('gal-count').textContent, 'Showing 60 of 200 staged rooms');
  assert.equal(cards(byId).length, 60);
  assert.equal(byId('gal-more').hidden, false, 'there are 140 more rooms and no way to them');
});

test('the pager appends the next page rather than replacing the first', async () => {
  // Replacing would leave the count honest and the grid useless — you would page
  // forward and watch the rooms you already had disappear.
  const { document, byId } = galleryDocument();
  const fetchImpl = pagingServer({ total: 200 });
  await start({ doc: document, fetchImpl });

  await byId('gal-more').fire('click');

  assert.deepEqual(fetchImpl.calls, [0, 60], 'the second request must ask for the next offset');
  assert.equal(cards(byId).length, 120);
  assert.equal(byId('gal-count').textContent, 'Showing 120 of 200 staged rooms');

  // 120 DISTINCT rooms. An append that re-served page one would still show 120 cards.
  const labels = cards(byId).map((c) => c.getAttribute('aria-label'));
  assert.equal(new Set(labels).size, 120, 'the appended page repeated rooms already on screen');
  assert.match(labels[119], /Room 119/);
});

test('once everything is on screen the pager goes away and the count drops the prefix', async () => {
  // 100, so the second page (40) exhausts it — the count and the button have to flip
  // together on the request that finishes, not one page early or late.
  const { document, byId } = galleryDocument();
  await start({ doc: document, fetchImpl: pagingServer({ total: 100 }) });
  assert.equal(byId('gal-more').hidden, false, 'still 40 to go');

  await byId('gal-more').fire('click');
  assert.equal(byId('gal-more').hidden, true);
  assert.equal(cards(byId).length, 100);
  assert.equal(byId('gal-count').textContent, '100 staged rooms');
});

test('a gallery that fits on one page never offers the pager at all', async () => {
  const { document, byId } = galleryDocument();
  await start({ doc: document, fetchImpl: pagingServer({ total: 3 }) });

  assert.equal(byId('gal-count').textContent, '3 staged rooms');
  assert.equal(byId('gal-more').hidden, true);
});

test('one room is still described in the singular', async () => {
  const { document, byId } = galleryDocument();
  await start({ doc: document, fetchImpl: pagingServer({ total: 1 }) });

  assert.equal(byId('gal-count').textContent, '1 staged room');
});

test('a page that comes back empty retires the pager instead of looping forever', async () => {
  // A total that outruns what the server will actually serve — an entry deleted between
  // two requests does this. Without the entries-length guard the button stays live and
  // every press re-asks the same offset for nothing.
  const { document, byId } = galleryDocument();
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    const offset = Number(new URL(String(url), 'https://stagify.test').searchParams.get('offset') ?? 0);
    return {
      ok: true,
      status: 200,
      json: async () => ({ entries: offset === 0 ? page(60) : [], total: 200, enabled: true }),
    };
  };

  await start({ doc: document, fetchImpl });
  assert.equal(byId('gal-more').hidden, false);

  await byId('gal-more').fire('click');
  assert.equal(calls, 2);
  assert.equal(byId('gal-more').hidden, true, 'a button that can never finish is worse than none');
  assert.equal(cards(byId).length, 60);
});

test('the pager button lives outside the grid, where it cannot be counted as a card', async () => {
  // #gal-grid.children is how the specs — and renderGrid's append — count rooms.
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../../../public/gallery.html', import.meta.url), 'utf8'));
  const grid = src.slice(src.indexOf('id="gal-grid"'));
  const closes = grid.indexOf('</div>');
  assert.ok(closes !== -1);
  assert.ok(!grid.slice(0, closes).includes('gal-more'), 'the pager must not be inside #gal-grid');
});
