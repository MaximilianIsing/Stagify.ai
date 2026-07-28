// Tier: route contract (fake AI) — POST /api/chat-upload, the multipart sibling of
// /api/chat.
//
// WHY THIS EXISTS
// chat-route.test.js covers /api/chat; the upload endpoint had no route-level test
// at all — only its extracted units (test/chat/chat-upload-prep.test.js,
// chat-upload-error.test.js). Everything the 280-line handler itself owns was
// uncovered: the guards, the multipart field plumbing (conversationHistory arrives
// as a JSON *string*, streamResponse as the *string* 'true'), the upload-only
// staging synthesis for "add this chair", and the imageAnnotations mapping. Those
// are exactly the behaviors a refactor of that handler would break silently, so
// this suite characterizes them.
//
// HOW THE MULTIPART BODY GETS PARSED
// test/helpers/chat-app.js mounts the router with REAL multer on memory storage,
// so `chatUpload.array('files', 5)` behaves as it does in production: req.files
// carries genuine Buffers and the text fields land on req.body. Tests post a real
// FormData body via fetch. The OpenAI client and every slow image step are still
// the deterministic fakes mountChat installs — no network, no model.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mountChat } from '../helpers/chat-app.js';

// A PNG only has to survive base64 round-tripping: annotateImage and
// downscaleImageForGPT are faked, so no real image bytes are decoded.
const PNG_BYTES = Buffer.from('png-room-bytes');
const pngFile = (name = 'room.png') =>
  new File([PNG_BYTES], name, { type: 'image/png' });

// The staging routing the fake model returns. No '?' in the response, so
// aiResponseDefersImageAction does NOT suppress the action.
const STAGING_ROUTING = {
  response: 'Staged your room.',
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
};

// An assistant turn carrying a staged image — what findMostRecentStagedImageIndex
// looks for (an assistant image_url item flagged isStaged).
const STAGED_HISTORY = [
  { role: 'user', content: 'stage my living room' },
  {
    role: 'assistant',
    content: [
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,c3RhZ2Vk' },
        isStaged: true,
      },
    ],
  },
];

let app;
afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

// Build and POST a real multipart body. `files` are appended under the 'files'
// field the router's .array('files', 5) reads; every other key becomes a text
// field, JSON-stringified when it isn't already a string (mirrors the browser,
// which can only send strings).
function postUpload(base, { files = [], ...fields } = {}) {
  const form = new FormData();
  for (const file of files) form.append('files', file, file.name);
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return fetch(`${base}/api/chat-upload`, { method: 'POST', body: form });
}

// Parse a raw SSE stream body into an ordered array of { event, data }.
function parseSse(raw) {
  return raw
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
}

// 1 ─ Guard: multer parsed the request but no file field was present.
test('an upload with no files is rejected with 400 and never calls the model', async () => {
  app = await mountChat({ routing: STAGING_ROUTING });

  const res = await postUpload(app.baseUrl, { message: 'stage this' });

  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'No files provided');
  assert.equal(app.calls.openaiCreate.calls, 0);
  assert.equal(app.calls.processStaging.calls, 0);
});

// 2 ─ Auth gate runs BEFORE the file check, so a rejected caller never reaches
//     the pipeline even with a valid upload attached.
test('an unauthenticated upload is rejected with 401 and never stages', async () => {
  app = await mountChat({
    routing: STAGING_ROUTING,
    requireProAccount: (req, res) => {
      res.status(401).json({ code: 'AUTH_REQUIRED' });
      return false;
    },
  });

  const res = await postUpload(app.baseUrl, { files: [pngFile()], message: 'stage this' });

  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'AUTH_REQUIRED');
  assert.equal(app.calls.processStaging.calls, 0);
});

// 3 ─ Misconfiguration: no OpenAI client → the same 500 /api/chat returns.
test('a missing OpenAI client yields a 500 AI-not-configured error', async () => {
  app = await mountChat({ openai: null });

  const res = await postUpload(app.baseUrl, { files: [pngFile()], message: 'stage this' });

  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'AI service not properly configured');
});

// 4 ─ Happy path. The uploaded file's real bytes reach processStaging, and the
//     response echoes the upload summary under `files` (the upload-only extra
//     field buildDesignerResponse merges in).
test('a PNG upload with staging routing stages the uploaded bytes and echoes the file summary', async () => {
  app = await mountChat({ routing: STAGING_ROUTING });

  const res = await postUpload(app.baseUrl, {
    files: [pngFile('living-room.png')],
    message: 'stage this room',
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.response, 'Staged your room.');
  assert.deepEqual(body.files, [{ name: 'living-room.png', type: 'image/png' }]);
  assert.equal(body.stagedImage, 'data:staged');

  // The current upload — not a history image — was the staging base.
  assert.equal(app.calls.processStaging.calls, 1);
  const stagedBuffer = app.calls.processStaging.lastArgs[0];
  assert.ok(Buffer.isBuffer(stagedBuffer));
  assert.equal(stagedBuffer.toString(), PNG_BYTES.toString());
});

// 5 ─ conversationHistory arrives as a JSON STRING (a multipart text field), and
//     the MAX_USER_MESSAGES ceiling is enforced on the parsed array before any
//     model call.
test('a history at the 20-user-message ceiling short-circuits with contextLimitReached', async () => {
  app = await mountChat({ routing: STAGING_ROUTING });

  const history = Array.from({ length: 20 }, (_, i) => ({
    role: 'user',
    content: `message ${i}`,
  }));

  const res = await postUpload(app.baseUrl, {
    files: [pngFile()],
    message: 'one more',
    conversationHistory: JSON.stringify(history),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.contextLimitReached, true);
  assert.match(body.response, /maximum conversation context limit \(20 messages\)/);
  assert.equal(app.calls.openaiCreate.calls, 0);
});

// 5b ─ A malformed conversationHistory field must not 500 the request: the handler
//      logs and falls back to an empty history. The "Error parsing conversation
//      history: SyntaxError" line this prints is the behavior under test, not a
//      failing suite.
test('an unparseable conversationHistory falls back to empty instead of failing the request', async () => {
  app = await mountChat({ routing: { response: 'Hello.' } });

  const res = await postUpload(app.baseUrl, {
    files: [pngFile()],
    message: 'hi',
    conversationHistory: '{not json',
  });

  assert.equal(res.status, 200);
  assert.equal((await res.json()).response, 'Hello.');
});

// 6 ─ Streaming opt-in over multipart. A form field can only be a STRING, so the
//     handler must accept streamResponse:'true' — the `=== 'true'` branch in
//     wantsStreamedChatResponse exists for exactly this endpoint. Combined with a
//     slow-image intent it opens SSE, and the staged image lands in the "images"
//     frame (not "message").
test("streamResponse:'true' as a form field streams SSE frames status/message/images/done", async () => {
  app = await mountChat({ routing: STAGING_ROUTING });

  const res = await postUpload(app.baseUrl, {
    files: [pngFile()],
    message: 'stage this room',
    streamResponse: 'true',
  });

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const frames = parseSse(await res.text());
  assert.deepEqual(frames.map((f) => f.event), ['status', 'message', 'images', 'done']);
  assert.equal(frames[0].data.type, 'staging');
  assert.equal(frames[1].data.response, 'Staged your room.');
  assert.equal(frames[2].data.stagedImage, 'data:staged');
});

// 6b ─ The same request WITHOUT the opt-in stays application/json, even though the
//      intent is a slow image action.
test('a staging upload without streamResponse returns application/json', async () => {
  app = await mountChat({ routing: STAGING_ROUTING });

  const res = await postUpload(app.baseUrl, {
    files: [pngFile()],
    message: 'stage this room',
  });

  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal((await res.json()).stagedImage, 'data:staged');
});

// 7 ─ Upload-only staging synthesis. The model returned NO staging action, but the
//     user is adding furniture to a room that already has a staged image in
//     history — the handler synthesizes a staging request so the furniture shot is
//     composited instead of being answered with text. This block lives only in
//     /api/chat-upload; /api/chat has no equivalent.
test('a furniture upload with no staging routing still stages when history has a staged image', async () => {
  app = await mountChat({ routing: { response: 'Adding that chair now.' } });

  const res = await postUpload(app.baseUrl, {
    files: [pngFile('chair.png')],
    message: 'add this chair to the room',
    conversationHistory: JSON.stringify(STAGED_HISTORY),
  });

  assert.equal(res.status, 200);
  assert.equal((await res.json()).stagedImage, 'data:staged');
  assert.equal(app.calls.processStaging.calls, 1);
});

// 7b ─ The mirror case: the same furniture-shaped message with NO staged image in
//      history synthesizes nothing and degrades to a plain text reply.
test('the same furniture message with no staged image in history does not synthesize staging', async () => {
  app = await mountChat({ routing: { response: 'Adding that chair now.' } });

  const res = await postUpload(app.baseUrl, {
    files: [pngFile('chair.png')],
    message: 'add this chair to the room',
  });

  assert.equal(res.status, 200);
  assert.equal(app.calls.processStaging.calls, 0);
});

// 8 ─ The client-supplied model is allow-listed before it reaches OpenAI, exactly
//     as on /api/chat (resolveChatModel), and the upload endpoint must not be the
//     hole in that gate.
test('an off-allow-list model is never forwarded to OpenAI', async () => {
  app = await mountChat({ routing: { response: 'Hi.' } });

  await postUpload(app.baseUrl, {
    files: [pngFile()],
    message: 'hi',
    model: 'evil-model-9000',
  });

  assert.equal(app.calls.openaiCreate.calls, 1);
  assert.notEqual(app.calls.openaiCreate.lastArgs[0].model, 'evil-model-9000');
});

// 9 ─ Image annotations are collected off the private `_annotation` property that
//     buildUploadMessages resolves from each image's background annotationPromise,
//     and returned to the frontend keyed by FILENAME.
test('a resolved image annotation is returned keyed by the uploaded filename', async () => {
  app = await mountChat({
    routing: { response: 'Nice room.' },
    annotateImage: async () => 'a bright empty living room',
  });

  const res = await postUpload(app.baseUrl, {
    files: [pngFile('front-room.png')],
    message: 'what do you think?',
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.imageAnnotations, { 'front-room.png': 'a bright empty living room' });
});

// 10 ─ An unsupported upload is described to the model as TEXT and never sent as an
//      image; the request still succeeds rather than erroring out.
test('an unsupported file type is described as text and never sent to OpenAI as an image', async () => {
  app = await mountChat({ routing: { response: 'That format is not supported.' } });

  const res = await postUpload(app.baseUrl, {
    files: [new File([Buffer.from('PKzip')], 'plans.zip', { type: 'application/zip' })],
    message: '',
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.files, [{ name: 'plans.zip', type: 'application/zip' }]);

  // Nothing image-shaped reached the model; the file is mentioned in text instead.
  const sentMessages = app.calls.openaiCreate.lastArgs[0].messages;
  const userTurn = sentMessages[sentMessages.length - 1];
  const imageItems = (Array.isArray(userTurn.content) ? userTurn.content : []).filter(
    (item) => item.type === 'image_url'
  );
  assert.equal(imageItems.length, 0);
  assert.match(JSON.stringify(userTurn.content), /plans\.zip/);
  assert.match(JSON.stringify(userTurn.content), /not supported/);
});

// 11 ─ A clarifying question suppresses the image action on this endpoint too
//      (aiResponseDefersImageAction is shared glue, but the upload handler has its
//      own synthesis step afterwards — this pins that the suppression still wins).
test('a clarifying-question response suppresses staging and returns plain JSON', async () => {
  app = await mountChat({
    routing: {
      ...STAGING_ROUTING,
      response: 'Which room is this — a living room or a den?',
    },
  });

  const res = await postUpload(app.baseUrl, {
    files: [pngFile()],
    message: 'stage this',
    streamResponse: 'true',
  });

  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(app.calls.processStaging.calls, 0);
  assert.equal((await res.json()).stagedImage, undefined);
});

// ORDER GUARD (mirror of the one in chat-route.test.js). /api/chat-upload
// dispatches STAGING before image GENERATION — the reverse of /api/chat. The two
// handlers share lib/chat/chat-post-routing.js and differ only by the `order`
// they pass in, so these two tests are the only thing pinning the difference.
test('/api/chat-upload runs staging BEFORE image generation (the reverse of /api/chat)', async () => {
  /** @type {string[]} */
  const order = [];
  app = await mountChat({
    routing: {
      ...STAGING_ROUTING,
      response: 'Staged your room and drew some artwork.',
      generate: [{ shouldGenerate: true, prompt: 'abstract artwork' }],
    },
    processStaging: async () => { order.push('staging'); return 'data:staged'; },
    processImageGeneration: async () => { order.push('generate'); return 'data:generated'; },
  });

  const res = await postUpload(app.baseUrl, {
    files: [pngFile()],
    message: 'stage this room and make some artwork',
  });

  const body = await res.json();
  assert.equal(body.stagedImage, 'data:staged');
  assert.equal(body.generatedImage, 'data:generated');
  assert.deepEqual(order, ['staging', 'generate']);
});
