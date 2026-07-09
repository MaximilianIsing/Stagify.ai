// GPT-vision annotation (lib/image/image-annotation.js). It asks GPT for a short
// description + a CAD/blueprint classification, then normalizes the reply into a single
// "<desc> CAD: True|False" string. The parsing has three branches — model returned a CAD
// line, model omitted it (fall back to the caller's isCAD), and the prompt itself changes
// with isCAD/detectBlueprint — plus a fail-OPEN to null on any error. A fake OpenAI client
// (never a real call, no cost) returns scripted content and captures the prompt we sent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImageAnnotation } from '../lib/image/image-annotation.js';

// A genuinely-decodable 1x1 PNG data URL. annotateImage runs it through the real
// downscaleImageForGPT first; a ≤1024px image is passed through untouched.
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// A fake OpenAI whose chat.completions.create returns scripted content (or throws) and
// records each payload so we can assert which prompt variant was sent.
function fakeOpenAI(content) {
  const calls = [];
  const client = {
    chat: {
      completions: {
        create: async (payload) => {
          calls.push(payload);
          if (content instanceof Error) throw content;
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
  return { client, calls };
}
const promptText = (payload) => payload.messages[0].content[0].text;

test('no OpenAI client → returns null without attempting a call', async () => {
  const { annotateImage } = createImageAnnotation({ openai: null });
  assert.equal(await annotateImage(TINY_PNG), null);
});

test('parses a "CAD: False" reply into a normalized "<desc> CAD: False"', async () => {
  const { client } = fakeOpenAI('Cozy living room with a sofa\nCAD: False');
  const { annotateImage } = createImageAnnotation({ openai: client });
  const out = await annotateImage(TINY_PNG, false, true);
  assert.equal(out, 'Cozy living room with a sofa CAD: False');
});

test('parses a "CAD: True" reply (blueprint) and strips a trailing period', async () => {
  const { client } = fakeOpenAI('Top-down architectural floor plan\nCAD: True.');
  const { annotateImage } = createImageAnnotation({ openai: client });
  const out = await annotateImage(TINY_PNG, false, true);
  assert.equal(out, 'Top-down architectural floor plan CAD: True');
});

test('detectBlueprint=true asks GPT to classify CAD True/False; explicit isCAD/plain-staged pin the verdict in the prompt', async () => {
  const detect = fakeOpenAI('desc\nCAD: False');
  await createImageAnnotation({ openai: detect.client }).annotateImage(TINY_PNG, false, true);
  assert.match(promptText(detect.calls[0]), /"CAD: True" if this is a blueprint/, 'detect mode asks the model to decide');

  const forced = fakeOpenAI('desc\nCAD: True');
  await createImageAnnotation({ openai: forced.client }).annotateImage(TINY_PNG, true, false);
  assert.match(promptText(forced.calls[0]), /answer: "CAD: True"\.$/, 'isCAD=true hard-codes CAD: True in the prompt');

  const staged = fakeOpenAI('desc\nCAD: False');
  await createImageAnnotation({ openai: staged.client }).annotateImage(TINY_PNG, false, false);
  assert.match(promptText(staged.calls[0]), /answer: "CAD: False"\.$/, 'non-detect staged image hard-codes CAD: False');
});

test('model omits the CAD line → fall back to the caller-supplied isCAD', async () => {
  const yes = fakeOpenAI('A blurry room, no verdict given');
  assert.equal(
    await createImageAnnotation({ openai: yes.client }).annotateImage(TINY_PNG, true, false),
    'A blurry room, no verdict given CAD: True',
  );
  const no = fakeOpenAI('A blurry room, no verdict given');
  assert.equal(
    await createImageAnnotation({ openai: no.client }).annotateImage(TINY_PNG, false, false),
    'A blurry room, no verdict given CAD: False',
  );
});

test('a thrown API error fails open to null (never blocks the pipeline)', async () => {
  const { client } = fakeOpenAI(new Error('429 rate limited'));
  const { annotateImage } = createImageAnnotation({ openai: client });
  assert.equal(await annotateImage(TINY_PNG, false, true), null);
});
