// OpenAI SDK contract. Every chat/vision/analyst call site and every test fake assumes
// `chat.completions.create(body)` sends `body` verbatim to /chat/completions and resolves
// to the raw JSON (`choices[0].message.content`, `tool_calls[].function`). The fakes can't
// notice an SDK major reshaping either side, so these tests drive the REAL client through
// its injectable fetch: a v7 → v8 change that breaks the contract fails here, not in prod.
// No network, no key.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';
import { createAiClients, OPENAI_TIMEOUT_MS } from '../../lib/services/ai-clients.js';

/** A fetch that records each request and replies from `replies` (last one repeats). */
function recordingFetch(replies) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? '{}')) });
    const { status = 200, body } = replies[Math.min(calls.length - 1, replies.length - 1)];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

const completion = (message, finish_reason = 'stop') => ({
  body: {
    id: 'chatcmpl-test', object: 'chat.completion', created: 0, model: 'gpt-test',
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason }],
  },
});

test('a routing request (vision + json_schema) reaches /chat/completions verbatim', async () => {
  const { fetch, calls } = recordingFetch([completion({ content: '{"response":"hi"}' })]);
  const openai = new OpenAI({ apiKey: 'sk-test', timeout: 5000, fetch });
  const body = {
    model: 'gpt-5-mini',
    messages: [
      { role: 'system', content: 'route' },
      { role: 'user', content: [
        { type: 'text', text: 'what room is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ] },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'r', strict: true, schema: { type: 'object' } } },
    max_completion_tokens: 200,
    reasoning_effort: 'minimal',
  };

  const res = await openai.chat.completions.create(/** @type {any} */ (body));

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/chat\/completions$/);
  assert.equal(calls[0].headers.get('authorization'), 'Bearer sk-test');
  assert.deepEqual(calls[0].body, body, 'the body is sent as-is, no renamed or dropped fields');
  assert.equal(res.choices[0].message.content, '{"response":"hi"}');
  assert.equal(res.choices[0].finish_reason, 'stop');
});

test('the deprecated max_tokens still passes through (welcome, erase, annotation, brief use it)', async () => {
  const { fetch, calls } = recordingFetch([completion({ content: 'Hello!' })]);
  const openai = new OpenAI({ apiKey: 'sk-test', timeout: 5000, fetch });
  await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], max_tokens: 50 });
  assert.equal(calls[0].body.max_tokens, 50);
});

test('tool calls come back in the shape admin-analyst reads', async () => {
  const toolCall = { id: 'call_1', type: 'function', function: { name: 'query_users', arguments: '{"limit":5}' } };
  const { fetch } = recordingFetch([completion({ content: null, tool_calls: [toolCall] }, 'tool_calls')]);
  const openai = new OpenAI({ apiKey: 'sk-test', timeout: 5000, fetch });
  const res = await openai.chat.completions.create({
    model: 'gpt-5-mini', messages: [{ role: 'user', content: 'how many users?' }],
    tools: [{ type: 'function', function: { name: 'query_users', parameters: { type: 'object' } } }],
    tool_choice: 'auto',
  });
  const [call] = /** @type {any[]} */ (res.choices[0].message.tool_calls);
  assert.equal(call.function.name, 'query_users');
  assert.equal(call.function.arguments, '{"limit":5}');
});

test('a 4xx rejects with .status and is not retried (callers catch and degrade)', async () => {
  const { fetch, calls } = recordingFetch([{ status: 400, body: { error: { message: 'bad model', type: 'invalid_request_error' } } }]);
  const openai = new OpenAI({ apiKey: 'sk-test', timeout: 5000, fetch });
  await assert.rejects(
    openai.chat.completions.create({ model: 'nope', messages: [{ role: 'user', content: 'x' }] }),
    (err) => err.status === 400 && /bad model/.test(err.message),
  );
  assert.equal(calls.length, 1);
});

// --- the factory's wiring -------------------------------------------------
const saved = process.env.GPT_KEY;
afterEach(() => {
  if (saved === undefined) delete process.env.GPT_KEY;
  else process.env.GPT_KEY = saved;
});

test('createAiClients builds the client with OPENAI_TIMEOUT_MS and the SDK default retries', () => {
  process.env.GPT_KEY = 'sk-test';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-openai-'));
  try {
    const { openai } = createAiClients({ __dirname: dir, DEBUG_MODE: false });
    assert.ok(openai instanceof OpenAI);
    assert.equal(openai.timeout, OPENAI_TIMEOUT_MS);
    assert.equal(openai.maxRetries, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
