// Unit tests for the pure Masking Studio generation helpers extracted into
// public/scripts/masking-studio/generation.js (region naming, cross-area prompt
// context, request-error mapping). No DOM, so they run directly under node --test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  regionNameFromBounds,
  buildAreaContext,
  requestError,
} from '../public/scripts/masking-studio/generation.js';

// The pure helpers take a translate(key, fallback) fn; tests exercise the
// English fallbacks by returning the fallback verbatim.
const tx = (_key, def) => def;

test('regionNameFromBounds: empty mask (maxX < 0) → no region', () => {
  assert.equal(regionNameFromBounds(48, 48, -1, -1, 48), '');
});

test('regionNameFromBounds: dead-center box → "center"', () => {
  assert.equal(regionNameFromBounds(20, 20, 28, 28, 48), 'center');
});

test('regionNameFromBounds: corners → "upper left" / "lower right"', () => {
  assert.equal(regionNameFromBounds(0, 0, 8, 8, 48), 'upper left');
  assert.equal(regionNameFromBounds(40, 40, 47, 47, 48), 'lower right');
});

test('regionNameFromBounds: middle row/center column get the "center"/"middle" wording', () => {
  assert.equal(regionNameFromBounds(0, 20, 8, 28, 48), 'center left');   // middle row, left col
  assert.equal(regionNameFromBounds(20, 0, 28, 8, 48), 'upper middle');  // center col, upper row
});

test('buildAreaContext: no other painted areas → empty string', () => {
  const self = { painted: true, mode: 'stage', prompt: 'sofa' };
  assert.equal(buildAreaContext(self, [self], () => 'center'), '');
});

test('buildAreaContext: summarizes only OTHER painted areas, with region + plan', () => {
  const self = { painted: true, mode: 'stage', prompt: 'sofa' };
  const other = { painted: true, mode: 'stage', prompt: 'a reading nook' };
  const removed = { painted: true, mode: 'remove', prompt: '' };
  const unpainted = { painted: false, mode: 'stage', prompt: 'ignored' };
  const region = (l) => (l === other ? 'upper left' : 'lower right');

  const ctx = buildAreaContext(self, [self, other, removed, unpainted], region);
  assert.match(ctx, /^ For context, other parts of this photo are being edited separately \(/);
  assert.match(ctx, /in the upper left of the photo: a reading nook/);
  assert.match(ctx, /in the lower right of the photo: the existing contents are being removed/);
  assert.doesNotMatch(ctx, /ignored/); // unpainted area excluded
  assert.match(ctx, /keep lighting, shadows, perspective/);
});

test('buildAreaContext: long neighbor prompts truncate to 87 chars + ellipsis', () => {
  const self = { painted: true, mode: 'stage', prompt: 'x' };
  const long = { painted: true, mode: 'stage', prompt: 'a'.repeat(200) };
  const ctx = buildAreaContext(self, [self, long], () => '');
  assert.match(ctx, /a{87}…/);
  assert.doesNotMatch(ctx, /a{88}/);
});

test('buildAreaContext: furniture-only neighbor (blank prompt) describes the reference plan', () => {
  const self = { painted: true, mode: 'stage', prompt: 'x' };
  const furn = { painted: true, mode: 'stage', prompt: '   ', furniture: {} };
  const ctx = buildAreaContext(self, [self, furn], () => '');
  assert.match(ctx, /furniture from a reference photo is being added/);
});

test('requestError: 401/403 fires the gate callback and returns the gate title', () => {
  let gated = 0;
  const onGate = () => { gated++; };
  assert.equal(requestError(401, null, tx, onGate), 'Masking Studio is a Stagify+ feature');
  assert.equal(requestError(403, null, tx, onGate), 'Masking Studio is a Stagify+ feature');
  assert.equal(gated, 2);
});

test('requestError: 429 and 413 map to specific messages without gating', () => {
  let gated = 0;
  const onGate = () => { gated++; };
  assert.match(requestError(429, null, tx, onGate), /generating too quickly/);
  assert.match(requestError(413, null, tx, onGate), /too large/);
  assert.equal(gated, 0);
});

test('requestError: other statuses prefer the server error, else a generic fallback', () => {
  assert.equal(requestError(500, { error: 'boom' }, tx, null), 'boom');
  assert.equal(requestError(500, null, tx, null), 'Something went wrong. Please try again.');
});
