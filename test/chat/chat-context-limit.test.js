// Tier: unit (no server) — lib/chat/chat-context-limit.js.
//
// WHAT THIS COVERS
// The conversation cap both chat endpoints enforce. Two things matter and neither
// is obvious from the call site: the comparison is `>=` (so the 20th user message
// is already refused, not the 21st), and the refusal is a 200 body carrying
// `contextLimitReached: true` — NOT an error status. The client keys off that flag
// to show the "reload the chat" hint, so a well-meant switch to a 4xx would break
// it silently.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_USER_MESSAGES,
  CONTEXT_LIMIT_MESSAGE,
  countUserMessages,
  isContextLimitReached,
  buildContextLimitResponse,
} from '../../lib/chat/chat-context-limit.js';

const userTurns = (n) => Array.from({ length: n }, () => ({ role: 'user', content: 'hi' }));

test('only user turns count toward the cap', () => {
  const mixed = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'system', content: 'c' },
    { role: 'user', content: 'd' },
  ];
  assert.equal(countUserMessages(mixed), 2);
  assert.equal(countUserMessages([]), 0);
});

test('the cap is inclusive: the MAX_USER_MESSAGES-th message is already refused', () => {
  assert.equal(isContextLimitReached(userTurns(MAX_USER_MESSAGES - 1)), false);
  assert.equal(isContextLimitReached(userTurns(MAX_USER_MESSAGES)), true);
  assert.equal(isContextLimitReached(userTurns(MAX_USER_MESSAGES + 5)), true);
});

test('assistant turns never push a conversation over the cap', () => {
  const history = [
    ...userTurns(MAX_USER_MESSAGES - 1),
    ...Array.from({ length: 50 }, () => ({ role: 'assistant', content: 'x' })),
  ];
  assert.equal(isContextLimitReached(history), false);
});

test('the refusal body is a success shape with the contextLimitReached flag', () => {
  const body = buildContextLimitResponse();
  assert.deepEqual(body, { response: CONTEXT_LIMIT_MESSAGE, contextLimitReached: true });
  // The client shows this verbatim; it must name the cap and the reload affordance.
  assert.match(body.response, new RegExp(`${MAX_USER_MESSAGES} messages`));
  assert.match(body.response, /reload/i);
  // No error field — this is a 200, not a failure.
  assert.equal('error' in body, false);
});

test('each call returns a fresh object (a handler could mutate it)', () => {
  assert.notEqual(buildContextLimitResponse(), buildContextLimitResponse());
});
