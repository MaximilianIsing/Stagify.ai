// resolveTargetRoomImageIndex (lib/chat/chat-base-image-staging.js) — picks which
// existing history image is the ROOM to add furniture into. Pure over the message
// list + options; the priority order (thumbnail selection → most-recent staged →
// sole room candidate → message-text hints → give up) decides whether "add that
// chair" lands in the right room or nowhere. No I/O or model client is touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTargetRoomImageIndex } from '../lib/chat/chat-base-image-staging.js';

// collectImagesFromHistory walks messages most-recent-first, so image index 0 is
// the newest image across the whole conversation.
const userUpload = (filename) => ({
  role: 'user',
  content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${filename}` }, filename }],
});
const stagedResult = (filename) => ({
  role: 'assistant',
  content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${filename}` }, isStaged: true, filename }],
});

test('returns null when there are no images and no hints', () => {
  assert.equal(resolveTargetRoomImageIndex([]), null);
  assert.equal(resolveTargetRoomImageIndex([userUpload('sofa-product.jpg')], { userMessage: 'hi' }), null,
    'a lone furniture reference is not a room target');
});

test('a valid thumbnail selection of a room wins outright', () => {
  const messages = [userUpload('empty-bedroom.jpg')];
  assert.equal(resolveTargetRoomImageIndex(messages, { baseImageIndex: 0 }), 0);
});

test('a thumbnail selection pointing at a furniture reference falls through to the staged room', () => {
  // images: [staged(0), green-sofa upload(1)] (most-recent-first)
  const messages = [userUpload('green-sofa.jpg'), stagedResult('staged-living.jpg')];
  assert.equal(resolveTargetRoomImageIndex(messages, { baseImageIndex: 1 }), 0,
    'selection is furniture → use the most recent staged image instead');
});

test('with no selection, the most recent staged image is the target', () => {
  const messages = [userUpload('empty-bedroom.jpg'), stagedResult('staged.jpg')];
  assert.equal(resolveTargetRoomImageIndex(messages, {}), 0);
});

test('a sole room candidate is chosen when nothing else disambiguates', () => {
  const messages = [userUpload('empty-bedroom.jpg')];
  assert.equal(resolveTargetRoomImageIndex(messages, {}), 0);
});

test('"that room" text picks the first room candidate when several rooms exist', () => {
  // Two room uploads, no staged image → roomCandidates has 2 entries, so the
  // single-candidate shortcut is skipped and the text hint decides.
  const messages = [userUpload('bedroom-a.jpg'), userUpload('kitchen-b.jpg')];
  assert.equal(resolveTargetRoomImageIndex(messages, { userMessage: 'add a lamp to that room' }), 0);
});

test('ambiguous rooms with no usable hint resolve to null', () => {
  const messages = [userUpload('bedroom-a.jpg'), userUpload('kitchen-b.jpg')];
  assert.equal(resolveTargetRoomImageIndex(messages, { userMessage: 'looks nice' }), null);
});
