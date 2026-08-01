// lib/staging/room-clustering.js — sorting a listing's photos into rooms and choosing the
// frame whose staging becomes each room's design bible.
//
// The pure functions carry the risk, so they carry the tests:
//  - assignRoomKeys decides which photos share a design bible. A wrong group conditions a
//    photo on ANOTHER room's furniture, so "two bedrooms separate" and "a failed label
//    stays null" are the two contracts that matter.
//  - pickHero must be stable across reruns (a flipping hero re-stages a whole room) and
//    must yield to an explicit operator choice.
// labelPhoto is driven by a fake Gemini client and real sharp buffers, and must fail open
// to null on every path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { promptMatrix } from '../../lib/staging/promptMatrix.js';
import {
  ROOM_LABEL_PROMPT,
  ROOM_LABEL_RESPONSE_SCHEMA,
  ROOM_LABEL_TYPES,
  OTHER_ROOM_TYPE,
  slugifyRoomLabel,
  assignRoomKeys,
  pickHero,
  createRoomClustering,
} from '../../lib/staging/room-clustering.js';

const photoBuffer = () =>
  sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 200, g: 190, b: 170 } } })
    .jpeg()
    .toBuffer();

// Fake Gemini client (same shape as test/image/image-review.test.js): a scripted
// `response.text()`, or a throw when handed an Error.
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

// --- vocabulary -------------------------------------------------------------
test('ROOM_LABEL_TYPES: derived from promptMatrix plus Other, never hand-listed', () => {
  assert.deepEqual(ROOM_LABEL_TYPES, [...Object.keys(promptMatrix), OTHER_ROOM_TYPE]);
  // Spot-check the exact spellings the staging API receives (case- and space-sensitive).
  assert.ok(ROOM_LABEL_TYPES.includes('Living room'));
  assert.ok(ROOM_LABEL_TYPES.includes('Dorm'));
  assert.equal(ROOM_LABEL_TYPES.includes('living room'), false, 'the keys are case-sensitive');
});

test('ROOM_LABEL_PROMPT and the response schema enumerate exactly that vocabulary', () => {
  for (const type of ROOM_LABEL_TYPES) {
    assert.ok(ROOM_LABEL_PROMPT.includes(`"${type}"`), `prompt must offer ${type}`);
  }
  assert.deepEqual(ROOM_LABEL_RESPONSE_SCHEMA.properties.roomType, { type: 'string', enum: ROOM_LABEL_TYPES });
  assert.deepEqual(ROOM_LABEL_RESPONSE_SCHEMA.required.sort(), ['confidence', 'isWide', 'roomLabel', 'roomType']);
});

test('ROOM_LABEL_PROMPT: asks for a distinguisher stable across frames of one room', () => {
  assert.match(ROOM_LABEL_PROMPT, /Two photos of the same room/);
  assert.match(ROOM_LABEL_PROMPT, /two different bedrooms must get DIFFERENT ones/);
  assert.match(ROOM_LABEL_PROMPT, /wide establishing shot/);
});

// --- slugifyRoomLabel -------------------------------------------------------
test('slugifyRoomLabel: lowercases, hyphenates, and trims stray separators', () => {
  assert.equal(slugifyRoomLabel('Primary Bedroom'), 'primary-bedroom');
  assert.equal(slugifyRoomLabel('  Upstairs   Bath!!  '), 'upstairs-bath');
  assert.equal(slugifyRoomLabel('Living room'), 'living-room');
  assert.equal(slugifyRoomLabel('2nd_bedroom'), '2nd-bedroom');
  assert.equal(slugifyRoomLabel('--kitchen--'), 'kitchen');
});

test('slugifyRoomLabel: junk and non-strings yield an empty slug', () => {
  for (const junk of [null, undefined, '', '   ', '!!!', {}, [], true, () => {}]) {
    assert.equal(slugifyRoomLabel(junk), '', `expected '' for ${String(junk)}`);
  }
  assert.equal(slugifyRoomLabel(3), '3', 'a number is sluggable');
});

test('slugifyRoomLabel: label variants that mean the same room collapse together', () => {
  assert.equal(slugifyRoomLabel('primary bedroom'), slugifyRoomLabel('  Primary  Bedroom '));
});

// --- assignRoomKeys ---------------------------------------------------------
test('assignRoomKeys: two bedrooms separate; frames of one room share a key', () => {
  const keys = assignRoomKeys([
    { photoId: 'p1', roomType: 'Living room', roomLabel: 'living room' },
    { photoId: 'p2', roomType: 'Living room', roomLabel: 'Living Room' },
    { photoId: 'p3', roomType: 'Bedroom', roomLabel: 'primary bedroom' },
    { photoId: 'p4', roomType: 'Bedroom', roomLabel: 'second bedroom' },
    { photoId: 'p5', roomType: 'Bedroom', roomLabel: 'Primary Bedroom' },
  ]);
  assert.equal(keys.get('p1'), 'living-room-1');
  assert.equal(keys.get('p2'), 'living-room-1', 'a label variant must not split a room');
  assert.equal(keys.get('p3'), 'bedroom-1');
  assert.equal(keys.get('p4'), 'bedroom-2', 'two bedrooms must not share one design bible');
  assert.equal(keys.get('p5'), 'bedroom-1');
});

test('assignRoomKeys: numbering is per room type and follows input order', () => {
  const keys = assignRoomKeys([
    { photoId: 1, roomType: 'Bathroom', roomLabel: 'upstairs bath' },
    { photoId: 2, roomType: 'Bedroom', roomLabel: 'guest bedroom' },
    { photoId: 3, roomType: 'Bathroom', roomLabel: 'powder room' },
  ]);
  assert.deepEqual([...keys.values()], ['bathroom-1', 'bedroom-1', 'bathroom-2']);
});

test('assignRoomKeys: a failed label stays null instead of being guessed into a group', () => {
  const keys = assignRoomKeys([
    { photoId: 'ok', roomType: 'Kitchen', roomLabel: 'kitchen' },
    { photoId: 'null-type', roomType: null, roomLabel: 'kitchen' },
    { photoId: 'no-type' },
    { photoId: 'blank-type', roomType: '   ', roomLabel: 'kitchen' },
    { photoId: 'junk-type', roomType: '!!!', roomLabel: 'kitchen' },
  ]);
  assert.equal(keys.get('ok'), 'kitchen-1');
  for (const id of ['null-type', 'no-type', 'blank-type', 'junk-type']) {
    assert.ok(keys.has(id), `${id} must still appear in the map`);
    assert.equal(keys.get(id), null, `${id} must be left unassigned, not merged into kitchen-1`);
  }
});

test('assignRoomKeys: a photo with no id is skipped entirely', () => {
  const keys = assignRoomKeys([
    { photoId: null, roomType: 'Kitchen', roomLabel: 'kitchen' },
    { photoId: '', roomType: 'Kitchen', roomLabel: 'kitchen' },
    { photoId: undefined, roomType: 'Kitchen', roomLabel: 'kitchen' },
    { photoId: 'real', roomType: 'Kitchen', roomLabel: 'kitchen' },
  ]);
  assert.deepEqual([...keys.keys()], ['real']);
});

test('assignRoomKeys: junk input yields an empty map rather than throwing', () => {
  for (const junk of [null, undefined, 'photos', 42, {}]) {
    assert.equal(assignRoomKeys(junk).size, 0);
  }
  assert.equal(assignRoomKeys([null, 'p1', 7, []]).size, 0);
});

test('assignRoomKeys: photos of one type with blank labels merge into one group', () => {
  // The labeller returns a label whenever it succeeds; merging the rare blank ones beats
  // minting a room (and a design bible) per photo.
  const keys = assignRoomKeys([
    { photoId: 'a', roomType: 'Office', roomLabel: '' },
    { photoId: 'b', roomType: 'Office', roomLabel: null },
  ]);
  assert.equal(keys.get('a'), 'office-1');
  assert.equal(keys.get('b'), 'office-1');
});

test('assignRoomKeys: deterministic — same input, same output, every call', () => {
  const input = [
    { photoId: 'p1', roomType: 'Bedroom', roomLabel: 'primary bedroom' },
    { photoId: 'p2', roomType: 'Bedroom', roomLabel: 'guest bedroom' },
    { photoId: 'p3', roomType: 'Living room', roomLabel: 'living room' },
  ];
  assert.deepEqual([...assignRoomKeys(input)], [...assignRoomKeys(input)]);
  assert.deepEqual([...assignRoomKeys(input)], [...assignRoomKeys([...input])]);
});

test('assignRoomKeys: shuffling the input renumbers suffixes but never regroups photos', () => {
  const input = [
    { photoId: 'p1', roomType: 'Bedroom', roomLabel: 'primary bedroom' },
    { photoId: 'p2', roomType: 'Bedroom', roomLabel: 'guest bedroom' },
    { photoId: 'p3', roomType: 'Bedroom', roomLabel: 'Primary Bedroom' },
    { photoId: 'p4', roomType: 'Kitchen', roomLabel: 'kitchen' },
  ];
  const shuffled = [input[2], input[3], input[0], input[1]];

  // The partition — which photos share a design bible — is what must be invariant.
  const partition = (map) => {
    /** @type {Map<string, string[]>} */
    const byKey = new Map();
    for (const [id, key] of map) {
      const bucket = byKey.get(String(key)) || [];
      bucket.push(String(id));
      byKey.set(String(key), bucket);
    }
    return [...byKey.values()].map((ids) => ids.sort().join(',')).sort();
  };
  assert.deepEqual(partition(assignRoomKeys(shuffled)), partition(assignRoomKeys(input)));
  assert.deepEqual(partition(assignRoomKeys(input)), ['p1,p3', 'p2', 'p4']);
});

// --- pickHero ---------------------------------------------------------------
test('pickHero: the widest stageable frame wins (it holds the most furniture)', () => {
  assert.equal(pickHero([
    { id: 'tall', width: 800, height: 1200, stageable: 1 },
    { id: 'wide', width: 2000, height: 1000, stageable: 1 },
    { id: 'square', width: 1000, height: 1000, stageable: 1 },
  ]), 'wide');
});

test('pickHero: excluded frames and gate-rejected frames are not eligible', () => {
  assert.equal(pickHero([
    { id: 'widest-but-excluded', width: 4000, height: 1000, stageable: 1, frameRole: 'excluded' },
    { id: 'wide-but-unstageable', width: 3000, height: 1000, stageable: 0 },
    { id: 'wide-but-false', width: 2500, height: 1000, stageable: false },
    { id: 'winner', width: 1600, height: 1000, stageable: 1 },
  ]), 'winner');
});

test('pickHero: an explicit operator hero wins outright', () => {
  assert.equal(pickHero([
    { id: 'widest', width: 4000, height: 1000, stageable: 1 },
    { id: 'chosen', width: 1100, height: 1000, stageable: 1, frameRole: 'hero' },
  ]), 'chosen');
  // …even when the automatic stageability check said no: the operator has seen the photo.
  assert.equal(pickHero([
    { id: 'widest', width: 4000, height: 1000, stageable: 1 },
    { id: 'chosen', width: 1100, height: 1000, stageable: 0, frameRole: 'hero' },
  ]), 'chosen');
});

test('pickHero: no eligible frame yields null', () => {
  assert.equal(pickHero([]), null);
  assert.equal(pickHero(null), null);
  assert.equal(pickHero(undefined), null);
  assert.equal(pickHero(/** @type {any} */ ('photos')), null);
  assert.equal(pickHero([
    { id: 'a', width: 2000, height: 1000, stageable: 0 },
    { id: 'b', width: 2000, height: 1000, stageable: 1, frameRole: 'excluded' },
  ]), null);
  assert.equal(pickHero([null, undefined, { width: 2000, height: 1000 }, { id: '' }]), null, 'a frame with no id is not a candidate');
});

test('pickHero: ties break deterministically by id so a rerun never flips the hero', () => {
  const frames = [
    { id: 'b', width: 2000, height: 1000, stageable: 1 },
    { id: 'a', width: 1000, height: 500, stageable: 1 },
    { id: 'c', width: 4000, height: 2000, stageable: 1 },
  ];
  assert.equal(pickHero(frames), 'a', 'identical 2:1 ratios resolve to the lowest id');
  assert.equal(pickHero([...frames].reverse()), 'a', 'input order must not change the winner');
  // Numeric ids compare on their string form — still total, still stable.
  const numeric = [{ id: 10, width: 100, height: 50, stageable: 1 }, { id: 9, width: 200, height: 100, stageable: 1 }];
  assert.equal(pickHero(numeric), pickHero([...numeric].reverse()));
  // Two explicit heroes also resolve deterministically rather than by discovery order.
  const twoHeroes = [
    { id: 'z', width: 1000, height: 1000, stageable: 1, frameRole: 'hero' },
    { id: 'y', width: 1000, height: 1000, stageable: 1, frameRole: 'hero' },
  ];
  assert.equal(pickHero(twoHeroes), 'y');
  assert.equal(pickHero([...twoHeroes].reverse()), 'y');
});

test('pickHero: frames with unknown dimensions lose to any measurable frame but stay candidates', () => {
  assert.equal(pickHero([
    { id: 'nodims', stageable: 1 },
    { id: 'measured', width: 1200, height: 1000, stageable: 1 },
  ]), 'measured');
  assert.equal(pickHero([
    { id: 'b', stageable: 1 },
    { id: 'a', width: 0, height: 0, stageable: 1 },
    { id: 'c', width: -100, height: 50, stageable: 1 },
  ]), 'a', 'with nothing measurable, the lowest id wins — but something wins');
});

// --- labelPhoto -------------------------------------------------------------
test('labelPhoto: a null client fails open to null', async () => {
  const { labelPhoto } = createRoomClustering({ genAI: null });
  assert.equal(await labelPhoto(await photoBuffer()), null);
});

test('labelPhoto: a thrown model error fails open to null', async () => {
  const { labelPhoto } = createRoomClustering({ genAI: fakeModel(new Error('503')) });
  assert.equal(await labelPhoto(await photoBuffer()), null);
});

test('labelPhoto: an undecodable buffer fails open to null', async () => {
  const { labelPhoto } = createRoomClustering({ genAI: fakeModel('{"roomType":"Kitchen"}') });
  assert.equal(await labelPhoto(Buffer.from('not an image')), null);
});

test('labelPhoto: an unreadable reply fails open to null', async () => {
  for (const reply of ['', 'It is a kitchen.', '{{{', '[1,2]', 'null']) {
    const { labelPhoto } = createRoomClustering({ genAI: fakeModel(reply) });
    assert.equal(await labelPhoto(await photoBuffer()), null, `expected null for ${JSON.stringify(reply)}`);
  }
});

test('labelPhoto: a valid reply is parsed and normalized', async () => {
  const { labelPhoto } = createRoomClustering({
    genAI: fakeModel(JSON.stringify({ roomType: 'Bedroom', roomLabel: '  primary bedroom ', isWide: true, confidence: 0.82 })),
  });
  assert.deepEqual(await labelPhoto(await photoBuffer()), {
    roomType: 'Bedroom',
    roomLabel: 'primary bedroom',
    isWide: true,
    confidence: 0.82,
  });
});

test('labelPhoto: a fenced reply with prose around it is still parsed', async () => {
  const body = JSON.stringify({ roomType: 'Kitchen', roomLabel: 'kitchen', isWide: false, confidence: 1 });
  const { labelPhoto } = createRoomClustering({ genAI: fakeModel(`Here:\n\`\`\`json\n${body}\n\`\`\``) });
  const label = await labelPhoto(await photoBuffer());
  assert.ok(label);
  assert.equal(label.roomType, 'Kitchen');
});

test('labelPhoto: an off-vocabulary room type becomes Other rather than a bad matrix key', async () => {
  for (const bad of ['Garage', 'living room', '', null, 42]) {
    const { labelPhoto } = createRoomClustering({
      genAI: fakeModel(JSON.stringify({ roomType: bad, roomLabel: 'garage', isWide: true, confidence: 0.5 })),
    });
    const label = await labelPhoto(await photoBuffer());
    assert.ok(label);
    assert.equal(label.roomType, OTHER_ROOM_TYPE, `expected Other for ${JSON.stringify(bad)}`);
  }
});

test('labelPhoto: confidence is clamped to 0-1 and isWide/roomLabel are coerced', async () => {
  const label = async (raw) => {
    const { labelPhoto } = createRoomClustering({ genAI: fakeModel(JSON.stringify(raw)) });
    return labelPhoto(await photoBuffer());
  };
  const base = { roomType: 'Office', roomLabel: 'office', isWide: true, confidence: 0.5 };
  assert.equal((await label({ ...base, confidence: 7 })).confidence, 1);
  assert.equal((await label({ ...base, confidence: -3 })).confidence, 0);
  assert.equal((await label({ ...base, confidence: 'high' })).confidence, 0);
  assert.equal((await label({ ...base, confidence: undefined })).confidence, 0);
  assert.equal((await label({ ...base, isWide: 'yes' })).isWide, true);
  assert.equal((await label({ ...base, isWide: undefined })).isWide, false);
  assert.equal((await label({ ...base, roomLabel: { a: 1 } })).roomLabel, '', 'a non-string label is dropped, not stringified');
  assert.equal((await label({ ...base, roomLabel: 'x'.repeat(200) })).roomLabel.length, 60);
});

test('labelPhoto: uses flash-lite with thinking off and the enum response schema', async () => {
  const seen = {};
  const { labelPhoto } = createRoomClustering({
    genAI: fakeModel(JSON.stringify({ roomType: 'Kitchen', roomLabel: 'kitchen', isWide: true, confidence: 1 }), seen),
  });
  await labelPhoto(await photoBuffer());
  assert.equal(seen.options.model, 'gemini-2.5-flash-lite', 'this call is per PHOTO, so unit cost matters');
  assert.equal(seen.options.generationConfig.temperature, 0);
  assert.deepEqual(seen.options.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  assert.equal(seen.options.generationConfig.responseMimeType, 'application/json');
  assert.equal(seen.options.generationConfig.responseSchema, ROOM_LABEL_RESPONSE_SCHEMA);
  // The photo is downscaled to JPEG before it is sent (downscaleImage's invariant).
  assert.equal(seen.parts[0].text, ROOM_LABEL_PROMPT);
  assert.equal(seen.parts[1].inlineData.mimeType, 'image/jpeg');
  assert.ok(seen.parts[1].inlineData.data.length > 0);
});

// --- the two halves fit together --------------------------------------------
test('assignRoomKeys + pickHero: a labelled listing resolves to one hero per room', async () => {
  const labels = [
    { photoId: 'lr-wide', roomType: 'Living room', roomLabel: 'living room' },
    { photoId: 'lr-detail', roomType: 'Living room', roomLabel: 'living room' },
    { photoId: 'bd-wide', roomType: 'Bedroom', roomLabel: 'primary bedroom' },
    { photoId: 'facade', roomType: null, roomLabel: null },
  ];
  const keys = assignRoomKeys(labels);
  const dims = {
    'lr-wide': { width: 2400, height: 1600, stageable: 1 },
    'lr-detail': { width: 1200, height: 1600, stageable: 1 },
    'bd-wide': { width: 2000, height: 1500, stageable: 1 },
  };
  /** @type {Record<string, string | number | null>} */
  const heroes = {};
  for (const key of new Set([...keys.values()].filter(Boolean))) {
    const frames = [...keys.entries()]
      .filter(([, k]) => k === key)
      .map(([id]) => ({ id, ...dims[String(id)] }));
    heroes[String(key)] = pickHero(frames);
  }
  assert.deepEqual(heroes, { 'living-room-1': 'lr-wide', 'bedroom-1': 'bd-wide' });
  assert.equal(keys.get('facade'), null, 'the unlabelled frame never joins a room');
});
