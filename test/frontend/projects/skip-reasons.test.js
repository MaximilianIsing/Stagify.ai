// Tier: frontend pure logic + a DRIFT GUARD across the front/back boundary.
//
// The Listing Studio tells the operator which frames the next staging run will skip and
// why. The rule that decides that lives on the server (`skipReasonFor` in
// routes/projects-shared.js — it is what `groupByRoom` enqueues through), and the browser
// cannot import a route module, so public/scripts/projects/state.js carries a mirror.
//
// A MIRROR IS ONLY SAFE IF SOMETHING FAILS WHEN IT STOPS MATCHING. That is this file. It
// does not compare the two implementations by reading them; it RUNS both over a matrix of
// photo shapes and asserts they answer identically, frame by frame — so a fifth reason, a
// reordered branch, or a changed comparison on either side lands here as a failure rather
// than as a badge that quietly lies about what will render.
//
// The DOM half (does the badge appear, does a room-type change clear it) is driven through
// the real page in ./studio.test.js. This file needs no document.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SKIP_REASONS as SERVER_SKIP_REASONS,
  skipReasonFor as serverSkipReasonFor,
} from '../../../routes/projects-shared.js';
import { SKIP_REASONS, skipReasonFor } from '../../../public/scripts/projects/state.js';
import { skipNotice } from '../../../public/scripts/projects/upload.js';
import { OTHER_ROOM_TYPE } from '../../../public/scripts/projects/vocab.js';

// The wire encoding, not the storage encoding: `rowToPhoto` serializes `row.stageable === 1`,
// so a browser only ever sees true/false/null (or the field missing on an older payload).
// The legacy 0/1 rows are covered separately below, where the frontend is deliberately a
// SUPERSET rather than a mirror.
const ROOM_KEYS = [undefined, null, '', 'living-room-1'];
const FRAME_ROLES = [undefined, 'support', 'hero', 'excluded'];
const STAGEABLE = [undefined, null, true, false];
const ROOM_TYPES = [undefined, null, '', 'Bedroom', OTHER_ROOM_TYPE, 'other'];

/** Every photo shape the matrix covers, as `{ id, …fields }` rows. */
function matrix() {
  /** @type {any[]} */
  const rows = [];
  for (const roomKey of ROOM_KEYS) {
    for (const frameRole of FRAME_ROLES) {
      for (const stageable of STAGEABLE) {
        for (const roomType of ROOM_TYPES) {
          rows.push({ id: `ph${rows.length}`, roomKey, frameRole, stageable, roomType });
        }
      }
    }
  }
  return rows;
}

test('the studio restates the server\'s skip codes exactly', () => {
  assert.deepEqual(
    SKIP_REASONS,
    { ...SERVER_SKIP_REASONS },
    'public/scripts/projects/state.js mirrors SKIP_REASONS in routes/projects-shared.js',
  );
});

test('the studio and the stage route agree, frame by frame, on what will be skipped', () => {
  const rows = matrix();
  /** @type {string[]} */
  const disagreements = [];
  for (const photo of rows) {
    const mine = skipReasonFor(photo);
    const theirs = serverSkipReasonFor(photo);
    if (mine !== theirs) {
      disagreements.push(`${JSON.stringify(photo)} → studio ${mine}, server ${theirs}`);
    }
  }
  assert.deepEqual(disagreements, [], 'the tray badge would claim something the run does not do');

  // A guard whose ledger is empty passes vacuously. Assert the matrix actually reaches
  // every code AND the "this frame stages" answer, or the loop above proves nothing.
  const produced = new Set(rows.map((photo) => serverSkipReasonFor(photo)));
  for (const code of Object.values(SKIP_REASONS)) {
    assert.ok(produced.has(code), `the matrix never produces ${code}`);
  }
  assert.ok(produced.has(null), 'the matrix never produces a frame that stages');
});

test('ORDER is part of the contract, not an accident of the branches', () => {
  // Each of these is skippable for two reasons at once. The server answers with the first
  // branch that matches, and the tray has to answer the same way or the two are not
  // comparable per-frame.
  assert.equal(skipReasonFor({ id: 'a', frameRole: 'excluded' }), SKIP_REASONS.NO_ROOM);
  assert.equal(
    skipReasonFor({ id: 'b', roomKey: 'r1', frameRole: 'excluded', stageable: false }),
    SKIP_REASONS.EXCLUDED,
  );
  assert.equal(
    skipReasonFor({ id: 'c', roomKey: 'r1', stageable: false, roomType: OTHER_ROOM_TYPE }),
    SKIP_REASONS.UNSTAGEABLE,
  );
  assert.equal(
    skipReasonFor({ id: 'd', roomKey: 'r1', roomType: OTHER_ROOM_TYPE }),
    SKIP_REASONS.NOT_A_ROOM,
  );
  assert.equal(skipReasonFor({ id: 'e', roomKey: 'r1', roomType: 'Bedroom' }), null);
});

test('a missing photo is NO_ROOM, and only the exact "Other" label is NOT_A_ROOM', () => {
  assert.equal(skipReasonFor(/** @type {any} */ (null)), SKIP_REASONS.NO_ROOM);
  // 'other' lowercase is not the clusterer's label. The server does not treat it as an
  // exterior and neither does this — guessing would skip a room the operator typed.
  assert.equal(skipReasonFor({ id: 'f', roomKey: 'r1', roomType: 'other' }), null);
});

test('the legacy 0/1 stageable encoding is caught too — a superset, on purpose', () => {
  // The fixtures and older rows carry 0/1 where the wire carries false/true; `isUnstageable`
  // has always read both. The server sees only its own column and compares to `false`, so
  // this one input is where the mirror is deliberately WIDER than the original: an
  // unstageable frame it reports as NOT_A_ROOM, the tray reports as UNSTAGEABLE — and the
  // tray suppresses its badge for an unstageable frame anyway, deferring to the gate's
  // sentence. Pinned so the divergence stays a decision rather than a surprise.
  const legacy = { id: 'g', roomKey: 'r1', stageable: 0, roomType: OTHER_ROOM_TYPE };
  assert.equal(skipReasonFor(legacy), SKIP_REASONS.UNSTAGEABLE);
  assert.equal(serverSkipReasonFor(legacy), SKIP_REASONS.NOT_A_ROOM);
  assert.equal(skipReasonFor({ id: 'h', roomKey: 'r1', stageable: 1, roomType: 'Bedroom' }), null);
});

// ── The copy ─────────────────────────────────────────────────────────────────

test('every skip reason the tray shows has copy, and UNSTAGEABLE deliberately has none', () => {
  for (const code of Object.values(SKIP_REASONS)) {
    const notice = skipNotice(code);
    if (code === SKIP_REASONS.UNSTAGEABLE) {
      assert.equal(
        notice,
        null,
        'the upload gate\'s own sentence is that frame\'s message — a second one competes with it',
      );
      continue;
    }
    assert.ok(notice, `${code} would be skipped with nothing on the thumbnail saying so`);
    assert.ok(notice.text.length > 12, `${code}'s copy is not a sentence`);
    assert.ok(!notice.text.includes(code), `${code} leaks the raw code at the operator`);
  }
  assert.equal(skipNotice(null), null, 'a frame that stages says nothing');
  assert.equal(skipNotice('SOMETHING_NEW'), null, 'an unknown code renders nothing, not "undefined"');
});

test('NOT_A_ROOM names the room-type control as the fix, and NO_ROOM names the room control', () => {
  const exterior = skipNotice(SKIP_REASONS.NOT_A_ROOM);
  assert.ok(exterior);
  // The whole point of this reason's copy: it is a DEFAULT, and the override is the
  // <select> already on the card. "Not staged" without the undo is just bad news.
  assert.match(exterior.text, /not staged/i);
  assert.match(exterior.text, /exterior/i);
  assert.match(exterior.text, /room type/i);
  assert.equal(exterior.describes, 'type');

  const unassigned = skipNotice(SKIP_REASONS.NO_ROOM);
  assert.ok(unassigned);
  assert.equal(unassigned.describes, 'room');

  const excluded = skipNotice(SKIP_REASONS.EXCLUDED);
  assert.ok(excluded);
  // Excluded is the one the operator chose. There is nothing to point at.
  assert.equal(excluded.describes, undefined);

  const texts = [exterior.text, unassigned.text, excluded.text];
  assert.equal(new Set(texts).size, 3, 'three reasons, three distinct sentences');
});
