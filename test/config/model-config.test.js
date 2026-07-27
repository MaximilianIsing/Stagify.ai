// Model-selection maps (lib/model-config.js). Pure input→output — a wrong mapping
// silently picks the wrong model or an unsupported temperature.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTemperatureForModel, getGeminiImageModel, resolveChatModel } from '../../lib/config/model-config.js';

test('getTemperatureForModel: gpt-5 models must use temperature 1, others 0.7', () => {
  assert.equal(getTemperatureForModel('gpt-5-mini'), 1);
  assert.equal(getTemperatureForModel('gpt-5'), 1);
  assert.equal(getTemperatureForModel('gpt-4o-mini'), 0.7);
  assert.equal(getTemperatureForModel('gemini-2.5-flash'), 0.7);
  assert.equal(getTemperatureForModel(undefined), 0.7);
  assert.equal(getTemperatureForModel(null), 0.7);
  assert.equal(getTemperatureForModel(''), 0.7);
});

// The allow-list is a spend control: `model` comes off the request body and is
// forwarded to OpenAI, so anything that escapes this function bills an arbitrary
// model to our API key. Every branch below is a way that could happen.
test('resolveChatModel: only the two allow-listed ids survive for a pro account', () => {
  assert.equal(resolveChatModel('gpt-4o-mini', { isPro: true }), 'gpt-4o-mini');
  assert.equal(resolveChatModel('gpt-5-mini', { isPro: true }), 'gpt-5-mini');
});

test('resolveChatModel: anything else degrades to the fast model, never passes through', () => {
  for (const attack of ['o1-pro', 'gpt-4.5-preview', 'gpt-5', 'GPT-5-MINI', 'gpt-4o-mini ', '']) {
    assert.equal(resolveChatModel(attack, { isPro: true }), 'gpt-4o-mini', `leaked: ${attack}`);
  }
});

test('resolveChatModel: non-string models (objects, arrays, null) cannot slip through', () => {
  for (const junk of [undefined, null, 0, {}, [], ['gpt-5-mini'], { toString: () => 'gpt-5-mini' }]) {
    assert.equal(resolveChatModel(junk, { isPro: true }), 'gpt-4o-mini');
  }
});

test('resolveChatModel: a non-pro account is pinned to the fast model, and isPro defaults to false', () => {
  assert.equal(resolveChatModel('gpt-5-mini', { isPro: false }), 'gpt-4o-mini');
  assert.equal(resolveChatModel('gpt-5-mini'), 'gpt-4o-mini');
  assert.equal(resolveChatModel('gpt-5-mini', {}), 'gpt-4o-mini');
});

test('getGeminiImageModel: gpt-5 → 3.1-flash-image (Stagify+), else 2.5-flash-image', () => {
  assert.equal(getGeminiImageModel('gpt-5-mini'), 'gemini-3.1-flash-image');
  assert.equal(getGeminiImageModel('gpt-4o-mini'), 'gemini-2.5-flash-image');
  assert.equal(getGeminiImageModel(undefined), 'gemini-2.5-flash-image');
  assert.equal(getGeminiImageModel(null), 'gemini-2.5-flash-image');
  assert.equal(getGeminiImageModel(''), 'gemini-2.5-flash-image');
});
