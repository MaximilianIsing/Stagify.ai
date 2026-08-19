// What a staged render is called (public/scripts/render-name.js).
//
// This module is the ONE naming derivation, shared by the owner's gallery and the public
// share page, so the tests here are as much about the contract as the output: the fallback
// stays a parameter, the owner's own name always wins, and a row written before any of the
// source machinery existed still reads exactly as it did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { styleLabel, sourceLabel, defaultName, entryName, NAMED_SOURCES } from '../../public/scripts/render-name.js';

test('an entry with no source keeps the original <Style> <Room type>', () => {
  // EVERY row in every existing gallery is this case — none of them carry a source — so a
  // regression here silently renames the entire product's history.
  assert.equal(defaultName({ furnitureStyle: 'luxury', roomType: 'Bedroom' }), 'Luxury Bedroom');
  assert.equal(defaultName({ furnitureStyle: 'standard', roomType: 'Bedroom' }), 'Standard Bedroom');
  assert.equal(defaultName({ roomType: 'Kitchen' }), 'Kitchen', 'no style leaves the room type alone');
  assert.equal(defaultName({ furnitureStyle: 'modern' }, 'FALLBACK'), 'FALLBACK', 'a style alone is not a name');
  assert.equal(defaultName({}, 'FALLBACK'), 'FALLBACK');
});

test('an explicit interior source still takes the <Style> <Room type> path', () => {
  // `interior` is in the lib-side vocabulary but has no rule, on purpose.
  assert.equal(defaultName({ source: 'interior', furnitureStyle: 'luxury', roomType: 'Bedroom' }), 'Luxury Bedroom');
});

test('each studio names itself, with its qualifier when it has one', () => {
  assert.equal(defaultName({ source: 'exterior', qualifier: 'Golden hour' }), 'Exterior — Golden hour');
  assert.equal(defaultName({ source: 'exterior', qualifier: 'Dusk, clear sky' }), 'Exterior — Dusk, clear sky');
  assert.equal(defaultName({ source: 'masking', qualifier: '3 areas' }), 'Masking Studio — 3 areas');
  assert.equal(defaultName({ source: 'designer', roomType: 'Kitchen' }), 'AI Designer — Kitchen');
});

test('a studio with no qualifier degrades to its bare name, not to the fallback', () => {
  assert.equal(defaultName({ source: 'exterior' }, 'FALLBACK'), 'Exterior');
  assert.equal(defaultName({ source: 'masking' }, 'FALLBACK'), 'Masking Studio');
  assert.equal(defaultName({ source: 'designer' }, 'FALLBACK'), 'AI Designer');
});

test("the designer's 'Other' guess is suppressed rather than printed", () => {
  // lib/chat/chat-staging.js defaults an unclassified turn to roomType 'Other'.
  // "AI Designer — Other" reads like a bug; "AI Designer" reads like a default.
  assert.equal(defaultName({ source: 'designer', roomType: 'Other' }), 'AI Designer');
  assert.equal(defaultName({ source: 'designer', roomType: 'other' }), 'AI Designer', 'case does not matter');
  assert.equal(defaultName({ source: 'designer', roomType: 'Other room' }), 'AI Designer — Other room',
    'only the exact sentinel is suppressed');
});

test('the source photo stem is appended to every shape', () => {
  assert.equal(
    defaultName({ furnitureStyle: 'luxury', roomType: 'Bedroom', sourceName: '123-main-mstr' }),
    'Luxury Bedroom · 123-main-mstr',
  );
  assert.equal(
    defaultName({ source: 'exterior', qualifier: 'Golden hour', sourceName: '123-main-front' }),
    'Exterior — Golden hour · 123-main-front',
  );
  assert.equal(
    defaultName({ source: 'exterior', sourceName: '123-main-front' }),
    'Exterior · 123-main-front',
    'a stem still lands when there is no qualifier',
  );
  assert.equal(
    defaultName({ roomType: 'Kitchen', sourceName: 'elm-st-04' }),
    'Kitchen · elm-st-04',
    'the room-only branch takes the suffix too',
  );
});

test('the stem is never appended to the caller-supplied fallback', () => {
  // A render with nothing to say about itself is "Staged room", not "Staged room · house" —
  // the suffix qualifies a name, and there is no name here to qualify.
  assert.equal(defaultName({ sourceName: 'house' }, 'FALLBACK'), 'FALLBACK');
});

test("the owner's own name wins outright and never gets a suffix", () => {
  // Appending provenance to a name somebody typed is the app arguing with them. It would
  // also break gallery/rename.js, which seeds the input from `name` and uses defaultName
  // only as the placeholder — a suffixed value would be saved back as a real custom name.
  const entry = {
    name: '412 Rosewood Lane',
    source: 'exterior',
    qualifier: 'Golden hour',
    sourceName: '123-main-front',
  };
  assert.equal(entryName(entry), '412 Rosewood Lane');
  assert.equal(defaultName(entry), 'Exterior — Golden hour · 123-main-front',
    'the derived name is still available underneath, for the placeholder');
});

test('entryName falls through to the derived name when there is no custom one', () => {
  assert.equal(entryName({ source: 'masking', qualifier: '2 areas', name: '' }), 'Masking Studio — 2 areas');
  assert.equal(entryName({ source: 'masking', qualifier: '2 areas', name: '   ' }), 'Masking Studio — 2 areas',
    'a whitespace-only name is not a name');
});

test('the fallback stays a parameter, because the share page cannot translate', () => {
  // The gallery passes its translated string and the share page passes plain English;
  // neither has to reach into the other's world. See the module header.
  assert.equal(defaultName({}, 'Habitación preparada'), 'Habitación preparada');
  assert.equal(entryName({}, 'Habitación preparada'), 'Habitación preparada');
  assert.equal(defaultName({}), 'Staged room', 'and the default default is English');
});

test('a share manifest carries no stem, so the same function yields the shorter name', () => {
  // routes/share-public.js publishes source and qualifier but NEVER sourceName. That is a
  // privacy decision, and this is what it looks like from the page: no branch, just absence.
  const owner = { source: 'exterior', qualifier: 'Golden hour', sourceName: '412-rosewood-ln' };
  const stranger = { source: 'exterior', qualifier: 'Golden hour' };
  assert.equal(defaultName(owner), 'Exterior — Golden hour · 412-rosewood-ln');
  assert.equal(defaultName(stranger), 'Exterior — Golden hour');
});

test('styleLabel capitalises the slug and survives nothing', () => {
  assert.equal(styleLabel('midcentury'), 'Midcentury');
  assert.equal(styleLabel(''), '');
  assert.equal(styleLabel(undefined), '');
});

test('sourceLabel names every labelled source and stays silent for interior', () => {
  // The detail panel's "Made with" row is omitted for interior renders, where the Room and
  // Style rows underneath already answer the question.
  assert.equal(sourceLabel('exterior'), 'Exterior');
  assert.equal(sourceLabel('masking'), 'Masking Studio');
  assert.equal(sourceLabel('designer'), 'AI Designer');
  // `api` is labelled but does NOT name a render — the row is the only place an owner
  // can tell an integration's render from one a colleague made by hand.
  assert.equal(sourceLabel('api'), 'API');
  assert.equal(sourceLabel('interior'), '');
  assert.equal(sourceLabel(''), '');
  assert.equal(sourceLabel(undefined), '');
});

test('every named source produces a distinct label', () => {
  // Set equality against the lib side lives in test/data/render-extra.test.js; this is the
  // behavioural half — a rule that exists must actually do something.
  //
  // Split from the naming sweep below because these became two different claims when the
  // API arrived: EVERY rule owes a unique label, but only a `namesRender` rule owes a
  // name. Asserting both in one loop is what would force a label-only source to invent a
  // card name it must not have.
  const labels = new Set();
  for (const source of NAMED_SOURCES) {
    const label = sourceLabel(source);
    assert.ok(label, `${source} has no label`);
    assert.ok(!labels.has(label), `${source} shares a label with another source`);
    labels.add(label);
  }
});

test('a source that names renders produces a distinct name; a label-only one does not', () => {
  const names = new Set();
  for (const source of NAMED_SOURCES) {
    const name = defaultName({ source }, 'FALLBACK');
    if (name === 'FALLBACK') continue; // label-only, covered by the case below
    assert.ok(!names.has(name), `${source} shares a name with another studio`);
    names.add(name);
  }
  // The naming sources still all name something, so the sweep above cannot go vacuous.
  assert.ok(names.size >= 3, 'the studios that name a render must still do so');
});

test('an API render keeps the interior name, so no client is shown the word "API"', () => {
  // THE REGRESSION THIS DESIGN EXISTS TO PREVENT. `defaultName` also feeds the heading of
  // the public share page (public/scripts/share/view.js), so a rule that named the render
  // would greet an anonymous client with "API" above their staged living room.
  const entry = { source: 'api', furnitureStyle: 'scandinavian', roomType: 'Living Room' };
  const name = defaultName(entry, 'FALLBACK');
  assert.ok(!/API/i.test(name), `an API render must not be named after the API: ${name}`);
  assert.match(name, /Living Room/);

  // ...while the owner's private "Made with" row still says where it came from.
  assert.equal(sourceLabel('api'), 'API');
});

test('an API render still takes the source-photo suffix that tells two houses apart', () => {
  // `sourceName` lives in the same column as `source`, so before this fix an unregistered
  // id nulled BOTH and every API render read "Standard Bedroom" with nothing after it.
  const name = defaultName(
    { source: 'api', furnitureStyle: 'standard', roomType: 'Bedroom', sourceName: '412-rosewood' },
    'FALLBACK',
  );
  assert.match(name, /412-rosewood/);
});
