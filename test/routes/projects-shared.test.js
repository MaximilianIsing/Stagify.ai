// Tier: unit (pure) — routes/projects-shared.js.
//
// WHAT THIS COVERS
// The clamps and filters every Listing Studio route shares, and in particular the ONE
// predicate that decides which photos get billed for a render: `skipReasonFor`.
//
// WHY THAT PREDICATE HAS ITS OWN FILE OF TESTS
// It is the chokepoint two different routes group through — the upload route picking each
// room's hero, and the stage route building the enqueue plan. They disagreed once (a photo
// the upload gate had rejected was ineligible to LEAD a room but still got enqueued as a
// support frame), and the fix was to share the rule rather than inline it twice. A shared
// rule is only worth anything if it is pinned, so each of its four branches is asserted
// individually and `groupByRoom` is asserted to route through it rather than re-deriving.
//
// THE NOT_A_ROOM BRANCH IS THE EXPENSIVE ONE. Every real listing shoot contains exteriors,
// and staging them spent money putting furniture on a driveway and then stalled that room's
// bible extraction. The tests below therefore pin both halves of the rule: an exterior is
// skipped, AND giving it a real room type stages it — because a rule with no override is a
// rule that will be worked around.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  skipReasonFor,
  groupByRoom,
  SKIP_REASONS,
  slugify,
  clampText,
  clampInt,
  asBool,
  extensionOf,
  serveContentType,
  storedVariationCount,
  mergeExtraJson,
} from '../../routes/projects-shared.js';
import { OTHER_ROOM_TYPE } from '../../lib/staging/room-clustering.js';

/** A photo row that WOULD be staged, overridden per test. */
const photo = (over = {}) => ({
  id: 'ph_1',
  projectId: 'p_1',
  storageKey: 'projects/p_1/src/a.webp',
  seq: 1,
  roomKey: 'living-room-1',
  roomType: 'Living room',
  frameRole: 'support',
  width: 1536,
  height: 1024,
  arLabel: '3:2',
  stageable: null,
  unstageableCode: null,
  sha256: 'sha',
  createdAt: 1,
  ...over,
});

// ── The staging rule ────────────────────────────────────────────────────────

test('a normal interior frame is staged', () => {
  assert.equal(skipReasonFor(photo()), null);
  assert.equal(skipReasonFor(photo({ stageable: true })), null);
  // Tri-state: "not checked yet" is NOT a rejection, matching the upload route's fail-open.
  assert.equal(skipReasonFor(photo({ stageable: null })), null);
});

test('each of the four skip reasons is reported distinctly', () => {
  assert.equal(skipReasonFor(photo({ roomKey: null })), SKIP_REASONS.NO_ROOM);
  assert.equal(skipReasonFor(photo({ roomKey: '' })), SKIP_REASONS.NO_ROOM);
  assert.equal(skipReasonFor(photo({ frameRole: 'excluded' })), SKIP_REASONS.EXCLUDED);
  assert.equal(skipReasonFor(photo({ stageable: false })), SKIP_REASONS.UNSTAGEABLE);
  assert.equal(skipReasonFor(photo({ roomType: OTHER_ROOM_TYPE })), SKIP_REASONS.NOT_A_ROOM);
  // They are codes, not prose: the studio localizes them.
  for (const code of Object.values(SKIP_REASONS)) assert.match(code, /^[A-Z_]+$/);
});

test('an exterior is skipped even though it clustered into a room and passed the upload gate', () => {
  // This is the shape the defect actually had. The frame has a room key (`other-1`), the
  // vision pre-check said `stageable: true` (a house facade is none of PERSON_PORTRAIT /
  // ANIMAL / FOOD / DOCUMENT / VEHICLE / UNRELATED_OBJECT), and the operator excluded
  // nothing — so every OTHER guard passes it and only the room type refuses it.
  const facade = photo({ id: 'ph_facade', roomKey: 'other-1', roomType: OTHER_ROOM_TYPE, stageable: true });
  assert.equal(skipReasonFor(facade), SKIP_REASONS.NOT_A_ROOM);
  assert.equal(groupByRoom([facade]).size, 0, 'and it must not reach the enqueue plan');
});

test('giving an exterior a real room type stages it — the rule has exactly one override', () => {
  const before = photo({ roomKey: 'other-1', roomType: OTHER_ROOM_TYPE });
  assert.equal(skipReasonFor(before), SKIP_REASONS.NOT_A_ROOM);
  // The room-type control on the tray thumbnail is the whole override, by design.
  assert.equal(skipReasonFor({ ...before, roomType: 'Sunroom' }), null);

  // …and promoting it to hero is NOT an override. Keying off `frameRole` as well would make
  // the rule "an exterior stages unless… unless…", and an operator who wants it staged is
  // one dropdown away from saying so.
  assert.equal(skipReasonFor({ ...before, frameRole: 'hero' }), SKIP_REASONS.NOT_A_ROOM);
});

test('the reasons are checked in a fixed order, so the most specific answer wins', () => {
  // A frame can trip several at once; the operator gets ONE reason, and it has to be the one
  // that is actionable. "No room yet" beats everything (nothing else can be decided without
  // it), and an explicit exclusion beats a machine verdict.
  assert.equal(skipReasonFor(photo({ roomKey: null, frameRole: 'excluded', stageable: false })), SKIP_REASONS.NO_ROOM);
  assert.equal(skipReasonFor(photo({ frameRole: 'excluded', stageable: false })), SKIP_REASONS.EXCLUDED);
  assert.equal(skipReasonFor(photo({ stageable: false, roomType: OTHER_ROOM_TYPE })), SKIP_REASONS.UNSTAGEABLE);
});

test('a missing photo is refused rather than throwing', () => {
  assert.equal(skipReasonFor(/** @type {any} */ (null)), SKIP_REASONS.NO_ROOM);
  assert.equal(skipReasonFor(/** @type {any} */ (undefined)), SKIP_REASONS.NO_ROOM);
});

// ── groupByRoom routes through it ───────────────────────────────────────────

test('groupByRoom keeps only what skipReasonFor accepts, in input order', () => {
  const photos = [
    photo({ id: 'a', roomKey: 'living-room-1', seq: 1 }),
    photo({ id: 'b', roomKey: 'living-room-1', seq: 2 }),
    photo({ id: 'c', roomKey: 'other-1', roomType: OTHER_ROOM_TYPE, seq: 3 }),
    photo({ id: 'd', roomKey: 'bedroom-1', roomType: 'Bedroom', seq: 4 }),
    photo({ id: 'e', roomKey: 'bedroom-1', roomType: 'Bedroom', frameRole: 'excluded', seq: 5 }),
    photo({ id: 'f', roomKey: null, seq: 6 }),
    photo({ id: 'g', roomKey: 'bedroom-1', roomType: 'Bedroom', stageable: false, seq: 7 }),
  ];
  const rooms = groupByRoom(photos);
  assert.deepEqual([...rooms.keys()], ['living-room-1', 'bedroom-1'], 'the exterior room must not appear at all');
  assert.deepEqual(rooms.get('living-room-1').map((p) => p.id), ['a', 'b']);
  assert.deepEqual(rooms.get('bedroom-1').map((p) => p.id), ['d']);
});

test('a shoot that is ALL exteriors groups to nothing', () => {
  // The state that used to bill for a whole listing of driveways. The route turns this into
  // its own actionable 409 rather than "none of these photos can be staged".
  const rooms = groupByRoom([
    photo({ id: 'a', roomKey: 'other-1', roomType: OTHER_ROOM_TYPE }),
    photo({ id: 'b', roomKey: 'other-2', roomType: OTHER_ROOM_TYPE }),
  ]);
  assert.equal(rooms.size, 0);
});

// ── The clamps ──────────────────────────────────────────────────────────────

test('slugify is a positive allowlist, not a blocklist', () => {
  // Its output is interpolated into a Content-Disposition header and into zip entry names,
  // so a character class nobody thought of has to be DROPPED rather than passed.
  assert.equal(slugify('12 Oak Avenue', 60), '12-oak-avenue');
  assert.equal(slugify('Flat 3"\r\nX-Injected: yes', 60), 'flat-3-x-injected-yes');
  assert.equal(slugify('../../etc/passwd', 60), 'etc-passwd');
  assert.equal(slugify('../..', 60), '');
  assert.equal(slugify('Ünïcôdé Rôôm', 60), 'unicode-room');
  assert.equal(slugify(null, 60), '');
  assert.equal(slugify('a'.repeat(200), 10).length <= 10, true);
  assert.equal(slugify('----', 60), '', 'a slug that is all separators is empty, not "-"');
});

test('clampText and clampInt refuse non-values rather than coercing them', () => {
  assert.equal(clampText('  hi  ', 10), 'hi');
  assert.equal(clampText('x'.repeat(50), 10).length, 10);
  assert.equal(clampText(42, 10), '', 'a number is not a string');
  assert.equal(clampText(null, 10), '');

  assert.equal(clampInt('5', 1, 10, 3), 5);
  assert.equal(clampInt(99, 1, 10, 3), 10, 'clamped to the ceiling');
  assert.equal(clampInt(-4, 1, 10, 3), 1);
  assert.equal(clampInt('nonsense', 1, 10, 3), 3, 'unparseable falls back');
  assert.equal(clampInt(undefined, 1, 10, 3), 3);
});

test('asBool accepts the form shapes and nothing else', () => {
  for (const yes of [true, 'true', 'on', 1, '1']) assert.equal(asBool(yes), true, String(yes));
  for (const no of [false, 'false', 'off', 0, '0', '', null, undefined, 'yes']) {
    assert.equal(asBool(no), false, String(no));
  }
});

test('serveContentType never guesses a type for an unknown extension', () => {
  assert.equal(serveContentType('projects/p/out/r.webp'), 'image/webp');
  assert.equal(serveContentType('projects/p/out/r.PNG'), 'image/png');
  assert.equal(serveContentType('projects/p/out/r.jpeg'), 'image/jpeg');
  // An unknown extension serves octet-stream, which (with nosniff) makes a mislabelled blob
  // a download rather than something the browser is willing to interpret.
  assert.equal(serveContentType('projects/p/out/r.svg'), 'application/octet-stream');
  assert.equal(serveContentType('projects/p/out/r'), 'application/octet-stream');
  assert.equal(serveContentType(null), 'application/octet-stream');
  assert.equal(extensionOf('a.b.WeBp'), 'webp');
  assert.equal(extensionOf('a.<script>'), 'scrip', 'sanitized to the legal characters AND capped at 5');
});

test('storedVariationCount clamps whatever is in the project bag', () => {
  const withSettings = (variationCount) => ({ extra: { jobSettings: { variationCount } } });
  assert.equal(storedVariationCount(/** @type {any} */ (withSettings(2))), 2);
  assert.equal(storedVariationCount(/** @type {any} */ (withSettings(99))), 3);
  assert.equal(storedVariationCount(/** @type {any} */ (withSettings('nonsense'))), 1);
  assert.equal(storedVariationCount(/** @type {any} */ ({ extra: null })), 1);
  assert.equal(storedVariationCount(null), 1);
});

test('mergeExtraJson replaces a corrupt bag instead of propagating it', () => {
  const merged = JSON.parse(mergeExtraJson(/** @type {any} */ ({ extra: { a: 1 } }), { b: 2 }));
  assert.deepEqual(merged, { a: 1, b: 2 });
  // getProject has already parsed the column (null when unparseable), so a corrupt bag
  // arrives here as null and is replaced rather than carried forward.
  assert.deepEqual(JSON.parse(mergeExtraJson(/** @type {any} */ ({ extra: null }), { b: 2 })), { b: 2 });
  assert.deepEqual(JSON.parse(mergeExtraJson(null, { b: 2 })), { b: 2 });
});
