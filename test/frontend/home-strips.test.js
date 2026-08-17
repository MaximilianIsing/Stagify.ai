// Tier: pure frontend logic + markup/CSS drift guards — public/scripts/home-strips.js.
//
// #learn ("What virtual staging is, and why it sells") was four stacked image+text
// rows; it is now four photo strips, one open at a time. Three things about that are
// fragile enough to be worth pinning, and all three fail SILENTLY:
//
//  1. THE i18n KEYS. The whole point of the rewrite was that no pack changed. Every
//     data-lang key that was on the old markup has to still be on the new markup, or a
//     string silently reverts to its English fallback on ten locales while English
//     itself looks perfect. The list below is the exact set the old rows carried.
//
//  2. THE `.hstrip__img` SELECTOR IS DUPLICATED IN home-reveal.js. That file warms the
//     section's image decodes by querying a class name it does not own. A rename here
//     does not throw over there — the decode warming just stops happening, and the
//     photos hitch when they animate in.
//
//  3. THE 900px BREAKPOINT IS DUPLICATED between home-strips.js (FLAT_QUERY) and the
//     `.hstrips--ready` block in home.css. Move one and the JS believes it is in a
//     layout the CSS is not rendering.
//
// Plus the fallback guard, which is the one that matters most: index-deferred.js
// injects home-strips.js AFTER `load`, so the un-upgraded markup is what every visitor
// sees first and what they keep if anything in that batch fails. Nothing may hide
// content unless `.hstrips--ready` is in the selector.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { indexForKey, FLAT_QUERY } from '../../public/scripts/home-strips.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (/** @type {string[]} */ ...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const INDEX = read('public', 'index.html');
const HOME_CSS = read('public', 'styles', 'home.css');
const STRIPS_JS = read('public', 'scripts', 'home-strips.js');
const REVEAL_JS = read('public', 'scripts', 'home-reveal.js');
const ENGLISH = JSON.parse(read('public', 'languages', 'english.json'));

/** Every data-lang key the section carries, in the order the strips use them. */
const LEARN_KEYS = ['home.info.title'];
for (const row of ['why', 'how', 'who', 'team']) {
  for (const part of ['eyebrow', 'title', 'body', 'caption', 'p1', 'p2', 'p3']) {
    LEARN_KEYS.push(`home.info.rows.${row}.${part}`);
  }
}

/** Walk a dotted key path into a pack. */
const lookup = (/** @type {string} */ key) =>
  key.split('.').reduce((/** @type {any} */ o, k) => (o == null ? o : o[k]), ENGLISH);

/** The `#learn` section, sliced out of index.html. */
function learnSection() {
  const start = INDEX.indexOf('<section class="home-section home-info" id="learn"');
  assert.ok(start > -1, '#learn section not found in index.html');
  const end = INDEX.indexOf('</section>', start);
  assert.ok(end > start, '#learn section is unterminated');
  return INDEX.slice(start, end);
}

/**
 * Strip comments before scanning for code.
 *
 * Not optional. Every file touched here carries a comment naming the very selector or
 * class the guard looks for — the home-reveal.js note literally spells out
 * `.hstrip__img`, and home.css's fallback note spells out `.hstrips--ready`. Without
 * stripping, each guard would pass with the real code DELETED, matching only on the
 * comment that explains it.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Every declaration written for an EXACT selector, concatenated across however many
 * rules mention it.
 *
 * Deliberately not a regex over the raw text. A rule like
 *   `.hstrips--ready .hstrip.is-open .hstrip__h,\n.hstrips--ready .hstrip__body { … }`
 * contains the literal substring `.hstrips--ready .hstrip__body {`, so a naive match
 * silently reads the wrong block — which is exactly what it did on the first attempt
 * here, and it reported the width rule as if it were the opacity one.
 *
 * @param {string} css comment-stripped stylesheet text
 * @param {string} selector e.g. '.hstrips--ready .hstrip__body'
 * @returns {string} the declarations, joined
 */
/**
 * The stylesheet with every at-rule block (`@media`, `@supports`, …) removed, leaving
 * only the unconditional rules.
 *
 * The strip layout genuinely differs by breakpoint: the wide layout must animate
 * nothing but opacity on its copy (animating the box is what caused the re-wrap-during-
 * slide), while the stacked layout MUST animate max-height, because there the strips
 * are content-sized and that is what opens them. A guard that cannot tell the two apart
 * either fails on correct code or passes on broken code.
 *
 * @param {string} css
 * @returns {string}
 */
function topLevelCss(css) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    if (css[i] === '@') {
      const brace = css.indexOf('{', i);
      if (brace === -1) break;
      let depth = 1;
      let j = brace + 1;
      while (j < css.length && depth > 0) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}') depth--;
        j++;
      }
      i = j;
      continue;
    }
    out += css[i++];
  }
  return out;
}

function declsFor(css, selector) {
  const out = [];
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const list = sel.split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (list.includes(selector)) out.push(body.trim());
  }
  return out.join('\n');
}

/* --------------------------------------------------------------- pure logic */

test('indexForKey wraps in both directions and honours Home/End', () => {
  assert.equal(indexForKey('ArrowRight', 0, 4), 1);
  assert.equal(indexForKey('ArrowRight', 3, 4), 0, 'right off the end wraps to the first');
  assert.equal(indexForKey('ArrowLeft', 0, 4), 3, 'left off the start wraps to the last');
  assert.equal(indexForKey('ArrowLeft', 2, 4), 1);
  // Down/Up are the stacked layout's equivalents of Right/Left.
  assert.equal(indexForKey('ArrowDown', 1, 4), 2);
  assert.equal(indexForKey('ArrowUp', 1, 4), 0);
  assert.equal(indexForKey('Home', 2, 4), 0);
  assert.equal(indexForKey('End', 0, 4), 3);
});

test('indexForKey ignores keys it does not own, so they still scroll the page', () => {
  for (const key of ['Enter', ' ', 'Tab', 'Escape', 'PageDown', 'a']) {
    assert.equal(indexForKey(key, 1, 4), -1, `${key} must not be swallowed`);
  }
});

test('indexForKey cannot divide by zero on an empty strip set', () => {
  assert.equal(indexForKey('ArrowRight', 0, 0), -1);
  assert.equal(indexForKey('Home', 0, 0), -1);
});

/* ------------------------------------------------------------ markup / i18n */

test('#learn ships exactly four strips, each with a button and a panel', () => {
  const section = learnSection();
  const strips = [...section.matchAll(/<div class="hstrip" data-strip="(\d)">/g)].map((m) => m[1]);
  assert.deepEqual(strips, ['0', '1', '2', '3'], 'strips must be present and indexed in order');
  assert.equal((section.match(/class="hstrip__btn"/g) || []).length, 4);
  assert.equal((section.match(/class="hstrip__body"/g) || []).length, 4);
  assert.equal((section.match(/<h3 class="hstrip__h">/g) || []).length, 4, 'each title must stay an <h3>');
});

test('every button controls the panel it is paired with, positionally', () => {
  const section = learnSection();
  const controls = [...section.matchAll(/aria-controls="([^"]+)"/g)].map((m) => m[1]);
  const panels = [...section.matchAll(/<div class="hstrip__body" id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(controls, panels, 'aria-controls must name the panel in the same position');

  const labelledBy = [...section.matchAll(/aria-labelledby="(learn-btn-[^"]+)"/g)].map((m) => m[1]);
  const btnIds = [...section.matchAll(/<button type="button" class="hstrip__btn" id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(labelledBy, btnIds, 'each panel must be labelled by its own button');
});

test('no data-lang key was dropped when the rows became strips', () => {
  const section = learnSection();
  const found = new Set([...section.matchAll(/data-lang="([^"]+)"/g)].map((m) => m[1]));

  // LEARN_KEYS is the exact set the four stacked rows carried. Every one of these is
  // authored in all 11 packs already; losing one here reverts that string to English on
  // ten locales.
  const missing = LEARN_KEYS.filter((k) => !found.has(k));
  assert.deepEqual(missing, [], `#learn lost i18n keys: ${missing.join(', ')}`);
});

test('the English text baked into #learn matches english.json', () => {
  // KEYS ARE NOT ENOUGH — the test above checks that each data-lang key is PRESENT, which
  // says nothing about the text sitting inside the element. The markup ships English
  // inline so the section reads correctly before the language pack loads, and the pack
  // then overwrites it. Let the two drift and the English page silently rewrites itself a
  // beat after load; every other locale looks perfect, so it is easy to miss entirely.
  //
  // This is a two-file edit waiting to go wrong: the strip labels live in index.html AND
  // in english.json, and nothing else pairs them. Same guard as
  // test/i18n/staging-label-i18n.test.js, different feature.
  const section = learnSection();
  // Entities, not defensiveness: home.info.rows.who.p2 ships as "Sellers &amp; buyers" in
  // the markup and "Sellers & buyers" in the pack, so a raw comparison fails on correct code.
  const decode = (/** @type {string} */ s) =>
    s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();

  for (const key of LEARN_KEYS) {
    // Tag-agnostic: these keys sit on h2, p, span and li.
    const el = new RegExp(`<(\\w+)[^>]*data-lang="${key.replace(/\./g, '\\.')}"[^>]*>([\\s\\S]*?)</\\1>`);
    const found = el.exec(section);
    assert.ok(found, `${key} is not on an element with text content in #learn`);
    assert.equal(decode(found[2]), lookup(key), `#learn's inline English for ${key} has drifted from english.json`);
  }
});

test('the four strip headings no longer carry data-tx', () => {
  const section = learnSection();
  // The <h2> keeps its effect; the <h3>s must not have one. Three of the four are hidden
  // at any moment (a collapsed strip shows only its eyebrow), and the effects run once
  // when the section scrolls in — so they would play unseen, and the title would then
  // appear unanimated when its strip was opened.
  assert.match(section, /class="home-section__title" id="learn-title" data-tx="rise"/);
  assert.equal(
    (section.match(/class="hstrip__title"[^>]*data-tx/g) || []).length,
    0,
    'a hidden strip title must not have a data-tx effect'
  );
});

/* ------------------------------------------------------- cross-file drift */

test('home-reveal.js still warms the strip photos', () => {
  const code = stripComments(REVEAL_JS);
  assert.match(
    code,
    /\.hstrip__img/,
    'home-reveal.js warmImages() no longer references .hstrip__img — #learn photo decodes are unwarmed'
  );
  assert.doesNotMatch(code, /\.info-row__media/, 'home-reveal.js still queries the removed .info-row__media');
});

test('the flat breakpoint matches between home-strips.js and home.css', () => {
  const fromJs = FLAT_QUERY.match(/(\d+)px/);
  assert.ok(fromJs, `FLAT_QUERY has no px value: ${FLAT_QUERY}`);

  // The @media block that contains the .hstrips--ready stack rules.
  const css = stripComments(HOME_CSS);
  const blocks = [...css.matchAll(/@media \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/g)];
  const owning = blocks.filter((b) => b[2].includes('.hstrips--ready'));
  assert.equal(owning.length, 1, 'expected exactly one @media block to hold the stacked strip rules');
  assert.equal(
    owning[0][1],
    fromJs[1],
    `home.css stacks the strips at ${owning[0][1]}px but home-strips.js uses ${fromJs[1]}px`
  );
});

test('home-strips.js is registered in the deferred batch', async () => {
  globalThis.document = globalThis.document || /** @type {any} */ ({ readyState: 'loading' });
  globalThis.window = globalThis.window || /** @type {any} */ ({ addEventListener() {} });
  const { DEFERRED } = await import('../../public/scripts/index-deferred.js');
  const entry = DEFERRED.find((e) => e.src === 'scripts/home-strips.js');
  assert.ok(entry, 'home-strips.js is not in the DEFERRED list, so it never loads');
  assert.equal(entry.module, true, 'home-strips.js is an ES module');
});

/* ------------------------------------------------------------- the fallback */

test('nothing hides strip content unless .hstrips--ready is in the selector', () => {
  const css = stripComments(HOME_CSS);

  // Every rule whose selector mentions a strip class, paired with its declarations.
  const rules = [...css.matchAll(/([^{}]*\.hstrip[^{}]*)\{([^{}]*)\}/g)];
  assert.ok(rules.length > 5, 'expected to find the strip rules in home.css');

  const offenders = rules
    .filter(([, selector, body]) => {
      if (selector.includes('.hstrips--ready')) return false;
      // These are what would leave the un-upgraded markup blank or unreadable.
      return /(^|[\s;])(opacity:\s*0|max-height:\s*0|display:\s*none|visibility:\s*hidden)/.test(body);
    })
    .map(([, selector]) => selector.trim().replace(/\s+/g, ' '));

  assert.deepEqual(
    offenders,
    [],
    `these rules hide #learn content without requiring the widget to be up: ${offenders.join(' | ')}`
  );
});

test('a collapsed panel is hidden visually, not removed from the accessibility tree', () => {
  const css = stripComments(HOME_CSS);
  const decls = declsFor(css, '.hstrips--ready .hstrip__body');
  assert.ok(decls, 'the strip-body rule is missing from home.css');

  // Hiding by opacity keeps the text in the document: a screen reader can still reach
  // it and Ctrl+F still finds it. `display:none` / `visibility:hidden` would not —
  // three quarters of this section's copy would cease to exist for anyone not using a
  // mouse to open each strip in turn. The hide is a visual state, not a deletion.
  assert.match(decls, /opacity:\s*0/, 'the collapsed panel must be hidden with opacity');
  assert.doesNotMatch(
    decls,
    /display:\s*none|visibility:\s*hidden|content-visibility:\s*hidden/,
    'a collapsed strip panel must stay in the accessibility tree and findable by in-page search'
  );
});

test('a collapsed spine shows its short label and keeps its title in the accessible name', () => {
  // Wide layout only: stacked, the strip is full width and the full title is the label.
  const css = topLevelCss(stripComments(HOME_CSS));
  const hidden = /display:\s*none|visibility:\s*hidden/;

  // The eyebrow IS the spine's label — the title is too long to set upright in 72-96px,
  // which is why it used to run sideways. Hide the eyebrow too and the strip becomes a
  // blank clickable panel: no error, no missing-content warning, just three unlabelled
  // photos that happen to be buttons.
  const eyebrow = declsFor(css, '.hstrips--ready .hstrip:not(.is-open) .hstrip__eyebrow');
  assert.ok(eyebrow, 'the collapsed spine no longer styles its label at all');
  assert.doesNotMatch(
    eyebrow,
    new RegExp(`${hidden.source}|opacity:\\s*0`),
    'the eyebrow is the collapsed spine\'s only visible label — hiding it leaves a blank panel'
  );

  // `width: min-content` is what stacks the label one word per line. Paired with it,
  // `overflow-wrap` is a trap: `break-word` and `anywhere` differ only in that `anywhere`
  // counts toward MIN-CONTENT sizing — so swapping it in resolves the box to one character
  // and stacks every LETTER down the spine. Nothing errors; the label just becomes a
  // column of single letters. `keep-all` is the same guard for the space-less CJK packs.
  // One word per row takes BOTH of these and neither works alone: min-content alone lets
  // two short words share a row ("HOW IT / WORKS"), and the oversized word-spacing alone
  // makes the label scroll sideways inside .hstrip's overflow:hidden. Dropping either one
  // still renders a label, just not the stacked one.
  assert.match(eyebrow, /width:\s*min-content/, 'the spine label is no longer stacked by word');
  assert.match(
    eyebrow,
    /word-spacing:\s*100vw/,
    'without a word-spacing wider than the label box, short words share a row — "HOW IT / WORKS"'
  );
  assert.match(
    eyebrow,
    /overflow-wrap:\s*break-word/,
    'the spine label must use overflow-wrap:break-word — `anywhere` feeds min-content sizing and stacks one LETTER per row'
  );
  assert.doesNotMatch(eyebrow, /overflow-wrap:\s*anywhere/, 'see above — `anywhere` breaks the min-content width');
  assert.match(eyebrow, /word-break:\s*keep-all/, 'without keep-all the CJK packs stack one character per row');

  // The title is hidden VISUALLY. display:none would make each button's accessible name
  // change as it expands, and would drop three of the section's four headings from the
  // page for anyone not opening every strip in turn.
  const title = declsFor(css, '.hstrips--ready .hstrip:not(.is-open) .hstrip__title');
  assert.match(title, /clip-path:\s*inset/, 'the collapsed title must be clipped, not removed');
  assert.doesNotMatch(
    title,
    hidden,
    'a collapsed strip title must stay in the accessibility tree — it is part of its button\'s name'
  );

  // THE HEADER MUST NOT GO BACK INTO FLOW. `.hstrip` is a flex column justified to
  // flex-end and the collapsed `.hstrip__body` keeps its full 600-800px natural height
  // while invisible, so in flow it pushes the label off the top of the 460px strip.
  assert.match(
    declsFor(css, '.hstrips--ready .hstrip:not(.is-open) .hstrip__h'),
    /position:\s*absolute/,
    'the collapsed header must stay out of flow, or the invisible panel below it shoves the label off the strip'
  );
});

test('the copy does not re-wrap while the strip is animating', () => {
  // Wide layout only — see topLevelCss. The stacked layout has no width animation to
  // re-wrap against and deliberately does the opposite of everything asserted here.
  const css = topLevelCss(stripComments(HOME_CSS));

  // The failure this prevents is not a crash, it is a feel: a body whose width tracks
  // the strip re-wraps from ~30 lines to 4 on every frame of the open transition.
  // Both the heading and the copy need it — the heading reflowed just as badly.
  for (const sel of ['.hstrips--ready .hstrip__body', '.hstrips--ready .hstrip.is-open .hstrip__h']) {
    assert.match(
      declsFor(css, sel),
      /width:\s*\d+cqw/,
      `${sel} must be sized in container units, not by the animating strip width`
    );
  }

  // cqw without container-type is not an error — it silently resolves against the
  // VIEWPORT instead, blowing the copy out to half the window on a wide screen.
  assert.match(
    declsFor(css, '.hstrips--ready'),
    /container-type:\s*inline-size/,
    '.hstrips--ready uses cqw units but no longer declares container-type — cqw would resolve against the viewport'
  );

  // And the copy must not animate its geometry, only its opacity.
  const body = declsFor(css, '.hstrips--ready .hstrip__body');
  const openBody = declsFor(css, '.hstrips--ready .hstrip.is-open .hstrip__body');
  for (const [what, decls] of [['collapsed', body], ['open', openBody]]) {
    assert.doesNotMatch(
      decls,
      /transition:[^;]*(max-height|width|transform|height)/,
      `the ${what} strip copy must animate opacity only — animating its box is what made switching feel busy`
    );
  }
});

test('home-strips.js only upgrades the markup once it has a usable widget', () => {
  const code = stripComments(STRIPS_JS);
  // The bail-out must come BEFORE the class that switches the layout on, or a partial
  // build leaves four absolutely-positioned slivers instead of four readable cards.
  const bail = code.indexOf('if (!sc) return;');
  const upgrade = code.indexOf("classList.add('hstrips--ready')");
  assert.ok(bail > -1, 'home-strips.js no longer bails when build() fails');
  assert.ok(upgrade > -1, 'home-strips.js no longer adds .hstrips--ready');
  assert.ok(bail < upgrade, '.hstrips--ready is added before the build() bail-out');
});

test('the copy starts arriving before the slide ends, so no panel sits empty', () => {
  // Wide layout only: the slide this is tuned against does not exist when stacked.
  const css = topLevelCss(stripComments(HOME_CSS));

  const seconds = (/** @type {string} */ s) => (s.endsWith('ms') ? parseFloat(s) / 1000 : parseFloat(s));

  const slide = declsFor(css, '.hstrips--ready .hstrip').match(/transition:\s*flex-grow\s+([\d.]+m?s)/);
  assert.ok(slide, 'the strip width transition is missing');

  const open = declsFor(css, '.hstrips--ready .hstrip.is-open .hstrip__body')
    .match(/transition:\s*opacity\s+([\d.]+m?s)\s+\w+\s+([\d.]+m?s)/);
  assert.ok(open, 'the open-copy fade must declare a duration and a delay');

  const slideMs = seconds(slide[1]);
  const delayMs = seconds(open[2]);

  // Too long a delay and the outgoing copy (which fades fast) is gone while the
  // incoming has not started — a wide, visibly empty panel. That is the regression
  // this pins; it shipped once at a 0.34s delay against a 0.38s slide and read as the
  // text simply being missing.
  assert.ok(
    delayMs < slideMs,
    `the copy's fade starts at ${delayMs}s but the slide only ends at ${slideMs}s — the open panel will sit empty`
  );
  // And not so early that it fades in during the fast part of the travel.
  assert.ok(delayMs > 0, 'the copy needs some delay, or it fades in while the strip is still moving fast');
});

/**
 * The `@media (max-width: …)` block that holds the stacked strip rules.
 * @returns {string}
 */
function stackedBlock() {
  const css = stripComments(HOME_CSS);
  const blocks = [...css.matchAll(/@media \(max-width: \d+px\) \{([\s\S]*?)\n\}/g)];
  const owning = blocks.filter((b) => b[1].includes('.hstrips--ready'));
  assert.equal(owning.length, 1, 'expected exactly one @media block to hold the stacked strip rules');
  return owning[0][1];
}

test('the stacked layout undoes the desktop-only fixed measure', () => {
  // The 52cqw measure exists solely to stop re-wrapping during the width animation.
  // Stacked there is no width animation, and leaving it on rendered the body at 184px
  // inside a 354px strip — the paragraph ran to fifteen lines down one edge.
  assert.match(
    stackedBlock(),
    /\.hstrips--ready \.hstrip__body \{[^{}]*width:\s*auto/,
    'the stacked layout must reset the copy width, or it renders at ~half the screen'
  );
});

test('a collapsed strip contributes no body height when stacked', () => {
  // Wide, the strip has a fixed height and clips, so a hidden body costs nothing.
  // Stacked, strips are sized by their content — without this the hidden bodies
  // inflated every collapsed strip to 600-800px and the section to ~2,900px.
  const block = stackedBlock();
  assert.match(
    block,
    /\.hstrips--ready \.hstrip:not\(\.is-open\) \.hstrip__body \{[^{}]*grid-template-rows:\s*0fr/,
    'a collapsed strip must contribute no height when stacked'
  );
  assert.doesNotMatch(
    block,
    /\.hstrips--ready \.hstrip:not\(\.is-open\) \.hstrip__body \{[^{}]*(display:\s*none|visibility:\s*hidden)/,
    'collapsing must not remove the panel from the accessibility tree'
  );

  // The open height must follow the CONTENT, never a fixed cap. 460px cleared English
  // at 390px but clipped German (556px needed) and French (534px) at 320px — the last
  // bullet and the caption simply vanished, with nothing to indicate it.
  assert.doesNotMatch(
    block,
    /\.hstrips--ready \.hstrip__body \{[^{}]*max-height:\s*\d/,
    'the stacked panel must not cap its height with a fixed value — no number is right for 11 packs across every phone width'
  );

  // The 0fr row only collapses if the wrapper gives up its automatic minimum size.
  assert.match(
    block,
    /\.hstrips--ready \.hstrip__inner \{[^{}]*min-height:\s*0/,
    '.hstrip__inner needs min-height:0 or the grid row cannot shrink to 0fr'
  );
});

test('every strip panel has the inner wrapper the collapse animation needs', () => {
  const section = learnSection();
  // grid-template-rows: 0fr collapses the ROW; something inside it has to carry the
  // overflow. Without this wrapper the stacked panels do not close at all.
  assert.equal(
    (section.match(/<div class="hstrip__inner">/g) || []).length,
    4,
    'each of the four strip bodies needs a .hstrip__inner wrapper'
  );
});

test('the whole collapsed strip is a tap target, not just its heading', () => {
  const code = stripComments(STRIPS_JS);
  // On a phone the heading is a ~40px bar at the bottom of a ~104px panel. If only the
  // button is wired, two thirds of what looks tappable does nothing.
  assert.match(
    code,
    /strip\.addEventListener\('click'/,
    'the strip itself must handle clicks, not only its button'
  );
  // ...but a click inside the OPEN panel must not re-trigger, or selecting the copy
  // fights the widget.
  assert.match(
    code,
    /strip\.addEventListener\('click',[\s\S]{0,160}!strip\.classList\.contains\('is-open'\)/,
    'the strip-level click must be guarded on the collapsed state'
  );
});

test('switching the widget on is applied, not animated', () => {
  const code = stripComments(STRIPS_JS);
  const css = stripComments(HOME_CSS);

  // The fallback deliberately shows every panel's copy. Turning the widget on therefore
  // drives three of them from opacity 1 to 0 — and unless transitions are suppressed for
  // that one frame it FADES, so every page load flashes four panels of text.
  const noTx = code.indexOf("classList.add('hstrips--no-tx')");
  const ready = code.indexOf("classList.add('hstrips--ready')");
  assert.ok(noTx > -1, 'home-strips.js no longer suppresses transitions during the upgrade');
  assert.ok(noTx < ready, 'transitions must be suppressed BEFORE the upgrade class lands');
  assert.match(code, /void root\.offsetHeight/, 'the suppressed state must be flushed before transitions come back');

  assert.match(
    css,
    /\.hstrips--no-tx[\s\S]{0,60}\{[^{}]*transition:\s*none\s*!important/,
    'home.css no longer defines the transition-suppressing rule the script relies on'
  );

  // rAF alone is not enough: this file is injected after `load`, and rAF does not fire
  // in a background tab — the section would keep its transitions off for the whole visit.
  assert.match(code, /requestAnimationFrame\(enableTransitions\)/, 'missing the rAF re-enable');
  assert.match(code, /setTimeout\(enableTransitions,\s*\d+\)/, 'missing the timer backstop for background tabs');
});

test('home-strips.js survives being injected after load', () => {
  const code = stripComments(STRIPS_JS);
  assert.match(
    code,
    /document\.readyState === 'loading'[\s\S]{0,200}else\s*\{?\s*init\(\)/,
    'home-strips.js must call init() directly when the document is already parsed'
  );
});
