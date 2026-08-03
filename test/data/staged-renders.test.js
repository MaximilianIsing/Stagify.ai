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

test('a pro account is capped far higher, not never', () => {
  // Stagify+ is sold as unlimited STAGING, which it is. The gallery keeps 200 finished
  // renders, which is what stops per-account storage growing forever. Well past the free
  // cap, so nothing a free user would notice applies here.
  assert.ok(PRO_GALLERY_LIMIT > FREE_GALLERY_LIMIT * 5, 'the two tiers must not be close');
  const { renders, user } = setup();
  for (let i = 0; i < FREE_GALLERY_LIMIT + 15; i += 1) addRender(renders, user.id, { at: 1_000 + i, isPro: true });
  assert.equal(renders.countForUser(user.id), FREE_GALLERY_LIMIT + 15, 'nowhere near the pro cap');
});

test('the pro cap DOES evict once it is reached', () => {
  // The whole point of capping it: unbounded per-account storage was the one safeguard
  // the plan left unbuilt. Driven at a lowered cap so the test does not have to create
  // two hundred rows.
  const { renders, user } = setup();
  const cap = 5;
  const ids = [];
  for (let i = 0; i < cap; i += 1) ids.push(addRender(renders, user.id, { at: 1_000 + i, isPro: true }).id);
  // enforceCap goes through the same evictBeyondCap path record() uses.
  const evicted = renders.enforceCap({ userId: user.id, isPro: true, now: 9_000, cap });
  assert.deepEqual(evicted, [], 'exactly at the cap loses nothing');

  addRender(renders, user.id, { at: 9_100, isPro: true });
  const over = renders.enforceCap({ userId: user.id, isPro: true, now: 9_200, cap });
  assert.equal(over.length, 1, 'one over the cap evicts one');
  assert.equal(over[0].id, ids[0], 'and it is the oldest');
});

test('capFor reports the tier ceilings', () => {
  assert.equal(capFor(true), PRO_GALLERY_LIMIT);
  assert.equal(capFor(false), FREE_GALLERY_LIMIT);
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
