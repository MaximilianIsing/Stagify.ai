// Tier: drift guard (static analysis of public/exterior-studio.html) — the PUBLIC pitch,
// the half of the page that an anonymous visitor, a free account and Googlebot all get.
//
// WHY THIS EXISTS
// The pitch is three text cards and a trust band, and its whole claim to being worth
// reading is that the cards do not merely DESCRIBE the studio's controls — they list them,
// in the studio's own words, from the same language-pack keys the real dropdowns and chips
// render from. That is the one thing here that can rot silently: add a seventh removal to
// CLEANUP_CLAUSES and the tool grows a chip, the prompt grows a clause, eleven packs grow a
// string, every existing guard stays green, and this page quietly goes on advertising six.
// The sweep below is the only thing that notices.
//
// Also pinned, because each was a deliberate decision and each regresses by ADDITION:
//   • the pitch is ONE container. #ex-features is the id exterior-studio/access.js hides
//     for a Stagify+ account; a section outside it survives into the Pro view, looking
//     completely fine to anyone checking while signed out.
//   • the page asks ONCE. A closing "comes with Stagify+" band with a second button was
//     built here and removed; so was a before/after comparison of the homepage's pair,
//     as redundant with the homepage panel that links here. Both are asserted gone in the
//     MARKUP, for the same reason access.test.js asserts the deleted upgrade overlay is:
//     the regression starts with the section coming back, styled and translated.
//
// See test/frontend/exterior-studio/access.test.js for the three-view writer itself, and
// test/i18n/exterior-options-i18n.test.js for the sweep that holds every `exteriorStudio.*`
// key this page names to all eleven packs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIME_OF_DAY_PRESETS, SKY_PRESETS, CLEANUP_CLAUSES } from '../../../lib/staging/exterior-prompts.js';
import { pageHtml, hiddenPageIds } from '../../helpers/exterior-studio-dom.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const html = pageHtml();

/** The markup between `id="ex-features"` and the tool that follows it. */
function pitchMarkup() {
  const start = html.indexOf('id="ex-features"');
  assert.notEqual(start, -1, '#ex-features is missing');
  const end = html.indexOf('id="ex-tool"', start);
  assert.notEqual(end, -1, '#ex-tool must come after the pitch');
  return html.slice(start, end);
}

// ---- one container, and it ships visible -----------------------------------

test('the whole pitch is inside #ex-features, the one region access.js hides', () => {
  // Anything outside it survives into the Pro view.
  const pitch = pitchMarkup();
  for (const marker of ['ex-features-section', 'ex-feature__opts', 'ex-honest']) {
    assert.ok(pitch.includes(marker), `${marker} must sit inside #ex-features`);
  }
});

test('the pitch ships VISIBLE — it is the no-JS default and what a crawler indexes', () => {
  assert.ok(!hiddenPageIds().has('ex-features'), 'the pitch must ship visible');
});

test('the page still has exactly one h1 — the pitch headings are h2/h3', () => {
  // The e2e suite asserts this too, but only in a browser, and a heading level is a
  // one-character mistake.
  assert.equal([...html.matchAll(/<h1\b/g)].length, 1, 'one h1 per page');
});

// ---- the cards list the studio's REAL vocabulary ---------------------------

test('every option pill on the feature cards is a real studio option', () => {
  // Swept from the markup rather than listed here, so a preset added tomorrow is covered
  // the day it ships and a key renamed in the page cannot quietly stop being checked.
  const pitch = pitchMarkup();
  const tables = { time: TIME_OF_DAY_PRESETS, skyOptions: SKY_PRESETS, controls: CLEANUP_CLAUSES };
  const pills = [...pitch.matchAll(/<li data-lang="exteriorStudio\.(time|skyOptions|controls)\.(\w+)">/g)];
  assert.ok(pills.length >= 12, `expected the full option vocabulary, found ${pills.length}`);
  for (const [, ns, key] of pills) {
    assert.ok(key in tables[ns], `exteriorStudio.${ns}.${key} names an option the studio does not have`);
  }

  // And the reverse, which is the half that actually rots: an option with no pill is a
  // capability the page has stopped advertising, and nothing else would ever say so.
  for (const [ns, table] of Object.entries(tables)) {
    const listed = pills.filter((p) => p[1] === ns).map((p) => p[2]).sort();
    const expected = Object.keys(table).filter((k) => k !== 'keep').sort();
    assert.deepEqual(listed, expected, `the ${ns} card does not list every option`);
  }
});

test('the three cards and the trust band are all still there', () => {
  // The pill sweep above passes just as happily with a whole card deleted, as long as what
  // is left is accurate — so count the cards, and check the promise did not go with one.
  const pitch = pitchMarkup();
  assert.equal([...pitch.matchAll(/<article class="ex-feature">/g)].length, 3);
  assert.ok(pitch.includes('exteriorStudio.features.honest.title'), 'the trust band is missing');
  assert.ok(pitch.includes('exteriorStudio.features.honest.body'));
});

// ---- what was deliberately taken out stays out -----------------------------

test('the pitch makes no second ask — the hero button is the only one', () => {
  // A closing "The Exterior Studio comes with Stagify+" band lived here, with a second Get
  // Stagify+ button and a link to the plan, and was removed by decision.
  const pitch = pitchMarkup();
  assert.ok(!/\bex-close\b/.test(pitch), 'the closing call-to-action band is back');
  assert.deepEqual(
    [...pitch.matchAll(/<a[^>]*href=/g)].map((m) => m[0]), [],
    'the pitch is READ, not clicked through',
  );

  // The hero still asks, once. Outside #ex-features because access.js hides that button
  // separately (#ex-hero-actions), so a Stagify+ account is not sold to twice either.
  assert.match(html, /id="ex-cta"[^>]*href="stagify-plus\.html"/);
});

test('there is no before/after comparison on the pitch — the homepage panel owns that pair', () => {
  // One was built here from media-webp/Homepage/Exterior and removed as redundant: the
  // homepage showcase is what links to this page, so a visitor arriving from it had just
  // seen the same two photographs. Asserted three ways because a partial restore is the
  // likely shape — markup back but unwired, or wired but unstyled — and each half alone
  // looks harmless in review.
  const pitch = pitchMarkup();
  assert.ok(!pitch.includes('ex-demo'), 'the pitch comparison markup is back');
  assert.ok(!pitch.includes('Homepage/Exterior'), 'the homepage pair is being shown here again');

  const app = fs.readFileSync(path.join(PUBLIC, 'scripts', 'exterior-studio-app.js'), 'utf8');
  assert.ok(!/mountPitchDemo/.test(app), 'the pitch demo is being mounted again');

  const css = fs.readFileSync(path.join(PUBLIC, 'styles', 'exterior-studio.css'), 'utf8')
    // The stylesheet's prose explains the removal, so strip comments first — otherwise the
    // note left for the next reader is what keeps this passing, and it would keep passing
    // with the rules restored underneath it.
    .replace(/\/\*[\s\S]*?\*\//g, '');
  for (const cls of ['.ex-proof', '.ex-recipe', '.ex-kicker']) {
    assert.ok(!css.includes(cls), `${cls} styles are back in exterior-studio.css`);
  }
});

test('the deleted sections\' copy keys are gone from every pack, not just the markup', () => {
  // Leaving them would pass every check — cross-pack parity only compares the packs to each
  // other — while the next person to re-add a section finds eight keys that look supported
  // and are simply stale copy nobody has read since.
  const langs = path.join(PUBLIC, 'languages');
  for (const name of fs.readdirSync(langs).filter((f) => f.endsWith('.json'))) {
    const studio = JSON.parse(fs.readFileSync(path.join(langs, name), 'utf8')).exteriorStudio ?? {};
    assert.ok(!('pitch' in studio), `${name} still carries the exteriorStudio.pitch block`);
  }
});
