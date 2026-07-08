// Unit tests for the AI Designer SSE stream parser extracted into
// public/scripts/ai-designer/chat-sse-client.js. Driven with a fake Response
// whose body.getReader() yields TextEncoder chunks — no network, no DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { consumeChatSse } from '../public/scripts/ai-designer/chat-sse-client.js';

// Build a fake fetch Response that streams the given string chunks (each a raw
// slice of the event-stream, so tests can split events across reads).
function fakeSseResponse(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    body: {
      getReader() {
        return {
          async read() {
            if (i < chunks.length) return { done: false, value: encoder.encode(chunks[i++]) };
            return { done: true, value: undefined };
          },
        };
      },
    },
  };
}

function collector() {
  const calls = { status: [], message: [], images: [], error: [] };
  return {
    calls,
    handlers: {
      onStatus: (p) => calls.status.push(p),
      onMessage: (p) => calls.message.push(p),
      onImages: (p) => calls.images.push(p),
      onError: (p) => calls.error.push(p),
    },
  };
}

test('dispatches each named event to its handler with the parsed payload', async () => {
  const { calls, handlers } = collector();
  await consumeChatSse(fakeSseResponse([
    'event: status\ndata: {"type":"staging"}\n\n',
    'event: message\ndata: {"response":"hi"}\n\n',
    'event: images\ndata: {"staged":["a"]}\n\n',
  ]), handlers);
  assert.deepEqual(calls.status, [{ type: 'staging' }]);
  assert.deepEqual(calls.message, [{ response: 'hi' }]);
  assert.deepEqual(calls.images, [{ staged: ['a'] }]);
  assert.equal(calls.error.length, 0);
});

test('reassembles an event split across multiple stream reads', async () => {
  const { calls, handlers } = collector();
  await consumeChatSse(fakeSseResponse([
    'event: mess',
    'age\ndata: {"response":"',
    'chunked"}\n\n',
  ]), handlers);
  assert.deepEqual(calls.message, [{ response: 'chunked' }]);
});

test('handles multiple events delivered in a single read', async () => {
  const { calls, handlers } = collector();
  await consumeChatSse(fakeSseResponse([
    'event: status\ndata: {"type":"a"}\n\nevent: status\ndata: {"type":"b"}\n\n',
  ]), handlers);
  assert.deepEqual(calls.status, [{ type: 'a' }, { type: 'b' }]);
});

test('defaults to the message event when no event: line is present', async () => {
  const { calls, handlers } = collector();
  await consumeChatSse(fakeSseResponse(['data: {"response":"default"}\n\n']), handlers);
  assert.deepEqual(calls.message, [{ response: 'default' }]);
});

test('skips blocks with no data: line, and an incomplete trailing block', async () => {
  const { calls, handlers } = collector();
  await consumeChatSse(fakeSseResponse([
    'event: status\n\n',                 // no data -> skipped
    'event: error\ndata: {"m":1}\n\n',
    'event: message\ndata: {"response":"never terminated"}',  // no \n\n -> not emitted
  ]), handlers);
  assert.deepEqual(calls.error, [{ m: 1 }]);
  assert.equal(calls.message.length, 0);
  assert.equal(calls.status.length, 0);
});

test('missing handlers are simply not called (all optional)', async () => {
  // Only onImages provided; status/message/error events must not throw.
  const seen = [];
  await consumeChatSse(fakeSseResponse([
    'event: status\ndata: {"type":"x"}\n\n',
    'event: images\ndata: {"n":2}\n\n',
  ]), { onImages: (p) => seen.push(p) });
  assert.deepEqual(seen, [{ n: 2 }]);
});
