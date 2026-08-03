// The gallery's two-step delete (public/scripts/gallery/delete-confirm.js).
//
// TWO REGRESSIONS LIVE HERE, and they are unrelated to each other except that both were
// in the same seven-line click handler:
//
//   1. IT FIRED ON THE FIRST CLICK. No confirmation, no busy state, no undo — and the
//      operation tombstones the bytes AND revokes the link the owner has already sent to
//      a client, so the person who loses something need not be the person who clicked.
//
//   2. IT RELOADED FROM PAGE ONE. `await load()` reset entries/loaded/grid, so an agent
//      who had pressed "Load more" twice lost 120 of their 180 cards, and their scroll
//      position, for deleting a single render.
//
// The second is the one a screenshot would never catch, and it is the reason `dropEntry`
// exists rather than a re-fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../../../public/scripts/gallery-app.js';
import { galleryDocument, fakeRoutes, cards } from '../../helpers/gallery-dom.js';

const PAGE_SIZE = 60;

const entry = (id, roomType = 'Bedroom') => ({
  id,
  createdAt: Date.UTC(2026, 7, 1),
  roomType,
  urls: { after: '/a.webp', before: '/b.webp', thumb: '/t.webp' },
  share: { url: `https://stagify.test/s/${id}`, viewCount: 0 },
});

const listing = (entries, extra = {}) => ({
  '/api/gallery': {
    status: 200,
    body: { entries: entries.map((e) => structuredClone(e)), total: entries.length, enabled: true, ...extra },
  },
});

/** Boot the page and open the first card, which is where the delete control lives. */
async function openFirstCard(fetchImpl) {
  const { document, byId } = galleryDocument();
  await start({ doc: document, fetchImpl });
  cards(byId)[0].fire('click');
  return { document, byId };
}

/** DELETEs counted separately from listings, since the point is often "and nothing else". */
const deletes = (fetchImpl) => fetchImpl.calls.filter((c) => c.method === 'DELETE');

// ---- the confirmation -----------------------------------------------------------------

test('the first click asks rather than deletes', async () => {
  const fetchImpl = fakeRoutes(listing([entry('r1')]));
  const { byId } = await openFirstCard(fetchImpl);

  byId('gal-delete').fire('click');

  assert.equal(deletes(fetchImpl).length, 0, 'a single click must not reach the server');
  assert.equal(byId('gal-delete-confirm').hidden, false, 'the confirmation is on screen');
  assert.equal(byId('gal-delete').hidden, true, 'and the trigger has stepped aside');
  assert.equal(byId('gal-delete').getAttribute('aria-expanded'), 'true');
});

test('focus lands on Keep it, not on the destructive button', async () => {
  // A held Enter, or a second click arriving where the first button used to be, must not
  // walk straight through the confirmation it just opened.
  const fetchImpl = fakeRoutes(listing([entry('r1')]));
  const { document, byId } = await openFirstCard(fetchImpl);

  byId('gal-delete').fire('click');
  assert.equal(document.activeElement, byId('gal-delete-cancel'));
});

test('confirming sends exactly one DELETE for the open render', async () => {
  const fetchImpl = fakeRoutes({
    ...listing([entry('r1'), entry('r2')]),
    '/api/gallery/r1': { status: 200, body: { success: true } },
  });
  const { byId } = await openFirstCard(fetchImpl);

  byId('gal-delete').fire('click');
  await byId('gal-delete-yes').fire('click');

  assert.equal(deletes(fetchImpl).length, 1);
  assert.match(deletes(fetchImpl)[0].url, /\/api\/gallery\/r1$/);
});

test('Keep it backs out and leaves the render alone', async () => {
  const fetchImpl = fakeRoutes(listing([entry('r1')]));
  const { document, byId } = await openFirstCard(fetchImpl);

  byId('gal-delete').fire('click');
  byId('gal-delete-cancel').fire('click');

  assert.equal(deletes(fetchImpl).length, 0);
  assert.equal(byId('gal-delete-confirm').hidden, true);
  assert.equal(byId('gal-delete').hidden, false);
  assert.equal(byId('gal-delete').getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, byId('gal-delete'), 'focus comes back to the trigger');
});

test('a double click while the request is in flight still sends one DELETE', async () => {
  // The second would 404 against the render the first just removed, and report a failure
  // for an operation that actually succeeded.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const fetchImpl = Object.assign(async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    if ((init.method ?? 'GET') === 'DELETE') {
      await gate;
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }
    return { ok: true, status: 200, json: async () => ({ entries: [entry('r1')], total: 1, enabled: true }) };
  }, { calls });

  const { byId } = await openFirstCard(fetchImpl);
  byId('gal-delete').fire('click');
  const first = byId('gal-delete-yes').fire('click');
  const second = byId('gal-delete-yes').fire('click');
  release();
  await Promise.all([first, second]);

  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 1);
});

test('a failed delete keeps the panel open and says so', async () => {
  // The render is still there. Closing would leave the owner with no way back to the
  // thing they were trying to remove.
  const fetchImpl = fakeRoutes({
    ...listing([entry('r1')]),
    '/api/gallery/r1': { status: 500, body: { error: 'nope' } },
  });
  const { byId } = await openFirstCard(fetchImpl);

  byId('gal-delete').fire('click');
  await byId('gal-delete-yes').fire('click');

  assert.equal(byId('gal-detail').hidden, false, 'the panel stays open');
  assert.match(byId('gal-delete-status').textContent, /Could not delete/);
  assert.equal(byId('gal-delete-yes').disabled, false, 'and the buttons are usable again');
  assert.equal(cards(byId).length, 1, 'the card is still there');
});

test('opening another card never shows an armed confirmation', async () => {
  const fetchImpl = fakeRoutes(listing([entry('r1'), entry('r2')]));
  const { byId } = await openFirstCard(fetchImpl);

  byId('gal-delete').fire('click');
  assert.equal(byId('gal-delete-confirm').hidden, false);

  byId('gal-detail-close').fire('click');
  cards(byId)[1].fire('click');

  assert.equal(byId('gal-delete-confirm').hidden, true, 'an armed confirm must not carry over');
  assert.equal(byId('gal-delete').hidden, false);
});

// ---- the pager regression ---------------------------------------------------------------

test('deleting one render does NOT throw away the pages already loaded', async () => {
  // THE REGRESSION. 120 of 200 on screen; deleting one must leave 119 — not 60, and not
  // a fresh request for page one.
  const calls = [];
  const fetchImpl = Object.assign(async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url: String(url), method });
    if (method === 'DELETE') return { ok: true, status: 200, json: async () => ({ success: true }) };
    const offset = Number(new URL(String(url), 'https://stagify.test').searchParams.get('offset') ?? 0);
    const n = Math.max(0, Math.min(PAGE_SIZE, 200 - offset));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        entries: Array.from({ length: n }, (_, i) => entry(`r${offset + i}`, `Room ${offset + i}`)),
        total: 200,
        enabled: true,
      }),
    };
  }, { calls });

  const { document, byId } = galleryDocument();
  await start({ doc: document, fetchImpl });
  await byId('gal-more').fire('click');
  assert.equal(cards(byId).length, 120, 'precondition: two pages are loaded');

  const listingsBefore = calls.filter((c) => c.method === 'GET').length;
  cards(byId)[0].fire('click');
  byId('gal-delete').fire('click');
  await byId('gal-delete-yes').fire('click');

  assert.equal(cards(byId).length, 119, 'the other 119 cards must survive');
  assert.equal(
    calls.filter((c) => c.method === 'GET').length,
    listingsBefore,
    'and it must not re-fetch — that is what reset the pager to page one',
  );
  assert.equal(byId('gal-count').textContent, 'Showing 119 of 199 staged rooms');
  assert.equal(byId('gal-more').hidden, false, 'there are still 80 more to reach');
});

test('the deleted render is the one that goes', async () => {
  const fetchImpl = fakeRoutes({
    ...listing([entry('r1', 'Bedroom'), entry('r2', 'Kitchen'), entry('r3', 'Study')]),
    '/api/gallery/r2': { status: 200, body: { success: true } },
  });
  const { document, byId } = galleryDocument();
  await start({ doc: document, fetchImpl });

  cards(byId)[1].fire('click');
  byId('gal-delete').fire('click');
  await byId('gal-delete-yes').fire('click');

  const labels = cards(byId).map((c) => c.getAttribute('aria-label'));
  assert.equal(labels.length, 2);
  assert.ok(labels.every((l) => !/Kitchen/.test(l)), `Kitchen survived: ${labels.join(' | ')}`);
  assert.ok(labels.some((l) => /Bedroom/.test(l)) && labels.some((l) => /Study/.test(l)));
});

test('deleting the last render lands on empty, not on a grid of nothing', async () => {
  const fetchImpl = fakeRoutes({
    ...listing([entry('r1')]),
    '/api/gallery/r1': { status: 200, body: { success: true } },
  });
  const { document, byId } = await openFirstCard(fetchImpl);

  byId('gal-delete').fire('click');
  await byId('gal-delete-yes').fire('click');

  assert.equal(document.body.getAttribute('data-state'), 'empty');
});

test('deleting the last MATCH says nothing matched, not nothing staged', async () => {
  // "Your gallery is empty" is a different and much more alarming claim than "no results
  // for bedroom", and the account still has every other render.
  const fetchImpl = fakeRoutes({
    ...listing([entry('r1')], { search: { enabled: true, q: 'bedroom' } }),
    '/api/gallery/r1': { status: 200, body: { success: true } },
  });
  const { document, byId } = galleryDocument();
  await start({ doc: document, fetchImpl, searchDelayMs: 0 });

  byId('gal-search-input').value = 'bedroom';
  await byId('gal-search').fire('submit', { preventDefault() {} });

  cards(byId)[0].fire('click');
  byId('gal-delete').fire('click');
  await byId('gal-delete-yes').fire('click');

  assert.equal(document.body.getAttribute('data-state'), 'no-results');
});

// ---- keyboard -------------------------------------------------------------------------

test('Escape backs out of the confirmation before it closes the panel', async () => {
  // Innermost first. The key that means "I did not mean that" must not also throw away
  // the render they were looking at.
  const fetchImpl = fakeRoutes(listing([entry('r1')]));
  const { document, byId } = await openFirstCard(fetchImpl);

  byId('gal-delete').fire('click');
  document.fire('keydown', { key: 'Escape' });

  assert.equal(byId('gal-delete-confirm').hidden, true, 'the confirmation closed');
  assert.equal(byId('gal-detail').hidden, false, 'and the panel did NOT');
  assert.equal(document.activeElement, byId('gal-delete'));

  document.fire('keydown', { key: 'Escape' });
  assert.equal(byId('gal-detail').hidden, true, 'a second press closes the panel');
});

test('the confirm buttons join the Tab cycle only while they are on screen', async () => {
  // `hidden` on the row does not set `.hidden` on the buttons inside it, so membership
  // is decided by the island rather than by a per-node filter — otherwise Tab would land
  // on a button that is not being displayed.
  const fetchImpl = fakeRoutes(listing([entry('r1')]));
  const { document, byId } = await openFirstCard(fetchImpl);

  const cycle = () => {
    const seen = [];
    byId('gal-detail-close').focus();
    for (let i = 0; i < 12; i += 1) {
      document.fire('keydown', { key: 'Tab', preventDefault() {} });
      const at = document.activeElement;
      if (seen.includes(at)) break;
      seen.push(at);
    }
    return seen;
  };

  assert.ok(!cycle().includes(byId('gal-delete-yes')), 'closed: the confirm button is not reachable');

  byId('gal-delete').fire('click');
  const armed = cycle();
  assert.ok(armed.includes(byId('gal-delete-yes')), 'armed: it is');
  assert.ok(armed.includes(byId('gal-delete-cancel')));
  assert.ok(!armed.includes(byId('gal-delete')), 'and the hidden trigger has left the cycle');
});
