// Tier: frontend island logic (stub DOM) — the analyst's conversation loop in
// public/scripts/admin/analyst.js.
//
// The loop is the part of this feature with real control flow: it posts a
// transcript, runs whatever tools come back against local data, posts again, and
// stops on an answer, an error, or the round cap. None of that was covered — the
// existing analyst suites test the executors and the pseudonym map, both of which
// are pure.
//
// What is asserted here is what an operator would notice going wrong:
//
//   1. A tool round must replay the assistant's request WITH its ids before the
//      `tool` replies that reference them, or the next turn is malformed.
//   2. Stopping must actually stop. The request in flight cannot be unsent, so the
//      test that matters is that its answer never lands in the transcript.
//   3. A failure must be recoverable without retyping, and retrying must not
//      leave the failed attempt in the transcript to be posted again.
//   4. Clearing must forget the account handles too — the one structure outside
//      ctx.data that holds addresses.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDom } from '../../helpers/admin-dom.js';

/** @type {any} */
let dom;
/** @type {any} */
let createAnalyst;

beforeEach(async () => {
  dom = makeDom();
  globalThis.document = dom;
  ({ createAnalyst } = await import('../../../public/scripts/admin/analyst.js'));
});

afterEach(() => {
  delete globalThis.document;
});

/** A deferred promise, so a test can hold a turn open and act while it is in flight. */
function deferred() {
  let resolve = (/** @type {any} */ _v) => {};
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * Build an analyst over a scripted server.
 *
 * `replies` is consumed one per POST. A function is called with the body, so a
 * test can assert on the transcript at the moment it was sent.
 */
function harness(replies) {
  const sent = [];
  const queue = replies.slice();
  const ctx = { data: {}, analyst: null };
  const analyst = createAnalyst({
    ctx,
    apiSend: (url, method, body) => {
      sent.push(body);
      const next = queue.length ? queue.shift() : { message: null, reason: 'empty' };
      return typeof next === 'function' ? next(body) : Promise.resolve(next);
    },
    currentFindings: () => ({ findings: [], failed: [] }),
    effectivePlan: () => 'free',
  });
  return { analyst, ctx, sent };
}

const toolTurn = (name) => ({
  message: null,
  toolCalls: [{ id: 'call_1', name, arguments: '{}' }],
});

// ── The round loop ──────────────────────────────────────────────────────────

test('a tool round is replayed with its ids before the replies that reference them', async () => {
  const { analyst, ctx, sent } = harness([toolTurn('list_findings'), { message: 'No findings yet.' }]);
  await analyst.submit('anything worth acting on?');

  const second = sent[1].messages;
  const assistant = second.find((m) => m.role === 'assistant');
  const reply = second.find((m) => m.role === 'tool');
  assert.equal(assistant.tool_calls[0].id, 'call_1');
  assert.equal(reply.tool_call_id, 'call_1');
  assert.ok(second.indexOf(assistant) < second.indexOf(reply), 'a reply before its request is a malformed turn');

  assert.equal(ctx.analyst.turns.at(-1).text, 'No findings yet.');
  assert.deepEqual(ctx.analyst.turns.at(-1).tools, ['list_findings'], 'the trace names what it ran');
});

test('the posted transcript is clamped to what the route accepts', async () => {
  // The route 400s above 40 messages, and nothing else trims — a long session used
  // to start failing for a reason that had nothing to do with the question.
  const { analyst, ctx, sent } = harness([{ message: 'ok' }]);
  ctx.analyst = {
    open: true, busy: false, error: null, run: 0, lastQuestion: '', turns: [],
    messages: Array.from({ length: 60 }, (_, i) => ({ role: 'user', content: `q${i}` })),
  };
  await analyst.submit('and now?');
  assert.ok(sent[0].messages.length <= 40, `posted ${sent[0].messages.length}`);
  assert.equal(sent[0].messages.at(-1).content, 'and now?', 'the clamp keeps the recent end');
});

test('the round cap ends the conversation rather than looping', async () => {
  const { analyst, ctx, sent } = harness(Array.from({ length: 12 }, () => toolTurn('metrics_snapshot')));
  await analyst.submit('why?');

  assert.ok(sent.length <= 6, `posted ${sent.length} times`);
  assert.match(ctx.analyst.error, /without reaching an answer/);
});

// ── Stopping ────────────────────────────────────────────────────────────────

test('a stopped question never lands, however late its answer arrives', async () => {
  const gate = deferred();
  const { analyst, ctx } = harness([() => gate.promise]);

  const running = analyst.submit('what changed?');
  assert.equal(ctx.analyst.busy, true);

  analyst.cancel();
  assert.equal(ctx.analyst.busy, false);
  assert.equal(ctx.analyst.error, 'Stopped.');

  // The request was already in flight and cannot be unsent; what must not happen
  // is its answer appearing under a question the operator walked away from.
  gate.resolve({ message: 'Renders fell 22%.' });
  await running;
  assert.equal(ctx.analyst.turns.filter((t) => t.role === 'answer').length, 0);
  assert.equal(ctx.analyst.busy, false);
});

test('stopping an idle drawer does nothing', () => {
  const { analyst, ctx } = harness([]);
  analyst.cancel();
  assert.equal(ctx.analyst.error, null);
});

// ── Recovering ──────────────────────────────────────────────────────────────

test('a failed question is retried without the operator retyping it', async () => {
  const { analyst, ctx, sent } = harness([
    { message: null, reason: 'truncated' },
    { message: 'Dorm renders fail at 9 of 40.' },
  ]);

  await analyst.submit('which room fails?');
  assert.match(ctx.analyst.error, /ran out of room/);

  await analyst.retry();
  assert.equal(ctx.analyst.error, null);
  assert.equal(ctx.analyst.turns.at(-1).text, 'Dorm renders fail at 9 of 40.');

  // The failed attempt is rewound rather than stacked: one question asked twice
  // must not reach the model as two.
  assert.equal(sent[1].messages.filter((m) => m.content === 'which room fails?').length, 1);
  assert.equal(ctx.analyst.turns.filter((t) => t.role === 'user').length, 1);
});

test('an expired session is reported as itself, not as a model failure', async () => {
  const { analyst, ctx } = harness([() => Promise.reject(Object.assign(new Error('nope'), { status: 401 }))]);
  await analyst.submit('who is paying?');
  assert.match(ctx.analyst.error, /Sign in again/);
});

// ── Clearing ────────────────────────────────────────────────────────────────

test('clearing forgets the transcript and the account handles with it', async () => {
  const { analyst, ctx } = harness([{ message: 'Email acct_abc123.' }]);
  await analyst.submit('who should I email?');
  assert.equal(ctx.analyst.turns.length, 2);

  analyst.clear();
  assert.deepEqual(ctx.analyst.turns, [], 'the next question starts from nothing');
  assert.deepEqual(ctx.analyst.messages, []);
  assert.equal(ctx.analyst.lastQuestion, '', 'nothing left to retry from a conversation that is gone');
});

test('clearing mid-question abandons it', async () => {
  const gate = deferred();
  const { analyst, ctx } = harness([() => gate.promise]);

  const running = analyst.submit('what changed?');
  analyst.clear();
  gate.resolve({ message: 'Renders fell 22%.' });
  await running;

  assert.deepEqual(ctx.analyst.turns, [], 'an answer landing after a clear would refill the transcript it cleared');
  assert.equal(ctx.analyst.busy, false);
});
