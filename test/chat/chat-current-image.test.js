// Tier: unit (no server) — lib/chat/chat-current-image.js.
//
// WHAT THIS COVERS
// /api/chat resolves the current turn's inline image ONCE and hands the pair to
// both the staging step and the CAD step. The load-bearing detail is that the two
// halves are independent: `hasImage` reports "the user attached something" and is
// true even when the data URL carries no decodable payload, in which case `buffer`
// stays null. Collapsing them (e.g. `hasImage = buffer !== null`) would change
// which staging branch runs for a malformed upload.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCurrentMessageImage } from '../../lib/chat/chat-current-image.js';

const dataUrl = (text) => 'data:image/png;base64,' + Buffer.from(text).toString('base64');

test('decodes the first image of the current turn', () => {
  const msg = {
    role: 'user',
    content: [
      { type: 'text', text: 'stage this' },
      { type: 'image_url', image_url: { url: dataUrl('room-bytes') } },
      { type: 'image_url', image_url: { url: dataUrl('second-image') } },
    ],
  };
  const out = extractCurrentMessageImage(msg);
  assert.equal(out.hasImage, true);
  assert.equal(out.buffer.toString(), 'room-bytes', 'the FIRST image wins');
});

test('no last user message at all', () => {
  assert.deepEqual(extractCurrentMessageImage(undefined), { hasImage: false, buffer: null });
});

test('string content (a plain text turn) carries no image', () => {
  assert.deepEqual(
    extractCurrentMessageImage({ role: 'user', content: 'just text' }),
    { hasImage: false, buffer: null },
  );
});

test('an array turn with no image item carries no image', () => {
  assert.deepEqual(
    extractCurrentMessageImage({ role: 'user', content: [{ type: 'text', text: 'hi' }] }),
    { hasImage: false, buffer: null },
  );
});

test('an image_url item with no url is not an image', () => {
  const out = extractCurrentMessageImage({
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: '' } }, { type: 'image_url' }],
  });
  assert.deepEqual(out, { hasImage: false, buffer: null });
});

test('a url with no base64 payload still counts as "has image", with a null buffer', () => {
  // Original behaviour: the two facts are separate. Do not collapse them.
  const out = extractCurrentMessageImage({
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: 'https://example.com/photo.png' } }],
  });
  assert.equal(out.hasImage, true);
  assert.equal(out.buffer, null);
});
