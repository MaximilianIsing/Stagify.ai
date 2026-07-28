// Tier: unit (no server) — lib/chat/chat-post-routing.js.
//
// WHAT THIS COVERS
// The sequencing of the five post-routing dispatch steps, and above all THE ONE
// THING THAT MUST NOT BE UNIFIED: /api/chat generates before it stages, while
// /api/chat-upload stages before it generates. Both handlers now share this
// runner, so the only thing keeping their behaviour apart is the `order` they
// pass — hence the first two tests assert the real call sequence for each
// endpoint's constant, and a third asserts the runner refuses a malformed order
// instead of quietly skipping a dispatch step.
//
// The text-folding asymmetry is pinned too: the generate step concatenates
// unguarded (`text + suffix`) while staging and CAD guard with `(text || '')`.
// That difference is inherited verbatim from the handlers; it is observable when
// the routing reply text is null, so it is asserted rather than tidied away.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import createPostRoutingDispatch, {
  GENERATE_THEN_STAGING,
  STAGING_THEN_GENERATE,
} from '../../lib/chat/chat-post-routing.js';

// A recording set of pipeline steps. Each returns a marker so the caller's
// argument bundles and the collected results can be traced.
function makeSteps(overrides = {}) {
  /** @type {string[]} */
  const calls = [];
  const steps = {
    runStagingRequests: async (args) => {
      calls.push(`staging:${args && args.tag}`);
      return { stagingResults: ['STAGED'], ...(overrides.staging || {}) };
    },
    runGenerateRequests: async (args) => {
      calls.push(`generate:${args && args.tag}`);
      return { generatedImages: ['GENERATED'], ...(overrides.generate || {}) };
    },
    resolveRecalledImage: (args) => {
      calls.push(`recall:${args && args.tag}`);
      return 'RECALLED';
    },
    resolveRequestedImage: async (args) => {
      calls.push(`requested:${args && args.tag}`);
      return {
        requestedImageForDisplay: 'REQUESTED',
        text: overrides.requestedText !== undefined ? overrides.requestedText : args.text,
      };
    },
    runCadRequests: async (args) => {
      calls.push(`cad:${args && args.tag}`);
      return { cadResults: ['CAD'], ...(overrides.cad || {}) };
    },
  };
  return { calls, steps };
}

const bundles = {
  stagingArgs: { tag: 's' },
  generateArgs: { tag: 'g' },
  recallArgs: { tag: 'r' },
  requestedArgs: { tag: 'i' },
  cadArgs: { tag: 'c' },
};

test('/api/chat order: generate runs BEFORE staging', async () => {
  const { calls, steps } = makeSteps();
  const { runPostRoutingDispatch } = createPostRoutingDispatch(steps);

  await runPostRoutingDispatch({ text: 'hi', order: GENERATE_THEN_STAGING, ...bundles });

  assert.deepEqual(calls, ['generate:g', 'staging:s', 'recall:r', 'requested:i', 'cad:c']);
});

test('/api/chat-upload order: staging runs BEFORE generate', async () => {
  const { calls, steps } = makeSteps();
  const { runPostRoutingDispatch } = createPostRoutingDispatch(steps);

  await runPostRoutingDispatch({ text: 'hi', order: STAGING_THEN_GENERATE, ...bundles });

  assert.deepEqual(calls, ['staging:s', 'generate:g', 'recall:r', 'requested:i', 'cad:c']);
});

test('the two shipped orders are genuinely different (guard against both constants collapsing)', () => {
  assert.deepEqual([...GENERATE_THEN_STAGING], ['generate', 'staging']);
  assert.deepEqual([...STAGING_THEN_GENERATE], ['staging', 'generate']);
  assert.notDeepEqual([...GENERATE_THEN_STAGING], [...STAGING_THEN_GENERATE]);
});

test('the tail (recall → image-request → CAD) is fixed and does not follow `order`', async () => {
  for (const order of [GENERATE_THEN_STAGING, STAGING_THEN_GENERATE]) {
    const { calls, steps } = makeSteps();
    const { runPostRoutingDispatch } = createPostRoutingDispatch(steps);
    await runPostRoutingDispatch({ text: 'hi', order, ...bundles });
    assert.deepEqual(calls.slice(2), ['recall:r', 'requested:i', 'cad:c']);
  }
});

test('every dispatch result is returned to the caller', async () => {
  const { steps } = makeSteps();
  const { runPostRoutingDispatch } = createPostRoutingDispatch(steps);

  const out = await runPostRoutingDispatch({ text: 'hi', order: GENERATE_THEN_STAGING, ...bundles });

  assert.deepEqual(out, {
    text: 'hi',
    stagingResults: ['STAGED'],
    generatedImages: ['GENERATED'],
    recalledImageForDisplay: 'RECALLED',
    requestedImageForDisplay: 'REQUESTED',
    cadResults: ['CAD'],
  });
});

test('suffixes are appended in dispatch order, so the order decides the reply text', async () => {
  const overrides = { staging: { textSuffix: ' [staged]' }, generate: { textSuffix: ' [generated]' } };

  const a = makeSteps(overrides);
  const b = makeSteps(overrides);
  const chat = await createPostRoutingDispatch(a.steps).runPostRoutingDispatch({
    text: 'Done.', order: GENERATE_THEN_STAGING, ...bundles,
  });
  const upload = await createPostRoutingDispatch(b.steps).runPostRoutingDispatch({
    text: 'Done.', order: STAGING_THEN_GENERATE, ...bundles,
  });

  assert.equal(chat.text, 'Done. [generated] [staged]');
  assert.equal(upload.text, 'Done. [staged] [generated]');
});

test('staging and CAD guard a null text with `|| ""`; generate does not — inherited verbatim', async () => {
  const staged = makeSteps({ staging: { textSuffix: 'S' } });
  const outStaged = await createPostRoutingDispatch(staged.steps).runPostRoutingDispatch({
    text: null, order: STAGING_THEN_GENERATE, ...bundles,
  });
  assert.equal(outStaged.text, 'S', 'staging drops the falsy text');

  const cad = makeSteps({ cad: { textSuffix: 'C' } });
  const outCad = await createPostRoutingDispatch(cad.steps).runPostRoutingDispatch({
    text: null, order: STAGING_THEN_GENERATE, ...bundles,
  });
  assert.equal(outCad.text, 'C', 'CAD drops the falsy text');

  const generated = makeSteps({ generate: { textSuffix: 'G' } });
  const outGen = await createPostRoutingDispatch(generated.steps).runPostRoutingDispatch({
    text: null, order: STAGING_THEN_GENERATE, ...bundles,
  });
  assert.equal(outGen.text, 'nullG', 'generate concatenates unguarded — original behaviour');
});

test('a falsy suffix never touches the text', async () => {
  const { steps } = makeSteps({ staging: { textSuffix: '' }, generate: { textSuffix: undefined } });
  const out = await createPostRoutingDispatch(steps).runPostRoutingDispatch({
    text: 'Done.', order: GENERATE_THEN_STAGING, ...bundles,
  });
  assert.equal(out.text, 'Done.');
});

test('the image-request step receives the text accumulated so far and REPLACES it', async () => {
  /** @type {any} */
  let seen = null;
  const { steps } = makeSteps({
    staging: { textSuffix: ' [staged]' },
    requestedText: 'ANALYSIS REPLACED THE REPLY',
  });
  const origRequested = steps.resolveRequestedImage;
  steps.resolveRequestedImage = async (args) => { seen = args; return origRequested(args); };

  const out = await createPostRoutingDispatch(steps).runPostRoutingDispatch({
    text: 'Done.', order: STAGING_THEN_GENERATE, ...bundles,
  });

  assert.equal(seen.text, 'Done. [staged]', 'gets the post-staging text, not the original');
  assert.equal(seen.tag, 'i', 'the caller bundle is passed through');
  assert.equal(out.text, 'ANALYSIS REPLACED THE REPLY');
});

test('the CAD suffix lands after the image-request replacement', async () => {
  const { steps } = makeSteps({ requestedText: 'REPLACED', cad: { textSuffix: ' [cad]' } });
  const out = await createPostRoutingDispatch(steps).runPostRoutingDispatch({
    text: 'Done.', order: GENERATE_THEN_STAGING, ...bundles,
  });
  assert.equal(out.text, 'REPLACED [cad]');
});

test('an injected `text` in requestedArgs cannot override the accumulated text', async () => {
  /** @type {any} */
  let seen = null;
  const { steps } = makeSteps();
  steps.resolveRequestedImage = async (args) => {
    seen = args;
    return { requestedImageForDisplay: null, text: args.text };
  };
  await createPostRoutingDispatch(steps).runPostRoutingDispatch({
    text: 'accumulated', order: GENERATE_THEN_STAGING, ...bundles,
    requestedArgs: { tag: 'i', text: 'STALE' },
  });
  assert.equal(seen.text, 'accumulated');
});

test('a malformed order throws instead of silently skipping a dispatch step', async () => {
  const { calls, steps } = makeSteps();
  const { runPostRoutingDispatch } = createPostRoutingDispatch(steps);

  for (const bad of [['staging'], [], ['staging', 'staging'], ['generate', 'cad'], undefined]) {
    await assert.rejects(
      () => runPostRoutingDispatch({ text: 'hi', order: /** @type {any} */ (bad), ...bundles }),
      /order must be/,
    );
  }
  assert.deepEqual(calls, [], 'nothing was dispatched');
});
