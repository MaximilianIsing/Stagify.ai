// Tier: drift guard — the Exterior Studio's option vocabulary, across the THREE places it
// has to agree at once.
//
// A preset is three things that never meet in the same file:
//   1. an <option value="…"> in public/exterior-studio.html — the wire value,
//   2. a clause keyed by that same string in lib/staging/exterior-prompts.js,
//   3. a label at exteriorStudio.time.<key> in eleven language packs.
//
// NONE OF THEM FAILS LOUDLY ALONE, which is the entire reason this file exists — the same
// reasoning that produced test/i18n/room-types-i18n.test.js after `Outdoors` sat in the
// prompt matrix and the dropdown but not the routing enum, silently rerouting every patio
// request for months.
//
// The specific failure modes here:
//   • an option whose value has no clause resolves to '' in clauseFrom() and the render
//     comes back looking almost right — the user picked "Golden hour" and got a light
//     correction pass, with nothing anywhere reporting a problem;
//   • a clause with no option is a prompt nobody can reach;
//   • a label missing from a pack renders as the raw English inside an otherwise
//     translated control, and static.test.js's coverage check only sees keys that exist
//     in english.json, so adding an option WITHOUT its label passes that check too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIME_OF_DAY_PRESETS, SKY_PRESETS, CLEANUP_CLAUSES } from '../../lib/staging/exterior-prompts.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'exterior-studio.html'), 'utf8');

/** Pull one <select>'s options out of the page as {value, langKey, selected}. */
function optionsOf(selectId) {
  const open = html.indexOf(`id="${selectId}"`);
  assert.notEqual(open, -1, `#${selectId} is missing from exterior-studio.html`);
  const end = html.indexOf('</select>', open);
  assert.notEqual(end, -1, `#${selectId} is not closed`);
  const block = html.slice(open, end);
  return [...block.matchAll(/<option value="([^"]+)"([^>]*)>/g)].map((m) => ({
    value: m[1],
    langKey: /data-lang="([^"]+)"/.exec(m[2])?.[1] || null,
    selected: /\sselected(?=[\s>])/.test(m[2]),
  }));
}

/**
 * Is a bare boolean attribute present in a captured attribute string?
 *
 * A helper rather than an inline regex per site, because the capture from `([^>]*)` stops
 * BEFORE the closing `>` — so a lookahead for `[\s>]` finds nothing when the attribute is
 * last, which is exactly where `hidden` and `disabled` are usually written.
 */
const hasAttr = (attrs, name) => new RegExp(`\\s${name}(?=[\\s>]|$)`).test(attrs);

const packs = fs.readdirSync(path.join(PUBLIC, 'languages')).filter((f) => f.endsWith('.json'));
const lookup = (pack, key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), pack);

/** Assert a key resolves to a non-empty string in every language pack. */
function assertTranslatedEverywhere(key) {
  for (const file of packs) {
    const pack = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'languages', file), 'utf8'));
    const value = lookup(pack, key);
    assert.equal(typeof value, 'string', `${file} is missing ${key}`);
    assert.ok(value.trim(), `${file} has an empty ${key}`);
  }
}

test('sanity: eleven packs, and the page still has both selects', () => {
  // Every assertion below sweeps these; if the discovery breaks they all pass vacuously.
  assert.equal(packs.length, 11, 'eleven language packs');
  assert.ok(optionsOf('ex-time').length >= 2);
  assert.ok(optionsOf('ex-sky').length >= 2);
});

for (const [name, selectId, table, ns] of [
  ['time of day', 'ex-time', TIME_OF_DAY_PRESETS, 'exteriorStudio.time'],
  ['sky', 'ex-sky', SKY_PRESETS, 'exteriorStudio.skyOptions'],
]) {
  test(`${name}: the dropdown and the prompt table list the same values, minus 'keep'`, () => {
    // `keep` is a WIRE value, not a label. The row is opt-in — an unticked checkbox is how
    // "leave this alone" is said — so offering "Keep as photographed" inside the dropdown
    // too would be the same statement twice, and the one place the two could disagree.
    const values = optionsOf(selectId).map((o) => o.value);
    assert.deepEqual(
      [...values].sort(),
      Object.keys(table).filter((k) => k !== 'keep').sort(),
      `every #${selectId} option needs a clause, and every clause except 'keep' needs an option`,
    );
    assert.equal(new Set(values).size, values.length, 'no duplicate values');
    assert.ok(!values.includes('keep'), "'keep' is expressed by the checkbox, not by an option");
  });

  test(`${name}: every option's label resolves in all eleven packs`, () => {
    for (const option of optionsOf(selectId)) {
      assert.ok(option.langKey, `${option.value} must carry a data-lang key`);
      assert.equal(option.langKey, `${ns}.${option.value}`, 'the key mirrors the wire value');
      assertTranslatedEverywhere(option.langKey);
    }
  });

  test(`${name}: the ENGLISH key is what goes on the wire, not the label`, () => {
    // The label is translated in place by language-loader, but `value` is untouched — so
    // a Spanish visitor still posts `goldenHour`. Pinning it here because the natural
    // mistake is to translate the value alongside the label, which the server then
    // silently resolves to '' and renders as a no-op.
    for (const option of optionsOf(selectId)) {
      assert.match(option.value, /^[a-z][a-zA-Z]*$/, `${option.value} must stay an ASCII camelCase key`);
      assert.ok(Object.prototype.hasOwnProperty.call(table, option.value));
    }
  });

  test(`${name}: the row is OPT-IN, and 'keep' is still the no-op it sends when off`, () => {
    // The property that makes the whole panel safe: a visitor who only wants the bins
    // gone must not also get their photo relit. The checkbox ships unchecked and its
    // sub-control ships hidden, so nothing here is requested unless it is asked for.
    const box = new RegExp(`<input type="checkbox" id="ex-use-${selectId.replace('ex-', '')}"([^>]*)>`).exec(html);
    assert.ok(box, `#${selectId} needs an opt-in checkbox`);
    assert.ok(!hasAttr(box[1], 'checked'), 'the toggle must ship OFF');
    assert.match(box[1], /data-ex-reveals="([^"]+)"/, 'and must name the body it reveals');

    const bodyId = /data-ex-reveals="([^"]+)"/.exec(box[1])[1];
    const body = new RegExp(`<div class="ex-option__body" id="${bodyId}"([^>]*)>`).exec(html);
    assert.ok(body, `the revealed body #${bodyId} must exist`);
    assert.ok(hasAttr(body[1], 'hidden'), 'and must ship hidden');

    // Exactly one preselected option, so ticking the row asks for something concrete
    // rather than whatever happened to be first.
    const selected = optionsOf(selectId).filter((o) => o.selected);
    assert.equal(selected.length, 1, 'exactly one default once the row is on');
    assert.equal(table.keep, '', "and 'keep' — what an OFF row sends — must contribute no clause");
  });
}

test('cleanup: every checkbox name has a clause, and every clause has a checkbox', () => {
  const names = [...html.matchAll(/<input type="checkbox"[^>]*\bname="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...names].sort(), Object.keys(CLEANUP_CLAUSES).sort());
});

test('cleanup: the toggles ship OFF, so nothing is removed unless it was asked for', () => {
  // These two used to ship CHECKED as a "sensible default". That made the panel do work
  // nobody requested — and worse, someone who only wanted the bins gone had to notice and
  // untick the vehicles row to avoid losing a car they wanted in frame.
  for (const name of Object.keys(CLEANUP_CLAUSES)) {
    const tag = new RegExp(`<input type="checkbox"[^>]*\\bname="${name}"([^>]*)>`).exec(html);
    assert.ok(tag, `${name} checkbox is missing`);
    assert.ok(!hasAttr(tag[1], 'checked'), `${name} must ship unchecked`);
  }
});

test('the submit button ships DISABLED', () => {
  // Nothing is selected on load, so the button must not be live: an empty request falls
  // through to the server's generic correction pass, which is a real render, really
  // billed, for an edit the visitor never asked for. The greyed-out button carries this
  // alone — the standing hint that used to sit under it was removed as clutter.
  const submit = /<button type="submit"[^>]*id="ex-enhance"([^>]*)>/.exec(html);
  assert.ok(submit, 'the submit button is missing');
  assert.ok(hasAttr(submit[1], 'disabled'), 'must ship disabled');
});

test('cleanup: every checkbox label resolves in all eleven packs', () => {
  for (const name of Object.keys(CLEANUP_CLAUSES)) {
    assertTranslatedEverywhere(`exteriorStudio.controls.${name}`);
  }
});

test('the free-text box is clamped in the markup as well as the handler', () => {
  // The server clamps to 500 regardless, so this is not a security boundary — it is the
  // difference between the textarea refusing the 501st character and the user writing a
  // paragraph that is silently truncated after they submit it.
  const textarea = /<textarea[^>]*id="ex-notes"[^>]*>/.exec(html)?.[0];
  assert.ok(textarea, 'the notes field is missing');
  assert.match(textarea, /maxlength="500"/);
  assert.match(textarea, /name="additionalPrompt"/, 'the field name the handler reads');
});

test('the page-level strings the studio needs all resolve in all eleven packs', () => {
  // Everything the markup names by key, swept from the page itself rather than listed
  // here — so a new control added tomorrow is covered the day it ships, and a key
  // renamed in the markup cannot quietly stop being checked.
  const keys = [...html.matchAll(/data-lang(?:-html|-attr)?="(exteriorStudio\.[^"|]+)/g)].map((m) => m[1]);
  assert.ok(keys.length >= 20, `expected the studio's strings, found ${keys.length}`);
  for (const key of new Set(keys)) assertTranslatedEverywhere(key);
});

test('the page meta and nav label resolve in all eleven packs', () => {
  for (const key of [
    'navigation.exteriorStudio',
    'navigation.tips.exteriorStudio',
    'pageMeta.exteriorStudio.title',
    'pageMeta.exteriorStudio.description',
    'pageMeta.exteriorStudio.keywords',
  ]) assertTranslatedEverywhere(key);
});

test('the non-English packs actually translated the option labels', () => {
  // Presence is not coverage: a pack that copied the English across passes every check
  // above while shipping an untranslated control, and that is what happens when someone
  // adds a key in a hurry. unstageable-i18n.test.js makes the same distinction for the
  // rejection copy.
  //
  // The three keys are chosen because NO language leaves any of them in English — there
  // is no "Dramatic"-style coincidence to tolerate — so this can demand that all ten
  // differ. A blanket sweep could not: several short labels (a brand name, a units
  // abbreviation) legitimately match, and a rule with an allowance is a rule a lazy
  // paste slips through, which is exactly how this assertion first failed to bite.
  const english = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'languages', 'english.json'), 'utf8'));
  const others = packs.filter((f) => f !== 'english.json');
  for (const key of ['exteriorStudio.time.goldenHour', 'exteriorStudio.actions.enhance', 'exteriorStudio.title']) {
    const en = lookup(english, key);
    const untranslated = others.filter((f) => {
      const pack = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'languages', f), 'utf8'));
      return lookup(pack, key) === en;
    });
    assert.deepEqual(untranslated, [], `${key} is still the English string in: ${untranslated.join(', ')}`);
  }
});
