// Expired presigned URLs, and the grid's recovery from them.
//
// THE BUG THIS PINS
// The listing's image URLs are presigned with a 15-minute TTL. thumb, after and before are
// signed in the SAME response at the same instant, so they age out together — which means
// the card's thumb→after fallback could never rescue an expiry: it swapped to a URL that
// was equally dead. Every tile became a transparent pixel with a `--missing` class, so a
// tab left open over lunch showed a gallery of blank rooms and looked like data loss.
//
// public/scripts/share/refresh.js already solved this for the public share page and was
// never wired to the owner's gallery. These specs are about that wiring: ONE re-fetch for
// a burst of broken tiles, every loaded page re-fetched rather than just the first, the
// open panel repainted without stealing focus, and a bounded number of attempts.
//
// `refreshDelayMs: 0` drives the debounce to nothing; the awaits after firing are what let
// the scheduled work run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../../../public/scripts/gallery-app.js';
import { MAX_ATTEMPTS } from '../../../public/scripts/share/refresh.js';
import { galleryDocument, cards } from '../../helpers/gallery-dom.js';

const PAGE_SIZE = 60;

/**
 * Let the debounced refresh and everything it awaits drain.
 *
 * A real setTimeout, so microtask ticks are not enough: the debounce is a macrotask, and
 * the work behind it is a chain of awaited fetches (up to one per loaded page). Several
 * turns, because `refetchLoaded` walks pages sequentially.
 */
const settle = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const entry = (id, sig) => ({
  id,
  createdAt: Date.UTC(2026, 7, 1),
  roomType: `Room ${id}`,
  urls: { after: `/a-${id}.webp?sig=${sig}`, before: `/b-${id}.webp?sig=${sig}`, thumb: `/t-${id}.webp?sig=${sig}` },
  share: { url: `https://stagify.test/s/${id}`, viewCount: 0 },
});

/**
 * A listing whose presigned URLs change every time it is asked — `sig=1` on the first
 * response, `sig=2` on the second. That is what makes "the tiles were re-pointed at fresh
 * URLs" observable rather than merely "a request went out".
 */
function expiringServer({ total = 2, pageSize = PAGE_SIZE, fail = false } = {}) {
  const calls = [];
  let generation = 0;
  const impl = async (url) => {
    const offset = Number(new URL(String(url), 'https://stagify.test').searchParams.get('offset') ?? 0);
    // One generation per FIRST page, so both pages of a re-fetch share a signature.
    if (offset === 0) generation += 1;
    calls.push(offset);
    if (fail && generation > 1) return { ok: false, status: 500, json: async () => null };
    const n = Math.max(0, Math.min(pageSize, total - offset));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        entries: Array.from({ length: n }, (_, i) => entry(`r${offset + i}`, generation)),
        total,
        enabled: true,
      }),
    };
  };
  return Object.assign(impl, { calls, generation: () => generation });
}

const srcOf = (card) => card.children.find((c) => c.tagName === 'IMG')?.getAttribute('src');
const imgsIn = (node) => node.descendants().filter((n) => n.tagName === 'IMG');

// ---- the debounce -----------------------------------------------------------------------

test('a burst of broken tiles causes ONE re-fetch, not one per tile', async () => {
  // The failure mode being avoided is a broken manifest turning twenty dead images into
  // twenty manifest requests — against a limiter that allows 120 per 15 minutes.
  const { document, byId } = galleryDocument();
  const fetchImpl = expiringServer({ total: 20 });
  await start({ doc: document, fetchImpl, refreshDelayMs: 0 });
  assert.equal(fetchImpl.calls.length, 1, 'precondition: one listing so far');

  for (const card of cards(byId)) {
    card.children.find((c) => c.tagName === 'IMG').fire('error');
  }
  await settle();

  assert.equal(fetchImpl.calls.length, 2, `20 broken tiles must produce 1 re-fetch, saw ${fetchImpl.calls.length - 1}`);
});

test('the re-fetch re-points the tiles at fresh URLs', async () => {
  const { document, byId } = galleryDocument();
  const fetchImpl = expiringServer({ total: 3 });
  await start({ doc: document, fetchImpl, refreshDelayMs: 0 });

  const before = cards(byId).map(srcOf);
  assert.ok(before.every((s) => s.includes('sig=1')), `expected the first generation, got ${before.join(' ')}`);

  cards(byId)[0].children.find((c) => c.tagName === 'IMG').fire('error');
  await settle();

  const after = cards(byId).map(srcOf);
  assert.ok(after.every((s) => s.includes('sig=2')), `tiles were not re-minted: ${after.join(' ')}`);
  assert.equal(after.length, 3, 'and the grid is still the same size');
});

// ---- the pager interaction ---------------------------------------------------------------

test('every loaded page is re-fetched, not just the first', async () => {
  // A plain reload would drop pages two and three. The reader did not ask for anything —
  // their gallery must not silently shrink while they are looking at it.
  const { document, byId } = galleryDocument();
  const fetchImpl = expiringServer({ total: 200 });
  await start({ doc: document, fetchImpl, refreshDelayMs: 0 });
  await byId('gal-more').fire('click');
  assert.deepEqual(fetchImpl.calls, [0, 60], 'precondition: two pages loaded');
  assert.equal(cards(byId).length, 120);

  cards(byId)[0].children.find((c) => c.tagName === 'IMG').fire('error');
  await settle();

  assert.deepEqual(fetchImpl.calls, [0, 60, 0, 60], 'the refresh must walk back to what was on screen');
  assert.equal(cards(byId).length, 120, 'and end with the same 120 cards');
  assert.equal(byId('gal-count').textContent, 'Showing 120 of 200 staged rooms');
});

// ---- the open panel ------------------------------------------------------------------------

test('the open comparison gets fresh URLs without stealing focus', async () => {
  // A re-mint the reader never asked for must not move their focus. openDetail() would
  // send it to the close button, which is why the panel is repainted rather than reopened.
  const { document, byId } = galleryDocument();
  const fetchImpl = expiringServer({ total: 2 });
  await start({ doc: document, fetchImpl, refreshDelayMs: 0 });

  cards(byId)[0].fire('click');
  byId('gal-share-copy').focus();
  assert.ok(imgsIn(byId('gal-compare')).every((i) => i.getAttribute('src').includes('sig=1')));

  imgsIn(byId('gal-compare'))[0].fire('error');
  await settle();

  const panelImgs = imgsIn(byId('gal-compare'));
  assert.ok(panelImgs.length >= 2, 'before and after are both present');
  assert.ok(
    panelImgs.every((i) => i.getAttribute('src').includes('sig=2')),
    `the panel kept dead URLs: ${panelImgs.map((i) => i.getAttribute('src')).join(' ')}`,
  );
  assert.equal(document.activeElement, byId('gal-share-copy'), 'focus must not have moved');
  assert.equal(byId('gal-detail').hidden, false, 'and the panel is still open');
});

test('the panel images are watched too, not only the grid', async () => {
  // The compare view is where a reader lingers, so it is the most likely place to be
  // holding an expired URL — and its images are built by a different function.
  const { document, byId } = galleryDocument();
  const fetchImpl = expiringServer({ total: 2 });
  await start({ doc: document, fetchImpl, refreshDelayMs: 0 });
  cards(byId)[0].fire('click');

  const calls = fetchImpl.calls.length;
  imgsIn(byId('gal-compare'))[0].fire('error');
  await settle();

  assert.equal(fetchImpl.calls.length, calls + 1, 'a broken panel image must trigger the refresh');
});

// ---- the budget ------------------------------------------------------------------------------

test('a manifest that stays broken stops re-fetching', async () => {
  // Otherwise a genuinely dead gallery is an infinite request loop against the limiter.
  const { document, byId } = galleryDocument();
  const fetchImpl = expiringServer({ total: 3, fail: true });
  await start({ doc: document, fetchImpl, refreshDelayMs: 0 });

  const img = () => cards(byId)[0]?.children.find((c) => c.tagName === 'IMG');
  for (let i = 0; i < MAX_ATTEMPTS + 3; i += 1) {
    const node = img();
    if (!node) break;
    node.fire('error');
    await settle();
  }

  assert.equal(
    fetchImpl.calls.length, 1 + MAX_ATTEMPTS,
    `expected the initial listing plus ${MAX_ATTEMPTS} attempts, saw ${fetchImpl.calls.length}`,
  );
});

test('a successful re-mint restores the budget', async () => {
  // An image can expire twice in a long-lived tab, and the second time must be recoverable
  // — the handlers are attached without `once` for the same reason.
  const { document, byId } = galleryDocument();
  const fetchImpl = expiringServer({ total: 2 });
  await start({ doc: document, fetchImpl, refreshDelayMs: 0 });

  for (let round = 0; round < MAX_ATTEMPTS + 2; round += 1) {
    cards(byId)[0].children.find((c) => c.tagName === 'IMG').fire('error');
    await settle();
    assert.equal(
      fetchImpl.calls.length, round + 2,
      `round ${round + 1}: a successful refresh must not consume the budget`,
    );
  }
});
