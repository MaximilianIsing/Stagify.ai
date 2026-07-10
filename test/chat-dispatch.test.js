// Shared post-routing orchestration glue (lib/chat/chat-dispatch.js): the blocks
// both /api/chat and /api/chat-upload run identically once they have a routing
// decision. The branching that actually changes a result lives in
// applyPostRoutingSuppression (defer-suppression + the add-furniture generate
// drop); logRoutingOutcome / sendChatResponse are thin but their wiring (which
// files arg, which mode) is what differs per endpoint, so we pin that too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import createChatDispatch from '../lib/chat/chat-dispatch.js';

const dataUrl = (s) => 'data:image/png;base64,' + Buffer.from(s).toString('base64');
// An assistant image tagged isStaged is what findMostRecentStagedImageIndex looks for.
const stagedImg = () => ({ role: 'assistant', content: [{ type: 'image_url', image_url: { url: dataUrl('staged') }, isStaged: true }] });

function makeDispatch(over = {}) {
  const calls = { logChatToFile: [] };
  const deps = {
    DEBUG_MODE: false,
    logChatToFile: (...args) => { calls.logChatToFile.push(args); },
    ...over,
  };
  return { d: createChatDispatch(deps), calls };
}

const REQS = { staging: { shouldStage: true }, generate: { shouldGenerate: true }, cad: { shouldCad: true } };

// --- applyPostRoutingSuppression: the two request-nulling rules ---

test('applyPostRoutingSuppression: a clarifying-question reply nulls staging, generate AND cad', () => {
  const { d } = makeDispatch();
  const out = d.applyPostRoutingSuppression({
    text: 'What style would you like for the living room?', // defer pattern + "?"
    userMessageText: 'add this sofa', history: [], // furniture phrase, but no staged image → rule 2 no-ops
    stagingRequestFromAI: REQS.staging, generateRequestFromAI: REQS.generate, cadRequestFromAI: REQS.cad,
  });
  assert.deepEqual(out, { stagingRequestFromAI: null, generateRequestFromAI: null, cadRequestFromAI: null });
});

test('applyPostRoutingSuppression: add-furniture on a staged room drops ONLY generate', () => {
  const { d } = makeDispatch();
  const out = d.applyPostRoutingSuppression({
    text: 'Done — added it.', // not a deferral
    userMessageText: 'add this sofa', history: [stagedImg()],
    stagingRequestFromAI: REQS.staging, generateRequestFromAI: REQS.generate, cadRequestFromAI: REQS.cad,
  });
  assert.equal(out.generateRequestFromAI, null, 'generate is dropped (staging handles the add)');
  assert.equal(out.stagingRequestFromAI, REQS.staging, 'staging is preserved');
  assert.equal(out.cadRequestFromAI, REQS.cad, 'cad is preserved');
});

test('applyPostRoutingSuppression: add-furniture with NO staged image leaves everything intact', () => {
  const { d } = makeDispatch();
  const out = d.applyPostRoutingSuppression({
    text: 'Done — added it.',
    userMessageText: 'add this sofa', history: [], // no staged image → rule 2 does not fire
    stagingRequestFromAI: REQS.staging, generateRequestFromAI: REQS.generate, cadRequestFromAI: REQS.cad,
  });
  assert.deepEqual(out, { stagingRequestFromAI: REQS.staging, generateRequestFromAI: REQS.generate, cadRequestFromAI: REQS.cad });
});

test('applyPostRoutingSuppression: a non-deferring, non-furniture turn is a pure pass-through', () => {
  const { d } = makeDispatch();
  const out = d.applyPostRoutingSuppression({
    text: 'Here is your staged room.',
    userMessageText: 'stage this room', history: [stagedImg()], // "stage this room" is not an add-furniture phrase
    stagingRequestFromAI: REQS.staging, generateRequestFromAI: REQS.generate, cadRequestFromAI: REQS.cad,
  });
  assert.deepEqual(out, { stagingRequestFromAI: REQS.staging, generateRequestFromAI: REQS.generate, cadRequestFromAI: REQS.cad });
});

// --- logRoutingOutcome: the business CSV row (the per-endpoint files/label wiring) ---

test('logRoutingOutcome: always writes one CSV row with the request ip/ua, DEBUG dump is opt-in', () => {
  const { d, calls } = makeDispatch(); // DEBUG_MODE:false → no debug dump, and no throw
  const req = { ip: '9.9.9.9', get: () => 'test-agent', connection: {} };
  d.logRoutingOutcome({ req, userId: 'u1', userMessageText: 'hello', text: 'hi there', files: [], memories: [], label: 'CHAT' });
  assert.equal(calls.logChatToFile.length, 1);
  assert.deepEqual(calls.logChatToFile[0], ['u1', 'hello', 'hi there', [], '9.9.9.9', 'test-agent']);
});

test('logRoutingOutcome: forwards the upload files array to the CSV writer unchanged', () => {
  const { d, calls } = makeDispatch();
  const files = [{ originalname: 'a.png' }];
  const req = { ip: '1.1.1.1', get: () => 'ua', connection: {} };
  d.logRoutingOutcome({ req, userId: 'u2', userMessageText: 'analyze', text: 'ok', files, memories: [], label: 'CHAT-UPLOAD', fileInfo: [{ name: 'a.png', type: 'image/png' }] });
  assert.equal(calls.logChatToFile[0][3], files, 'the multipart files array is what gets logged, not []');
});

// --- beginChatStream / sendChatResponse: mode wiring ---

test('beginChatStream: no streaming when the client did not ask for it (res untouched)', () => {
  const { d } = makeDispatch();
  let touched = false;
  const res = new Proxy({}, { get: () => () => { touched = true; } });
  const streamMode = d.beginChatStream({
    req: { body: {}, query: {}, headers: {} }, res,
    text: 'x', memoryActions: { stores: [], forgets: [] },
    stagingRequestFromAI: REQS.staging, generateRequestFromAI: null, cadRequestFromAI: null,
  });
  assert.equal(streamMode, false);
  assert.equal(touched, false, 'a non-streaming request never opens the SSE channel');
});

test('sendChatResponse: non-stream mode replies with a plain JSON body', () => {
  const { d } = makeDispatch();
  let sent = null;
  const res = { json: (body) => { sent = body; } };
  const payload = { response: 'done' };
  d.sendChatResponse({ res, response: payload, streamMode: false });
  assert.equal(sent, payload);
});
