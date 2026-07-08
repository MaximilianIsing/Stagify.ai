// Routing-decision helpers (lib/chat-routing.js). Pure, but they gate real work:
// parseDesignerRoutingCompletion must not throw on a model refusal, and
// aiResponseDefersImageAction decides whether a clarifying-question reply
// SUPPRESSES an (expensive) staging/generate/CAD action the model also set.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDesignerRoutingCompletion,
  aiResponseDefersImageAction,
  chatWillProcessSlowImages,
  chatIntentType,
} from '../lib/chat/chat-routing.js';

test('parseDesignerRoutingCompletion: parses JSON content, and degrades a refusal to a plain reply', () => {
  const parsed = parseDesignerRoutingCompletion({ choices: [{ message: { content: '{"response":"hi","staging":null}' } }] });
  assert.deepEqual(parsed, { response: 'hi', staging: null });

  const refused = parseDesignerRoutingCompletion({ choices: [{ message: { refusal: 'I can\'t help with that.' } }] });
  assert.deepEqual(refused, { response: 'I can\'t help with that.' }, 'a refusal surfaces as text, not a JSON.parse crash');
});

test('aiResponseDefersImageAction: true only when the reply asks a question instead of acting', () => {
  assert.equal(aiResponseDefersImageAction('Could you tell me what style you prefer?'), true);
  assert.equal(aiResponseDefersImageAction('What style would you like for this room?'), true);

  // A completion announcing a result is NOT a defer, even though it mentions the room.
  assert.equal(aiResponseDefersImageAction('Here is your staged room!'), false);
  assert.equal(aiResponseDefersImageAction("I've staged your room in a modern style."), false);

  // A defer phrase with no actual question mark does not defer.
  assert.equal(aiResponseDefersImageAction('Please provide more details.'), false);
  assert.equal(aiResponseDefersImageAction('Sure, staging it now.'), false);
  assert.equal(aiResponseDefersImageAction(''), false);
  assert.equal(aiResponseDefersImageAction(null), false);
});

test('chatWillProcessSlowImages: true when any staging/generate/CAD action is requested', () => {
  assert.equal(chatWillProcessSlowImages({ shouldStage: true }, null, null), true);
  assert.equal(chatWillProcessSlowImages(null, { shouldGenerate: true, prompt: 'x' }, null), true);
  assert.equal(chatWillProcessSlowImages(null, { shouldGenerate: true, prompt: '' }, null), false, 'generate needs a prompt');
  assert.equal(chatWillProcessSlowImages(null, null, [{ shouldProcessCAD: true }]), true);
  assert.equal(chatWillProcessSlowImages(null, null, null), false);
});

test('chatIntentType: CAD and staging map to "staging", generate to "generating", else "general"', () => {
  assert.equal(chatIntentType(null, null, { shouldProcessCAD: true }), 'staging');
  assert.equal(chatIntentType({ shouldStage: true }, null, null), 'staging');
  assert.equal(chatIntentType(null, { shouldGenerate: true }, null), 'generating');
  assert.equal(chatIntentType(null, null, null), 'general');
});
