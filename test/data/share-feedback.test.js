// Tier: unit (real SQLite in a temp dir) — lib/data/share-feedback.js.
//
// WHAT THIS COVERS, AND WHY
// These rows are written by ANONYMOUS callers holding a share link, so the properties worth
// pinning are the ones that bound what a leaked URL can do to the volume the database and
// every customer's photographs live on:
//
//   - THE CEILINGS ARE IN THE STORE, NOT THE ROUTE. A second route, or a refactor of the
//     one that exists, must not be able to write an unbounded row — so the note clamp, the
//     verdict allowlist and the per-share cap are all asserted here, against the store's own
//     API, rather than through an HTTP surface that could be bypassed.
//   - THE CAP CANNOT BE RACED. It is checked inside the insert's transaction; the test that
//     matters is that filling to the limit and pushing once more leaves the row count
//     unchanged, not merely that the call reports a refusal.
//   - "LATEST WINS" IS A REDUCTION, NOT AN UPDATE. Rows are append-only so a broker keeps
//     the note explaining why a room was re-rendered, while `latestByRoom` still answers
//     with the current verdict. Both halves are asserted, because an implementation that
//     updated in place would satisfy the second on its own.
//   - NOTHING IDENTIFIES THE VIEWER. The stored shape is checked field by field, because
//     the failure here is silent: an added column would simply start collecting data from
//     people who never agreed to anything.
//
// Runs against a throwaway data dir, so no real data is touched.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createShareFeedback,
  clampNote,
  FEEDBACK_VERDICTS,
  MAX_NOTE,
  MAX_VIEWER_LABEL,
  MAX_PER_SHARE,
} from '../../lib/data/share-feedback.js';
import { createProjects } from '../../lib/data/projects.js';
import { closeDb } from '../../lib/data/db.js';

const T0 = Date.UTC(2026, 6, 30, 12);
const OWNER = 'u_broker_1';
const SHARE = 's_link_1';
const PROJECT = 'p_listing_1';

const dirs = [];

/** A feedback store on a fresh data dir. */
function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-fb-'));
  dirs.push(dir);
  return { dir, feedback: createShareFeedback(dir) };
}

/** Record one response with the fixture's ids. */
function add(feedback, over = {}) {
  return feedback.addFeedback({
    shareId: SHARE, projectId: PROJECT, userId: OWNER,
    roomKey: 'living-room-1', verdict: 'approved', now: T0, ...over,
  });
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    // Windows cannot unlink the .db/-wal/-shm files while the shared handle is open.
    closeDb(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── What gets stored ────────────────────────────────────────────────────────

test('a response stores the answer and nothing that identifies the viewer', () => {
  const { feedback } = store();
  const result = add(feedback, { verdict: 'changes', note: 'Sofa is too big for that wall', viewerLabel: 'Dana' });
  assert.equal(result.ok, true);

  const row = result.ok ? result.feedback : null;
  // Field by field rather than a snapshot: the failure mode is an ADDED field quietly
  // collecting data from people who never agreed to anything, and a snapshot of the fields
  // that exist today would not notice one.
  assert.deepEqual(Object.keys(row).sort(), [
    'createdAt', 'id', 'note', 'projectId', 'roomKey', 'shareId', 'userId', 'verdict', 'viewerLabel',
  ]);
  assert.equal(row.verdict, 'changes');
  assert.equal(row.note, 'Sofa is too big for that wall');
  assert.equal(row.viewerLabel, 'Dana');
  assert.equal(row.userId, OWNER, 'the user is the listing OWNER, never the viewer');
  assert.equal(row.createdAt, T0);
});

test('the viewer may stay anonymous', () => {
  const { feedback } = store();
  const result = add(feedback, { viewerLabel: undefined, note: undefined });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.feedback.viewerLabel, '', 'never null or "undefined"');
  assert.equal(result.ok && result.feedback.note, '');
});

test('whole-listing feedback keeps a null room rather than a sentinel string', () => {
  const { feedback } = store();
  for (const empty of [null, undefined, '']) {
    const result = add(feedback, { roomKey: empty });
    assert.equal(result.ok && result.feedback.roomKey, null, `roomKey ${String(empty)} must normalize to null`);
  }
});

// ── The ceilings ────────────────────────────────────────────────────────────

test('the verdict is an allowlist, not a caller-supplied string', () => {
  const { feedback } = store();
  for (const bad of ['', 'APPROVED', 'approve', 'rejected', 'DROP TABLE', null, 7, {}]) {
    const result = add(feedback, { verdict: /** @type {any} */ (bad) });
    assert.deepEqual(result, { ok: false, code: 'BAD_VERDICT' }, `verdict ${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(feedback.count(), 0, 'a refused verdict must not write a row');
  for (const good of FEEDBACK_VERDICTS) {
    assert.equal(add(feedback, { verdict: good }).ok, true);
  }
});

test('free text is clamped and collapsed, not rejected', () => {
  // Rejecting a long note loses what someone typed. Clamping keeps the useful part, and the
  // UI shows a counter so it is not a surprise.
  const { feedback } = store();
  const result = add(feedback, {
    verdict: 'changes',
    note: `${'x'.repeat(MAX_NOTE + 400)}`,
    viewerLabel: 'y'.repeat(MAX_VIEWER_LABEL + 100),
  });
  assert.equal(result.ok, true, 'over-long text is clamped, never a refusal');
  assert.equal(result.ok && result.feedback.note.length, MAX_NOTE);
  assert.equal(result.ok && result.feedback.viewerLabel.length, MAX_VIEWER_LABEL);
});

test('clampNote collapses whitespace so a wall of newlines cannot flood the broker\'s panel', () => {
  assert.equal(clampNote('  a\n\n\n\nb\t\tc  ', 100), 'a b c');
  assert.equal(clampNote('\n'.repeat(400), 100), '');
  assert.equal(clampNote(null, 100), '');
  assert.equal(clampNote(42, 100), '', 'a non-string is empty, not "42"');
});

test('a share link cannot collect more than its allowance, and the cap cannot be raced past', () => {
  const { feedback } = store();
  for (let i = 0; i < MAX_PER_SHARE; i += 1) {
    assert.equal(add(feedback, { now: T0 + i }).ok, true, `response ${i} should fit`);
  }
  assert.deepEqual(feedback.allowanceFor(SHARE), { used: MAX_PER_SHARE, limit: MAX_PER_SHARE, full: true });

  const overflow = add(feedback, { now: T0 + MAX_PER_SHARE });
  assert.deepEqual(overflow, { ok: false, code: 'FULL' });
  // The refusal has to be a REFUSAL, not a reported one: the check and the insert share a
  // transaction precisely so the row count is the assertion, not the return value.
  assert.equal(feedback.count(), MAX_PER_SHARE, 'the refused write must not have landed');

  // A different link has its own allowance — the cap is per share, not per listing, so
  // rotating the link is also how a broker gets a fresh one.
  assert.equal(add(feedback, { shareId: 's_link_2' }).ok, true);
});

test('a response with no share or project is refused outright', () => {
  const { feedback } = store();
  assert.deepEqual(add(feedback, { shareId: '' }), { ok: false, code: 'MISSING_SHARE' });
  assert.deepEqual(add(feedback, { projectId: '' }), { ok: false, code: 'MISSING_SHARE' });
  assert.equal(feedback.count(), 0);
});

// ── Reading it back ─────────────────────────────────────────────────────────

test('latestByRoom answers with the current verdict while the history survives', () => {
  const { feedback } = store();
  add(feedback, { verdict: 'changes', note: 'Too blue', now: T0 });
  add(feedback, { verdict: 'approved', note: 'Perfect now', now: T0 + 1000 });
  add(feedback, { roomKey: 'bedroom-1', verdict: 'changes', note: 'Smaller bed', now: T0 + 2000 });
  add(feedback, { roomKey: null, verdict: 'approved', note: 'Whole place looks great', now: T0 + 3000 });

  const latest = feedback.latestByRoom(SHARE);
  assert.equal(latest.get('living-room-1')?.verdict, 'approved', 'the newer answer wins');
  assert.equal(latest.get('living-room-1')?.note, 'Perfect now');
  assert.equal(latest.get('bedroom-1')?.verdict, 'changes');
  assert.equal(latest.get('')?.note, 'Whole place looks great',
    'whole-listing feedback is keyed under "" so it cannot collide with a real room');
  assert.equal(latest.size, 3);

  // …and the superseded note is still on record, which is what a broker wants when they
  // wonder why a room was re-rendered.
  const all = feedback.listForProject(PROJECT);
  assert.equal(all.length, 4, 'rows are append-only — nothing is updated in place');
  assert.ok(all.some((f) => f.note === 'Too blue'));
  assert.deepEqual(all.map((f) => f.createdAt), [T0 + 3000, T0 + 2000, T0 + 1000, T0], 'newest first');
});

test('latestByRoom is scoped to ONE link, so a rotated link starts clean', () => {
  // Otherwise the person holding today's link reads what the previous holder wrote.
  const { feedback } = store();
  add(feedback, { shareId: 's_old', verdict: 'changes', note: 'Old holder said this' });
  add(feedback, { shareId: 's_new', verdict: 'approved' });

  assert.equal(feedback.latestByRoom('s_new').get('living-room-1')?.note, '');
  assert.equal(feedback.latestByRoom('s_old').get('living-room-1')?.note, 'Old holder said this');
  // The OWNER still sees both — it is their listing and their history.
  assert.equal(feedback.listForProject(PROJECT).length, 2);
});

test('listForProject is scoped to one listing', () => {
  const { feedback } = store();
  add(feedback, { projectId: 'p_a' });
  add(feedback, { projectId: 'p_b' });
  assert.equal(feedback.listForProject('p_a').length, 1);
  assert.equal(feedback.listForProject('p_a')[0].projectId, 'p_a');
});

// ── Cascades ────────────────────────────────────────────────────────────────

test('deleting a listing takes its feedback with it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-fb-'));
  dirs.push(dir);
  const projects = createProjects(dir);
  const project = projects.createProject({ userId: OWNER, title: '12 Oak St', now: T0 });
  const share = projects.shares.createShare({ projectId: project.id, userId: OWNER, now: T0 });
  projects.feedback.addFeedback({
    shareId: share.share.id, projectId: project.id, userId: OWNER,
    roomKey: 'living-room-1', verdict: 'changes', note: 'private note', now: T0,
  });

  const removed = projects.deleteProject(project.id);
  assert.equal(removed.feedback, 1, 'deleteProject must report the responses it removed');
  assert.equal(projects.feedback.listForProject(project.id).length, 0);
  assert.equal(projects.feedback.count(), 0);
});

test('erasing a user takes every response across every listing, including orphans', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-fb-'));
  dirs.push(dir);
  const projects = createProjects(dir);
  const a = projects.createProject({ userId: OWNER, title: 'A', now: T0 });
  const base = { userId: OWNER, roomKey: null, verdict: 'approved', now: T0 };
  projects.feedback.addFeedback({ ...base, shareId: 's1', projectId: a.id });
  // A response whose project row is already gone — the per-project loop cannot reach it, so
  // it is exactly what the by-user sweep exists for.
  projects.feedback.addFeedback({ ...base, shareId: 's2', projectId: 'p_vanished' });

  const totals = projects.deleteProjectsForUser(OWNER);
  assert.equal(totals.feedback, 2, 'the by-user sweep must reach the orphan too');
  assert.equal(projects.feedback.count(), 0);
});

test("another user's feedback survives an unrelated erasure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-fb-'));
  dirs.push(dir);
  const projects = createProjects(dir);
  const theirs = projects.createProject({ userId: 'u_someone_else', title: 'Theirs', now: T0 });
  projects.feedback.addFeedback({
    shareId: 's_theirs', projectId: theirs.id, userId: 'u_someone_else',
    roomKey: null, verdict: 'approved', now: T0,
  });

  projects.createProject({ userId: OWNER, title: 'Mine', now: T0 });
  projects.deleteProjectsForUser(OWNER);

  assert.equal(projects.feedback.listForProject(theirs.id).length, 1,
    'the sweep is keyed on the erased account, not on the whole table');
});
