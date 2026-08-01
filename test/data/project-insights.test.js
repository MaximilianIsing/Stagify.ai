// Tier: unit (real SQLite + a real temp filesystem) — lib/data/project-insights.js.
//
// WHAT THIS COVERS
// The support tool. Its failure mode is not a crash, it is a CONFIDENT WRONG ANSWER: an
// operator reads "nothing is stuck", tells a broker their listing is fine, and it never
// finishes. So the tests are about the three ways it could lie:
//
//   - `blocked` must mean what the QUEUE means by it. This module restates the claim
//     barrier's condition in its own SQL rather than importing it, so the test that matters
//     is the one that builds a genuinely unclaimable row and checks BOTH agree — the module
//     and `claimNextRender` itself.
//   - "stuck" must not fire on a listing that is simply working. A run mid-flight touches
//     `updated_at` on every completion, so the threshold has to be measured against that.
//   - `storageByAccount` must attribute bytes to the right account, and must not invent an
//     account for an orphan directory the sweep owns.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectInsights, DEFAULT_STALE_AFTER_MS } from '../../lib/data/project-insights.js';
import { createProjects } from '../../lib/data/projects.js';
import { createProjectStorage } from '../../lib/data/project-storage.js';
import { closeDb } from '../../lib/data/db.js';

const NOW = Date.UTC(2026, 6, 31, 12);
const OWNER = 'u_broker';
const HOUR = 60 * 60 * 1000;

const dirs = [];

/** Stores plus the insights reader over one fresh data dir, with a frozen clock. */
function harness({ now = () => NOW } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-insight-'));
  dirs.push(dir);
  return {
    dir,
    projects: createProjects(dir),
    storage: createProjectStorage({ baseDir: dir }),
    insights: createProjectInsights({ baseDir: dir, now }),
  };
}

/**
 * A listing in `staging` with a hero and one support frame, both queued.
 * `bible` false leaves the support frame structurally unclaimable.
 */
function stagingListing(h, { userId = OWNER, bible = false, updatedAt = NOW } = {}) {
  const project = h.projects.createProject({ userId, title: 'Listing', now: updatedAt });
  const mk = (role, sha) => {
    const added = h.projects.addPhoto({
      projectId: project.id,
      storageKey: `projects/${project.id}/src/${sha.padStart(32, '0')}.webp`,
      sha256: sha, roomKey: 'living-room-1', roomType: 'Living room', frameRole: role, now: updatedAt,
    });
    assert.equal(added.ok, true, 'precondition: photo added');
    return added.photo;
  };
  const hero = mk('hero', `h${project.id.slice(0, 8)}`);
  const support = mk('support', `s${project.id.slice(0, 8)}`);
  h.projects.enqueueRender({ projectId: project.id, photoId: hero.id, now: updatedAt });
  h.projects.enqueueRender({ projectId: project.id, photoId: support.id, now: updatedAt });
  if (bible) {
    h.projects.createBibleAndUnblockRoom({
      projectId: project.id, roomKey: 'living-room-1', doc: { pieces: [] }, now: updatedAt,
    });
  }
  h.projects.updateProject(project.id, { status: 'staging', now: updatedAt });
  return { project, hero, support };
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    // Windows cannot unlink the .db/-wal/-shm files while the shared handle is open.
    closeDb(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── `blocked` must mean what the queue means ────────────────────────────────

test('blocked counts exactly the rows the CLAIM refuses — checked against the claim itself', () => {
  // The load-bearing test. This module restates the barrier's condition in its own SQL, so
  // agreeing with `claimNextRender` is an assumption until something proves it. Here the
  // hero is claimable and the support frame is not, and BOTH the report and the real queue
  // are asked.
  const h = harness();
  stagingListing(h, { bible: false });

  const totals = h.insights.queueTotals();
  assert.equal(totals.queued, 2);
  assert.equal(totals.blocked, 1, 'the support frame has no bible and can never be claimed');

  // The queue's own answer: it hands out the hero, then nothing.
  const first = h.projects.claimNextRender({ now: NOW });
  assert.ok(first, 'the hero is claimable');
  assert.equal(h.projects.claimNextRender({ now: NOW }), null,
    'and the barred support frame is NOT — which is what `blocked` claims');
});

test('a room WITH a bible has nothing blocked', () => {
  const h = harness();
  stagingListing(h, { bible: true });
  assert.equal(h.insights.queueTotals().blocked, 0);
  // …and the queue agrees: both rows can be claimed.
  assert.ok(h.projects.claimNextRender({ now: NOW }));
  assert.ok(h.projects.claimNextRender({ now: NOW }));
});

test('a queued HERO is never counted as blocked — it is what unblocks the room', () => {
  const h = harness();
  const { project, hero } = stagingListing(h, { bible: false });
  // A second hero variation, still queued: claimable, so not blocked.
  h.projects.enqueueRender({ projectId: project.id, photoId: hero.id, variation: 2, now: NOW });
  assert.equal(h.insights.queueTotals().blocked, 1, 'still only the support frame');
});

test('queue totals span every account, which is the whole point of the tool', () => {
  const h = harness();
  stagingListing(h, { userId: 'u_a', bible: true });
  stagingListing(h, { userId: 'u_b', bible: true });
  const totals = h.insights.queueTotals();
  assert.equal(totals.queued, 4, 'two listings, two frames each');
  assert.equal(totals.ok, 0);
  assert.equal(totals.failed, 0);
});

test('an empty database reports zeroes rather than nulls', () => {
  // SUM() over no rows is NULL in SQLite; a `null` reaching a dashboard renders as blank and
  // reads as "unknown" when the truthful answer is "none".
  const h = harness();
  assert.deepEqual(h.insights.queueTotals(), { queued: 0, running: 0, blocked: 0, failed: 0, ok: 0 });
  assert.deepEqual(h.insights.stuckListings(), []);
});

// ── "stuck" must not fire on a listing that is working ──────────────────────

test('a listing that has just been touched is NOT stuck', () => {
  const h = harness();
  stagingListing(h, { bible: true, updatedAt: NOW });
  assert.deepEqual(h.insights.stuckListings(), [], 'it moved a moment ago');
});

test('a listing silent past the threshold IS stuck, and carries its counts', () => {
  const h = harness();
  const { project } = stagingListing(h, { bible: false, updatedAt: NOW - 2 * HOUR });

  const [stuck] = h.insights.stuckListings();
  assert.ok(stuck, 'a listing idle for two hours must be reported');
  assert.equal(stuck.projectId, project.id);
  assert.equal(stuck.userId, OWNER);
  assert.equal(stuck.reason, 'blocked', 'it is both idle AND barred; the actionable reason wins');
  assert.equal(stuck.idleMs, 2 * HOUR);
  assert.equal(stuck.queued, 2);
  assert.equal(stuck.blocked, 1, 'and says WHY — one frame will never be claimable');
});

test('the threshold boundary is inclusive, and configurable', () => {
  // `bible: true` so NOTHING is blocked — otherwise the blocked rule would report this
  // listing at any threshold and the test would pass without exercising the clock at all.
  const h = harness();
  stagingListing(h, { bible: true, updatedAt: NOW - DEFAULT_STALE_AFTER_MS });
  assert.equal(h.insights.stuckListings().length, 1, 'exactly at the threshold counts as stuck');
  assert.equal(h.insights.stuckListings({ staleAfterMs: 4 * HOUR }).length, 0,
    'a longer threshold forgives it');
});

test('A BLOCKED LISTING IS REPORTED EVEN WHEN THE WORKER CALLED IT READY', () => {
  // THE CASE THE FIXTURES MISSED, found by running the endpoint against a real server.
  // The worker moves a listing to 'ready' as soon as nothing is CLAIMABLE — and a
  // permanently-barred support frame satisfies that. So the broker sees "ready" while one
  // frame silently never renders, and the status-scoped query this test replaced returned
  // an empty list for exactly the listing an operator most needs to find.
  const h = harness();
  const { project } = stagingListing(h, { bible: false, updatedAt: NOW });
  h.projects.updateProject(project.id, { status: 'ready', now: NOW });

  const [stuck] = h.insights.stuckListings();
  assert.ok(stuck, 'a blocked listing must surface whatever the status column says');
  assert.equal(stuck.projectId, project.id);
  assert.equal(stuck.status, 'ready', 'and the report is honest about that status');
  assert.equal(stuck.reason, 'blocked', 'which tells the operator to regenerate the room');
  assert.equal(stuck.blocked, 1);
});

test('a finished or untouched listing with nothing blocked is NOT reported', () => {
  // The other half: reporting healthy listings would bury the ones that need attention.
  const h = harness();
  for (const status of ['draft', 'ready', 'archived']) {
    const { project } = stagingListing(h, { bible: true, updatedAt: NOW - 2 * HOUR });
    h.projects.updateProject(project.id, { status, now: NOW - 2 * HOUR });
  }
  assert.deepEqual(h.insights.stuckListings(), []);
});

test('blocked listings sort ahead of merely stalled ones', () => {
  // A blocked listing has a known fix; a stalled one needs investigating. The actionable
  // ones go first even when they are more recent.
  const h = harness();
  stagingListing(h, { bible: true, updatedAt: NOW - 9 * HOUR });   // stalled, very old
  const blocked = stagingListing(h, { bible: false, updatedAt: NOW - 1 * HOUR });

  const rows = h.insights.stuckListings();
  assert.equal(rows[0].projectId, blocked.project.id);
  assert.equal(rows[0].reason, 'blocked');
  assert.equal(rows[1].reason, 'stalled');
});

test('stuck listings come back worst-first and are capped', () => {
  const h = harness();
  stagingListing(h, { bible: true, updatedAt: NOW - 2 * HOUR });
  stagingListing(h, { bible: true, updatedAt: NOW - 9 * HOUR });
  stagingListing(h, { bible: true, updatedAt: NOW - 5 * HOUR });

  const idle = h.insights.stuckListings().map((s) => s.idleMs);
  assert.deepEqual(idle, [9 * HOUR, 5 * HOUR, 2 * HOUR], 'longest idle first');
  assert.equal(h.insights.stuckListings({ limit: 2 }).length, 2);
});

test('the report carries ids and counts, never the listing\'s content', () => {
  // It is a support tool, not a window into somebody's property. An operator needs to know
  // WHICH listing, not to read its address out of a dashboard.
  const h = harness();
  const { project } = stagingListing(h, { bible: true, updatedAt: NOW - 2 * HOUR });
  h.projects.updateProject(project.id, { title: '14 Alderbrook Lane', address: 'Boulder, CO', now: NOW - 2 * HOUR });

  const serialized = JSON.stringify(h.insights.health());
  assert.equal(serialized.includes('Alderbrook'), false, 'no title');
  assert.equal(serialized.includes('Boulder'), false, 'no address');
  assert.equal(serialized.includes('storage_key'), false);
  assert.ok(serialized.includes(project.id), 'but the id, so the operator can act');
});

// ── Storage attribution ─────────────────────────────────────────────────────

test('bytes are attributed to the owning account, largest first', async () => {
  const h = harness();
  const small = stagingListing(h, { userId: 'u_small' });
  const big = stagingListing(h, { userId: 'u_big' });
  await h.storage.write(h.storage.keyFor({ projectId: small.project.id, kind: 'out', id: 'a'.repeat(32), ext: 'webp' }), Buffer.alloc(100));
  await h.storage.write(h.storage.keyFor({ projectId: big.project.id, kind: 'out', id: 'b'.repeat(32), ext: 'webp' }), Buffer.alloc(5000));
  await h.storage.write(h.storage.keyFor({ projectId: big.project.id, kind: 'src', id: 'c'.repeat(32), ext: 'webp' }), Buffer.alloc(2000));

  const rows = h.insights.storageByAccount();
  assert.equal(rows[0].userId, 'u_big');
  assert.equal(rows[0].bytes, 7000, 'both src and out count');
  assert.equal(rows[1].userId, 'u_small');
  assert.equal(rows[1].bytes, 100);
});

test('an orphan directory is attributed to NOBODY rather than to a guess', async () => {
  // A project directory with no row belongs to the SWEEP, not this report. Inventing an
  // account for it would put bytes against someone who does not own them.
  const h = harness();
  const mine = stagingListing(h, { userId: 'u_real' });
  await h.storage.write(h.storage.keyFor({ projectId: mine.project.id, kind: 'out', id: 'd'.repeat(32), ext: 'webp' }), Buffer.alloc(50));
  const orphanDir = path.join(h.dir, 'data', 'projects', 'f'.repeat(32), 'out');
  fs.mkdirSync(orphanDir, { recursive: true });
  fs.writeFileSync(path.join(orphanDir, `${'e'.repeat(32)}.webp`), Buffer.alloc(9999));

  const rows = h.insights.storageByAccount();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userId, 'u_real');
  assert.equal(rows[0].bytes, 50, 'the orphan\'s 9999 bytes belong to nobody');
});

test('storage measurement is opt-in, because it walks the whole volume', () => {
  const h = harness();
  stagingListing(h);
  assert.deepEqual(h.insights.health().storage, [], 'not paid for on a routine health check');
  assert.equal(Array.isArray(h.insights.health({ withStorage: true }).storage), true);
});

test('a missing projects directory measures as empty rather than throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-insight-'));
  dirs.push(dir);
  createProjects(dir);
  const insights = createProjectInsights({ baseDir: dir, now: () => NOW });
  assert.deepEqual(insights.storageByAccount(), []);
});
