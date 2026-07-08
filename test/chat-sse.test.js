// -----------------------------------------------------------------------------
// Unit tests for lib/chat/chat-sse.js
//
// PURPOSE
//   chat-sse.js holds the Server-Sent-Events plumbing for streamed chat replies,
//   extracted verbatim from server.js. It is pure request/response glue with no
//   network, model, or store access, so every dependency here is a hand-rolled
//   fake — there is nothing real to reach out to.
//
// WHAT IS COVERED (asserting ACTUAL behavior of the real source, not guesses)
//   1. wantsStreamedChatResponse(req)
//        The streaming opt-in predicate. TRUE when any one of these holds:
//          - body.streamResponse === true          (boolean)
//          - body.streamResponse === 'true'         (string)
//          - req.query.stream === '1'
//          - req.headers['x-stream-response'] === '1'
//        FALSE when none are present, and specifically NOT tricked by the
//        falsey-but-present variants streamResponse:false and stream:'0'.
//        NOTE: the source reads req.headers WITHOUT optional chaining, so a
//        headers object is always supplied by these fakes (as a real Express
//        request would).
//
//   2. extractChatImagePayload(fullResponse)
//        Always carries `response`. Then copies ONLY the whitelisted image keys
//        that are actually present (!== undefined). A non-whitelisted key is
//        dropped; an undefined whitelisted key is omitted.
//
//   3. writeChatSseEvent(res, event, payload)
//        Emits exactly two writes: `event: <name>\n` then
//        `data: <JSON.stringify(payload)>\n\n`.
//
//   4. finishStreamedChatResponse(res, fullResponse)
//        Writes an `images` event (data === extractChatImagePayload(...)),
//        then a `done` event with {}, then calls res.end() exactly once.
//
// HOUSE STYLE
//   node:test runner, node:assert/strict, descriptive behavior-sentence names.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  wantsStreamedChatResponse,
  initChatSse,
  writeChatSseEvent,
  extractChatImagePayload,
  finishStreamedChatResponse,
} from '../lib/chat/chat-sse.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

// Minimal Express-request shape. The real predicate touches req.body,
// req.query, and req.headers, so every fake supplies all three (headers is
// read without optional chaining and would otherwise throw).
function makeReq({ body = {}, query = {}, headers = {} } = {}) {
  return { body, query, headers };
}

// A response double that concatenates every res.write() argument into one
// buffer and counts res.end() invocations. This mirrors exactly how the SSE
// helpers push bytes to the wire.
function makeRes() {
  const res = {
    written: '',
    endCalls: 0,
    write(chunk) {
      res.written += chunk;
      return true;
    },
    end() {
      res.endCalls += 1;
    },
  };
  return res;
}

// ---------------------------------------------------------------------------
// 1. wantsStreamedChatResponse
// ---------------------------------------------------------------------------

test('wantsStreamedChatResponse returns true when body.streamResponse is the boolean true', () => {
  const req = makeReq({ body: { streamResponse: true } });
  assert.equal(wantsStreamedChatResponse(req), true);
});

test("wantsStreamedChatResponse returns true when body.streamResponse is the string 'true'", () => {
  const req = makeReq({ body: { streamResponse: 'true' } });
  assert.equal(wantsStreamedChatResponse(req), true);
});

test("wantsStreamedChatResponse returns true when req.query.stream is '1'", () => {
  const req = makeReq({ query: { stream: '1' } });
  assert.equal(wantsStreamedChatResponse(req), true);
});

test("wantsStreamedChatResponse returns true when the x-stream-response header is '1'", () => {
  const req = makeReq({ headers: { 'x-stream-response': '1' } });
  assert.equal(wantsStreamedChatResponse(req), true);
});

test('wantsStreamedChatResponse returns false when no streaming signal is present at all', () => {
  const req = makeReq();
  assert.equal(wantsStreamedChatResponse(req), false);
});

test('wantsStreamedChatResponse returns false for the present-but-falsey opt-outs streamResponse:false and stream:0', () => {
  const req = makeReq({
    body: { streamResponse: false },
    query: { stream: '0' },
    headers: { 'x-stream-response': '0' },
  });
  assert.equal(wantsStreamedChatResponse(req), false);
});

test('wantsStreamedChatResponse tolerates a request with no body and still returns false', () => {
  // Source falls back to `req.body || {}`, so a bodyless request must not throw.
  const req = { query: {}, headers: {} };
  assert.equal(wantsStreamedChatResponse(req), false);
});

// ---------------------------------------------------------------------------
// 2. extractChatImagePayload
// ---------------------------------------------------------------------------

test('extractChatImagePayload always carries response and copies exactly the present whitelisted keys while dropping non-whitelisted and undefined ones', () => {
  const fullResponse = {
    response: 'hello world',
    // whitelisted + present -> kept
    stagedImage: 'data:staged',
    stagedImages: ['a', 'b'],
    stagingParams: { style: 'modern' },
    generatedImage: 'data:gen',
    generatedImages: ['g1'],
    cadImage: 'data:cad',
    cadImages: ['c1'],
    cadParams: { units: 'mm' },
    requestedImage: 'data:req',
    recalledImage: 'data:recalled',
    imageAnnotations: [{ x: 1 }],
    files: ['f1.png'],
    // whitelisted but explicitly undefined -> omitted
    stagedImageAnnotations: undefined,
    // NOT whitelisted -> dropped
    secret: 'x',
    internalBuffer: 'y',
  };

  const payload = extractChatImagePayload(fullResponse);

  assert.deepEqual(payload, {
    response: 'hello world',
    stagedImage: 'data:staged',
    stagedImages: ['a', 'b'],
    stagingParams: { style: 'modern' },
    generatedImage: 'data:gen',
    generatedImages: ['g1'],
    cadImage: 'data:cad',
    cadImages: ['c1'],
    cadParams: { units: 'mm' },
    requestedImage: 'data:req',
    recalledImage: 'data:recalled',
    imageAnnotations: [{ x: 1 }],
    files: ['f1.png'],
  });

  // Explicit spot-checks on the drop/omit behavior.
  assert.equal('secret' in payload, false);
  assert.equal('internalBuffer' in payload, false);
  assert.equal('stagedImageAnnotations' in payload, false);
});

test('extractChatImagePayload on a bare response yields only the response key', () => {
  const payload = extractChatImagePayload({ response: 'just text' });
  assert.deepEqual(payload, { response: 'just text' });
});

test('extractChatImagePayload carries an undefined response through when fullResponse has no response field', () => {
  // `response` is copied unconditionally, so it is present (as undefined) even
  // when the source object lacks it.
  const payload = extractChatImagePayload({ stagedImage: 'only-image' });
  assert.equal('response' in payload, true);
  assert.equal(payload.response, undefined);
  assert.equal(payload.stagedImage, 'only-image');
});

test('extractChatImagePayload passes through EVERY one of the 16 whitelisted image keys when present', () => {
  // Guards the whitelist itself: if any key were dropped from the source list,
  // this deepEqual (and the key count) would fail. Distinct values everywhere so
  // no two keys can be confused for one another.
  const fullResponse = {
    response: 'r',
    stagedImage: 's1', stagedImages: ['s2'], stagingParams: { a: 1 }, stagedImageAnnotations: { s: 1 },
    generatedImage: 'g1', generatedImages: ['g2'], generatedImageAnnotations: { g: 1 },
    cadImage: 'c1', cadImages: ['c2'], cadParams: { c: 1 }, cadImageAnnotation: 'ca1', cadImageAnnotations: { c: 2 },
    requestedImage: 'req', recalledImage: 'rec', imageAnnotations: [{ i: 1 }], files: ['f'],
  };
  const payload = extractChatImagePayload(fullResponse);
  assert.deepEqual(payload, fullResponse, 'all 16 whitelisted keys + response survive verbatim');
  assert.equal(Object.keys(payload).length, 17, 'response + 16 image keys, nothing more/less');
});

// ---------------------------------------------------------------------------
// 3. writeChatSseEvent
// ---------------------------------------------------------------------------

test('writeChatSseEvent emits an event line then a JSON data line terminated by a blank line', () => {
  const res = makeRes();
  const payload = { foo: 'bar', n: 7 };

  writeChatSseEvent(res, 'update', payload);

  assert.equal(
    res.written,
    `event: update\ndata: ${JSON.stringify(payload)}\n\n`,
  );
  // Concretely: the exact serialized bytes.
  assert.equal(res.written, 'event: update\ndata: {"foo":"bar","n":7}\n\n');
});

test('writeChatSseEvent serializes an empty payload as {}', () => {
  const res = makeRes();
  writeChatSseEvent(res, 'ping', {});
  assert.equal(res.written, 'event: ping\ndata: {}\n\n');
});

// ---------------------------------------------------------------------------
// 4. finishStreamedChatResponse
// ---------------------------------------------------------------------------

test('finishStreamedChatResponse writes an images event, then a done event, then ends the response exactly once', () => {
  const res = makeRes();
  const fullResponse = {
    response: 'all done',
    stagedImage: 'data:staged',
    secret: 'nope', // non-whitelisted, must not leak into the images event
  };

  finishStreamedChatResponse(res, fullResponse);

  const imagesPayload = extractChatImagePayload(fullResponse);
  const expected =
    `event: images\ndata: ${JSON.stringify(imagesPayload)}\n\n` +
    `event: done\ndata: {}\n\n`;

  assert.equal(res.written, expected);
  assert.equal(res.endCalls, 1);

  // The images event body must equal extractChatImagePayload and carry no
  // non-whitelisted keys.
  const imagesBlock = res.written.split('\n\n')[0]; // "event: images\ndata: {...}"
  const imagesJson = imagesBlock.slice(imagesBlock.indexOf('data: ') + 'data: '.length);
  assert.deepEqual(JSON.parse(imagesJson), {
    response: 'all done',
    stagedImage: 'data:staged',
  });
});

// ---------------------------------------------------------------------------
// 5. initChatSse
// ---------------------------------------------------------------------------

test('initChatSse sets a 200 status, the SSE headers, and flushes them', () => {
  const headers = {};
  let status;
  let flushed = 0;
  const res = {
    status(code) { status = code; return this; },
    setHeader(name, value) { headers[name] = value; },
    flushHeaders() { flushed += 1; },
  };

  initChatSse(res);

  assert.equal(status, 200);
  assert.equal(headers['Content-Type'], 'text/event-stream; charset=utf-8');
  assert.equal(headers['Cache-Control'], 'no-cache, no-transform');
  assert.equal(headers['Connection'], 'keep-alive');
  assert.equal(headers['X-Accel-Buffering'], 'no', 'disables proxy buffering so frames flush immediately');
  assert.equal(flushed, 1, 'flushHeaders is invoked when the platform provides it');
});
