// Guards for the prompt audit: contradictions and silent-failure modes that a passing suite
// would otherwise hide. Each of these pins a bug that was live, not a hypothetical.
//
// The common shape of all of them: a prompt said two things that could not both be true, or
// a parser turned "the model did not answer" into "the answer was fine". Neither breaks a
// test on its own — the render still returns an image, the CSV still gets a row — which is
// exactly why they need pinning.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generatePrompt,
  FURNITURE_ERASE_PROMPT,
  buildChatSystemInstruction,
  buildChatUploadSystemInstruction,
  AI_DESIGNER_IMAGE_FRAMING_RULES,
  reviewReplyFormat,
  QUALITY_REVIEW_PROMPT,
  ARCHITECTURE_REVIEW_CLAUSE,
} from '../../lib/staging/prompts.js';

// The system instructions take context bags; these are the minimum shape they read.
const chatArgs = { imageContext: '', memories: [], dateContext: '', baseSelectionContext: '' };

// ---- The crop carve-out, on every surface that reaches interior staging --------
//
// "a closer crop is allowed ONLY when the user explicitly asked for one" survived in FOUR
// places after the studios were fixed: the Designer's framing rules and both chat system
// instructions told the routing model to write that permission into additionalPrompt, which
// then flowed into generatePrompt — where INTERIOR_PRESERVATION_RULES denies it outright and,
// speaking last, wins. The routing model was being told to promise something the image model
// would be told to ignore.

test('no interior-path prompt grants a crop, zoom or re-frame', () => {
  const surfaces = {
    'the assembled staging prompt': generatePrompt('Living room', 'standard', 'zoom in on the sofa', false),
    'the chat system instruction': buildChatSystemInstruction(chatArgs),
    'the chat-upload system instruction': buildChatUploadSystemInstruction(chatArgs),
    'the Designer framing rules': AI_DESIGNER_IMAGE_FRAMING_RULES,
  };
  for (const [name, text] of Object.entries(surfaces)) {
    for (const carveOut of [/closer crop is allowed/i, /unless the user explicitly asked for a tighter crop/i, /asked for a closer or different crop/i]) {
      assert.ok(!carveOut.test(text), `${name} must not grant a crop (${carveOut})`);
    }
  }
});

test('the Designer is told to describe the request, not to restate the rules', () => {
  // Three copies of a rule is not three times the safety. generatePrompt() appends the lock
  // last with explicit authority; a model-improvised paraphrase written into every
  // additionalPrompt only competes with it, in wording that varies per turn.
  for (const s of [buildChatSystemInstruction(chatArgs), buildChatUploadSystemInstruction(chatArgs)]) {
    assert.match(s, /should describe WHAT THE USER ASKED FOR/);
    assert.match(s, /Do NOT add architecture-preservation, aspect-ratio or cropping instructions/);
    assert.ok(
      !/Always emphasize that architecture/i.test(s),
      'the old "write the preservation rules yourself" instruction must stay gone',
    );
  }
});

// ---- The erase prompt's counterweight -----------------------------------------

test('the erase prompt protects the window the curtains were hanging on', () => {
  // Removing window treatments is wanted; re-rendering the window behind them is not, and it
  // is where the reported "window became a wall" failures cluster. The prompt asked for the
  // first and said nothing about the second.
  assert.match(FURNITURE_ERASE_PROMPT, /removes the FABRIC ONLY/i);
  assert.match(FURNITURE_ERASE_PROMPT, /same frame, same glazing bars/i);
  assert.match(FURNITURE_ERASE_PROMPT, /Never fill in, wall over, shrink or hide a window/i);
});

test('the erase prompt breaks ties toward LEAVING a thing, not removing it', () => {
  // It used to say: "When unsure whether a cabinet is freestanding or built-in, treat it as
  // freestanding and REMOVE it." Pointed at a fitted vanity or an alcove shelf, that is an
  // instruction to demolish. The asymmetry is the point — the two mistakes do not cost the
  // same, and the prompt now says which one it prefers.
  assert.match(FURNITURE_ERASE_PROMPT, /cannot tell whether something is furniture or part of the room, LEAVE IT/i);
  assert.ok(
    !/treat it as freestanding and REMOVE it/i.test(FURNITURE_ERASE_PROMPT),
    'the old tie-break pointed at destroying built-ins',
  );
});

// ---- The keep-furniture clarifier ---------------------------------------------

test('the keep-furniture clarifier cannot reach a keep-clause', () => {
  // Kitchen and Bathroom entries now OPEN with "keeping the existing … exactly as
  // photographed". The clarifier used to say "treat any furniture and decor NAMED ABOVE as a
  // guide to the desired STYLE only" — which reached those very items and told the model they
  // were changeable, contradicting the sentence immediately before it.
  const p = generatePrompt('Kitchen', 'modern', '', false);
  assert.match(p, /keeping the existing cabinetry, counters, backsplash, sink and built-in appliances exactly as photographed/);
  assert.match(p, /listed above FOR YOU TO ADD as a guide to the desired STYLE only/);
  assert.match(p, /does not loosen anything above that you were told to keep exactly as photographed/);
  assert.ok(
    !/treat any furniture and decor named above/i.test(p),
    'the unscoped wording reached the keep-clause',
  );
});

// ---- One reply-format contract ------------------------------------------------

test('the reviewer states each verdict line exactly once', () => {
  // The format used to be split across three constants with ~1,200 characters of content
  // between the halves. A model asked to hold a four-line contract across that much
  // interleaved prose drops parts of it — which is the mechanism behind the omitted
  // ARCHITECTURE line that used to be logged as "clean".
  const assembled = QUALITY_REVIEW_PROMPT + ARCHITECTURE_REVIEW_CLAUSE + reviewReplyFormat({ architecture: true });
  // Counted as SPECIFICATION SITES — lines that tell the model to emit the token — not raw
  // substring hits. One line legitimately names a token twice ('"PERFECT: true" or
  // "PERFECT: false"'); two separate lines demanding it is the failure being guarded against.
  for (const token of ['PERFECT:', 'SCORE:', 'WHY:', 'ARCHITECTURE:']) {
    const sites = assembled.split('\n').filter((l) => l.includes(token));
    assert.equal(
      sites.length, 1,
      `"${token}" must be specified on exactly one line (found ${sites.length}:\n  ${sites.join('\n  ')})`,
    );
  }
  // …and the format block is last, so nothing follows the contract it states.
  assert.ok(
    assembled.indexOf('REPLY FORMAT') > assembled.indexOf('ARCHITECTURE CHECK'),
    'the format block comes after the rubric it applies to',
  );
});

test('the ARCHITECTURE line is demanded unconditionally, the others are conditional', () => {
  // The whole tri-state parse depends on the model emitting this line even on a clean render.
  const withArch = reviewReplyFormat({ architecture: true });
  assert.match(withArch, /ALWAYS include this line, even when everything else is perfect/);
  assert.match(withArch, /"SCORE: <0-100>" — include ONLY if PERFECT is false/);
  // The mask reviewer has no source to compare against, so it must not be asked the question.
  assert.ok(!reviewReplyFormat().includes('ARCHITECTURE'), 'no architecture line without a source image');
  // WHY is opt-out: the mask path never feeds it back into a retry and runs on an 80-token
  // budget, so asking for it there would only crowd out PERFECT and SCORE.
  assert.ok(!reviewReplyFormat({ why: false }).includes('WHY:'), 'WHY is suppressible');
});

// ---- No user request excuses architecture drift --------------------------------

test('the architecture check overrides the "judge against the request" leniency', () => {
  // reviewImageQuality injects "A result that reasonably fulfills this request is GOOD". A
  // render that enlarged a window genuinely DOES reasonably fulfil "make it bright and open",
  // so without this the reviewer's own instruction licenses the drift it exists to catch.
  assert.match(ARCHITECTURE_REVIEW_CLAUSE, /NO REQUEST CAN EXCUSE THIS/);
  assert.match(ARCHITECTURE_REVIEW_CLAUSE, /brighter, more open, more spacious, or airier/);
  assert.match(ARCHITECTURE_REVIEW_CLAUSE, /never a licence to enlarge, add or remove a window/);
  assert.match(ARCHITECTURE_REVIEW_CLAUSE, /could only have been satisfied by changing the room, the correct answer is "changed"/);
});
