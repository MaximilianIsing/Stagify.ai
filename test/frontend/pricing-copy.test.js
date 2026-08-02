// Drift guard: the free tier's advertised cap vs the one the server actually enforces.
//
// WHY THIS EXISTS
// The Stagify+ comparison table used to mark "Unlimited staging generations" with a ✓
// in BOTH columns — the page's most prominent claim, labelled as something the free
// plan already included. The homepage went further and said "Unlimited generations:
// Totally free", which was simply untrue: free is capped at FREE_DAILY_LIMIT, and that
// number appeared nowhere in the UI until a user hit it.
//
// The free column now states the real cap. That creates a NEW failure mode: change
// FREE_DAILY_LIMIT and the marketing quietly starts lying, in eleven languages, with
// nothing to catch it. This test is that catch.

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

test('every language pack advertises the free cap the server actually enforces', () => {
  const limit = enforcedDailyLimit();
  const all = packs();
  assert.ok(all.length >= 11, `expected 11 language packs, found ${all.length}`);

  for (const { name, json } of all) {
    const cap = at(json, 'stagifyPlus.compare.freeCap');
    assert.equal(typeof cap, 'string', `${name} is missing stagifyPlus.compare.freeCap`);
    assert.ok(
      cap.includes(String(limit)),
      `${name} advertises the free cap as "${cap}" but the server enforces ${limit} ` +
        '(lib/data/auth-store.js FREE_DAILY_LIMIT). Update the packs, or the pricing page lies.',
    );
  }
});

test('the comparison table shows the cap in the free column, not a second tick', () => {
  // The specific regression: `Unlimited staging generations` with ✓ in both columns.
  // Assert on the rendered row so re-adding the tick fails here rather than in review.
  const html = fs.readFileSync(path.join(PUBLIC, 'stagify-plus.html'), 'utf8').replace(/\r\n/g, '\n');
  const row = /<th[^>]*stagifyPlus\.compare\.rows\.unlimited[^>]*>[\s\S]*?<\/tr>/.exec(html);
  assert.ok(row, 'the unlimited-generations row is gone from stagify-plus.html');

  const ticks = (row[0].match(/sp-mark--yes/g) || []).length;
  assert.equal(ticks, 1, 'the free column must state its cap, not claim the paid tier\'s headline benefit');
  assert.match(row[0], /stagifyPlus\.compare\.freeCap/, 'the free cell should render the localized cap');
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
