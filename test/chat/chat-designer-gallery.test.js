// The AI Designer's gallery entries (the persistence block in lib/chat/chat-staging.js).
//
// Two things make this path different from the other three writers, and both are what the
// tests below are really about:
//
//   1. One chat turn can stage up to THREE different photos, so it calls recordPending once
//      per result rather than once with three natives. Batching them would hand every entry
//      the same `sourceBuffer` and put the wrong room behind the before/after slider.
//   2. Image GENERATION shares this pipeline but must write nothing. It has no source photo
//      and no room type, so every such entry would be called "AI Designer" and nothing more
//      — which is the exact bug this naming work exists to fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import createChatPipeline from '../../lib/chat/chat-pipeline.js';

const dataUrl = (s) => 'data:image/png;base64,' + Buffer.from(s).toString('base64');
const userImg = (s) => ({ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl(s) } }] });
const PRO = { id: 'u_pro', email: 'pro@x.com', plan: 'pro' };

/** A render-persistence double that records every call. */
function fakePersistence(seen, { enabled = true, throwOnRecord = false } = {}) {
  return {
    enabled: () => enabled,
    recordPending: (arg) => {
      if (throwOnRecord) throw new Error('sqlite is on fire');
      seen.recorded.push(arg);
      return { entries: [{ id: `r${seen.recorded.length}`, native: arg.natives[0].buffer }], evicted: [] };
    },
    uploadInBackground: async (arg) => { seen.uploaded.push(arg); return { ok: 1, failed: 0 }; },
  };
}

function makePipeline(over = {}) {
  const calls = { staging: [], generate: [] };
  const seen = { recorded: [], uploaded: [] };
  const deps = {
    DEBUG_MODE: false,
    openai: { chat: { completions: { create: async () => ({ choices: [{ message: { content: '{}' } }] }) } } },
    annotateImage: async () => 'a bright modern kitchen',
    downscaleImageForGPT: async (u) => u,
    getGeminiImageModel: () => 'gemini-x',
    getTemperatureForModel: () => 0.7,
    processImageGeneration: async (prompt) => { calls.generate.push(prompt); return 'data:generated'; },
    // Hands back a native buffer the way the real processStaging does, so the hook under
    // test is genuinely exercised rather than stubbed past.
    processStaging: async (buf, params) => {
      calls.staging.push({ buf, params });
      params.onNative?.(Buffer.from(`native:${buf.toString()}`), { format: 'png' });
      return 'data:staged';
    },
    blueprintTo3D: async () => Buffer.from('cadbuf'),
    incPromptCount: () => {},
    saveMemories: () => {},
    renderPersistence: fakePersistence(seen),
    ...over,
  };
  return { pipe: createChatPipeline(deps), calls, seen };
}

const stageBase = (over = {}) => ({
  userId: 'u', req: {}, selectedModel: 'm', baseImageIndex: null,
  currentMessageHasImage: false, currentImageBuffer: null, applyOriginalKeywordFallback: true,
  userMessageText: 'stage this room',
  resolveDualUpload: () => null, resolveFallbackImage: () => null,
  user: PRO,
  ...over,
});

test('a staged turn becomes a gallery entry labelled as the AI Designer', async () => {
  const { pipe, seen } = makePipeline();
  await pipe.runStagingRequests({
    stagingRequestFromAI: { shouldStage: true, roomType: 'Kitchen' },
    history: [],
    ...stageBase({
      resolveFallbackImage: () => ({
        buffer: Buffer.from('ROOM'), source: 'current message', sourceName: 'elm-st-04.jpg',
      }),
    }),
  });
  assert.equal(seen.recorded.length, 1);
  const [call] = seen.recorded;
  assert.deepEqual(call.extra, { source: 'designer', sourceName: 'elm-st-04.jpg' });
  assert.equal(call.isPro, true, 'both chat endpoints are behind requireProAccount');
  assert.equal(call.user, PRO);
  assert.equal(call.params.roomType, 'Kitchen', 'the qualifier is derived from this column, not frozen');
  assert.equal(call.extra.qualifier, undefined, 'so no qualifier is stored');
  assert.equal(call.natives[0].buffer.toString(), 'native:ROOM', 'the model output, not the delivery upscale');
});

test("the room type is recorded as the model guessed it, 'Other' included", async () => {
  // The row stays honest about what the routing model decided; suppressing 'Other' is a
  // DISPLAY rule in public/scripts/render-name.js, not a storage one.
  const { pipe, seen } = makePipeline();
  await pipe.runStagingRequests({
    stagingRequestFromAI: { shouldStage: true },
    history: [],
    ...stageBase({ resolveFallbackImage: () => ({ buffer: Buffer.from('R'), source: 's' }) }),
  });
  assert.equal(seen.recorded[0].params.roomType, 'Other');
  assert.equal(seen.recorded[0].extra.sourceName, '', 'a resolver with no filename contributes none');
});

test('three staged photos in one turn share a batch but keep their own before image', async () => {
  // The reason this path calls recordPending once per result. If it batched, all three
  // entries would get one shared sourceBuffer and two of the three sliders would be wrong.
  const { pipe, seen } = makePipeline();
  await pipe.runStagingRequests({
    stagingRequestFromAI: [
      { shouldStage: true, usePreviousImage: 0 },
      { shouldStage: true, usePreviousImage: 1 },
      { shouldStage: true, usePreviousImage: 2 },
    ],
    history: [userImg('img-A'), userImg('img-B'), userImg('img-C')],
    ...stageBase(),
  });
  assert.equal(seen.recorded.length, 3);
  assert.equal(new Set(seen.recorded.map((c) => c.batchId)).size, 1, 'one turn is one batch');
  assert.deepEqual(seen.recorded.map((c) => c.variationBase), [0, 1, 2]);
  assert.deepEqual(
    seen.uploaded.map((u) => u.sourceBuffer.toString()),
    ['img-C', 'img-B', 'img-A'],
    'each entry keeps the photo it was actually staged from',
  );
});

test('a pure image-generation turn writes nothing to the gallery', async () => {
  const { pipe, seen, calls } = makePipeline();
  await pipe.runGenerateRequests({
    generateRequestFromAI: { shouldGenerate: true, prompt: 'a mid-century sofa' },
    req: {},
    selectedModel: 'm',
  });
  assert.equal(calls.generate.length, 1, 'the image was still generated and returned to the chat');
  assert.equal(seen.recorded.length, 0, 'but it is a conversational artifact, not a render of a property');
});

test('with the gallery off, no native hook is wired and nothing is decoded', async () => {
  const seen = { recorded: [], uploaded: [] };
  const { pipe, calls } = makePipeline({ renderPersistence: fakePersistence(seen, { enabled: false }) });
  const { stagingResults } = await pipe.runStagingRequests({
    stagingRequestFromAI: { shouldStage: true },
    history: [],
    ...stageBase({ resolveFallbackImage: () => ({ buffer: Buffer.from('R'), source: 's' }) }),
  });
  assert.equal(calls.staging[0].params.onNative, null, 'nowhere to put the bytes, so nothing is kept');
  assert.equal(seen.recorded.length, 0);
  assert.equal(stagingResults.length, 1, 'and the user still gets their staged image');
});

test('an anonymous turn stores nothing even when the gallery is on', async () => {
  const { pipe, seen, calls } = makePipeline();
  await pipe.runStagingRequests({
    stagingRequestFromAI: { shouldStage: true },
    history: [],
    ...stageBase({ user: null, resolveFallbackImage: () => ({ buffer: Buffer.from('R'), source: 's' }) }),
  });
  assert.equal(calls.staging[0].params.onNative, null);
  assert.equal(seen.recorded.length, 0);
});

test('a gallery failure can never fail the chat turn', async () => {
  // The user has already been charged for the render and already has the image on screen.
  const seen = { recorded: [], uploaded: [] };
  const { pipe } = makePipeline({ renderPersistence: fakePersistence(seen, { throwOnRecord: true }) });
  const { stagingResults, textSuffix } = await pipe.runStagingRequests({
    stagingRequestFromAI: { shouldStage: true },
    history: [],
    ...stageBase({ resolveFallbackImage: () => ({ buffer: Buffer.from('R'), source: 's' }) }),
  });
  assert.equal(stagingResults.length, 1);
  assert.equal(textSuffix, '', 'and the user is told nothing, because nothing they asked for failed');
});

test('the onNative hook never rides out on the chat response', async () => {
  // stagingParams travels on to buildDesignerResponse. JSON.stringify would drop a
  // function, but one sitting on a response object is a trap for the first structuredClone.
  const { pipe } = makePipeline();
  const { stagingResults } = await pipe.runStagingRequests({
    stagingRequestFromAI: { shouldStage: true },
    history: [],
    ...stageBase({ resolveFallbackImage: () => ({ buffer: Buffer.from('R'), source: 's' }) }),
  });
  assert.equal(stagingResults[0].params.onNative, undefined);
  assert.doesNotThrow(() => JSON.stringify(stagingResults[0].params));
});

test('a render that failed to produce an image produces no entry', async () => {
  const seen = { recorded: [], uploaded: [] };
  const { pipe } = makePipeline({
    renderPersistence: fakePersistence(seen),
    processStaging: async () => null,
  });
  await pipe.runStagingRequests({
    stagingRequestFromAI: { shouldStage: true },
    history: [],
    ...stageBase({ resolveFallbackImage: () => ({ buffer: Buffer.from('R'), source: 's' }) }),
  });
  assert.equal(seen.recorded.length, 0);
});
