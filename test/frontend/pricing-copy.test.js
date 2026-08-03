// Drift guard: the free tier's advertised cap vs the one the server actually enforces.
//
// WHY THIS EXISTS
// The homepage used to say "Unlimited generations: Totally free", which was simply
// untrue — free is capped at FREE_DAILY_LIMIT, and that number appeared nowhere in the
// UI until a user hit it. It now states the real figure, which creates a NEW failure
// mode: change FREE_DAILY_LIMIT and the marketing quietly starts lying, in eleven
// languages, with nothing to catch it. This test is that catch.
//
// NOTE ON THE COMPARISON TABLE: "Unlimited staging generations" is deliberately ticked
// in BOTH columns on stagify-plus.html — a product decision (2026-08-01) that 50/day
// reads as effectively unlimited and naming a cap there would scare people off. That is
// why nothing here asserts on that row. The honest number lives on the homepage bullet
// instead, and that is what is pinned below.
//
// The gallery row above it is the opposite call (2026-08-03): both tiers quote a real
// figure, so both can go stale against lib/data/staged-renders.js. Pinned at the bottom
// of this file — including the exactness of the figure, since 200 is a ceiling and
// anything like "200+" would invert its meaning.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const LANGS = path.join(PUBLIC, 'languages');

/** The enforced ceiling, read from the source of truth rather than restated here. */
function enforcedDailyLimit() {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'data', 'auth-store.js'), 'utf8');
  const m = /const\s+FREE_DAILY_LIMIT\s*=\s*(\d+)\s*;/.exec(src);
  assert.ok(m, 'FREE_DAILY_LIMIT is no longer a literal in lib/data/auth-store.js — update this guard');
  return Number(m[1]);
}

/** Resolve a dotted key in a language pack. */
function at(json, dotted) {
  return dotted.split('.').reduce((node, key) => (node == null ? node : node[key]), json);
}

const packs = () =>
  fs.readdirSync(LANGS)
    .filter((f) => f.endsWith('.json'))
    .map((name) => ({ name, json: JSON.parse(fs.readFileSync(path.join(LANGS, name), 'utf8')) }));

test('every language pack states the free cap the server actually enforces', () => {
  // The homepage's "why us" bullet is the one place the real figure is quoted, so it
  // is the one that can go stale against FREE_DAILY_LIMIT.
  const limit = enforcedDailyLimit();
  const all = packs();
  assert.ok(all.length >= 11, `expected 11 language packs, found ${all.length}`);

  for (const { name, json } of all) {
    const line = at(json, 'whyUs.stagify.features.free');
    assert.equal(typeof line, 'string', `${name} is missing whyUs.stagify.features.free`);
    assert.ok(
      line.includes(String(limit)),
      `${name} says "${line}" but the server enforces ${limit}/day ` +
        '(lib/data/auth-store.js FREE_DAILY_LIMIT). Update the packs, or the homepage lies.',
    );
  }
});

test('the English markup fallback quotes the same figure as the packs', () => {
  // data-lang-html overwrites this at runtime, but it is what ships before the pack
  // loads — and it drifted from the pack once already.
  const limit = enforcedDailyLimit();
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const row = new RegExp(`whyUs\\.stagify\\.features\\.free[^>]*>[^<]*<strong>[^<]*${limit}[^<]*</strong>`);
  assert.match(html, row, `index.html's free-tier bullet should quote ${limit}`);
});

/**
 * A gallery cap's default, read from the source of truth. Only the DEFAULT can be
 * pinned — both constants are `Number(process.env.X) || <default>`, so an operator who
 * overrides the env var makes the page stale in a way no test can see. That is the
 * accepted cost of the env override; the literal is what ships, and it is what drifts.
 * @param {'FREE_GALLERY_LIMIT'|'PRO_GALLERY_LIMIT'} name
 */
function galleryLimit(name) {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'data', 'staged-renders.js'), 'utf8');
  const m = new RegExp(`export const ${name} = Number\\(process\\.env\\.${name}\\) \\|\\| (\\d+);`).exec(src);
  assert.ok(m, `${name} is no longer a literal default in lib/data/staged-renders.js — update this guard`);
  return Number(m[1]);
}

test('the compare table quotes the gallery caps the server actually enforces', () => {
  // The row is the only place either number is advertised, and both columns carry one,
  // so a change to either constant silently makes the pricing page wrong.
  const free = galleryLimit('FREE_GALLERY_LIMIT');
  const pro = galleryLimit('PRO_GALLERY_LIMIT');
  assert.notEqual(free, pro, 'the row compares two tiers — identical caps make it pointless');

  // Comments stripped first: a commented-out row still contains every token this
  // matches on, so scanning the raw file would pass with the row invisible on the page.
  const html = fs.readFileSync(path.join(PUBLIC, 'stagify-plus.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const row = /stagifyPlus\.compare\.rows\.gallery[\s\S]{0,400}?<\/tr>/.exec(html);
  assert.ok(row, 'stagify-plus.html no longer has a gallery row in the compare table');

  const values = [...row[0].matchAll(/<span class="sp-value[^"]*">(\d+)<\/span>/g)].map((m) => Number(m[1]));
  assert.deepEqual(
    values,
    [free, pro],
    `the gallery row advertises ${JSON.stringify(values)} but the server enforces ` +
      `${free} (free) and ${pro} (Stagify+) — see lib/data/staged-renders.js.`,
  );
});

test('every language pack labels the gallery row', () => {
  // No cross-pack parity guard covers the stagifyPlus namespace, so a key added to
  // english.json alone ships green and the row renders untranslated in ten languages.
  const all = packs();
  assert.ok(all.length >= 11, `expected 11 language packs, found ${all.length}`);

  for (const { name, json } of all) {
    const label = at(json, 'stagifyPlus.compare.rows.gallery');
    assert.equal(
      typeof label,
      'string',
      `${name} is missing stagifyPlus.compare.rows.gallery — the row falls back to English there`,
    );
    assert.ok(label.trim().length > 0, `${name} has an empty stagifyPlus.compare.rows.gallery`);
  }
});

test('no page still claims unlimited generations are free', () => {
  // The homepage's "Unlimited generations: Totally free" was the same message in a
  // louder place. It is a factual claim about the free plan, so it is checked in
  // English (the markup fallback) rather than across translations.
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.doesNotMatch(
    html,
    /<strong>Unlimited generations<\/strong>\s*:\s*Totally free/i,
    'index.html tells free users they already have the paid tier\'s headline benefit',
  );
});
