// Post-routing dispatch pipeline (lib/chat-pipeline.js) — the gnarliest stateful
// code in the chat surface. We drive createChatPipeline() with arg-recording fakes
// (no real AI, no cost) and assert on the decisions that silently ruin a result
// when they regress: which image buffer gets staged (the 3-way precedence), how
// per-item failures are surfaced, memory forget/store surgery, and the analyze-vs-
// view gate that decides whether a second billed GPT call happens.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import createChatPipeline from '../lib/chat/chat-pipeline.js';

const dataUrl = (s) => 'data:image/png;base64,' + Buffer.from(s).toString('base64');
const userImg = (s) => ({ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl(s) } }] });

function makePipeline(over = {}) {
  const calls = { staging: [], generate: [], openai: [], saveMemories: [], incPromptCount: 0 };
  const deps = {
    DEBUG_MODE: false,
    openai: { chat: { completions: { create: async (args) => {
      calls.openai.push(args);
      return { choices: [{ message: { content: JSON.stringify({ response: 'analyzed text' }) } }] };
    } } } },
    annotateImage: async () => null,
    downscaleImageForGPT: async (u) => u,
    getGeminiImageModel: () => 'gemini-x',
    getTemperatureForModel: () => 0.7,
    processImageGeneration: async (prompt) => { calls.generate.push(prompt); return 'data:generated'; },
    processStaging: async (buf, params, req, furniture) => { calls.staging.push({ buf, params, furniture }); return 'data:staged'; },
    blueprintTo3D: async () => Buffer.from('cadbuf'),
    incPromptCount: () => { calls.incPromptCount++; },
    saveMemories: (userId, mems) => { calls.saveMemories.push({ userId, mems }); },
    ...over,
  };
  return { pipe: createChatPipeline(deps), calls };
}

// Shared staging boilerplate; override the injected callbacks per test.
const stageBase = (over = {}) => ({
  userId: 'u', req: {}, selectedModel: 'm', baseImageIndex: null,
  currentMessageHasImage: false, currentImageBuffer: null, applyOriginalKeywordFallback: true,
  userMessageText: 'stage this room', // deliberately NOT an add-furniture phrase
  resolveDualUpload: () => null, resolveFallbackImage: () => null, ...over,
});

// --- applyMemoryActions: list surgery + save-on-change ---

test('applyMemoryActions: forgets:["all"] wipes everything and persists', () => {
  const { pipe, calls } = makePipeline();
  const r = pipe.applyMemoryActions({
    memoryActionsFromAI: { forgets: ['all'] },
    memories: [{ id: 'a', content: 'x' }, { id: 'b', content: 'y' }],
    userId: 'u', userMessageText: 'forget everything',
  });
  assert.deepEqual(r.memories, []);
  assert.deepEqual(r.memoryActions.forgets, ['all']);
  assert.equal(calls.saveMemories.length, 1);
  assert.deepEqual(calls.saveMemories[0].mems, []);
});

test('applyMemoryActions: forgets by exact id, then falls back to fuzzy content match', () => {
  const { pipe } = makePipeline();
  const byId = pipe.applyMemoryActions({
    memoryActionsFromAI: { forgets: ['b'] },
    memories: [{ id: 'a', content: 'apple' }, { id: 'b', content: 'banana' }],
    userId: 'u', userMessageText: 'forget b',
  });
  assert.deepEqual(byId.memories.map((m) => m.id), ['a']);
  assert.deepEqual(byId.memoryActions.forgets, ['b']);

  // No id 'banana' exists → fuzzy content match removes the item whose content contains it.
  const byContent = pipe.applyMemoryActions({
    memoryActionsFromAI: { forgets: ['banana'] },
    memories: [{ id: '1', content: 'I love banana bread' }, { id: '2', content: 'apple' }],
    userId: 'u', userMessageText: 'forget the banana one',
  });
  assert.deepEqual(byContent.memories.map((m) => m.id), ['2']);
  assert.deepEqual(byContent.memoryActions.forgets, ['1'], 'reports the resolved id, not the query');
});

test('applyMemoryActions: stores append; a no-op change never calls saveMemories', () => {
  const stored = makePipeline();
  const r = stored.pipe.applyMemoryActions({
    memoryActionsFromAI: { stores: ['User is a real estate agent', '  '] }, // blank is skipped
    memories: [], userId: 'u', userMessageText: 'I am an agent',
  });
  assert.deepEqual(r.memories.map((m) => m.content), ['User is a real estate agent']);
  assert.deepEqual(r.memoryActions.stores, ['User is a real estate agent']);
  assert.equal(stored.calls.saveMemories.length, 1);

  const noop = makePipeline();
  const r2 = noop.pipe.applyMemoryActions({
    memoryActionsFromAI: { stores: [], forgets: [] },
    memories: [{ id: 'a', content: 'x' }], userId: 'u', userMessageText: 'hello',
  });
  assert.deepEqual(r2.memoryActions, { stores: [], forgets: [] });
  assert.equal(noop.calls.saveMemories.length, 0, 'no change → no persistence');
});

// --- runStagingRequests: the 3-way image-source precedence ---

test('runStagingRequests: a dual upload wins over any usePreviousImage index', async () => {
  const { pipe, calls } = makePipeline();
  const roomBuffer = Buffer.from('ROOM');
  const furnitureBuffers = [Buffer.from('FURN')];
  const { stagingResults, textSuffix } = await pipe.runStagingRequests({
    stagingRequestFromAI: { shouldStage: true, usePreviousImage: 1 },
    history: [userImg('img-A'), userImg('img-B')],
    ...stageBase({ resolveDualUpload: () => ({ roomBuffer, furnitureBuffers, source: 'dual' }) }),
  });
  assert.equal(stagingResults.length, 1);
  assert.equal(textSuffix, '');
  assert.ok(calls.staging[0].buf.equals(roomBuffer), 'the dual-upload room buffer is staged');
  assert.equal(calls.staging[0].furniture, furnitureBuffers, 'dual-upload furniture buffers are passed through');
  assert.equal(calls.incPromptCount, 1);
});

test('runStagingRequests: usePreviousImage picks that history index; out-of-range → most recent', async () => {
  const history = [userImg('img-A'), userImg('img-B'), userImg('img-C')]; // idx0=C, idx1=B, idx2=A

  const exact = makePipeline();
  await exact.pipe.runStagingRequests({
    stagingRequestFromAI: { shouldStage: true, usePreviousImage: 2 },
    history,
    ...stageBase({ resolveFallbackImage: () => { throw new Error('fallback must not run'); } }),
  });
  assert.equal(exact.calls.staging[0].buf.toString(), 'img-A', 'index 2 = oldest');

  const oob = makePipeline();
  await oob.pipe.runStagingRequests({
    stagingRequestFromAI: { shouldStage: true, usePreviousImage: 99 },
    history,
    ...stageBase(),
  });
  assert.equal(oob.calls.staging[0].buf.toString(), 'img-C', 'out-of-range falls back to the most recent image');
});

test('runStagingRequests: with neither dual upload nor a selection, the injected fallback image is used', async () => {
  const { pipe, calls } = makePipeline();
  await pipe.runStagingRequests({
    stagingRequestFromAI: { shouldStage: true },
    history: [],
    ...stageBase({ resolveFallbackImage: () => ({ buffer: Buffer.from('FB'), source: 'fallback' }) }),
  });
  assert.equal(calls.staging[0].buf.toString(), 'FB');
});

test('runStagingRequests: per-item errors are swallowed in a batch, apologized for only when singular', async () => {
  // Batch of 3, the 2nd throws → 2 results, no apology (the failure is silent).
  let n = 0;
  const batch = makePipeline({ processStaging: async () => { n += 1; if (n === 2) throw new Error('boom'); return 'data:staged'; } });
  const b = await batch.pipe.runStagingRequests({
    stagingRequestFromAI: [
      { shouldStage: true, usePreviousImage: 0 },
      { shouldStage: true, usePreviousImage: 0 },
      { shouldStage: true, usePreviousImage: 0 },
    ],
    history: [userImg('img-C')],
    ...stageBase(),
  });
  assert.equal(b.stagingResults.length, 2);
  assert.equal(b.textSuffix, '', 'no user-facing apology for a single failure within a batch');
  assert.equal(batch.calls.incPromptCount, 2, 'prompt count increments only on success');

  // Single request that throws → apologetic suffix.
  const solo = makePipeline({ processStaging: async () => { throw new Error('boom'); } });
  const s = await solo.pipe.runStagingRequests({
    stagingRequestFromAI: { shouldStage: true, usePreviousImage: 0 },
    history: [userImg('img-C')],
    ...stageBase(),
  });
  assert.equal(s.stagingResults.length, 0);
  assert.match(s.textSuffix, /error while staging the room/);

  // Single request with no resolvable image → the "couldn't find the image" apology.
  const noImg = makePipeline();
  const ni = await noImg.pipe.runStagingRequests({
    stagingRequestFromAI: { shouldStage: true },
    history: [],
    ...stageBase(),
  });
  assert.match(ni.textSuffix, /couldn't find the image to stage/);
});

// --- runGenerateRequests ---

test('runGenerateRequests: filters to generatable requests; total failure yields an apology', async () => {
  const { pipe, calls } = makePipeline();
  const ok = await pipe.runGenerateRequests({
    generateRequestFromAI: [
      { shouldGenerate: true, prompt: 'a modern sofa' },
      { shouldGenerate: false, prompt: 'skip me' },
      { prompt: 'no flag' },
    ],
    req: {}, selectedModel: 'm',
  });
  assert.equal(ok.generatedImages.length, 1);
  assert.equal(ok.textSuffix, '');
  assert.equal(calls.generate.length, 1, 'only the shouldGenerate+prompt request ran');

  const failing = makePipeline({ processImageGeneration: async () => null });
  const fail = await failing.pipe.runGenerateRequests({
    generateRequestFromAI: { shouldGenerate: true, prompt: 'x' }, req: {}, selectedModel: 'm',
  });
  assert.equal(fail.generatedImages.length, 0);
  assert.match(fail.textSuffix, /error while generating/);
});

// --- resolveRequestedImage: the analyze-vs-view billed-call gate ---

test('resolveRequestedImage: "show" views for free; "describe" spends exactly one analysis call', async () => {
  const history = [userImg('img-C')];
  const { pipe, calls } = makePipeline();

  const view = await pipe.resolveRequestedImage({
    imageRequestFromAI: { requestImage: true, imageIndex: 0 }, history,
    baseMessages: [{ role: 'system', content: 's' }], systemInstruction: 's',
    userMessageText: 'show me the image', analysisUserText: 'analyze', selectedModel: 'm', text: 'original',
  });
  assert.equal(view.requestedImageForDisplay, dataUrl('img-C'));
  assert.equal(view.text, 'original', 'a plain view keeps the original text');
  assert.equal(calls.openai.length, 0, 'viewing must NOT make a billed GPT call');

  const analyze = await pipe.resolveRequestedImage({
    imageRequestFromAI: { requestImage: true, imageIndex: 0 }, history,
    baseMessages: [{ role: 'system', content: 's' }], systemInstruction: 's',
    userMessageText: 'describe the image', analysisUserText: 'analyze', selectedModel: 'm', text: 'original',
  });
  assert.equal(analyze.text, 'analyzed text', 'analysis replaces the reply text');
  assert.equal(calls.openai.length, 1, 'exactly one analysis call');
});

// --- resolveRecalledImage ---

test('resolveRecalledImage: returns the url at the index, null when disabled or absent', () => {
  const { pipe } = makePipeline();
  assert.equal(pipe.resolveRecalledImage({ recallRequestFromAI: { shouldRecall: true, imageIndex: 0 }, history: [userImg('img-C')] }), dataUrl('img-C'));
  assert.equal(pipe.resolveRecalledImage({ recallRequestFromAI: { shouldRecall: false }, history: [userImg('img-C')] }), null);
  assert.equal(pipe.resolveRecalledImage({ recallRequestFromAI: { shouldRecall: true, imageIndex: 0 }, history: [] }), null, 'no images → null');
});

// --- buildDesignerResponse: pure assembly + awaited annotations ---

test('buildDesignerResponse: single result stays scalar, multiple become arrays, annotations resolve', async () => {
  const { pipe } = makePipeline();

  const single = await pipe.buildDesignerResponse({
    text: 'hi', memoryActions: { stores: ['s'], forgets: [] },
    stagingResults: [{ stagedImage: 'data:st', params: { roomType: 'X' }, annotationPromise: Promise.resolve('note') }],
    generatedImages: [], requestedImageForDisplay: null, recalledImageForDisplay: 'data:recall', cadResults: [],
    extraFields: { files: ['f'] },
  });
  assert.equal(single.response, 'hi');
  assert.deepEqual(single.memories, { stores: ['s'], forgets: [] });
  assert.equal(single.stagedImage, 'data:st');
  assert.deepEqual(single.stagingParams, { roomType: 'X' });
  assert.deepEqual(single.stagedImageAnnotations, { staged_0: 'note' }, 'the annotation promise is awaited into the map');
  assert.equal(single.recalledImage, 'data:recall');
  assert.deepEqual(single.files, ['f'], 'extraFields are spread in');

  const multi = await pipe.buildDesignerResponse({
    text: 'x', memoryActions: { stores: [], forgets: [] },
    stagingResults: [
      { stagedImage: 'a', params: {}, annotationPromise: Promise.resolve(null) },
      { stagedImage: 'b', params: {}, annotationPromise: Promise.resolve(null) },
    ],
    generatedImages: [], requestedImageForDisplay: null, recalledImageForDisplay: null, cadResults: [],
  });
  assert.deepEqual(multi.stagedImages, ['a', 'b']);
  assert.equal(multi.stagedImage, undefined, 'no scalar field when there are multiple results');
});
