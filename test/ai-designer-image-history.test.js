// Unit tests for the AI Designer conversation-history image bookkeeping
// extracted into public/scripts/ai-designer/image-history.js. This is the
// client-side parallel of the already-tested backend lib/chat-history.js; the
// functions operate on plain data (no DOM), so they run under node --test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getRootBaseNameForImage,
  extractRawImagesChronological,
  applyThumbnailLabels,
  collectImagesFromConversationHistory,
  getThumbnailLabel,
  pickPreferredRoomImageIndex,
  getBaseImageIndexForRequest,
  resolveStagingRootBaseName,
} from '../public/scripts/ai-designer/image-history.js';

function userUpload(url, filename) {
  return { role: 'user', content: [{ type: 'image_url', image_url: { url }, filename }] };
}
function assistantImage(url, flags = {}) {
  return { role: 'assistant', content: [{ type: 'image_url', image_url: { url }, ...flags }] };
}

// A living-room upload -> two staged results, then a sofa upload, then a plain
// (non-staged/generated/masked) assistant image that must be ignored.
function sampleHistory() {
  return [
    userUpload('u1', 'living-room.png'),
    { role: 'assistant', content: [{ type: 'text', text: 'done' }, { type: 'image_url', image_url: { url: 's1' }, isStaged: true }] },
    assistantImage('s2', { isStaged: true }),
    userUpload('u2', 'sofa.png'),
    assistantImage('plain', {}), // not staged/generated/masked -> excluded
  ];
}

test('extractRawImagesChronological: uploads + qualifying assistant images, oldest-first, plain excluded', () => {
  const imgs = extractRawImagesChronological(sampleHistory());
  assert.deepEqual(imgs.map((i) => i.url), ['u1', 's1', 's2', 'u2']);
  assert.equal(imgs[0].isStaged, false);
  assert.equal(imgs[1].isStaged, true);
  assert.equal(imgs[0].filename, 'living-room.png');
});

test('extractRawImagesChronological: empty history -> []', () => {
  assert.deepEqual(extractRawImagesChronological([]), []);
});

test('applyThumbnailLabels: uploads keep their stem, staged inherit + number sequentially', () => {
  const imgs = extractRawImagesChronological(sampleHistory());
  applyThumbnailLabels(imgs);
  const byUrl = Object.fromEntries(imgs.map((i) => [i.url, i]));
  assert.equal(byUrl.u1.displayLabel, 'living-room');
  assert.equal(byUrl.s1.displayLabel, 'living-room (Staged #1)');
  assert.equal(byUrl.s2.displayLabel, 'living-room (Staged #2)');
  assert.equal(byUrl.u2.displayLabel, 'sofa');
  // staged results carry the most recent upload's root name.
  assert.equal(byUrl.s1.rootBaseName, 'living-room');
});

test('applyThumbnailLabels: masked and generated labels', () => {
  const imgs = [
    { url: 'u', filename: 'kitchen.png', isStaged: false, isGenerated: false, isMasked: false },
    { url: 'm', filename: null, isMasked: true, maskNumber: null },
    { url: 'g', filename: 'kitchen-generated.png', isGenerated: true },
  ];
  applyThumbnailLabels(imgs);
  assert.equal(imgs[1].displayLabel, 'kitchen (Masked)');
  assert.equal(imgs[2].displayLabel, 'kitchen-generated (Generated)');
});

test('collectImagesFromConversationHistory: newest-first with labels applied', () => {
  const imgs = collectImagesFromConversationHistory(sampleHistory());
  assert.deepEqual(imgs.map((i) => i.url), ['u2', 's2', 's1', 'u1']);
  assert.equal(imgs[0].displayLabel, 'sofa');
});

test('getRootBaseNameForImage: rootBaseName > filename stem > "Upload"', () => {
  assert.equal(getRootBaseNameForImage({ rootBaseName: 'explicit' }), 'explicit');
  assert.equal(getRootBaseNameForImage({ filename: 'photo.png' }), 'photo');
  assert.equal(getRootBaseNameForImage({}), 'Upload');
  assert.equal(getRootBaseNameForImage(null), 'Upload');
});

test('getThumbnailLabel: uses displayLabel, else derives from root', () => {
  assert.equal(getThumbnailLabel({ displayLabel: 'Ready' }), 'Ready');
  assert.equal(getThumbnailLabel({ filename: 'den.png' }), 'den');
});

test('pickPreferredRoomImageIndex: room keyword wins over furniture', () => {
  assert.equal(pickPreferredRoomImageIndex([{ filename: 'sofa.png' }, { filename: 'living-room.png' }]), 1);
});

test('pickPreferredRoomImageIndex: furniture present -> pick an unknown as the room', () => {
  assert.equal(pickPreferredRoomImageIndex([{ filename: 'chair.png' }, { filename: 'IMG_1234.png' }]), 1);
});

test('pickPreferredRoomImageIndex: <2 images -> 0; ambiguous -> index 1', () => {
  assert.equal(pickPreferredRoomImageIndex([{ filename: 'x.png' }]), 0);
  assert.equal(pickPreferredRoomImageIndex([]), 0);
  assert.equal(pickPreferredRoomImageIndex([{ filename: 'a.png' }, { filename: 'b.png' }]), 1);
});

test('getBaseImageIndexForRequest: null selection -> undefined; out-of-range -> 0; valid -> itself', () => {
  const h = sampleHistory();
  assert.equal(getBaseImageIndexForRequest(h, null), undefined);
  assert.equal(getBaseImageIndexForRequest(h, 2), 2);
  assert.equal(getBaseImageIndexForRequest(h, 99), 0);
  assert.equal(getBaseImageIndexForRequest([], 0), undefined);
});

test('resolveStagingRootBaseName: selected base image wins', () => {
  const h = sampleHistory();
  // newest-first list is [u2(sofa), s2, s1, u1(living-room)]; index 3 -> living-room upload.
  assert.equal(resolveStagingRootBaseName([], h, 3), 'living-room');
  // index 0 -> sofa upload.
  assert.equal(resolveStagingRootBaseName([], h, 0), 'sofa');
});

test('resolveStagingRootBaseName: no selection falls back to an uploaded file, then newest image, then "Upload"', () => {
  const files = [{ name: 'balcony.jpg', type: 'image/jpeg' }];
  assert.equal(resolveStagingRootBaseName(files, [], null), 'balcony');
  // No files, no selection, but history exists -> newest image's root.
  assert.equal(resolveStagingRootBaseName([], sampleHistory(), null), 'sofa');
  // Nothing at all -> "Upload".
  assert.equal(resolveStagingRootBaseName([], [], null), 'Upload');
});
