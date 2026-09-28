// Gemini adapter (lib/services/gemini-client.js). Nine call sites and every Gemini test
// fake speak the old @google/generative-ai shape; this adapter is what keeps them true on
// the current SDK. These tests drive the REAL @google/genai client through its injectable
// fetch, so a field the SDK renames or a request it reshapes fails here, not in production.
// No network, no key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiClient } from '../../lib/services/gemini-client.js';

const IMAGE_B64 = Buffer.from('fake-png').toString('base64');

/** A fetch that records each request and replies from `replies` (last one repeats). */
function recordingFetch(replies) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    const { status = 200, body } = replies[Math.min(calls.length - 1, replies.length - 1)];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

const imageReply = {
  body: {
    candidates: [{
      content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: IMAGE_B64 } }] },
      finishReason: 'STOP',
    }],
  },
};

test('generationConfig reaches the API as generationConfig, and Part[] as one user turn', async () => {
  const { fetch, calls } = recordingFetch([imageReply]);
  const genAI = createGeminiClient('test-key', { timeoutMs: 5000, attempts: 1, fetch });
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash-image',
    generationConfig: { seed: 42, temperature: 0.5, imageConfig: { aspectRatio: '4:3' } },
  });

  await model.generateContent([
    { text: 'stage this room' },
    { inlineData: { mimeType: 'image/jpeg', data: IMAGE_B64 } },
  ]);

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /models\/gemini-2\.5-flash-image:generateContent/);
  const { contents, generationConfig } = calls[0].body;
  assert.equal(contents.length, 1, 'the parts form a single turn');
  assert.equal(contents[0].role, 'user');
  assert.deepEqual(contents[0].parts.map((p) => Object.keys(p)[0]), ['text', 'inlineData']);
  assert.equal(generationConfig.seed, 42);
  assert.equal(generationConfig.temperature, 0.5);
  assert.deepEqual(generationConfig.imageConfig, { aspectRatio: '4:3' });
});

test('thinkingConfig passes through (segment.js and image-review.js switch thinking off)', async () => {
  const { fetch, calls } = recordingFetch([{ body: { candidates: [{ content: { parts: [{ text: '[]' }] } }] } }]);
  const genAI = createGeminiClient('test-key', { timeoutMs: 5000, attempts: 1, fetch });
  await genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: { thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 2048 },
  }).generateContent([{ text: 'find the sofa' }]);

  assert.deepEqual(calls[0].body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  assert.equal(calls[0].body.generationConfig.maxOutputTokens, 2048);
});

test('the response keeps the old shape: result.response.candidates and text()', async () => {
  const { fetch } = recordingFetch([{
    body: { candidates: [{ content: { parts: [{ text: '  {"ok":true}  ' }] }, finishReason: 'STOP' }] },
  }]);
  const genAI = createGeminiClient('test-key', { timeoutMs: 5000, attempts: 1, fetch });
  const result = await genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' }).generateContent([{ text: 'grade' }]);

  const response = await result.response;
  assert.equal(response.text(), '  {"ok":true}  ');
  assert.equal(response.candidates[0].finishReason, 'STOP');
});

test('an image-only reply exposes its inlineData, and text() is a safe empty string', async () => {
  const { fetch } = recordingFetch([imageReply]);
  const genAI = createGeminiClient('test-key', { timeoutMs: 5000, attempts: 1, fetch });
  const { response } = await genAI.getGenerativeModel({ model: 'gemini-2.5-flash-image' }).generateContent([{ text: 'x' }]);

  assert.equal(response.candidates[0].content.parts[0].inlineData.data, IMAGE_B64);
  assert.equal(response.text(), '');
});

test('a blocked prompt yields no candidates and an empty text(), not a throw', async () => {
  const { fetch } = recordingFetch([{ body: { promptFeedback: { blockReason: 'SAFETY' } } }]);
  const genAI = createGeminiClient('test-key', { timeoutMs: 5000, attempts: 1, fetch });
  const { response } = await genAI.getGenerativeModel({ model: 'gemini-2.5-flash-image' }).generateContent([{ text: 'x' }]);

  assert.equal(response.candidates, undefined);
  assert.equal(response.promptFeedback.blockReason, 'SAFETY');
  assert.equal(response.text(), '');
});

test('attempts caps the SDK retry: a 503 is retried once at attempts=2, never at attempts=1', async () => {
  const unavailable = { status: 503, body: { error: { code: 503, message: 'overloaded', status: 'UNAVAILABLE' } } };

  const once = recordingFetch([unavailable]);
  const noRetry = createGeminiClient('test-key', { timeoutMs: 5000, attempts: 1, fetch: once.fetch });
  await assert.rejects(noRetry.getGenerativeModel({ model: 'm' }).generateContent([{ text: 'x' }]));
  assert.equal(once.calls.length, 1, 'attempts=1 must not retry');

  const twice = recordingFetch([unavailable, imageReply]);
  const oneRetry = createGeminiClient('test-key', { timeoutMs: 5000, attempts: 2, fetch: twice.fetch });
  const { response } = await oneRetry.getGenerativeModel({ model: 'm' }).generateContent([{ text: 'x' }]);
  assert.equal(twice.calls.length, 2, 'attempts=2 retries the 503 once');
  assert.ok(response.candidates[0].content.parts[0].inlineData);
});
