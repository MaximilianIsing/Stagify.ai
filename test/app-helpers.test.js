// Unit tests for the pure helpers extracted from scripts/app.js into
// public/scripts/app/helpers.js. No DOM; File/atob are global in Node >=20.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  abbreviateFileName,
  dataURLToFile,
  fillTemplate,
  dailyLimitMessage,
  roomDownloadSlug,
} from '../public/scripts/app/helpers.js';

test('abbreviateFileName: passthrough when short, ellipsis when clipped', () => {
  assert.equal(abbreviateFileName('sofa.png', 20), 'sofa.png');
  assert.equal(abbreviateFileName('a-very-long-filename.png', 10), 'a-very-lon...');
  assert.equal(abbreviateFileName('', 5), '');
  assert.equal(abbreviateFileName(null, 5), '');
  // Exactly maxLen is not clipped.
  assert.equal(abbreviateFileName('12345', 5), '12345');
});

test('dataURLToFile: decodes base64 payload, mime, and name', async () => {
  // "hi" base64-encoded is "aGk=".
  const file = dataURLToFile('data:text/plain;base64,aGk=', 'note.txt');
  assert.ok(file instanceof File);
  assert.equal(file.name, 'note.txt');
  assert.equal(file.type, 'text/plain');
  assert.equal(await file.text(), 'hi');
});

test('dataURLToFile: falls back to image/png and photo.png', () => {
  // A data URL whose header has no ";" after the mime -> regex misses -> png fallback.
  const file = dataURLToFile('data:base64,aGk=');
  assert.equal(file.type, 'image/png');
  assert.equal(file.name, 'photo.png');
});

test('fillTemplate: replaces every occurrence of each {token}', () => {
  assert.equal(fillTemplate('{a}-{b}-{a}', { a: 1, b: 2 }), '1-2-1');
  // null/undefined values collapse to an empty string.
  assert.equal(fillTemplate('x{gap}y', { gap: null }), 'xy');
  assert.equal(fillTemplate('x{gap}y', { gap: undefined }), 'xy');
  // Unknown tokens are left untouched; no replacements is a passthrough.
  assert.equal(fillTemplate('keep {unknown}', { other: 1 }), 'keep {unknown}');
  assert.equal(fillTemplate('nothing to do'), 'nothing to do');
  // Non-string / nullish templates coerce rather than throw.
  assert.equal(fillTemplate(null), '');
  assert.equal(fillTemplate(undefined, { a: 1 }), '');
});

test('dailyLimitMessage: fills the template with server counts', () => {
  const msg = dailyLimitMessage(
    { dailyGenerationLimit: 5, dailyGenerationsUsed: 5 },
    { template: 'Used {used} of {limit} today.' },
  );
  assert.equal(msg, 'Used 5 of 5 today.');
});

test('dailyLimitMessage: defaults limit to 3 and used to limit when omitted', () => {
  const msg = dailyLimitMessage({}, { template: '{used}/{limit}' });
  assert.equal(msg, '3/3');
});

test('dailyLimitMessage: falls back when template is missing or still "Loading..."', () => {
  // No template -> server error string wins.
  assert.equal(
    dailyLimitMessage({ error: 'Slow down.' }, {}),
    'Slow down.',
  );
  // The i18n "Loading..." sentinel is treated as no template.
  assert.equal(
    dailyLimitMessage({ dailyGenerationLimit: 4 }, { template: 'Loading...' }),
    'Daily free limit reached (4 per day).',
  );
  // No template and no server error -> hard-coded English default at the limit.
  assert.equal(
    dailyLimitMessage(null),
    'Daily free limit reached (3 per day).',
  );
});

test('roomDownloadSlug: lowercases, dashes whitespace, defaults to "room"', () => {
  assert.equal(roomDownloadSlug('Living Room'), 'living-room');
  assert.equal(roomDownloadSlug('DINING   ROOM'), 'dining-room');
  assert.equal(roomDownloadSlug(''), 'room');
  assert.equal(roomDownloadSlug(null), 'room');
  assert.equal(roomDownloadSlug(undefined), 'room');
});
