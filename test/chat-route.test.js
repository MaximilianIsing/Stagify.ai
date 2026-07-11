// Tier: route contract (fake AI) — POST /api/chat, the AI Designer chat endpoint.
//
// WHAT THIS COVERS
// The chat handler asks OpenAI for a JSON "routing" decision, then dispatches to
// staging / generation / CAD. This suite exercises the handler's own control flow:
//   - the auth gate and the "AI not configured" guard,
//   - the streamMode decision in routes/chat.js: SSE is used ONLY when the client
//     opts in (streamResponse:true) AND the routed intent is a slow-image action
//     (staging / generate / cad). A plain-text reply is ALWAYS application/json,
//     even with streamResponse:true.
//   - the SSE frame protocol from lib/chat-sse.js (status → message → images → done),
//     where the FINAL image lands in the "images" event (not "message", not a
//     trailing chunk), and there is NO [DONE] sentinel.
//   - the equivalent non-streaming JSON body,
//   - defer-suppression: a clarifying-question response ("...?") nulls the staging
//     action (aiResponseDefersImageAction), degrading to a plain text reply.
//
// WHY NO REAL API CALL HAPPENS
// The router is mounted (see test/helpers/chat-app.js) with a fake OpenAI client
// whose chat.completions.create returns a scripted routing object, and with
// processStaging / processImageGeneration / blueprintTo3D replaced by fakes that
// return sentinel data URLs. Nothing here touches a network or a model; every
// assertion is deterministic. The image data URLs are plain base64 sentinels —
// the chat handler never decodes them through sharp (downscaleImageForGPT and
// processStaging are faked), so no real image bytes are needed.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mountChat } from './helpers/chat-app.js';

// A data URL is enough: the handler only splits on ',' and base64-decodes it into
// a Buffer that it hands to the (faked) processStaging.
const ROOM_IMAGE = 'data:image/png;base64,' + Buffer.from('room-bytes').toString('base64');

// The staging routing the recon prescribes. Response has no '?' so it is NOT
// suppressed by aiResponseDefersImageAction.
const STAGING_ROUTING = {
  response: 'Done staging your room.',
  staging: [
    {
      shouldStage: true,
      roomType: 'Living room',
      additionalPrompt: 'warm modern, keep framing',
      removeFurniture: false,
      usePreviousImage: false,
      furnitureImageIndex: null,
      styleReference: false,
    },
  ],
};

let app;
afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

const postChat = (base, body, headers = {}) =>
  fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

// Parse a raw SSE stream body into an ordered array of { event, data }.
// Each frame is "event: NAME\ndata: <JSON>\n\n" (see lib/chat-sse.js).
function parseSse(raw) {
  return raw
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => {
      const lines = frame.split('\n');
      const eventLine = lines.find((l) => l.startsWith('event:'));
      const dataLine = lines.find((l) => l.startsWith('data:'));
      return {
        event: eventLine ? eventLine.slice('event:'.length).trim() : null,
        data: dataLine ? JSON.parse(dataLine.slice('data:'.length).trim()) : null,
      };
    });
}

// 1 ─ Plain text reply is JSON even when the client asked to stream.
test('plain-text routing with streamResponse:true still replies as application/json (no SSE)', async () => {
  app = await mountChat({ routing: { response: 'Hi! Upload a photo to begin.' } });

  const res = await postChat(app.baseUrl, {
    messages: [{ role: 'user', content: 'hello' }],
    streamResponse: true,
  });

  const ctype = res.headers.get('content-type') || '';
  assert.match(ctype, /application\/json/);
  assert.doesNotMatch(ctype, /text\/event-stream/);

  const body = await res.json();
  assert.equal(body.response, 'Hi! Upload a photo to begin.');
  assert.deepEqual(body.memories, { stores: [], forgets: [] });
  assert.equal(body.stagedImage, undefined);
  assert.equal(app.calls.processStaging.calls, 0);
});

// 2 ─ Streamed staging turn: opt-in + slow-image intent → SSE with the documented
//     status → message → images → done frame sequence.
test('staging routing with streamResponse and an image streams SSE frames status/message/images/done', async () => {
  app = await mountChat({ routing: STAGING_ROUTING });

  const res = await postChat(app.baseUrl, {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'stage this' },
          { type: 'image_url', image_url: { url: ROOM_IMAGE } },
        ],
      },
    ],
    streamResponse: true,
  });

  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

  const frames = parseSse(await res.text());
  assert.deepEqual(
    frames.map((f) => f.event),
    ['status', 'message', 'images', 'done'],
  );

  const byEvent = Object.fromEntries(frames.map((f) => [f.event, f.data]));
  assert.equal(byEvent.status.type, 'staging');
  assert.equal(byEvent.message.response, 'Done staging your room.');
  // The final image lives ONLY in the 'images' event. The earlier 'message'
  // frame carries the text/memories but must NOT smuggle the staged image.
  assert.equal(byEvent.message.stagedImage, undefined);
  assert.equal(byEvent.images.stagedImage, 'data:staged');
  assert.equal(byEvent.images.stagingParams.roomType, 'Living room');

  assert.equal(app.calls.processStaging.calls, 1);
  assert.equal(app.calls.incPromptCount.calls, 1);
});

// 3 ─ Same staging intent, but the client did NOT opt into streaming → plain JSON,
//     proving the non-streaming staging path still runs the pipeline.
test('staging routing without streamResponse returns the staged image as application/json', async () => {
  app = await mountChat({ routing: STAGING_ROUTING });

  const res = await postChat(app.baseUrl, {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'stage this' },
          { type: 'image_url', image_url: { url: ROOM_IMAGE } },
        ],
      },
    ],
  });

  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const body = await res.json();
  assert.equal(body.stagedImage, 'data:staged');
  assert.equal(body.stagingParams.roomType, 'Living room');
  assert.equal(app.calls.processStaging.calls, 1);
});

// 4 ─ Generate is text-to-image (no room image required); streamed SSE carries the
//     generated image in the "images" frame with a "generating" status.
test('generate routing with streamResponse streams a generating status and the generated image', async () => {
  app = await mountChat({
    routing: {
      response: 'Here are some options.',
      generate: [{ shouldGenerate: true, prompt: 'a modern sofa' }],
    },
  });

  const res = await postChat(app.baseUrl, {
    messages: [{ role: 'user', content: 'generate a modern sofa' }],
    streamResponse: true,
  });

  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

  const frames = parseSse(await res.text());
  assert.deepEqual(
    frames.map((f) => f.event),
    ['status', 'message', 'images', 'done'],
  );

  const byEvent = Object.fromEntries(frames.map((f) => [f.event, f.data]));
  assert.equal(byEvent.status.type, 'generating');
  assert.equal(byEvent.message.response, 'Here are some options.');
  assert.equal(byEvent.images.generatedImage, 'data:generated');

  assert.equal(app.calls.processImageGeneration.calls, 1);
  assert.equal(app.calls.processStaging.calls, 0);
});

// 5 ─ Defer-suppression: a clarifying-question response ("...?") with a staging
//     action nulls the action, so the turn degrades to a plain JSON text reply.
test('a clarifying-question response suppresses the staging action and returns plain JSON', async () => {
  app = await mountChat({
    routing: {
      response: 'What style would you prefer?',
      staging: [
        {
          shouldStage: true,
          roomType: 'Living room',
          additionalPrompt: 'warm modern',
          removeFurniture: false,
          usePreviousImage: false,
          furnitureImageIndex: null,
          styleReference: false,
        },
      ],
    },
  });

  const res = await postChat(app.baseUrl, {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'stage this' },
          { type: 'image_url', image_url: { url: ROOM_IMAGE } },
        ],
      },
    ],
    streamResponse: true,
  });

  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const body = await res.json();
  assert.equal(body.response, 'What style would you prefer?');
  assert.equal(body.stagedImage, undefined);
  assert.equal(app.calls.processStaging.calls, 0);
});

// 6 ─ Auth gate: when requireProAccount rejects, the handler returns before any
//     dispatch and never runs the pipeline.
test('an unauthenticated request is rejected with 401 and never stages', async () => {
  app = await mountChat({
    routing: STAGING_ROUTING,
    requireProAccount: (req, res) => {
      res.status(401).json({ code: 'AUTH_REQUIRED' });
      return false;
    },
  });

  const res = await postChat(app.baseUrl, {
    messages: [{ role: 'user', content: 'stage this' }],
  });

  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'AUTH_REQUIRED');
  assert.equal(app.calls.processStaging.calls, 0);
});

// 6b ─ IDOR guard: memories key on the VALIDATED SESSION account (proUser.id),
//      never a client-supplied body field. A signed-in user must not be able to
//      read or overwrite another account's memories by passing that account's id.
test('memories key on the session user.id and ignore a spoofed body userId', async () => {
  const loadArgs = [];
  app = await mountChat({
    routing: { response: 'Noted.', memories: { stores: ['User is an architect'] } },
    requireProAccount: () => ({ id: 'session-user', email: 'me@example.com', plan: 'pro' }),
    loadMemories: (id) => { loadArgs.push(id); return []; },
  });

  const res = await postChat(app.baseUrl, {
    messages: [{ role: 'user', content: 'I am an architect' }],
    // Attacker-controlled identity fields — both MUST be ignored by the handler.
    userId: 'victim-account-id',
    userEmail: 'victim@example.com',
  });

  assert.equal(res.status, 200);
  // Read path: memories were loaded for the session user, not the spoofed id.
  assert.deepEqual(loadArgs, ['session-user']);
  // Write path: the AI's memory store persisted under the session user, not the spoofed id.
  assert.equal(app.calls.saveMemories.calls, 1);
  assert.equal(app.calls.saveMemories.lastArgs[0], 'session-user');
});

// 7 ─ Misconfiguration: no OpenAI client → 500 with the documented message.
test('a missing OpenAI client yields a 500 AI-not-configured error', async () => {
  app = await mountChat({ openai: null });

  const res = await postChat(app.baseUrl, {
    messages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'AI service not properly configured');
  assert.equal(app.calls.processStaging.calls, 0);
});

// 8 ─ CAD (flagship 3D-render intent): opt-in + a shouldProcessCAD decision on a
//     message that carries a blueprint image → SSE. chatIntentType maps CAD to the
//     'staging' status category, and the rendered blueprint lands in the "images"
//     frame as cadImage (a data: URL built from blueprintTo3D's returned buffer).
test('cad routing with streamResponse renders the blueprint and streams cadImage in the images frame', async () => {
  app = await mountChat({
    routing: {
      response: 'Here is your 3D render.',
      cad: [
        { shouldProcessCAD: true, imageIndex: 0, furnitureImageIndex: null, additionalPrompt: '' },
      ],
    },
  });

  const res = await postChat(app.baseUrl, {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'turn this floorplan into a 3D render' },
          { type: 'image_url', image_url: { url: ROOM_IMAGE } },
        ],
      },
    ],
    streamResponse: true,
  });

  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

  const frames = parseSse(await res.text());
  assert.deepEqual(
    frames.map((f) => f.event),
    ['status', 'message', 'images', 'done'],
  );

  const byEvent = Object.fromEntries(frames.map((f) => [f.event, f.data]));
  assert.equal(byEvent.status.type, 'staging'); // chatIntentType maps CAD → 'staging'
  assert.equal(byEvent.message.response, 'Here is your 3D render.');

  // cadImage is a data: URL whose base64 payload is exactly blueprintTo3D's buffer.
  assert.equal(typeof byEvent.images.cadImage, 'string');
  assert.match(byEvent.images.cadImage, /^data:/);
  const cadB64 = byEvent.images.cadImage.split(',')[1];
  assert.equal(Buffer.from(cadB64, 'base64').toString(), 'cad');

  // The blueprint was rendered exactly once (getImageFromHistory resolved index 0).
  assert.equal(app.calls.cad.length, 1);
  assert.equal(app.calls.processStaging.calls, 0);
});

// 9 ─ Multi-request staging: the router returns an ARRAY of two shouldStage
//     requests. buildDesignerResponse switches to the plural shape (stagedImages /
//     stagingParams arrays) and the pipeline runs processStaging once per request.
test('a two-request staging array streams plural stagedImages and stages twice', async () => {
  app = await mountChat({
    routing: {
      response: 'Done staging both versions.',
      staging: [
        {
          shouldStage: true,
          roomType: 'Living room',
          additionalPrompt: 'warm modern',
          removeFurniture: false,
          usePreviousImage: false,
          furnitureImageIndex: null,
          styleReference: false,
        },
        {
          shouldStage: true,
          roomType: 'Bedroom',
          additionalPrompt: 'calm minimalist',
          removeFurniture: false,
          usePreviousImage: false,
          furnitureImageIndex: null,
          styleReference: false,
        },
      ],
    },
  });

  const res = await postChat(app.baseUrl, {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'stage this two ways' },
          { type: 'image_url', image_url: { url: ROOM_IMAGE } },
        ],
      },
    ],
    streamResponse: true,
  });

  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

  const frames = parseSse(await res.text());
  assert.deepEqual(
    frames.map((f) => f.event),
    ['status', 'message', 'images', 'done'],
  );

  const byEvent = Object.fromEntries(frames.map((f) => [f.event, f.data]));
  assert.equal(byEvent.status.type, 'staging');
  // >1 result → plural arrays (no singular stagedImage), one entry per request.
  assert.equal(byEvent.images.stagedImage, undefined);
  assert.ok(Array.isArray(byEvent.images.stagedImages));
  assert.equal(byEvent.images.stagedImages.length, 2);
  assert.ok(Array.isArray(byEvent.images.stagingParams));
  assert.equal(byEvent.images.stagingParams.length, 2);
  assert.equal(byEvent.images.stagingParams[0].roomType, 'Living room');
  assert.equal(byEvent.images.stagingParams[1].roomType, 'Bedroom');

  assert.equal(app.calls.processStaging.calls, 2);
});

// 10 ─ Request guard: a body with no messages array is rejected 400 before any
//      routing call or pipeline dispatch.
test('a request with no messages array is rejected with 400', async () => {
  app = await mountChat({ routing: STAGING_ROUTING });

  const res = await postChat(app.baseUrl, { streamResponse: false });

  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Messages array is required');
  assert.equal(app.calls.openaiCreate.calls, 0);
  assert.equal(app.calls.processStaging.calls, 0);
});
