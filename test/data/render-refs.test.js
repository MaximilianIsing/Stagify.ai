// lib/data/render-refs.js — content-addressed furniture reference photos.
//
// Two properties matter here and neither is obvious from the happy path. Dedupe has to
// be per USER (so no cross-account inference is possible, and so erasure is an
// unconditional delete), and the lifetime of a reference object has to be DERIVED
// rather than counted — a denormalized ref_count whose decrement runs twice deletes
// bytes a live gallery entry still points at, and that is a broken image forever.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuthStore } from '../../lib/data/auth-store.js';
import { getDb, closeDb } from '../../lib/data/db.js';
import { createRenderRefs, MAX_REFS_PER_RENDER } from '../../lib/data/render-refs.js';
import { createStagedRenders } from '../../lib/data/staged-renders.js';
import { keyForRender, keyForRef, newRenderId } from '../../lib/data/object-keys.js';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-refs-'));
  dirs.push(dir);
  const authStore = createAuthStore(dir);
  stores.push(authStore);
  const refs = createRenderRefs(dir);
  const renders = createStagedRenders(dir);
  const mk = (email) => {
    const start = authStore.startRegistration(email, 'CorrectHorse9!');
    return authStore.completeRegistration(email, start.code).user;
  };
  return { dir, db: getDb(dir), refs, renders, user: mk('seller@example.com'), other: mk('other@example.com') };
}

/** Record one render carrying the given reference hashes. */
function renderWithRefs(renders, refs, userId, refHashes, { at = 1_000 } = {}) {
  const id = newRenderId();
  renders.record({
    render: { id, userId },
    blobs: [{ role: 'after', storageKey: keyForRender({ renderId: id, role: 'after' }), bytes: 1 }],
    isPro: true,
    now: at,
  });
  refs.link({ renderId: id, userId, refHashes });
  renders.markOk(id);
  return id;
}

const SOFA = Buffer.from('a photo of a sofa');

test('the same photo from one account is stored once', () => {
  const { refs, user } = setup();
  const hash = refs.hashFor(user.id, SOFA);

  const first = refs.ensureRef({ userId: user.id, refHash: hash, bytes: 30_000 });
  assert.equal(first.created, true, 'the first upload has to happen');
  assert.equal(first.storageKey, keyForRef({ refHash: hash }));

  const second = refs.ensureRef({ userId: user.id, refHash: hash, bytes: 30_000 });
  assert.equal(second.created, false, 'the second must skip the encode AND the PUT');
  assert.equal(second.storageKey, first.storageKey);
  assert.equal(refs.countForUser(user.id), 1);
});

test('the same photo from two accounts is stored twice, deliberately', () => {
  // Cross-user dedupe of a stock furniture photo would be a rounding error. Being able
  // to say "erasure deleted their bytes, full stop" — with no "is anyone else still
  // using this?" question — is not.
  const { refs, user, other } = setup();
  const mine = refs.hashFor(user.id, SOFA);
  const theirs = refs.hashFor(other.id, SOFA);
  assert.notEqual(mine, theirs);

  assert.equal(refs.ensureRef({ userId: user.id, refHash: mine }).created, true);
  assert.equal(refs.ensureRef({ userId: other.id, refHash: theirs }).created, true);
  assert.equal(refs.countForUser(user.id), 1);
  assert.equal(refs.countForUser(other.id), 1);
});

test('references come back in the order the user attached them', () => {
  const { refs, renders, user } = setup();
  const hashes = ['sofa', 'lamp', 'rug'].map((s) => refs.hashFor(user.id, Buffer.from(s)));
  for (const h of hashes) refs.ensureRef({ userId: user.id, refHash: h });
  const renderId = renderWithRefs(renders, refs, user.id, hashes);

  const got = refs.forRender(renderId);
  assert.deepEqual(got.map((r) => r.ref_hash), hashes);
  assert.deepEqual(got.map((r) => r.seq), [0, 1, 2]);
});

test('more references than the upload allows are dropped, not stored', () => {
  const { refs, renders, user } = setup();
  const many = Array.from({ length: MAX_REFS_PER_RENDER + 3 }, (_, i) => refs.hashFor(user.id, Buffer.from(`ref${i}`)));
  for (const h of many) refs.ensureRef({ userId: user.id, refHash: h });
  const renderId = renderWithRefs(renders, refs, user.id, many);
  assert.equal(refs.forRender(renderId).length, MAX_REFS_PER_RENDER);
});

// ---- the derived lifetime ---------------------------------------------------------

function tombstoned(db) {
  return db.prepare('SELECT storage_key FROM blob_tombstones').all().map((r) => r.storage_key);
}

test('a reference survives while ANY render still uses it', () => {
  // The case a broken ref_count gets wrong: two renders share one sofa photo, one is
  // deleted, and the photo must stay because the other still shows it.
  const { db, refs, renders, user } = setup();
  const hash = refs.hashFor(user.id, SOFA);
  refs.ensureRef({ userId: user.id, refHash: hash });
  const a = renderWithRefs(renders, refs, user.id, [hash], { at: 1_000 });
  const b = renderWithRefs(renders, refs, user.id, [hash], { at: 2_000 });

  renders.remove({ id: a, userId: user.id, now: 3_000 });

  assert.equal(refs.countForUser(user.id), 1, 'the reference is still in use');
  assert.ok(!tombstoned(db).includes(keyForRef({ refHash: hash })), 'its bytes must NOT be queued');
  assert.equal(refs.forRender(b).length, 1, 'the surviving render still shows it');
});

test('a reference is swept once the last render using it goes', () => {
  const { db, refs, renders, user } = setup();
  const hash = refs.hashFor(user.id, SOFA);
  refs.ensureRef({ userId: user.id, refHash: hash });
  const a = renderWithRefs(renders, refs, user.id, [hash], { at: 1_000 });
  const b = renderWithRefs(renders, refs, user.id, [hash], { at: 2_000 });

  renders.remove({ id: a, userId: user.id, now: 3_000 });
  renders.remove({ id: b, userId: user.id, now: 4_000 });

  assert.equal(refs.countForUser(user.id), 0);
  assert.ok(tombstoned(db).includes(keyForRef({ refHash: hash })), 'now the bytes are owed a deletion');
});

test('one account\'s sweep never touches another account\'s references', () => {
  const { db, refs, renders, user, other } = setup();
  const mine = refs.hashFor(user.id, SOFA);
  const theirs = refs.hashFor(other.id, SOFA);
  refs.ensureRef({ userId: user.id, refHash: mine });
  refs.ensureRef({ userId: other.id, refHash: theirs });
  const a = renderWithRefs(renders, refs, user.id, [mine], { at: 1_000 });
  renderWithRefs(renders, refs, other.id, [theirs], { at: 1_000 });

  renders.remove({ id: a, userId: user.id, now: 3_000 });

  assert.equal(refs.countForUser(other.id), 1);
  assert.ok(!tombstoned(db).includes(keyForRef({ refHash: theirs })));
});

test('eviction sweeps orphaned references too, not just explicit deletes', () => {
  // Free-tier eviction and a user-initiated delete go down different paths; both have to
  // reach the references, or a capped account slowly accumulates unreferenced bytes.
  const { db, refs, renders, user } = setup();
  const hash = refs.hashFor(user.id, SOFA);
  refs.ensureRef({ userId: user.id, refHash: hash });
  // One old render holds the only link to it, then push it past the cap.
  renderWithRefs(renders, refs, user.id, [hash], { at: 1_000 });
  for (let i = 0; i < 25; i += 1) {
    const id = newRenderId();
    renders.record({ render: { id, userId: user.id }, isPro: false, now: 2_000 + i });
    renders.markOk(id);
  }

  assert.equal(refs.countForUser(user.id), 0, 'the evicted render was the last holder');
  assert.ok(tombstoned(db).includes(keyForRef({ refHash: hash })));
});
