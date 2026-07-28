// Tier: unit (no server) — lib/chat/chat-upload-context.js.
//
// WHAT THIS COVERS
// How the multipart endpoint reconstructs what the JSON endpoint gets for free.
// Three non-obvious rules live here:
//   - a malformed conversationHistory field degrades to an empty history instead
//     of failing the request (the upload itself is still worth answering);
//   - the image context is built from the history BEFORE this upload — the client
//     echoes the pending turn back, and counting it would shift every image index
//     the model is told about;
//   - the system instruction is assembled in a fixed order (base → image context →
//     base-image selection → sole-upload note); the model reads the later sections
//     as overriding, so the order is behaviour, not formatting.
// Also pins the deliberately asymmetric blank-message defaulting in
// applyDefaultUserContentText (one branch trims, the other does not).

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseConversationHistory,
  buildUploadContext,
  appendSoleUploadNote,
  applyDefaultUserContentText,
  SOLE_UPLOAD_NOTE,
} from '../../lib/chat/chat-upload-context.js';
import { logger } from '../../lib/logger.js';

const origError = logger.error;
afterEach(() => { logger.error = origError; });

const file = (originalname) => ({ originalname, mimetype: 'image/png', buffer: Buffer.from('x') });
const userImageTurn = (filename) => ({
  role: 'user',
  content: [{ type: 'image_url', filename, image_url: { url: 'data:image/png;base64,AAA' } }],
});

// ── parseConversationHistory ────────────────────────────────────────────────
test('parses a JSON string field', () => {
  assert.deepEqual(parseConversationHistory('[{"role":"user","content":"hi"}]'), [
    { role: 'user', content: 'hi' },
  ]);
});

test('passes an already-parsed array through untouched', () => {
  const arr = [{ role: 'user', content: 'hi' }];
  assert.equal(parseConversationHistory(arr), arr);
});

test('missing/empty field yields an empty history', () => {
  assert.deepEqual(parseConversationHistory(undefined), []);
  assert.deepEqual(parseConversationHistory(''), []);
});

test('malformed JSON is logged and degrades to an empty history, not a thrown request', () => {
  /** @type {any[][]} */
  const logged = [];
  logger.error = (...args) => { logged.push(args); };

  assert.deepEqual(parseConversationHistory('{not json'), []);
  assert.equal(logged.length, 1);
  assert.match(logged[0][0], /conversation history/i);
});

// ── buildUploadContext ──────────────────────────────────────────────────────
test('excludes the turn the client echoed back for THIS upload from the image context', () => {
  const conversationHistory = [userImageTurn('old-room.png'), userImageTurn('sofa.png')];

  const out = buildUploadContext({
    memories: [],
    files: [file('sofa.png')],
    conversationHistory,
    baseImageIndex: null,
    debugMode: false,
  });

  assert.deepEqual(out.historyForImageContext, [conversationHistory[0]], 'the pending turn is dropped');
  assert.match(out.imageContext, /old-room\.png/);
  assert.doesNotMatch(out.imageContext, /sofa\.png/);
});

test('a history that does not duplicate the upload is kept whole', () => {
  const conversationHistory = [userImageTurn('old-room.png')];
  const out = buildUploadContext({
    memories: [],
    files: [file('sofa.png')],
    conversationHistory,
    baseImageIndex: null,
    debugMode: false,
  });
  assert.deepEqual(out.historyForImageContext, conversationHistory);
});

test('the instruction is assembled base → image context → base-image selection', () => {
  const conversationHistory = [userImageTurn('old-room.png')];

  const withNothing = buildUploadContext({
    memories: [], files: [], conversationHistory: [], baseImageIndex: null, debugMode: false,
  });
  const withContext = buildUploadContext({
    memories: [], files: [], conversationHistory, baseImageIndex: 0, debugMode: false,
  });

  assert.equal(withContext.systemInstruction.startsWith(withNothing.systemInstruction), true,
    'the base prompt still leads');
  const ctxAt = withContext.systemInstruction.indexOf(withContext.imageContext);
  const selAt = withContext.systemInstruction.indexOf('USER UI SELECTION');
  assert.ok(ctxAt > 0, 'the image context is folded in');
  assert.ok(selAt > ctxAt, 'the UI selection is appended after the image context');
});

test('an empty image context is not concatenated (no stray blank section)', () => {
  const out = buildUploadContext({
    memories: [], files: [], conversationHistory: [], baseImageIndex: null, debugMode: false,
  });
  assert.equal(out.imageContext, '');
  assert.equal(out.systemInstruction.includes('undefined'), false);
});

test('debugMode:true dumps the image context under the CHAT-UPLOAD banner', () => {
  const origDebug = logger.debug;
  /** @type {any[][]} */
  const logged = [];
  logger.debug = (...args) => { logged.push(args); };
  try {
    buildUploadContext({
      memories: [],
      files: [],
      conversationHistory: [userImageTurn('old-room.png')],
      baseImageIndex: null,
      debugMode: true,
    });
  } finally {
    logger.debug = origDebug;
  }
  assert.equal(logged[0][0], '=== IMAGE CONTEXT SENT TO AI (CHAT-UPLOAD) ===');
});

// ── appendSoleUploadNote ────────────────────────────────────────────────────
test('the sole-upload note is added only when this upload has the conversation\'s only images', () => {
  const base = 'INSTRUCTION';
  assert.equal(
    appendSoleUploadNote({ systemInstruction: base, hasImages: true, historyForImageContext: [] }),
    base + SOLE_UPLOAD_NOTE,
  );
  assert.equal(
    appendSoleUploadNote({ systemInstruction: base, hasImages: false, historyForImageContext: [] }),
    base,
    'a text-only upload gets no note',
  );
  assert.equal(
    appendSoleUploadNote({
      systemInstruction: base,
      hasImages: true,
      historyForImageContext: [userImageTurn('old-room.png')],
    }),
    base,
    'history already has an image, so "first or second?" is a fair question',
  );
});

// ── applyDefaultUserContentText ─────────────────────────────────────────────
test('empty content with no unsupported files gets the generic analyze prompt', () => {
  const userContent = [];
  applyDefaultUserContentText({ userContent, message: '', unsupportedFiles: [] });
  assert.deepEqual(userContent, [{ type: 'text', text: 'Please analyze these files.' }]);
});

test('unsupported files with no message get an acknowledgement, pluralized', () => {
  const one = [];
  applyDefaultUserContentText({ userContent: one, message: '', unsupportedFiles: [{ name: 'a.avif', type: 'image/avif' }] });
  assert.match(one[0].text, /a file but it is in an unsupported format/);

  const many = [];
  applyDefaultUserContentText({
    userContent: many,
    message: '   ',
    unsupportedFiles: [{ name: 'a.avif', type: 'image/avif' }, { name: 'b.avif', type: 'image/avif' }],
  });
  assert.match(many[0].text, /some files but they are in an unsupported format/);
});

test('a real user message suppresses the unsupported-file acknowledgement', () => {
  const userContent = [{ type: 'text', text: 'what is this?' }];
  applyDefaultUserContentText({ userContent, message: 'what is this?', unsupportedFiles: [{ name: 'a.avif', type: 'image/avif' }] });
  assert.deepEqual(userContent, [{ type: 'text', text: 'what is this?' }]);
});

test('existing non-blank content is never prefixed', () => {
  const userContent = [{ type: 'text', text: 'stage this' }, { type: 'image_url' }];
  applyDefaultUserContentText({ userContent, message: 'stage this', unsupportedFiles: [] });
  assert.equal(userContent.length, 2);
  assert.equal(userContent[0].text, 'stage this');
});

test('the two branches trim differently — asymmetry inherited verbatim', () => {
  // Whitespace-only lone text item: the unsupported-files branch trims (so it
  // counts as blank and IS replaced)…
  const withUnsupported = [{ type: 'text', text: '   ' }];
  applyDefaultUserContentText({
    userContent: withUnsupported,
    message: '',
    unsupportedFiles: [{ name: 'a.avif', type: 'image/avif' }],
  });
  assert.equal(withUnsupported.length, 2, 'prepended');

  // …while the no-unsupported-files branch does not trim, so the same item is
  // treated as real content and left alone.
  const withoutUnsupported = [{ type: 'text', text: '   ' }];
  applyDefaultUserContentText({ userContent: withoutUnsupported, message: '', unsupportedFiles: [] });
  assert.equal(withoutUnsupported.length, 1, 'untouched');
});

test('an image-only upload is left alone (it is not "no content")', () => {
  const userContent = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }];
  applyDefaultUserContentText({ userContent, message: '', unsupportedFiles: [] });
  assert.equal(userContent.length, 1);
});
