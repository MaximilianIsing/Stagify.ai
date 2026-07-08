// Conversation-history / image-resolution helpers (lib/chat-history.js). These are
// pure functions, but they decide WHICH stored image a staging/CAD/recall request
// targets and how uploads split into room-vs-furniture. A silent regression here
// stages the wrong image or swaps room/furniture — the user just sees a bad result
// with no error. All deterministic: call directly, no fakes, no server boot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectImagesFromHistory,
  getImageFromHistory,
  getOriginalImageIndex,
  buildImageContext,
  findMostRecentStagedImageIndex,
  resolveCadImageIndex,
  parseBaseImageIndex,
  deduplicateMessages,
  stripImagesFromHistory,
  filterUnsupportedFiles,
  userWantsToAddFurnitureToRoom,
  classifyUploadImageRole,
  partitionDualUploadEntries,
  resolveDualUploadStaging,
} from '../lib/chat-history.js';

// A conversation with interleaved images: user upload → assistant staged (+ a
// decorative image that is NOT staged/generated) → user upload. Index 0 = most
// recent. The decorative assistant image must be EXCLUDED (only staged/generated
// assistant images are collectable).
function interleavedHistory() {
  return [
    { role: 'user', content: [
      { type: 'text', text: 'stage this room' },
      { type: 'image_url', image_url: { url: 'data:room' }, filename: 'room.png' },
    ] },
    { role: 'assistant', content: [
      { type: 'text', text: 'here you go' },
      { type: 'image_url', image_url: { url: 'data:staged' }, isStaged: true, filename: 'staged.png' },
      { type: 'image_url', image_url: { url: 'data:decorative' } }, // not staged/generated → excluded
    ] },
    { role: 'user', content: [
      { type: 'image_url', image_url: { url: 'data:chair' }, filename: 'chair.png' },
    ] },
  ];
}

test('collectImagesFromHistory: index 0 = most recent; assistant images only when staged/generated', () => {
  const imgs = collectImagesFromHistory(interleavedHistory());
  assert.equal(imgs.length, 3, 'the decorative (non-staged) assistant image is excluded');
  assert.equal(imgs[0].filename, 'chair.png', 'most recent user upload is index 0');
  assert.equal(imgs[0].isStaged, false);
  assert.equal(imgs[1].filename, 'staged.png', 'assistant staged image is next');
  assert.equal(imgs[1].isStaged, true);
  assert.equal(imgs[2].filename, 'room.png', 'oldest user upload is highest index');
  assert.ok(!imgs.some((i) => i.url === 'data:decorative'), 'decorative assistant image never collected');
  assert.equal(collectImagesFromHistory(null).length, 0, 'non-array → empty');
});

test('getImageFromHistory: valid index returns that image; out-of-range silently falls back to index 0', () => {
  const h = interleavedHistory();
  assert.equal(getImageFromHistory(h, 0).filename, 'chair.png');
  assert.equal(getImageFromHistory(h, 2).filename, 'room.png');
  // The dangerous fallback: an out-of-range index does NOT return null — it returns
  // the most-recent image. Documented so a change to this behavior is caught.
  assert.equal(getImageFromHistory(h, 99).filename, 'chair.png', 'out-of-range → index 0 fallback');
  assert.equal(getImageFromHistory([], 0), null, 'no images → null');
  assert.equal(getImageFromHistory(null, 0), null, 'non-array → null');
});

test('getOriginalImageIndex: points at the oldest user upload', () => {
  // Two user uploads, no assistant images between → user-list index of the oldest is 1.
  const h = [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:a' }, filename: 'first.png' }] },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:b' }, filename: 'second.png' }] },
  ];
  assert.equal(getOriginalImageIndex(h), 1);
  assert.equal(getOriginalImageIndex([]), null, 'no uploads → null');
});

test('buildImageContext: marks the original image and parses CAD annotations into the prompt text', () => {
  const h = [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:plan' }, filename: 'plan.png', _annotation: 'A floor plan. CAD: True' }] },
    { role: 'assistant', content: [{ type: 'image_url', image_url: { url: 'data:staged' }, isStaged: true, filename: 'staged.png' }] },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:chair' }, filename: 'chair.png' }] },
  ];
  const { imageContext, originalImageIndex } = buildImageContext(h);
  // Full-list indexing: chair(0), staged(1), plan(2). The original (oldest upload) is plan at index 2.
  assert.equal(originalImageIndex, 2);
  assert.match(imageContext, /Index 0:.*chair\.png/);
  assert.match(imageContext, /Index 1: staged image/);
  assert.match(imageContext, /Index 2:.*plan\.png/);
  assert.match(imageContext, /\[CAD: True\]/, 'CAD:True annotation is surfaced');
  assert.match(imageContext, /ORIGINAL\/FIRST USER-UPLOADED IMAGE/);
  assert.match(imageContext, /use index 2/, 'the recall hint names the original index');
  assert.equal(buildImageContext(null).imageContext, '', 'non-array → empty context');
});

test('findMostRecentStagedImageIndex: returns the collected index of the first staged image, else null', () => {
  assert.equal(findMostRecentStagedImageIndex(interleavedHistory()), 1);
  const noStaged = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:x' } }] }];
  assert.equal(findMostRecentStagedImageIndex(noStaged), null);
});

test('resolveCadImageIndex: AI index wins when current message has an image or no UI selection', () => {
  const h = interleavedHistory();
  assert.equal(resolveCadImageIndex({ imageIndex: 2 }, null, h, false), 2, 'no base selection → AI index');
  assert.equal(resolveCadImageIndex({ imageIndex: 2 }, 1, h, true), 2, 'current upload present → AI index, ignore base');
  assert.equal(resolveCadImageIndex({ imageIndex: 2 }, 1, h, false), 1, 'UI selection wins when no current upload');
  assert.equal(resolveCadImageIndex({}, null, h, false), 0, 'missing imageIndex defaults to 0');
});

test('parseBaseImageIndex: only non-negative integers survive; blanks/garbage → null', () => {
  assert.equal(parseBaseImageIndex('3'), 3);
  assert.equal(parseBaseImageIndex('0'), 0);
  assert.equal(parseBaseImageIndex(5), 5);
  assert.equal(parseBaseImageIndex(''), null);
  assert.equal(parseBaseImageIndex(undefined), null);
  assert.equal(parseBaseImageIndex(null), null);
  assert.equal(parseBaseImageIndex('-1'), null);
  assert.equal(parseBaseImageIndex('abc'), null);
});

test('deduplicateMessages: drops exact re-sends and role-less junk; images compare by placeholder', () => {
  const deduped = deduplicateMessages([
    { role: 'user', content: 'hello' },
    { role: 'user', content: 'hello' }, // exact dup → dropped
    { content: 'no role' },             // invalid → skipped
    { role: 'assistant', content: 'hi' },
  ]);
  assert.equal(deduped.length, 2);
  assert.deepEqual(deduped.map((m) => m.role), ['user', 'assistant']);

  // Current impl replaces image base64 with a placeholder before hashing, so two
  // messages with the SAME caption but DIFFERENT images collapse to one. Pinned so
  // a change to this (arguably surprising) behavior is caught.
  const sameCaption = deduplicateMessages([
    { role: 'user', content: [{ type: 'text', text: 'stage' }, { type: 'image_url', image_url: { url: 'data:AAA' } }] },
    { role: 'user', content: [{ type: 'text', text: 'stage' }, { type: 'image_url', image_url: { url: 'data:BBB' } }] },
  ]);
  assert.equal(sameCaption.length, 1, 'images are hashed as [IMAGE_DATA], so identical captions dedup');
});

test('stripImagesFromHistory: replaces images with text refs, but can keep the current message intact', () => {
  const h = [
    { role: 'user', content: [{ type: 'text', text: 'old' }, { type: 'image_url', image_url: { url: 'data:x' }, filename: 'a.png' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'reply' }, { type: 'image_url', image_url: { url: 'data:y' }, isStaged: true }] },
    { role: 'user', content: [{ type: 'text', text: 'new' }, { type: 'image_url', image_url: { url: 'data:z' }, filename: 'b.png' }] },
  ];
  const stripped = stripImagesFromHistory(h, true);
  assert.equal(typeof stripped[0].content, 'string');
  assert.match(stripped[0].content, /\[Image: a\.png\]/, 'older user image → filename ref');
  assert.match(stripped[1].content, /\[Staged image from previous message\]/, 'assistant image → staged ref');
  assert.equal(Array.isArray(stripped[2].content), true, 'the current (last) user message keeps its images');

  const strippedNoKeep = stripImagesFromHistory(h, false);
  assert.equal(typeof strippedNoKeep[2].content, 'string', 'without keep flag, the last message is stripped too');
});

test('filterUnsupportedFiles: AVIF/unsupported images become an explanatory text note; supported kept', () => {
  const { filteredContent, unsupportedFiles } = filterUnsupportedFiles([
    { type: 'text', text: 'here' },
    { type: 'image_url', image_url: { url: 'data:image/avif;base64,AAAA' } },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } },
  ]);
  assert.equal(unsupportedFiles.length, 1);
  assert.equal(unsupportedFiles[0].type, 'AVIF');
  assert.equal(filteredContent[1].type, 'text', 'the AVIF image is converted to a text note');
  assert.match(filteredContent[1].text, /not supported/);
  assert.equal(filteredContent[2].type, 'image_url', 'the PNG survives');
});

test('userWantsToAddFurnitureToRoom: catches add/place phrasing, ignores unrelated edits', () => {
  assert.equal(userWantsToAddFurnitureToRoom('add this chair'), true);
  assert.equal(userWantsToAddFurnitureToRoom('put the sofa in the corner'), true);
  assert.equal(userWantsToAddFurnitureToRoom('place this here'), true);
  assert.equal(userWantsToAddFurnitureToRoom('make it brighter'), false);
  assert.equal(userWantsToAddFurnitureToRoom(''), false);
  assert.equal(userWantsToAddFurnitureToRoom(null), false);
});

// --- dual-upload room/furniture split: the highest-risk heuristic in this module ---

test('classifyUploadImageRole: filename/annotation keywords and staged flags decide the role', () => {
  assert.equal(classifyUploadImageRole({ filename: 'chair.png' }), 'furniture');
  assert.equal(classifyUploadImageRole({ filename: 'living-room.png' }), 'room');
  assert.equal(classifyUploadImageRole({ isStaged: true }), 'room', 'staged output is always a room');
  assert.equal(classifyUploadImageRole({ isGenerated: true }), 'room');
  assert.equal(classifyUploadImageRole({ filename: 'IMG_1234.png' }), 'unknown');
  assert.equal(classifyUploadImageRole(null), 'unknown');
});

test('partitionDualUploadEntries: resolves room vs furniture across the ambiguous cases', () => {
  const room = { role: 'room', buffer: 'R', filename: 'r' };
  const furn = { role: 'furniture', buffer: 'F', filename: 'f' };
  const unk1 = { role: 'unknown', buffer: 'U1', filename: 'u1' };
  const unk2 = { role: 'unknown', buffer: 'U2', filename: 'u2' };

  assert.deepEqual(partitionDualUploadEntries([room, furn]), { room, furniture: [furn] });
  assert.deepEqual(partitionDualUploadEntries([room, unk1]), { room, furniture: [unk1] }, 'lone unknown → furniture');
  assert.deepEqual(partitionDualUploadEntries([furn, unk1]), { room: unk1, furniture: [furn] }, 'lone unknown → room');
  // Two unknowns: the common upload order is furniture-first, room-second → last is the room.
  assert.deepEqual(partitionDualUploadEntries([unk1, unk2]), { room: unk2, furniture: [unk1] });
  assert.equal(partitionDualUploadEntries([room, { role: 'room', buffer: 'R2', filename: 'r2' }]), null, 'two rooms → unresolvable');
});

test('resolveDualUploadStaging: maps the room and furniture buffers from a two-image upload', () => {
  const chair = { originalname: 'chair.png', mimetype: 'image/png', buffer: Buffer.from('chair-bytes') };
  const room = { originalname: 'living-room.png', mimetype: 'image/png', buffer: Buffer.from('room-bytes') };
  const res = resolveDualUploadStaging([chair, room], [], 'stage this');
  assert.ok(res, 'a room+furniture split is found');
  assert.ok(res.roomBuffer.equals(room.buffer), 'the room-named file is the room');
  assert.equal(res.furnitureBuffers.length, 1);
  assert.ok(res.furnitureBuffers[0].equals(chair.buffer), 'the chair-named file is the furniture');

  // The "stage my room" override kicks in only when the classifier CANNOT split
  // (here both files read as rooms) — it forces the last upload to be the room.
  const bedroom = { originalname: 'bedroom.png', mimetype: 'image/png', buffer: Buffer.from('bedroom') };
  const living = { originalname: 'living-room.png', mimetype: 'image/png', buffer: Buffer.from('living') };
  const overridden = resolveDualUploadStaging([bedroom, living], [], 'please stage my room');
  assert.ok(overridden, 'the override resolves the two-room ambiguity');
  assert.ok(overridden.roomBuffer.equals(living.buffer), 'the last upload becomes the room');
  assert.ok(overridden.furnitureBuffers[0].equals(bedroom.buffer));

  assert.equal(resolveDualUploadStaging([chair], [], 'x'), null, 'a single image is not a dual upload');
});
