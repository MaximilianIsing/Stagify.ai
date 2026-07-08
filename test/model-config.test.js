// Model-selection maps (lib/model-config.js). Pure input→output — a wrong mapping
// silently picks the wrong model or an unsupported temperature.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTemperatureForModel, getGeminiImageModel } from '../lib/config/model-config.js';

test('getTemperatureForModel: gpt-5 models must use temperature 1, others 0.7', () => {
  assert.equal(getTemperatureForModel('gpt-5-mini'), 1);
  assert.equal(getTemperatureForModel('gpt-5'), 1);
  assert.equal(getTemperatureForModel('gpt-4o-mini'), 0.7);
  assert.equal(getTemperatureForModel('gemini-2.5-flash'), 0.7);
  assert.equal(getTemperatureForModel(undefined), 0.7);
  assert.equal(getTemperatureForModel(null), 0.7);
  assert.equal(getTemperatureForModel(''), 0.7);
});

test('getGeminiImageModel: gpt-5 → 3.1-flash-image (Stagify+), else 2.5-flash-image', () => {
  assert.equal(getGeminiImageModel('gpt-5-mini'), 'gemini-3.1-flash-image');
  assert.equal(getGeminiImageModel('gpt-4o-mini'), 'gemini-2.5-flash-image');
  assert.equal(getGeminiImageModel(undefined), 'gemini-2.5-flash-image');
  assert.equal(getGeminiImageModel(null), 'gemini-2.5-flash-image');
  assert.equal(getGeminiImageModel(''), 'gemini-2.5-flash-image');
});
