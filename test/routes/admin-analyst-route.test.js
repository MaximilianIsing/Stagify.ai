// Tier: route (routes/admin-analyst.js) — the console's analyst endpoint.
//
// WHY A SEPARATE FILE, AND WHAT IT IS ACTUALLY FOR. This is the second admin route
// that sends anything to a third party, and the first that does so repeatedly, in a
// loop, carrying whatever the browser put in a transcript. So the assertions here
// are about the contract rather than the arithmetic:
//
//   - **The gate**, because this one costs money per call.
//   - **The ordering of protectLogs and express.json**, because an unauthenticated
//     body must never be parsed. That is asserted directly rather than read off the
//     source, since it is a one-character mistake to make and silent to have made.
//   - **Degradation**, because a deployment without GPT_KEY must show a drawer that
//     explains itself, not a 500. `ask` never throws; the route must not invent a
//     way to.
//   - **The tool-call round trip**, because the loop lives in the browser and the
//     server's only job in it is to relay ids faithfully. An id mangled here breaks
//     every following `tool` message and the model simply gets confused.
//
// What the model is actually SENT is covered in test/services/admin-analyst.test.js
// against a stub client; what the tools RETURN is covered in
// test/frontend/admin/admin-analyst.test.js. This file fakes the service on purpose.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAdminAnalystRouter } from '../../routes/admin-analyst.js';

const KEY = 'test-endpoint-key';
const auth = { 'X-Stagify-Endpoint-Key': KEY, 'Content-Type': 'application/json' };

/** Every server opened by a test, so none is left holding the runner open. */
const servers = [];
afterEach(() => { while (servers.length) servers.pop().close(); });

/**
 * Mount the router with a spy service.
 * `configured: false` leaves the dep off the bag — the no-key deployment.
 */
async function mount({ configured = true, answer = { message: 'All quiet.' } } = {}) {
  const calls = [];
  const app = express();
  const protectLogs = (req, res, next) => (
    req.get('X-Stagify-Endpoint-Key') === KEY ? next() : res.status(403).json({ error: 'Forbidden' })
  );
  app.use(createAdminAnalystRouter({
    adminAnalyst: configured
      ? { ask: async (arg) => { calls.push(arg); return typeof answer === 'function' ? answer(arg) : answer; } }
      : null,
    protectLogs,
    setSensitiveHeaders: (res) => res.set('Referrer-Policy', 'no-referrer'),
  }));
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(srv);
  return { url: `http://127.0.0.1:${srv.address().port}/api/admin/analyst`, calls };
}

const ask = (url, body, headers = auth) =>
  fetch(url, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

// ── The gate ────────────────────────────────────────────────────────────────

test('the endpoint is behind the admin gate', async () => {
  const { url, calls } = await mount();
  const res = await ask(url, { messages: [{ role: 'user', content: 'hi' }] }, { 'Content-Type': 'application/json' });
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0, 'an unauthenticated request must not reach the model');
});

test('an unauthenticated body is rejected without being parsed', async () => {
  // protectLogs runs BEFORE express.json(). If that ordering is ever swapped, this
  // malformed body would produce a 400 from the parser instead of a 403 from the
  // guard — which is how an unauthenticated caller gets to spend our CPU.
  const { url } = await mount();
  const res = await ask(url, '{ this is not json', { 'Content-Type': 'application/json' });
  assert.equal(res.status, 403, 'the guard must answer before the parser does');
});

// ── Degradation ─────────────────────────────────────────────────────────────

test('a deployment with no model answers 200 with a reason, not an error', async () => {
  const { url } = await mount({ configured: false });
  const res = await ask(url, { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 200, 'a missing dependency must not read as an outage');
  assert.deepEqual(await res.json(), { message: null, reason: 'unavailable' });
});

test('a missing or non-array messages field is a 400', async () => {
  const { url, calls } = await mount();
  for (const body of [{}, { messages: 'hello' }, { messages: null }]) {
    const res = await ask(url, body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
  assert.equal(calls.length, 0);
});

test('an oversized transcript is refused before it reaches the model', async () => {
  const { url, calls } = await mount();
  const messages = Array.from({ length: 41 }, (_, i) => ({ role: 'user', content: `q${i}` }));
  const res = await ask(url, { messages });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /at most 40/);
  assert.equal(calls.length, 0);
});

// ── The happy paths ─────────────────────────────────────────────────────────

test('a finished answer is returned verbatim', async () => {
  const { url, calls } = await mount({ answer: { message: 'Renders fell 22%.', model: 'gpt-5' } });
  const res = await ask(url, { messages: [{ role: 'user', content: 'what changed?' }] });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { message: 'Renders fell 22%.', model: 'gpt-5' });
  assert.deepEqual(calls[0].messages, [{ role: 'user', content: 'what changed?' }]);
});

test('tool calls are relayed with their ids intact', async () => {
  // The browser executes these and replies with `tool` messages keyed to these ids.
  // A mangled id breaks every following message in the conversation.
  const toolCalls = [
    { id: 'call_abc123', name: 'segment_breakdown', arguments: '{"field":"roomType"}' },
    { id: 'call_def456', name: 'render_outcomes', arguments: '{"days":7}' },
  ];
  const { url } = await mount({ answer: { message: null, toolCalls, model: 'gpt-5' } });
  const res = await ask(url, { messages: [{ role: 'user', content: 'which room fails?' }] });
  const body = await res.json();
  assert.deepEqual(body.toolCalls, toolCalls);
});

test('a transcript carrying tool results is passed through unchanged', async () => {
  // The route is a relay, not an editor — the service owns sanitisation, and a
  // route that also rewrote the transcript would give two places to disagree.
  const messages = [
    { role: 'user', content: 'which room fails?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'segment_breakdown', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"rows":[]}' },
  ];
  const { url, calls } = await mount();
  await ask(url, { messages });
  assert.deepEqual(calls[0].messages, messages);
});

// ── Caching ─────────────────────────────────────────────────────────────────

test('the answer is never cached', async () => {
  // It quotes the operator's own analytics back at them. Not a credential, but not
  // something to leave in a shared cache either.
  const { url } = await mount();
  const res = await ask(url, { messages: [{ role: 'user', content: 'hi' }] });
  assert.match(res.headers.get('cache-control') || '', /no-store/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
});
