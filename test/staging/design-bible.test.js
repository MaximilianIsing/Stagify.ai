// lib/staging/design-bible.js — the locked per-room furniture document.
//
// Two contracts carry the weight here:
//  1. normalizeBible is the TRUST BOUNDARY. Model output becomes the prompt for every
//     other frame of a room, so every rejection path, every cap, and above all the fact
//     that room identity comes from the CALLER (never the model) are pinned below.
//  2. bibleSummaryLines is an ORDERING CONTRACT. lib/staging/prompts.js builds the
//     injected support-frame block from these lines, so the exact output for a fixture is
//     pinned byte for byte — if this test goes red, the prompt block moved.
// extractBible is exercised against a fake Gemini client (no real call, no cost), because
// its whole job is to turn every possible failure into null.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BIBLE_SCHEMA_VERSION,
  BIBLE_EXTRACTION_PROMPT,
  DESIGN_BIBLE_RESPONSE_SCHEMA,
  normalizeBible,
  criticalSlots,
  bibleSummaryLines,
  createDesignBible,
} from '../../lib/staging/design-bible.js';

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const CTX = { roomKey: 'living-room-1', roomType: 'Living room', furnitureStyle: 'midcentury' };

// A minimal well-formed model reply.
const modelReply = (overrides = {}) => ({
  palette: { walls: 'warm off-white', primary: 'oatmeal boucle' },
  lighting: { direction: 'window on the long wall' },
  pieces: [{ slot: 'sofa', identity: '3-seat low-profile sofa', placement: 'against the long wall', critical: true }],
  negatives: ['no tufted upholstery'],
  ...overrides,
});

// Fake Gemini client: getGenerativeModel().generateContent() returns a scripted
// `response.text()`, or throws when handed an Error. Matches how design-bible.js calls
// the @google/generative-ai SDK (same fake as test/image/image-review.test.js).
function fakeModel(content, seen = {}) {
  return {
    getGenerativeModel(options) {
      seen.options = options;
      return {
        generateContent: async (parts) => {
          seen.parts = parts;
          if (content instanceof Error) throw content;
          return { response: { text: () => content } };
        },
      };
    },
  };
}

// --- normalizeBible: rejection paths ----------------------------------------
test('normalizeBible: rejects anything that is not an object', () => {
  for (const junk of [null, undefined, '', 'sofa', 42, true, [], [{ slot: 'sofa' }]]) {
    assert.equal(normalizeBible(junk, CTX), null, `expected null for ${JSON.stringify(junk)}`);
  }
});

test('normalizeBible: rejects a reply with no usable pieces', () => {
  assert.equal(normalizeBible(modelReply({ pieces: [] }), CTX), null, 'empty pieces');
  assert.equal(normalizeBible(modelReply({ pieces: undefined }), CTX), null, 'absent pieces');
  assert.equal(normalizeBible(modelReply({ pieces: 'sofa' }), CTX), null, 'pieces as a string');
  assert.equal(normalizeBible(modelReply({ pieces: [null, 'sofa', 7, []] }), CTX), null, 'pieces of junk');
  // Filtering happens BEFORE the emptiness check: pieces that all fail validation are the
  // same as no pieces at all.
  assert.equal(
    normalizeBible(modelReply({ pieces: [{ slot: '', identity: 'a sofa' }, { slot: 'rug', identity: '  ' }] }), CTX),
    null,
    'a piece needs both a slot and an identity',
  );
  assert.equal(
    normalizeBible(modelReply({ pieces: [{ slot: '!!!', identity: 'a sofa' }] }), CTX),
    null,
    'a slot of punctuation alone normalizes to empty',
  );
});

// --- normalizeBible: trust boundary -----------------------------------------
test('normalizeBible: room identity comes from the caller, NEVER from the model', () => {
  // The model tries to redirect the bible at another room and forge the schema version.
  const hostile = modelReply({
    version: 99,
    roomKey: 'bedroom-4',
    roomType: 'Kitchen',
    furnitureStyle: 'luxury',
  });
  const bible = normalizeBible(hostile, CTX);
  assert.ok(bible);
  assert.equal(bible.roomKey, 'living-room-1', 'roomKey must come from ctx, not the model');
  assert.equal(bible.roomType, 'Living room', 'roomType must come from ctx, not the model');
  assert.equal(bible.furnitureStyle, 'midcentury', 'furnitureStyle must come from ctx, not the model');
  assert.equal(bible.version, BIBLE_SCHEMA_VERSION, 'version is stamped by us');
});

test('normalizeBible: the response schema does not let the model emit room identity', () => {
  const props = Object.keys(DESIGN_BIBLE_RESPONSE_SCHEMA.properties);
  assert.deepEqual(props.sort(), ['lighting', 'negatives', 'palette', 'pieces']);
  for (const forbidden of ['version', 'roomKey', 'roomType', 'furnitureStyle']) {
    assert.equal(props.includes(forbidden), false, `${forbidden} must be server-stamped, not modelled`);
  }
});

// --- normalizeBible: slots --------------------------------------------------
test('normalizeBible: slots are lowercased, hyphenated and stripped to [a-z0-9-]', () => {
  const bible = normalizeBible(modelReply({
    pieces: [{ slot: '  Coffee Table (Oval)! ', identity: 'oval walnut coffee table' }],
  }), CTX);
  assert.ok(bible);
  assert.equal(bible.pieces[0].slot, 'coffee-table-oval');
});

test('normalizeBible: duplicate slots collapse, keeping the first position', () => {
  const bible = normalizeBible(modelReply({
    pieces: [
      { slot: 'sofa', identity: 'first sofa', critical: true },
      { slot: 'rug', identity: 'a rug', critical: true },
      { slot: 'Sofa', identity: 'second sofa', critical: true },
      { slot: 'sofa', identity: 'third sofa', critical: false },
    ],
  }), CTX);
  assert.ok(bible);
  assert.deepEqual(bible.pieces.map((p) => p.slot), ['sofa', 'rug']);
  assert.equal(bible.pieces[0].identity, 'first sofa', 'the first occurrence wins');
});

test('normalizeBible: a critical:true duplicate supersedes a critical:false one, in place', () => {
  const bible = normalizeBible(modelReply({
    pieces: [
      { slot: 'sofa', identity: 'minor mention of the sofa', critical: false },
      { slot: 'plant', identity: 'a fig', critical: false },
      { slot: 'sofa', identity: 'the real sofa description', critical: true },
    ],
  }), CTX);
  assert.ok(bible);
  assert.deepEqual(bible.pieces.map((p) => p.slot), ['sofa', 'plant'], 'position is the first occurrence\'s');
  assert.equal(bible.pieces[0].critical, true, 'criticality must not be lost — it drives the consistency gate');
  assert.equal(bible.pieces[0].identity, 'the real sofa description');

  // …and NOT the other way round: a later non-critical duplicate cannot demote.
  const kept = normalizeBible(modelReply({
    pieces: [
      { slot: 'sofa', identity: 'the real sofa description', critical: true },
      { slot: 'sofa', identity: 'minor mention', critical: false },
    ],
  }), CTX);
  assert.ok(kept);
  assert.equal(kept.pieces.length, 1);
  assert.equal(kept.pieces[0].critical, true);
  assert.equal(kept.pieces[0].identity, 'the real sofa description');
});

test('normalizeBible: slot is capped at 40 characters', () => {
  const bible = normalizeBible(modelReply({
    pieces: [{ slot: 'a'.repeat(80), identity: 'something' }],
  }), CTX);
  assert.ok(bible);
  assert.equal(bible.pieces[0].slot.length, 40);
});

// --- normalizeBible: caps and coercion --------------------------------------
test('normalizeBible: text fields are capped (identity 400, placement 200, negative 160)', () => {
  const bible = normalizeBible(modelReply({
    pieces: [{ slot: 'sofa', identity: 'i'.repeat(900), placement: 'p'.repeat(900), critical: true }],
    negatives: ['n'.repeat(900)],
  }), CTX);
  assert.ok(bible);
  assert.equal(bible.pieces[0].identity.length, 400);
  assert.equal(bible.pieces[0].placement.length, 200);
  assert.equal(bible.negatives[0].length, 160);
});

test('normalizeBible: pieces cap at 14 and negatives at 8', () => {
  const bible = normalizeBible(modelReply({
    pieces: Array.from({ length: 30 }, (_, i) => ({ slot: `slot-${i}`, identity: `piece ${i}` })),
    negatives: Array.from({ length: 20 }, (_, i) => `no thing ${i}`),
  }), CTX);
  assert.ok(bible);
  assert.equal(bible.pieces.length, 14);
  assert.equal(bible.negatives.length, 8);
  assert.equal(bible.negatives[7], 'no thing 7');
});

test('normalizeBible: the cap can never discard a CRITICAL piece', () => {
  // The failure this prevents, which is silent and total: the cap used to slice in the
  // model's own emission order, so a room where it listed 14 accessories before naming the
  // sofa and the bed came out with ZERO critical pieces. Everything downstream then agrees
  // the room is fine — designBiblePromptSuffix emits no "MUST match exactly" block, and
  // reviewDesignConsistency early-returns "no critical pieces" as passing — so the whole
  // room renders unconditioned and is recorded as continuity-clean.
  const filler = Array.from({ length: 14 }, (_, i) => ({
    slot: `trinket-${i}`, identity: `small accessory ${i}`, placement: 'a shelf', critical: false,
  }));
  const bible = normalizeBible(modelReply({
    pieces: [
      ...filler,
      { slot: 'sofa', identity: '3-seat bouclé sofa, four walnut legs', placement: 'long wall', critical: true },
      { slot: 'bed', identity: 'king oak platform bed, no headboard tufting', placement: 'facing the window', critical: true },
    ],
  }), CTX);
  assert.ok(bible);
  assert.equal(bible.pieces.length, 14, 'still capped');
  const slots = bible.pieces.map((p) => p.slot);
  assert.ok(slots.includes('sofa'), 'the sofa survived the cap');
  assert.ok(slots.includes('bed'), 'so did the bed');
  assert.deepEqual(slots.slice(0, 2), ['sofa', 'bed'], 'critical pieces lead, in the order the model gave them');
  assert.equal(criticalSlots(bible).length, 2, 'and the reviewer therefore has something to score');
});

test('normalizeBible: within each group the model’s order is preserved', () => {
  // A stable partition, not a sort — the model tends to name the most prominent piece of a
  // kind first, and reordering within a group would throw that signal away.
  const bible = normalizeBible(modelReply({
    pieces: [
      { slot: 'plant', identity: 'fig', critical: false },
      { slot: 'sofa', identity: 'sofa', critical: true },
      { slot: 'lamp', identity: 'lamp', critical: false },
      { slot: 'rug', identity: 'rug', critical: true },
    ],
  }), CTX);
  assert.ok(bible);
  assert.deepEqual(bible.pieces.map((p) => p.slot), ['sofa', 'rug', 'plant', 'lamp']);
});

test('normalizeBible: critical is coerced to a real boolean', () => {
  const bible = normalizeBible(modelReply({
    pieces: [
      { slot: 'sofa', identity: 'a sofa', critical: 'yes' },
      { slot: 'rug', identity: 'a rug', critical: 0 },
      { slot: 'lamp', identity: 'a lamp' },
      { slot: 'table', identity: 'a table', critical: null },
    ],
  }), CTX);
  assert.ok(bible);
  assert.deepEqual(bible.pieces.map((p) => p.critical), [true, false, false, false]);
  for (const p of bible.pieces) assert.equal(typeof p.critical, 'boolean');
});

test('normalizeBible: negatives of junk types are dropped, not stringified', () => {
  const bible = normalizeBible(modelReply({ negatives: [null, {}, [], 'no chrome', undefined, '   ', 7] }), CTX);
  assert.ok(bible);
  // Numbers coerce (7 → '7'); objects/arrays/null do not survive at all.
  assert.deepEqual(bible.negatives, ['no chrome', '7']);
});

test('normalizeBible: negatives that are not an array become an empty list', () => {
  for (const junk of [5, 'no chrome', { 0: 'no chrome' }, null]) {
    const bible = normalizeBible(modelReply({ negatives: junk }), CTX);
    assert.ok(bible, 'a bad negatives list must not sink an otherwise good bible');
    assert.deepEqual(bible.negatives, []);
  }
});

test('normalizeBible: a missing or junk palette/lighting is tolerated', () => {
  for (const junk of [undefined, null, 'blue', 42, ['blue']]) {
    const bible = normalizeBible(modelReply({ palette: junk, lighting: junk }), CTX);
    assert.ok(bible, 'furniture is the point; a missing palette is not fatal');
    assert.deepEqual(bible.palette, {});
    assert.deepEqual(bible.lighting, {});
  }
});

test('normalizeBible: palette/lighting keep only known keys and drop empty values', () => {
  const bible = normalizeBible(modelReply({
    palette: { walls: '  warm off-white ', primary: '', accent: null, ceiling: 'white', wood: 'walnut' },
    lighting: { direction: 'window camera-left', mood: 'moody', timeOfDay: '   ' },
  }), CTX);
  assert.ok(bible);
  assert.deepEqual(bible.palette, { walls: 'warm off-white', wood: 'walnut' });
  assert.deepEqual(bible.lighting, { direction: 'window camera-left' });
});

test('normalizeBible: palette/lighting keys come out in canonical order', () => {
  // The model emitted them backwards; the document must not inherit that order, because
  // bibleSummaryLines has to be byte-stable.
  const bible = normalizeBible(modelReply({
    palette: { wood: 'oak', metal: 'brass', accent: 'ochre', secondary: 'sand', primary: 'cream', walls: 'white' },
  }), CTX);
  assert.ok(bible);
  assert.deepEqual(Object.keys(bible.palette), ['walls', 'primary', 'secondary', 'accent', 'metal', 'wood']);
});

test('normalizeBible: nested nulls and missing fields do not throw', () => {
  const bible = normalizeBible({
    pieces: [null, undefined, { slot: null, identity: null }, { slot: 'sofa', identity: 'a sofa', placement: null }],
    palette: { walls: undefined },
    negatives: null,
  }, {});
  assert.ok(bible);
  assert.equal(bible.pieces.length, 1);
  assert.equal(bible.pieces[0].placement, '');
  assert.equal(bible.roomKey, '', 'a caller that supplies no ctx gets empty identity, not model data');
});

// --- criticalSlots ----------------------------------------------------------
test('criticalSlots: lists only critical slots, in bible order, and tolerates null', () => {
  const bible = normalizeBible(modelReply({
    pieces: [
      { slot: 'plant', identity: 'a fig', critical: false },
      { slot: 'sofa', identity: 'a sofa', critical: true },
      { slot: 'rug', identity: 'a rug', critical: true },
    ],
  }), CTX);
  assert.deepEqual(criticalSlots(bible), ['sofa', 'rug']);
  assert.deepEqual(criticalSlots(null), []);
  assert.deepEqual(criticalSlots(undefined), []);
  assert.deepEqual(criticalSlots(/** @type {any} */ ({ pieces: 'sofa' })), []);
});

// --- bibleSummaryLines: the ordering contract -------------------------------
const FIXTURE = {
  version: 1,
  roomKey: 'living-room-1',
  roomType: 'Living room',
  furnitureStyle: 'midcentury',
  palette: {
    walls: 'warm off-white',
    primary: 'oatmeal boucle',
    secondary: 'walnut',
    accent: 'muted ochre',
    metal: 'brushed brass',
    wood: 'walnut',
  },
  lighting: {
    direction: 'window on the long wall',
    temperature: 'warm daylight ~4800K',
    timeOfDay: 'late afternoon',
  },
  pieces: [
    {
      slot: 'sofa',
      identity: '3-seat low-profile sofa, oatmeal boucle, four tapered walnut legs, two loose back cushions, no tufting',
      placement: 'against the long wall opposite the window',
      critical: true,
    },
    {
      slot: 'fiddle-leaf-fig',
      identity: '1.6m fiddle-leaf fig in a matte terracotta pot',
      placement: 'in the corner beside the window',
      critical: false,
    },
    {
      slot: 'rug',
      identity: 'flat-weave wool rug, cream with a thin charcoal border, low pile',
      placement: 'centred under the coffee table',
      critical: true,
    },
  ],
  negatives: ['no tufted or chesterfield upholstery', 'no chrome or black metal', 'no high-pile or patterned rug'],
};

// PINNED. lib/staging/prompts.js builds the injected consistency block out of these exact
// lines and in this exact order, so changing the format here is changing the prompt for
// every support frame. If you must change it, change it deliberately and update the
// prompt-ordering test downstream in the same commit.
test('bibleSummaryLines: exact pinned output for the fixture bible', () => {
  assert.deepEqual(bibleSummaryLines(FIXTURE), [
    'Room: Living room (midcentury style)',
    'Palette: walls warm off-white; primary oatmeal boucle; secondary walnut; accent muted ochre; metal brushed brass; wood walnut',
    'Lighting: direction window on the long wall; temperature warm daylight ~4800K; timeOfDay late afternoon',
    'Locked pieces (must be the same objects in every photo of this room):',
    '- sofa: 3-seat low-profile sofa, oatmeal boucle, four tapered walnut legs, two loose back cushions, no tufting | placement: against the long wall opposite the window',
    '- rug: flat-weave wool rug, cream with a thin charcoal border, low pile | placement: centred under the coffee table',
    'Secondary pieces (keep consistent, minor variation tolerated):',
    '- fiddle-leaf-fig: 1.6m fiddle-leaf fig in a matte terracotta pot | placement: in the corner beside the window',
    'Never include:',
    '- no tufted or chesterfield upholstery',
    '- no chrome or black metal',
    '- no high-pile or patterned rug',
  ]);
});

test('bibleSummaryLines: critical pieces lead, regardless of their order in the document', () => {
  const lines = bibleSummaryLines(FIXTURE);
  const locked = lines.indexOf('Locked pieces (must be the same objects in every photo of this room):');
  const secondary = lines.indexOf('Secondary pieces (keep consistent, minor variation tolerated):');
  assert.ok(locked > -1 && secondary > locked);
  assert.ok(lines.findIndex((l) => l.startsWith('- rug:')) < secondary, 'a critical piece stays above the split');
  assert.ok(lines.findIndex((l) => l.startsWith('- fiddle-leaf-fig:')) > secondary);
});

test('bibleSummaryLines: is a pure function of the document (repeat calls are identical)', () => {
  assert.deepEqual(bibleSummaryLines(FIXTURE), bibleSummaryLines(FIXTURE));
  // Palette key order in the source object must not leak into the output.
  const reordered = { ...FIXTURE, palette: { wood: 'walnut', walls: 'warm off-white', primary: 'oatmeal boucle', secondary: 'walnut', accent: 'muted ochre', metal: 'brushed brass' } };
  assert.deepEqual(bibleSummaryLines(reordered), bibleSummaryLines(FIXTURE));
});

test('bibleSummaryLines: empty sections are omitted, not left as bare headers', () => {
  const lines = bibleSummaryLines({
    ...FIXTURE,
    furnitureStyle: '',
    palette: {},
    lighting: {},
    pieces: [{ slot: 'sofa', identity: 'a sofa', placement: '', critical: true }],
    negatives: [],
  });
  assert.deepEqual(lines, [
    'Room: Living room',
    'Locked pieces (must be the same objects in every photo of this room):',
    '- sofa: a sofa',
  ]);
});

test('bibleSummaryLines: a null or piece-less bible yields no lines', () => {
  assert.deepEqual(bibleSummaryLines(null), []);
  assert.deepEqual(bibleSummaryLines(undefined), []);
  assert.deepEqual(bibleSummaryLines(/** @type {any} */ ({ ...FIXTURE, pieces: [] })), []);
  assert.deepEqual(bibleSummaryLines(/** @type {any} */ ({ ...FIXTURE, pieces: 'sofa' })), []);
  assert.equal(
    bibleSummaryLines(/** @type {any} */ ({ ...FIXTURE, roomType: '', furnitureStyle: '', pieces: [{ slot: 's', identity: 'i', placement: '', critical: false }] }))[0],
    'Room: unspecified',
    'a bible with no room type still renders a stable first line',
  );
});

// --- BIBLE_EXTRACTION_PROMPT: the rules that matter -------------------------
test('BIBLE_EXTRACTION_PROMPT: bans camera-relative wording in identity', () => {
  assert.match(BIBLE_EXTRACTION_PROMPT, /NEVER use camera-relative or angle-dependent language in identity/);
  assert.match(BIBLE_EXTRACTION_PROMPT, /"on the\s+left"/);
  assert.match(BIBLE_EXTRACTION_PROMPT, /nearest the camera/);
  // …and points relative-to-architecture wording at `placement` instead.
  assert.match(BIBLE_EXTRACTION_PROMPT, /placement: where the piece sits relative to the ARCHITECTURE/);
});

test('BIBLE_EXTRACTION_PROMPT: demands facts, not adjectives', () => {
  assert.match(BIBLE_EXTRACTION_PROMPT, /REPRODUCIBLE identity/);
  assert.match(BIBLE_EXTRACTION_PROMPT, /leg count/);
  assert.match(BIBLE_EXTRACTION_PROMPT, /cushion count/);
  assert.match(BIBLE_EXTRACTION_PROMPT, /pile height/);
  assert.match(BIBLE_EXTRACTION_PROMPT, /replace every adjective with a fact/);
});

test('BIBLE_EXTRACTION_PROMPT: sets the critical threshold and the 3-8 negatives rule', () => {
  assert.match(BIBLE_EXTRACTION_PROMPT, /critical: true ONLY for the large, defining pieces/);
  assert.match(BIBLE_EXTRACTION_PROMPT, /false for plants, throw pillows/);
  assert.match(BIBLE_EXTRACTION_PROMPT, /negatives — 3 to 8/);
  assert.match(BIBLE_EXTRACTION_PROMPT, /naming the wrong thing\s+suppresses drift better than describing the right thing/);
});

// --- extractBible -----------------------------------------------------------
test('extractBible: a null client returns null (caller must record "no bible")', async () => {
  const { extractBible } = createDesignBible({ genAI: null });
  assert.equal(await extractBible(TINY_PNG, CTX), null);
});

test('extractBible: a hero frame that is not a data URL returns null', async () => {
  const { extractBible } = createDesignBible({ genAI: fakeModel(JSON.stringify(modelReply())) });
  assert.equal(await extractBible('https://example.com/hero.jpg', CTX), null);
  assert.equal(await extractBible('', CTX), null);
});

test('extractBible: a thrown model error returns null', async () => {
  const { extractBible } = createDesignBible({ genAI: fakeModel(new Error('429 rate limited')) });
  assert.equal(await extractBible(TINY_PNG, CTX), null);
});

test('extractBible: a garbage reply returns null', async () => {
  for (const reply of ['', 'I cannot describe this room.', '{{{', '[1,2,3]', 'null']) {
    const { extractBible } = createDesignBible({ genAI: fakeModel(reply) });
    assert.equal(await extractBible(TINY_PNG, CTX), null, `expected null for ${JSON.stringify(reply)}`);
  }
});

test('extractBible: valid JSON whose pieces are all unusable returns null', async () => {
  const { extractBible } = createDesignBible({ genAI: fakeModel(JSON.stringify(modelReply({ pieces: [] }))) });
  assert.equal(await extractBible(TINY_PNG, CTX), null);
});

test('extractBible: a bare-JSON reply is parsed and normalized', async () => {
  const { extractBible } = createDesignBible({ genAI: fakeModel(JSON.stringify(modelReply())) });
  const bible = await extractBible(TINY_PNG, CTX);
  assert.ok(bible);
  assert.equal(bible.version, BIBLE_SCHEMA_VERSION);
  assert.equal(bible.roomKey, 'living-room-1');
  assert.deepEqual(bible.pieces.map((p) => p.slot), ['sofa']);
});

test('extractBible: a fenced-JSON reply with prose around it is still parsed', async () => {
  const reply = `Sure — here is the bible.\n\`\`\`json\n${JSON.stringify(modelReply())}\n\`\`\`\nHope that helps!`;
  const { extractBible } = createDesignBible({ genAI: fakeModel(reply) });
  const bible = await extractBible(TINY_PNG, CTX);
  assert.ok(bible, 'a model that ignores responseMimeType must not cost us the bible');
  assert.equal(bible.pieces[0].slot, 'sofa');
});

test('extractBible: unfenced JSON wrapped in prose falls back to the outermost object', async () => {
  const reply = `Here you go: ${JSON.stringify(modelReply())} — let me know if you need more.`;
  const { extractBible } = createDesignBible({ genAI: fakeModel(reply) });
  const bible = await extractBible(TINY_PNG, CTX);
  assert.ok(bible);
  assert.equal(bible.pieces[0].identity, '3-seat low-profile sofa');
});

test('extractBible: sends flash (not flash-lite), temperature 0, no thinking, and the response schema', async () => {
  const seen = {};
  const { extractBible } = createDesignBible({ genAI: fakeModel(JSON.stringify(modelReply()), seen) });
  await extractBible(TINY_PNG, CTX);
  assert.equal(seen.options.model, 'gemini-2.5-flash', 'extraction quality is the whole ballgame; this runs once per room');
  assert.equal(seen.options.generationConfig.temperature, 0);
  assert.deepEqual(seen.options.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  assert.equal(seen.options.generationConfig.responseMimeType, 'application/json');
  assert.equal(seen.options.generationConfig.responseSchema, DESIGN_BIBLE_RESPONSE_SCHEMA);
  // Prompt first, then the hero frame as inline base64.
  assert.equal(seen.parts[0].text, BIBLE_EXTRACTION_PROMPT);
  assert.equal(seen.parts[1].inlineData.mimeType, 'image/png');
  assert.ok(seen.parts[1].inlineData.data.length > 0);
});

test('extractBible: the model cannot redirect the bible at another room', async () => {
  const hostile = JSON.stringify(modelReply({ roomKey: 'bedroom-2', roomType: 'Bathroom' }));
  const { extractBible } = createDesignBible({ genAI: fakeModel(hostile) });
  const bible = await extractBible(TINY_PNG, CTX);
  assert.ok(bible);
  assert.equal(bible.roomKey, 'living-room-1');
  assert.equal(bible.roomType, 'Living room');
});
