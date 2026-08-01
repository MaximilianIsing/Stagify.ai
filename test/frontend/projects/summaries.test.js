// Tier: unit (pure) — public/scripts/projects/summaries.js.
//
// WHY THIS FILE EXISTS
// This module had NO tests, and it computes the number a broker approves a spend against:
// the confirm dialog's "this will produce N render(s)". A wrong number here is not a
// cosmetic bug — the operator agrees to a cost, presses Stage, and gets a different one.
//
// The absence is what let a real drift ship. `stagePlan` applied two exclusions of its own
// (no room, excluded) and its comment claimed those were "the same two exclusions
// `groupByRoom` applies server-side". That stopped being true twice: the server also drops
// a frame the upload gate rejected, and one whose roomType is 'Other' — an exterior, which
// every real listing shoot contains several of. The dialog quoted renders that were never
// going to happen. It now defers to `skipReasonFor`, and the tests below pin BOTH the
// arithmetic and the deferral.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stagePlan,
  stagePlanSummary,
  progressAnnouncement,
  blockedSummary,
  RENDER_SECONDS_LOW,
  RENDER_SECONDS_HIGH,
} from '../../../public/scripts/projects/summaries.js';
import { OTHER_ROOM_TYPE } from '../../../public/scripts/projects/vocab.js';

/** A frame that WOULD be staged, overridden per case. */
const photo = (over = {}) => ({
  id: 'ph', roomKey: 'living-room-1', roomType: 'Living room',
  frameRole: 'support', stageable: true, ...over,
});

// ── The arithmetic ──────────────────────────────────────────────────────────

test('a room is ONE hero render plus variationCount for every other frame', () => {
  // The hero derives the look bible the rest are conditioned on, so it is never varied.
  // `photos × variations` would over-count by a room's worth of variations per room —
  // on a 9-room shoot, an 18-render lie.
  const room = [photo({ id: 'a' }), photo({ id: 'b' }), photo({ id: 'c' })];
  assert.equal(stagePlan(room, 1).renders, 3, '1 hero + 2 support × 1');
  assert.equal(stagePlan(room, 3).renders, 7, '1 hero + 2 support × 3');
  assert.equal(stagePlan([photo()], 3).renders, 1, 'a one-photo room is just its hero');
});

test('rooms are counted independently', () => {
  const photos = [
    photo({ id: 'a', roomKey: 'living-room-1' }),
    photo({ id: 'b', roomKey: 'living-room-1' }),
    photo({ id: 'c', roomKey: 'bedroom-1', roomType: 'Bedroom' }),
  ];
  const plan = stagePlan(photos, 2);
  assert.equal(plan.rooms, 2);
  assert.equal(plan.renders, 4, '(1 + 1×2) + 1');
  assert.equal(plan.photos, 3);
});

test('variationCount is clamped to 1–3 rather than trusted', () => {
  const room = [photo({ id: 'a' }), photo({ id: 'b' })];
  assert.equal(stagePlan(room, 99).renders, stagePlan(room, 3).renders);
  assert.equal(stagePlan(room, 0).renders, stagePlan(room, 1).renders);
  assert.equal(stagePlan(room, /** @type {any} */ ('nonsense')).renders, stagePlan(room, 1).renders);
});

// ── The exclusions it must NOT re-derive ────────────────────────────────────

test('AN EXTERIOR IS NOT QUOTED — the drift this module shipped', () => {
  // The regression in one test. Every real shoot has a front elevation, a backyard, a
  // garage; the clusterer labels them 'Other' and the server never stages them. Quoting
  // them means the operator approves a price for renders that will not happen.
  const photos = [
    photo({ id: 'a' }),
    photo({ id: 'b' }),
    photo({ id: 'facade', roomKey: 'other-1', roomType: OTHER_ROOM_TYPE }),
    photo({ id: 'garage', roomKey: 'other-2', roomType: OTHER_ROOM_TYPE }),
  ];
  const plan = stagePlan(photos, 1);
  assert.equal(plan.rooms, 1, 'the two exterior "rooms" are not rooms');
  assert.equal(plan.renders, 2, 'and cost nothing');
  assert.equal(plan.photos, 2);
});

test('a frame the upload gate rejected is not quoted either', () => {
  // The other exclusion this module used to miss. The tray already tells the operator the
  // photo cannot be staged; charging for it in the same breath would be incoherent.
  const photos = [photo({ id: 'a' }), photo({ id: 'bad', stageable: false })];
  assert.equal(stagePlan(photos, 1).renders, 1);
  assert.equal(stagePlan(photos, 1).skipped, 1);
});

test('excluded and unassigned frames are still reported separately — they are actionable', () => {
  // The dialog names these two specifically, because the operator can do something about
  // them. The other two skips are the product working as intended.
  const photos = [
    photo({ id: 'a' }),
    photo({ id: 'out', frameRole: 'excluded' }),
    photo({ id: 'nowhere', roomKey: null }),
    photo({ id: 'facade', roomKey: 'other-1', roomType: OTHER_ROOM_TYPE }),
  ];
  const plan = stagePlan(photos, 1);
  assert.equal(plan.excluded, 1);
  assert.equal(plan.unassigned, 1);
  assert.equal(plan.skipped, 3, 'all three are skipped');
  assert.equal(plan.renders, 1);
});

test('an empty or absent list is a clean zero rather than a throw', () => {
  for (const input of [[], null, undefined]) {
    const plan = stagePlan(/** @type {any} */ (input), 3);
    assert.equal(plan.renders, 0);
    assert.equal(plan.rooms, 0);
  }
});

// ── The sentence the operator reads ─────────────────────────────────────────

test('the summary states the renders, the rooms and an honest time BAND', () => {
  const text = stagePlanSummary({ renders: 10, rooms: 3, unassigned: 0 });
  assert.match(text, /10 render\(s\)/);
  assert.match(text, /3 room\(s\)/);
  const low = Math.round((10 * RENDER_SECONDS_LOW) / 60);
  const high = Math.round((10 * RENDER_SECONDS_HIGH) / 60);
  assert.match(text, new RegExp(`${low}.{1,3}${high} minutes`), 'a band, because the spread is real');
  assert.match(text, /cancel/i, 'and says the run can be stopped');
});

test('a plan that would stage nothing says so instead of quoting zero renders', () => {
  const text = stagePlanSummary({ renders: 0, rooms: 0, unassigned: 4 });
  assert.match(text, /nothing would be staged/i);
  assert.doesNotMatch(text, /0 render/);
});

// ── The live-region announcement (the poller's diff) ─────────────────────────

test('an unchanged poll announces nothing', () => {
  // The announcement is a DIFF. Speaking on every tick would make a screen reader unusable
  // during a 90-render run.
  const p = { queued: 2, running: 1, ok: 3, failed: 0, superseded: 0, total: 6 };
  assert.equal(progressAnnouncement(p, { ...p }), '');
});

test('a frame finishing is announced', () => {
  const before = { queued: 2, running: 1, ok: 3, failed: 0, superseded: 0, total: 6 };
  const after = { ...before, queued: 1, ok: 4 };
  assert.notEqual(progressAnnouncement(before, after), '', 'a real transition speaks');
});

test('a NULL baseline announces the run STARTING — the silence comes from seed(), not here', () => {
  // I assumed the opposite writing this file, and the code was right. `null` genuinely means
  // "a run just began", and saying so is correct. The reason OPENING a half-finished listing
  // does not read the whole queue aloud is that the poller calls `seed(progress)` first
  // (projects/polling.js), establishing the baseline silently — not because this function is
  // quiet on null. Worth pinning both halves so neither is "fixed" into the other.
  const next = { queued: 1, running: 1, ok: 4, failed: 0, superseded: 0, total: 6 };
  assert.match(progressAnnouncement(null, next), /start/i);
});

test('blockedSummary explains a stall only when there is one', () => {
  assert.equal(blockedSummary({ queued: 2, running: 0, ok: 0, failed: 0, superseded: 0, total: 2, blocked: 0 }), '');
  const text = blockedSummary({ queued: 2, running: 0, ok: 0, failed: 0, superseded: 0, total: 2, blocked: 2 });
  assert.notEqual(text, '', 'a blocked room must be explained, not left as a silent stall');
});
