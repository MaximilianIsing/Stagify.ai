// Tier: pure frontend logic + markup/CSS/i18n drift guards — public/scripts/home-restage.js.
//
// #restage ("Press it again. Get a different room.") replaced the before/after drag wipe.
// Five things about it are fragile enough to pin, and every one of them fails SILENTLY —
// the section keeps working, it just stops being correct:
//
//  1. THE DRAW. The whole promise of the section is that pressing again gives you
//     something new. A regression to Math.random() per press still "works" — it just
//     starts repeating within a handful of presses, which a visitor reads as broken.
//     The properties below (whole pool before any repeat, never twice in a row) are the
//     feature, so they are asserted directly rather than through the DOM.
//
//  2. THE POOL LIST vs THE FILES ON DISK. restage-pool.js is checked in because the
//     browser cannot list a directory and a manifest fetch would put a round-trip on the
//     critical path. That means adding or deleting a render is two edits, and forgetting
//     the second one 404s a press (or silently drops an image from rotation).
//
//  3. THE BUTTON MUST NOT WORK WITHOUT JS. index-deferred.js injects this module after
//     `load`, so the served markup is what every visitor sees first and keeps forever if
//     that batch fails. The button therefore ships `disabled` and stays invisible until
//     `.rs--ready`. A dead, visible control is the failure mode being guarded.
//
//  4. NO STRING HERE MAY CARRY A PLACEHOLDER. There was briefly a "{seen} of {n} looks
//     so far" counter; it is gone, and with it the only reason this section had to
//     interpolate anything. Every remaining string is either server-rendered by
//     routes/i18n.js for the ten localized URLs or written straight to textContent, so
//     a stray brace reintroduced by a translator ships literally to the visitor. The
//     guard is asserted over the whole key set rather than one key, and the counter's
//     removal is pinned in markup, module and packs so it cannot creep back halfway.
//
//  5. THE EXTERIOR WIPE SURVIVED. Removing this section's wipe left mountWipe() with
//     exactly one caller (#exterior-studio-demo in the showcase carousel) and all the
//     `.ba*` CSS with exactly one consumer. Both now look dead to a grep, and deleting
//     either silently empties a showcase panel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeBag } from '../../public/scripts/home-restage.js';
import { RESTAGE_DIR, RESTAGE_EMPTY, RESTAGE_POOL, RESTAGE_SIZE } from '../../public/scripts/restage-pool.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (/** @type {string[]} */ ...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

/**
 * Strip CSS comments before any rule scanning.
 *
 * Not optional here. The rules this file guards are heavily commented — and those
 * comments quote the very selectors they warn about, e.g. "`.rs__btn-label--again {
 * visibility: hidden }` loses to it outright". A raw scan happily matches that prose as
 * if it were a live rule, so the guards started failing against a stylesheet that was
 * completely correct, and would equally have passed against a broken one.
 *
 * @param {string} css
 * @returns {string}
 */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Same idea for JavaScript sources. The module's comments spell out the very calls the
 * guards below forbid ("DO NOT await image.decode()"), so an unstripped scan reads the
 * warning as the offence and fails against correct code — which is exactly what
 * happened. Block comments plus whole-line `//` comments is enough here; no trailing
 * comment in this module sits on a line with code that a guard inspects.
 *
 * @param {string} js
 * @returns {string}
 */
const stripJs = (js) =>
  js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const INDEX = read('public', 'index.html');
const HOME_CSS = stripComments(read('public', 'styles', 'home.css'));
const DEFERRED = read('public', 'scripts', 'index-deferred.js');
const STUDIO_JS = read('public', 'scripts', 'staging-studio.js');

const PACKS = [
  'english', 'spanish', 'french', 'german', 'italian', 'portuguese',
  'dutch', 'russian', 'japanese', 'korean', 'chinese',
];

/* -------------------------------------------------------------- 1. the draw */

test('the bag deals the entire pool before anything repeats', () => {
  const items = Array.from({ length: 60 }, (_, i) => `r${i}`);
  const bag = makeBag(items);
  const seen = Array.from({ length: items.length }, () => bag.draw());
  assert.equal(new Set(seen).size, items.length,
    'a full cycle must contain every render exactly once');
});

test('the bag never deals the same render twice in a row, across cycles', () => {
  const items = Array.from({ length: 12 }, (_, i) => `r${i}`);
  // Many cycles: the risky boundary is the reshuffle, which is only exercised on wrap.
  for (let trial = 0; trial < 200; trial++) {
    const bag = makeBag(items);
    const seen = Array.from({ length: items.length * 4 }, () => bag.draw());
    for (let i = 1; i < seen.length; i++) {
      assert.notEqual(seen[i], seen[i - 1],
        `back-to-back repeat of ${seen[i]} at draw ${i} (trial ${trial})`);
    }
  }
});

test('every cycle after the first is also a full permutation', () => {
  const items = Array.from({ length: 10 }, (_, i) => `r${i}`);
  const bag = makeBag(items);
  for (let cycle = 0; cycle < 5; cycle++) {
    const seen = Array.from({ length: items.length }, () => bag.draw());
    assert.equal(new Set(seen).size, items.length, `cycle ${cycle} dropped or repeated an item`);
  }
});

test('the bag is not a rotation — order varies between instances', () => {
  const items = Array.from({ length: 30 }, (_, i) => `r${i}`);
  const orders = new Set(
    Array.from({ length: 20 }, () => {
      const bag = makeBag(items);
      return Array.from({ length: items.length }, () => bag.draw()).join(',');
    })
  );
  // A fixed or insufficiently shuffled order would collapse these to one or two strings.
  assert.ok(orders.size > 15, `expected varied orders, got ${orders.size} distinct of 20`);
});

test('an empty pool draws null rather than throwing', () => {
  assert.equal(makeBag([]).draw(), null);
});

/* ------------------------------------------- 2. the pool list vs the files */

test('restage-pool.js lists exactly the renders that exist on disk', () => {
  const dir = path.join(ROOT, 'public', 'media-webp', 'Homepage', 'Restage');
  const onDisk = fs.readdirSync(dir).filter((f) => /^r\d+\.webp$/.test(f)).sort();
  assert.deepEqual([...RESTAGE_POOL].sort(), onDisk,
    'add or remove a render and public/scripts/restage-pool.js must be updated to match');
  assert.ok(RESTAGE_POOL.length >= 20,
    'the pool is the whole point — a handful of renders would repeat visibly');
});

test('the empty source photo exists and is served from the same directory', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'public', RESTAGE_DIR + RESTAGE_EMPTY)));
  assert.ok(INDEX.includes(RESTAGE_DIR + RESTAGE_EMPTY),
    'index.html must reference the same empty photo the module documents');
});

test('every pool file is small enough to fetch on a press', () => {
  const dir = path.join(ROOT, 'public', 'media-webp', 'Homepage', 'Restage');
  for (const file of RESTAGE_POOL) {
    const kb = fs.statSync(path.join(dir, file)).size / 1024;
    assert.ok(kb < 150, `${file} is ${Math.round(kb)} KB; a press should not cost that much`);
  }
});

/* ------------------------------------------------ 3. progressive enhancement */

test('the button ships disabled and hidden until the script marks the root ready', () => {
  const button = INDEX.match(/<button[^>]*data-restage-btn[^>]*>/);
  assert.ok(button, 'index.html must carry the [data-restage-btn] control');
  assert.match(button[0], /\bdisabled\b/,
    'the served button must be disabled — home-restage.js loads after `load`, so a ' +
    'failure in that batch would otherwise leave a live control that does nothing');
  assert.match(HOME_CSS, /\.rs__btn\s*\{[^}]*visibility:\s*hidden/,
    '.rs__btn must be hidden by default');
  assert.match(HOME_CSS, /\.rs--ready\s+\.rs__btn\s*\{[^}]*visibility:\s*visible/,
    'only `.rs--ready` may reveal it, so the reveal cannot happen without working JS');
});

test('the section is registered in the deferred batch', () => {
  assert.match(DEFERRED, /scripts\/home-restage\.js/);
});

test('the section markup carries every hook the module queries', () => {
  for (const hook of ['data-restage', 'data-restage-btn', 'data-restage-revert',
    'rs__stack', 'rs__empty', 'id="restage"']) {
    assert.ok(INDEX.includes(hook), `index.html is missing ${hook}`);
  }
});

test('the frame is ratio-locked and the image carries no width/height attributes', () => {
  // width/height attributes resolve as a presentational height, which defeats CSS
  // aspect-ratio outright unless height:auto is also set. The stack is the ratio
  // holder here and .rs__stack img is absolutely positioned, so there is no CLS to
  // trade away by omitting them.
  // Pinned to RESTAGE_SIZE rather than to a literal, so the stylesheet cannot drift from
  // the real dimensions of the photographs. That constant has no runtime importer — this
  // is what makes it load-bearing rather than dead, and why it must not be "cleaned up".
  const ratio = new RegExp(
    `\\.rs__stack\\s*\\{[^}]*aspect-ratio:\\s*${RESTAGE_SIZE.width}\\s*/\\s*${RESTAGE_SIZE.height}`
  );
  assert.match(HOME_CSS, ratio,
    `.rs__stack must be locked to the source photo's ${RESTAGE_SIZE.width}x${RESTAGE_SIZE.height}`);
  const img = INDEX.match(/<img[^>]*class="rs__empty"[^>]*>/);
  assert.ok(img, 'the empty-room image must be present');
  assert.doesNotMatch(img[0], /\s(width|height)=/,
    'width/height attributes here would defeat the .rs__stack aspect-ratio');
});

test('the frame cannot be stretched, or aspect-ratio runs backwards and it overflows', () => {
  // The bug this pins shipped and was reported: `.rs` sets `align-items: stretch`, which
  // makes .rs__stack's HEIGHT definite; `aspect-ratio` then computes the WIDTH from that
  // height instead of the other way round, and the frame grows past its own grid track
  // and out over the copy panel. The panel is translucent, so the photo shows through it.
  // Measured at a 920px container: 551px track, 841px frame — a 290px overlap.
  //
  // It is width-dependent (the narrower the right column, the more its copy wraps, the
  // taller the row, the wider the frame), so it looks perfect at full width. That is
  // exactly why it needs a guard rather than an eyeball.
  const stack = HOME_CSS.match(/\.rs__stack\s*\{[^}]*\}/);
  assert.ok(stack, 'home.css must style the frame');
  assert.match(stack[0], /aspect-ratio:/, 'the frame is ratio-locked — that is the premise');
  const align = stack[0].match(/align-self:\s*([\w-]+)/);
  assert.ok(align, '.rs__stack must set align-self explicitly, or it inherits stretch from .rs');
  assert.ok(align[1] !== 'stretch',
    'align-self: stretch is what makes the height definite and inverts aspect-ratio');
  // And the escape hatch that looks like a fix but is not: pinning the width stops the
  // overflow by overriding the ratio, so every render would crop instead.
  assert.ok(!/width:\s*100%/.test(stack[0]),
    'width:100% would stop the overflow by breaking the 1216:832 lock — the ratio is ' +
    'load-bearing here, so the alignment is what gives');
});

test('no clipping layer also carries backdrop-filter', () => {
  // Chrome stops painting descendant <img>s when backdrop-filter and overflow:hidden
  // land on the SAME element, and every diagnostic still reports the image healthy.
  for (const [name, re] of [
    ['.rs__stack', /\.rs__stack\s*\{[^}]*\}/],
    ['.rs__card', /\.rs__card\s*\{[^}]*\}/],
  ]) {
    const block = HOME_CSS.match(/** @type {RegExp} */ (re));
    assert.ok(block, `home.css must style ${name}`);
    assert.ok(!block[0].includes('backdrop-filter'),
      `${name} pairs backdrop-filter with clipping, which would blank every render`);
  }
  // The frame must NOT clip, or the thrown card is cut off at the left edge.
  const stack = HOME_CSS.match(/\.rs__stack\s*\{[^}]*\}/);
  assert.ok(!stack[0].includes('overflow: hidden'),
    'clipping the frame would cut the departing card off mid-throw');
});

/* --------------------------------------------------------- 4. the i18n keys */

const SECTION_KEYS = [
  'home.restage.title', 'home.restage.subtitle', 'home.restage.kicker',
  'home.restage.panelTitle', 'home.restage.panelBody', 'home.restage.button',
  'home.restage.buttonAgain', 'home.restage.seeOriginal',
  'home.restage.emptyAlt', 'home.restage.stagedAlt', 'home.restage.loadFailed',
  // Reused rather than duplicated: the three points are the ORIGINAL bullets from the
  // section this replaced, already translated in all eleven packs.
  'home.studio.points.speed', 'home.studio.points.restage', 'home.studio.points.rights',
  // Desktop-only extras.
  'home.restage.points.rooms', 'home.restage.points.browser',
];

/** @param {Record<string, any>} pack @param {string} key */
const lookup = (pack, key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), pack);

for (const name of PACKS) {
  test(`${name}.json carries every string the section renders`, () => {
    const pack = JSON.parse(read('public', 'languages', `${name}.json`));
    for (const key of SECTION_KEYS) {
      const value = lookup(pack, key);
      assert.equal(typeof value, 'string', `${name}.json is missing ${key}`);
      assert.ok(value.trim().length, `${name}.json has an empty ${key}`);
    }
  });

}

test('no string the section renders carries an un-substituted placeholder', () => {
  // Every one of these is either server-rendered by routes/i18n.js or written straight
  // to textContent, so a surviving {brace} would ship literally to the visitor.
  for (const name of PACKS) {
    const pack = JSON.parse(read('public', 'languages', `${name}.json`));
    for (const key of SECTION_KEYS) {
      assert.doesNotMatch(lookup(pack, key), /[{}]/, `${name}.json: ${key} has a placeholder`);
    }
  }
});

test('the counter and its keys are gone from markup, module and packs', () => {
  const source = read('public', 'scripts', 'home-restage.js');
  assert.ok(!INDEX.includes('data-restage-hint'), 'the hint element was removed');
  assert.ok(!source.includes('hintCount'), 'the module no longer renders a count');
  for (const name of PACKS) {
    const pack = JSON.parse(read('public', 'languages', `${name}.json`));
    assert.ok(!('hintCount' in pack.home.restage), `${name}.json still carries hintCount`);
    assert.ok(!('hintIdle' in pack.home.restage), `${name}.json still carries hintIdle`);
  }
});

test('the first press throws something too', () => {
  // The empty room is the permanent base layer, not a card, so there is nothing to throw
  // on the opening press unless the module makes a disposable copy of it. That press is
  // the one most visitors ever make, and without this it popped the staged room in with
  // no animation at all.
  const source = read('public', 'scripts', 'home-restage.js');
  assert.match(source, /current \|\| makeGhost\(\)/,
    'stage() must fall back to a throwaway copy of the empty photo when no card is showing');
  assert.match(source, /void ghost\.offsetWidth/,
    'the copy must be laid out at rest for a frame, or the throw transition never runs');
  assert.match(source, /ghost\.setAttribute\('aria-hidden', 'true'\)/,
    'the copy duplicates an image already in the document, so it must not be announced');
});

test('the departing card is thrown clear of the arriving one', () => {
  const leaving = HOME_CSS.match(/\.rs__card\.is-leaving\s*\{[^}]*\}/);
  assert.ok(leaving, 'home.css must style the leaving card');
  // z-index: without it the exit happens *underneath* the new card and is never seen.
  assert.match(leaving[0], /z-index:\s*2/, 'the leaving card must paint above the arriving one');
  // Travel further than the card's own width, or it vanishes partway across.
  const travel = leaving[0].match(/translateX\(-(\d+(?:\.\d+)?)%\)/);
  assert.ok(travel, 'it must travel left, not just fade');
  assert.ok(Number(travel[1]) >= 100,
    `throw is only ${travel[1]}% — under 100% the card never fully leaves the frame`);
  // A LATE opacity fade, or the motion is hidden behind a cross-fade.
  const fade = leaving[0].match(/opacity\s+([\d.]+)s\s+[a-z-]+\s+([\d.]+)s/);
  assert.ok(fade, 'the opacity fade must be delayed so the card stays solid through the flight');
  // And the whole exit has to stay brisk — a longer throw reads as the card being
  // dragged off rather than flicked. The JS removal timer must outlast it.
  const travelMs = Number(leaving[0].match(/transform\s+([\d.]+)s/)[1]) * 1000;
  assert.ok(travelMs <= 550, `exit runs ${travelMs}ms; over ~550ms it drags`);
  assert.ok(Number(fade[1]) * 1000 + Number(fade[2]) * 1000 <= travelMs + 20,
    'the fade must finish with the flight, not after it');
  const removal = Number(read('public', 'scripts', 'home-restage.js')
    .match(/card\.remove\(\), (\d+)\)/)[1]);
  assert.ok(removal > travelMs, `cards are removed after ${removal}ms, cutting the ${travelMs}ms exit short`);
});

test('the two button labels are stacked so the width never changes', () => {
  const btn = INDEX.match(/<button[^>]*data-restage-btn[\s\S]*?<\/button>/);
  assert.ok(btn, 'the stage button must exist');
  assert.ok(btn[0].includes('home.restage.button'), 'the first-press label ships in markup');
  assert.ok(btn[0].includes('home.restage.buttonAgain'), 'the repeat label ships too');
  const rule = HOME_CSS.match(/\.rs__btn\s*\{[^}]*\}/);
  assert.match(rule[0], /display:\s*grid/, 'both labels must share one grid cell');
  assert.match(HOME_CSS, /\.rs__btn-label\s*\{[^}]*grid-area:\s*1\s*\/\s*1/,
    'stacking them in the same cell is what pins the width across the flip');
  assert.ok(!/button\.textContent\s*=/.test(read('public', 'scripts', 'home-restage.js')),
    'the module must not write the label — markup owns both, so a language re-apply is safe');
});

test('the label swap cross-fades, so the button is never blank mid-transition', () => {
  // The first attempt at this SEQUENCED the two labels — out over 0.13s, then in over
  // 0.13s — so that only one was ever `visibility: visible` and the accessible name could
  // not read as both at once. It was correct and it looked wrong: for ~40ms in the middle
  // the pill had no text on it at all. The two concerns are now separated — pixels
  // overlap, `aria-hidden` carries the name — and this guard pins that separation.
  const outRule = HOME_CSS.match(/\.rs\.has-staged \.rs__btn \.rs__btn-label--first\s*\{[^}]*\}/);
  const inRule = HOME_CSS.match(/\.rs\.has-staged \.rs__btn \.rs__btn-label--again\s*\{[^}]*\}/);
  const base = HOME_CSS.match(/\.rs \.rs__btn \.rs__btn-label\s*\{[^}]*\}/);
  assert.ok(outRule && inRule && base, 'both halves of the swap must be styled');

  // No delay on either side: any stagger reopens the blank gap.
  const delay = (/** @type {string} */ block) => {
    const m = block.match(/opacity\s+[\d.]+s\s+[a-z-]+\s+([\d.]+)s/);
    return m ? Number(m[1]) : 0;
  };
  assert.equal(delay(base[0]), 0, 'the shared transition must not delay the fade');
  for (const [name, block] of [['outgoing', outRule[0]], ['incoming', inRule[0]]]) {
    assert.equal(delay(block), 0,
      `the ${name} label declares a transition-delay — staggering the two is what left ` +
      'the button blank in the middle of the swap');
  }
  assert.match(base[0], /transition:\s*opacity\s+[\d.]+s/, 'the labels must fade, not cut');

  // visibility must NOT ride along with the fade any more: it would hide the very label
  // that is supposed to still be painted on its way out.
  for (const [name, block] of [['outgoing', outRule[0]], ['incoming', inRule[0]], ['base', base[0]]]) {
    assert.ok(!/visibility/.test(block),
      `the ${name} rule still switches visibility, which cannot overlap with a cross-fade`);
  }

  // Opposite directions, or the two wordings smudge into each other.
  assert.match(outRule[0], /transform:\s*translateY\(-[\d.]+px\)/, 'the old wording lifts away');
  const restingIn = HOME_CSS.match(/\.rs \.rs__btn \.rs__btn-label--again\s*\{[^}]*\}/);
  assert.ok(restingIn && /transform:\s*translateY\([\d.]+px\)/.test(restingIn[0]),
    'the new wording rises from below');

  // The accessible name is now the module's job, and it must cover every state change.
  const source = stripJs(read('public', 'scripts', 'home-restage.js'));
  assert.match(source, /function syncLabelAria\(staged\)/, 'the module must own the name');
  assert.match(source, /labelFirst\.setAttribute\('aria-hidden', String\(staged\)\)/);
  assert.match(source, /labelAgain\.setAttribute\('aria-hidden', String\(!staged\)\)/);
  assert.equal((source.match(/syncLabelAria\(/g) || []).length, 4,
    'syncLabelAria must be defined and called at all three state changes — mount, the ' +
    'render landing, and revert. A missed call leaves the name stuck on the old wording.');

  // And the pre-ready hide has to survive, or both labels paint inside a button that is
  // meant to be invisible (the anti-FOUC rule forces [data-lang] back to visible).
  assert.match(HOME_CSS, /\.rs:not\(\.rs--ready\) \.rs__btn \.rs__btn-label\s*\{[^}]*visibility:\s*hidden/,
    'both labels must still be hidden before the module marks the section ready');
});

test('the retired sequencing leaves nothing behind', () => {
  // `has-swapped` existed only to tell "just mounted" from "just reverted" for the old
  // sequenced timing. The cross-fade needs no such distinction, so the class and its rule
  // must go rather than linger as a state nobody reads.
  const source = stripJs(read('public', 'scripts', 'home-restage.js'));
  assert.ok(!source.includes('has-swapped'), 'the module must no longer set has-swapped');
  assert.ok(!HOME_CSS.includes('has-swapped'), 'and home.css must no longer style it');
});

test('the label swap keeps the accessible name to exactly one wording', () => {
  // With the labels cross-fading, BOTH are painted for a quarter second, so nothing about
  // the CSS keeps the button from being announced as "Stage this room Stage it again".
  // aria-hidden is the only thing standing between the visitor and that, and it is set
  // from JS — so the markup must ship a sane starting state and the module must cover
  // every transition.
  const btn = INDEX.match(/<button[^>]*data-restage-btn[\s\S]*?<\/button>/);
  assert.ok(btn, 'the stage button must exist');
  // The served markup must NOT claim a label is hidden: without JS the button never
  // appears at all, and a stale aria-hidden would be a lie about a control nobody sees.
  assert.ok(!/aria-hidden/.test(btn[0]),
    'the labels must not ship aria-hidden — the module sets it once it has mounted');

  // Mount, land, revert. Miss one and the name sticks on the wording that is fading out.
  const source = stripJs(read('public', 'scripts', 'home-restage.js'));
  const pairs = [
    ['a render landing', /classList\.add\('has-staged'\);\s*\n\s*syncLabelAria\(true\);/],
    ['revert', /classList\.remove\('has-staged'\);\s*\n\s*syncLabelAria\(false\);/],
    ['mount', /syncLabelAria\(false\);\s*\n\s*\/?\/?[^\n]*\n?\s*button\.disabled = false;/],
  ];
  for (const [where, re] of pairs) {
    assert.match(source, re, `the accessible name must be resynced at ${where}`);
  }
});

test('every visibility rule on a [data-lang] element outranks the i18n anti-FOUC rule', () => {
  // styles.css hides then re-shows every translatable element:
  //     body.language-loaded [data-lang] { visibility: visible }   -> (0,2,1)
  // Anything in this section that hides a [data-lang] element with `visibility` must
  // beat that, or the rule silently does nothing: the two button labels paint on top of
  // each other, and the "hidden" revert control stays focusable while invisible. This
  // fails a plain `.rs__btn-label--again { visibility: hidden }`, which is what shipped
  // first and looked correct in the stylesheet.
  const STYLES = stripComments(read('public', 'styles', 'styles.css'));
  assert.match(STYLES, /body\.language-loaded \[data-lang\][^{]*\{\s*visibility:\s*visible/,
    'the anti-FOUC rule this guard is calibrated against has moved or changed');

  /** Count (classes+attributes+pseudo-classes, elements) for a simple selector. */
  const rank = (/** @type {string} */ sel) => ({
    b: (sel.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length,
    c: (sel.match(/(^|[\s>+~])[a-z][\w-]*/g) || []).length,
  });
  const I18N = { b: 2, c: 1 };

  // Elements in this section that carry data-lang and are hidden with `visibility`.
  const targets = ['rs__btn-label', 'rs__revert', 'rs__error'];
  let checked = 0;
  for (const [, selector, body] of HOME_CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/visibility:\s*(hidden|visible)/.test(body)) continue;
    if (!targets.some((t) => selector.includes(t))) continue;
    for (const part of selector.split(',')) {
      const sel = part.trim();
      if (!targets.some((t) => sel.includes(t))) continue;
      const r = rank(sel);
      assert.ok(r.b > I18N.b || (r.b === I18N.b && r.c > I18N.c),
        `"${sel}" has specificity (0,${r.b},${r.c}) and loses to the i18n rule (0,2,1)`);
      checked++;
    }
  }
  assert.ok(checked >= 4, `expected the label and revert visibility rules, saw ${checked}`);
});

test('"See original" appears only while something is staged', () => {
  const revert = HOME_CSS.match(/\.rs__revert\s*\{[^}]*\}/);
  assert.ok(revert, 'home.css must style the revert control');
  assert.match(revert[0], /font-style:\s*italic/, 'it is italic small text under the button');
  assert.match(revert[0], /opacity:\s*0/, 'hidden until a card is showing');
  assert.match(HOME_CSS, /\.rs\.has-staged[^{]*\.rs__revert\s*\{[^}]*opacity:\s*1/,
    'and revealed by the same class the card sets');
  const source = read('public', 'scripts', 'home-restage.js');
  assert.ok(source.includes("root.classList.remove('has-staged')"),
    'reverting must drop has-staged so the control fades back out');
});

test('the copy on the right carries no em-dash', () => {
  const english = JSON.parse(read('public', 'languages', 'english.json'));
  for (const key of ['panelBody', 'panelTitle', 'kicker', 'subtitle', 'title']) {
    assert.doesNotMatch(english.home.restage[key], /—/, `home.restage.${key} still has an em-dash`);
  }
  const aside = INDEX.match(/<aside class="rs__side[\s\S]*?<\/aside>/);
  assert.doesNotMatch(aside[0].replace(/<!--[\s\S]*?-->/g, ''), /—/,
    'the rendered panel markup still contains an em-dash');
});

test('the arriving card is opaque on arrival, with no entrance fade', () => {
  // The departing card is what reveals the new one, so the new one must already be
  // solid when it lands. An entrance fade here is invisible in isolation but wrong in
  // motion: the card being thrown slides away and uncovers a still-transparent
  // replacement, so the empty room shows through it for a few frames and the new photo
  // reads as recessed, then snapping forward. It shipped that way and was spotted by eye.
  assert.ok(!/\.rs__card\.is-entering/.test(HOME_CSS),
    'no entrance-state rule may exist on .rs__card');
  const source = stripJs(read('public', 'scripts', 'home-restage.js'));
  assert.ok(!source.includes('is-entering'),
    'the module must not add an entrance class to the arriving card');
  // And it must insert the element preload() already decoded, not a fresh <img> on the
  // same URL — a new element may defer its decode past the frame it is inserted in,
  // which is a blank card while the departing one is already moving.
  assert.match(source, /image = await preload\(/,
    'stage() must take the decoded element back from preload()');
  assert.ok(!/image\.src\s*=\s*RESTAGE_DIR/.test(source),
    'building a second <img> on the same URL reintroduces the decode gap');
  // But the wait must never depend on decode(): in a background tab that promise never
  // settles, so awaiting it leaves the button disabled and the section dead until the
  // tab is focused. Resolving on `load` is the whole contract.
  assert.ok(!/await\s+\w*\.?decode\(\)|\.decode\(\)\.then/.test(source),
    'preload() must resolve on load, never on decode() — it hangs in a background tab');
});

test('the two extra bullets are desktop-only', () => {
  const aside = INDEX.match(/<aside class="rs__side[\s\S]*?<\/aside>/)[0];
  const items = [...aside.matchAll(/<li([^>]*)>/g)].map((m) => m[1]);
  assert.equal(items.length, 5, 'the wide layout shows five bullets');
  const wide = items.filter((attrs) => attrs.includes('rs__li--wide'));
  assert.equal(wide.length, 2, 'exactly two of them are the desktop-only extras');
  // Hidden with display, not visibility/opacity: a phone should not have them read out
  // either, and `visibility` would lose to the i18n anti-FOUC rule anyway.
  //
  // Dropped at 1100px, NOT at the 900px where the section stacks, and the gap between
  // those two numbers is load-bearing. The panel is stretched to the frame, and the frame
  // is ratio-locked, so its height FALLS as the window narrows while the copy's height
  // rises. Cutting these two bullets only at 900px left the panel taller than the photo
  // across the whole 900-1100px band. Raising the cut is what keeps the columns level
  // down to ~1000px.
  const cut = HOME_CSS.match(/@media \(max-width:\s*(\d+)px\)\s*\{\s*\.rs__li--wide\s*\{[^}]*display:\s*none/);
  assert.ok(cut, 'the two extras must be dropped by a media query of their own');
  assert.ok(Number(cut[1]) >= 1100,
    `the extras are cut at ${cut[1]}px; below ~1100 the copy outgrows the frame and the ` +
    'panel stops matching the photo height');
  // The three that survive are the ones carrying the core claims.
  for (const key of ['speed', 'restage', 'rights']) {
    const li = items.find((a) => a.includes(`home.studio.points.${key}`));
    assert.ok(li !== undefined, `the ${key} bullet must be present`);
    assert.ok(!li.includes('rs__li--wide'), `the ${key} bullet must survive on mobile`);
  }
});

test('the aside carries the informative bullets', () => {
  const aside = INDEX.match(/<aside class="rs__side[\s\S]*?<\/aside>/);
  assert.ok(aside, 'the copy panel must exist');
  assert.ok(aside[0].includes('home-list'), 'the bullets are a .home-list');
  for (const key of ['speed', 'restage', 'rights']) {
    assert.ok(aside[0].includes(`home.studio.points.${key}`), `missing the ${key} bullet`);
  }
  for (const key of ['rooms', 'browser']) {
    assert.ok(aside[0].includes(`home.restage.points.${key}`), `missing the ${key} bullet`);
  }
  assert.ok(aside[0].includes('data-restage-btn'), 'the button lives in the panel');
});

/* ------------------------------------- 6. the press animation, and the lack of a gate */

test('pressing the button is never gated on the fetch it starts', () => {
  // The section is meant to be mashed — every press is another render seen — so the
  // control must stay live while renders are in the air. Both halves of the old gate are
  // guarded, because either one alone reintroduces the cooldown: `busy` dropped the
  // press outright, and `disabled` made the button refuse the click before JS saw it.
  const source = stripJs(read('public', 'scripts', 'home-restage.js'));
  const disables = [...source.matchAll(/button\.disabled\s*=\s*(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(disables, ['false'],
    'the button may only ever be ENABLED by the module (once, at mount); re-adding a ' +
    '`button.disabled = true` on press is the cooldown coming back');
  assert.ok(!/\bbusy\b/.test(source),
    'the `busy` flag dropped presses that arrived mid-fetch — presses must now overlap');
  // Overlapping presses mean the loading sheen has to be refcounted. A boolean cleared
  // it on the FIRST arrival while later fetches were still running.
  assert.match(source, /inflight\s*=\s*Math\.max\(0,\s*inflight\s*-\s*1\)/,
    'is-working must be released by a counter, not by the first render to land');
  assert.ok(!/if\s*\(\s*inflight\s*\)\s*return/.test(source),
    'nothing may bail out early just because another fetch is running');
});

test('an in-flight render is abandoned if the visitor reverts first', () => {
  // Without this, "See original" is undone a moment later by a fetch that was already on
  // its way — the empty room appears, then silently re-stages itself.
  const source = stripJs(read('public', 'scripts', 'home-restage.js'));
  assert.match(source, /const mine = epoch;/, 'each press must capture the epoch it started under');
  assert.match(source, /epoch \+= 1;/, 'revert must bump it');
  assert.match(source, /if \(mine !== epoch\)/, 'and a stale render must not be inserted');
  assert.ok(!/if \(busy \|\| !current\) return/.test(source),
    'revert is no longer refused while a fetch is running');
});

test('the press animation restarts rather than being retriggered', () => {
  // Adding a class that is already present is not a style change, so without the
  // remove/reflow/add the second press inside the 580ms bounce animates nothing at all —
  // which, with no cooldown, is the common case rather than an edge one.
  const source = stripJs(read('public', 'scripts', 'home-restage.js'));
  const play = source.match(/function playPress\(\)\s*\{[\s\S]*?\n {2}\}/);
  assert.ok(play, 'the module must own a press-animation trigger');
  assert.match(play[0], /classList\.remove\('is-boing'[^)]*\)[\s\S]*void button\.offsetWidth[\s\S]*classList\.add\('is-boing'[^)]*\)/,
    'remove, force a reflow, then re-add — in that order');
  // And it has to fire before anything that can await, or the feedback lands after the
  // network rather than under the finger. It now lives at the CALL SITE rather than
  // inside stage(), so the assertion is that the handler animates first and stages second.
  const handler = source.match(/button\.addEventListener\('click', \(\) => \{[\s\S]*?\n {2}\}\);/);
  assert.ok(handler, "the button's click handler must be the thing that bounces the pill");
  assert.ok(handler[0].indexOf('playPress()') < handler[0].indexOf('stage()'),
    'the animation must play before stage(), which can await');
});

test('clicking the photo does not bounce the button', () => {
  // Each trigger animates only the thing the visitor touched. Bouncing the pill when the
  // PHOTO was clicked threw the eye to the far side of the section at the exact moment
  // the room it controls was changing.
  const source = stripJs(read('public', 'scripts', 'home-restage.js'));

  // stage() itself must stay feedback-free, or every entry point inherits the bounce
  // again and this regresses silently.
  const stage = source.match(/async function stage\(\)\s*\{[\s\S]*?\n {2}\}/);
  assert.ok(stage, 'stage() must exist');
  assert.ok(!stage[0].includes('playPress()'),
    'stage() must not bounce the pill — the photo calls it too');

  // The photo's handler taps the frame and nothing else.
  const tap = source.match(/tapTarget\.addEventListener\('click', \(\) => \{[\s\S]*?\n {4}\}\);/);
  assert.ok(tap, "the photo's click handler must exist");
  assert.match(tap[0], /playTap\(\);/, 'the room acknowledges its own tap');
  assert.ok(!tap[0].includes('playPress()'),
    'the button must stay still when the photo is what was clicked');

  // And the button still bounces on its own press — the point is to split them, not to
  // remove the animation that this whole section started with.
  const handler = source.match(/button\.addEventListener\('click', \(\) => \{[\s\S]*?\n {2}\}\);/);
  assert.ok(handler && handler[0].includes('playPress()'),
    'the button must still bounce when the BUTTON is pressed');
  assert.ok(!handler[0].includes('playTap()'),
    'and it must not dim the photo, which is the frame\'s own feedback');
});

test('a press mid-wave re-fires the letters from where they are, not from the baseline', () => {
  // The SOFT restart. Both extremes were tried and both are wrong: re-arming the wave
  // flat teleports 25 glyphs back to the baseline mid-hop (a stutter, worse the faster
  // you press), and refusing to re-arm it at all makes the text feel dead under a fast
  // press. `--from` carries the glyph's current height into the next wave's 0%, so the
  // letter changes direction instead of jumping.
  const source = stripJs(read('public', 'scripts', 'home-restage.js'));
  const play = source.match(/function playPress\(\)\s*\{[\s\S]*?\n {2}\}/)[0];
  // No press may be swallowed — both classes re-fire, unconditionally.
  assert.match(play, /button\.classList\.remove\('is-boing', 'is-hopping'\)/);
  assert.match(play, /button\.classList\.add\('is-boing', 'is-hopping'\)/);
  assert.ok(!/if\s*\([^)]*\)\s*button\.classList\.(add|remove)\('is-hopping'\)/.test(play),
    'the wave must not be conditionally skipped — that is the "feels dead" behaviour');

  // Sample, then remove, then reflow, then add. Every step of that order is load-bearing.
  const at = (/** @type {string} */ needle) => play.indexOf(needle);
  assert.ok(at('captureHopOffsets()') !== -1, 'the offsets must be captured on each press');
  assert.ok(at('captureHopOffsets()') < at("classList.remove('is-boing', 'is-hopping')"),
    'sampling AFTER the class comes off reads 0 for every glyph — the animation is ' +
    'cancelled and, having no fill, the glyph reverts in the same breath');
  assert.ok(at("classList.remove('is-boing', 'is-hopping')") < at('void button.offsetWidth'),
    'the reflow must sit between the remove and the add');
  assert.ok(at('void button.offsetWidth') < at("classList.add('is-boing', 'is-hopping')"),
    're-adding a class that never left is not a style change, so nothing would replay');

  const capture = source.match(/function captureHopOffsets\(\)\s*\{[\s\S]*?\n {2}\}/);
  assert.ok(capture, 'the module must sample the glyph heights');
  assert.match(capture[0], /getComputedStyle\(glyph\)/,
    'the rendered matrix is the source of truth — it already accounts for the easing ' +
    'and the per-glyph stagger, so there is no second copy of the curve to keep in step');
  assert.match(capture[0], /new DOMMatrixReadOnly\(transform\)\.m42/,
    'm42 is the translateY component');
  assert.match(capture[0], /setProperty\('--from'/, 'and it must be written as --from');
  assert.match(capture[0], /typeof DOMMatrixReadOnly === 'function'/,
    'DOMMatrixReadOnly must be feature-checked, not assumed');
  assert.match(capture[0], /catch \{\s*offset = 0;/,
    'an unparseable transform must fall back to the baseline, not throw out of a click');

  // The keyframe that consumes it, and the fallback that keeps a first press valid.
  const frames = HOME_CSS.match(/@keyframes rsBtnHop\s*\{[\s\S]*?\n\}/);
  assert.ok(frames, 'the hop keyframes must exist');
  assert.match(frames[0], /0%\s*\{\s*transform:\s*translateY\(var\(--from,\s*0px\)\)/,
    'the wave must start at the captured height, with a fallback — a bare var(--from) ' +
    'makes the whole transform invalid when unset and the 0% keyframe silently drops out');
  assert.match(frames[0], /100%\s*\{\s*transform:\s*none/, 'and still end at rest');

  // `--from` alone is NOT enough, and this is the part that looks redundant and is not.
  // A glyph applies no animated value during its animation-delay, so without `backwards`
  // it renders at the BASELINE until its delay elapses and only then jumps to --from.
  // Measured with the fill mode omitted: 9 of 13 glyphs teleported, by up to 5.4px — and
  // it is invisible on a first press, because --from is 0 there.
  const rule = HOME_CSS.match(/\.rs__btn\.is-hopping \.rs__btn-char\s*\{[^}]*\}/)[0];
  assert.match(rule, /animation-fill-mode:\s*backwards/,
    'the 0% keyframe must extend back over the delay, or --from does nothing for any ' +
    'glyph that has not started yet — which is most of them');

  // A glyph already in the air joins the new wave with no stagger; one at rest keeps its
  // place in the queue. Holding an airborne glyph to its delay is continuous but leaves a
  // letter hanging motionless for up to 242ms, which reads as stuck rather than springy.
  assert.match(capture[0], /const airborne = Math\.abs\(offset\) > 0\.01;/,
    'a hair off the baseline counts as at rest — exact zero never arrives');
  assert.match(capture[0], /setProperty\('--i', airborne \? '0' : \(glyph\.dataset\.hopIndex \|\| '0'\)\)/,
    'airborne glyphs skip the stagger; resting ones must be RESTORED to their own index, ' +
    'or the wave flattens permanently after the first interrupt');
  assert.match(source, /span\.dataset\.hopIndex = String\(Math\.min\(index, HOP_STAGGER_CAP\)\)/,
    'which is only possible because the base index is kept on the element');

  // And a re-split must not leave fresh spans parented under a live wave class, or the
  // new label twitches on its own with nobody pressing anything.
  const split = source.match(/const splitLabels = \(\) => \{[\s\S]*?\n {2}\};/);
  assert.ok(split, 'the re-split helper must exist');
  assert.ok(split[0].indexOf("remove('is-hopping')") < split[0].indexOf('labels.forEach'),
    'is-hopping must come off before the new spans go in');
});

test('the squash beats the hover lift and the release bounces back', () => {
  const active = HOME_CSS.match(/\.rs__btn:active\s*\{[^}]*\}/);
  assert.ok(active, 'home.css must give the button a pressed state');
  assert.match(active[0], /scaleY\(0?\.\d+\)/, 'the press squashes the pill vertically');
  assert.match(active[0], /scaleX\(1\.\d+\)/, 'and spreads it horizontally — that is the squash');
  // Identical specificity to `.rs__btn:hover`, so ONLY source order decides. Hoisting the
  // active rule above the hover rule silently restores the do-nothing press.
  const hoverAt = HOME_CSS.indexOf('.rs__btn:hover');
  const activeAt = HOME_CSS.indexOf('.rs__btn:active');
  assert.ok(hoverAt !== -1 && activeAt > hoverAt,
    '.rs__btn:active must come after .rs__btn:hover — both are (0,2,0), so order is all there is');
  // The release starts from the pressed pose, not from rest: `:active` stops applying the
  // instant the pointer lifts, so a keyframe list beginning at `transform: none` snaps
  // the button to full size for a frame before the bounce.
  const boing = HOME_CSS.match(/@keyframes rsBtnBoing\s*\{[\s\S]*?\n\}/);
  assert.ok(boing, 'the release animation must exist');
  assert.match(boing[0], /0%\s*\{\s*transform:\s*scaleX\(1\.06\) scaleY\(0\.86\) translateY\(2px\)/,
    'the bounce must begin at the pressed pose so the handoff from :active is seamless');
  assert.match(boing[0], /100%\s*\{\s*transform:\s*none/, 'and end at rest');
});

test('the per-glyph hop survives a language switch and cannot run away with a long label', () => {
  const source = stripJs(read('public', 'scripts', 'home-restage.js'));
  // language-loader.js assigns textContent to every [data-lang] node on each pass, which
  // flattens the spans. It fires `languagechange` at the end of that pass; re-splitting
  // there is the only thing keeping the stagger alive after a switch.
  assert.match(source, /addEventListener\('languagechange', splitLabels\)/,
    'the labels must be re-split after every language apply pass');
  assert.match(source, /Math\.min\(index, HOP_STAGGER_CAP\)/,
    'the stagger index must be clamped, or a long label still hops after the pill has settled');
  // The spans must stay free of data-lang, or the loader's MutationObserver treats the
  // module's own output as new work and re-applies forever.
  const split = source.match(/function splitLabel\([\s\S]*?\n\}/);
  assert.ok(split, 'splitLabel() must exist');
  assert.ok(!/data-lang/.test(split[0]),
    'a data-lang on the generated spans would make the i18n observer feed itself');
  // Spaces stay bare text nodes so the accessible name keeps real word boundaries.
  assert.match(split[0], /createTextNode\(' '\)/,
    'spaces must not be wrapped — the accessible name has to keep its word boundaries');

  const hop = HOME_CSS.match(/\.rs__btn\.is-hopping \.rs__btn-char\s*\{[^}]*\}/);
  assert.ok(hop, 'home.css must animate the generated glyph spans off their own class');
  assert.ok(!/\.rs__btn\.is-boing \.rs__btn-char/.test(HOME_CSS),
    'the glyph hop must NOT hang off the pill class — that is what let a press reset it');
  assert.match(hop[0], /var\(--i,\s*0\)/,
    'a bare var(--i) makes the whole animation-delay invalid when unset, silently ' +
    'firing every glyph at once');
  assert.match(HOME_CSS, /\.rs__btn-char\s*\{[^}]*display:\s*inline-block/,
    'inline boxes ignore transforms, so the hop needs inline-block');
});

test('reduced motion keeps the press readable and drops only the decoration', () => {
  // home.css has more than one reduced-motion block, so anchor on the one that owns this
  // section rather than on the first `@media` in the file — indexOf() found the `.reveal`
  // block and the guard passed against a stylesheet that had never been edited.
  const blocks = [...HOME_CSS.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/g)]
    .map((m) => m[0]);
  const block = blocks.find((b) => b.includes('.rs__btn'));
  assert.ok(block, 'no reduced-motion block covers the restage button');
  // The dip stays — that is the answer to "did my press register?". The rubber goes.
  assert.match(block, /\.rs__btn:active\s*\{[^}]*translateY\(2px\)/,
    'a press must still visibly register under reduced motion');
  assert.doesNotMatch(block.match(/\.rs__btn:active\s*\{[^}]*\}/)[0], /scale/,
    'but without the squash');
  assert.match(block, /\.rs__btn\.is-boing,\s*\.rs__btn\.is-hopping \.rs__btn-char\s*\{[^}]*animation:\s*none/,
    'the bounce and the glyph hop must both be switched off');
});

/* --------------------------------- 7. the photo is a trigger, and failures are visible */

test('the photo stages too, without becoming a second tab stop', () => {
  // The heading promises "Click to see what staging does", and below 900px the section
  // stacks and puts the button ~290px under the room — too far to watch the change while
  // pressing on a smaller phone.
  const stack = INDEX.match(/<div class="rs__stack[^>]*>/);
  assert.ok(stack, 'the frame must exist');
  assert.match(stack[0], /data-restage-tap/, 'the frame must carry the tap hook');
  // NOT a second accessible control. `button` already exposes this exact action to
  // keyboard and screen-reader users; a role+tabindex here would add a redundant tab stop
  // announcing the same thing twice. This is the assertion that stops a well-meaning
  // "a11y fix" from doing that.
  assert.ok(!/role=/.test(stack[0]), 'the frame must not be announced as a control');
  assert.ok(!/tabindex=/.test(stack[0]), 'and must not be focusable');

  const source = stripJs(read('public', 'scripts', 'home-restage.js'));
  assert.match(source, /tapTarget\.addEventListener\('click'/, 'the tap must be wired');
  // A drag inside the frame is a selection, not a press.
  assert.match(source, /if \(selection && !selection\.isCollapsed/,
    'a text/image selection must not be treated as a press');

  // The affordance is gated on the same class as the button, so a photo that cannot yet
  // stage does not advertise that it can.
  assert.match(HOME_CSS, /\.rs--ready \.rs__stack\s*\{[^}]*cursor:\s*pointer/,
    'the pointer cursor must wait for .rs--ready, like the button does');
});

test('nothing in this section sets `transition` on an element that carries .reveal', () => {
  // THIS SHIPPED AND BROKE THE SECTION'S ENTRANCE. `.reveal` (styles in this file) sets
  //     transition: opacity .6s, transform .6s
  // at specificity (0,1,0). `.rs__stack` is ALSO (0,1,0) and lives later in the file, so
  // a `transition` declared there does not merge — it replaces the reveal's outright, and
  // the frame stops animating in on scroll and teleports into place. The symptom appears
  // nowhere near the rule that causes it, and the rule looked entirely innocuous.
  //
  // index.html decides which elements carry .reveal; these are the ones in #restage.
  const revealed = ['rs__stack', 'rs__side'];
  for (const cls of revealed) {
    const section = INDEX.match(new RegExp(`class="${cls}[^"]*"`));
    assert.ok(section && /\breveal\b/.test(section[0]),
      `${cls} is expected to carry .reveal — update this guard if that changed`);
    // A bare element rule is the dangerous one; `::before`/`::after` own their own
    // transitions and are fine, as is any rule that also names a state class.
    const bare = HOME_CSS.match(new RegExp(`(^|\\})\\s*\\.${cls}\\s*\\{[^}]*\\}`, 'g')) || [];
    for (const block of bare) {
      assert.ok(!/(^|[;{\s])transition\s*:/.test(block),
        `a bare .${cls} rule declares \`transition\`, which replaces .reveal's and kills ` +
        'the entrance animation. Put the transition on a pseudo-element instead.');
    }
  }
});

test('the photo press feedback avoids every transform already in play', () => {
  // Three things own a transform here and a press scale would fight all of them:
  // .rs__stack carries .reveal (its entrance animation drives the transform), .rs__card
  // uses transform for the throw, and .rs__card.is-leaving replaces the transition
  // wholesale. A pseudo-element collides with none of them.
  const tapped = HOME_CSS.match(/\.rs__stack\.is-tapped::before\s*\{[^}]*\}/);
  assert.ok(tapped, 'the frame must acknowledge a tap, via its own pseudo-element');
  assert.ok(!/transform/.test(tapped[0]),
    'a transform here fights .reveal, which owns .rs__stack\'s transform');
  const base = HOME_CSS.match(/\.rs__stack::before\s*\{[^}]*\}/);
  assert.ok(base, 'the tap overlay must exist');
  assert.match(base[0], /pointer-events:\s*none/, 'it sits over the photo, which is clickable');
  assert.match(base[0], /transition:\s*opacity/, 'and owns its own transition');
  assert.ok(!/\.rs__stack\.is-tapped\s+\.rs__(card|empty)/.test(HOME_CSS),
    'nor may it transform the layers inside — .rs__card\'s transform is the throw');

  const source = stripJs(read('public', 'scripts', 'home-restage.js'));
  // Cleared on a timer, not on transitionend: a repeat tap can leave the shadow already
  // at its pressed value, and a transition with nothing to animate fires no event at all,
  // which would strand the frame looking pressed.
  assert.match(source, /setTimeout\(\(\) => stack\.classList\.remove\('is-tapped'\)/,
    'the tap class must clear on a timer');
  assert.ok(!/transitionend[\s\S]{0,120}is-tapped/.test(source),
    'transitionend does not fire when the value is unchanged — it would stick');
});

test('a failed render says so, and the message clears on the next success', () => {
  const err = INDEX.match(/<p class="rs__error"[^>]*>/);
  assert.ok(err, 'the panel must carry a failure line');
  assert.match(err[0], /data-lang="home\.restage\.loadFailed"/, 'localized like everything else');
  assert.match(err[0], /data-restage-error/, 'with a hook the module can find');

  const source = stripJs(read('public', 'scripts', 'home-restage.js'));
  assert.match(source, /if \(!inflight\) root\.classList\.add\('has-error'\)/,
    'raised only once the LAST outstanding fetch has failed — with presses overlapping ' +
    'by design, one 404 among four in-flight requests is not worth reporting');
  assert.match(source, /root\.classList\.remove\('has-error'\)/, 'and cleared on a success');
  // Cleared on the landing, NOT at the top of stage(): clearing on press blanks the line
  // the instant the visitor acts on it, and a retry that also failed would flicker it.
  const stage = source.match(/async function stage\(\)\s*\{[\s\S]*?\n {2}\}/)[0];
  assert.ok(stage.indexOf("remove('has-error')") > stage.indexOf('await preload('),
    'the message must survive the press that is retrying it');

  // ZERO-HEIGHT, and it has to satisfy both halves of a squeeze:
  //  - it must not RESERVE space. The panel is stretched to a ratio-locked frame, so
  //    every px the copy takes is a px that has to come from somewhere; an earlier
  //    version held a ~26px box open and that alone made the panel taller than the photo
  //    at every width under ~1140px.
  //  - it must not ADD space when shown either. .rs__side is a centred flex column, so a
  //    plain display:none toggle re-centres the panel and every control above it jumps
  //    ~13px up at the moment the visitor is reaching for the button again.
  const rule = HOME_CSS.match(/\.rs__error\s*\{[^}]*\}/);
  assert.ok(rule, 'home.css must style the failure line');
  assert.match(rule[0], /height:\s*0/, 'the line must contribute no height in either state');
  assert.match(rule[0], /margin:\s*0/, 'and no margin, which would count against the frame too');
  assert.match(rule[0], /transform:\s*translateY/,
    'the gap under the revert control must come from transform, which costs no layout');
  const errRules = HOME_CSS.match(/\.rs[^{]*\.rs__error\s*\{[^}]*\}/g) || [];
  assert.ok(!/display:\s*none/.test(errRules.join('')),
    'display:none would re-centre the whole panel when the line appears');
});

test('both controls carry a focus ring, and the pill does not use brand-on-brand', () => {
  const btn = HOME_CSS.match(/\.rs__btn:focus-visible\s*\{[^}]*\}/);
  const rev = HOME_CSS.match(/\.rs__revert:focus-visible\s*\{[^}]*\}/);
  assert.ok(btn, '.rs__btn must have a focus ring — it was the only control here without one');
  assert.ok(rev, '.rs__revert must have one too');
  // The pill's own background is a --brand gradient; a --brand ring on it is very nearly
  // invisible, which is a focus indicator that technically exists and practically doesn't.
  assert.match(btn[0], /outline:\s*3px solid var\(--brand-deep\)/,
    'the pill needs the darker token to read against its own gradient');
  assert.ok(!/var\(--brand\)/.test(btn[0]), 'brand-on-brand is not a visible ring');
  assert.match(rev[0], /outline:\s*3px solid var\(--brand\)/, 'the revert sits on the pale panel');
});

test('"See original" is a real tap target at every width', () => {
  // Measured at 15x70 before this: it failed WCAG 2.5.8's 24x24 on its own and passed
  // only via the spacing exception, while being the ONLY way back to the original photo.
  const rule = HOME_CSS.match(/\.rs__revert\s*\{[^}]*display:\s*inline-block[^}]*\}/);
  assert.ok(rule, 'the control must be padded up to a usable size');
  // Vertical padding on an inline box paints but does not grow the hit target.
  assert.match(rule[0], /display:\s*inline-block/, 'inline-block is what makes the padding count');
  const pad = rule[0].match(/padding:\s*(\d+)px/);
  assert.ok(pad, 'it must declare vertical padding');
  // 12.5px text at line-height ~1.2 is ~15px; 2x5px of padding clears 24px.
  assert.ok(15 + Number(pad[1]) * 2 >= 24,
    `12.5px text plus ${pad[1]}px x2 of padding is ${15 + Number(pad[1]) * 2}px, under the 24px minimum`);

  const open = HOME_CSS.indexOf('@media (max-width: 900px)');
  const block = HOME_CSS.slice(open, HOME_CSS.indexOf('\n}', open));
  assert.match(block, /\.rs__revert\s*\{[^}]*align-self:\s*stretch/,
    'on mobile it must match the full-width button above it rather than staying pinned left');
});

test('the empty room is decode-warmed with the other lazy below-fold photos', () => {
  // A stale selector in warmImages() does not throw, it silently stops warming — which is
  // why every entry in that list is pinned by the section that owns it.
  const reveal = read('public', 'scripts', 'home-reveal.js');
  // Anchored on a known member of the list, not on the first querySelectorAll in the
  // file — that one is `.reveal`, and matching it made this guard pass against a
  // home-reveal.js that warmed nothing at all.
  const list = reveal.match(/querySelectorAll\(\s*"([^"]*\.hstrip__img[^"]*)"/);
  assert.ok(list, 'warmImages() must still select its images by class list');
  assert.ok(list[1].split(',').map((s) => s.trim()).includes('.rs__empty'),
    'home-reveal.js must warm .rs__empty — it is the one photo this section ships');
  // The 100-render pool must NOT creep in here. Warming it is 4.8MB for a section most
  // visitors scroll past, and it is the explicit trade this module documents.
  assert.ok(!/rs__card/.test(list[1]), 'the render pool is deliberately never prefetched');
});

/* ------------------------------------------------- 5. what the change retired */

test('the old before/after section is fully gone from markup and CSS', () => {
  for (const dead of ['studio-shell', 'studio-side', 'studio-examples', 'studio-ex']) {
    assert.ok(!INDEX.includes(`class="${dead}`), `index.html still renders .${dead}`);
    assert.ok(!HOME_CSS.includes(`.${dead} {`), `home.css still styles .${dead}`);
  }
  assert.ok(!STUDIO_JS.includes('function mountExamples'),
    'mountExamples went with the room toggle it drove');
});

test('the exterior wipe still has its mount, its markup and its CSS', () => {
  // All three now have exactly one consumer, so each looks deletable in isolation.
  assert.ok(STUDIO_JS.includes('function mountWipe'), 'mountWipe still drives the showcase panel');
  assert.ok(STUDIO_JS.includes('exterior-studio-demo'), 'and is still mounted against it');
  assert.ok(INDEX.includes('id="exterior-studio-demo"'), 'the showcase panel must still exist');
  for (const rule of ['.ba-handle', '.ba-before', '.ba-after', '.ba-tag']) {
    assert.ok(HOME_CSS.includes(rule), `home.css lost ${rule}, which the exterior panel needs`);
  }
});
