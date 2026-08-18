// The homepage hero's "Added in this render" list.
//
// The list under the hero photo names what the AI actually put into THAT render, and the
// hero photo changes every time a visitor touches either dropdown — so the list is 48
// separate lists of five, one per room/style pair the picker can reach, in each of the 11
// language packs. scripts/hero-picker.js paints it from hero.added.items.<style>.<room>.
//
// That shape is what this file exists for. Nothing about it fails loudly on its own:
//
//   - A MISSING COMBINATION is invisible in the pack-coverage gate in test/server/static.test.js,
//     because flattenKeys() treats an array as a leaf. It only shows up as a list that goes
//     blank when a visitor picks that one pair, on the one page that matters most.
//   - ADDING A ROOM OR A STYLE to hero-picker.js generates a new render and a new menu row,
//     and silently no list to go with it. So the room and style key sets are read back out
//     of hero-picker.js rather than restated here — the picker is the source of truth, and
//     this fails the moment the two disagree.
//   - THE FIVE KEYS IN THE MARKUP (hero.added.item1..item5) are a second copy of the default
//     pair's list, kept because index.html has to ship something readable for the no-JS case
//     and for a locale page whose pack has not resolved yet. Two copies of a string in 11
//     files is a drift waiting to happen, so the copy is pinned instead of trusted.
//
// The lists themselves are prose about a photograph and cannot be machine-checked against
// one. What can be checked is that each exists, is the right shape, and is not a duplicate
// of its neighbour — which is what a half-finished fill-in looks like.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PACKS = path.join(ROOT, 'public', 'languages');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const ITEMS_PER_LIST = 5;

const packFiles = fs.readdirSync(PACKS).filter((f) => f.endsWith('.json')).sort();
const packs = Object.fromEntries(
  packFiles.map((f) => [f, JSON.parse(fs.readFileSync(path.join(PACKS, f), 'utf8'))]),
);

// hero-picker.js is a browser module with no imports and no exports, so it cannot be
// imported here; it is read as text. Comments are stripped FIRST — the block above ROOMS
// discusses the two room types that are deliberately absent, and the one above STYLES
// discusses how `custom` is generated, both in prose that names keys.
const pickerSrc = read('public', 'scripts', 'hero-picker.js')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** Every `key: '...'` inside the named const's array literal, in declaration order. */
function keysOf(name) {
  const at = pickerSrc.indexOf(`const ${name} = [`);
  assert.notEqual(at, -1, `hero-picker.js should declare ${name}`);
  const end = pickerSrc.indexOf('];', at);
  assert.notEqual(end, -1, `${name} should be a closed array literal`);
  const keys = [...pickerSrc.slice(at, end).matchAll(/\bkey:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(keys.length > 0, `${name} should list at least one key`);
  return keys;
}

const STYLES = keysOf('STYLES');
const ROOMS = keysOf('ROOMS');

const defaultOf = (name) => {
  const m = pickerSrc.match(new RegExp(`const ${name} = '([^']+)'`));
  assert.ok(m, `hero-picker.js should declare ${name}`);
  return m[1];
};
const DEFAULT_ROOM = defaultOf('DEFAULT_ROOM');
const DEFAULT_STYLE = defaultOf('DEFAULT_STYLE');

test('the picker offers the pairs this file thinks it does', () => {
  assert.ok(STYLES.includes(DEFAULT_STYLE), `DEFAULT_STYLE ${DEFAULT_STYLE} is not in STYLES`);
  assert.ok(ROOMS.includes(DEFAULT_ROOM), `DEFAULT_ROOM ${DEFAULT_ROOM} is not in ROOMS`);
  assert.equal(new Set(STYLES).size, STYLES.length, 'STYLES has a duplicate key');
  assert.equal(new Set(ROOMS).size, ROOMS.length, 'ROOMS has a duplicate key');
});

test('every pack carries a five-item list for every room/style pair', () => {
  const problems = [];
  for (const [file, pack] of Object.entries(packs)) {
    const items = pack?.hero?.added?.items;
    if (!items || typeof items !== 'object') {
      problems.push(`${file}: no hero.added.items`);
      continue;
    }
    const extraStyles = Object.keys(items).filter((s) => !STYLES.includes(s));
    if (extraStyles.length) problems.push(`${file}: unknown style(s) ${extraStyles.join(', ')}`);
    for (const style of STYLES) {
      const byRoom = items[style];
      if (!byRoom || typeof byRoom !== 'object') {
        problems.push(`${file}: hero.added.items.${style} missing`);
        continue;
      }
      const extraRooms = Object.keys(byRoom).filter((r) => !ROOMS.includes(r));
      if (extraRooms.length) problems.push(`${file}: ${style} has unknown room(s) ${extraRooms.join(', ')}`);
      for (const room of ROOMS) {
        const list = byRoom[room];
        const where = `${file}: ${style}.${room}`;
        if (!Array.isArray(list)) { problems.push(`${where} is not an array`); continue; }
        if (list.length !== ITEMS_PER_LIST) problems.push(`${where} has ${list.length} items, want ${ITEMS_PER_LIST}`);
        if (list.some((v) => typeof v !== 'string' || !v.trim())) problems.push(`${where} has a blank or non-string item`);
        if (new Set(list).size !== list.length) problems.push(`${where} repeats an item`);
      }
    }
  }
  assert.deepEqual(problems, [], `hero.added.items gaps:\n${problems.join('\n')}`);
});

// A list copy-pasted from the pair next door is the failure mode of filling 48 of these in
// by hand, and it is the one a reader notices immediately: the picture changes and the
// words do not. English only — a translator legitimately collapses distinctions the source
// draws (a language with one word for "sofa" and "settee" will land on it twice), and
// failing their build over that would be an invitation to pad.
test('no two English lists are identical', () => {
  const seen = new Map();
  const clashes = [];
  const items = packs['english.json'].hero.added.items;
  for (const style of STYLES) {
    for (const room of ROOMS) {
      const fingerprint = items[style][room].join('|');
      if (seen.has(fingerprint)) clashes.push(`${style}.${room} duplicates ${seen.get(fingerprint)}`);
      else seen.set(fingerprint, `${style}.${room}`);
    }
  }
  assert.deepEqual(clashes, [], `duplicate hero lists:\n${clashes.join('\n')}`);
});

// Every pair the picker offers has to have a render behind it too, or the list describes a
// photo that 404s. hero-picker.js builds the filename as <style>-<room>.webp off the `slug`
// fields, which is why the slugs are read rather than derived from the keys.
test('every pair named in the packs has a render on disk', () => {
  const slug = (name, key) => {
    const at = pickerSrc.indexOf(`const ${name} = [`);
    const row = pickerSrc.slice(at, pickerSrc.indexOf('];', at))
      .split('\n')
      .find((l) => l.includes(`key: '${key}'`));
    const m = row && row.match(/slug:\s*'([^']+)'/);
    return m ? m[1] : key;
  };
  const missing = [];
  for (const style of STYLES) {
    for (const room of ROOMS) {
      const file = `${slug('STYLES', style)}-${slug('ROOMS', room)}.webp`;
      if (!fs.existsSync(path.join(ROOT, 'public', 'media-webp', 'example', file))) missing.push(file);
    }
  }
  assert.deepEqual(missing, [], `renders missing for pairs with lists: ${missing.join(', ')}`);
});

// The two copies of the default pair's list: the numbered keys the markup reads, and the
// entry in the matrix the script reads. They are the same five strings or the list changes
// the moment JavaScript takes over, which reads as a flicker for no reason.
test('hero.added.item1..5 is the default pair\'s list, in every pack', () => {
  const problems = [];
  for (const [file, pack] of Object.entries(packs)) {
    const added = pack?.hero?.added;
    const canonical = added?.items?.[DEFAULT_STYLE]?.[DEFAULT_ROOM];
    if (!Array.isArray(canonical)) continue; // already reported by the shape test above
    for (let i = 0; i < ITEMS_PER_LIST; i++) {
      const key = `item${i + 1}`;
      if (added[key] !== canonical[i]) {
        problems.push(`${file}: hero.added.${key} is ${JSON.stringify(added[key])}, want ${JSON.stringify(canonical[i])}`);
      }
    }
  }
  assert.deepEqual(problems, [], `default-pair list drift:\n${problems.join('\n')}`);
});

// And the third copy, the one in the document. index.html ships the five <li> as visible
// English text because that is what a crawler and a no-JS visitor get.
test('index.html ships the default pair\'s five items as its fallback text', () => {
  const html = read('public', 'index.html');
  const block = html.match(/<ul class="hp-added__list">([\s\S]*?)<\/ul>/);
  assert.ok(block, 'index.html should contain the .hp-added__list <ul>');

  const rows = [...block[1].matchAll(/<li data-lang="hero\.added\.(item\d)">([^<]*)<\/li>/g)];
  assert.equal(rows.length, ITEMS_PER_LIST, `expected ${ITEMS_PER_LIST} <li data-lang="hero.added.itemN">`);

  const english = packs['english.json'].hero.added;
  rows.forEach(([, key, text], i) => {
    assert.equal(key, `item${i + 1}`, 'the five items should be item1..item5, in order');
    assert.equal(text, english[key], `<li> text disagrees with english.json hero.added.${key}`);
  });
});
