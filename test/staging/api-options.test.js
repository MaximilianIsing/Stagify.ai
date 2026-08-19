// Tier: unit (pure, no HTTP) — lib/staging/api-options.js.
//
// WHAT THIS COVERS
// This module exists to stop the published vocabulary drifting from the tables the
// renderer actually consults, so almost every test here is a DRIFT GUARD rather than a
// behaviour check. The bug it was written for is instructive: the docs table said
// "e.g. Living Room, Bedroom, Kitchen" and the copy-pasteable curl sent
// `roomType=Living Room`, with a capital R that is not a promptMatrix key — so the one
// example we shipped silently fell through to the generic prompt and still charged a
// credit. Nothing failed, because nothing compared the two.
//
// The `unknown` contract is asserted against the real normalizers, not just declared:
// a developer branching on "will a typo be caught?" is relying on it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promptMatrix } from '../../lib/staging/promptMatrix.js';
import { ALL_LOCALES } from '../../lib/i18n/locales.js';
import { MAX_UPLOAD_BYTES, STAGING_IMAGE_MIME_TYPES } from '../../lib/http/uploads.js';
import {
  STAMP_STYLE_NAMES,
  DEFAULT_STAMP_STYLE,
  STAMP_SCALE_MIN,
  STAMP_SCALE_MAX,
  STAMP_SCALE_DEFAULT,
  readStampRequest,
} from '../../lib/image/stamp-disclosure.js';
import {
  buildApiOptions,
  roomTypes,
  furnitureStyles,
  DEFAULT_ROOM_TYPE,
  DEFAULT_FURNITURE_STYLE,
} from '../../lib/staging/api-options.js';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(rootDir, rel), 'utf8');

test('every published list is the renderer’s own, not a copy of it', () => {
  const o = buildApiOptions();
  assert.deepEqual(o.room_type.values, Object.keys(promptMatrix));
  assert.deepEqual(o.stamp_style.values, STAMP_STYLE_NAMES);
  assert.deepEqual(o.stamp_lang.values, ALL_LOCALES.map((l) => l.lang));
  assert.deepEqual(o.image.mime_types, STAGING_IMAGE_MIME_TYPES);
  assert.equal(o.image.max_bytes, MAX_UPLOAD_BYTES);
  assert.equal(o.stamp_style.default, DEFAULT_STAMP_STYLE);
  assert.equal(o.stamp_scale.min, STAMP_SCALE_MIN);
  assert.equal(o.stamp_scale.max, STAMP_SCALE_MAX);
  assert.equal(o.stamp_scale.default, STAMP_SCALE_DEFAULT);
});

test('furnitureStyles is read off one room, so every room must carry the same keys', () => {
  // The derivation is only safe while the matrix is rectangular. If a room is ever added
  // with a missing style, this fails here rather than silently publishing a list that is
  // wrong for that room.
  const expected = furnitureStyles();
  assert.ok(expected.length >= 8, 'sanity: the style set should not have collapsed');
  for (const [room, styles] of Object.entries(promptMatrix)) {
    assert.deepEqual(Object.keys(styles), expected, `${room} does not carry the same styles`);
  }
});

test('DRIFT GUARD: the published defaults are the handler’s destructuring defaults', () => {
  // The endpoint tells a caller what happens when they omit a field. If someone changes
  // the handler's default and not this module, the answer becomes a lie — and it is the
  // kind of lie nobody notices, because omitting the field still works.
  const src = read('lib/staging/virtual-staging-handler.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const roomDefault = src.match(/roomType\s*=\s*'([^']*)'/);
  const styleDefault = src.match(/furnitureStyle\s*=\s*'([^']*)'/);
  assert.ok(roomDefault, 'could not find the roomType default — did the destructuring move?');
  assert.ok(styleDefault, 'could not find the furnitureStyle default');
  assert.equal(roomDefault[1], DEFAULT_ROOM_TYPE);
  assert.equal(styleDefault[1], DEFAULT_FURNITURE_STYLE);
});

test('the published defaults are themselves valid values', () => {
  assert.ok(roomTypes().includes(DEFAULT_ROOM_TYPE));
  assert.ok(furnitureStyles().includes(DEFAULT_FURNITURE_STYLE));
});

test('roomType really is case-sensitive, which is why the endpoint says so', () => {
  // This is the trap the docs walked into. 'Living Room' is not a key, and nothing
  // rejects it — generatePrompt falls through to a generic sentence.
  assert.ok(Object.prototype.hasOwnProperty.call(promptMatrix, 'Living room'));
  assert.ok(!Object.prototype.hasOwnProperty.call(promptMatrix, 'Living Room'));
  assert.equal(buildApiOptions().room_type.case_sensitive, true);
});

test('the stamp fields behave the way the endpoint advertises', () => {
  const o = buildApiOptions();

  // unknown: 'default' — an unrecognised style is replaced, not rejected.
  assert.equal(o.stamp_style.unknown, 'default');
  assert.equal(
    readStampRequest({ labelVirtuallyStaged: 'true', stampStyle: 'neon-pink' }).style,
    DEFAULT_STAMP_STYLE,
  );
  // ...and case-insensitively, as declared.
  assert.equal(o.stamp_style.case_sensitive, false);
  assert.equal(
    readStampRequest({ labelVirtuallyStaged: 'true', stampStyle: STAMP_STYLE_NAMES[0].toUpperCase() }).style,
    STAMP_STYLE_NAMES[0],
  );

  // unknown: 'clamp' — out of range is pulled to the bound, not refused.
  assert.equal(o.stamp_scale.unknown, 'clamp');
  assert.equal(readStampRequest({ labelVirtuallyStaged: 'true', stampScale: '99' }).scale, STAMP_SCALE_MAX);
  assert.equal(readStampRequest({ labelVirtuallyStaged: 'true', stampScale: '0.01' }).scale, STAMP_SCALE_MIN);
  // Unparseable is the default rather than a bound — worth pinning, it is the case an
  // empty multipart field produces.
  assert.equal(readStampRequest({ labelVirtuallyStaged: 'true', stampScale: '' }).scale, STAMP_SCALE_DEFAULT);
});

test('the body is JSON-safe and carries no internals', () => {
  const o = buildApiOptions();
  assert.equal(o.object, 'options');
  const round = JSON.parse(JSON.stringify(o));
  assert.deepEqual(round, o, 'the response must survive serialisation unchanged');
  // Nothing here is account-specific: this endpoint is unauthenticated.
  const flat = JSON.stringify(o);
  assert.ok(!/price_|sk_|stg_live_/.test(flat), 'no secret or Stripe id may appear');
});
