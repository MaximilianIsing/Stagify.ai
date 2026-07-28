// Tier: unit (no server) — lib/chat/chat-image-context-log.js.
//
// WHAT THIS COVERS
// The DEBUG-only banner both chat endpoints print around the image context. The
// closing rule is DERIVED (one '=' wider than the header) rather than passed in,
// so these tests pin the exact four strings the two endpoints used to emit
// literally — if the derivation ever drifts, the operator-facing output changes
// and this fails. Also pins the debugMode gate: this must be a no-op in
// production, not merely quieter.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { logImageContextDebug } from '../../lib/chat/chat-image-context-log.js';
import { logger } from '../../lib/logger.js';

const origDebug = logger.debug;
/** @type {any[][]} */
let logged = [];
function capture() {
  logged = [];
  logger.debug = (...args) => { logged.push(args); };
}
afterEach(() => { logger.debug = origDebug; });

test('/api/chat emits the exact banner the handler used to inline', () => {
  capture();
  logImageContextDebug({ imageContext: 'IMAGE 1: a sofa', label: 'CHAT', debugMode: true });

  assert.deepEqual(logged.map((args) => args[0]), [
    '=== IMAGE CONTEXT SENT TO AI (CHAT) ===',
    'IMAGE 1: a sofa',
    '========================================',
  ]);
});

test('/api/chat-upload emits the exact (wider) banner the handler used to inline', () => {
  capture();
  logImageContextDebug({ imageContext: 'IMAGE 1: a sofa', label: 'CHAT-UPLOAD', debugMode: true });

  assert.deepEqual(logged.map((args) => args[0]), [
    '=== IMAGE CONTEXT SENT TO AI (CHAT-UPLOAD) ===',
    'IMAGE 1: a sofa',
    '===============================================',
  ]);
});

test('the closing rule is exactly one character wider than the header', () => {
  capture();
  logImageContextDebug({ imageContext: 'x', label: 'ANYTHING-ELSE', debugMode: true });
  const [header, , footer] = logged.map((args) => args[0]);
  assert.equal(footer.length, header.length + 1);
  assert.match(footer, /^=+$/);
});

test('an empty image context logs the "no images" line instead of the banner', () => {
  capture();
  logImageContextDebug({ imageContext: '', label: 'CHAT', debugMode: true });
  assert.deepEqual(logged, [['[Image Context] No images in conversation history']]);
});

test('debugMode:false is a no-op — nothing is logged at all', () => {
  capture();
  logImageContextDebug({ imageContext: 'IMAGE 1: a sofa', label: 'CHAT', debugMode: false });
  logImageContextDebug({ imageContext: '', label: 'CHAT-UPLOAD', debugMode: false });
  assert.deepEqual(logged, []);
});
