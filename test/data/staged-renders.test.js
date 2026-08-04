// lib/data/staged-renders.js — the gallery's rows, and the cap that is the paywall.
//
// The eviction matrix below is the point of this file. "Free keeps your last N" is a
// billing boundary, so it has to be exact under every shape of over-cap: at the cap,
// one over, many over, and the case that actually bites — a lapsed Pro account arriving
// with hundreds. A cap that can be raced, or that only ever removes one row, is not a
// cap; it is a suggestion that happens to hold in the tests.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuthStore } from '../../lib/data/auth-store.js';
import { getDb, closeDb } from '../../lib/data/db.js';
import {
  createStagedRenders, FREE_GALLERY_LIMIT, PRO_GALLERY_LIMIT, DOWNGRADE_GRACE_MS, capFor, MAX_RENDER_NAME,
  searchTerms, MAX_SEARCH_TERMS, MAX_SEARCH_QUERY,
} from '../../lib/data/staged-renders.js';
import { keyForRender, newRenderId } from '../../lib/data/object-keys.js';

const dirs = [];
const stores = [];

afterEach(() => {
  while (stores.length) { try { stores.pop().close(); } catch { /* already closed */ } }
  while (dirs.length) {
    const d = dirs.pop();
    try { closeDb(d); } catch { /* not open */ }
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ }
  }
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-renders-'));
  dirs.push(dir);
  const authStore = createAuthStore(dir);
  stores.push(authStore);
  const renders = createStagedRenders(dir);
  const start = authStore.startRegistration('seller@example.com', 'CorrectHorse9!');
  const { user } = authStore.completeRegistration('seller@example.com', start.code);
  return { dir, db: getDb(dir), authStore, renders, user };
}

/** Add one finished entry, `n` milliseconds into the fixture's timeline. */
function addRender(renders, userId, { at = 1_000, isPro = false, roomType = 'Bedroom' } = {}) {
  const id = newRenderId();
  const res = renders.record({
    render: { id, userId, roomType, furnitureStyle: 'modern', model: 'gemini' },
    blobs: [
      { role: 'after', storageKey: keyForRender({ renderId: id, role: 'after' }), bytes: 110_000 },
      { role: 'thumb', storageKey: keyForRender({ renderId: id, role: 'thumb' }), bytes: 21_000 },
    ],
    isPro,
    now: at,
  });
  renders.markOk(id, { width: 1024, height: 683 });
  return { id, ...res };
}

function tombstoned(db) {
  return db.prepare('SELECT storage_key FROM blob_tombstones').all().map((r) => r.storage_key);
}

// ---- the basics -------------------------------------------------------------------

test('a recorded render is pending until its bytes land', () => {
  const { renders, user } = setup();
  const id = newRenderId();
  renders.record({ render: { id, userId: user.id }, blobs: [], isPro: true });

  assert.equal(renders.get(id).status, 'pending');
  assert.deepEqual(renders.listForUser({ userId: user.id }), [], 'pending rows are not in the gallery');

  renders.markOk(id, { width: 1024, height: 683 });
  assert.equal(renders.listForUser({ userId: user.id }).length, 1);
  assert.equal(renders.get(id).width, 1024);
});

test('a failed render never appears, so a dead upload is absent rather than broken', () => {
  const { renders, user } = setup();
  const id = newRenderId();
  renders.record({ render: { id, userId: user.id }, blobs: [], isPro: true });
  renders.markFailed(id);
  assert.deepEqual(renders.listForUser({ userId: user.id }), []);
});

test('the prompt and settings are kept, which is what the gallery is for', () => {
  const { renders, user } = setup();
  const id = newRenderId();
  renders.record({
    render: {
      id, userId: user.id, roomType: 'Dorm', furnitureStyle: 'coastal',
      additionalPrompt: 'keep the desk', removeFurniture: true, model: 'gemini-3.1-flash-image',
    },
    isPro: true,
  });
  renders.markOk(id);
  const row = renders.listForUser({ userId: user.id })[0];
  assert.equal(row.room_type, 'Dorm');
  assert.equal(row.furniture_style, 'coastal');
  assert.equal(row.additional_prompt, 'keep the desk');
  assert.equal(row.remove_furniture, 1);
  assert.equal(row.model, 'gemini-3.1-flash-image');
});

// ---- the owner's own name ----------------------------------------------------------
//
// A render starts unnamed and the PAGE derives `<Style> <Room type>` from the two columns
// above. So the only thing stored here is a name somebody typed, and NULL has to keep
// meaning "unnamed" — a rename that wrote '' would freeze every reset render into a row
// the gallery then labels with an empty string.

test('a render starts with no name of its own', () => {
  const { renders, user } = setup();
  const { id } = addRender(renders, user.id);
  assert.equal(renders.get(id).custom_name, null, 'the default is derived, never stored');
});

test('naming a render keeps what was typed', () => {
  const { renders, user } = setup();
  const { id } = addRender(renders, user.id);

  const res = renders.rename({ id, userId: user.id, name: '412 Rosewood Lane' });
  assert.deepEqual(res, { ok: true, name: '412 Rosewood Lane' });
  assert.equal(renders.get(id).custom_name, '412 Rosewood Lane');
  assert.equal(renders.listForUser({ userId: user.id })[0].custom_name, '412 Rosewood Lane');
});

test('an empty name is a RESET, not a render called ""', () => {
  const { renders, user } = setup();
  const { id } = addRender(renders, user.id);
  renders.rename({ id, userId: user.id, name: 'Wilson viewing' });

  for (const blank of ['', '   ', '\t\n']) {
    renders.rename({ id, userId: user.id, name: 'Wilson viewing' });
    const res = renders.rename({ id, userId: user.id, name: blank });
    assert.deepEqual(res, { ok: true, name: '' }, `${JSON.stringify(blank)} should clear it`);
    assert.equal(renders.get(id).custom_name, null, `${JSON.stringify(blank)} stored a blank instead of NULL`);
  }
});

test('a name is trimmed, collapsed and stripped of control characters', () => {
  // It goes into the grid, the dialog heading and a card's aria-label. A newline or a bidi
  // override in any of those is a display bug at best.
  const { renders, user } = setup();
  const { id } = addRender(renders, user.id);

  const { name } = renders.rename({ id, userId: user.id, name: '  412  Rosewood\nLane‮  ' });
  assert.equal(name, '412 Rosewood Lane');
  assert.equal(renders.get(id).custom_name, '412 Rosewood Lane');
});

test('a name is clamped at MAX_RENDER_NAME, by code point', () => {
  // `.slice()` would cut an astral character between its surrogates and store half of it.
  const { renders, user } = setup();
  const { id } = addRender(renders, user.id);

  const long = `${'a'.repeat(MAX_RENDER_NAME - 1)}🏠 and a great deal more text`;
  const { name } = renders.rename({ id, userId: user.id, name: long });
  assert.equal([...name].length, MAX_RENDER_NAME);
  assert.ok(name.endsWith('🏠'), 'the last code point was split');
  assert.equal([...renders.get(id).custom_name].length, MAX_RENDER_NAME);
});

test('a non-string name clears rather than storing "[object Object]"', () => {
  const { renders, user } = setup();
  const { id } = addRender(renders, user.id);
  renders.rename({ id, userId: user.id, name: 'Wilson viewing' });

  for (const junk of [null, undefined, 42, {}, ['a']]) {
    assert.equal(renders.rename({ id, userId: user.id, name: junk }).name, '');
    assert.equal(renders.get(id).custom_name, null);
    renders.rename({ id, userId: user.id, name: 'Wilson viewing' });
  }
});

test("one account cannot name another's render", () => {
  // `user_id` is in the UPDATE's WHERE, so there is no check-then-write to disagree with.
  const { renders, user } = setup();
  const { id } = addRender(renders, user.id);

  const res = renders.rename({ id, userId: 'someone-else', name: 'Mine now' });
  assert.equal(res.ok, false, 'reported a write that did not happen');
  assert.equal(renders.get(id).custom_name, null, 'a stranger renamed a render');
});

test('renaming a render that does not exist reports it rather than throwing', () => {
  const { renders, user } = setup();
  assert.equal(renders.rename({ id: newRenderId(), userId: user.id, name: 'Ghost' }).ok, false);
});

test('an evicted render cannot be renamed', () => {
  // It is gone from the gallery, so a successful rename would report a write against a row
  // nothing can show.
  const { renders, user } = setup();
  const { id } = addRender(renders, user.id);
  assert.equal(renders.remove({ id, userId: user.id }), true);

  assert.equal(renders.rename({ id, userId: user.id, name: 'Too late' }).ok, false);
  assert.equal(renders.get(id).custom_name, null);
});

test('the name survives a reopen of the store', () => {
  // The guarded ALTER runs on every open. A second open must not lose the column or the
  // rows in it — which is the failure mode `ensureColumn`'s PRAGMA check exists to avoid.
  const { dir, renders, user } = setup();
  const { id } = addRender(renders, user.id);
  renders.rename({ id, userId: user.id, name: '412 Rosewood Lane' });

  const reopened = createStagedRenders(dir);
  assert.equal(reopened.get(id).custom_name, '412 Rosewood Lane');
});

// ---- search --------------------------------------------------------------------------
//
// Searching is the Stagify+ half of the gallery, and it runs in SQL rather than over the
// loaded page: the route pages at 60 while the Pro cap is 200, so a filter applied in the
// browser would quietly only ever look at the first screenful.

/** Add one finished render with searchable fields set. */
function addSearchable(renders, userId, fields, at = 1_000) {
  const id = newRenderId();
  renders.record({ render: { id, userId, ...fields }, isPro: true, now: at });
  renders.markOk(id);
  return id;
}

const namesOf = (renders, userId, q) => renders
  .listForUser({ userId, q })
  .map((r) => r.custom_name ?? `${r.furniture_style} ${r.room_type}`);

test('a term matches the room type, the style, the name or the prompt', () => {
  const { renders, user } = setup();
  addSearchable(renders, user.id, { roomType: 'Bedroom', furnitureStyle: 'luxury' }, 1_000);
  addSearchable(renders, user.id, { roomType: 'Kitchen', furnitureStyle: 'coastal' }, 2_000);
  const named = addSearchable(renders, user.id, { roomType: 'Office', furnitureStyle: 'modern' }, 3_000);
  renders.rename({ id: named, userId: user.id, name: '412 Rosewood Lane' });
  const prompted = addSearchable(renders, user.id, { roomType: 'Bathroom', additionalPrompt: 'keep the skylight' }, 4_000);

  assert.deepEqual(namesOf(renders, user.id, 'kitchen'), ['coastal Kitchen']);
  assert.deepEqual(namesOf(renders, user.id, 'luxury'), ['luxury Bedroom']);
  assert.deepEqual(namesOf(renders, user.id, 'rosewood'), ['412 Rosewood Lane']);
  assert.deepEqual(renders.listForUser({ userId: user.id, q: 'skylight' }).map((r) => r.id), [prompted]);
});

test('the DERIVED default name is searchable, which a per-column match would not be', () => {
  // The card for an unnamed render reads "Luxury Bedroom". Neither column contains that
  // string, so matching the whole phrase against each one in turn finds nothing — and
  // typing what is on the card and getting no results is what makes a search feel broken.
  const { renders, user } = setup();
  addSearchable(renders, user.id, { roomType: 'Bedroom', furnitureStyle: 'luxury' });
  addSearchable(renders, user.id, { roomType: 'Bedroom', furnitureStyle: 'coastal' });

  assert.deepEqual(namesOf(renders, user.id, 'luxury bedroom'), ['luxury Bedroom']);
  // Every term has to land, so the second render is excluded rather than matched on
  // "bedroom" alone.
  assert.equal(renders.countForUser(user.id, { q: 'luxury bedroom' }), 1);
});

test('terms are ANDed, and their order does not matter', () => {
  const { renders, user } = setup();
  addSearchable(renders, user.id, { roomType: 'Bedroom', furnitureStyle: 'luxury' });

  assert.equal(renders.countForUser(user.id, { q: 'bedroom luxury' }), 1, 'order must not matter');
  assert.equal(renders.countForUser(user.id, { q: 'lux bed' }), 1, 'partial words still match');
  assert.equal(renders.countForUser(user.id, { q: 'luxury kitchen' }), 0, 'one missing term excludes the row');
});

test('matching ignores ASCII case', () => {
  const { renders, user } = setup();
  addSearchable(renders, user.id, { roomType: 'Bedroom', furnitureStyle: 'luxury' });
  for (const q of ['BEDROOM', 'BeDrOoM', 'bedroom']) {
    assert.equal(renders.countForUser(user.id, { q }), 1, q);
  }
});

test('LIKE wildcards in the query are literal, not a match-everything', () => {
  // Unescaped, `%` matches every row and `_` matches any character — so a user typing
  // punctuation would silently get the wrong set rather than no set.
  const { renders, user } = setup();
  const pct = addSearchable(renders, user.id, { roomType: 'Office', additionalPrompt: '100% linen' }, 1_000);
  addSearchable(renders, user.id, { roomType: 'Bedroom', furnitureStyle: 'luxury' }, 2_000);

  // `%` finds the row that literally CONTAINS a percent sign, and only that one. Two
  // matches here would mean the wildcard leaked through and matched everything.
  assert.deepEqual(renders.listForUser({ userId: user.id, q: '%' }).map((r) => r.id), [pct]);
  assert.deepEqual(renders.listForUser({ userId: user.id, q: '100%' }).map((r) => r.id), [pct]);
  assert.equal(renders.countForUser(user.id, { q: 'b_droom' }), 0, '_ matched any character');
  assert.equal(renders.countForUser(user.id, { q: '\\' }), 0, 'a lone backslash must not break the pattern');
});

test('an empty or blank query is not a search at all', () => {
  const { renders, user } = setup();
  addSearchable(renders, user.id, { roomType: 'Bedroom' }, 1_000);
  addSearchable(renders, user.id, { roomType: 'Kitchen' }, 2_000);

  for (const q of ['', '   ', undefined, null, 42]) {
    assert.equal(renders.listForUser({ userId: user.id, q }).length, 2, `${JSON.stringify(q)} narrowed the list`);
    assert.equal(renders.countForUser(user.id, { q }), 2);
  }
});

test('search respects tenancy, so it cannot read across accounts', () => {
  const { renders, user } = setup();
  addSearchable(renders, user.id, { roomType: 'Bedroom', furnitureStyle: 'luxury' });
  addSearchable(renders, 'someone-else', { roomType: 'Bedroom', furnitureStyle: 'luxury' });

  assert.equal(renders.countForUser(user.id, { q: 'bedroom' }), 1);
  assert.equal(renders.countForUser('someone-else', { q: 'bedroom' }), 1);
});

test('search sees neither evicted nor unfinished renders', () => {
  // The same two predicates the plain listing uses. A search that surfaced a render the
  // grid cannot show would be a result you can never open.
  const { renders, user } = setup();
  const gone = addSearchable(renders, user.id, { roomType: 'Bedroom', furnitureStyle: 'luxury' }, 1_000);
  renders.remove({ id: gone, userId: user.id });
  const pendingId = newRenderId();
  renders.record({ render: { id: pendingId, userId: user.id, roomType: 'Bedroom', furnitureStyle: 'luxury' }, isPro: true });

  assert.equal(renders.countForUser(user.id, { q: 'bedroom' }), 0);
  assert.deepEqual(renders.listForUser({ userId: user.id, q: 'bedroom' }), []);
});

test('search pages, and its count is the MATCHING total', () => {
  // The count sits above the grid. Printing the account's whole total over a filtered grid
  // would be the page contradicting itself.
  const { renders, user } = setup();
  for (let i = 0; i < 5; i += 1) addSearchable(renders, user.id, { roomType: 'Bedroom', furnitureStyle: 'luxury' }, 1_000 + i);
  addSearchable(renders, user.id, { roomType: 'Kitchen', furnitureStyle: 'coastal' }, 9_000);

  assert.equal(renders.countForUser(user.id), 6, 'the unfiltered total');
  assert.equal(renders.countForUser(user.id, { q: 'bedroom' }), 5);
  assert.equal(renders.listForUser({ userId: user.id, q: 'bedroom', limit: 2 }).length, 2);
  assert.equal(renders.listForUser({ userId: user.id, q: 'bedroom', limit: 2, offset: 4 }).length, 1);
  // Newest first, exactly as the unfiltered listing orders.
  const page = renders.listForUser({ userId: user.id, q: 'bedroom', limit: 5 });
  assert.deepEqual([...page].sort((a, b) => b.created_at - a.created_at).map((r) => r.id), page.map((r) => r.id));
});

test('a query past the term cap still searches, on the terms it kept', () => {
  // The WHERE grows one LIKE per term, so an unbounded query is an unbounded statement
  // built from user input. Terms past the cap are dropped, never the whole search.
  const { renders, user } = setup();
  addSearchable(renders, user.id, { roomType: 'Bedroom', furnitureStyle: 'luxury' });

  assert.equal(searchTerms('a b c d e f g h i j k').length, MAX_SEARCH_TERMS);
  const many = `luxury ${Array.from({ length: 20 }, (_, i) => `t${i}`).join(' ')}`;
  assert.equal(searchTerms(many).length, MAX_SEARCH_TERMS);
  assert.doesNotThrow(() => renders.countForUser(user.id, { q: many }));
});

test('a query past the length cap is truncated rather than refused', () => {
  const { renders, user } = setup();
  addSearchable(renders, user.id, { roomType: 'Bedroom', furnitureStyle: 'luxury' });
  assert.equal(searchTerms('x'.repeat(MAX_SEARCH_QUERY + 40))[0].length, MAX_SEARCH_QUERY);
  assert.equal(renders.countForUser(user.id, { q: 'x'.repeat(MAX_SEARCH_QUERY + 40) }), 0);
});

// ---- the eviction matrix ----------------------------------------------------------

test('a free account exactly at the cap loses nothing', () => {
  const { renders, user } = setup();
  for (let i = 0; i < FREE_GALLERY_LIMIT; i += 1) addRender(renders, user.id, { at: 1_000 + i });
  assert.equal(renders.countForUser(user.id), FREE_GALLERY_LIMIT);
});

test('one over the cap evicts exactly the oldest one', () => {
  const { renders, user } = setup();
  const ids = [];
  for (let i = 0; i < FREE_GALLERY_LIMIT; i += 1) ids.push(addRender(renders, user.id, { at: 1_000 + i }).id);
  const last = addRender(renders, user.id, { at: 9_000 });

  assert.deepEqual(last.evicted.map((e) => e.id), [ids[0]], 'the oldest goes');
  assert.equal(renders.countForUser(user.id), FREE_GALLERY_LIMIT);
  assert.equal(renders.get(ids[0]).evicted_at, 9_000, 'soft delete — the row stays so the UI can say what went');
});

test('an account far over the cap converges in ONE pass', () => {
  // The reason the query is `LIMIT -1 OFFSET cap` and not "delete one when count = cap+1".
  // A lapsed Pro account arrives hundreds over; evicting one per insert would never
  // catch up, and the user would sit permanently over their limit.
  const { renders, user } = setup();
  for (let i = 0; i < FREE_GALLERY_LIMIT + 30; i += 1) addRender(renders, user.id, { at: 1_000 + i, isPro: true });
  assert.equal(renders.countForUser(user.id), FREE_GALLERY_LIMIT + 30, 'well under the pro cap');

  const evicted = renders.enforceCap({ userId: user.id, isPro: false, now: 50_000 });
  assert.equal(evicted.length, 30);
  assert.equal(renders.countForUser(user.id), FREE_GALLERY_LIMIT);
});

test('eviction tombstones exactly the evicted entry\'s bytes', () => {
  const { db, renders, user } = setup();
  const ids = [];
  for (let i = 0; i < FREE_GALLERY_LIMIT; i += 1) ids.push(addRender(renders, user.id, { at: 1_000 + i }).id);
  addRender(renders, user.id, { at: 9_000 });

  const queued = tombstoned(db);
  assert.deepEqual(queued.sort(), [
    keyForRender({ renderId: ids[0], role: 'after' }),
    keyForRender({ renderId: ids[0], role: 'thumb' }),
  ].sort());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM render_blobs WHERE render_id = ?').get(ids[0]).n, 0);
  // ...and nothing else was queued.
  assert.equal(queued.length, 2);
});

test('a shared entry evicts LAST, so the link the agent just sent keeps working', () => {
  const { db, renders, user } = setup();
  const ids = [];
  for (let i = 0; i < FREE_GALLERY_LIMIT; i += 1) ids.push(addRender(renders, user.id, { at: 1_000 + i }).id);
  // Share the OLDEST — the one that would otherwise fall off next.
  db.prepare(`INSERT INTO gallery_shares (token_hash, render_id, user_id, created_at) VALUES (?, ?, ?, ?)`)
    .run('sha256$deadbeef', ids[0], user.id, 1_000);

  const res = addRender(renders, user.id, { at: 9_000 });
  assert.deepEqual(res.evicted.map((e) => e.id), [ids[1]], 'the shared oldest is protected; the next one goes');
  assert.equal(renders.get(ids[0]).evicted_at, null);
});

test('a shared entry still COUNTS against the cap', () => {
  // Otherwise a free user grows their gallery without limit by sharing everything.
  const { db, renders, user } = setup();
  const ids = [];
  for (let i = 0; i < FREE_GALLERY_LIMIT; i += 1) {
    const { id } = addRender(renders, user.id, { at: 1_000 + i });
    ids.push(id);
    db.prepare('INSERT INTO gallery_shares (token_hash, render_id, user_id, created_at) VALUES (?, ?, ?, ?)')
      .run(`sha256$${id}`, id, user.id, 1_000);
  }
  const res = addRender(renders, user.id, { at: 9_000 });
  assert.equal(res.evicted.length, 1, 'every entry is shared, so one must still go');
  assert.equal(renders.countForUser(user.id), FREE_GALLERY_LIMIT);
});

test('evicting a shared entry revokes its link in the same transaction', () => {
  // A live link pointing at bytes that are about to be tombstoned would 404 with no
  // explanation. Revoking makes it the SAME uniform 404 as a deliberate revoke — correct,
  // but it must not be silent, which is why `hadLiveShare` comes back to the caller.
  const { db, renders, user } = setup();
  const ids = [];
  for (let i = 0; i < FREE_GALLERY_LIMIT; i += 1) {
    const { id } = addRender(renders, user.id, { at: 1_000 + i });
    ids.push(id);
    db.prepare('INSERT INTO gallery_shares (token_hash, render_id, user_id, created_at) VALUES (?, ?, ?, ?)')
      .run(`sha256$${id}`, id, user.id, 1_000);
  }
  const res = addRender(renders, user.id, { at: 9_000 });

  assert.equal(res.evicted[0].hadLiveShare, true, 'the caller can tell the user their link stopped working');
  const share = db.prepare('SELECT revoked_at FROM gallery_shares WHERE render_id = ?').get(res.evicted[0].id);
  assert.equal(share.revoked_at, 9_000);
});

test('a pro gallery is never evicted from, at any size', () => {
  // Stagify+ keeps every finished render — the compare table on stagify-plus.html says
  // "Unlimited" and this is the assertion behind that word.
  //
  // The count deliberately runs well past the FREE cap rather than past some pro figure,
  // because there is no pro figure to run past: what is being asserted is that no number
  // of renders reaches a ceiling. A test that stopped at 199 would have passed against
  // the old 200 too, and would therefore have proved nothing about this change.
  assert.equal(PRO_GALLERY_LIMIT, Infinity, 'the paid gallery has no ceiling');
  const { renders, user } = setup();
  const ids = [];
  for (let i = 0; i < FREE_GALLERY_LIMIT * 4; i += 1) {
    const res = addRender(renders, user.id, { at: 1_000 + i, isPro: true });
    ids.push(res.id);
    assert.deepEqual(res.evicted, [], `insert ${i} evicted something from an uncapped gallery`);
  }
  assert.equal(renders.countForUser(user.id), FREE_GALLERY_LIMIT * 4);
  // The FIRST render — the one any finite cap would have taken first — is still there.
  assert.equal(renders.get(ids[0]).evicted_at, null, 'the oldest entry survives');
});

test('enforceCap on a pro account is a no-op however much history it has', () => {
  // The other entry point. A grace window closing calls this directly, and a pro account
  // that lapsed and then RESUBSCRIBED inside the window would go through it as pro.
  const { renders, user } = setup();
  for (let i = 0; i < FREE_GALLERY_LIMIT + 40; i += 1) addRender(renders, user.id, { at: 1_000 + i, isPro: true });

  assert.deepEqual(renders.enforceCap({ userId: user.id, isPro: true, now: 9_000 }), []);
  assert.equal(renders.countForUser(user.id), FREE_GALLERY_LIMIT + 40);
});

test('an explicit cap still evicts — the operator override has to work', () => {
  // PRO_GALLERY_LIMIT is env-overridable precisely so a ceiling can be re-imposed without
  // a deploy if one account's history ever threatens the storage bill. That path shares
  // evictBeyondCap with the free tier, and this is what keeps it exercised now that no
  // default sends a pro account through it. Driven at a lowered cap so the test does not
  // have to create hundreds of rows.
  const { renders, user } = setup();
  const cap = 5;
  const ids = [];
  for (let i = 0; i < cap; i += 1) ids.push(addRender(renders, user.id, { at: 1_000 + i, isPro: true }).id);
  const evicted = renders.enforceCap({ userId: user.id, isPro: true, now: 9_000, cap });
  assert.deepEqual(evicted, [], 'exactly at the cap loses nothing');

  addRender(renders, user.id, { at: 9_100, isPro: true });
  const over = renders.enforceCap({ userId: user.id, isPro: true, now: 9_200, cap });
  assert.equal(over.length, 1, 'one over the cap evicts one');
  assert.equal(over[0].id, ids[0], 'and it is the oldest');
});

test('capFor reports the tier ceilings', () => {
  assert.equal(capFor(true), PRO_GALLERY_LIMIT);
  assert.equal(capFor(true), Infinity, 'Stagify+ is uncapped');
  assert.equal(capFor(false), FREE_GALLERY_LIMIT);
  assert.ok(Number.isFinite(capFor(false)), 'the free tier is still capped');
});

test('one account\'s cap never touches another\'s entries', () => {
  const { dir, renders, user, authStore } = setup();
  const start = authStore.startRegistration('other@example.com', 'CorrectHorse9!');
  const other = authStore.completeRegistration('other@example.com', start.code).user;
  void dir;

  for (let i = 0; i < FREE_GALLERY_LIMIT + 5; i += 1) addRender(renders, other.id, { at: 1_000 + i, isPro: true });
  for (let i = 0; i < FREE_GALLERY_LIMIT + 5; i += 1) addRender(renders, user.id, { at: 1_000 + i });

  assert.equal(renders.countForUser(user.id), FREE_GALLERY_LIMIT);
  assert.equal(renders.countForUser(other.id), FREE_GALLERY_LIMIT + 5);
});

// ---- the downgrade grace window ---------------------------------------------------

test('the grace window suppresses eviction ENTIRELY, not per row', () => {
  // Evicting 480 entries on a lapsed subscriber's next render is brutal, silent, and
  // lands at the worst moment. During the window the cap simply does not apply.
  const { renders, user } = setup();
  for (let i = 0; i < FREE_GALLERY_LIMIT + 40; i += 1) addRender(renders, user.id, { at: 1_000 + i, isPro: true });

  renders.startGrace(user.id, 10_000);
  assert.equal(renders.isInGrace(user.id, 10_000), true);

  const res = addRender(renders, user.id, { at: 11_000, isPro: false });
  assert.deepEqual(res.evicted, [], 'nothing is evicted while the window is open');
  assert.equal(renders.countForUser(user.id), FREE_GALLERY_LIMIT + 41);
});

test('when the grace window expires the cap applies in one pass', () => {
  const { renders, user } = setup();
  for (let i = 0; i < FREE_GALLERY_LIMIT + 40; i += 1) addRender(renders, user.id, { at: 1_000 + i, isPro: true });
  renders.startGrace(user.id, 10_000);

  const after = 10_000 + DOWNGRADE_GRACE_MS + 1;
  assert.equal(renders.isInGrace(user.id, after), false);
  const evicted = renders.enforceCap({ userId: user.id, isPro: false, now: after });
  assert.equal(evicted.length, 40, 'everything past the cap, in one pass');
  assert.equal(renders.countForUser(user.id), FREE_GALLERY_LIMIT);
});

test('the render being inserted is never its own eviction victim', () => {
  // Regression. With share-protection sorting shared entries ahead of everything else,
  // a free account whose entries were ALL shared inserted a new render and the new
  // render — the generation the user had just spent — was what fell off the end.
  const { renders, user, db } = setup();
  const ids = [];
  for (let i = 0; i < FREE_GALLERY_LIMIT; i += 1) {
    const { id } = addRender(renders, user.id, { at: 1_000 + i });
    ids.push(id);
    db.prepare('INSERT INTO gallery_shares (token_hash, render_id, user_id, created_at) VALUES (?, ?, ?, ?)')
      .run(`sha256$${id}`, id, user.id, 1_000);
  }
  const fresh = addRender(renders, user.id, { at: 9_000 });

  assert.ok(!fresh.evicted.some((e) => e.id === fresh.id), 'the new render must survive its own insert');
  assert.equal(renders.get(fresh.id).evicted_at, null);
  assert.ok(renders.listForUser({ userId: user.id }).some((r) => r.id === fresh.id));
});

// ---- explicit delete, and the stale sweep -----------------------------------------

test('a user can delete one entry, and it is the HARD revoke', () => {
  const { db, renders, user } = setup();
  const { id } = addRender(renders, user.id, { isPro: true });
  db.prepare('INSERT INTO gallery_shares (token_hash, render_id, user_id, created_at) VALUES (?, ?, ?, ?)')
    .run('sha256$x', id, user.id, 1_000);

  assert.equal(renders.remove({ id, userId: user.id, now: 5_000 }), true);
  // Tombstoning the bytes is what makes an outstanding presigned URL start 404ing;
  // revoking a share only stops NEW URLs being minted.
  assert.equal(tombstoned(db).length, 2);
  assert.equal(db.prepare('SELECT revoked_at FROM gallery_shares WHERE render_id = ?').get(id).revoked_at, 5_000);
  assert.deepEqual(renders.listForUser({ userId: user.id }), []);
});

test('deleting somebody else\'s entry does nothing at all', () => {
  // Ownership is keyed on the validated session id inside the WHERE, never on a body.
  const { db, renders, user, authStore } = setup();
  const start = authStore.startRegistration('other@example.com', 'CorrectHorse9!');
  const other = authStore.completeRegistration('other@example.com', start.code).user;
  const { id } = addRender(renders, user.id, { isPro: true });

  assert.equal(renders.remove({ id, userId: other.id }), false);
  assert.equal(renders.listForUser({ userId: user.id }).length, 1);
  assert.equal(tombstoned(db).length, 0, 'a refused delete must not queue anything');
});

test('a render stuck mid-upload is swept, and whatever landed is queued', () => {
  const { db, renders, user } = setup();
  const id = newRenderId();
  renders.record({
    render: { id, userId: user.id },
    blobs: [{ role: 'after', storageKey: keyForRender({ renderId: id, role: 'after' }), bytes: 1 }],
    isPro: true,
    now: 1_000,
  });

  assert.equal(renders.sweepStalePending({ now: 1_000 + 60_000 }), 0, 'an hour has not passed');
  assert.equal(renders.sweepStalePending({ now: 1_000 + 2 * 60 * 60 * 1000 }), 1);
  assert.equal(renders.get(id).status, 'failed');
  assert.equal(tombstoned(db).length, 1, 'bytes that did land are not orphaned');
});

test('the sweep is measured against the row, not process uptime', () => {
  // A restart in the middle of a sweep must not be able to mark a live render failed.
  const { renders, user } = setup();
  const id = newRenderId();
  renders.record({ render: { id, userId: user.id }, isPro: true, now: 1_000_000 });
  assert.equal(renders.sweepStalePending({ now: 1_000_500 }), 0);
  assert.equal(renders.get(id).status, 'pending');
});

// ── replaceResult: refining a render in place ────────────────────────────────
//
// The Masking Studio's "Looks Good" lands here when the photo it was given came out of the
// gallery. NOTHING ABOUT THE ENTRY MAY CHANGE except the pixels — see the method's own
// header for the full list, each item of which is asserted below.

test('replaceResult swaps the bytes and the dimensions, and nothing else', () => {
  const { renders, user } = setup();
  const { id } = addRender(renders, user.id, { at: 1_000, isPro: true });
  renders.rename({ id, userId: user.id, name: '412 Rosewood Lane' });
  const before = renders.get(id);

  const ok = renders.replaceResult({
    id,
    userId: user.id,
    width: 1920,
    height: 1080,
    blobs: [{ role: 'after', storageKey: keyForRender({ renderId: id, role: 'after' }), bytes: 90_000 }],
  });

  assert.equal(ok, true);
  const after = renders.get(id);
  assert.equal(after.width, 1920, 'the composite can differ in size from the original render');
  assert.equal(after.height, 1080);
  assert.equal(after.created_at, before.created_at, 'a refine must not jump the render to the top');
  assert.equal(after.custom_name, '412 Rosewood Lane', 'if they named it, it keeps its name');
  assert.equal(after.status, 'ok');
  assert.equal(after.extra_json, before.extra_json,
    'a refined INTERIOR render stays "Luxury Bedroom", never "Masking Studio — 3 areas"');
  assert.equal(
    renders.blobsFor(id).find((b) => b.role === 'after').bytes, 90_000,
    'byte accounting follows the bytes, or usage drifts on every refine',
  );
});

test("replaceResult refuses another account's render", () => {
  // Ownership is in the WHERE, never a check-then-write. A guessed id must change nothing.
  const { renders, user } = setup();
  const { id } = addRender(renders, user.id, { isPro: true });
  assert.equal(renders.replaceResult({ id, userId: 'u_someone_else', width: 1, height: 1 }), false);
  assert.equal(renders.get(id).width, 1024, 'untouched');
});

test('replaceResult refuses a render that is still uploading its first bytes', () => {
  // Its uploadInBackground is in flight and would markOk over the replacement moments later.
  const { renders, user } = setup();
  const id = newRenderId();
  renders.record({ render: { id, userId: user.id }, isPro: true, now: 1_000 });
  assert.equal(renders.get(id).status, 'pending');
  assert.equal(renders.replaceResult({ id, userId: user.id, width: 1, height: 1 }), false);
});

test('replaceResult cannot resurrect an evicted row', () => {
  const { renders, user } = setup();
  const { id } = addRender(renders, user.id, { isPro: false });
  for (let i = 0; i < FREE_GALLERY_LIMIT + 1; i++) addRender(renders, user.id, { at: 2_000 + i, isPro: false });
  assert.ok(renders.get(id).evicted_at, 'the cap took it');
  assert.equal(renders.replaceResult({ id, userId: user.id, width: 1, height: 1 }), false);
});

test('replaceResult refuses a render that does not exist', () => {
  const { renders, user } = setup();
  assert.equal(renders.replaceResult({ id: newRenderId(), userId: user.id, width: 1, height: 1 }), false);
});

test('replaceResult never runs eviction — no row was added', () => {
  // Running the cap here would delete somebody's oldest render as a side effect of an edit.
  const { renders, user } = setup();
  const ids = [];
  for (let i = 0; i < FREE_GALLERY_LIMIT; i++) ids.push(addRender(renders, user.id, { at: 1_000 + i }).id);
  const countBefore = renders.countForUser(user.id);
  renders.replaceResult({ id: ids[ids.length - 1], userId: user.id, width: 800, height: 600 });
  assert.equal(renders.countForUser(user.id), countBefore, 'a full gallery stays exactly as full');
  assert.ok(!renders.get(ids[0]).evicted_at, 'and the oldest entry survives');
});

// ── the naming payload is searchable ─────────────────────────────────────────

test('a render is findable by its stored qualifier and its source filename', () => {
  // The card reads "Exterior — Golden hour · 412-rosewood-front". Typing what is on the
  // card and getting no results is the failure that makes a search box feel broken, and
  // neither term is in any of the columns the haystack used to cover.
  const { renders, user } = setup();
  const id = newRenderId();
  renders.record({
    render: {
      id,
      userId: user.id,
      roomType: 'Exterior',
      extra: { source: 'exterior', qualifier: 'Golden hour', sourceName: '412-rosewood-front' },
    },
    isPro: true,
    now: 1_000,
  });
  renders.markOk(id, { width: 1, height: 1 });

  assert.equal(renders.countForUser(user.id, { q: 'Golden hour' }), 1, 'by the qualifier');
  assert.equal(renders.countForUser(user.id, { q: 'rosewood' }), 1, 'by the source photo');
  assert.equal(renders.countForUser(user.id, { q: 'exterior' }), 1, 'and by the studio that made it');
  assert.equal(renders.countForUser(user.id, { q: 'nothing-like-this' }), 0);
});

test('a damaged extra_json cannot break the listing or the search', () => {
  // json_extract would RAISE on this, 500-ing a whole page of the gallery over one row.
  // A LIKE against the raw text has no error mode at all, which is why it is a LIKE.
  const { renders, db, user } = setup();
  const { id } = addRender(renders, user.id, { isPro: true });
  db.prepare('UPDATE staged_renders SET extra_json = ? WHERE id = ?').run('{not json', id);
  assert.doesNotThrow(() => renders.listForUser({ userId: user.id, limit: 10, offset: 0 }));
  assert.doesNotThrow(() => renders.countForUser(user.id, { q: 'bedroom' }));
});
