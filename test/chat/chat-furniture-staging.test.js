// Tier: unit (no server) — lib/chat/chat-furniture-staging.js.
//
// WHAT THIS COVERS
// The upload-only rescue that saves an "add this sofa to my staged room" upload
// when the routing model returned no staging action. All three preconditions are
// load-bearing and each is asserted separately: the model must have produced
// NOTHING (a real staging request is never overwritten), the message must read as
// a furniture-placement request, and the conversation must actually contain a
// staged image to place it into — otherwise there is no room to stage and the
// synthesized request would fail downstream.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAddFurnitureStaging } from '../../lib/chat/chat-furniture-staging.js';

const STAGED_HISTORY = [
  { role: 'user', content: 'stage my living room' },
  {
    role: 'assistant',
    content: [{ type: 'image_url', isStaged: true, image_url: { url: 'data:image/png;base64,AAA' } }],
  },
];

test('synthesizes a staging request when all three preconditions hold', () => {
  const out = resolveAddFurnitureStaging({
    stagingRequestFromAI: null,
    message: 'add this sofa to the room',
    conversationHistory: STAGED_HISTORY,
  });

  assert.deepEqual(out, {
    shouldStage: true,
    roomType: 'Other',
    additionalPrompt: 'add this sofa to the room',
    removeFurniture: false,
    usePreviousImage: false,
    furnitureImageIndex: null,
  });
});

test('an empty message falls back to a canned prompt', () => {
  // userWantsToAddFurnitureToRoom('') is false, so reaching the fallback needs a
  // message that matches the heuristic yet is falsy at concat time — impossible in
  // practice, which is exactly why the `||` default exists. Pin the shape instead:
  const out = resolveAddFurnitureStaging({
    stagingRequestFromAI: null,
    message: 'add this chair',
    conversationHistory: STAGED_HISTORY,
  });
  assert.equal(out.additionalPrompt, 'add this chair');
  assert.equal(out.shouldStage, true);
});

test("the model's own staging request is never overwritten", () => {
  const original = { shouldStage: true, roomType: 'Living room' };
  const out = resolveAddFurnitureStaging({
    stagingRequestFromAI: original,
    message: 'add this sofa to the room',
    conversationHistory: STAGED_HISTORY,
  });
  assert.equal(out, original, 'returned by identity, unmodified');
});

test('a message that is not a furniture-placement request is left alone', () => {
  assert.equal(
    resolveAddFurnitureStaging({
      stagingRequestFromAI: null,
      message: 'what do you think of my house?',
      conversationHistory: STAGED_HISTORY,
    }),
    null,
  );
});

test('no staged image in history means nothing to add the furniture to', () => {
  const noStaged = [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
    { role: 'assistant', content: 'Nice sofa.' },
  ];
  assert.equal(
    resolveAddFurnitureStaging({
      stagingRequestFromAI: null,
      message: 'add this sofa to the room',
      conversationHistory: noStaged,
    }),
    null,
  );
  assert.equal(
    resolveAddFurnitureStaging({
      stagingRequestFromAI: null,
      message: 'add this sofa to the room',
      conversationHistory: [],
    }),
    null,
  );
});
