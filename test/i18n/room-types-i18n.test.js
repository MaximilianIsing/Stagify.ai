// Drift guard across the three places a room type has to exist at once:
// the dropdown in public/index.html, the prompt matrix the server stages from
// (lib/staging/promptMatrix.js), and the 11 language packs.
//
// None of these fail loudly on their own. An option with no matrix entry silently
// falls back to a generic "Stage this X professionally"; a missing roomTypes key
// leaves the option showing the English fallback baked into the markup. Both ship
// looking fine, which is why this is a test and not a convention — same spirit as
// the rejection-code guard in unstageable-i18n.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOCALES } from '../../lib/i18n/locales.js';
import { promptMatrix } from '../../lib/staging/promptMatrix.js';
import { DESIGNER_ROUTING_SCHEMA } from '../../lib/staging/prompts.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LANG_DIR = path.join(ROOT, 'public', 'languages');

// English is served statically at the root rather than via a LOCALES entry, so it is
// not in that list — but it needs the keys like every other pack.
const LANGS = [...new Set(['english', ...LOCALES.map((l) => l.lang)])];
const packFor = (lang) => JSON.parse(fs.readFileSync(path.join(LANG_DIR, `${lang}.json`), 'utf8'));

/** 'Living room' -> 'livingRoom', matching the roomTypes key scheme in the packs. */
const langKeyFor = (room) =>
  room
    .split(/\s+/)
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join('');

/** The room-type dropdown options as authored in index.html, in document order. */
function dropdownOptions() {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const menu = html.match(/<div id="room-type-select"[\s\S]*?<div class="select-menu[\s\S]*?<\/div>\s*<\/div>/);
  assert.ok(menu, 'could not locate the #room-type-select menu in index.html');
  return [...menu[0].matchAll(/<div class="option[^"]*"\s+data-value="([^"]+)"/g)].map((m) => m[1]);
}

test('every dropdown room type has a prompt-matrix entry', () => {
  for (const room of dropdownOptions()) {
    assert.ok(promptMatrix[room], `index.html offers "${room}" but promptMatrix has no entry for it`);
  }
});

test('every prompt-matrix room type is offered in the dropdown', () => {
  // A matrix entry nobody can select is dead weight; more importantly it usually means
  // a room type was added to the backend and the UI half was forgotten.
  const offered = new Set(dropdownOptions());
  for (const room of Object.keys(promptMatrix)) {
    assert.ok(offered.has(room), `promptMatrix has "${room}" but index.html does not offer it`);
  }
});

/** The AI Designer's routing tool enum — the chat path's view of the room types. */
const routingEnum = () => {
  const e = DESIGNER_ROUTING_SCHEMA?.properties?.staging?.items?.properties?.roomType?.enum;
  assert.ok(Array.isArray(e), 'could not read roomType enum out of DESIGNER_ROUTING_SCHEMA');
  return e;
};

test('every prompt-matrix room type is reachable from the AI Designer chat', () => {
  // This is the failure that hides best: a room type absent from the routing enum is
  // not rejected, the model just picks "Other" instead — which has no matrix entry, so
  // the request quietly stages from the generic prompt with none of the room's rules.
  // ("Outdoors" sat in exactly that state until this guard was added.)
  const routable = new Set(routingEnum());
  for (const room of Object.keys(promptMatrix)) {
    assert.ok(routable.has(room), `promptMatrix has "${room}" but the chat routing enum cannot select it`);
  }
});

test('the routing enum adds nothing beyond the matrix except the Other escape hatch', () => {
  // 'Other' is deliberately routing-only: it is how the model says "a room we do not
  // have a template for". Anything ELSE extra is a typo or a stale rename, and would
  // route real requests to a matrix miss.
  const known = new Set([...Object.keys(promptMatrix), 'Other']);
  for (const room of routingEnum()) {
    assert.ok(known.has(room), `routing enum offers "${room}" but promptMatrix has no entry for it`);
  }
});

test('the prose contract in the chat system instructions matches the routing enum', () => {
  // The enum is sent as a JSON schema, but the same list is ALSO spelled out in prose in
  // both system instructions. Models follow the prose; if the two disagree the schema
  // wins silently and the prose becomes a lie that misroutes requests.
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'staging', 'prompts.js'), 'utf8');
  const prose = [...src.matchAll(/"roomType": ((?:"[^"]+"\|)+"[^"]+")/g)];
  assert.ok(prose.length >= 2, 'expected the roomType prose contract in both system instructions');
  for (const [, list] of prose) {
    const named = list.split('|').map((s) => s.replace(/"/g, ''));
    assert.deepEqual(named, routingEnum(), 'prose room-type list drifted from DESIGNER_ROUTING_SCHEMA');
  }
});

test('every language pack names every room type', () => {
  for (const lang of LANGS) {
    const block = packFor(lang).roomTypes;
    assert.ok(block, `${lang}.json has no roomTypes block`);
    for (const room of Object.keys(promptMatrix)) {
      const key = langKeyFor(room);
      assert.equal(typeof block[key], 'string', `${lang}.json is missing roomTypes.${key} (for "${room}")`);
      assert.ok(block[key].trim().length > 0, `${lang}.json has an empty roomTypes.${key}`);
    }
  }
});

test('no language pack carries a room type the app cannot stage', () => {
  const known = new Set(Object.keys(promptMatrix).map(langKeyFor));
  for (const lang of LANGS) {
    for (const key of Object.keys(packFor(lang).roomTypes)) {
      assert.ok(known.has(key), `${lang}.json has stale roomTypes.${key}`);
    }
  }
});

test('every language pack translates the "New" option badge', () => {
  // The badge is markup-driven (data-lang="common.newBadge"); a missing key leaves the
  // English "New" sitting in an otherwise fully translated dropdown.
  for (const lang of LANGS) {
    const value = packFor(lang).common?.newBadge;
    assert.equal(typeof value, 'string', `${lang}.json is missing common.newBadge`);
    assert.ok(value.trim().length > 0, `${lang}.json has an empty common.newBadge`);
  }
});
