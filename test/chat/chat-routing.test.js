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
} from '../../lib/chat/chat-routing.js';

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

test('chatIntentType: CAD gets its OWN category, staging/generate keep theirs, else "general"', () => {
  // CAD used to borrow 'staging', so a ~30s gemini-3-pro-image render announced itself as
  // "staging your room…". It is also checked FIRST: a turn doing both reports the
  // floor-plan work, because that is the half the user is actually waiting on.
  assert.equal(chatIntentType(null, null, { shouldProcessCAD: true }), 'floorplan');
  assert.equal(chatIntentType({ shouldStage: true }, null, { shouldProcessCAD: true }), 'floorplan');
  assert.equal(chatIntentType({ shouldStage: true }, null, null), 'staging');
  assert.equal(chatIntentType(null, { shouldGenerate: true }, null), 'generating');
  assert.equal(chatIntentType(null, null, null), 'general');
});

test('aiResponseDefersImageAction: the disclosure question defers, but only when it is the whole turn', () => {
  // The "Virtually staged" label is decided in conversation, so the assistant asks about it
  // when a request is listing-bound but silent on disclosure. None of the original defer
  // patterns reach that question — they are all about style, colour, or which image — so
  // without this the suppression would let a model ask AND stage in the same turn, billing
  // a render for the very thing it was asking permission for.
  assert.equal(
    aiResponseDefersImageAction('Before I stage it — would you like me to add the "Virtually staged" label to the photo?'),
    true,
  );
  assert.equal(
    aiResponseDefersImageAction('Most MLSs expect a disclosure. Shall I add the virtually staged label?'),
    true,
  );
  assert.equal(
    aiResponseDefersImageAction('Do you want me to label it as virtually staged?'),
    true,
  );

  // THE OTHER DIRECTION, and the one that costs a working feature if it breaks: offering
  // the label AFTER doing the work is an ACTION turn. Suppressing it would throw away the
  // render the user just asked for, every time the assistant is helpful about disclosure.
  assert.equal(
    aiResponseDefersImageAction("I've staged your living room. Would you like me to add the \"Virtually staged\" label too?"),
    false,
  );
  assert.equal(
    aiResponseDefersImageAction('Here is your staged room — want the virtually staged label on it?'),
    false,
  );

  // And a statement about the label is not a question about it.
  assert.equal(
    aiResponseDefersImageAction('I added the "Virtually staged" label to the bottom-right corner.'),
    false,
  );
});
