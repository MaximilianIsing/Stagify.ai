// Tier: store unit — the three batched page reads behind the owner's gallery listing.
//
// `blobsForRenders`, `forRenders` and the share lookup inside `ensureForRenders` replaced
// per-row statements that the listing ran inside its map. That made a page cost three
// statements per tile; it now costs three statements per PAGE. The route-level guard that
// the listing keeps using them lives in test/routes/gallery-route.test.js — this file
// proves the batched reads ANSWER THE SAME QUESTION as the single-render ones they were
// folded out of, which is the half a statement count cannot check.
//
// The plan assertions matter as much as the equivalence ones. `WHERE x IN (SELECT value
// FROM json_each(?))` is only cheap because SQLite drives it as a seek per id against the
// primary key; if a schema change ever cost it that index the query would silently become
// a full table scan per listing and every other test here would still pass. They EXPLAIN
// the exported SQL the stores actually prepare, never a copy — a plan test against a
// retyped query is a test of the copy.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, closeDb } from '../../lib/data/db.js';
import { createStagedRenders } from '../../lib/data/staged-renders.js';
import { createRenderRefs } from '../../lib/data/render-refs.js';
import { createGalleryShares } from '../../lib/data/gallery-shares.js';
import {
  BLOBS_FOR_RENDERS_SQL, REFS_FOR_RENDERS_SQL, ACTIVE_FOR_RENDERS_SQL,
} from '../../lib/data/gallery-page-reads.js';
import { keyForRender, newRenderId } from '../../lib/data/object-keys.js';

const dirs = [];

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    try { closeDb(d); } catch { /* not open */ }
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ }
  }
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-batchread-'));
  dirs.push(dir);
  return {
    dir,
    db: getDb(dir),
    renders: createStagedRenders(dir),
    refs: createRenderRefs(dir),
    shares: createGalleryShares(dir),
  };
}

/**
 * One finished render, with the three blobs the pipeline really writes and however many
 * reference photos were asked for.
 */
function addRender(renders, refs, userId, { refHashes = [], at = 1_000 } = {}) {
  const id = newRenderId();
  renders.record({
    render: { id, userId, roomType: 'Bedroom' },
    blobs: ['after', 'before', 'thumb'].map((role) => ({
      role, storageKey: keyForRender({ renderId: id, role }), bytes: 1,
    })),
    isPro: true,
    now: at,
  });
  for (const [i, refHash] of refHashes.entries()) {
    refs.ensureRef({ userId, refHash, bytes: 1, now: at + i });
  }
  if (refHashes.length) refs.link({ renderId: id, userId, refHashes });
  renders.markOk(id, { width: 1024, height: 683 });
  return id;
}

const hash = (n) => String(n).padStart(64, 'a');

// ---- equivalence: the batch answers what N singles answer ----------------------------

test('blobsForRenders returns exactly what a call to blobsFor per render returns', () => {
  const { renders, refs } = setup();
  const ids = Array.from({ length: 5 }, () => addRender(renders, refs, 'user-1'));

  const batched = renders.blobsForRenders(ids);
  for (const id of ids) {
    // Sorted on both sides: neither statement promises an order for blobs, and pinning
    // one here would be asserting an incidental property of the current index.
    const by = (a, b) => a.role.localeCompare(b.role);
    const single = renders.blobsFor(id).slice().sort(by);
    const fromBatch = (batched.get(id) ?? []).slice().sort(by)
      // The batched row carries render_id (it is the grouping key); the single-render one
      // has no need of it. Every other field must match, value for value.
      .map(({ render_id: _ignored, ...rest }) => rest);
    assert.deepEqual(fromBatch, single, `blobs for ${id}`);
    assert.equal(single.length, 3, 'after, before and thumb');
  }
  assert.equal(batched.size, ids.length);
});

test('forRenders returns exactly what a call to forRender per render returns, in seq order', () => {
  const { renders, refs } = setup();
  // Deliberately uneven: five references, one, and none. The empty case is the common one
  // in production — most renders carry no furniture photos at all — and it is the case the
  // per-row version spent most of its statements on.
  const many = addRender(renders, refs, 'user-1', { refHashes: [hash(1), hash(2), hash(3), hash(4), hash(5)] });
  const one = addRender(renders, refs, 'user-1', { refHashes: [hash(2)] });
  const none = addRender(renders, refs, 'user-1');

  const batched = refs.forRenders([many, one, none]);
  for (const id of [many, one]) {
    const fromBatch = (batched.get(id) ?? []).map(({ render_id: _ignored, ...rest }) => rest);
    assert.deepEqual(fromBatch, refs.forRender(id), `refs for ${id}`);
  }
  assert.deepEqual(batched.get(many).map((r) => r.seq), [0, 1, 2, 3, 4], 'upload order preserved');

  // ABSENT, not present-and-empty. One "nothing here" state rather than two.
  assert.equal(batched.has(none), false);
  assert.equal(batched.get(none), undefined);
  assert.deepEqual(refs.forRender(none), [], 'and the single-render read still says empty');
});

test('both batched reads ignore ids that do not exist and accept an empty page', () => {
  const { renders, refs } = setup();
  const real = addRender(renders, refs, 'user-1', { refHashes: [hash(9)] });

  const blobs = renders.blobsForRenders([real, 'render-that-never-existed']);
  assert.deepEqual([...blobs.keys()], [real]);
  const grouped = refs.forRenders([real, 'render-that-never-existed']);
  assert.deepEqual([...grouped.keys()], [real]);

  // A search that matched nothing hands the route an empty page, so this is a real path,
  // not a defensive flourish.
  for (const empty of [[], null, undefined]) {
    assert.equal(renders.blobsForRenders(empty).size, 0);
    assert.equal(refs.forRenders(empty).size, 0);
  }
});

// ---- equivalence: the batched share lookup ------------------------------------------

test('ensureForRenders mints the same links one-at-a-time ensureShare would', () => {
  const { renders, refs, shares } = setup();
  const rows = Array.from({ length: 4 }, () => addRender(renders, refs, 'user-1'))
    .map((id) => ({ id, user_id: 'user-1' }));

  const minted = shares.ensureForRenders({ renders: rows });
  assert.equal(minted.size, 4);
  for (const { id } of rows) {
    assert.ok(minted.get(id).token, 'every entry arrives with a usable link');
    assert.equal(minted.get(id).renderId, id, 'and it is keyed to the right render');
  }

  // Idempotent: a second listing reuses, never rotates. This is what the whole
  // mint-on-read design rests on, and the batched lookup must not have changed it.
  const again = shares.ensureForRenders({ renders: rows });
  for (const { id } of rows) {
    assert.equal(again.get(id).token, minted.get(id).token, `token stable for ${id}`);
    assert.equal(again.get(id).createdAt, minted.get(id).createdAt);
  }
  // And it agrees with the single-render entry point.
  for (const { id } of rows) {
    assert.equal(shares.ensureShare({ renderId: id, userId: 'user-1' }).token, minted.get(id).token);
  }
});

test('a revoked share is not resurrected by the batched lookup', () => {
  const { renders, refs, shares } = setup();
  const id = addRender(renders, refs, 'user-1');
  const rows = [{ id, user_id: 'user-1' }];

  const first = shares.ensureForRenders({ renders: rows }).get(id);
  shares.revoke(id);

  const second = shares.ensureForRenders({ renders: rows }).get(id);
  assert.ok(second.token, 'a fresh link is minted');
  assert.notEqual(second.token, first.token, 'the revoked token is NOT handed back');
  assert.deepEqual(
    shares.resolveShare(first.token), { ok: false, reason: 'revoked' },
    'and the old one stays dead',
  );
});

test('an expired share is replaced rather than reused, batched or not', () => {
  const { renders, refs, shares } = setup();
  const id = addRender(renders, refs, 'user-1');
  const rows = [{ id, user_id: 'user-1' }];

  const first = shares.ensureShare({ renderId: id, userId: 'user-1', expiresAt: 5_000, now: 1_000 });
  // now is past expiresAt: the prefetched row exists and is live, but is not USABLE, so
  // the batched path has to fall through to a mint exactly as the per-row path did.
  const second = shares.ensureForRenders({ renders: rows, now: 9_000 }).get(id);
  assert.notEqual(second.token, first.token);
  assert.equal(second.expiresAt, null, 'the replacement carries no stale expiry');
});

// ---- the plans -----------------------------------------------------------------------

/** @param {any} db @param {string} sql @returns {string} The plan, one line. */
const planOf = (db, sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
  .all(JSON.stringify(['a', 'b'])).map((r) => r.detail).join(' | ');

test('every batched read is an index seek per id, never a table scan', () => {
  const { db } = setup();
  // json_each itself is scanned — that is the list being driven, and it is two rows here.
  // What must never appear is a scan of the TABLE, which is what the `IN` would degrade to
  // if the leading-column index went away.
  const cases = [
    ['render_blobs', BLOBS_FOR_RENDERS_SQL, 'render_blobs'],
    ['render_refs', REFS_FOR_RENDERS_SQL, 'rr'],
    ['gallery_shares', ACTIVE_FOR_RENDERS_SQL, 'gallery_shares'],
  ];
  for (const [table, sql, alias] of cases) {
    const plan = planOf(db, sql);
    assert.match(plan, new RegExp(`SEARCH ${alias} USING (COVERING )?INDEX`), `${table}: ${plan}`);
    assert.doesNotMatch(plan, new RegExp(`SCAN ${alias}\\b`), `${table} must not be scanned: ${plan}`);
    assert.match(plan, /json_each/, `${table}: the id list drives the query: ${plan}`);
  }
});

test('the reference join reaches ref_objects by its primary key', () => {
  const { db } = setup();
  // The batched refs read is the only one of the three that joins. A missing index here
  // would be a scan of every reference object in the database, once per gallery listing.
  assert.match(planOf(db, REFS_FOR_RENDERS_SQL), /SEARCH o USING INDEX/);
});

test('a page of ids binds as one JSON parameter, so the SQL text never varies', () => {
  const { renders, refs } = setup();
  // The reason for json_each over a generated `?, ?, ?`: better-sqlite3 caches prepared
  // statements by SQL TEXT, so a placeholder run that grew with the page would prepare a
  // new statement per distinct page size — and would eventually meet
  // SQLITE_MAX_VARIABLE_NUMBER. One `?` means one statement, whatever the page.
  for (const sql of [BLOBS_FOR_RENDERS_SQL, REFS_FOR_RENDERS_SQL, ACTIVE_FOR_RENDERS_SQL]) {
    assert.equal((sql.match(/\?/g) ?? []).length, 1, `one bound parameter: ${sql}`);
  }
  // And it really does hold a full page, well past any placeholder ceiling.
  const ids = Array.from({ length: 200 }, () => addRender(renders, refs, 'user-1'));
  assert.equal(renders.blobsForRenders(ids).size, 200);
});
