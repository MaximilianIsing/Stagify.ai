// The AI Designer's "Label as virtually staged" contract: the routing-schema field the
// model fills in, the prose that tells it when to, and the consumer that reads it.
//
// WHY THIS FILE EXISTS AT ALL
// On the four checkbox surfaces the disclosure is wired to a control you can see: if it
// stops working, the box is there and the badge is not, and someone notices. Here the
// entire feature is a schema field plus some paragraphs of English, and EVERY failure mode
// is silent — the model emits a field nobody reads, or reads a style nobody can render, or
// the prose and the schema quietly stop describing the same thing. Nothing throws, the
// render succeeds, and the photo goes out undisclosed.
//
// So these are drift guards rather than behaviour tests, and each one pins two things that
// must agree to each other rather than to a copy in the test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DESIGNER_ROUTING_SCHEMA, buildChatSystemInstruction, buildChatUploadSystemInstruction,
} from '../../lib/staging/prompts.js';
import { DISCLOSURE_ROUTING_FIELD } from '../../lib/staging/disclosure-rules.js';
import { STAMP_STYLE_NAMES, STAMP_SCALE_MIN, STAMP_SCALE_MAX } from '../../lib/image/stamp-disclosure.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const stagingItem = DESIGNER_ROUTING_SCHEMA.properties.staging.items;
/** The object half of the nullable `disclosure` field. */
const disclosureObject = DISCLOSURE_ROUTING_FIELD.anyOf.find((v) => v.type === 'object');

const CONTEXT = {
  imageContext: '', currentDate: 'August 11, 2026', hasBaseSelection: false, memories: [],
};

// ---- the schema field ------------------------------------------------------

test('DRIFT GUARD: the schema offers exactly the badge styles the renderer can draw', () => {
  // The styles are pre-rendered PNG masters on disk, so this is not a cosmetic list: a
  // style the model can emit but stamp-disclosure.js cannot render is a THROWN render —
  // and because the stamp fails closed, a paid staging that never reaches the user. The
  // enum is spelled out in disclosure-rules.js rather than imported, because importing it
  // would pull sharp into every prompt build; this test is the price of that.
  assert.deepEqual(
    [...disclosureObject.properties.style.enum].sort(),
    [...STAMP_STYLE_NAMES].sort(),
    'the routing schema and the badge renderer disagree about which styles exist',
  );
});

test('the scale the model is told about is the range the server actually accepts', () => {
  // Advertising a wider range than clampStampScale allows would have the model confidently
  // asking for a size it silently does not get — the user asks for "much bigger" twice and
  // gets the same photo back.
  const described = disclosureObject.properties.scale.description;
  assert.match(described, new RegExp(String(STAMP_SCALE_MIN)));
  assert.match(described, new RegExp(String(STAMP_SCALE_MAX)));
});

test('disclosure is nullable, and its style/size live INSIDE the object', () => {
  // The shape is the product decision. `null` is the whole "no label" answer, so there is
  // no separate boolean to disagree with the style — and no way to express a size for a
  // badge that was never asked for.
  assert.ok(
    DISCLOSURE_ROUTING_FIELD.anyOf.some((v) => v.type === 'null'),
    'null must be a valid disclosure — it is how the model says "no label"',
  );
  assert.deepEqual(Object.keys(disclosureObject.properties).sort(), ['scale', 'style']);
  assert.deepEqual([...disclosureObject.required].sort(), ['scale', 'style']);
  assert.equal(disclosureObject.additionalProperties, false);
});

test('disclosure is in `required` — a strict schema rejects the whole response otherwise', () => {
  // `strict: true` on the response format means every property must be listed in
  // `required`. Miss this and the API rejects the schema outright, which is at least loud
  // — but it is also the one mistake that makes the field look optional to a reader.
  assert.ok(
    stagingItem.required.includes('disclosure'),
    'every property of a strict schema must be required',
  );
  assert.deepEqual(
    [...stagingItem.required].sort(), Object.keys(stagingItem.properties).sort(),
    'strict mode: the required list and the property list must match exactly',
  );
});

// ---- the consumer ----------------------------------------------------------

test('DRIFT GUARD: every staging field the schema defines is READ by chat-staging.js', () => {
  // THE HOLE THIS CLOSES, and it is the one that would have swallowed this whole feature.
  // The schema decides what the model may emit; lib/chat/chat-staging.js is the only place
  // that turns it into staging params. Nothing connects the two. A field can be added to
  // the schema, documented in both system instructions, emitted correctly by the model on
  // every turn — and dropped on the floor, with the full suite green, because the params
  // builder never mentions it. There is no error and no warning: the user asks for a
  // disclosure, pays for the render, and gets an unlabelled photo.
  const source = read('lib/chat/chat-staging.js')
    // Strip comments first, or a field named only in a nearby explanation counts as read.
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // Matched as a property access on ANY identifier rather than on `stagingRequest`
  // specifically: `shouldStage` is legitimately read off the raw array element while the
  // list is being filtered, before the per-request variable exists. Pinning the variable
  // name would make this guard a style rule about one function instead of a statement
  // about whether the field is used at all.
  for (const field of Object.keys(stagingItem.properties)) {
    assert.match(
      source, new RegExp(`\\.${field}\\b`),
      `the routing schema offers "${field}" but chat-staging.js never reads it — the model `
      + 'can set it on every turn and it will do nothing',
    );
  }
});

test('the badge language is NOT the model\'s to choose', () => {
  // It follows the site language, which only the browser knows. If it ever appeared in the
  // routing schema the model would start picking a disclosure language from the room photo
  // or from its own reply, and a Spanish agent would get English badges when they happened
  // to type in English.
  assert.ok(!('lang' in disclosureObject.properties));
  assert.ok(!('stampLang' in stagingItem.properties));
  assert.match(read('lib/chat/chat-staging.js'), /body\?\.stampLang/, 'it comes off the request');
});

// ---- the prose -------------------------------------------------------------

for (const [name, build] of [
  ['buildChatSystemInstruction', buildChatSystemInstruction],
  ['buildChatUploadSystemInstruction', buildChatUploadSystemInstruction],
]) {
  test(`${name} carries the disclosure contract AND the rules`, () => {
    // Both endpoints stage, so both need this. They are near-duplicate hand-concatenated
    // strings, which is exactly the shape that gets updated in one place and not the
    // other — /api/chat would ask about the MLS and /api/chat-upload would not, for
    // reasons no one could see.
    const s = build(CONTEXT);
    assert.match(s, /"disclosure"/, 'the JSON contract must name the field');
    assert.match(s, /VIRTUALLY STAGED" LABEL/, 'the rules block must be included');
    assert.match(s, /DEFAULT IS NULL/, 'the default must be stated, not implied');
    assert.match(s, /ASK FIRST/, 'the ask-on-publishing-cues rule');
    assert.match(s, /MLS/, 'the cue itself, by name');
    assert.match(s, /Do NOT put this preference in "memories"/, 'per-conversation, not per-account');
    // Every style the schema allows has to be described, or the model can only reach the
    // ones that happen to be documented.
    for (const style of STAMP_STYLE_NAMES) assert.match(s, new RegExp(`"${style}"`));
  });
}

test('the rules do not contradict the RESPONSE vs ACTION rule they rely on', () => {
  // The ask branch needs no new machinery precisely because asking and staging are already
  // mutually exclusive: the model writes questions only and sets shouldStage false. If
  // that rule ever leaves the instruction, "ask about the label" silently becomes "ask
  // about the label AND stage it anyway", which bills a render for a question.
  const s = buildChatSystemInstruction(CONTEXT);
  assert.match(s, /Never ask clarifying questions AND trigger staging/);
  assert.match(s, /stage nothing that turn/, 'the disclosure rule must say so too');
});
