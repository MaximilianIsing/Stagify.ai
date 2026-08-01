// Tier: unit (real SQLite in a temp dir) — lib/data/project-renders.js, the render QUEUE.
//
// WHY A SECOND FILE ALONGSIDE test/data/projects.test.js
// That file covers the queue's happy lifecycle (claim, complete, fail, reclaim) and the bible
// barrier. This one covers the four statements whose whole job is to LOSE gracefully — the
// cases where a worker's write must be refused rather than applied — because those are the
// ones a fake store cannot stand in for and the ones whose absence was invisible:
//
//   * `attachBible` must not stamp a QUEUED HERO row. It used to stamp every queued render of
//     the room, and the worker read the frame's role off `bible_id`, so a stamped hero was
//     dispatched down the SUPPORT path and staged against a bible extracted from a different
//     frame. The unit-test fake mirrored the behaviour the SQL *should* have had, so the suite
//     asserted an invariant the database did not have and stayed green. Hence: test the SQL.
//   * `complete` / `fail` must MATCH NOTHING when the row is no longer live work. A render
//     finishing after DELETE /api/projects/:id used to be written back as 'ok' (recreating the
//     project directory the delete had removed), because an UPDATE that matches nothing is
//     indistinguishable from one that succeeded unless the statement is guarded.
//   * `requeueRenderForRetry` is the bounded retry: a transient failure has to come BACK, but
//     the budget test lives inside the UPDATE so no caller can loop past it.
//   * `failBlockedRendersForRoom` drains the rows the barrier will never release, without
//     touching the ones it still might.
//
// Runs against a throwaway data dir, so no real project data is touched.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjects, newId } from '../../lib/data/projects.js';
import { closeDb, getDb } from '../../lib/data/db.js';

const T0 = Date.UTC(2026, 6, 29, 9);
const MINUTE = 60 * 1000;
const USER = 'u_renders_1';

/** @type {string[]} */
const dirs = [];

let shaCounter = 0;

/**
 * One listing with a hero and a support frame in room 'living-1' — the shape every barrier
 * question needs.
 * @returns {any} `{ dir, projects, project, hero, support }`.
 */
function roomFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-renders-'));
  dirs.push(dir);
  const projects = createProjects(dir);
  const project = projects.createProject({ userId: USER, title: '9 Elm St', now: T0 });
  const add = (/** @type {any} */ over) => {
    const result = projects.addPhoto({
      projectId: project.id,
      storageKey: `projects/${project.id}/src/${newId()}.webp`,
      sha256: `sha-${(shaCounter += 1)}`,
      roomKey: 'living-1',
      roomType: 'Living room',
      now: T0,
      ...over,
    });
    assert.equal(result.ok, true, 'precondition: addPhoto failed');
    return result.photo;
  };
  return { dir, projects, project, hero: add({ frameRole: 'hero' }), support: add({ frameRole: 'support' }), add };
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    // Windows cannot unlink the .db/-wal/-shm files while the shared handle is open.
    closeDb(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── attachBible must not stamp a hero ────────────────────────────────────────

test('attachBibleToQueuedRenders does NOT stamp a QUEUED HERO render of the room', () => {
  // The assertion the old fake made and the old SQL did not. Revert the `frame_role <> 'hero'`
  // half of BARRED_PHOTOS_IN_ROOM and this fails; every other attach test still passes.
  const { projects, project, hero, support } = roomFixture();
  const heroRender = projects.enqueueRender({ projectId: project.id, photoId: hero.id, now: T0 });
  const supportRender = projects.enqueueRender({ projectId: project.id, photoId: support.id, now: T0 + 1 });
  const bible = projects.createBible({ projectId: project.id, roomKey: 'living-1', doc: { pieces: [] }, roomType: 'r', furnitureStyle: 'f', now: T0 });

  assert.equal(projects.attachBibleToQueuedRenders(project.id, 'living-1', bible.id), 1, 'only the support frame is released');
  assert.equal(projects.getRender(supportRender.id).bibleId, bible.id);
  assert.equal(projects.getRender(heroRender.id).bibleId, null,
    'a hero AUTHORS its room\'s bible and is never conditioned on one — a bible_id here is a lie about how the image was made');
});

test('a second hero variation queued after the bible exists is also left unstamped', () => {
  // The real sequence: the hero renders, the bible lands, and only then is a re-run queued.
  const { projects, project, hero, support } = roomFixture();
  projects.enqueueRender({ projectId: project.id, photoId: support.id, now: T0 });
  const bible = projects.createBible({ projectId: project.id, roomKey: 'living-1', doc: { pieces: [] }, roomType: 'r', furnitureStyle: 'f', now: T0 });
  const rerun = projects.enqueueRender({ projectId: project.id, photoId: hero.id, variation: 2, now: T0 + MINUTE });

  projects.attachBibleToQueuedRenders(project.id, 'living-1', bible.id);
  assert.equal(projects.getRender(rerun.id).bibleId, null);
  // And leaving it unstamped costs it nothing: heroes were never barred in the first place,
  // so it is claimable on its own terms.
  const claimed = [projects.claimNextRender({ now: T0 + 2 * MINUTE }), projects.claimNextRender({ now: T0 + 2 * MINUTE })];
  assert.ok(claimed.some((r) => r && r.id === rerun.id), 'the unstamped hero re-run still runs');
  assert.equal(projects.progressFor(project.id).queued, 0);
});

// ── complete / fail must lose the race ───────────────────────────────────────

test('completeRender returns null when the row was DELETED mid-render', () => {
  // The GDPR hole: the worker had already written the blob, and a null it ignored meant a
  // staged photo of a deleted listing stayed on disk with nothing referencing it.
  const { dir, projects, project, hero } = roomFixture();
  projects.enqueueRender({ projectId: project.id, photoId: hero.id, now: T0 });
  const claimed = projects.claimNextRender({ now: T0 });
  getDb(dir).prepare('DELETE FROM renders WHERE id = ?').run(claimed.id);

  assert.equal(projects.completeRender(claimed.id, { storageKey: 'projects/x/out/y.webp', now: T0 + MINUTE }), null);
  assert.equal(projects.getRender(claimed.id), null, 'and it is not resurrected');
});

test('completeRender refuses a render a newer bible already SUPERSEDED', () => {
  const { projects, project, hero } = roomFixture();
  const first = projects.enqueueRender({ projectId: project.id, photoId: hero.id, now: T0 });
  const claimed = projects.claimNextRender({ now: T0 });
  projects.completeRender(claimed.id, { storageKey: 'k1', now: T0 });
  assert.equal(projects.supersedeRendersForRoom(project.id, 'living-1', { now: T0 }), 1);

  assert.equal(projects.completeRender(first.id, { storageKey: 'k2', now: T0 + MINUTE }), null,
    'a retired render must not be republished by a late arrival');
  const row = projects.getRender(first.id);
  assert.equal(row.status, 'superseded');
  assert.equal(row.storageKey, 'k1', 'and its stored key is untouched');
});

test('failRender also loses the race rather than rewriting a settled row', () => {
  const { dir, projects, project, hero } = roomFixture();
  const gone = projects.enqueueRender({ projectId: project.id, photoId: hero.id, now: T0 });
  const published = projects.enqueueRender({ projectId: project.id, photoId: hero.id, variation: 2, now: T0 + 1 });
  projects.claimNextRender({ now: T0 });
  projects.claimNextRender({ now: T0 });
  projects.completeRender(published.id, { storageKey: 'k', now: T0 });
  getDb(dir).prepare('DELETE FROM renders WHERE id = ?').run(gone.id);

  assert.equal(projects.failRender(gone.id, { errorCode: 'X', now: T0 }), null, 'a deleted row cannot be failed');
  assert.equal(projects.failRender(published.id, { errorCode: 'X', now: T0 }), null, 'a published render cannot be un-published');
  assert.equal(projects.getRender(published.id).status, 'ok');
});

// ── The bounded retry ────────────────────────────────────────────────────────

test('requeueRenderForRetry puts a failed attempt back until the budget is spent', () => {
  const { projects, project, hero } = roomFixture();
  const render = projects.enqueueRender({ projectId: project.id, photoId: hero.id, now: T0 });
  projects.claimNextRender({ now: T0 });

  const first = projects.requeueRenderForRetry(render.id, { errorCode: 'MODEL_UNAVAILABLE', durationMs: 400, maxAttempts: 3, now: T0 + MINUTE });
  assert.equal(first.status, 'queued', 'back on the queue — nothing else ever requeues a failure');
  assert.equal(first.claimedAt, null, 'and its lease is gone, so it is claimable now, not in ten minutes');
  assert.equal(first.genAttempts, 1, 'the attempt is counted, or the retry loops forever');
  assert.equal(first.errorCode, 'MODEL_UNAVAILABLE', 'the last reason stays visible while it waits');
  assert.equal(projects.getProject(project.id).updatedAt, T0 + MINUTE);

  assert.equal(projects.requeueRenderForRetry(render.id, { errorCode: 'MODEL_UNAVAILABLE', maxAttempts: 3 }).genAttempts, 2);
  assert.equal(projects.requeueRenderForRetry(render.id, { errorCode: 'MODEL_UNAVAILABLE', maxAttempts: 3 }), null,
    'the third attempt has nowhere left to go — the caller must fail it terminally');
  const row = projects.getRender(render.id);
  assert.equal(row.genAttempts, 2, 'a declined requeue does NOT count an attempt, so failRender counting it is exactly once');
  assert.equal(row.status, 'queued', 'and it is not silently failed behind the caller\'s back');
});

test('the retry BUDGET is enforced by the statement, not by the caller', () => {
  // The test lives in the UPDATE next to the increment it guards, so two workers cannot both
  // read gen_attempts as 2 and both decide there is one try left.
  const { projects, project, hero } = roomFixture();
  const render = projects.enqueueRender({ projectId: project.id, photoId: hero.id, now: T0 });
  for (let i = 0; i < 10; i += 1) projects.requeueRenderForRetry(render.id, { errorCode: 'X', maxAttempts: 3 });
  assert.equal(projects.getRender(render.id).genAttempts, 2, 'ten calls, two attempts');

  // A missing/absurd budget must not become an unbounded one: every attempt is a paid call.
  const other = projects.enqueueRender({ projectId: project.id, photoId: hero.id, variation: 2, now: T0 });
  assert.equal(projects.requeueRenderForRetry(other.id, { errorCode: 'X' }), null, 'no budget means no retry');
  assert.equal(projects.requeueRenderForRetry(other.id, { errorCode: 'X', maxAttempts: 0 }), null);
  assert.equal(projects.getRender(other.id).genAttempts, 0);
});

test('requeueRenderForRetry cannot resurrect a deleted or superseded render', () => {
  const { dir, projects, project, hero } = roomFixture();
  const gone = projects.enqueueRender({ projectId: project.id, photoId: hero.id, now: T0 });
  getDb(dir).prepare("UPDATE renders SET status = 'superseded' WHERE id = ?").run(gone.id);
  assert.equal(projects.requeueRenderForRetry(gone.id, { errorCode: 'X', maxAttempts: 3 }), null);
  assert.equal(projects.requeueRenderForRetry('ghost', { errorCode: 'X', maxAttempts: 3 }), null);
});

// ── Draining what the barrier will never release ─────────────────────────────

test('failBlockedRendersForRoom drains the rows no bible will ever unblock', () => {
  const { projects, project, hero, support, add } = roomFixture();
  const kitchen = add({ roomKey: 'kitchen-1', frameRole: 'support' });
  const blocked = projects.enqueueRender({ projectId: project.id, photoId: support.id, now: T0 });
  const heroQueued = projects.enqueueRender({ projectId: project.id, photoId: hero.id, now: T0 });
  const elsewhere = projects.enqueueRender({ projectId: project.id, photoId: kitchen.id, now: T0 });

  assert.equal(projects.progressFor(project.id).blocked, 2, 'both support frames are barred to begin with');
  assert.equal(projects.failBlockedRendersForRoom(project.id, 'living-1', { errorCode: 'BIBLE_MISSING', now: T0 + MINUTE }), 1);

  const row = projects.getRender(blocked.id);
  assert.equal(row.status, 'failed');
  assert.equal(row.errorCode, 'BIBLE_MISSING');
  assert.equal(row.genAttempts, 0, 'nothing was ever attempted — the room simply had no bible to attempt it against');
  assert.equal(projects.getRender(heroQueued.id).status, 'queued', 'a queued HERO is claimable and must be left to run');
  assert.equal(projects.getRender(elsewhere.id).status, 'queued', 'another room keeps its blocked row');
  assert.equal(projects.progressFor(project.id).blocked, 1, 'this room stopped counting as pending');
  assert.equal(projects.getProject(project.id).updatedAt, T0 + MINUTE);
});

test('failBlockedRendersForRoom leaves a row that a bible DID reach, and is idempotent', () => {
  const { projects, project, support } = roomFixture();
  const render = projects.enqueueRender({ projectId: project.id, photoId: support.id, now: T0 });
  const bible = projects.createBible({ projectId: project.id, roomKey: 'living-1', doc: { pieces: [] }, roomType: 'r', furnitureStyle: 'f', now: T0 });
  projects.attachBibleToQueuedRenders(project.id, 'living-1', bible.id);

  assert.equal(projects.failBlockedRendersForRoom(project.id, 'living-1', { now: T0 }), 0, 'it is not blocked — it is waiting its turn');
  assert.equal(projects.getRender(render.id).status, 'queued');
  assert.equal(projects.failBlockedRendersForRoom(project.id, 'no-such-room', { now: T0 }), 0);
  assert.equal(projects.failBlockedRendersForRoom(project.id, null, { now: T0 }), 0);
});

test('a blocked room drains: queued goes to zero and the frame is reported as failed', () => {
  // The stuck state end-to-end: the hero is done, its bible never arrived, and the room's
  // support row is unclaimable forever. `hasPendingWork` already reads false here — it asks
  // what a WORKER could pick up — but `queued` stayed non-zero, and `queued` is what the
  // studio polls on, so the listing looked busy indefinitely and /stage answered 409.
  const { projects, project, hero, support } = roomFixture();
  projects.enqueueRender({ projectId: project.id, photoId: hero.id, now: T0 });
  projects.enqueueRender({ projectId: project.id, photoId: support.id, now: T0 + 1 });
  const claimed = projects.claimNextRender({ now: T0 });
  projects.completeRender(claimed.id, { storageKey: 'k', now: T0 });
  const stuck = projects.progressFor(project.id);
  assert.equal(stuck.queued, 1, 'the barred row still counts as queued work the UI is waiting on');
  assert.equal(stuck.blocked, 1, 'and nothing will ever claim it');

  projects.failBlockedRendersForRoom(project.id, 'living-1', { errorCode: 'BIBLE_MISSING', now: T0 });
  assert.equal(projects.hasPendingWork(project.id), false);
  const progress = projects.progressFor(project.id);
  assert.equal(progress.queued, 0, 'the queue is drained');
  assert.equal(progress.blocked, 0);
  assert.equal(progress.failed, 1, 'reported honestly as a failed frame, not as pending forever');
  assert.equal(progress.ok + progress.failed, progress.total, 'every frame has an answer');
});

// ── extra_json ───────────────────────────────────────────────────────────────

test('completeRender persists `extra` as a JSON object and leaves it alone when omitted', () => {
  const { projects, project, hero } = roomFixture();
  projects.enqueueRender({ projectId: project.id, photoId: hero.id, now: T0 });
  const claimed = projects.claimNextRender({ now: T0 });

  const done = projects.completeRender(claimed.id, {
    storageKey: 'k', consistencyScore: 62, extra: { mismatchedSlots: ['sofa', 'rug'] }, now: T0,
  });
  // An object, not a bare array: extra_json is a bag other fields will join.
  assert.deepEqual(done.extra, { mismatchedSlots: ['sofa', 'rug'] });
  assert.deepEqual(projects.getRender(claimed.id).extra, { mismatchedSlots: ['sofa', 'rug'] }, 'and it survives the round trip');

  // A later write with no `extra` must not blank it.
  const again = projects.enqueueRender({ projectId: project.id, photoId: hero.id, variation: 2, now: T0 });
  projects.claimNextRender({ now: T0 });
  assert.equal(projects.completeRender(again.id, { storageKey: 'k2', now: T0 }).extra, null, 'absent reads as null');
  assert.deepEqual(projects.getRender(claimed.id).extra, { mismatchedSlots: ['sofa', 'rug'] }, 'the first render kept its own bag');
});
