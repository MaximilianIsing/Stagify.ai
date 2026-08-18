// Tier: data aggregation (real SQLite on a temp dir) — lib/analytics/admin-metrics.js.
//
// WHY THIS EXISTS. This module is the first thing in the repo that runs analytical
// SQL against the production database on an operator's click, so it carries two
// risks nothing else in the admin layer does.
//
//   1. **It could be an N+1.** Every query here is a GROUP BY or a COUNT, and the
//      whole point is that the statement count is FIXED. A future edit that reaches
//      for "just one more lookup per account" would still pass every behavioural
//      assertion below while turning a dashboard tab into a table scan per user.
//      The last test counts `prepare` calls across two datasets of very different
//      size and fails if the number moves — see [[sqlite-statement-count-guard]].
//   2. **It reports numbers nothing else can check.** The CSV exports cannot
//      corroborate a byte total or a share view count, so if an aggregate is wrong
//      it is wrong silently and forever. Hence the fixtures below are built with
//      deliberately awkward shapes — an evicted render, a failed one, a legacy row
//      with no `extra_json`, a share minted but never opened — rather than a tidy
//      happy path.
//
// The schema is created by the REAL store factories against a temp data dir, never
// by inline DDL in this file. They all share one connection per base dir
// (lib/data/db.js#getDb), so constructing them together produces exactly the
// database production has, and a schema change cannot leave this suite testing a
// stale shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getDb, closeDb, resolveDataDir } from '../../lib/data/db.js';
import { createAuthStore } from '../../lib/data/auth-store.js';
import { createStagedRenders } from '../../lib/data/staged-renders.js';
import { createStripeEventLog } from '../../lib/data/stripe-events.js';
import { createBlobTombstones } from '../../lib/data/blob-tombstones.js';
import { createAdminMetrics } from '../../lib/analytics/admin-metrics.js';

const DAY = 24 * 60 * 60 * 1000;

/** A temp base dir with every table the metrics module reads, and its open handle. */
function makeDb() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-metrics-'));
  // Constructing the stores is what applies each schema.
  createAuthStore(base);
  createStagedRenders(base);
  createStripeEventLog(base);
  createBlobTombstones(base);
  const db = getDb(base);
  return {
    base,
    db,
    getDataLogDir: () => resolveDataDir(base),
    close: () => { try { closeDb(base); } catch { /* already closed */ } },
  };
}

/** Insert one staged render directly, so the fixture can set states the API guards. */
function addRender(db, row) {
  db.prepare(`
    INSERT INTO staged_renders (id, user_id, created_at, status, room_type, evicted_at, extra_json)
    VALUES (@id, @userId, @createdAt, @status, @roomType, @evictedAt, @extraJson)
  `).run({
    roomType: 'Living room', evictedAt: null, extraJson: null, status: 'ok', ...row,
  });
}

function addBlob(db, row) {
  db.prepare(`
    INSERT INTO render_blobs (render_id, role, storage_key, bytes, user_id)
    VALUES (@renderId, @role, @storageKey, @bytes, @userId)
  `).run({ role: 'after', storageKey: 'k/' + row.renderId, ...row });
}

function addShare(db, row) {
  db.prepare(`
    INSERT INTO gallery_shares (token_hash, render_id, user_id, created_at, view_count, last_viewed_at, revoked_at)
    VALUES (@tokenHash, @renderId, @userId, @createdAt, @viewCount, @lastViewedAt, @revokedAt)
  `).run({ viewCount: 0, lastViewedAt: null, revokedAt: null, ...row });
}

// ── Renders ─────────────────────────────────────────────────────────────────

test('render totals count every state, and distinct accounts', async (t) => {
  const h = makeDb();
  t.after(h.close);
  const now = Date.now();

  addRender(h.db, { id: 'r1', userId: 'u1', createdAt: now - 1 * DAY, status: 'ok' });
  addRender(h.db, { id: 'r2', userId: 'u1', createdAt: now - 2 * DAY, status: 'failed' });
  addRender(h.db, { id: 'r3', userId: 'u2', createdAt: now - 3 * DAY, status: 'pending' });
  addRender(h.db, { id: 'r4', userId: 'u2', createdAt: now - 4 * DAY, status: 'ok', evictedAt: now });

  const m = createAdminMetrics(h).snapshot({ now });
  assert.equal(m.renders.total, 4);
  assert.equal(m.renders.ok, 2);
  assert.equal(m.renders.failed, 1);
  assert.equal(m.renders.pending, 1);
  assert.equal(m.renders.evicted, 1);
  assert.equal(m.renders.distinctUsers, 2, 'the count the CSV cannot produce');
});

test('an evicted render still counts toward the outcome totals', async (t) => {
  // Eviction is a gallery-capacity event, not a staging outcome. Filtering it out
  // of `ok`/`failed` would make the success rate quietly IMPROVE every time a free
  // account hit its cap, because the evicted rows are disproportionately old.
  const h = makeDb();
  t.after(h.close);
  const now = Date.now();
  addRender(h.db, { id: 'e1', userId: 'u1', createdAt: now - DAY, status: 'failed', evictedAt: now });

  const m = createAdminMetrics(h).snapshot({ now });
  assert.equal(m.renders.failed, 1, 'an evicted failure is still a failure');
  assert.equal(m.renders.evicted, 1);
});

test('bySource buckets legacy and malformed extra_json as unknown, not as a crash', async (t) => {
  // Rows predating extra_json have it NULL; a row that somehow holds non-JSON must
  // not abort the whole query, which is what an unguarded json_extract would do.
  const h = makeDb();
  t.after(h.close);
  const now = Date.now();

  addRender(h.db, { id: 's1', userId: 'u1', createdAt: now, extraJson: JSON.stringify({ source: 'interior' }) });
  addRender(h.db, { id: 's2', userId: 'u1', createdAt: now, extraJson: JSON.stringify({ source: 'exterior' }) });
  addRender(h.db, { id: 's3', userId: 'u1', createdAt: now, extraJson: JSON.stringify({ source: 'interior' }) });
  addRender(h.db, { id: 's4', userId: 'u1', createdAt: now, extraJson: null });
  addRender(h.db, { id: 's5', userId: 'u1', createdAt: now, extraJson: 'not json at all' });

  const m = createAdminMetrics(h).snapshot({ now });
  const bySource = Object.fromEntries(m.renders.bySource.map((r) => [r.source, r.total]));
  assert.equal(bySource.interior, 2);
  assert.equal(bySource.exterior, 1);
  assert.equal(bySource.unknown, 2, 'a NULL and a malformed value both land in unknown');
});

test('the duration windows are relative to the injected now, not the wall clock', async (t) => {
  const h = makeDb();
  t.after(h.close);
  const now = Date.parse('2026-06-15T12:00:00Z');

  addRender(h.db, { id: 'w1', userId: 'u1', createdAt: now - 2 * DAY, status: 'ok' });
  addRender(h.db, { id: 'w2', userId: 'u1', createdAt: now - 10 * DAY, status: 'failed' });
  addRender(h.db, { id: 'w3', userId: 'u2', createdAt: now - 200 * DAY, status: 'ok' });

  const m = createAdminMetrics(h).snapshot({ now });
  assert.equal(m.renders.last7d.total, 1);
  assert.equal(m.renders.last30d.total, 2);
  assert.equal(m.renders.last30d.failed, 1);
  assert.equal(m.renders.last30d.users, 1);
  assert.equal(m.renders.total, 3, 'all-time is unaffected by the windows');
});

test('per-account distribution reports the shape and the top accounts', async (t) => {
  const h = makeDb();
  t.after(h.close);
  const now = Date.now();

  // u1: 5 ok, u2: 2 ok, u3: 1 ok + 1 failed (failures do not count as usage here).
  for (let i = 0; i < 5; i++) addRender(h.db, { id: `a${i}`, userId: 'u1', createdAt: now, status: 'ok' });
  for (let i = 0; i < 2; i++) addRender(h.db, { id: `b${i}`, userId: 'u2', createdAt: now, status: 'ok' });
  addRender(h.db, { id: 'c0', userId: 'u3', createdAt: now, status: 'ok' });
  addRender(h.db, { id: 'c1', userId: 'u3', createdAt: now, status: 'failed' });

  const m = createAdminMetrics(h).snapshot({ now });
  assert.equal(m.renders.perUser.accounts, 3);
  assert.equal(m.renders.perUser.max, 5);
  assert.equal(m.renders.perUser.top[0].userId, 'u1');
  assert.equal(m.renders.perUser.top[0].renders, 5);
  assert.equal(m.renders.perUser.top.length, 3);
});

// ── Storage ─────────────────────────────────────────────────────────────────

test('storage sums bytes overall and per account, largest first', async (t) => {
  const h = makeDb();
  t.after(h.close);

  addBlob(h.db, { renderId: 'r1', userId: 'u1', bytes: 100 });
  addBlob(h.db, { renderId: 'r1', userId: 'u1', bytes: 50, role: 'thumb' });
  addBlob(h.db, { renderId: 'r2', userId: 'u2', bytes: 900 });

  const m = createAdminMetrics(h).snapshot({});
  assert.equal(m.storage.bytes, 1050);
  assert.equal(m.storage.blobs, 3);
  assert.equal(m.storage.topAccounts[0].userId, 'u2');
  assert.equal(m.storage.topAccounts[0].bytes, 900);
  assert.equal(m.storage.topAccounts[1].bytes, 150, 'both roles of a render roll up to its owner');
});

// ── Shares ──────────────────────────────────────────────────────────────────

test('shares separate links-opened from total openings', async (t) => {
  // 40 views across 2 of 30 links is a different product situation from 40 across
  // 25 of them, and one total cannot tell them apart — so both are reported.
  const h = makeDb();
  t.after(h.close);
  const now = Date.now();

  addShare(h.db, { tokenHash: 't1', renderId: 'r1', userId: 'u1', createdAt: now, viewCount: 30, lastViewedAt: now });
  addShare(h.db, { tokenHash: 't2', renderId: 'r2', userId: 'u1', createdAt: now, viewCount: 10, lastViewedAt: now - DAY });
  addShare(h.db, { tokenHash: 't3', renderId: 'r3', userId: 'u2', createdAt: now, viewCount: 0 });
  addShare(h.db, { tokenHash: 't4', renderId: 'r4', userId: 'u2', createdAt: now, viewCount: 0, revokedAt: now });

  const m = createAdminMetrics(h).snapshot({ now });
  assert.equal(m.shares.minted, 4);
  assert.equal(m.shares.viewed, 2, 'links ever opened');
  assert.equal(m.shares.views, 40, 'total openings');
  assert.equal(m.shares.revoked, 1);
  assert.equal(m.shares.lastViewedAt, now);
});

// ── Health ──────────────────────────────────────────────────────────────────

test('a stripe event stuck past the reclaim window is counted; a fresh claim is not', async (t) => {
  const h = makeDb();
  t.after(h.close);
  const now = Date.now();
  const reclaim = 5 * 60 * 1000;

  const ins = h.db.prepare('INSERT INTO stripe_events (id, type, status, claimed_at) VALUES (?, ?, ?, ?)');
  ins.run('evt_stuck', 'x', 'processing', now - reclaim - 1000);
  ins.run('evt_fresh', 'x', 'processing', now - 1000);
  ins.run('evt_done', 'x', 'done', now - reclaim - 1000);

  const m = createAdminMetrics(h).snapshot({ now });
  assert.equal(m.health.stuckStripeEvents, 1, 'only the abandoned claim counts');
  assert.equal(m.health.stripeReclaimMs, reclaim);
});

test('tombstone backlog reports the repeatedly-failing subset and the latest error', async (t) => {
  const h = makeDb();
  t.after(h.close);
  const now = Date.now();

  const ins = h.db.prepare(`
    INSERT INTO blob_tombstones (storage_key, created_at, attempts, last_attempt_at, last_error)
    VALUES (?, ?, ?, ?, ?)`);
  ins.run('k1', now, 0, null, null);
  ins.run('k2', now, 4, now - 1000, 'AccessDenied');
  ins.run('k3', now, 5, now, 'NoSuchBucket');

  const m = createAdminMetrics(h).snapshot({ now });
  assert.equal(m.health.tombstoneBacklog, 3);
  assert.equal(m.health.tombstonesFailing, 2);
  assert.equal(m.health.lastTombstoneError, 'NoSuchBucket', 'the most recent attempt wins');
});

// ── Empty database ──────────────────────────────────────────────────────────

test('an empty database returns zeros and NULLS — never a fabricated number', async (t) => {
  // The invariant the whole dashboard runs on: absent must not read as a value.
  // Counts are genuinely 0, but a percentile over no accounts and a "last viewed"
  // that never happened have no value, and must say so.
  const h = makeDb();
  t.after(h.close);

  const m = createAdminMetrics(h).snapshot({});
  assert.equal(m.renders.total, 0);
  assert.equal(m.renders.distinctUsers, 0);
  assert.deepEqual(m.renders.bySource, []);
  assert.strictEqual(m.renders.perUser.p50, null, 'no accounts means no median, not 0');
  assert.strictEqual(m.renders.perUser.max, null);
  assert.strictEqual(m.renders.firstAt, null);
  assert.strictEqual(m.shares.lastViewedAt, null);
  assert.strictEqual(m.health.lastTombstoneError, null);
  assert.equal(m.storage.bytes, 0);
});

// ── Log sizes ───────────────────────────────────────────────────────────────

test('a log that has never been written is reported as absent, not omitted', async (t) => {
  // "No rejections have ever been logged" and "the rejection log is small" are
  // different facts. Dropping the row would render as the second.
  const h = makeDb();
  t.after(h.close);
  fs.writeFileSync(path.join(h.getDataLogDir(), 'prompt_logs.csv'), 'timestamp\nx\n');

  const m = createAdminMetrics(h).snapshot({});
  const byName = Object.fromEntries(m.logs.map((l) => [l.name, l]));
  assert.equal(byName['prompt_logs.csv'].exists, true);
  assert.ok(byName['prompt_logs.csv'].bytes > 0);
  assert.equal(byName['rejection_logs.csv'].exists, false);
  assert.equal(byName['rejection_logs.csv'].bytes, 0);
  assert.equal(byName['email_open_logs.csv'].ceiling, 4 * 1024 * 1024, 'the ceiling rides along');
});

// ── The N+1 guard ───────────────────────────────────────────────────────────

test('the statement count is FIXED — it does not grow with the data', async (t) => {
  // The guard that makes this endpoint safe to point at production. Every
  // behavioural assertion above passes just as happily against a per-account
  // lookup, so this counts `prepare` calls directly, across two datasets three
  // orders of magnitude apart in size.
  //
  // Prepares are counted at FACTORY time (where they all belong) and at SNAPSHOT
  // time (which must be zero — a statement built inside snapshot() is one built
  // per request, and the next step from there is one per row).
  function countPrepares(rows) {
    const h = makeDb();
    t.after(h.close);
    const now = Date.now();
    const insert = h.db.prepare(
      "INSERT INTO staged_renders (id, user_id, created_at, status) VALUES (?, ?, ?, 'ok')",
    );
    const many = h.db.transaction(() => {
      for (let i = 0; i < rows; i++) insert.run(`r${i}`, `u${i % 50}`, now - i);
    });
    many();

    let atFactory = 0;
    let atSnapshot = 0;
    let phase = 'factory';
    const spy = {
      prepare(sql) {
        if (phase === 'factory') atFactory += 1; else atSnapshot += 1;
        return h.db.prepare(sql);
      },
    };
    const metrics = createAdminMetrics({ db: spy, getDataLogDir: h.getDataLogDir });
    phase = 'snapshot';
    const snap = metrics.snapshot({ now });
    // Run it twice: a lazily-memoized statement would show up on the first call
    // and hide on the second, which is still one prepare per process, not per row.
    metrics.snapshot({ now });
    return { atFactory, atSnapshot, total: snap.renders.total };
  }

  const small = countPrepares(10);
  const large = countPrepares(5000);

  assert.equal(small.total, 10);
  assert.equal(large.total, 5000);
  assert.equal(
    small.atFactory,
    large.atFactory,
    `prepare count moved with the data: ${small.atFactory} vs ${large.atFactory} — this is an N+1`,
  );
  assert.equal(small.atSnapshot, 0, 'snapshot() must not prepare anything; statements belong to the factory');
  assert.equal(large.atSnapshot, 0);
  assert.ok(small.atFactory > 0 && small.atFactory < 40, `expected a handful of statements, got ${small.atFactory}`);
});
