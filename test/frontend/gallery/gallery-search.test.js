// Searching the gallery (Stagify+).
//
// WHAT THIS COVERS
// Three properties, none of which a screenshot would catch:
//
//   1. THE BOX IS REVEALED BY THE SERVER. `search.enabled` on the listing is the same
//      answer that decides whether `?q=` is honoured, so a page that read the plan off
//      window.StagifyAuth could offer a filter the server would then ignore.
//   2. FILTERING IS A REQUEST, NOT A CLIENT-SIDE PASS. The route pages at 60 while the Pro
//      cap is 200, so a search applied to the loaded array would quietly only ever look at
//      the first screenful and report "no matches" for renders that exist.
//   3. NO MATCHES IS ITS OWN STATE. Landing a search on the empty state tells an agent who
//      has staged two hundred rooms that they have staged none — and hides the box that
//      would let them undo it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../../../public/scripts/gallery-app.js';
import { galleryDocument } from '../../helpers/gallery-dom.js';

const ROOMS = [
  { id: 'r1', roomType: 'Bedroom', furnitureStyle: 'luxury' },
  { id: 'r2', roomType: 'Kitchen', furnitureStyle: 'coastal' },
  { id: 'r3', roomType: 'Bedroom', furnitureStyle: 'coastal', name: '412 Rosewood Lane' },
];

const entryFor = (room) => ({
  createdAt: Date.UTC(2026, 7, 1),
  name: '',
  additionalPrompt: '',
  urls: { after: '/a.webp', before: '/b.webp', thumb: '/t.webp' },
  references: [],
  share: { url: 'https://stagify.test/s/TOKEN', viewCount: 0 },
  ...room,
});

/**
 * A server that filters the way routes/gallery.js does — every term must appear somewhere
 * in the row, and `total` is the MATCHING count rather than the size of the gallery.
 *
 * @param {{ pro?: boolean, rooms?: any[], pageSize?: number }} [arg]
 */
function searchServer({ pro = true, rooms = ROOMS, pageSize = 60 } = {}) {
  const calls = [];
  const impl = async (url) => {
    const params = new URL(String(url), 'https://stagify.test').searchParams;
    const q = pro ? (params.get('q') ?? '') : '';
    const offset = Number(params.get('offset') ?? 0);
    calls.push({ q, offset });

    const terms = q.trim().split(/\s+/).filter(Boolean);
    const matches = rooms.filter((room) => {
      const hay = `${room.name ?? ''} ${room.furnitureStyle ?? ''} ${room.roomType ?? ''}`.toLowerCase();
      return terms.every((term) => hay.includes(term.toLowerCase()));
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        entries: matches.slice(offset, offset + pageSize).map(entryFor),
        total: matches.length,
        enabled: true,
        search: { enabled: pro, q },
      }),
    };
  };
  return Object.assign(impl, { calls });
}

/** Boot with searching instant, so a spec can await a query rather than sleep through one. */
async function boot(server = searchServer()) {
  const ctx = galleryDocument();
  const state = await start({ doc: ctx.document, fetchImpl: server, searchDelayMs: 0 });
  return { ...ctx, server, state };
}

/** Type into the box and submit, which is the deterministic half of the debounce. */
const searchFor = (ctx, text) => {
  ctx.byId('gal-search-input').value = text;
  return ctx.byId('gal-search').fire('submit', { preventDefault() {} });
};

const roomsOn = (ctx) => ctx.byId('gal-grid').children.map((card) => card.textContent);

// ---- the Stagify+ gate ----------------------------------------------------------------

test('a Stagify+ listing switches the search box on', async () => {
  const ctx = await boot();
  assert.equal(ctx.body.getAttribute('data-gal-search'), 'on');
});

test('a free listing leaves it off, and the CSS is what hides it', async () => {
  // The attribute is the whole gate on the client. Asserting it rather than a class keeps
  // this testable against the document stand-in, which has no classList — and it is the
  // form the stylesheet already selects on.
  const ctx = await boot(searchServer({ pro: false }));
  assert.equal(ctx.body.getAttribute('data-gal-search'), 'off');
});

test('the box is revealed by the SERVER, not by a plan read on the client', async () => {
  // Same page, same code, opposite answer — nothing here consults window.StagifyAuth.
  const pro = await boot(searchServer({ pro: true }));
  const free = await boot(searchServer({ pro: false }));
  assert.notEqual(pro.body.getAttribute('data-gal-search'), free.body.getAttribute('data-gal-search'));
});

test('a free account carrying a query is put back to the whole gallery', async () => {
  // Reachable by typing ?q= into the URL bar. The server returns everything, so the page
  // must stop claiming it is showing matches rather than label the full list as results.
  const ctx = await boot(searchServer({ pro: false }));
  await searchFor(ctx, 'kitchen');

  assert.equal(ctx.byId('gal-grid').children.length, 3, 'the query must not have been applied');
  assert.match(ctx.byId('gal-count').textContent, /3 staged rooms/, 'counted as matches, not as the gallery');
  assert.equal(ctx.byId('gal-search-input').value, '', 'the box must not keep a query that did nothing');
});

// ---- searching -------------------------------------------------------------------------

test('a query narrows the grid and the count', async () => {
  const ctx = await boot();
  assert.equal(ctx.byId('gal-grid').children.length, 3);

  await searchFor(ctx, 'kitchen');
  assert.equal(ctx.byId('gal-grid').children.length, 1);
  assert.match(roomsOn(ctx)[0], /Coastal Kitchen/);
  assert.match(ctx.byId('gal-count').textContent, /1 match$/, 'counted as matches, not as staged rooms');
});

test('the query goes to the SERVER, so it searches more than the loaded page', async () => {
  // The route pages at 60 and the Pro cap is 200. A filter over the loaded array would
  // report "no matches" for renders that exist but are not on screen yet.
  const ctx = await boot();
  await searchFor(ctx, 'kitchen');
  assert.deepEqual(ctx.server.calls.at(-1), { q: 'kitchen', offset: 0 });
});

test('a search always restarts at the first page', async () => {
  // Carrying the previous offset would open a search part-way into results it has not
  // shown, with a pager that could never reach the top of them.
  const ctx = await boot(searchServer({ pageSize: 2 }));
  await ctx.byId('gal-more').fire('click');
  assert.equal(ctx.server.calls.at(-1).offset, 2, 'fixture check: the pager moved off page one');

  await searchFor(ctx, 'bedroom');
  assert.equal(ctx.server.calls.at(-1).offset, 0);
});

test('several terms narrow further, in any order', async () => {
  const ctx = await boot();
  await searchFor(ctx, 'coastal bedroom');
  assert.equal(ctx.byId('gal-grid').children.length, 1);
  assert.match(roomsOn(ctx)[0], /412 Rosewood Lane/, 'the named render is still matched on its metadata');
});

test("a render's own name is searchable", async () => {
  const ctx = await boot();
  await searchFor(ctx, 'rosewood');
  assert.equal(ctx.byId('gal-grid').children.length, 1);
  assert.match(roomsOn(ctx)[0], /412 Rosewood Lane/);
});

test('the derived default name is searchable too', async () => {
  // The card reads "Luxury Bedroom" for a render with no name of its own. Typing what is
  // on the card has to find it, or the box feels broken.
  const ctx = await boot();
  await searchFor(ctx, 'luxury bedroom');
  assert.equal(ctx.byId('gal-grid').children.length, 1);
  assert.match(roomsOn(ctx)[0], /Luxury Bedroom/);
});

// ---- no matches --------------------------------------------------------------------------

test('a search that matches nothing is NOT the empty state', async () => {
  const ctx = await boot();
  const state = await searchFor(ctx, 'conservatory');

  assert.equal(state, 'no-results');
  assert.equal(ctx.body.getAttribute('data-state'), 'no-results',
    'an agent with three rooms must not be told they have none');
});

test('the no-matches panel names what was searched for', async () => {
  const ctx = await boot();
  await searchFor(ctx, 'conservatory');
  assert.match(ctx.byId('gal-no-results-detail').textContent, /conservatory/);
});

test('an account with nothing staged is still the EMPTY state, not no-matches', async () => {
  const ctx = await boot(searchServer({ rooms: [] }));
  assert.equal(ctx.state, 'empty');
  assert.equal(ctx.body.getAttribute('data-state'), 'empty');
});

test('clearing from the no-matches panel brings the whole gallery back', async () => {
  const ctx = await boot();
  await searchFor(ctx, 'conservatory');
  assert.equal(ctx.body.getAttribute('data-state'), 'no-results');

  const state = await ctx.byId('gal-search-reset').fire('click');
  assert.equal(state, 'ready');
  assert.equal(ctx.byId('gal-grid').children.length, 3);
  assert.equal(ctx.byId('gal-search-input').value, '', 'the box still held the query that emptied the page');
});

// ---- the box itself ----------------------------------------------------------------------

test('the clear button appears with the text and goes away with it', async () => {
  const ctx = await boot();
  assert.equal(ctx.byId('gal-search-clear').hidden, true, 'nothing to clear yet');

  ctx.byId('gal-search-input').value = 'kitchen';
  ctx.byId('gal-search-input').fire('input');
  assert.equal(ctx.byId('gal-search-clear').hidden, false, 'it belongs to the BOX, not to the request');

  await ctx.byId('gal-search-clear').fire('click');
  assert.equal(ctx.byId('gal-search-clear').hidden, true);
});

test('clearing the box reloads the full gallery', async () => {
  const ctx = await boot();
  await searchFor(ctx, 'kitchen');
  assert.equal(ctx.byId('gal-grid').children.length, 1);

  await ctx.byId('gal-search-clear').fire('click');
  assert.equal(ctx.byId('gal-grid').children.length, 3);
  assert.deepEqual(ctx.server.calls.at(-1), { q: '', offset: 0 });
  assert.match(ctx.byId('gal-count').textContent, /3 staged rooms/, 'back to counting rooms, not matches');
});

test('clearing puts focus back in the box so the next query can just be typed', async () => {
  const ctx = await boot();
  await searchFor(ctx, 'kitchen');
  await ctx.byId('gal-search-clear').fire('click');
  assert.equal(ctx.document.activeElement, ctx.byId('gal-search-input'));
});

test('re-running the query already on screen costs no request', async () => {
  // The limiter allows 120 requests per 15 minutes. Backspacing to where you were, or
  // pressing Enter twice, must not spend one.
  const ctx = await boot();
  await searchFor(ctx, 'kitchen');
  const spent = ctx.server.calls.length;

  await searchFor(ctx, 'kitchen');
  await searchFor(ctx, '  kitchen  ');
  assert.equal(ctx.server.calls.length, spent, 'an unchanged query was re-sent');
});

test('trailing spaces are not a different search', async () => {
  const ctx = await boot();
  await searchFor(ctx, '  kitchen ');
  assert.equal(ctx.server.calls.at(-1).q, 'kitchen');
});

// ---- the debounce ------------------------------------------------------------------------

const tick = (ms = 0) => new Promise((resolve) => { setTimeout(resolve, ms); });

test('typing collapses into ONE request rather than one per keystroke', async () => {
  // Sized against the limiter rather than against feel: a request per keystroke would
  // exhaust an agent's whole 15-minute window inside a single query and answer 429 to
  // their next page load.
  const ctx = await boot();
  const before = ctx.server.calls.length;

  const input = ctx.byId('gal-search-input');
  for (const value of ['k', 'ki', 'kit', 'kitc', 'kitch', 'kitche', 'kitchen']) {
    input.value = value;
    input.fire('input');
  }
  await tick();
  await tick();

  assert.equal(ctx.server.calls.length - before, 1, 'one request per pause, not per keystroke');
  assert.equal(ctx.server.calls.at(-1).q, 'kitchen', 'and it is the FINAL text, not the first');
});

test('a submit cancels the pending debounce instead of searching twice', async () => {
  const ctx = await boot();
  const before = ctx.server.calls.length;

  const input = ctx.byId('gal-search-input');
  input.value = 'kitchen';
  input.fire('input');
  await searchFor(ctx, 'kitchen');
  await tick();
  await tick();

  assert.equal(ctx.server.calls.length - before, 1);
});

test('an overtaken response does not paint over a newer query', async () => {
  // Two searches can be in flight at once: a slow "bed" overtaken by a fast "bedroom". The
  // slow one lands last, and without a sequence check it would paint results for a query
  // the box no longer holds.
  const ctx = galleryDocument();
  /** @type {((v: any) => void)[]} */
  const held = [];
  let holdNext = false;
  const base = searchServer();
  const impl = async (url) => {
    const res = await base(url);
    if (!holdNext) return res;
    holdNext = false;
    // Park this response until the test releases it.
    await new Promise((resolve) => { held.push(resolve); });
    return res;
  };
  await start({ doc: ctx.document, fetchImpl: Object.assign(impl, { calls: base.calls }), searchDelayMs: 0 });

  holdNext = true;
  ctx.byId('gal-search-input').value = 'bedroom';
  const slow = ctx.byId('gal-search').fire('submit', { preventDefault() {} });

  ctx.byId('gal-search-input').value = 'kitchen';
  await ctx.byId('gal-search').fire('submit', { preventDefault() {} });
  assert.equal(ctx.byId('gal-grid').children.length, 1);
  assert.match(ctx.byId('gal-grid').children[0].textContent, /Kitchen/);

  held.forEach((release) => release());
  assert.equal(await slow, 'stale', 'the overtaken request must report itself stale');
  assert.match(ctx.byId('gal-grid').children[0].textContent, /Kitchen/, 'the older response repainted the grid');
  assert.equal(ctx.byId('gal-search-input').value, 'kitchen');
});
