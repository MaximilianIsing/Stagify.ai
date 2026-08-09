// Tier: pure frontend logic + markup/i18n drift guards — public/scripts/home-figures.js.
//
// The module drives the two figures that replaced static blocks on the homepage: the
// #compare savings calculator and the #ai-shift NAR chart. Three things about that are
// genuinely fragile, and this file exists for them:
//
//  1. THE MARKUP CARRIES THE FINAL VALUES, AND THE MODULE RECOMPUTES THEM. The chart's
//     authored numerals and `--seg-w` widths ARE the no-JS / reduced-motion rendering;
//     the calculator's authored text is the value at CALC.initial. Nothing at runtime
//     reconciles the two — if the constants here and the markup drift apart, the page
//     paints one number and then silently swaps to a different one. Only a test catches
//     that, because both states look perfectly plausible on their own.
//
//  2. THE SLIDER FLOOR IS A GRAMMAR CONSTRAINT, not a UX preference. `min: 5` forces
//     weeksFor() to [10, 200] and always even, which is what lets `home.compare.calc.
//     weeks` ship as one form per language instead of one/few/many sets. Lowering it
//     makes ten translations quietly ungrammatical with no visible failure.
//
//  3. NOTHING IN formatCurrency MAY THROW. e2e/index.spec.js fails the build on any
//     pageerror, and `new Intl.NumberFormat('')` throws RangeError while
//     `currencyDisplay: 'narrowSymbol'` throws on Safari < 14.1.
//
// On i18n: test/server/static.test.js already gates key PRESENCE across all 11 packs
// (english.json is the baseline; a missing translation fails the build there). What it
// cannot check is the shape of a value, so the checks below cover the two that matter —
// that every pack kept the `{n}` placeholder, and that the footnote still quotes the
// same figure the calculator actually multiplies by.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// count-up.js's IIFE assigns window.StagifyHeroStats at import time, and
// home-figures.js imports rampValue from it. Same stub count-up.test.js uses.
globalThis.window = globalThis.window || {};
const {
  CALC,
  clampListings,
  costFor,
  weeksFor,
  weeksAtRamp,
  formatCurrency,
  fillCount,
} = await import('../../public/scripts/home-figures.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const LANG_DIR = path.join(ROOT, 'public', 'languages');

function packs() {
  const files = fs.readdirSync(LANG_DIR).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 11, 'eleven language packs');
  return files.map((file) => ({
    file,
    json: JSON.parse(fs.readFileSync(path.join(LANG_DIR, file), 'utf8')),
  }));
}

/** `attr="value"` out of an element's attribute soup. */
function attr(html, name) {
  return (html.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];
}

// --------------------------------------------------------------------------
// Pure model
// --------------------------------------------------------------------------

test('clampListings bounds, floors, and survives a missing slider value', () => {
  assert.equal(clampListings(24), 24);
  assert.equal(clampListings('37'), 37, 'input.value is always a string');
  assert.equal(clampListings(1), CALC.min, 'below the floor');
  assert.equal(clampListings(5000), CALC.max, 'above the ceiling');
  assert.equal(clampListings(12.9), 12, 'floors rather than rounds');

  // Number('') and Number(null) are both 0, which would clamp to the minimum and
  // silently disagree with the markup's authored fallback. These must read as
  // "no slider state" and fall back to the initial value instead.
  assert.equal(clampListings(''), CALC.initial);
  assert.equal(clampListings(null), CALC.initial);
  assert.equal(clampListings(undefined), CALC.initial);
  assert.equal(clampListings('not a number'), CALC.initial);
  assert.equal(clampListings(NaN), CALC.initial);
  assert.equal(clampListings(Infinity), CALC.initial, 'not a finite number, so not a position');
});

test('costFor and weeksFor are linear and exact at both endpoints', () => {
  assert.equal(costFor(CALC.min), 10000);
  assert.equal(costFor(CALC.initial), 48000);
  assert.equal(costFor(CALC.max), 200000);
  assert.equal(weeksFor(CALC.initial), 48);
  assert.equal(weeksFor(CALC.max), 200);
});

test('the slider floor keeps the week count out of singular territory', () => {
  // This is the whole reason CALC.min is 5 rather than 1. `home.compare.calc.weeks` is
  // a single "{n} weeks" form in each of the 11 packs — there is no one/other pair —
  // so the value substituted into it must never be 1. Lowering the floor would not
  // break anything visibly in English; it would just make ten packs ungrammatical.
  assert.ok(
    weeksFor(CALC.min) >= 10,
    'CALC.min must keep weeksFor() >= 10; home.compare.calc.weeks has no singular form ' +
      'in any pack, so a value of 1 would be grammatically wrong in ten languages'
  );
  for (let n = CALC.min; n <= CALC.max; n++) {
    assert.equal(weeksFor(n) % 2, 0, `weeksFor(${n}) must stay even`);
    assert.ok(weeksFor(n) >= 10, `weeksFor(${n}) must stay >= 10`);
  }
});

test('no frame of the intro ramp can render a singular week count', () => {
  // CALC.min protects the SETTLED value; this protects the ~60 frames on the way there.
  // Ramping weeks from 0 would paint "1 weeks", "2 weeks", "3 weeks" — the exact forms
  // that ten packs have no grammar for — and it would look completely fine in English,
  // which is why only a test catches it.
  const floor = weeksFor(CALC.min);
  for (let listings = CALC.min; listings <= CALC.max; listings += 5) {
    const target = weeksFor(listings);
    for (let step = 0; step <= 120; step++) {
      const t = step / 120;
      const shown = Math.round(weeksAtRamp(target, t));
      assert.ok(
        shown >= floor,
        `listings=${listings} t=${t.toFixed(3)} rendered "${shown} weeks", below the ${floor} floor`
      );
    }
    assert.equal(weeksAtRamp(target, 0), floor, 'the ramp starts at the floor');
    assert.equal(weeksAtRamp(target, 1), target, 'and lands exactly on target');
  }
});

test('fillCount substitutes {n} and tolerates a template that lost it', () => {
  assert.equal(fillCount('{n} weeks', 48), '48 weeks');
  assert.equal(fillCount('{n}週間', 48), '48週間', 'no space, as ja/zh need');
  assert.equal(fillCount('Недель: {n}', 48), 'Недель: 48', 'placeholder need not lead');
  // A translator dropping the placeholder must degrade to odd copy, never a crash —
  // e2e/index.spec.js fails the build on any pageerror.
  assert.equal(fillCount('weeks', 48), 'weeks');
});

test('formatCurrency localises, and never throws whatever it is handed', () => {
  assert.equal(formatCurrency(48000, 'en'), '$48,000');
  assert.equal(formatCurrency(0, 'en'), '$0');
  assert.equal(formatCurrency(200000, 'en'), '$200,000');

  const de = formatCurrency(48000, 'de');
  assert.match(de, /48\.000/, 'German groups with dots');
  assert.match(de, /\$/, 'still a dollar amount');

  // The formatter is memoised on the resolved tag; a stale cache would return the
  // German string here.
  assert.equal(formatCurrency(48000, 'en'), '$48,000', 'memo invalidates on tag change');

  // The three inputs that actually throw inside Intl.
  for (const bad of ['', '   ', undefined, null, 'not-a-locale', 'e']) {
    assert.doesNotThrow(
      () => formatCurrency(2000, /** @type {any} */ (bad)),
      `formatCurrency must absorb ${JSON.stringify(bad)}`
    );
    assert.equal(typeof formatCurrency(2000, /** @type {any} */ (bad)), 'string');
  }
});

// --------------------------------------------------------------------------
// Markup drift — the authored fallback vs. what the module will compute
// --------------------------------------------------------------------------

test('the slider markup matches CALC', () => {
  const input = (INDEX.match(/<input\b[^>]*\bdata-calc-range\b[^>]*>/) || [])[0];
  assert.ok(input, 'index.html has a [data-calc-range] slider');
  assert.equal(attr(input, 'min'), String(CALC.min));
  assert.equal(attr(input, 'max'), String(CALC.max));
  assert.equal(attr(input, 'value'), String(CALC.initial));
  assert.equal(attr(input, 'step'), '1', 'clampListings floors, so fractional steps would fight it');
  assert.equal(attr(input, 'id'), 'calc-listings');
  assert.match(INDEX, /<label\b[^>]*\bfor="calc-listings"/, 'the question labels the slider');
});

test('the calculator\'s authored text is the value at CALC.initial', () => {
  // This is what stops the pre-JS paint from disagreeing with the first render. The
  // deferred module does not run until after `load` + idle, so these strings are on
  // screen for a second or more.
  const pick = (name) => (INDEX.match(new RegExp(`\\b${name}\\b[^>]*>([^<]*)<`)) || [])[1];

  assert.equal(pick('data-calc-cost'), formatCurrency(costFor(CALC.initial), 'en'));
  assert.equal(pick('data-calc-weeks'), `${weeksFor(CALC.initial)} weeks`);
  assert.equal(pick('data-calc-zero'), formatCurrency(0, 'en'));
  assert.equal(pick('data-calc-listings'), String(CALC.initial));

  const scale = (INDEX.match(/<div class="calc__scale"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '';
  const ticks = [...scale.matchAll(/<span>(\d+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(ticks, [String(CALC.min), String(CALC.max)], 'the scale labels the real range');
});

test('the calculator has the wiring home-figures.js queries for', () => {
  for (const hook of ['data-calc', 'data-calc-results', 'data-calc-cost', 'data-calc-weeks']) {
    assert.ok(INDEX.includes(hook), `index.html is missing [${hook}]`);
  }
  // aria-live must NOT be authored — the module adds it once the intro ramp is done,
  // because a live region during a 60-frame count-up reads every intermediate number.
  const results = (INDEX.match(/<div\b[^>]*\bdata-calc-results\b[^>]*>/) || [])[0];
  assert.ok(results, '[data-calc-results] exists');
  assert.ok(!/aria-live/.test(results), 'aria-live is added by JS after the ramp, never authored');
});

test('the old comparison table is gone but its citation block survives', () => {
  for (const dead of ['cmp-row', 'cmp-cell', 'cmp-mark', 'cmp-head', 'cmp-brandcell']) {
    assert.ok(!INDEX.includes(dead), `${dead} is left over from the deleted table`);
  }
  // .cmp-source is shared by #compare and #ai-shift — deleting it with the table would
  // have silently dropped both NAR citations.
  assert.equal(
    (INDEX.match(/class="cmp-source reveal"/g) || []).length,
    2,
    'both NAR citation blocks are still present'
  );
});

// --------------------------------------------------------------------------
// Markup drift — the chart's four representations of the same four numbers
// --------------------------------------------------------------------------

test('the chart percentages are static text, never animated', () => {
  // A survey share is a measured fact, not a running total, so counting it up from 0%
  // implies a process that never happened — and paints six wrong figures on the way to
  // the right one. This was built, judged nonsense, and removed; the guard stops it
  // coming back by the usual route (a ramp needs a target attribute to ramp toward).
  assert.ok(
    !INDEX.includes('data-nar-count'),
    'data-nar-count is back — the chart numerals are being animated again'
  );
  const chart = (INDEX.match(/<div class="nar-card[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/) || [])[0] || '';
  assert.ok(chart, 'the NAR card is still there');
  assert.ok(
    !/data-count|data-ramp|data-countup/i.test(chart),
    'no count-up hook of any name belongs on the chart'
  );
});

test('the bar segments, the legend and the aria-label agree', () => {
  const segments = [...INDEX.matchAll(/data-nar-seg="([^"]+)"[^>]*style="--seg-w:(\d+)%"/g)].map(
    (m) => ({ key: m[1], width: Number(m[2]) })
  );
  assert.equal(segments.length, 4, 'four bar segments');

  // NOT exactly 100: NAR publishes each share rounded independently, and these four
  // sum to 101. That is the source data, not a typo — `.nar-bar` is a flex row, so the
  // extra 1% is absorbed by flex-shrink and the bar still renders flush. The bound is
  // here only to catch a real slip (a dropped digit, a doubled segment).
  const total = segments.reduce((sum, s) => sum + s.width, 0);
  assert.ok(
    total >= 98 && total <= 102,
    `the segment widths sum to ${total}%, which is too far from 100 to be survey rounding`
  );

  // Read the VISIBLE text, not an attribute — it is the only representation left, and
  // it is what a reader actually compares against the bar. `.pct` carries no data-lang,
  // so "20%" is stable across all 11 packs.
  const legend = [...INDEX.matchAll(
    /data-nar-key="([^"]+)"[\s\S]*?<span class="pct">(\d+)%<\/span>/g
  )].map((m) => ({ key: m[1], pct: Number(m[2]) }));
  assert.equal(legend.length, 4, 'four legend percentages');
  assert.deepEqual(
    legend.map((l) => l.key),
    segments.map((s) => s.key),
    'legend rows and bar segments are in the same order, keyed the same'
  );
  for (let i = 0; i < segments.length; i++) {
    assert.equal(legend[i].pct, segments[i].width, `${segments[i].key}: legend vs bar width`);
  }

  // The bar is role="img", so its aria-label is the ONLY thing a screen reader gets —
  // it is a fourth copy of these numbers and drifts silently.
  const bar = (INDEX.match(/<div class="nar-bar"[^>]*>/) || [])[0] || '';
  const label = attr(bar, 'aria-label') || '';
  for (const seg of segments) {
    assert.ok(
      label.includes(`${seg.width}%`),
      `the bar's aria-label omits ${seg.key}'s ${seg.width}%`
    );
  }
});

test('legend rows are real buttons, not tabbable list items', () => {
  const rows = [...INDEX.matchAll(/<button\b[^>]*\bdata-nar-key="[^"]+"[^>]*>/g)];
  assert.equal(rows.length, 4, 'all four legend rows are <button>');
  for (const [row] of rows) {
    assert.equal(attr(row, 'type'), 'button', 'a bare <button> submits if ever nested in a form');
    assert.equal(attr(row, 'aria-pressed'), 'false', 'click pins the highlight, so it is a toggle');
  }
  // Scoped to the legend on purpose. Elsewhere on this page `tabindex="-1"` on an <li>
  // is correct — the language switcher is a role="listbox" with roving focus.
  const legendHtml = (INDEX.match(/<ul class="nar-legend">[\s\S]*?<\/ul>/) || [])[0] || '';
  assert.ok(legendHtml, 'the legend list is still there');
  assert.ok(!/<li[^>]*tabindex/.test(legendHtml), 'no tabindex on a legend list item');
});

// --------------------------------------------------------------------------
// i18n — shape checks that the presence gate in static.test.js cannot make
// --------------------------------------------------------------------------

test('home.compare.calc is complete and non-blank in all eleven packs', () => {
  for (const { file, json } of packs()) {
    const calc = json.home?.compare?.calc;
    assert.ok(calc, `${file}: home.compare.calc is missing`);
    for (const key of ['question', 'weeks', 'note']) {
      assert.equal(typeof calc[key], 'string', `${file}: home.compare.calc.${key} is a string`);
      assert.ok(calc[key].trim().length > 0, `${file}: home.compare.calc.${key} is not blank`);
    }
  }
});

test('every pack keeps the {n} placeholder in the weeks template', () => {
  // fillCount() degrades gracefully if this is dropped, but the result is a bare "weeks"
  // with no number — the calculator would look broken while throwing nothing.
  for (const { file, json } of packs()) {
    assert.ok(
      json.home.compare.calc.weeks.includes('{n}'),
      `${file}: home.compare.calc.weeks lost its {n} placeholder`
    );
  }
});

test('the footnote quotes the figure the calculator actually multiplies by', () => {
  // The note says "$2,000 per home"; CALC.costPerHome is what turns 24 into $48,000.
  // Changing one without the other makes the page cite a number it does not use.
  const digits = String(CALC.costPerHome); // "2000"
  const grouped = new RegExp(
    digits.slice(0, 1) + '[.,\\u00A0\\u202F\\u2009 ]?' + digits.slice(1)
  );
  for (const { file, json } of packs()) {
    assert.match(
      json.home.compare.calc.note,
      grouped,
      `${file}: home.compare.calc.note does not mention CALC.costPerHome (${CALC.costPerHome})`
    );
  }
});

test('the keys the calculator reuses from the deleted table still exist', () => {
  // 11 of the old home.compare.rows.* keys are now orphans, deliberately left in place.
  // These ten are NOT orphans — the calculator's eyebrow, column heads, captions and
  // sub-lines are all built from them. A future dead-key sweep must fail here rather
  // than silently blanking half the component (a missing key falls back to the English
  // markup, so on english.json alone the damage would be invisible).
  const REUSED = [
    'eyebrow',
    'colTraditional',
    'colStagify',
    'rows.cost.aspect',
    'rows.cost.trad',
    'rows.cost.stag',
    'rows.time.aspect',
    'rows.time.trad',
    'rows.time.stag',
    'rows.logistics.stag',
  ];
  for (const { file, json } of packs()) {
    for (const dotted of REUSED) {
      const value = dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), json.home.compare);
      assert.equal(typeof value, 'string', `${file}: home.compare.${dotted} is still needed`);
      assert.ok(value.trim().length > 0, `${file}: home.compare.${dotted} is blank`);
    }
    // And each must still be referenced by the markup.
    if (file === 'english.json') {
      for (const dotted of REUSED) {
        assert.ok(
          INDEX.includes(`home.compare.${dotted}`),
          `index.html no longer uses home.compare.${dotted} — retire the key or the guard`
        );
      }
    }
  }
});
