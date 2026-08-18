// The homepage hero picker's keyboard and screen-reader contract.
//
// WHY A SOURCE-LEVEL GUARD, and why this file exists at all.
//
// The picker is two listboxes embedded in an <h1>, a photo that swaps under them, and a
// toggle laid over the photo. None of that had a single assertion about ARIA, focus or keys
// — e2e/index.spec.js drives it with .click() only, and test/frontend/untested-frontend-
// modules.test.js exempts hero-picker.js from unit coverage on the grounds that the swap is
// covered there. Both are true and neither looks at accessibility, so every fault below was
// invisible to the build:
//
//   • `.hp-menu__item:focus-visible` shared a block with :hover, which meant `outline: none`
//     plus a 1.06:1 background as the only focus signal — and `[aria-selected="true"]` had
//     the SAME specificity (0,2,0) and came later, so on the selected row it won outright.
//     The selected row is the one openMenu() focuses, so opening either menu by keyboard
//     showed no focus indicator anywhere. A CSS specificity clash, silent by construction.
//   • The renders hidden by `opacity: 0` stayed in the accessibility tree, so a screen reader
//     found every pair the visitor had viewed stacked in one box.
//   • The "See original" toggle flipped aria-pressed AND swapped its label, which announces
//     the inverse of the true state.
//
// These assertions are structural — whether a screen reader really announces the swap is an
// e2e concern. What fails the DEPLOY is the attribute or the branch going missing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const INDEX = read('public/index.html');
const JS = read('public/scripts/hero-picker.js');
const CSS = read('public/styles/hero-picker.css');

/** Source with comments stripped, so prose describing a rule never satisfies a check for it. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const JS_CODE = code(JS);
const CSS_CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** One element's opening tag, by id. */
function tag(id) {
  const m = INDEX.match(new RegExp(`<[a-zA-Z][\\w-]*\\b[^>]*\\bid="${id}"[^>]*>`));
  assert.ok(m, `public/index.html no longer ships #${id}`);
  return m[0];
}

test('both listboxes are named and are real listboxes', () => {
  for (const id of ['hero-room-list', 'hero-style-list']) {
    const t = tag(id);
    assert.match(t, /role="listbox"/, `#${id} lost role="listbox"`);
    // An unnamed listbox announces as "list box" and nothing else, which is useless when
    // there are two of them in one sentence.
    assert.match(
      t, /data-lang-attr="hero\.(room|style)MenuLabel\|aria-label"/,
      `#${id} lost its localised aria-label — an unnamed listbox tells the user nothing`,
    );
  }
});

test('both triggers advertise the popup they own', () => {
  for (const id of ['hero-room-btn', 'hero-style-btn']) {
    const t = tag(id);
    assert.match(t, /aria-haspopup="listbox"/, `#${id} lost aria-haspopup`);
    assert.match(t, /aria-expanded="false"/, `#${id} must ship collapsed`);
    assert.match(t, /aria-controls="hero-(room|style)-menu"/, `#${id} lost aria-controls`);
    assert.match(t, /type="button"/, `#${id} must not be a submit button`);
  }
});

test('the keyboard contract covers a two-column listbox, not just up and down', () => {
  // Home/End matter more since the style menu reached 8 rows: "Custom" is seven Downs away.
  // Left/Right matter because the menu is laid out in two visible columns — a sighted
  // keyboard user WILL press them, and doing nothing is a dead end with no feedback.
  for (const key of ['Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft']) {
    assert.match(
      JS_CODE, new RegExp(`'${key}'`),
      `hero-picker.js no longer handles ${key} in the menu keydown handler`,
    );
  }
  // Left/Right step by one visual column, which is what applyColumns() wrote.
  assert.match(
    JS_CODE, /--hp-menu-rows/,
    'the arrow handler must read --hp-menu-rows, or Left/Right cannot know the column height',
  );
});

test('focus is an outline that a background rule cannot cancel', () => {
  const focusRule = CSS_CODE.match(/\.hp-menu__item:focus-visible\s*\{([^}]*)\}/);
  assert.ok(focusRule, 'hero-picker.css lost its .hp-menu__item:focus-visible rule');
  assert.match(
    focusRule[1], /outline:\s*\d/,
    'focus must be drawn with an outline. A background swap is colour-only, and it loses to '
      + '[aria-selected="true"] at the same specificity — which is the row that has focus '
      + 'the moment the menu opens.',
  );
  assert.ok(
    !/outline:\s*none/.test(focusRule[1]),
    '.hp-menu__item:focus-visible must not clear the outline',
  );
  // The selected row is dark, so the ring needs its own colour there or it vanishes into it.
  assert.match(
    CSS_CODE, /\.hp-menu__item\[aria-selected="true"\]:focus-visible\s*\{[^}]*outline-color/,
    'the selected row needs its own outline-color, or the ring disappears against --brand-deep',
  );
});

test('only the render on screen is exposed to assistive tech', () => {
  // opacity: 0 hides a thing from the eye and from nobody else. Without this, every pair the
  // visitor has looked at is still an <img> with real alt text in the same box.
  assert.match(
    JS_CODE, /setAttribute\('aria-hidden', 'true'\)/,
    'hero-picker.js no longer hides the off-screen renders from the accessibility tree',
  );
  assert.match(JS_CODE, /removeAttribute\('aria-hidden'\)/, 'the visible render must be un-hidden again');
  // Removal is not an option for the LCP node, which is why it is aria-hidden and not display:none.
  assert.ok(
    !/\.remove\(\)/.test(JS_CODE.slice(JS_CODE.indexOf('function showOnly'), JS_CODE.indexOf('function showOnly') + 400)),
    'the adopted LCP <img> must never be removed — see the file header',
  );
});

test('the picker announces what it just did', () => {
  const live = tag('hero-live');
  assert.match(live, /aria-live="polite"/, '#hero-live lost aria-live');
  assert.match(live, /class="sr-only"/, '#hero-live must be visually hidden, not visible copy');
  assert.match(
    INDEX, /<p class="sr-only" id="hero-live" role="status" aria-live="polite"><\/p>/,
    '#hero-live must ship EMPTY — a live region populated in the same breath as being created '
      + 'is routinely missed by screen readers',
  );
  assert.match(JS_CODE, /function announce\(/, 'hero-picker.js lost announce()');
});

test('the See-original toggle does not announce the opposite of its state', () => {
  const btn = tag('hero-original-btn');
  /* THE LABEL CARRIES THE ACTION, so nothing may claim a pressed state alongside it. The two
     conventions are mutually exclusive: a sighted visitor reads the label as what the button
     will do, assistive tech reads aria-pressed as what is already on. Ship both and a screen
     reader says "See staged, pressed" while the ORIGINAL is the photo on screen.
     This button used to take the other side of that trade — constant label, aria-pressed —
     and swapped in 2026-08-18 because the label reads as broken to everyone who can see it. */
  assert.ok(
    !/aria-pressed/.test(btn),
    'aria-pressed is back on a button whose label swaps. Pick one convention: either the label '
      + 'names the action and there is no pressed state, or the label is constant and '
      + 'aria-pressed carries it. Both together announce the inverse of the truth.',
  );
  assert.match(
    JS_CODE,
    /showingOriginal \? 'hero\.seeStaged' : 'hero\.seeOriginal'/,
    'the toggle must swap between both label keys',
  );
  // The state still has to be exposed somewhere the stylesheet can see it.
  assert.match(
    JS_CODE,
    /classList\.toggle\('is-showing-original', showingOriginal\)/,
    'the showing-original state must still land on the button as a class',
  );
  /* The swapped key has to travel with the text. applyTranslations() writes textContent
     straight from data-lang, so a stale attribute repaints "See original" over the button on
     the next language change while the original is still what is showing. */
  assert.match(JS_CODE, /setAttribute\('data-lang', key\)/, 'data-lang must be swapped with the label');
});

test('motion is suppressed for visitors who ask for it', () => {
  const at = CSS_CODE.indexOf('prefers-reduced-motion');
  assert.ok(at !== -1, 'hero-picker.css lost its prefers-reduced-motion block');
  /* Start AFTER the at-rule's own `{`. Leave it in and the first rule-matching pass pairs the
     media query's opening brace with the first inner rule's closing one, swallowing whichever
     rule happens to be listed first — which silently exempted it from this test. */
  const reduce = CSS_CODE.slice(CSS_CODE.indexOf('{', at) + 1);

  /* Matched against the whole SELECTOR LIST rather than a bare selector, because these are
     routinely comma-joined (`.hp-menu, .hp-menu:not([hidden])`) and a rule that is grouped
     with a sibling is still a rule. Nor does it care whether the motion is a `transition` or
     an `animation` — the menu has been authored both ways, and what matters is only that it
     is switched off rather than shortened. */
  const suppressed = (needle) => [...reduce.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .some(([, sel, body]) => sel.split(',').some((s) => s.trim().startsWith(needle))
      && /(transition|animation):\s*none/.test(body));

  for (const [selector, what] of [['.hp-canvas__img', 'the cross-fade'], ['.hp-menu', 'the menu open/close']]) {
    assert.ok(
      suppressed(selector),
      `${what} is no longer switched off under reduced motion (${selector})`,
    );
  }
});
