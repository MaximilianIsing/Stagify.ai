// Drift guard: advertised ceilings vs the ones the server actually enforces.
//
// WHY THIS EXISTS
// Several places on the site quote a real figure that can go stale against a constant.
// Where a page names a number, this file pins it to its source of truth so the marketing
// cannot quietly start lying in eleven languages with nothing to catch it.
//
// NOTE ON THE FREE GENERATION CAP: the homepage "why us" bullet
// (whyUs.stagify.features.free) deliberately says "unlimited" while the server still
// enforces FREE_DAILY_LIMIT — a product decision (2026-08-07) extending the same call
// already made for the "Unlimited staging generations" row on stagify-plus.html, which
// is ticked in BOTH columns (2026-08-01): 50/day reads as effectively unlimited and
// naming a cap scares prospects off. So this file no longer pins that bullet to the
// figure. What it pins instead is the INVERSE — that no pack reintroduces a number
// there — because a figure in that bullet is read as a ceiling whatever it says, and a
// stale one is the exact failure this file exists to catch. If you want the honest cap
// back on the page, change the copy AND flip these two tests together.
//
// The gallery row on stagify-plus.html quotes a real figure in the FREE column, so it
// can go stale against lib/data/staged-renders.js. Pinned at the bottom of this file —
// including the exactness of the figure, since 10 is a ceiling and anything like "10+"
// would invert its meaning.
//
// The Stagify+ column of that row says "Unlimited" (2026-08-03), and that is a claim
// about the SERVER, not a bigger number: PRO_GALLERY_LIMIT defaults to Infinity, so
// nothing is ever evicted from a paid gallery. Restoring a finite default would make the
// page a lie in eleven languages, which is exactly the failure this file exists to catch,
// so the pro half is pinned to the absence of a numeric default rather than to a value.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const LANGS = path.join(PUBLIC, 'languages');

/** Resolve a dotted key in a language pack. */
function at(json, dotted) {
  return dotted.split('.').reduce((node, key) => (node == null ? node : node[key]), json);
}

const packs = () =>
  fs.readdirSync(LANGS)
    .filter((f) => f.endsWith('.json'))
    .map((name) => ({ name, json: JSON.parse(fs.readFileSync(path.join(LANGS, name), 'utf8')) }));

test('no language pack quotes a generation figure in the free bullet', () => {
  // The bullet says "unlimited" on purpose (see the header). A pack that "translated" it
  // back to a number would advertise a ceiling — and, worse, one that goes stale against
  // FREE_DAILY_LIMIT the moment that constant moves. No cross-pack parity guard covers
  // the whyUs namespace either, so the presence check has to live here too.
  const all = packs();
  assert.ok(all.length >= 11, `expected 11 language packs, found ${all.length}`);

  for (const { name, json } of all) {
    const line = at(json, 'whyUs.stagify.features.free');
    assert.equal(typeof line, 'string', `${name} is missing whyUs.stagify.features.free`);
    assert.ok(line.trim().length > 0, `${name} has an empty whyUs.stagify.features.free`);
    assert.doesNotMatch(
      line,
      /\d/,
      `${name} says "${line}" — a figure in the free bullet advertises a daily ceiling. ` +
        'The copy is deliberately "unlimited"; see the header of this file.',
    );
  }
});

test('the English markup fallback makes the same claim as the packs', () => {
  // data-lang-html overwrites this at runtime, but it is what ships before the pack
  // loads — and it drifted from the pack once already.
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const row = /whyUs\.stagify\.features\.free[^>]*>\s*<strong>([^<]*)<\/strong>/.exec(html);
  assert.ok(row, "index.html no longer has a whyUs.stagify.features.free bullet with a <strong> lead-in");
  assert.doesNotMatch(
    row[1],
    /\d/,
    `index.html's free-tier bullet leads with "${row[1]}" — a figure there contradicts the packs`,
  );
});

/**
 * The gallery source, with its comments stripped.
 *
 * Both constants are discussed at length in prose directly above themselves — including
 * the literal text `Number(process.env.PRO_GALLERY_LIMIT) || Infinity` — so a guard that
 * scanned the raw file would happily match a sentence describing the code rather than the
 * code, and would keep passing after the declaration itself changed. Anchoring every
 * pattern below at a line start would also do it (JSDoc lines begin with ` *`), but
 * stripping is the assertion that does not quietly depend on how a comment is indented.
 */
function gallerySource() {
  return fs
    .readFileSync(path.join(ROOT, 'lib', 'data', 'staged-renders.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * The free gallery cap's default, read from the source of truth. Only the DEFAULT can be
 * pinned — the constant is `Number(process.env.X) || <default>`, so an operator who
 * overrides the env var makes the page stale in a way no test can see. That is the
 * accepted cost of the env override; the literal is what ships, and it is what drifts.
 */
function freeGalleryLimit() {
  const m = /export const FREE_GALLERY_LIMIT = Number\(process\.env\.FREE_GALLERY_LIMIT\) \|\| (\d+);/
    .exec(gallerySource());
  assert.ok(m, 'FREE_GALLERY_LIMIT is no longer a literal default in lib/data/staged-renders.js — update this guard');
  return Number(m[1]);
}

test('the compare table matches the gallery ceilings the server actually enforces', () => {
  const free = freeGalleryLimit();

  // The pro half. `Infinity` is the whole claim — a finite default, however large, means
  // a paid gallery does evict and the word "Unlimited" on the page is false.
  assert.match(
    gallerySource(),
    /export const PRO_GALLERY_LIMIT = Number\(process\.env\.PRO_GALLERY_LIMIT\) \|\| Infinity;/,
    'PRO_GALLERY_LIMIT no longer defaults to Infinity, but stagify-plus.html still advertises ' +
      'an unlimited Stagify+ gallery. Change the page, or change it back.',
  );

  // Comments stripped first: a commented-out row still contains every token this
  // matches on, so scanning the raw file would pass with the row invisible on the page.
  const html = fs.readFileSync(path.join(PUBLIC, 'stagify-plus.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const row = /stagifyPlus\.compare\.rows\.gallery[\s\S]{0,400}?<\/tr>/.exec(html);
  assert.ok(row, 'stagify-plus.html no longer has a gallery row in the compare table');

  const cells = [...row[0].matchAll(/<span class="sp-value[^"]*"([^>]*)>([^<]+)<\/span>/g)];
  assert.equal(cells.length, 2, 'the gallery row should have exactly two value cells, free then Stagify+');

  assert.equal(
    Number(cells[0][2]),
    free,
    `the gallery row advertises ${cells[0][2]} for the free tier but the server enforces ` +
      `${free} — see lib/data/staged-renders.js.`,
  );

  // The pro cell must be the localized word, NOT a figure: a number there would be read
  // as a ceiling whatever it said, and would go stale against a constant that no longer
  // has a value to go stale against.
  assert.match(
    cells[1][1],
    /data-lang="stagifyPlus\.compare\.unlimitedValue"/,
    'the Stagify+ gallery cell must carry data-lang="stagifyPlus.compare.unlimitedValue", ' +
      'or it ships in English to ten other languages',
  );
  assert.doesNotMatch(
    cells[1][2],
    /\d/,
    `the Stagify+ gallery cell says "${cells[1][2]}" — a figure there advertises a ceiling ` +
      'the server does not enforce',
  );
});

test('every language pack labels the gallery row and its Stagify+ value', () => {
  // No cross-pack parity guard covers the stagifyPlus namespace, so a key added to
  // english.json alone ships green and the row renders untranslated in ten languages.
  // Both keys of the row are checked: the label was the only translated part until the
  // Stagify+ cell stopped being a language-neutral figure and became a word.
  const all = packs();
  assert.ok(all.length >= 11, `expected 11 language packs, found ${all.length}`);

  for (const { name, json } of all) {
    for (const key of ['stagifyPlus.compare.rows.gallery', 'stagifyPlus.compare.unlimitedValue']) {
      const value = at(json, key);
      assert.equal(typeof value, 'string', `${name} is missing ${key} — it falls back to English there`);
      assert.ok(value.trim().length > 0, `${name} has an empty ${key}`);
    }
  }
});

test('no pack translates the unlimited gallery value as a number', () => {
  // The point of the cell is that there is no figure. A pack that "translated" it back to
  // 200 would restore exactly the claim the server stopped making, and the English-only
  // markup check above cannot see it.
  for (const { name, json } of packs()) {
    assert.doesNotMatch(
      String(at(json, 'stagifyPlus.compare.unlimitedValue')),
      /\d/,
      `${name} quotes a figure for stagifyPlus.compare.unlimitedValue — the Stagify+ gallery has no ceiling`,
    );
  }
});

// REMOVED (2026-08-07): 'no page still claims unlimited generations are free'. It banned
// the homepage from advertising unlimited free generations, which is now the deliberate
// copy — the assertion had survived only because its regex matched the old exact wording
// ("Unlimited generations: Totally free") and not the new one, i.e. it was passing by
// accident, not by agreement. Reinstating it means reversing the product decision in the
// header of this file.
