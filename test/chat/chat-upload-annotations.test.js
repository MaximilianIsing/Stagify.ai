// Tier: unit (no server) — lib/chat/chat-upload-annotations.js.
//
// WHAT THIS COVERS
// The map of per-upload image annotations the /api/chat-upload response carries
// back to the browser. It is built from the PRIVATE `_annotation` / `_filename`
// side-channel (those keys are stripped before the array goes to OpenAI), with an
// index-aligned fallback to the pre-clean item's filename. The alignment is the
// fragile part: the fallback indexes `filteredUserContent` with the CLEANED item's
// index, so the two arrays must stay positionally paired.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractUploadImageAnnotations } from '../../lib/chat/chat-upload-annotations.js';

test('keys each annotation by the item\'s own _filename', () => {
  const cleanedUserContent = [
    { type: 'text', text: 'stage these' },
    { type: 'image_url', _annotation: 'a bright living room', _filename: 'room.png' },
    { type: 'image_url', _annotation: 'a grey sofa', _filename: 'sofa.png' },
  ];
  const out = extractUploadImageAnnotations({ cleanedUserContent, filteredUserContent: [] });
  assert.deepEqual(out, { 'room.png': 'a bright living room', 'sofa.png': 'a grey sofa' });
});

test('falls back to the index-aligned pre-clean item (filename, then originalname)', () => {
  const cleanedUserContent = [
    { type: 'image_url', _annotation: 'first' },
    { type: 'image_url', _annotation: 'second' },
  ];
  const filteredUserContent = [
    { filename: 'from-filename.png' },
    { originalname: 'from-originalname.png' },
  ];
  const out = extractUploadImageAnnotations({ cleanedUserContent, filteredUserContent });
  assert.deepEqual(out, { 'from-filename.png': 'first', 'from-originalname.png': 'second' });
});

test('_filename wins over the index-aligned fallback', () => {
  const out = extractUploadImageAnnotations({
    cleanedUserContent: [{ type: 'image_url', _annotation: 'x', _filename: 'own.png' }],
    filteredUserContent: [{ filename: 'other.png' }],
  });
  assert.deepEqual(out, { 'own.png': 'x' });
});

test('items with no annotation, no filename, or the wrong type are skipped', () => {
  const out = extractUploadImageAnnotations({
    cleanedUserContent: [
      { type: 'text', text: 'hi', _annotation: 'ignored — not an image' },
      { type: 'image_url', _filename: 'no-annotation.png' },
      { type: 'image_url', _annotation: 'unattributable' },
      { type: 'image_url', _annotation: 'kept', _filename: 'ok.png' },
    ],
    filteredUserContent: [],
  });
  assert.deepEqual(out, { 'ok.png': 'kept' });
});

test('an empty content array yields an empty map, not null', () => {
  assert.deepEqual(extractUploadImageAnnotations({ cleanedUserContent: [], filteredUserContent: [] }), {});
});

test('the last annotation wins when two uploads share a filename', () => {
  const out = extractUploadImageAnnotations({
    cleanedUserContent: [
      { type: 'image_url', _annotation: 'first', _filename: 'dup.png' },
      { type: 'image_url', _annotation: 'second', _filename: 'dup.png' },
    ],
    filteredUserContent: [],
  });
  assert.deepEqual(out, { 'dup.png': 'second' });
});
