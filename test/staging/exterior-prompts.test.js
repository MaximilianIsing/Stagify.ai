// Tier: prompt assembly — lib/staging/exterior-prompts.js.
//
// The prompt IS the feature here. Unlike interior staging, where a weak prompt yields a
// dull room, a weak prompt on this path yields a photo that misrepresents a real property
// — so most of what follows is about the hard rules surviving, in the right order,
// against anything the user typed.
//
// Two properties are load-bearing and neither fails loudly on its own:
//   1. A preset on `keep` must contribute SILENCE. "Leave the sky unchanged" reads to an
//      image model as an instruction to do something about the sky.
//   2. EXTERIOR_PRESERVATION_RULES must come LAST. It claims to override everything above
//      it, which is only true if nothing is below it — the same ordering contract
//      ROOM_TYPE_CONSTRAINTS relies on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIME_OF_DAY_PRESETS,
  SKY_PRESETS,
  CLEANUP_CLAUSES,
  EXTERIOR_PRESERVATION_RULES,
  EXTERIOR_CHECK_PROMPT,
  EXTERIOR_REVIEW_PROMPT,
  EXTERIOR_IGNORED_CODES,
  buildExteriorPrompt,
  describeExteriorRequest,
  describeExteriorQualifier,
  TIME_OF_DAY_LABELS,
  SKY_LABELS,
  CLEANUP_LABELS,
} from '../../lib/staging/exterior-prompts.js';
import { UNSTAGEABLE_CODES } from '../../lib/staging/unstageable.js';
import { IMAGE_FRAMING_PRESERVATION_RULES } from '../../lib/staging/prompts.js';

// ---- The preset tables -----------------------------------------------------

test('every preset table carries a `keep` entry that is EMPTY', () => {
  // The whole no-op contract. A non-empty `keep` would quietly make "don't touch the
  // lighting" into a lighting instruction, and the render would still look fine — just
  // not like the photo the user uploaded.
  for (const [name, table] of [['TIME_OF_DAY_PRESETS', TIME_OF_DAY_PRESETS], ['SKY_PRESETS', SKY_PRESETS]]) {
    assert.equal(table.keep, '', `${name}.keep must be the empty string`);
  }
});

test('every non-keep preset and cleanup clause is real, substantial text', () => {
  // Sweep guard: the per-clause tests below all read from these tables, so an entry
  // silently emptied would make them assert nothing.
  const entries = [
    ...Object.entries(TIME_OF_DAY_PRESETS),
    ...Object.entries(SKY_PRESETS),
    ...Object.entries(CLEANUP_CLAUSES),
  ].filter(([key]) => key !== 'keep');
  assert.ok(entries.length >= 8, `expected at least 8 clauses, found ${entries.length}`);
  for (const [key, text] of entries) {
    assert.ok(text.trim().length > 60, `${key} is too short to be a real instruction`);
  }
});

// ---- buildExteriorPrompt ---------------------------------------------------

test('a selected preset puts its exact clause in the prompt', () => {
  const prompt = buildExteriorPrompt({ timeOfDay: 'goldenHour', sky: 'clearBlue' });
  assert.ok(prompt.includes(TIME_OF_DAY_PRESETS.goldenHour), 'the time-of-day clause is verbatim');
  assert.ok(prompt.includes(SKY_PRESETS.clearBlue), 'the sky clause is verbatim');
});

test('a `keep` preset contributes nothing at all', () => {
  const prompt = buildExteriorPrompt({ timeOfDay: 'keep', sky: 'keep' });
  for (const [key, text] of Object.entries({ ...TIME_OF_DAY_PRESETS, ...SKY_PRESETS })) {
    if (key === 'keep') continue;
    assert.ok(!prompt.includes(text), `${key}'s clause leaked into a keep/keep prompt`);
  }
});

test('an unknown or missing preset key degrades to silence, it does not throw', () => {
  // This runs off a request body on a paid path. A preset key we do not recognise should
  // cost the user a plainer photo, never a 500.
  assert.doesNotThrow(() => buildExteriorPrompt({ timeOfDay: 'chartreuse', sky: 42 }));
  assert.doesNotThrow(() => buildExteriorPrompt());
  const prompt = buildExteriorPrompt({ timeOfDay: 'chartreuse' });
  assert.ok(prompt.includes(EXTERIOR_PRESERVATION_RULES), 'the hard rules still ship');
});

test('each removal toggle emits its own clause, only its own, and only when enabled', () => {
  // Swept over the table rather than named pair by pair, so the sixth removal is covered
  // the day it is added rather than the day someone remembers to extend this. That matters
  // more here than it looks: buildExteriorPrompt iterates CLEANUP_CLAUSES, so a new entry
  // reaches the prompt with no code change at all — and an untested clause that reaches a
  // paid render path is the worst of both worlds.
  const keys = Object.keys(CLEANUP_CLAUSES);
  assert.ok(keys.length >= 5, `expected the five removals, swept ${keys.length}`);

  const off = buildExteriorPrompt({});
  for (const key of keys) {
    assert.ok(!off.includes(CLEANUP_CLAUSES[key]), `${key} leaked into a request that asked for nothing`);
  }

  // One at a time. Independence is the property that makes an opt-in panel mean anything:
  // someone who ticks only "clear the snow" must not also get the bins taken away.
  for (const key of keys) {
    const only = buildExteriorPrompt({ [key]: true });
    assert.ok(only.includes(CLEANUP_CLAUSES[key]), `${key} did not emit its own clause`);
    for (const other of keys) {
      if (other !== key) assert.ok(!only.includes(CLEANUP_CLAUSES[other]), `${key} also emitted ${other}`);
    }
  }

  const all = buildExteriorPrompt(Object.fromEntries(keys.map((k) => [k, true])));
  for (const key of keys) {
    assert.ok(all.includes(CLEANUP_CLAUSES[key]), `${key} was dropped when every removal was on`);
  }
});

test('clearing snow keeps the SEASON — it must not hand back a summer photograph', () => {
  // The clause that decides whether snow removal is offerable at all. Lying snow is a
  // condition of the day the shutter fired, so clearing it is the same category as
  // clearing a parked van — but the area it uncovers is the whole plot rather than one
  // patch of driveway, and a model told only "remove the snow" will cheerfully return a
  // green lawn and a tree in leaf. That is not the same property in the same month, and it
  // is precisely the misrepresentation EXTERIOR_PRESERVATION_RULES exists to prevent.
  const clause = CLEANUP_CLAUSES.removeSnow;
  assert.match(clause, /KEEP THE SEASON/, 'stated in caps, because it is the constraint that matters');
  for (const term of ['bare trees and shrubs stay bare', 'dormant', 'greened up', 'replanted']) {
    assert.ok(clause.includes(term), `the snow clause must address "${term}"`);
  }
  assert.ok(clause.includes('same day with the snow cleared'), 'and must say what the result IS');
});

test('drying off wet weather changes ONLY the water', () => {
  // Rain and sky are separate rows on purpose: an agent who wants a dry driveway under the
  // overcast sky they actually had has to be able to ask for exactly that. A clause that
  // let the model "helpfully" brighten the sky while it was in there would silently merge
  // two opt-in rows into one, which is the same bug as a preset defaulting to on.
  const clause = CLEANUP_CLAUSES.removeWetWeather;
  assert.match(clause, /Change ONLY the water/);
  for (const untouched of ['sky', 'time of day', 'season', 'direction of the light']) {
    assert.ok(clause.includes(untouched), `the wet-weather clause must leave "${untouched}" alone`);
  }
});

test('removing people leaves nothing of them behind', () => {
  // Half-removed people are the signature failure of this edit: a floating shadow, a
  // cropped arm, or the photographer still standing in the window glass. Naming them is
  // what stops the model settling for painting over the torso.
  const clause = CLEANUP_CLAUSES.removePeople;
  for (const term of ['reflection', 'silhouette', 'shadow', 'pet']) {
    assert.ok(clause.toLowerCase().includes(term), `the people clause must address "${term}"`);
  }
  assert.match(clause, /not replace them with anyone else/i, 'and must not swap in a stock passer-by');
});

test('a request with nothing selected at all still asks for SOMETHING', () => {
  // Reachable only by a direct API call — the UI disables submit until something is
  // requested. If the prompt ended up empty of instructions the model would hand back the
  // input unchanged and the render would be billed for a no-op.
  const prompt = buildExteriorPrompt({});
  assert.match(prompt, /correction pass/i, 'a bare request falls back to a light correction pass');
});

test('free text ALONE is the whole request — no correction pass bolted on', () => {
  // The controls are opt-in, so "remove the bin bags" and nothing else is now the common
  // case rather than an edge one. The generic correction pass must not ride along: it
  // ends with "Change nothing else", which directly contradicts the instruction the user
  // actually gave, and it relights a photo they never asked to have relit.
  const prompt = buildExteriorPrompt({ additionalPrompt: 'remove the bin bags by the gate' });
  assert.ok(prompt.includes('remove the bin bags by the gate'));
  assert.ok(!/correction pass/i.test(prompt), 'the fallback is a last resort, not a floor');
  assert.ok(!prompt.includes('ALSO APPLY'), 'and it is not also appended a second time');
});

test('free text alongside a preset is stated once, as the priority clause', () => {
  const prompt = buildExteriorPrompt({ timeOfDay: 'dusk', additionalPrompt: 'keep the flag' });
  assert.equal((prompt.match(/keep the flag/g) || []).length, 1, 'said once, not twice');
  assert.ok(prompt.includes('ALSO APPLY'), 'and marked as taking priority over the list');
});

test('the prompt tells the model to change nothing it was not asked for', () => {
  // The instruction that makes an opt-in panel mean anything. Without it, asking only for
  // the bins removed still invites a "helpful" sky replacement.
  assert.match(buildExteriorPrompt({ removeClutter: true }), /make NO other changes/i);
});

test('free text is APPENDED, never substituted for the presets', () => {
  // generatePrompt() has a mode where furnitureStyle 'custom' replaces the base prompt
  // wholesale with the user's text. This path deliberately has no such mode: the presets
  // the user picked are still what they picked.
  const prompt = buildExteriorPrompt({
    timeOfDay: 'dusk',
    removeVehicles: true,
    additionalPrompt: 'make the front door navy',
  });
  assert.ok(prompt.includes(TIME_OF_DAY_PRESETS.dusk), 'the preset survives the free text');
  assert.ok(prompt.includes(CLEANUP_CLAUSES.removeVehicles), 'the toggle survives the free text');
  assert.ok(prompt.includes('make the front door navy'), 'and the free text is present');
});

test('free text is trimmed, and whitespace-only free text counts as nothing', () => {
  const blank = buildExteriorPrompt({ additionalPrompt: '   ' });
  assert.ok(!blank.includes('ALSO APPLY'), 'whitespace-only free text adds nothing');
  assert.match(blank, /correction pass/i, 'and does not count as a request either');
  assert.ok(buildExteriorPrompt({ additionalPrompt: '  navy door  ' }).includes('- navy door'));
});

test('the hard rules are present and come LAST — after the user\'s own words', () => {
  // The ordering contract. EXTERIOR_PRESERVATION_RULES says it overrides every
  // instruction above it, which is a lie the moment anything is emitted below it. The
  // free-text case is the one that matters: it is the only part of the prompt an
  // untrusted party controls.
  const prompt = buildExteriorPrompt({
    timeOfDay: 'goldenHour',
    removeClutter: true,
    additionalPrompt: 'remove the power lines and re-turf the lawn',
  });
  const rules = prompt.indexOf(EXTERIOR_PRESERVATION_RULES);
  assert.ok(rules !== -1, 'the hard rules must ship on every prompt');
  assert.ok(rules > prompt.indexOf('remove the power lines'), 'the hard rules outrank the free text');
  assert.ok(rules > prompt.indexOf(TIME_OF_DAY_PRESETS.goldenHour), 'and the presets');
  assert.ok(rules > prompt.indexOf(CLEANUP_CLAUSES.removeClutter), 'and the toggles');
  assert.ok(rules > prompt.indexOf(IMAGE_FRAMING_PRESERVATION_RULES), 'and the framing block');
});

test('the hard rules forbid the edits the product deliberately does not offer', () => {
  // The controls do not expose landscaping, power lines or resurfacing — but the free
  // text box can ask for any of them in plain English, so the refusal has to live in the
  // prompt rather than in the absence of a checkbox. These are the exact edits that turn
  // "enhanced photo" into "misrepresented property".
  const rules = EXTERIOR_PRESERVATION_RULES.toLowerCase();
  for (const forbidden of ['power line', 'landscape', 'resurface', 'roofline', 'window', 'house number', 'neighbour']) {
    assert.ok(rules.includes(forbidden), `the hard rules must address "${forbidden}"`);
  }
  assert.match(EXTERIOR_PRESERVATION_RULES, /overrides EVERY instruction above/i);
});

test('the hard rules PERMIT rebuilding what a removal uncovered — and bound it', () => {
  // Without this bullet the prompt contradicts itself, and the contradiction resolves the
  // wrong way. EXTERIOR_PRESERVATION_RULES forbids resurfacing a driveway, repairing worn
  // ground and greening up a lawn — and it is emitted LAST precisely so it wins every
  // argument. But every removal clause has to reconstruct the surface the removed thing was
  // covering, so on a literal reading the block revokes the feature it sits underneath.
  //
  // Vehicles and clutter got away with it for as long as they did because a van covers one
  // patch of tarmac. Snow covers the driveway, the path, the beds and the lawn at once, so
  // the model has to be told what it is allowed to rebuild before it decides for itself.
  //
  // THE PERMISSION MUST LIVE INSIDE THE PRESERVATION BLOCK. Stated anywhere above it — in
  // the removal clause, say, where it would read more naturally — the block's own "this
  // section overrides EVERY instruction above it" revokes it again on the next line.
  assert.ok(
    EXTERIOR_PRESERVATION_RULES.includes('rebuild only what that thing was hiding'),
    'the hard rules must grant reconstruction, or they forbid the removals above them',
  );

  // Pinned as a whole bullet, opening word included, because the dangerous mutation is not
  // deletion — it is the SCOPE quietly coming off. "You may rebuild the surface" without
  // "where you were asked above to remove something" is a standing licence to repave the
  // drive on a request that only asked for a bluer sky, and every other assertion in this
  // test still passes when it reads that way.
  assert.match(
    EXTERIOR_PRESERVATION_RULES,
    /^- Where you were asked ABOVE to remove something .*? you may rebuild only what that thing was hiding/m,
    'the permission must stay a bullet scoped to what was actually asked for',
  );

  // Scoped to things the panel actually removes, so it cannot be read as blanket licence.
  for (const removable of ['vehicle', 'clutter', 'person', 'snow', 'standing water']) {
    assert.ok(
      EXTERIOR_PRESERVATION_RULES.includes(removable),
      `the reconstruction carve-out must name "${removable}"`,
    );
  }

  // And bounded, or it is simply permission to improve the property by another route —
  // clear the snow, get back a driveway with the cracks filled in.
  assert.match(EXTERIOR_PRESERVATION_RULES, /never permission to improve it/i);
  assert.match(EXTERIOR_PRESERVATION_RULES, /not a cleaner, newer, greener or better-kept one/i);
});

test('the reconstruction carve-out has NOT weakened the flat prohibitions', () => {
  // The mutation this exists to catch: someone reads the two bullets as duplicative and
  // "simplifies" by deleting the flat ban on resurfacing, leaving only the permission —
  // at which point the model may rebuild any surface it likes and call it uncovering.
  // These have to coexist: a blanket NO, then a narrow, reasoned exception.
  assert.match(EXTERIOR_PRESERVATION_RULES, /Do not resurface, clean, repair or re-point/);
  assert.match(EXTERIOR_PRESERVATION_RULES, /Do not re-landscape the property/);
  assert.ok(
    EXTERIOR_PRESERVATION_RULES.indexOf('Do not resurface') < EXTERIOR_PRESERVATION_RULES.indexOf('rebuild only what'),
    'the prohibition is stated first and the exception qualifies it, not the other way round',
  );
});

test('the framing rules are shared with the interior path, not re-worded', () => {
  // One definition of "do not move the camera". A second copy would drift, and the drift
  // would only show up as an aspect-ratio complaint months later.
  assert.ok(buildExteriorPrompt({}).includes(IMAGE_FRAMING_PRESERVATION_RULES));
});

// ---- describeExteriorRequest ----------------------------------------------

test('the summary names every selected option', () => {
  const summary = describeExteriorRequest({
    timeOfDay: 'goldenHour',
    sky: 'dramatic',
    removeVehicles: true,
    removeClutter: true,
    additionalPrompt: 'keep the flag',
  });
  assert.match(summary, /golden-hour/i);
  assert.match(summary, /dramatic sky/i);
  assert.match(summary, /vehicles removed/i);
  assert.match(summary, /clutter removed/i);
  assert.match(summary, /keep the flag/);
});

test('the summary stays a sentence when nothing is selected', () => {
  const summary = describeExteriorRequest({});
  assert.ok(summary.trim().length > 20, 'the QA reviewer is handed this as the request');
  assert.ok(!summary.endsWith(': '), 'never a dangling colon');
});

test('the summary is BYTE-IDENTICAL to what it produced before the label refactor', () => {
  // TIME_LABELS/SKY_LABELS were inline consts in this function until they were promoted to
  // two-column module tables so the gallery could reuse them. That refactor must be
  // invisible here: this string is fed to the QA reviewer AND written to the CSV prompt
  // log, so a one-character drift silently changes what every retry is graded against and
  // makes two eras of the log incomparable. These are the exact former outputs.
  assert.equal(
    describeExteriorRequest({ timeOfDay: 'goldenHour', sky: 'clearBlue' }),
    'Enhance this exterior property photo: golden-hour light, a clear blue sky',
  );
  assert.equal(
    describeExteriorRequest({ timeOfDay: 'morning' }),
    'Enhance this exterior property photo: mid-morning light',
  );
  assert.equal(
    describeExteriorRequest({ timeOfDay: 'midday', sky: 'lightClouds', removeVehicles: true }),
    'Enhance this exterior property photo: bright midday sun, a blue sky with light clouds, parked vehicles removed',
  );
  assert.equal(
    describeExteriorRequest({ timeOfDay: 'dusk', sky: 'dramatic', removeClutter: true }),
    'Enhance this exterior property photo: dusk / twilight, a dramatic sky, temporary clutter removed',
  );
  assert.equal(
    describeExteriorRequest({}),
    'Enhance this exterior property photo with a light, natural correction pass',
  );
});

test('the summary reads the removals back in the order the panel lists them', () => {
  // The summary is what the QA reviewer is told the user asked for and what lands in the
  // CSV prompt log, so its order is not cosmetic — it is how a row is read months later.
  // Pinned as a whole string rather than five `match`es because the failure worth catching
  // is a reordering, which every individual substring assertion passes.
  assert.equal(
    describeExteriorRequest({
      removeVehicles: true, removeClutter: true, removePeople: true, removeSnow: true, removeWetWeather: true,
    }),
    'Enhance this exterior property photo: parked vehicles removed, temporary clutter removed, '
    + 'people removed, snow cleared, rain and wet ground dried off',
  );
  assert.equal(
    describeExteriorRequest({ timeOfDay: 'goldenHour', removeSnow: true }),
    'Enhance this exterior property photo: golden-hour light, snow cleared',
  );
});

// ---- describeExteriorQualifier (the gallery name) ---------------------------

test('the qualifier is a NAME, not a sentence fragment', () => {
  // "Exterior — a clear blue sky" would be wrong on a card; "Exterior — Clear sky" is not.
  assert.equal(describeExteriorQualifier({ timeOfDay: 'goldenHour' }), 'Golden hour');
  assert.equal(describeExteriorQualifier({ timeOfDay: 'dusk', sky: 'clearBlue' }), 'Dusk, clear sky');
  assert.equal(describeExteriorQualifier({ sky: 'clearBlue' }), 'Clear sky', 'sky alone is capitalised');
  assert.equal(describeExteriorQualifier({ sky: 'dramatic' }), 'Dramatic sky');
});

test('the qualifier falls back to a cleanup flag, but never stacks four terms', () => {
  assert.equal(describeExteriorQualifier({ removeVehicles: true }), 'Vehicles removed');
  assert.equal(describeExteriorQualifier({ removeClutter: true }), 'Clutter removed');
  assert.equal(describeExteriorQualifier({ removePeople: true }), 'People removed');
  assert.equal(describeExteriorQualifier({ removeSnow: true }), 'Snow cleared');
  assert.equal(describeExteriorQualifier({ removeWetWeather: true }), 'Rain removed');
  assert.equal(
    describeExteriorQualifier({ timeOfDay: 'goldenHour', removeVehicles: true, removeClutter: true }),
    'Golden hour',
    'the relight is the more distinguishing fact, and the card has one line',
  );
});

test('the qualifier names ONE removal even when five were asked for', () => {
  // The card has a single line. "Exterior — vehicles removed, clutter removed, people
  // removed, snow cleared, dried off" distinguishes nothing, because it stops fitting long
  // before it stops being true. First flag in panel order wins.
  assert.equal(
    describeExteriorQualifier({
      removeVehicles: true, removeClutter: true, removePeople: true, removeSnow: true, removeWetWeather: true,
    }),
    'Vehicles removed',
  );
  assert.equal(
    describeExteriorQualifier({ removeSnow: true, removeWetWeather: true }),
    'Snow cleared',
    'and the winner is the first ENABLED one, not simply the first in the table',
  );
});

test('DRIFT GUARD: every removal that has a prompt clause also has BOTH labels', () => {
  // The same pairing the presets have, and it exists for a sharper reason. Adding a key to
  // CLEANUP_CLAUSES wires it into buildExteriorPrompt automatically — so a sixth removal
  // would reach the model, cost money and change the photo while the QA summary, the CSV
  // row and the gallery card all reported that nothing of the sort had been requested.
  // Loud here, or silent forever.
  for (const [key, clause] of Object.entries(CLEANUP_CLAUSES)) {
    assert.ok(clause, `${key} has no prompt clause`);
    const labels = CLEANUP_LABELS[key];
    assert.ok(labels, `CLEANUP_CLAUSES.${key} has no entry in CLEANUP_LABELS`);
    assert.ok(labels.phrase, `CLEANUP_LABELS.${key} has no phrase`);
    assert.ok(labels.title, `CLEANUP_LABELS.${key} has no title`);
    // The phrase is prose inside "Enhance this exterior property photo: …" and the title is
    // a name on a card. Identical strings usually mean one was pasted into the other and
    // one of the two registers is now wrong — but `people removed` is legitimately both,
    // so this can only assert they are each shaped right, not that they differ.
    assert.equal(labels.phrase, labels.phrase.trim(), `CLEANUP_LABELS.${key}.phrase has stray whitespace`);
    assert.equal(labels.title[0], labels.title[0].toLowerCase(), `CLEANUP_LABELS.${key}.title must be lower-case — the qualifier capitalises it`);
  }
});

test('DRIFT GUARD: no removal label exists for a flag that was retired', () => {
  for (const key of Object.keys(CLEANUP_LABELS)) {
    assert.ok(key in CLEANUP_CLAUSES, `CLEANUP_LABELS.${key} names a removal that no longer exists`);
  }
});

test('the qualifier is empty when nothing was opted into, leaving the name "Exterior"', () => {
  // Which is exactly what every exterior render was called before this existed — so the
  // do-nothing request is the one case with no behaviour change at all.
  assert.equal(describeExteriorQualifier({}), '');
  assert.equal(describeExteriorQualifier({ timeOfDay: 'keep', sky: 'keep' }), '');
  assert.equal(describeExteriorQualifier(), '');
});

test('an unknown option key degrades to silence rather than throwing', () => {
  // Same posture as the prompt builders: this runs on a paid render path.
  assert.equal(describeExteriorQualifier({ timeOfDay: 'midnight', sky: 'aurora' }), '');
  assert.equal(describeExteriorQualifier({ timeOfDay: /** @type {any} */ (7) }), '');
});

test('DRIFT GUARD: every preset that has a prompt clause also has BOTH labels', () => {
  // This is what makes "no fourth label table" safe. A fifth sky preset added with a clause
  // but no name would otherwise ship silently and be called "Exterior" like everything was
  // before — the exact bug the qualifier exists to fix.
  for (const [key, clause] of Object.entries(TIME_OF_DAY_PRESETS)) {
    if (key === 'keep') {
      assert.equal(TIME_OF_DAY_LABELS[key], undefined, 'keep contributes silence, so it has no labels');
      continue;
    }
    assert.ok(clause, `${key} has no prompt clause`);
    const labels = TIME_OF_DAY_LABELS[key];
    assert.ok(labels, `TIME_OF_DAY_PRESETS.${key} has no entry in TIME_OF_DAY_LABELS`);
    assert.ok(labels.phrase, `TIME_OF_DAY_LABELS.${key} has no phrase`);
    assert.ok(labels.title, `TIME_OF_DAY_LABELS.${key} has no title`);
  }
  for (const [key, clause] of Object.entries(SKY_PRESETS)) {
    if (key === 'keep') {
      assert.equal(SKY_LABELS[key], undefined, 'keep contributes silence, so it has no labels');
      continue;
    }
    assert.ok(clause, `${key} has no prompt clause`);
    const labels = SKY_LABELS[key];
    assert.ok(labels, `SKY_PRESETS.${key} has no entry in SKY_LABELS`);
    assert.ok(labels.phrase, `SKY_LABELS.${key} has no phrase`);
    assert.ok(labels.title, `SKY_LABELS.${key} has no title`);
  }
});

test('DRIFT GUARD: no label exists for a preset that was removed', () => {
  // The other direction — a retired preset leaving a name behind that nothing can select.
  for (const key of Object.keys(TIME_OF_DAY_LABELS)) {
    assert.ok(key in TIME_OF_DAY_PRESETS, `TIME_OF_DAY_LABELS.${key} names a preset that no longer exists`);
  }
  for (const key of Object.keys(SKY_LABELS)) {
    assert.ok(key in SKY_PRESETS, `SKY_LABELS.${key} names a preset that no longer exists`);
  }
});

// ---- The upload gate -------------------------------------------------------

test('the exterior check prompt never offers the VEHICLE digit', () => {
  // The single most likely false rejection this feature has. A house photographed from
  // the kerb with a car on the drive is the canonical input, and the interior taxonomy's
  // `5` exists to reject exactly that framing.
  assert.equal(UNSTAGEABLE_CODES['5'].code, 'VEHICLE', 'sanity: 5 is still VEHICLE upstream');
  assert.ok(!/^5 =/m.test(EXTERIOR_CHECK_PROMPT), 'the exterior gate must not list digit 5');
  assert.ok(EXTERIOR_IGNORED_CODES.has('5'), 'and must drop it even if the grader answers it anyway');
});

test('the check prompt keeps the SHARED digit meanings for every code it does list', () => {
  // unstageable.js's header warns that a prompt drifting from its taxonomy silently
  // mislabels rejections ("the model says 4 = document, we tell the user vehicle"). Two
  // prompts now feed one table, so this pins that every digit the exterior gate offers
  // still means what the table says it means.
  const listed = [...EXTERIOR_CHECK_PROMPT.matchAll(/^(\d) = (.+)$/gm)].map((m) => [m[1], m[2].toLowerCase()]);
  const expectations = { 1: 'person', 2: 'animal', 3: 'food', 4: 'screenshot', 6: 'other object' };
  for (const [digit, text] of listed) {
    if (digit === '0') continue;
    assert.ok(expectations[digit], `digit ${digit} is not part of the shared taxonomy`);
    assert.ok(text.includes(expectations[digit]), `digit ${digit} must still mean "${expectations[digit]}"`);
  }
  assert.deepEqual(
    listed.map(([d]) => d).filter((d) => d !== '0').sort(),
    ['1', '2', '3', '4', '6'],
    'exactly the shared codes minus VEHICLE',
  );
});

test('the check prompt says clutter and cars are NOT grounds for rejection', () => {
  // Belt and braces on the same failure: the accept-list has to be explicit, because a
  // grader reading "enhances exterior photographs" could reasonably conclude a frame
  // dominated by a parked car is off-topic.
  const text = EXTERIOR_CHECK_PROMPT.toLowerCase();
  assert.ok(text.includes('parked cars'), 'the prompt must whitelist parked cars explicitly');
  assert.match(EXTERIOR_CHECK_PROMPT, /unsure/i, 'and must still fail open when unsure');
});

// ---- The QA rubric ---------------------------------------------------------

test('the exterior review prompt keeps the reply format the retry loop parses', () => {
  // staging-pipeline.js reads PERFECT/SCORE and folds WHY back into the next attempt.
  // A rubric that reworded these would make every render score 0 and burn its full
  // retry budget — expensively, and silently.
  assert.match(EXTERIOR_REVIEW_PROMPT, /"PERFECT: true"/);
  assert.match(EXTERIOR_REVIEW_PROMPT, /"PERFECT: false"/);
  assert.match(EXTERIOR_REVIEW_PROMPT, /"SCORE: <0-100>"/);
});

test('the exterior rubric grades the edit, not the property', () => {
  // The failure mode worth naming: a reviewer that treats a worn driveway or a car left
  // in frame as a defect fails every honest render and retries until the model starts
  // "fixing" the property — which is the one thing the preservation rules forbid.
  assert.match(EXTERIOR_REVIEW_PROMPT, /do NOT judge the property itself/i);
  assert.match(EXTERIOR_REVIEW_PROMPT, /exterior/i);
  // And it must name the defects this edit actually produces, which the interior rubric
  // says nothing about.
  for (const defect of ['halo', 'roofline', 'shadow']) {
    assert.ok(EXTERIOR_REVIEW_PROMPT.toLowerCase().includes(defect), `the rubric must mention "${defect}"`);
  }
});
