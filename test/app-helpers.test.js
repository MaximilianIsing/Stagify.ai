// Unit tests for the pure helpers extracted from scripts/app.js into
// public/scripts/app/helpers.js. No DOM; File/atob are global in Node >=20.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { abbreviateFileName, dataURLToFile } from '../public/scripts/app/helpers.js';

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
