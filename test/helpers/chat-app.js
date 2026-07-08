// Mounts the real AI Designer chat router (routes/chat.js) on a bare Express app
// with fully faked dependencies, then listens on an ephemeral port. This mirrors
// test/helpers/staging-app.js (mountStaging): it exercises the ACTUAL /api/chat
// handler — auth gate, the routing-completion parse, the streamMode decision, and
// the SSE-vs-res.json branch — with the OpenAI client and every slow image step
// (processStaging / processImageGeneration / blueprintTo3D) swapped for
// deterministic in-process fakes. No full server boot, no real network/model call.
//
// The OpenAI client is scriptable: pass `routing` (a single routing object, or an
// array used as a FIFO queue) and each `chat.completions.create` call returns
// `{ choices: [{ message: { content: JSON.stringify(routing) } }] }`, exactly the
// shape parseDesignerRoutingCompletion() expects. That is how each test drives a
// different intent (plain-text / staging / generate / clarifying-question) without
// touching a model.

import express from 'express';
import createChatRouter from '../../routes/chat.js';

const pass = (req, res, next) => next();

// Minimal call-counting spy. `fn.calls` is the invocation count; `fn.lastArgs`
// is the most recent argument list. `impl` supplies the return value.
function makeSpy(impl) {
  const fn = (...args) => {
    fn.calls += 1;
    fn.lastArgs = args;
    return impl ? impl(...args) : undefined;
  };
  fn.calls = 0;
  fn.lastArgs = null;
  return fn;
}

// Mount the chat router with `over` merged over the faked baseChatDeps.
// `over.routing` scripts the fake model; all other keys override a dep directly
// (e.g. `requireProAccount`, `openai: null`). Returns { baseUrl, calls, close }.
export async function mountChat(options = {}) {
  const { routing = { response: '' }, ...over } = options;
  const routingQueue = Array.isArray(routing) ? [...routing] : [routing];

  // Fakes we assert against from the tests.
  const processStaging = makeSpy(async () => 'data:staged');
  const processImageGeneration = makeSpy(async () => 'data:generated');
  const incPromptCount = makeSpy();
  const saveMemories = makeSpy();
  // CAD render fake: record each invocation's args in `cad` and hand back a tiny
  // real Buffer, so runCadRequests can base64-encode it into a data: URL exactly
  // as it would a genuine 3D render. `cad.length` is the call count.
  const cad = [];
  const blueprintTo3D = makeSpy(async (...args) => {
    cad.push(args);
    return Buffer.from('cad');
  });
  const openaiCreate = makeSpy(async () => {
    // Pop the next scripted routing object; once one remains, keep returning it
    // (each of these tests makes exactly one routing call per request).
    const r = routingQueue.length > 1 ? routingQueue.shift() : routingQueue[0];
    return { choices: [{ message: { content: JSON.stringify(r) } }] };
  });

  const baseChatDeps = {
    // Must be TRUTHY or the handler short-circuits with 500.
    openai: { chat: { completions: { create: openaiCreate } } },
    genLimiter: pass,
    // Consumed at route-registration time (chatUpload.array('files', 5)).
    chatUpload: { array: () => pass },
    // Default: authorized. Return truthy and DON'T touch res (matches real guard).
    requireProAccount: () => true,
    loadMemories: () => [],
    saveMemories,
    getUserIdentifier: () => 'test',
    getTemperatureForModel: () => 0.7,
    getGeminiImageModel: () => 'gemini-x',
    downscaleImageForGPT: async (u) => u,
    annotateImage: async () => null,
    logChatToFile: () => {},
    incPromptCount,
    processStaging,
    processImageGeneration,
    blueprintTo3D,
    DEBUG_MODE: false,
  };

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(createChatRouter({ ...baseChatDeps, ...over }));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls: { processStaging, processImageGeneration, incPromptCount, saveMemories, openaiCreate, blueprintTo3D, cad },
    close: () => new Promise((r) => server.close(r)),
  };
}
