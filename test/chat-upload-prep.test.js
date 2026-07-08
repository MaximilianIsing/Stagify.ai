// Tier: unit (hand-rolled fakes) — lib/chat/chat-upload-prep.js, the
// /api/chat-upload PRE-ROUTING pipeline.
//
// WHAT THIS COVERS
// createUploadPrep(deps) returns four functions that turn a multipart upload
// into a GPT-ready messages array and run the routing completion. This suite
// exercises each in isolation, asserting the ACTUAL branch logic quoted from the
// source:
//   - buildUploadUserContent: the [TAG: …] prefix map (stage/generate/…), the
//     'auto' no-prefix escape, AVIF rejection (text note, never an image), other
//     unsupported types (ZIP → "…not supported."), supported images (base64 data
//     URL + annotationPromise, firstImageFile), text files (utf8 inlined) and
//     PDFs ("[File: … Content cannot be directly read]").
//   - buildUploadMessages: system message first, conversation-history images
//     STRIPPED to text, and the current user turn cleaned to ONLY
//     { type:'image_url', image_url:{ url } } with the url DOWNSCALED, while the
//     internal cleanedUserContent keeps _annotation / _filename.
//   - runUploadRouting: the success mapping (missing keys default to null,
//     memories defaults to {stores:[],forgets:[]}), the image-error recovery pass
//     (second create() call; cad intentionally stays null on that path), and the
//     non-image-error re-throw.
//
// WHY NO REAL API / MODEL / COST
// Every model-touching dependency is injected as a hand-rolled fake:
//   * openai.chat.completions.create is a scripted async fn that returns a
//     completion whose message.content is JSON.stringify(routingObj), or throws a
//     scripted error — it never opens a socket.
//   * annotateImage / downscaleImageForGPT / getTemperatureForModel are trivial
//     pure fakes. downscaleImageForGPT appends '#down' so a test can PROVE it ran.
//   * DEBUG_MODE is false, silencing the module's console logging.
// No network, no OpenAI SDK method, no email, no filesystem, no cost — every
// assertion is deterministic. Image "bytes" are tiny in-memory Buffers; nothing
// is decoded through sharp because downscaleImageForGPT is faked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import createUploadPrep from '../lib/chat/chat-upload-prep.js';

// ── Fakes ───────────────────────────────────────────────────────────────────

// A scriptable OpenAI stand-in. `steps` is consumed one per create() call; each
// step is { routing } (returned as a completion whose content is JSON), or
// { error } (thrown). Records call count + args so tests can assert both.
function makeScriptedOpenAI(steps) {
  const state = { calls: 0, args: [] };
  const openai = {
    chat: {
      completions: {
        create: async (args) => {
          const step = steps[state.calls] ?? steps[steps.length - 1];
          state.calls += 1;
          state.args.push(args);
          if (step.error) throw step.error;
          return { choices: [{ message: { content: JSON.stringify(step.routing) } }] };
        },
      },
    },
  };
  return { openai, state };
}

// Build the prep with sensible defaults; each dep is overridable per-test.
function makePrep(overrides = {}) {
  return createUploadPrep({
    DEBUG_MODE: false,
    openai: overrides.openai,
    annotateImage: overrides.annotateImage ?? (async () => 'note'),
    downscaleImageForGPT: overrides.downscaleImageForGPT ?? (async (u) => u + '#down'),
    getTemperatureForModel: overrides.getTemperatureForModel ?? (() => 0.7),
  });
}

// A minimal multer-style file: { originalname, mimetype, buffer }.
function makeFile(originalname, mimetype, content = 'x') {
  return {
    originalname,
    mimetype,
    buffer: Buffer.isBuffer(content) ? content : Buffer.from(content),
  };
}

const textItems = (content) => content.filter((i) => i.type === 'text');
const imageItems = (content) => content.filter((i) => i.type === 'image_url');
const joinText = (content) => textItems(content).map((i) => i.text).join('\n');

// ─────────────────────────────────────────────────────────────────────────────
// 1 ─ buildUploadUserContent: tag mapping
// ─────────────────────────────────────────────────────────────────────────────

test('buildUploadUserContent prefixes the message with the mapped [TAG: …] for a non-auto tag', () => {
  const prep = makePrep();
  const { userContent } = prep.buildUploadUserContent({
    files: [],
    message: 'do it',
    messageTag: 'stage',
  });
  // tagMap.stage === '[TAG: Stage]', then `${tag} ${msg}`.trim().
  assert.equal(userContent[0].type, 'text');
  assert.equal(userContent[0].text, '[TAG: Stage] do it');
});

test('buildUploadUserContent adds NO tag prefix when messageTag is "auto"', () => {
  const prep = makePrep();
  const { userContent } = prep.buildUploadUserContent({
    files: [],
    message: 'do it',
    messageTag: 'auto',
  });
  // `messageTag !== 'auto'` is false → the raw message is used verbatim.
  assert.equal(userContent[0].text, 'do it');
});

test('buildUploadUserContent emits the bare tag as a text item when there is no message', () => {
  const prep = makePrep();
  const { userContent, hasImages } = prep.buildUploadUserContent({
    files: [],
    message: '',
    messageTag: 'generate',
  });
  // else-if branch: no text message but a tag → push tagMap.generate as text.
  assert.equal(userContent.length, 1);
  assert.equal(userContent[0].text, '[TAG: Generate]');
  assert.equal(hasImages, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 ─ buildUploadUserContent: AVIF is rejected to text, never sent as an image
// ─────────────────────────────────────────────────────────────────────────────

test('buildUploadUserContent routes an AVIF upload to unsupportedFiles and a text note, not an image', () => {
  const prep = makePrep();
  const { userContent, hasImages, firstImageFile, unsupportedFiles } =
    prep.buildUploadUserContent({
      files: [makeFile('photo.avif', 'image/avif')],
      message: '',
      messageTag: 'auto',
    });

  assert.equal(unsupportedFiles.length, 1);
  assert.equal(unsupportedFiles[0].fileType, 'AVIF');
  // Appended as a TEXT note, and NOT added as an image_url.
  assert.equal(imageItems(userContent).length, 0);
  assert.match(joinText(userContent), /in AVIF format which is not supported\./);
  assert.equal(hasImages, false);
  assert.equal(firstImageFile, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 ─ buildUploadUserContent: other unsupported types → text note
// ─────────────────────────────────────────────────────────────────────────────

test('buildUploadUserContent rejects a non-image unsupported type (zip) with a "…not supported." note', () => {
  const prep = makePrep();
  const { userContent, hasImages, unsupportedFiles } = prep.buildUploadUserContent({
    files: [makeFile('a.zip', 'application/zip')],
    message: '',
    messageTag: 'auto',
  });

  assert.equal(unsupportedFiles.length, 1);
  // fileType = ext.toUpperCase().substring(1) → 'ZIP'.
  assert.equal(unsupportedFiles[0].fileType, 'ZIP');
  assert.equal(imageItems(userContent).length, 0);
  assert.match(joinText(userContent), /in ZIP format which is not supported\./);
  assert.equal(hasImages, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 ─ buildUploadUserContent: supported image → vision item + annotationPromise
// ─────────────────────────────────────────────────────────────────────────────

test('buildUploadUserContent turns a supported PNG into an image_url item with a base64 data URL and annotationPromise', async () => {
  const annotateCalls = [];
  const prep = makePrep({
    annotateImage: async (...args) => {
      annotateCalls.push(args);
      return 'note';
    },
  });

  const file = makeFile('room.png', 'image/png', Buffer.from('PNGBYTES'));
  const { userContent, hasImages, firstImageFile } = prep.buildUploadUserContent({
    files: [file],
    message: 'stage this',
    messageTag: 'auto',
  });

  assert.equal(hasImages, true);
  assert.equal(firstImageFile, file);

  const img = imageItems(userContent)[0];
  assert.ok(img, 'expected an image_url item');
  const expectedUrl = 'data:image/png;base64,' + Buffer.from('PNGBYTES').toString('base64');
  assert.equal(img.image_url.url, expectedUrl);
  assert.equal(img.filename, 'room.png');
  assert.equal(img.originalname, 'room.png');
  assert.ok(img.annotationPromise && typeof img.annotationPromise.then === 'function');

  // annotateImage was invoked with (imageDataUrl, false, true) and the promise
  // resolves to its result.
  assert.equal(annotateCalls.length, 1);
  assert.deepEqual(annotateCalls[0], [expectedUrl, false, true]);
  assert.equal(await img.annotationPromise, 'note');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 ─ buildUploadUserContent: text file inlined, PDF placeholdered
// ─────────────────────────────────────────────────────────────────────────────

test('buildUploadUserContent inlines a text file (File: <name> + utf8 body) and placeholders a PDF', () => {
  const prep = makePrep();

  const textRes = prep.buildUploadUserContent({
    files: [makeFile('notes.txt', 'text/plain', 'hello')],
    message: '',
    messageTag: 'auto',
  });
  const textBlob = joinText(textRes.userContent);
  assert.match(textBlob, /File: notes\.txt/);
  assert.match(textBlob, /hello/);
  assert.equal(imageItems(textRes.userContent).length, 0);

  const pdfRes = prep.buildUploadUserContent({
    files: [makeFile('doc.pdf', 'application/pdf', Buffer.from('%PDF'))],
    message: '',
    messageTag: 'auto',
  });
  assert.match(
    joinText(pdfRes.userContent),
    /\[File: doc\.pdf, Type: application\/pdf - Content cannot be directly read\]/,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 ─ buildUploadMessages: system-first, history images stripped, current turn
//     cleaned + downscaled
// ─────────────────────────────────────────────────────────────────────────────

test('buildUploadMessages puts system first, strips history images to text, and cleans+downscales the current turn', async () => {
  const prep = makePrep();

  const file = makeFile('room.png', 'image/png', Buffer.from('PNGBYTES'));
  const { userContent } = prep.buildUploadUserContent({
    files: [file],
    message: 'stage this',
    messageTag: 'auto',
  });

  // A prior user turn that carried its own image — it must be reduced to text.
  const conversationHistory = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'earlier' },
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,UFJJT1I=' },
          filename: 'prior.png',
        },
      ],
    },
  ];

  const { safeMessages, cleanedUserContent } = await prep.buildUploadMessages({
    systemInstruction: 'SYS',
    userContent,
    files: [file],
    conversationHistory,
  });

  // System message is first, verbatim.
  assert.deepEqual(safeMessages[0], { role: 'system', content: 'SYS' });

  // Every message BEFORE the current turn is image-free: the history image was
  // stripped to a "[Image: prior.png]" text reference (string content).
  const priorMessages = safeMessages.slice(0, -1);
  for (const msg of priorMessages) {
    const hasImage =
      Array.isArray(msg.content) && msg.content.some((i) => i.type === 'image_url');
    assert.equal(hasImage, false, 'no image_url may survive in non-current messages');
  }
  assert.equal(typeof safeMessages[1].content, 'string');
  assert.match(safeMessages[1].content, /\[Image: prior\.png\]/);

  // The LAST message is the current user turn; its image item is cleaned to ONLY
  // { type, image_url:{ url } } (no filename / originalname / annotationPromise
  // leak) and the url is downscaled (ends with '#down').
  const current = safeMessages[safeMessages.length - 1];
  assert.equal(current.role, 'user');
  const curImg = imageItems(current.content)[0];
  assert.deepEqual(Object.keys(curImg).sort(), ['image_url', 'type']);
  assert.deepEqual(Object.keys(curImg.image_url), ['url']);
  assert.ok(curImg.image_url.url.endsWith('#down'));

  // Internally, cleanedUserContent keeps the annotation + filename side-channel
  // (these are deliberately NOT sent to OpenAI).
  const cleanImg = imageItems(cleanedUserContent)[0];
  assert.equal(cleanImg._annotation, 'note');
  assert.equal(cleanImg._filename, 'room.png');
});

// ─────────────────────────────────────────────────────────────────────────────
// 7 ─ runUploadRouting: success mapping + defaults
// ─────────────────────────────────────────────────────────────────────────────

test('runUploadRouting returns the parsed routing fields on success (missing keys default to null)', async () => {
  const { openai, state } = makeScriptedOpenAI([
    { routing: { response: 'ok', staging: [{ shouldStage: true }], memories: { stores: ['m'], forgets: [] } } },
  ]);
  const prep = makePrep({ openai });

  const result = await prep.runUploadRouting({
    safeMessages: [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ],
    selectedModel: 'gpt-x',
    message: 'hi',
    unsupportedFiles: [],
    conversationHistory: [],
    systemInstruction: 'SYS',
  });

  assert.equal(state.calls, 1);
  assert.equal(result.text, 'ok');
  assert.deepEqual(result.stagingRequestFromAI, [{ shouldStage: true }]);
  assert.deepEqual(result.memoryActionsFromAI, { stores: ['m'], forgets: [] });
  assert.equal(result.imageRequestFromAI, null);
  assert.equal(result.recallRequestFromAI, null);
  assert.equal(result.generateRequestFromAI, null);
  assert.equal(result.cadRequestFromAI, null);

  // The completion was requested with the selected model + injected temperature.
  assert.equal(state.args[0].model, 'gpt-x');
  assert.equal(state.args[0].temperature, 0.7);
});

test('runUploadRouting defaults memories to {stores:[],forgets:[]} when the routing omits them', async () => {
  const { openai } = makeScriptedOpenAI([{ routing: { response: 'hello' } }]);
  const prep = makePrep({ openai });

  const result = await prep.runUploadRouting({
    safeMessages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    selectedModel: 'gpt-x',
    message: 'hi',
    unsupportedFiles: [],
    conversationHistory: [],
    systemInstruction: 'SYS',
  });

  assert.equal(result.text, 'hello');
  assert.deepEqual(result.memoryActionsFromAI, { stores: [], forgets: [] });
  assert.equal(result.stagingRequestFromAI, null);
  assert.equal(result.imageRequestFromAI, null);
  assert.equal(result.recallRequestFromAI, null);
  assert.equal(result.generateRequestFromAI, null);
  assert.equal(result.cadRequestFromAI, null);
});

test('runUploadRouting maps ALL routing fields (including cad) on the success path', async () => {
  const { openai } = makeScriptedOpenAI([
    {
      routing: {
        response: 'r',
        staging: [{ shouldStage: true }],
        memories: { stores: ['a'], forgets: ['b'] },
        imageRequest: { x: 1 },
        recall: { y: 2 },
        generate: [{ shouldGenerate: true, prompt: 'p' }],
        cad: [{ shouldProcessCAD: true }],
      },
    },
  ]);
  const prep = makePrep({ openai });

  const result = await prep.runUploadRouting({
    safeMessages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    selectedModel: 'gpt-x',
    message: 'hi',
    unsupportedFiles: [],
    conversationHistory: [],
    systemInstruction: 'SYS',
  });

  assert.equal(result.text, 'r');
  assert.deepEqual(result.stagingRequestFromAI, [{ shouldStage: true }]);
  assert.deepEqual(result.memoryActionsFromAI, { stores: ['a'], forgets: ['b'] });
  assert.deepEqual(result.imageRequestFromAI, { x: 1 });
  assert.deepEqual(result.recallRequestFromAI, { y: 2 });
  assert.deepEqual(result.generateRequestFromAI, [{ shouldGenerate: true, prompt: 'p' }]);
  // The success path DOES read cad (contrast with the recovery path below).
  assert.deepEqual(result.cadRequestFromAI, [{ shouldProcessCAD: true }]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 8 ─ runUploadRouting: image-error recovery (second create() call)
// ─────────────────────────────────────────────────────────────────────────────

test('runUploadRouting retries with a second create() when the first fails with an invalid_image_format code', async () => {
  const err = Object.assign(new Error('boom'), { code: 'invalid_image_format' });
  const { openai, state } = makeScriptedOpenAI([
    { error: err },
    {
      routing: {
        response: 'recovered',
        staging: [{ shouldStage: false }],
        memories: { stores: ['x'], forgets: ['y'] },
        cad: [{ shouldProcessCAD: true }],
      },
    },
  ]);
  const prep = makePrep({ openai });

  const result = await prep.runUploadRouting({
    safeMessages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    selectedModel: 'gpt-x',
    message: 'help',
    unsupportedFiles: [],
    conversationHistory: [],
    systemInstruction: 'SYS',
  });

  assert.equal(state.calls, 2); // first threw, recovery pass succeeded
  assert.equal(result.text, 'recovered');
  assert.deepEqual(result.stagingRequestFromAI, [{ shouldStage: false }]);
  assert.deepEqual(result.memoryActionsFromAI, { stores: ['x'], forgets: ['y'] });
  assert.equal(result.imageRequestFromAI, null);
  assert.equal(result.recallRequestFromAI, null);
  assert.equal(result.generateRequestFromAI, null);
  // The catch/recovery path intentionally never assigns cadRequestFromAI, so it
  // keeps its null default even though the recovery routing carries `cad`.
  assert.equal(result.cadRequestFromAI, null);
});

test('runUploadRouting recovers via a second create() when unsupportedFiles is non-empty (even for a non-image error)', async () => {
  // Error is NOT image-related, but unsupportedFiles.length > 0 forces the
  // recovery branch anyway.
  const err = Object.assign(new Error('random failure'), { code: 'server_error' });
  const { openai, state } = makeScriptedOpenAI([
    { error: err },
    { routing: { response: 'acknowledged the avif', staging: [{ shouldStage: false }] } },
  ]);
  const prep = makePrep({ openai });

  const result = await prep.runUploadRouting({
    safeMessages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    selectedModel: 'gpt-x',
    message: 'stage it',
    unsupportedFiles: [{ name: 'x.avif', fileType: 'AVIF' }],
    conversationHistory: [],
    systemInstruction: 'SYS',
  });

  assert.equal(state.calls, 2);
  assert.equal(result.text, 'acknowledged the avif');
  assert.deepEqual(result.stagingRequestFromAI, [{ shouldStage: false }]);
  assert.equal(result.cadRequestFromAI, null);
});

test('runUploadRouting recovers when the error message mentions "unsupported image"', async () => {
  const err = new Error('The request contained an unsupported image payload');
  const { openai, state } = makeScriptedOpenAI([
    { error: err },
    { routing: { response: 'handled', memories: { stores: [], forgets: [] } } },
  ]);
  const prep = makePrep({ openai });

  const result = await prep.runUploadRouting({
    safeMessages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    selectedModel: 'gpt-x',
    message: 'go',
    unsupportedFiles: [],
    conversationHistory: [],
    systemInstruction: 'SYS',
  });

  assert.equal(state.calls, 2);
  assert.equal(result.text, 'handled');
});

// ─────────────────────────────────────────────────────────────────────────────
// 9 ─ runUploadRouting: non-image error is re-thrown to the caller
// ─────────────────────────────────────────────────────────────────────────────

test('runUploadRouting re-throws a non-image error when there are no unsupported files (create called once)', async () => {
  const err = new Error('database exploded');
  const { openai, state } = makeScriptedOpenAI([{ error: err }]);
  const prep = makePrep({ openai });

  await assert.rejects(
    prep.runUploadRouting({
      safeMessages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      selectedModel: 'gpt-x',
      message: 'go',
      unsupportedFiles: [],
      conversationHistory: [],
      systemInstruction: 'SYS',
    }),
    /database exploded/,
  );
  assert.equal(state.calls, 1); // no recovery pass — the else branch re-threw
});

// ─────────────────────────────────────────────────────────────────────────────
// 10 ─ runUploadRouting: the recovery pass ASSEMBLES errorMessages exactly
//      [system, ...filterConversationHistory(history), {user: errorUserContent}]
//      and re-issues create() with the selected model + injected temperature.
// ─────────────────────────────────────────────────────────────────────────────

test('runUploadRouting recovery builds errorUserContent (message + per-file AVIF note) and re-calls create with model+temperature', async () => {
  // FIRST create() throws an image-format error; SECOND returns a valid routing.
  const { openai, state } = makeScriptedOpenAI([
    { error: { code: 'invalid_image_format' } },
    { routing: { response: 'recovered', staging: [{ shouldStage: false }] } },
  ]);
  // A distinct temperature (≠ the 0.7 default) so we can PROVE the recovery pass
  // read it from getTemperatureForModel(selectedModel).
  const getTemperatureForModel = (m) => (m === 'gpt-x' ? 0.55 : 0.1);
  const prep = makePrep({ openai, getTemperatureForModel });

  // An assistant string-content turn passes through filterConversationHistory
  // untouched (it only rewrites array-content USER turns), so filteredHistory
  // is structurally identical to what we pass in.
  const conversationHistory = [{ role: 'assistant', content: 'prior reply' }];

  const result = await prep.runUploadRouting({
    safeMessages: [{ role: 'user', content: [{ type: 'text', text: 'ignored on recovery' }] }],
    selectedModel: 'gpt-x',
    message: 'stage it',
    unsupportedFiles: [{ name: 'photo.avif', fileType: 'AVIF' }],
    conversationHistory,
    systemInstruction: 'SYS',
  });

  // Both create() calls happened; the recovery pass produced the result.
  assert.equal(state.calls, 2);
  assert.equal(result.text, 'recovered');
  assert.deepEqual(result.stagingRequestFromAI, [{ shouldStage: false }]);

  // The SECOND create() carries the freshly-assembled errorMessages array.
  const secondArgs = state.args[1];
  const expectedErrorUserContent = [
    { type: 'text', text: 'stage it' },
    { type: 'text', text: 'I uploaded "photo.avif" but it is in AVIF format which is not supported.' },
  ];
  assert.deepEqual(secondArgs.messages, [
    { role: 'system', content: 'SYS' },
    { role: 'assistant', content: 'prior reply' }, // ...filteredHistory (unchanged)
    { role: 'user', content: expectedErrorUserContent },
  ]);

  // errorUserContent carries BOTH the original message and the exact AVIF note.
  const secondUserContent = secondArgs.messages[secondArgs.messages.length - 1].content;
  assert.ok(
    secondUserContent.some((i) => i.type === 'text' && i.text.includes('stage it')),
    'expected the original "stage it" message text',
  );
  assert.ok(
    secondUserContent.some(
      (i) =>
        i.type === 'text' &&
        i.text === 'I uploaded "photo.avif" but it is in AVIF format which is not supported.',
    ),
    'expected the exact per-file AVIF unsupported note',
  );

  // The recovery create() used the selected model + getTemperatureForModel(model).
  assert.equal(secondArgs.model, 'gpt-x');
  assert.equal(secondArgs.temperature, getTemperatureForModel('gpt-x'));
  // And so did the first (pre-failure) call.
  assert.equal(state.args[0].model, 'gpt-x');
  assert.equal(state.args[0].temperature, getTemperatureForModel('gpt-x'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 11 ─ buildUploadUserContent: an unsupported note is APPENDED to an existing
//      trailing text item (joined with '\n\n'), not pushed as a separate item.
// ─────────────────────────────────────────────────────────────────────────────

test('buildUploadUserContent appends the unsupported-file note onto the SAME trailing text item (\\n\\n-joined)', () => {
  const prep = makePrep();
  const { userContent, unsupportedFiles } = prep.buildUploadUserContent({
    files: [makeFile('a.zip', 'application/zip')],
    message: 'hello',
    messageTag: 'auto',
  });

  // The trailing item is already a text item ('hello'), so the branch
  //   userContent[last].type !== 'text'  is false → NO new text item is pushed;
  // the note is concatenated onto that same item with '\n\n'.
  const texts = textItems(userContent);
  assert.equal(texts.length, 1, 'the note must fold into the existing text item, not add a second');
  assert.equal(imageItems(userContent).length, 0);
  assert.equal(userContent.length, 1);

  const merged = texts[0].text;
  assert.ok(merged.startsWith('hello'), 'the original message stays at the front');
  assert.ok(merged.includes('\n\n'), 'the note is joined onto the message with a blank line');
  assert.ok(merged.includes('not supported.'), 'the unsupported-file note is present');
  assert.equal(
    merged,
    'hello\n\nI uploaded a file named "a.zip" but it is in ZIP format which is not supported.',
  );

  assert.equal(unsupportedFiles.length, 1);
  assert.equal(unsupportedFiles[0].fileType, 'ZIP');
});

// ─────────────────────────────────────────────────────────────────────────────
// 12 ─ buildUploadMessages: the MIDDLEMAN filter converts an AVIF image_url in
//      userContent to a text note so NO avif image survives to the current turn.
// ─────────────────────────────────────────────────────────────────────────────

test('buildUploadMessages strips an AVIF image_url from userContent (converted to a text note, no avif image sent)', async () => {
  const prep = makePrep();

  // userContent already contains an AVIF image_url item (as if it slipped past
  // the per-file check). filterUnsupportedFiles must rewrite it to text.
  const userContent = [
    { type: 'text', text: 'stage it' },
    { type: 'image_url', image_url: { url: 'data:image/avif;base64,AAAA' } },
  ];

  const { safeMessages } = await prep.buildUploadMessages({
    systemInstruction: 'SYS',
    userContent,
    files: [],
    conversationHistory: [],
  });

  // The current user turn is the last message; it must carry NO image_url at all
  // (the lone avif was converted to text), and certainly no avif data URL.
  const current = safeMessages[safeMessages.length - 1];
  assert.equal(current.role, 'user');
  assert.equal(imageItems(current.content).length, 0, 'no image_url may survive the AVIF strip');
  assert.ok(
    current.content.every((i) => !(i.type === 'image_url' && String(i.image_url?.url).includes('avif'))),
    'no avif image_url may reach OpenAI',
  );
  // It was converted to an "…not supported." text note.
  assert.match(joinText(current.content), /not supported\./);
  assert.match(joinText(current.content), /AVIF format/);
  // The original text item is preserved.
  assert.match(joinText(current.content), /stage it/);
});
