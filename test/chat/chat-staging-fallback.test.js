// Tier: unit (no server) — lib/chat/chat-staging-fallback.js.
//
// WHAT THIS COVERS
// The last-resort base image each endpoint offers the staging dispatch. The two
// answers are deliberately different and each has one non-obvious rule:
//   - /api/chat labels its source 'staged image' vs 'conversation history', which
//     is what the staging prompt keys off to decide it is re-staging rather than
//     staging fresh;
//   - /api/chat-upload REFUSES to offer the upload when the message reads as
//     "add this furniture to my staged room" — the upload is the furniture there,
//     and using it as the base would stage the sofa instead of the room.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveHistoryFallbackImage,
  resolveCurrentUploadFallbackImage,
} from '../../lib/chat/chat-staging-fallback.js';

const dataUrl = (text) => 'data:image/png;base64,' + Buffer.from(text).toString('base64');

test('/api/chat: decodes the history image and labels a staged source', () => {
  const out = resolveHistoryFallbackImage({ imageFromHistory: dataUrl('prev'), isStagedImage: true });
  assert.equal(out.buffer.toString(), 'prev');
  assert.equal(out.source, 'staged image');
  assert.match(out.logMessage, /conversation history \(fallback\)/);
});

test('/api/chat: a user upload from history is labelled differently', () => {
  const out = resolveHistoryFallbackImage({ imageFromHistory: dataUrl('prev'), isStagedImage: false });
  assert.equal(out.source, 'conversation history');
});

test('/api/chat: no history image, or one with no base64 payload, yields null', () => {
  assert.equal(resolveHistoryFallbackImage({ imageFromHistory: null, isStagedImage: false }), null);
  assert.equal(resolveHistoryFallbackImage({ imageFromHistory: '', isStagedImage: true }), null);
  assert.equal(
    resolveHistoryFallbackImage({ imageFromHistory: 'https://example.com/x.png', isStagedImage: false }),
    null,
  );
});

test('/api/chat-upload: offers the current upload as the base', () => {
  const firstImageFile = { originalname: 'room.png', mimetype: 'image/png', buffer: Buffer.from('room') };
  const out = resolveCurrentUploadFallbackImage({ firstImageFile, message: 'stage this living room' });
  assert.equal(out.buffer, firstImageFile.buffer, 'the buffer is passed through, not re-decoded');
  assert.equal(out.source, 'current message');
});

test('/api/chat-upload: an "add this furniture to the room" message suppresses the upload as base', () => {
  const firstImageFile = { originalname: 'sofa.png', mimetype: 'image/png', buffer: Buffer.from('sofa') };
  assert.equal(
    resolveCurrentUploadFallbackImage({ firstImageFile, message: 'add this sofa to the room' }),
    null,
  );
});

test('/api/chat-upload: no image in the upload yields null', () => {
  assert.equal(resolveCurrentUploadFallbackImage({ firstImageFile: null, message: 'hello' }), null);
});
