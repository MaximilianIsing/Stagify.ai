// "Label as virtually staged" reaching processStaging from a chat turn
// (the disclosure half of lib/chat/chat-staging.js).
//
// The AI Designer is the only surface where this option has no checkbox: the routing model
// sets `disclosure` from what the user said, and the presence of that object IS the flag.
// Which means the model's output is being used as renderer configuration — so it gets
// exactly the validation a request body gets, and none of the trust. A hallucinated style
// is a badge master that does not exist on disk, and because the stamp fails CLOSED that
// is not a missing badge, it is a paid render the user never receives.
//
// The other thing pinned here is what the user is TOLD when that happens. A withheld
// render used to arrive as "Sorry, I encountered an error while staging the room" — and,
// for a multi-request turn, as nothing at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import createChatPipeline from '../../lib/chat/chat-pipeline.js';

/** Build the pipeline with a processStaging double that records the params it was given. */
function makePipeline(over = {}) {
  const calls = { staging: [] };
  const deps = {
    DEBUG_MODE: false,
    openai: { chat: { completions: { create: async () => ({ choices: [{ message: { content: '{}' } }] }) } } },
    annotateImage: async () => 'a room',
    downscaleImageForGPT: async (u) => u,
    getGeminiImageModel: () => 'gemini-x',
    getTemperatureForModel: () => 0.7,
    processImageGeneration: async () => 'data:generated',
    processStaging: async (buf, params) => { calls.staging.push(params); return 'data:staged'; },
    blueprintTo3D: async () => Buffer.from('cadbuf'),
    incPromptCount: () => {},
    saveMemories: () => {},
    renderPersistence: null,
    ...over,
  };
  return { pipe: createChatPipeline(deps), calls };
}

/** Everything runStagingRequests needs besides the routing decision. */
const stageBase = (over = {}) => ({
  history: [],
  userId: 'u',
  req: {},
  selectedModel: 'm',
  baseImageIndex: null,
  currentMessageHasImage: false,
  currentImageBuffer: null,
  applyOriginalKeywordFallback: true,
  userMessageText: 'stage this room',
  resolveDualUpload: () => null,
  resolveFallbackImage: () => ({ buffer: Buffer.from('ROOM'), source: 'current message', sourceName: 'a.jpg' }),
  user: null,
  ...over,
});

/** Run one turn with the given routing decision, and return the staging params it produced. */
async function stageWith(disclosure, { req = {}, over = {} } = {}) {
  const { pipe, calls } = makePipeline(over);
  await pipe.runStagingRequests({
    stagingRequestFromAI: { shouldStage: true, roomType: 'Kitchen', disclosure },
    ...stageBase({ req }),
  });
  return calls.staging[0];
}

// ---- the flag --------------------------------------------------------------

test('no disclosure means no badge — the default, and the common case', async () => {
  // "Stage this living room" must never come back labelled. Every plain staging request
  // goes through this line, so a truthy default here would put a disclosure on every photo
  // the Designer has ever produced.
  const params = await stageWith(null);
  assert.equal(params.labelVirtuallyStaged, false);

  // Not just null: a routing model that omits the key entirely gets the same answer.
  const { pipe, calls } = makePipeline();
  await pipe.runStagingRequests({
    stagingRequestFromAI: { shouldStage: true, roomType: 'Kitchen' },
    ...stageBase(),
  });
  assert.equal(calls.staging[0].labelVirtuallyStaged, false);
});

test('a disclosure object turns the badge on and carries the chosen look', async () => {
  const params = await stageWith({ style: 'banner', scale: 1.4 });
  assert.equal(params.labelVirtuallyStaged, true);
  assert.equal(params.stampStyle, 'banner');
  assert.equal(params.stampScale, 1.4);
});

test('the PRESENCE of the object is the flag — there is no separate boolean to disagree with', async () => {
  // The schema has no `label: true` field, deliberately: two sources for one answer is two
  // chances for the style to say "banner" while the flag says off.
  const params = await stageWith({ style: 'dark', scale: 1 });
  assert.equal(params.labelVirtuallyStaged, true);
  assert.equal(params.disclosure, undefined, 'the raw routing object is not forwarded');
});

// ---- the model is untrusted input ------------------------------------------

test('a style the renderer cannot draw falls back instead of failing the render', async () => {
  // STAMP_STYLES is a set of pre-rendered masters on disk. An invented name is not a
  // cosmetic miss — stampVirtuallyStaged would throw, and it fails closed, so the user
  // pays for a render they never see because the model wrote "neon".
  const params = await stageWith({ style: 'neon', scale: 1 });
  assert.equal(params.labelVirtuallyStaged, true, 'they still asked for a label');
  assert.equal(params.stampStyle, 'dark', 'and they get the default one');
});

test('the size is clamped, not trusted — the model can emit any number the schema allows', async () => {
  // `scale` is `type: 'number'` in the schema, so nothing above it bounds the value: JSON
  // Schema minimum/maximum are advisory to the model, not enforced by the API.
  const huge = await stageWith({ style: 'dark', scale: 99 });
  assert.ok(huge.stampScale <= 1.6, `expected a clamped scale, got ${huge.stampScale}`);
  const tiny = await stageWith({ style: 'dark', scale: 0.01 });
  assert.ok(tiny.stampScale >= 0.7, `expected a clamped scale, got ${tiny.stampScale}`);
  const nonsense = await stageWith({ style: 'dark', scale: 'big' });
  assert.equal(nonsense.stampScale, 1, 'a non-number falls back to normal size');
});

// ---- the language is the request's, not the model's ------------------------

test('the badge language comes off the request, so it follows the SITE language', async () => {
  const params = await stageWith({ style: 'dark', scale: 1 }, { req: { body: { stampLang: 'german' } } });
  assert.equal(params.stampLang, 'german');
});

test('a missing or junk language falls back to English rather than failing', async () => {
  // An older client that does not send the field, and a tampered one. Neither may take
  // down a render: the fallback is a readable badge in the wrong language, which is
  // recoverable; a throw is a lost render.
  assert.equal((await stageWith({ style: 'dark', scale: 1 }, { req: {} })).stampLang, 'english');
  assert.equal(
    (await stageWith({ style: 'dark', scale: 1 }, { req: { body: { stampLang: '../../etc/passwd' } } })).stampLang,
    'english',
  );
});

// ---- fail closed, out loud -------------------------------------------------

test('a withheld render says which option to drop, instead of "something went wrong"', async () => {
  // The stamp throws rather than delivering an unlabelled photo, so the render SUCCEEDED
  // and was held back. Told only that an error occurred, the user retries into the same
  // wall and pays for a render each time; naming the label is the only actionable thing.
  const boom = Object.assign(new Error('badge master missing'), { code: 'DISCLOSURE_STAMP_FAILED' });
  const { pipe } = makePipeline({ processStaging: async () => { throw boom; } });
  const { stagingResults, textSuffix } = await pipe.runStagingRequests({
    stagingRequestFromAI: { shouldStage: true, roomType: 'Kitchen', disclosure: { style: 'dark', scale: 1 } },
    ...stageBase(),
  });

  assert.equal(stagingResults.length, 0, 'nothing may be delivered');
  assert.match(textSuffix, /label/i);
  assert.match(textSuffix, /without the label/i, 'the way out');
  assert.ok(!/encountered an error/i.test(textSuffix), 'not the generic failure copy');
  assert.ok(!textSuffix.includes('badge master missing'), 'never the raw exception');
});

test('and it says so for a MULTI-request turn, where the generic branch stays silent', async () => {
  // The generic apology is gated on `stagingRequests.length === 1`, on the reasoning that
  // the other renders still arrived. That reasoning does not survive here: ask for three
  // variations with a label and all three are withheld, so silence would be the whole
  // answer — three paid renders and an empty reply.
  const boom = Object.assign(new Error('nope'), { code: 'DISCLOSURE_STAMP_FAILED' });
  const { pipe } = makePipeline({ processStaging: async () => { throw boom; } });
  const one = { shouldStage: true, roomType: 'Kitchen', disclosure: { style: 'dark', scale: 1 } };
  const { textSuffix } = await pipe.runStagingRequests({
    stagingRequestFromAI: [one, { ...one }, { ...one }],
    ...stageBase(),
  });

  assert.match(textSuffix, /label/i, 'three withheld renders must not be silent');
  // Said once. Three variations that failed the same way are one fact, and repeating it
  // reads as three separate faults.
  assert.equal(textSuffix.match(/Virtually staged/g).length, 1);
});

test('an ordinary staging failure keeps its own message', async () => {
  // The pair to the case above: the disclosure branch must not swallow every other error,
  // which would tell someone to drop a label they never asked for.
  const { pipe } = makePipeline({ processStaging: async () => { throw new Error('gemini is down'); } });
  const { textSuffix } = await pipe.runStagingRequests({
    stagingRequestFromAI: { shouldStage: true, roomType: 'Kitchen' },
    ...stageBase(),
  });
  assert.match(textSuffix, /encountered an error/i);
  assert.ok(!/label/i.test(textSuffix));
});
