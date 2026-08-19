// Tier: drift guard + unit — the 2024/2025 survey-year switch on the #ai-shift card.
//
// WHY THIS EXISTS: the card's 2025 figures now live in TWO places that no runtime check
// compares. The authored markup in index.html is what ships (and what the server-rendered
// /es, /fr, … pages carry); NAR_YEARS['2025'] in home-nar-years.js is what the switch
// repaints when the visitor comes back from 2024. Nothing at runtime reads one against
// the other — click 2024 then 2025 on a drifted pair and the card silently lands on
// different numbers than it loaded with. That comparison is this file's main job.
//
// The second job is the citation. The year in "…2025 Technology Survey" is swapped by a
// digit substitution on an ALREADY-TRANSLATED string, which is only safe while every
// pack writes the year as one four-digit Arabic numeral. That premise is checked here
// against all eleven packs rather than assumed, because a reworded pack would otherwise
// ship a card citing the wrong survey with nothing failing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripJsComments } from '../helpers/strip-js-comments.js';

// count-up.js runs an IIFE at import time that touches `window`; home-nar-years.js
// imports rampValue from it, so the same stub home-figures.test.js uses is needed here.
globalThis.window = globalThis.window || {};

const { NAR_YEARS, NAR_SOURCE_URL, NAR_DEFAULT_YEAR, yearizeSource, paintNarYear } =
  await import('../../public/scripts/home-nar-years.js');
const { rampValue } = await import('../../public/scripts/count-up.js');

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

/** @param {string} tag @param {string} name */
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : null;
}

const ORDER = ['daily', 'weekly', 'monthly', 'none'];

// --------------------------------------------------------------------------
// The table vs the markup
// --------------------------------------------------------------------------

test("NAR_YEARS['2025'] is the same card the markup ships", () => {
  const y = NAR_YEARS[NAR_DEFAULT_YEAR];
  assert.ok(y, 'the default year has a row in the table');

  const widths = Object.fromEntries(
    [...INDEX.matchAll(/data-nar-seg="([^"]+)"[^>]*style="--seg-w:(\d+)%"/g)].map((m) => [
      m[1],
      Number(m[2]),
    ])
  );
  const legend = Object.fromEntries(
    [...INDEX.matchAll(/data-nar-key="([^"]+)"[\s\S]*?<span class="pct">(\d+)%<\/span>/g)].map(
      (m) => [m[1], Number(m[2])]
    )
  );
  for (const key of ORDER) {
    assert.equal(widths[key], y[key], `${key}: bar width vs NAR_YEARS`);
    assert.equal(legend[key], y[key], `${key}: legend percentage vs NAR_YEARS`);
  }

  // The 68% note and both tile numerals are the other three authored copies.
  const note = INDEX.match(/<p class="nar-usage__note"><strong>(\d+)%<\/strong>/);
  assert.ok(note, 'the note carries a percentage');
  assert.equal(Number(note[1]), y.any, 'the note figure vs NAR_YEARS.any');

  const nums = [...INDEX.matchAll(/<span class="nar-stat__num">(\d+)%<\/span>/g)].map((m) =>
    Number(m[1])
  );
  assert.deepEqual(nums, [y.stat1, y.stat2], 'the two tile numerals vs NAR_YEARS');

  // The bar's aria-label is the fourth copy and the only one a screen reader gets.
  const bar = (INDEX.match(/<div class="nar-bar"[^>]*>/) || [])[0] || '';
  const label = attr(bar, 'aria-label') || '';
  for (const key of ORDER) {
    assert.ok(label.includes(`${y[key]}%`), `the aria-label omits ${key}'s ${y[key]}%`);
  }
});

test('both years are internally consistent', () => {
  for (const [year, y] of Object.entries(NAR_YEARS)) {
    // `any` is the derived "already use AI" share. It is not an independent figure —
    // it is 100 minus the "not yet" bucket, and a typo in either is only visible here.
    assert.equal(y.any, 100 - y.none, `${year}: the note figure is 100 minus "not yet"`);

    // NAR rounds each share independently, so the four need not sum to exactly 100 —
    // both years happen to sum to 101. The bound only catches a real slip.
    const total = ORDER.reduce((sum, key) => sum + y[key], 0);
    assert.ok(total >= 98 && total <= 102, `${year}: the four shares sum to ${total}%`);

    for (const key of [...ORDER, 'stat1', 'stat2']) {
      assert.ok(
        Number.isInteger(y[key]) && y[key] >= 0 && y[key] <= 100,
        `${year}.${key} is a whole percentage`
      );
    }
    assert.ok(NAR_SOURCE_URL[year], `${year} has a citation URL`);
    assert.ok(
      NAR_SOURCE_URL[year].startsWith('https://www.nar.realtor/'),
      `${year} cites nar.realtor itself, not a secondhand write-up`
    );
  }
});

test('2024 and 2025 are different numbers, or the switch is decoration', () => {
  const a = NAR_YEARS['2024'];
  const b = NAR_YEARS['2025'];
  assert.notDeepEqual(a, b, 'the two years must not be the same row');
  assert.notEqual(NAR_SOURCE_URL['2024'], NAR_SOURCE_URL['2025'], 'each year cites its own report');
});

// --------------------------------------------------------------------------
// The citation year swap
// --------------------------------------------------------------------------

test('every pack writes the survey year as one four-digit numeral', () => {
  // This is the premise yearizeSource() stands on. It holds in the CJK and Cyrillic
  // packs too (Japanese writes "2025年", which still matches) — but it is a property of
  // the translations, not of the code, so it is checked rather than trusted.
  for (const { file, json } of packs()) {
    for (const key of ['source', 'sourceCite']) {
      const text = json.home?.nar?.[key];
      assert.equal(typeof text, 'string', `${file}: home.nar.${key} is a string`);
      const years = text.match(/\b20\d\d\b/g) || [];
      assert.equal(years.length, 1, `${file}: home.nar.${key} names exactly one year`);
      assert.equal(years[0], '2025', `${file}: home.nar.${key} still names the default year`);
    }
  }
});

test('yearizeSource retargets the year and leaves the sentence alone', () => {
  for (const { file, json } of packs()) {
    const source = json.home.nar.source;
    const out = yearizeSource(source, '2024');
    assert.ok(out.includes('2024'), `${file}: retargeted to 2024`);
    assert.ok(!out.includes('2025'), `${file}: no 2025 left behind`);
    assert.equal(out.length, source.length, `${file}: only the digits changed`);
    // Idempotent, so repeated switching cannot compound.
    assert.equal(yearizeSource(out, '2024'), out, `${file}: switching twice is a no-op`);
    assert.equal(yearizeSource(out, '2025'), source, `${file}: switching back restores it`);
  }
});

test('yearizeSource does not eat percentages or other numbers', () => {
  // The French and German packs write "20 %" with a non-breaking-ish space, and every
  // pack's aria string is full of bare numbers. A regex that matched loosely would
  // rewrite those into years.
  assert.equal(yearizeSource('20 % tous les jours, 2025 Survey', '2024'), '20 % tous les jours, 2024 Survey');
  assert.equal(yearizeSource('AI usage: 20% daily, 32% not yet', '2024'), 'AI usage: 20% daily, 32% not yet');
  assert.equal(yearizeSource('12 months', '2024'), '12 months');
});

// --------------------------------------------------------------------------
// i18n — the 2024 wording
// --------------------------------------------------------------------------

test('all eleven packs carry the 2024 tile sentences and aria label', () => {
  for (const { file, json } of packs()) {
    const y = json.home?.nar?.y2024;
    assert.ok(y, `${file}: home.nar.y2024 is missing`);
    for (const key of ['stat1', 'stat2', 'usageAria']) {
      assert.equal(typeof y[key], 'string', `${file}: home.nar.y2024.${key} is a string`);
      assert.ok(y[key].trim().length > 0, `${file}: home.nar.y2024.${key} is not blank`);
    }
    const label = json.home?.nar?.yearsLabel;
    assert.equal(typeof label, 'string', `${file}: home.nar.yearsLabel is a string`);
    assert.ok(label.trim().length > 0, `${file}: home.nar.yearsLabel is not blank`);
  }
});

test("each pack's 2024 aria label carries the 2024 numbers, not the 2025 ones", () => {
  // The aria-label is a fourth copy of four numbers in eleven languages — the single
  // most drift-prone string on the card, and invisible to anyone not using a reader.
  const y = NAR_YEARS['2024'];
  for (const { file, json } of packs()) {
    const aria = json.home.nar.y2024.usageAria;
    for (const key of ORDER) {
      assert.ok(aria.includes(String(y[key])), `${file}: the 2024 aria label omits ${key}'s ${y[key]}`);
    }
    assert.ok(
      !aria.includes(String(NAR_YEARS['2025'].none)),
      `${file}: the 2024 aria label still carries a 2025 figure`
    );
  }
});

// --------------------------------------------------------------------------
// The toggle markup
// --------------------------------------------------------------------------

test('the year switch is two aria-pressed buttons inside the citation row', () => {
  const buttons = [...INDEX.matchAll(/<button\b[^>]*\bdata-nar-year="[^"]+"[^>]*>/g)].map(
    (m) => m[0]
  );
  assert.equal(buttons.length, 2, 'one button per year');

  const years = buttons.map((b) => attr(b, 'data-nar-year'));
  assert.deepEqual(years, ['2024', '2025'], 'chronological order, oldest first');
  for (const year of years) {
    assert.ok(NAR_YEARS[year], `the ${year} button has a row in NAR_YEARS`);
  }

  for (const b of buttons) {
    // A bare <button> submits if it is ever nested in a form — same reason the legend
    // rows carry this.
    assert.equal(attr(b, 'type'), 'button', 'explicit type=button');
    assert.ok(attr(b, 'aria-pressed') !== null, 'the pressed state is exposed');
  }

  // The markup must ship agreeing with itself: the pressed button is the year the card
  // is authored as, so a no-JS reader is not told they are looking at 2024.
  const pressed = buttons.filter((b) => attr(b, 'aria-pressed') === 'true');
  assert.equal(pressed.length, 1, 'exactly one year is pressed on load');
  assert.equal(
    attr(pressed[0], 'data-nar-year'),
    NAR_DEFAULT_YEAR,
    'the pressed button is the year the card is authored as'
  );

  // Not a tablist: there are no panels, so tab semantics would promise a structure the
  // card does not have.
  const group = (INDEX.match(/<div class="nar-years"[^>]*>/) || [])[0] || '';
  assert.ok(group, 'the switch has a wrapper');
  assert.equal(attr(group, 'role'), 'group', 'role=group, not tablist');
  assert.ok(
    /data-lang-attr="home\.nar\.yearsLabel\|aria-label"/.test(group),
    'the group is named, or a reader announces two bare years with no context'
  );

  // It belongs to the citation row — that is what puts it bottom-right of the card.
  const sourceRow = (INDEX.match(/<div class="nar-source">[\s\S]*?\n {10}<\/div>/) || [])[0] || '';
  assert.ok(sourceRow, 'the citation row is still there');
  assert.ok(sourceRow.includes('class="nar-years"'), 'the switch sits in the citation row');
});

test('every node the painter writes through exists in the shipped card', () => {
  // paintNarYear() reaches for these by selector. The shim in the next test cannot
  // catch a selector that stopped matching the real markup, so that is checked here.
  const needles = [
    'data-nar-source-text',
    'data-nar-source-link',
    'class="nar-bar"',
    'class="nar-usage__note"',
    'class="nar-stat__num"',
    'nar-stat__txt',
  ];
  for (const needle of needles) {
    assert.ok(INDEX.includes(needle), `the card no longer has ${needle}`);
  }
  // The five nodes this module takes over from language-loader.js on init.
  assert.equal(
    (INDEX.match(/data-nar-owned/g) || []).length,
    5,
    'the set of nodes the year switch owns changed — update initNarYears with it'
  );
});

// --------------------------------------------------------------------------
// paintNarYear
// --------------------------------------------------------------------------

/**
 * The smallest thing paintNarYear can write into: a fixed selector→node map rather than
 * a selector engine. What it cannot prove — that these selectors match the shipped
 * markup — is proved as text by the test above, which is the half that actually rots.
 */
function fakeCard() {
  /** @param {string} tag */
  const node = (tag) => ({
    tag,
    textContent: '',
    attrs: /** @type {Record<string, string>} */ ({}),
    styles: /** @type {Record<string, string>} */ ({}),
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    style: {
      /** @type {Record<string, string>} */
      setProperty(name, value) {
        node_styles.set(tag, { ...(node_styles.get(tag) || {}), [name]: value });
      },
    },
  });
  const node_styles = new Map();

  const segs = Object.fromEntries(ORDER.map((k) => [k, node(`seg:${k}`)]));
  const pcts = Object.fromEntries(ORDER.map((k) => [k, node(`pct:${k}`)]));
  const bar = node('bar');
  const note = node('note');
  const nums = [node('num0'), node('num1')];
  const txts = [node('txt0'), node('txt1')];
  const sourceText = node('sourceText');
  const sourceLink = node('sourceLink');

  const one = new Map();
  for (const k of ORDER) {
    one.set(`[data-nar-seg="${k}"]`, segs[k]);
    one.set(`[data-nar-key="${k}"] .pct`, pcts[k]);
  }
  one.set('.nar-bar', bar);
  one.set('.nar-usage__note strong', note);
  one.set('[data-nar-source-text]', sourceText);
  one.set('[data-nar-source-link]', sourceLink);

  const many = new Map([
    ['.nar-stat__num', nums],
    ['.nar-stat__txt', txts],
  ]);

  return {
    segs,
    pcts,
    bar,
    note,
    nums,
    txts,
    sourceText,
    sourceLink,
    segWidth: (k) => (node_styles.get(`seg:${k}`) || {})['--seg-w'],
    card: {
      querySelector: (sel) => one.get(sel) || null,
      querySelectorAll: (sel) => many.get(sel) || [],
    },
  };
}

// HTMLElement is a browser global the painter narrows on before touching `.style`.
// Under node --test it does not exist, so the shim's segment nodes would be skipped and
// every width assertion would pass vacuously against `undefined`. Declaring it as a
// class the fake nodes are instances of is what makes that branch real here.
class FakeHTMLElement {}
globalThis.HTMLElement = globalThis.HTMLElement || FakeHTMLElement;

const tx = (key, fallback) => `tx(${key})|${fallback ? 'has-fallback' : ''}`;

test('paintNarYear writes every figure for the year it is given', () => {
  for (const year of ['2024', '2025']) {
    const f = fakeCard();
    // Give the segment nodes the prototype the painter checks for.
    for (const k of ORDER) Object.setPrototypeOf(f.segs[k], FakeHTMLElement.prototype);
    paintNarYear(f.card, year, tx);

    const y = NAR_YEARS[year];
    for (const k of ORDER) {
      assert.equal(f.pcts[k].textContent, `${y[k]}%`, `${year}: ${k} legend text`);
      // `--seg-w` is the only thing that moves the bar; without this the widths could
      // stop being written and every other assertion here would still pass.
      assert.equal(f.segWidth(k), `${y[k]}%`, `${year}: ${k} bar width`);
    }
    assert.equal(f.note.textContent, `${y.any}%`, `${year}: the note figure`);
    assert.equal(f.nums[0].textContent, `${y.stat1}%`, `${year}: tile 1 numeral`);
    assert.equal(f.nums[1].textContent, `${y.stat2}%`, `${year}: tile 2 numeral`);

    // The tile sentences come from the pack, per year — that is the whole point of the
    // y2024 namespace, so assert the painter asked for the right keys.
    const suffix = year === '2025' ? '' : '.y2024';
    assert.ok(f.txts[0].textContent.includes(`home.nar${suffix}.stat1`), `${year}: tile 1 key`);
    assert.ok(f.txts[1].textContent.includes(`home.nar${suffix}.stat2`), `${year}: tile 2 key`);
    assert.ok(f.bar.attrs['aria-label'].includes(`home.nar${suffix}.usageAria`), `${year}: aria key`);

    assert.equal(f.sourceLink.attrs.href, NAR_SOURCE_URL[year], `${year}: the citation link`);
  }
});

// --------------------------------------------------------------------------
// The year-switch animation
// --------------------------------------------------------------------------

test('the animated numerals stand alone — no translated words ride along', () => {
  // THE PLURAL TRAP, and why this card is immune to it. The packs have no plural
  // machinery, so a number inside a translated string gets one grammatical form and the
  // code must keep it in that form's range. An animation violates that invisibly: the
  // settled frame is right while sixty intermediate frames parade "1 weeks" past ten
  // languages. It bit the #compare calculator exactly this way.
  //
  // The tween here is safe BY CONSTRUCTION rather than by a floor: every node it writes
  // holds only a bare numeral, and the translated sentence is a SEPARATE element beside
  // it. This asserts that separation, because the day someone folds the number into the
  // sentence key, the tween silently becomes ungrammatical in ten packs.
  const note = INDEX.match(/<p class="nar-usage__note">([\s\S]*?)<\/p>/);
  assert.ok(note, 'the note is still there');
  assert.ok(
    /^<strong>\d+%<\/strong>\s*<span[^>]*data-lang="home\.nar\.note"/.test(note[1].trim()),
    'the note figure is its own <strong>, outside the translated span'
  );

  for (const tile of INDEX.matchAll(/<div class="nar-stat">([\s\S]*?)<\/div>/g)) {
    assert.ok(
      /<span class="nar-stat__num">\d+%<\/span>/.test(tile[1]),
      'the tile numeral is its own element'
    );
    assert.ok(
      !/nar-stat__num"[^>]*data-lang/.test(tile[1]),
      'the tile numeral must not carry a translated string'
    );
  }

  const legend = (INDEX.match(/<ul class="nar-legend">[\s\S]*?<\/ul>/) || [])[0] || '';
  for (const pct of legend.matchAll(/<span class="pct">([^<]*)<\/span>/g)) {
    assert.match(pct[1], /^\d+%$/, 'a legend percentage is a bare numeral');
  }
});

test('the two kinds of text change are marked for their own treatment', () => {
  // The tiles change WORDING entirely (different survey questions), so they fade out,
  // swap off screen, and fade back. The citation changes by four characters — the year,
  // twice — so it dissolves, both wordings on screen at once. Getting these the wrong
  // way round is not a crash, just a card that flickers where it should morph.
  assert.equal(
    (INDEX.match(/nar-swap/g) || []).length,
    2,
    'exactly the two tile sentences cross-fade'
  );
  const tiles = [...INDEX.matchAll(/<span class="nar-stat__txt nar-swap"/g)];
  assert.equal(tiles.length, 2, 'and they are the tile sentences, not something else');

  // ONE dissolve unit, the whole citation paragraph. Per-node ghosts were the obvious
  // alternative and they misalign: the sentence and the cite link are inline content
  // that wraps, and you cannot lay a rectangle over a wrapped inline box.
  const para = (INDEX.match(/<p data-nar-dissolve[^>]*>/) || [])[0] || '';
  assert.ok(para, 'the citation paragraph is the dissolve unit');
  assert.ok(/class="[^"]*\bnar-dissolve\b/.test(para), 'and it carries the class the CSS eases');
  assert.equal(
    (INDEX.match(/data-nar-dissolve/g) || []).length,
    1,
    'exactly one dissolve unit — a second ghost would stack over the first'
  );
  // The year-bearing nodes must be INSIDE it, or the clone copies the wrong text.
  const paraBlock = (INDEX.match(/<p data-nar-dissolve[\s\S]*?<\/p>/) || [])[0] || '';
  assert.ok(paraBlock.includes('data-nar-source-text'), 'the sentence is inside the dissolve unit');
  assert.ok(paraBlock.includes('data-nar-source-link'), 'the cite link is inside it too');
});

test('the dissolve ghost is inert and never outlives its transition', () => {
  const src = stripJsComments(
    fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'home-nar-years.js'), 'utf8')
  );
  const fn = src.slice(src.indexOf('function dissolveCitation'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));

  // A visible duplicate of the citation must not be reachable by a reader or by Tab —
  // it is a copy of live text that is on its way out, and its link would be a focus
  // stop that vanishes under the visitor.
  // MEASURED IN THE BROWSER: the first version faded the new citation UP from 0 while
  // the old went down. Two crossing opacities sum to less than 1 in the middle, and the
  // pair was caught at 0/0 together — the citation disappeared for ~150ms, which is a
  // worse flicker than the plain fade it replaced. Only the outgoing clone may animate;
  // the live text stays opaque underneath so the sentence is never absent.
  assert.ok(
    !/live\.style\.opacity/.test(body),
    'the live citation must not be faded — dissolving means the new text stays opaque ' +
      'under the outgoing clone, or there is an instant showing neither'
  );
  assert.ok(
    /ghost\.style\.opacity\s*=\s*"0"/.test(body),
    'the outgoing clone is the thing that fades'
  );

  assert.ok(/aria-hidden/.test(body), 'the ghost is hidden from assistive tech');
  assert.ok(/tabindex/.test(body), "the ghost's link is taken out of the tab order");
  assert.ok(/setTimeout/.test(body), 'the ghost is removed on a timer');
  assert.ok(
    !/requestAnimationFrame/.test(body),
    'the dissolve must not depend on requestAnimationFrame — a background tab pauses ' +
      'it, and a stranded ghost is permanently doubled text over the real citation'
  );
  // The un-animated paths sweep first, or a language change landing mid-dissolve leaves
  // the old sentence stacked over the new one.
  assert.ok(/function clearGhosts/.test(src), 'there is a ghost sweep');
  assert.ok(
    (src.match(/clearGhosts\(card\)/g) || []).length >= 2,
    'the sweep runs on the un-animated path too, not only inside the dissolve'
  );
});

test('paintNarYear only animates when asked, and never writes a fractional percent', () => {
  // The default path (no options) is what load and `languagechange` use. It must land
  // on the exact figures with no rAF loop at all — this runs under node --test, where
  // requestAnimationFrame does not exist, so a tween on this path would throw or hang.
  const f = fakeCard();
  paintNarYear(f.card, '2024', tx);
  assert.equal(f.note.textContent, '55%', 'the un-animated path lands immediately');
  assert.equal(f.nums[0].textContent, '42%', 'and on the exact published figure');

  // Sample the easing across its whole range, not just the endpoints: the settled frame
  // being right is exactly what hides an intermediate-frame bug.
  for (const [from, to] of [[20, 9], [9, 20], [82, 42], [46, 28], [68, 55]]) {
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      const value = Math.round(from + rampValue(to - from, t));
      assert.ok(Number.isInteger(value), `t=${t}: ${from}->${to} stays a whole percent`);
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      assert.ok(
        value >= lo && value <= hi,
        `t=${t}: ${from}->${to} passed through ${value}%, outside the two real figures`
      );
    }
  }
  // The curve must actually arrive, or the last frame would need a correction nobody
  // would notice was missing.
  assert.equal(Math.round(20 + rampValue(9 - 20, 1)), 9, 'the tween lands on its target');
  assert.equal(Math.round(20 + rampValue(9 - 20, 0)), 20, 'and starts where it was');
});

test('the tween never runs on load — only the click path asks for it', () => {
  // The whole reason the deleted entrance wipe was a bug is that it had no correct
  // trigger. This one has exactly one, and this is the check that it stays that way.
  // Stripped for the same reason as the background-tab guard below: the prose here
  // discusses `animate` at length, and a scan that counted comments would be satisfied
  // by the explanation of the rule rather than by the rule.
  const src = stripJsComments(
    fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'home-nar-years.js'), 'utf8')
  );
  const animateCalls = [...src.matchAll(/animate:\s*true/g)];
  assert.equal(animateCalls.length, 1, 'exactly one call site turns the animation on');
  // Locate it rather than slicing on a token that also appears inside select(): the one
  // animated call must sit after select() opens and before the languagechange handler,
  // which is the other caller and must stay silent.
  const at = src.indexOf('animate: true');
  const selectAt = src.indexOf('function select');
  const langAt = src.indexOf('window.addEventListener("languagechange"');
  assert.ok(selectAt > -1 && langAt > selectAt, 'both call sites are still recognisable');
  assert.ok(
    at > selectAt && at < langAt,
    'the one animated call is the click-driven select(), not init or languagechange'
  );
  assert.ok(
    /prefersReducedMotion\(\)/.test(src),
    'the animation is gated on prefers-reduced-motion'
  );
});

test('every frame of the real tween is a whole percent between the two real figures', () => {
  // Drives the ACTUAL rAF loop, not the easing maths — a hand-checked curve proves
  // nothing about what the loop writes into the DOM. Every intermediate frame is
  // captured and checked, because the settled frame being right is precisely what hides
  // an intermediate-frame bug (the #compare calculator shipped one for months).
  const realRaf = globalThis.requestAnimationFrame;
  const realCancel = globalThis.cancelAnimationFrame;
  const realPerf = globalThis.performance;

  /** @type {Array<(t: number) => void>} */
  let queue = [];
  let clock = 0;
  globalThis.requestAnimationFrame = (cb) => {
    queue.push(cb);
    return queue.length;
  };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.performance = /** @type {any} */ ({ now: () => clock });

  try {
    const f = fakeCard();
    for (const k of ORDER) Object.setPrototypeOf(f.segs[k], FakeHTMLElement.prototype);
    // Start from a fully-painted 2025 card so the tween has real `from` values to read.
    paintNarYear(f.card, '2025', tx);
    paintNarYear(f.card, '2024', tx, { animate: true });

    const watched = [
      { el: f.pcts.daily, from: 20, to: 9 },
      { el: f.pcts.none, from: 32, to: 45 },
      { el: f.note, from: 68, to: 55 },
      { el: f.nums[0], from: 82, to: 42 },
    ];

    let frames = 0;
    // 620ms tween; step ~16ms and stop when the loop stops asking for frames.
    while (queue.length && frames < 200) {
      const pending = queue;
      queue = [];
      clock += 16;
      pending.forEach((cb) => cb(clock));
      frames++;
      for (const w of watched) {
        const text = String(w.el.textContent);
        assert.match(text, /^\d+%$/, `frame ${frames}: "${text}" is not a whole percent`);
        const value = Number(text.replace('%', ''));
        const lo = Math.min(w.from, w.to);
        const hi = Math.max(w.from, w.to);
        assert.ok(
          value >= lo && value <= hi,
          `frame ${frames}: ${w.from}->${w.to} showed ${value}%, a figure no survey published`
        );
      }
    }

    assert.ok(frames > 5, `the tween ran ${frames} frames — it is not actually animating`);
    for (const w of watched) {
      assert.equal(w.el.textContent, `${w.to}%`, 'the tween settles on the exact figure');
    }
  } finally {
    globalThis.requestAnimationFrame = realRaf;
    globalThis.cancelAnimationFrame = realCancel;
    globalThis.performance = realPerf;
  }
});

test('every tweened numeral is set in tabular figures', () => {
  // WHY THIS IS NOT COSMETIC. Inter's default figures are proportional, so a numeral's
  // rendered width depends on WHICH digits it holds — measured at the tile's type, the
  // values a tween passes through span 17.6px ("11%" is 68.4px wide, "46%" is 86.0px).
  // The tile's numeral column is `auto`, so that swing resized the column on every
  // frame: the % sign slid left and right and shoved the sentence beside it. Tabular
  // figures pin every value to one width and the movement disappears.
  //
  // Only the ANIMATED numerals need this, which is exactly the set below. `.nar-legend
  // .pct` already had it before the year switch existed — that is where the pattern
  // came from, not a coincidence worth breaking.
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles', 'home.css'), 'utf8');

  for (const selector of ['.nar-stat__num', '.nar-usage__note strong', '.nar-legend .pct']) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const block = css.match(new RegExp(`^${escaped}\\s*\\{[\\s\\S]*?^\\}`, 'm'));
    assert.ok(block, `${selector} no longer has a rule block in home.css`);
    assert.match(
      block[0],
      /font-variant-numeric:\s*tabular-nums/,
      `${selector} lost its tabular figures — its width will change with its digits, ` +
        'and it is animated, so that reads as the % sign jittering'
    );
  }
});

test('neither animation can be stranded by a backgrounded tab', () => {
  // FOUND IN THE BROWSER, NOT BY READING THE CODE: a screenshot caught the two tile
  // sentences and the citation stuck fully invisible. requestAnimationFrame is PAUSED
  // in a background tab (setTimeout is only throttled), so anything whose CLEANUP runs
  // inside rAF never happens if the visitor clicks and switches tab.
  //
  // Two separate stranding modes, one guard each:
  //   the crossfade — `is-swapping` never removed, so the text stays at opacity 0
  //   the numerals  — the tween freezes on an intermediate value like "14%", which is
  //                   a figure NAR never published, presented as if it were data
  // Comments STRIPPED FIRST, or this guard reads its own explanation: the prose above
  // the fix names requestAnimationFrame to say why it must not be used, which is
  // exactly the token being scanned for.
  const src = stripJsComments(
    fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'home-nar-years.js'), 'utf8')
  );

  const fade = src.slice(src.indexOf('function crossfadeText'));
  const fadeBody = fade.slice(0, fade.indexOf('\n}\n'));
  assert.ok(
    /classList\.remove\("is-swapping"\)/.test(fadeBody),
    'the crossfade still removes its class somewhere'
  );
  assert.ok(
    !/requestAnimationFrame/.test(fadeBody),
    'the crossfade must not clean up inside requestAnimationFrame — a background tab ' +
      'pauses it and the swapped text is left permanently invisible'
  );

  const tween = src.slice(src.indexOf('function tweenNumerals'));
  const tweenBody = tween.slice(0, tween.indexOf('\n}\n'));
  assert.ok(
    /safety:\s*setTimeout\(settle/.test(tweenBody),
    'the numeral tween needs a timer that settles it if rAF never resumes'
  );
  assert.ok(
    /clearTimeout/.test(src),
    'and the safety timer is cleared, or a stale one fires over a newer year'
  );
});

test('paintNarYear ignores a year it has no data for', () => {
  const f = fakeCard();
  paintNarYear(f.card, '2023', tx);
  assert.equal(f.note.textContent, '', 'nothing was written for an unknown year');
  assert.equal(f.nums[0].textContent, '', 'the tiles were left alone');
});
