// AI Designer system-instruction builders (lib/prompts.js). These are pure string
// builders; a regression (dropped context, missing JSON contract) is silent and
// degrades the model's behavior. We assert the caller-supplied context is embedded
// and the response contract is present — without pinning the exact prose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatSystemInstruction, buildChatUploadSystemInstruction } from '../lib/prompts.js';

test('buildChatSystemInstruction embeds image/date/base-selection context and the JSON contract', () => {
  const s = buildChatSystemInstruction({
    imageContext: '<<IMAGE_CTX>>',
    memories: [],
    dateContext: '<<DATE_CTX>>',
    baseSelectionContext: '<<BASE_SEL>>',
  });
  assert.match(s, /Stagify\.ai/);
  assert.ok(s.includes('<<IMAGE_CTX>>'), 'image context is embedded');
  assert.ok(s.includes('<<DATE_CTX>>'), 'date context is embedded');
  assert.ok(s.includes('<<BASE_SEL>>'), 'base-selection context is embedded');
  for (const key of ['"response"', '"memories"', '"staging"', '"generate"', '"cad"']) {
    assert.ok(s.includes(key), `the response contract mentions ${key}`);
  }
});

test('buildChatSystemInstruction lists memories only when present', () => {
  const withMem = buildChatSystemInstruction({
    imageContext: '',
    memories: [{ content: 'prefers Scandinavian style' }, { content: 'has a small apartment' }],
    dateContext: '',
    baseSelectionContext: '',
  });
  assert.match(withMem, /Important information to remember/);
  assert.ok(withMem.includes('1. prefers Scandinavian style'));
  assert.ok(withMem.includes('2. has a small apartment'));

  const noMem = buildChatSystemInstruction({ imageContext: '', memories: [], dateContext: '', baseSelectionContext: '' });
  assert.ok(!noMem.includes('Important information to remember'), 'no memory header when there are none');
});

test('buildChatUploadSystemInstruction embeds memories, identity, and the JSON contract', () => {
  const s = buildChatUploadSystemInstruction({ memories: [{ content: 'wants a cozy vibe' }], dateContext: '' });
  assert.match(s, /Stagify\.ai/);
  assert.ok(s.includes('1. wants a cozy vibe'), 'memory is listed');
  for (const key of ['"response"', '"memories"', '"staging"', '"generate"']) {
    assert.ok(s.includes(key), `the response contract mentions ${key}`);
  }
});
