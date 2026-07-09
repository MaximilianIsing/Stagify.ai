// Unit tests for the AI Designer i18n helpers extracted into
// public/scripts/ai-designer/i18n.js. getPdfAlt dereferences window.LanguageSystem
// bare (no try/catch), so a minimal window shim is installed before any call;
// lang() wraps its access in try/catch and tolerates a bare shim the same way.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { lang, getPdfAlt } from '../public/scripts/ai-designer/i18n.js';

beforeEach(() => {
  globalThis.window = {};
});

test('lang: returns the fallback when LanguageSystem is absent', () => {
  assert.equal(lang('pdf.retry', 'Retry'), 'Retry');
});

test('lang: returns the localized value when LanguageSystem is loaded', () => {
  globalThis.window.LanguageSystem = {
    isLoaded: () => true,
    getText: (key) => (key === 'pdf.retry' ? 'Réessayer' : key),
  };
  assert.equal(lang('pdf.retry', 'Retry'), 'Réessayer');
});

test('lang: ignores the "Loading..." placeholder and key echoes', () => {
  globalThis.window.LanguageSystem = { isLoaded: () => true, getText: () => 'Loading...' };
  assert.equal(lang('pdf.stop', 'Stop generating'), 'Stop generating');
  globalThis.window.LanguageSystem = { isLoaded: () => true, getText: (key) => key };
  assert.equal(lang('pdf.stop', 'Stop generating'), 'Stop generating');
});

test('lang: swallows a throwing LanguageSystem and falls back', () => {
  globalThis.window.LanguageSystem = {
    isLoaded: () => true,
    getText: () => { throw new Error('boom'); },
  };
  assert.equal(lang('pdf.retry', 'Retry'), 'Retry');
});

test('getPdfAlt: serves the built-in fallback map when LanguageSystem is absent', () => {
  assert.equal(getPdfAlt('sendMessage'), 'Send message');
  assert.equal(getPdfAlt('assistantAvatar'), 'Stagify AI Designer');
  assert.equal(getPdfAlt('nonexistent-key'), '');
});

test('getPdfAlt: interpolates {placeholder} replacements', () => {
  assert.equal(
    getPdfAlt('uploadPreview', { filename: 'room.png' }),
    'Preview of uploaded file: room.png'
  );
  assert.equal(getPdfAlt('stagedRoom', { suffix: ' (2)' }), 'AI-staged room (2)');
  assert.equal(
    getPdfAlt('thumbnailOption', { label: 'Kitchen', index: 3 }),
    'Kitchen — image 3 in conversation'
  );
});

test('getPdfAlt: null/undefined replacement values become empty strings', () => {
  assert.equal(getPdfAlt('stagedRoom', { suffix: null }), 'AI-staged room');
  assert.equal(getPdfAlt('generatedImage', { suffix: undefined }), 'AI-generated design image');
});

test('getPdfAlt: prefers the localized text and still interpolates into it', () => {
  globalThis.window.LanguageSystem = {
    isLoaded: () => true,
    getText: (key) => (key === 'pdf.alt.uploadPreview' ? 'Aperçu : {filename}' : ''),
  };
  assert.equal(getPdfAlt('uploadPreview', { filename: 'a.jpg' }), 'Aperçu : a.jpg');
  // Empty localized text falls through to the fallback map.
  assert.equal(getPdfAlt('sendMessage'), 'Send message');
});
