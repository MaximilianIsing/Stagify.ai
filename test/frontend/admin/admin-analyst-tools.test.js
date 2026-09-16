// Tier: contract between the two halves of the analyst's tool layer.
//
// WHY THIS FILE IS SEPARATE FROM admin-analyst.test.js. That one tests what the
// executors RETURN. This one tests that they exist under the names the model is
// told about — a different failure with a much worse signature.
//
// The schemas live on the server (lib/services/admin-analyst-tools.js) and the
// executors live in the browser (public/scripts/admin/analyst-tools.js), for the
// reasons each of those files documents at length. The cost of that split is that
// NOTHING FAILS AT RUNTIME when they drift: rename a tool on one side and the model
// is offered a tool the browser cannot run, the browser answers "no such tool", and
// the model apologises and guesses. The operator sees a vague answer, not an error,
// which is the worst way for a bug to present in a console whose entire value is
// that its numbers can be trusted.
//
// So the name sets are pinned against each other here, the same way
// test/i18n/locale-data.test.js pins the browser's language table against the
// server's. This is a drift guard, not a unit test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ANALYST_TOOLS, ANALYST_TOOL_NAMES, toolsForModel } from '../../../lib/services/admin-analyst-tools.js';
import { ANALYST_EXECUTOR_NAMES, createAnalystTools } from '../../../public/scripts/admin/analyst-tools.js';

/** A tool factory over an empty dashboard — enough to enumerate the executors. */
function tools() {
  return createAnalystTools({
    ctx: { data: {} },
    identity: { handleFor: () => 'acct_000000', segment: (t) => [{ text: t, account: null }], reset() {} },
    currentFindings: () => ({ findings: [], failed: [] }),
    effectivePlan: (u) => (u && u.plan) || 'free',
  });
}

test('every declared tool has an executor, and every executor is declared', () => {
  const declared = [...ANALYST_TOOL_NAMES].sort();
  const executable = [...tools().names].sort();

  assert.deepEqual(
    executable,
    declared,
    'the schema registry and the browser executors have drifted — the model would be offered a tool '
    + 'nothing can run, and nothing would fail at runtime to tell you',
  );
  // The exported constant is what the drawer and other callers read, so it has to
  // agree with the factory rather than merely being near it.
  assert.deepEqual([...ANALYST_EXECUTOR_NAMES].sort(), declared);
});

test('the registry is non-empty and every entry is well formed', () => {
  assert.ok(ANALYST_TOOLS.length >= 8, `expected the full catalogue, found ${ANALYST_TOOLS.length}`);
  for (const t of ANALYST_TOOLS) {
    assert.match(t.name, /^[a-z][a-z0-9_]*$/, `tool name is not a valid identifier: ${t.name}`);
    assert.ok(t.description && t.description.length > 60, `${t.name} needs a description the model can act on`);
    assert.equal(t.parameters.type, 'object', `${t.name} parameters must be an object schema`);
    for (const req of t.parameters.required || []) {
      assert.ok(t.parameters.properties[req], `${t.name} requires "${req}" but does not declare it`);
    }
  }
  const names = ANALYST_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'two tools share a name, so one would shadow the other');
});

test('toolsForModel emits the shape the chat-completions API expects', () => {
  const wire = toolsForModel();
  assert.equal(wire.length, ANALYST_TOOLS.length);
  for (const t of wire) {
    assert.equal(t.type, 'function');
    assert.ok(t.function.name && t.function.description && t.function.parameters);
  }
});

test('an unknown tool name is answered, not thrown', () => {
  // The model can hallucinate a name. A throw here would kill the conversation;
  // an error string lets it correct itself on the next round.
  const out = JSON.parse(tools().run({ name: 'not_a_tool', arguments: '{}' }));
  assert.match(out.error, /No such tool/);
});

test('malformed arguments fall back to defaults rather than failing the turn', () => {
  // Every parameter is optional or clamped, so an unparseable bag still answers a
  // useful question — and burning a round-trip on "I could not parse that" is worse.
  const out = JSON.parse(tools().run({ name: 'render_outcomes', arguments: 'not json at all' }));
  assert.ok(!out.error, `a bad argument string should not produce an error: ${out.error}`);
  assert.ok(Array.isArray(out.rows));
});
