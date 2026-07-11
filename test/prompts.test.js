// AI Designer system-instruction builders (lib/prompts.js). These are pure string
// builders; a regression (dropped context, missing JSON contract) is silent and
// degrades the model's behavior. We assert the caller-supplied context is embedded
// and the response contract is present — without pinning the exact prose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChatSystemInstruction,
  buildChatUploadSystemInstruction,
  buildWelcomeMessagePrompt,
  generatePrompt,
  qualityRetryFeedbackSuffix,
  styleReferencePromptSuffix,
  maskReferencePromptSuffix,
  furnitureReferencePromptSuffix,
} from '../lib/staging/prompts.js';

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

// --- buildWelcomeMessagePrompt: folds stored memories into a numbered list ---

test('buildWelcomeMessagePrompt with no memories omits the user-information block', () => {
  const s = buildWelcomeMessagePrompt();
  assert.match(s, /returning user of Stagify AI Designer/);
  assert.ok(!s.includes('User information:'), 'no memory block when there are none');
});

test('buildWelcomeMessagePrompt numbers each stored memory', () => {
  const s = buildWelcomeMessagePrompt([{ content: 'likes minimalism' }, { content: 'has two cats' }]);
  assert.match(s, /User information:/);
  assert.ok(s.includes('1. likes minimalism'));
  assert.ok(s.includes('2. has two cats'));
});

// --- generatePrompt: room-type + style matrix with keep/remove-furniture branches ---

test('generatePrompt keeps existing furniture by default and preserves architecture', () => {
  const p = generatePrompt('Bedroom', 'standard', '', false);
  assert.match(p, /KEEP EXISTING FURNITURE/);
  assert.match(p, /PRESERVE THE ARCHITECTURE EXACTLY/);
  assert.ok(!p.includes('remove all existing furniture'), 'does not instruct removal when keeping');
});

test('generatePrompt removes furniture first when removeFurniture is set (boolean or "true")', () => {
  for (const flag of [true, 'true']) {
    const p = generatePrompt('Living room', 'standard', '', flag);
    assert.match(p, /remove all existing furniture and decor/i);
    assert.ok(!p.includes('KEEP EXISTING FURNITURE'), `flag=${JSON.stringify(flag)} keeps nothing`);
  }
});

test('generatePrompt uses the additionalPrompt as the base for a custom style', () => {
  const p = generatePrompt('Office', 'custom', '  a Bauhaus reading nook  ', false);
  assert.ok(p.includes('a Bauhaus reading nook'), 'custom style promotes the additional prompt');
});

test('generatePrompt appends non-custom additional details as a priority suffix', () => {
  const p = generatePrompt('Kitchen', 'standard', 'add a green island', false);
  assert.match(p, /Prioritize the following above everything else: add a green island/);
});

// --- qualityRetryFeedbackSuffix: turn a QA verdict into a corrective suffix ---

test('qualityRetryFeedbackSuffix is empty for a missing or passing review', () => {
  assert.equal(qualityRetryFeedbackSuffix(null), '');
  assert.equal(qualityRetryFeedbackSuffix({ perfect: true }), '');
});

test('qualityRetryFeedbackSuffix lifts the named defect out of the WHY: line', () => {
  const s = qualityRetryFeedbackSuffix({ perfect: false, reason: 'PERFECT: false\nWHY: the sofa has three arms' });
  assert.match(s, /REVISION NEEDED/);
  assert.ok(s.includes('the sofa has three arms'), 'the specific defect is quoted back');
});

test('qualityRetryFeedbackSuffix falls back to a generic nudge when no WHY: line is present', () => {
  const s = qualityRetryFeedbackSuffix({ perfect: false, reason: 'PERFECT: false' });
  assert.match(s, /a visible quality defect/);
});

// --- styleReferencePromptSuffix: singular vs. plural reference wording ---

test('styleReferencePromptSuffix is empty when there are no reference images', () => {
  assert.equal(styleReferencePromptSuffix(0), '');
  assert.equal(styleReferencePromptSuffix(-1), '');
});

test('styleReferencePromptSuffix distinguishes one reference from many', () => {
  assert.match(styleReferencePromptSuffix(1), /The second image is/);
  assert.match(styleReferencePromptSuffix(3), /The additional images after the room photo are/);
  assert.match(styleReferencePromptSuffix(1), /STYLE REFERENCE/);
});

// --- maskReferencePromptSuffix: constant guidance for the mask-edit reference ---

test('maskReferencePromptSuffix describes the trailing reference image', () => {
  const s = maskReferencePromptSuffix();
  assert.match(s, /REFERENCE IMAGE/);
  assert.match(s, /masked region/);
});

// --- furnitureReferencePromptSuffix: enumerate the reference ordinals (joinOrdinals) ---

test('furnitureReferencePromptSuffix is empty when there are no reference images', () => {
  assert.equal(furnitureReferencePromptSuffix(0), '');
});

test('furnitureReferencePromptSuffix uses singular wording for one reference', () => {
  const s = furnitureReferencePromptSuffix(1);
  assert.match(s, /The second image/);
  assert.match(s, /reference furniture piece\b/);
});

test('furnitureReferencePromptSuffix joins multiple ordinals with an Oxford comma', () => {
  const s = furnitureReferencePromptSuffix(3);
  assert.match(s, /The second, third, and fourth images/);
  assert.match(s, /reference furniture pieces\b/);
});

test('furnitureReferencePromptSuffix adds the preserve-existing-staging clause when asked', () => {
  const kept = furnitureReferencePromptSuffix(2, true);
  assert.match(kept, /ALREADY-STAGED ROOM/);
  const fresh = furnitureReferencePromptSuffix(2, false);
  assert.ok(!fresh.includes('ALREADY-STAGED ROOM'), 'no preserve clause without the flag');
});
