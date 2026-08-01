// Tier: unit (real SQLite in a temp dir) — lib/data/project-shares.js.
//
// WHAT THIS COVERS, AND WHY THESE ASSERTIONS AND NOT OTHERS
// A share row is the key to an UNAUTHENTICATED URL into a customer's listing, so the
// properties worth pinning are the ones whose failure is a security incident rather than
// a bug:
//
//   - THE TOKEN IS NEVER RECOVERABLE. `createShare` is the only function that has ever
//     seen the plaintext, and no other function returns anything derived from it. The test
//     for this greps the SERIALIZED database file for the token, which is the only form of
//     the assertion that a future refactor cannot quietly satisfy — checking that some
//     mapper omits a field passes the moment someone adds a different one.
//   - RESOLUTION IS FAIL-CLOSED at every axis: unknown, revoked, expired, and empty each
//     refuse, and the boundary of `expiresAt` is inclusive (a link expiring exactly now is
//     dead, not alive).
//   - ROTATION IS ATOMIC AND TOTAL: minting a second link kills the first one in the same
//     breath, so a listing never has two live doors.
//   - REVOCATION IS A STATE CHANGE, NOT A DELETE — the audit trail (view counts on a link
//     the broker has already killed) is the point of the table having a `revoked_at`
//     column instead of a DELETE.
//   - THE VIEW DEBOUNCE, because the count is shown to a broker as "your seller opened
//     this", and an inflated number is a lie in the direction that flatters us.
//
// Runs against a throwaway data dir, so no real data is touched.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createProjectShares,
  normalizeShareSettings,
  newShareToken,
  SHARE_TOKEN_BYTES,
  VIEW_DEBOUNCE_MS,
} from '../../lib/data/project-shares.js';
import { createProjects } from '../../lib/data/projects.js';
import { closeDb } from '../../lib/data/db.js';

const T0 = Date.UTC(2026, 6, 30, 12);
const DAY = 24 * 60 * 60 * 1000;
const USER = 'u_broker_1';
const PROJECT = 'p_listing_1';

const dirs = [];

/** A share store on a fresh data dir. */
function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-share-'));
  dirs.push(dir);
  return { dir, shares: createProjectShares(dir) };
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    // Windows cannot unlink the .db/-wal/-shm files while the shared handle is open.
    closeDb(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── The token ───────────────────────────────────────────────────────────────

test('a minted token is CSPRNG base64url of the declared width', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) {
    const token = newShareToken();
    assert.match(token, /^[A-Za-z0-9_-]+$/, 'base64url only — it is one URL path segment');
    // 32 bytes base64url-encodes to 43 characters with no padding.
    assert.equal(token.length, Math.ceil((SHARE_TOKEN_BYTES * 8) / 6));
    seen.add(token);
  }
  assert.equal(seen.size, 50, 'tokens must not repeat');
});

test('the plaintext token never reaches the database file', () => {
  const { dir, shares } = store();
  const { token } = shares.createShare({ projectId: PROJECT, userId: USER, now: T0 });

  // Read what is actually ON DISK rather than what a mapper chose to return. This is the
  // assertion that survives a refactor: if someone stores the raw token in a new column,
  // in the settings bag, or in a log-shaped audit row, this fails and the field-by-field
  // checks below would not.
  closeDb(dir);
  // `resolveDataDir` decides where the file actually lands, so walk rather than guess.
  const files = fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((rel) => path.join(dir, String(rel)))
    .filter((abs) => path.basename(abs).startsWith('auth-store.db') && fs.statSync(abs).isFile());
  assert.ok(files.length, 'precondition: the database file should exist');
  for (const file of files) {
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.includes(token), false, `${path.basename(file)} contains the raw share token`);
  }
});

test('no read-back path returns the token', () => {
  const { shares } = store();
  const { token, share } = shares.createShare({ projectId: PROJECT, userId: USER, now: T0 });

  const surfaces = {
    active: shares.activeShareFor(PROJECT),
    history: shares.listSharesFor(PROJECT),
    resolved: shares.resolveShare(token, T0),
    updated: shares.updateShare(share.id, { settings: { headline: 'Hi' } }),
  };
  assert.equal(JSON.stringify(surfaces).includes(token), false,
    'a read surface leaked the plaintext token');
});

// ── Resolution ──────────────────────────────────────────────────────────────

test('resolveShare accepts a live token and refuses every other state', () => {
  const { shares } = store();
  const { token, share } = shares.createShare({ projectId: PROJECT, userId: USER, now: T0 });

  const live = shares.resolveShare(token, T0);
  assert.equal(live.ok, true);
  assert.equal(live.ok && live.share.id, share.id);

  assert.deepEqual(shares.resolveShare('', T0), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(shares.resolveShare('not-a-real-token', T0), { ok: false, code: 'NOT_FOUND' });
  // A token that differs in one character must not resolve — i.e. the lookup is on the
  // whole digest, not a prefix.
  assert.deepEqual(shares.resolveShare(`${token.slice(0, -1)}x`, T0), { ok: false, code: 'NOT_FOUND' });

  shares.revokeSharesFor(PROJECT, T0 + 1);
  assert.deepEqual(shares.resolveShare(token, T0 + 2), { ok: false, code: 'REVOKED' });
});

test('expiry is inclusive — a link expiring exactly now is already dead', () => {
  const { shares } = store();
  const { token } = shares.createShare({ projectId: PROJECT, userId: USER, expiresAt: T0 + DAY, now: T0 });

  assert.equal(shares.resolveShare(token, T0 + DAY - 1).ok, true, 'still live a millisecond before');
  assert.deepEqual(shares.resolveShare(token, T0 + DAY), { ok: false, code: 'EXPIRED' },
    'the expiry instant itself must be dead, not the last live moment');
  assert.deepEqual(shares.resolveShare(token, T0 + DAY + 1), { ok: false, code: 'EXPIRED' });
});

test('a share with no expiry stays live indefinitely', () => {
  const { shares } = store();
  const { token, share } = shares.createShare({ projectId: PROJECT, userId: USER, now: T0 });
  assert.equal(share.expiresAt, null);
  assert.equal(shares.resolveShare(token, T0 + 3650 * DAY).ok, true);
});

// ── Rotation and revocation ─────────────────────────────────────────────────

test('minting a second link rotates the first out atomically', () => {
  const { shares } = store();
  const first = shares.createShare({ projectId: PROJECT, userId: USER, now: T0 });
  const second = shares.createShare({ projectId: PROJECT, userId: USER, now: T0 + 1000 });

  assert.notEqual(first.token, second.token);
  assert.equal(second.replaced, 1, 'the previous link should be reported as rotated out');
  assert.equal(shares.resolveShare(first.token, T0 + 2000).ok, false, 'the old link must be dead');
  assert.equal(shares.resolveShare(second.token, T0 + 2000).ok, true);

  const active = shares.activeShareFor(PROJECT);
  assert.equal(active?.id, second.share.id, 'exactly one live link per listing');
});

test('revocation keeps the row, and its view history, as an audit trail', () => {
  const { shares } = store();
  const { token, share } = shares.createShare({ projectId: PROJECT, userId: USER, now: T0 });
  shares.recordView(share.id, T0 + 1000, null);
  shares.recordView(share.id, T0 + 1000 + VIEW_DEBOUNCE_MS, T0 + 1000);

  assert.equal(shares.revokeSharesFor(PROJECT, T0 + 5000), 1);
  assert.equal(shares.resolveShare(token, T0 + 6000).ok, false);

  const history = shares.listSharesFor(PROJECT);
  assert.equal(history.length, 1, 'revoking must not delete the row');
  assert.equal(history[0].revokedAt, 5000 + T0);
  assert.equal(history[0].viewCount, 2, 'the broker keeps the count from before the revoke');
  assert.equal(shares.activeShareFor(PROJECT), null);
});

test('revoking twice is idempotent rather than an error', () => {
  const { shares } = store();
  shares.createShare({ projectId: PROJECT, userId: USER, now: T0 });
  assert.equal(shares.revokeSharesFor(PROJECT, T0 + 1), 1);
  assert.equal(shares.revokeSharesFor(PROJECT, T0 + 2), 0);
});

test('revokeShare targets one row without touching another listing', () => {
  const { shares } = store();
  const mine = shares.createShare({ projectId: PROJECT, userId: USER, now: T0 });
  const other = shares.createShare({ projectId: 'p_other', userId: USER, now: T0 });

  assert.equal(shares.revokeShare(mine.share.id, T0 + 1), 1);
  assert.equal(shares.resolveShare(other.token, T0 + 2).ok, true, 'a sibling listing is unaffected');
  assert.equal(shares.revokeShare(mine.share.id, T0 + 3), 0, 'already revoked');
});

// ── Settings ────────────────────────────────────────────────────────────────

test('normalizeShareSettings is an allowlist that defaults before/after ON', () => {
  const clean = normalizeShareSettings({
    showBefore: undefined,
    headline: '  Sunny two-bed  ',
    secretInternalFlag: 'should not survive',
    agentEmail: 'agent@example.com',
  });
  assert.equal(clean.showBefore, true, 'the before/after pair is the persuasive point; default it on');
  assert.equal(clean.headline, 'Sunny two-bed', 'trimmed');
  assert.equal(clean.agentEmail, 'agent@example.com');
  assert.equal('secretInternalFlag' in clean, false, 'unknown keys must be dropped, not stored');
  // Non-strings collapse to '' rather than to "undefined"/"[object Object]" on the page.
  assert.equal(normalizeShareSettings({ headline: { toString: () => 'x' } }).headline, '');
  assert.equal(normalizeShareSettings(null).showBefore, true);
  assert.equal(normalizeShareSettings('nonsense').headline, '');
});

test('settings are clamped so a published field cannot be unbounded', () => {
  const clean = normalizeShareSettings({ headline: 'h'.repeat(500), note: 'n'.repeat(5000) });
  assert.ok(clean.headline.length <= 120);
  assert.ok(clean.note.length <= 600);
});

test('updateShare replaces settings but leaves the token and, by default, the expiry', () => {
  const { shares } = store();
  const { token, share } = shares.createShare({
    projectId: PROJECT, userId: USER, expiresAt: T0 + 30 * DAY, now: T0,
    settings: { headline: 'First', agentName: 'Dana' },
  });

  const updated = shares.updateShare(share.id, { settings: { headline: 'Second' } });
  assert.equal(updated?.settings.headline, 'Second');
  assert.equal(updated?.settings.agentName, '', 'settings are replaced wholesale, not merged');
  assert.equal(updated?.expiresAt, T0 + 30 * DAY,
    'omitting expiresAt must not silently un-expire a time-boxed link');
  assert.equal(shares.resolveShare(token, T0 + DAY).ok, true, 'the link the broker already sent still works');

  assert.equal(shares.updateShare(share.id, { settings: {}, expiresAt: null })?.expiresAt, null,
    'an explicit null clears the expiry');
  assert.equal(shares.updateShare('no-such-share', {}), null);
});

// ── Views ───────────────────────────────────────────────────────────────────

test('views are counted once per debounce window', () => {
  const { shares } = store();
  const { share } = shares.createShare({ projectId: PROJECT, userId: USER, now: T0 });

  assert.equal(shares.recordView(share.id, T0 + 10, null), true, 'the first view always counts');
  assert.equal(shares.recordView(share.id, T0 + 20, T0 + 10), false, 'a reload inside the window does not');
  assert.equal(shares.recordView(share.id, T0 + 10 + VIEW_DEBOUNCE_MS, T0 + 10), true,
    'the window boundary itself counts — the debounce is exclusive');

  const seen = shares.listSharesFor(PROJECT)[0];
  assert.equal(seen.viewCount, 2);
  assert.equal(seen.lastViewedAt, T0 + 10 + VIEW_DEBOUNCE_MS);
});

// ── Cascades ────────────────────────────────────────────────────────────────

test('deleting a listing takes its share links with it, in the same call', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-share-'));
  dirs.push(dir);
  const projects = createProjects(dir);
  const project = projects.createProject({ userId: USER, title: '12 Oak St', now: T0 });
  const { token } = projects.shares.createShare({ projectId: project.id, userId: USER, now: T0 });

  assert.equal(projects.shares.resolveShare(token, T0).ok, true, 'precondition: the link works');
  const removed = projects.deleteProject(project.id);

  assert.equal(removed.shares, 1, 'deleteProject must report the links it killed');
  assert.equal(projects.shares.resolveShare(token, T0 + 1).ok, false,
    'a link surviving its listing is a live URL into deleted data');
  assert.equal(projects.shares.listSharesFor(project.id).length, 0);
});

test('erasing a user takes every share of every listing, including orphans', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-share-'));
  dirs.push(dir);
  const projects = createProjects(dir);
  const a = projects.createProject({ userId: USER, title: 'A', now: T0 });
  const b = projects.createProject({ userId: USER, title: 'B', now: T0 });
  const tokens = [
    projects.shares.createShare({ projectId: a.id, userId: USER, now: T0 }).token,
    projects.shares.createShare({ projectId: b.id, userId: USER, now: T0 }).token,
    // A share whose project row is already gone. The per-project loop cannot reach this,
    // so it is exactly what the by-user sweep exists for — and it is the shape a partial
    // failure would leave behind.
    projects.shares.createShare({ projectId: 'p_vanished', userId: USER, now: T0 }).token,
  ];

  const totals = projects.deleteProjectsForUser(USER);
  assert.equal(totals.projects, 2);
  assert.equal(totals.shares, 3, 'the by-user sweep must reach the orphan too');
  for (const token of tokens) {
    assert.equal(projects.shares.resolveShare(token, T0 + 1).ok, false,
      'no link may survive an erasure request');
  }
});

test("another user's shares survive an unrelated erasure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-share-'));
  dirs.push(dir);
  const projects = createProjects(dir);
  const theirs = projects.createProject({ userId: 'u_someone_else', title: 'Theirs', now: T0 });
  const kept = projects.shares.createShare({ projectId: theirs.id, userId: 'u_someone_else', now: T0 });

  projects.createProject({ userId: USER, title: 'Mine', now: T0 });
  projects.deleteProjectsForUser(USER);

  assert.equal(projects.shares.resolveShare(kept.token, T0 + 1).ok, true,
    'the sweep is keyed on the erased account, not on the whole table');
});
