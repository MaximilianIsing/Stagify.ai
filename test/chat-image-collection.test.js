// getPriorHistoryForImageContext (lib/chat/chat-image-collection.js) — when the
// client echoes the current upload back inside conversationHistory, this drops that
// trailing user message so the image-context builder does not count the same file
// twice. Pure list surgery; no I/O.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPriorHistoryForImageContext } from '../lib/chat/chat-image-collection.js';

const userWithImages = (...filenames) => ({
  role: 'user',
  content: filenames.map((filename) => ({ type: 'image_url', image_url: { url: `data:x,${filename}` }, filename })),
});

test('non-array / empty history passes straight through', () => {
  assert.deepEqual(getPriorHistoryForImageContext(null, ['a.jpg']), []);
  assert.deepEqual(getPriorHistoryForImageContext([], ['a.jpg']), []);
});

test('with no current-upload filenames the history is returned unchanged', () => {
  const history = [userWithImages('room.jpg')];
  assert.equal(getPriorHistoryForImageContext(history, []), history);
  assert.equal(getPriorHistoryForImageContext(history, undefined), history);
});

test('drops the trailing message when it only duplicates the current upload', () => {
  const history = [{ role: 'assistant', content: [] }, userWithImages('room.jpg')];
  const out = getPriorHistoryForImageContext(history, ['room.jpg']);
  assert.equal(out.length, 1, 'the echoed upload message is removed');
  assert.equal(out[0].role, 'assistant');
});

test('keeps the trailing message when it carries a different image', () => {
  const history = [userWithImages('other.jpg')];
  assert.equal(getPriorHistoryForImageContext(history, ['room.jpg']), history);
});

test('keeps the trailing message when it is not an image-bearing user turn', () => {
  const textTurn = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
  assert.equal(getPriorHistoryForImageContext(textTurn, ['room.jpg']), textTurn);

  const assistantLast = [userWithImages('room.jpg'), { role: 'assistant', content: [] }];
  assert.equal(getPriorHistoryForImageContext(assistantLast, ['room.jpg']), assistantLast);
});
