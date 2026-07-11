// Furniture/room classification heuristics (lib/chat/chat-image-classification.js).
// These are pure over their inputs (message text, filename/annotation strings) and
// steer whether an upload is treated as a room to stage or a furniture reference to
// place — a misclassification silently sends the wrong image down the wrong pipeline.
// No fs, network, or model client is touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  userWantsToAddFurnitureToRoom,
  isLikelyFurnitureReferenceImage,
  isRoomImageForFurniturePlacement,
  classifyUploadImageRole,
} from '../lib/chat/chat-image-classification.js';

test('userWantsToAddFurnitureToRoom detects "add this chair"-style asks', () => {
  assert.equal(userWantsToAddFurnitureToRoom('add this chair to the room'), true);
  assert.equal(userWantsToAddFurnitureToRoom('put the sofa in the corner'), true);
  assert.equal(userWantsToAddFurnitureToRoom('incorporate that lamp'), true);
});

test('userWantsToAddFurnitureToRoom ignores full-room staging and junk input', () => {
  assert.equal(userWantsToAddFurnitureToRoom('stage this living room in a modern style'), false);
  assert.equal(userWantsToAddFurnitureToRoom(''), false);
  assert.equal(userWantsToAddFurnitureToRoom(null), false);
  assert.equal(userWantsToAddFurnitureToRoom(42), false);
});

test('isLikelyFurnitureReferenceImage keys off furniture terms without room terms', () => {
  assert.equal(isLikelyFurnitureReferenceImage({ filename: 'green-sofa.jpg' }), true);
  assert.equal(isLikelyFurnitureReferenceImage({ annotation: 'a walnut dresser on white' }), true);
});

test('isLikelyFurnitureReferenceImage rejects rooms, staged/generated, and empty inputs', () => {
  assert.equal(isLikelyFurnitureReferenceImage({ filename: 'living-room-sofa.jpg' }), false, 'room term present');
  assert.equal(isLikelyFurnitureReferenceImage({ filename: 'sofa.jpg', isStaged: true }), false);
  assert.equal(isLikelyFurnitureReferenceImage({ filename: 'sofa.jpg', isGenerated: true }), false);
  assert.equal(isLikelyFurnitureReferenceImage(null), false);
});

test('isRoomImageForFurniturePlacement: staged/generated always qualify, furniture refs never do', () => {
  assert.equal(isRoomImageForFurniturePlacement({ isStaged: true, filename: 'sofa.jpg' }), true);
  assert.equal(isRoomImageForFurniturePlacement({ isGenerated: true }), true);
  assert.equal(isRoomImageForFurniturePlacement({ filename: 'empty-bedroom.jpg' }), true);
  assert.equal(isRoomImageForFurniturePlacement({ filename: 'product-sofa.jpg' }), false, 'furniture ref is not a room');
  assert.equal(isRoomImageForFurniturePlacement(null), false);
});

test('classifyUploadImageRole labels furniture, rooms, and the unknown fallback', () => {
  assert.equal(classifyUploadImageRole({ filename: 'sofa-product-shot.jpg' }), 'furniture');
  assert.equal(classifyUploadImageRole({ filename: 'listing-photo-kitchen.jpg' }), 'room');
  assert.equal(classifyUploadImageRole({ isStaged: true }), 'room', 'staged images are rooms');
  assert.equal(classifyUploadImageRole({ filename: 'IMG_1234.jpg' }), 'unknown');
  assert.equal(classifyUploadImageRole(null), 'unknown');
});
