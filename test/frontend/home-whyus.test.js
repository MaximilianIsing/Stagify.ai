// Tier: frontend island logic (DOM-stubbed) — public/scripts/home-whyus.js.
//
// #why renders two columns of seven bullets that are actually seven MATCHED PAIRS:
// "Unlimited free generations" is the rebuttal to "Expensive: Costly, per-image fees",
// and so on down both lists. home-whyus.js lights both halves of a pair together so
// that correspondence is visible; without it the section is two unrelated lists and
// the argument never lands.
//
// Two kinds of assertion live here:
//
//   1. Behaviour, against a fake DOM (no jsdom in this repo — same approach as
//      test/frontend/app/tilt-effect.test.js). The interesting cases are the ones a
//      screenshot cannot show: that a pin actually locks out hover, and that at rest
//      the grid carries NO focus attribute, which is the progressive-enhancement
//      contract — every dim/lift rule in home.css is scoped behind [data-vs-focus],
//      so if this module never runs the section must render exactly as authored.
//
//   2. Drift guards over the real index.html, because both failures they catch are
//      invisible in review AND in a local browser check:
//
//      - An unpaired row. Add a bullet to one column and not the other and the
//        pairing quietly starts lying — a lit row with no partner.
//      - `data-lang-html` moved back onto the <li>. language-loader.js:86 assigns
//        `el.innerHTML` on every such node, so a button nested INSIDE one is
//        destroyed on the first language load. That is why the key sits on an inner
//        <span> instead. The trap is that it works perfectly in English and dies
//        only after a language switch, so nothing short of this guard catches it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');

const { initWhyUs } = await import('../../public/scripts/home-whyus.js');

/** The seven pair keys, in the order both lists use them. */
const KEYS = ['speed', 'effort', 'price', 'ads', 'signup', 'quality', 'rights'];

// ---- Minimal fake DOM ------------------------------------------------------

/** A `.whyus-row` button that records its listeners and can replay them. */
function makeBtn() {
  /** @type {Record<string, Function[]>} */
  const handlers = {};
  /** @type {Record<string, string>} */
  const attrs = { 'aria-pressed': 'false' };
  return {
    handlers,
    attrs,
    addEventListener(/** @type {string} */ type, /** @type {Function} */ fn) {
      (handlers[type] ||= []).push(fn);
    },
    setAttribute(/** @type {string} */ k, /** @type {string} */ v) { attrs[k] = String(v); },
    getAttribute(/** @type {string} */ k) { return k in attrs ? attrs[k] : null; },
    fire(/** @type {string} */ type) { for (const fn of handlers[type] || []) fn.call(this, {}); },
  };
}

/** One `<li data-vs="…">`, optionally with its button missing. */
function makeRow(/** @type {string} */ key, { withButton = true } = {}) {
  const btn = withButton ? makeBtn() : null;
  /** @type {Set<string>} */
  const classes = new Set();
  return {
    key,
    btn,
    getAttribute: (/** @type {string} */ k) => (k === 'data-vs' ? key : null),
    querySelector: (/** @type {string} */ sel) => (sel === '.whyus-row' ? btn : null),
    classList: {
      toggle(/** @type {string} */ name, /** @type {boolean} */ on) {
        if (on) classes.add(name); else classes.delete(name);
      },
    },
    get lit() { return classes.has('is-lit'); },
  };
}

/**
 * Build a grid of 14 rows — seven keys x two lists — and install it as `document`.
 * `missingButtonOn` drops the button from one row, to exercise the skip guard.
 */
function mount({ missingButtonOn = '' } = {}) {
  const rows = [];
  for (const list of ['yes', 'no']) {
    for (const key of KEYS) {
      rows.push(makeRow(key, { withButton: missingButtonOn !== `${list}:${key}` }));
    }
  }
  /** @type {Record<string, string>} */
  const gridAttrs = {};
  const grid = {
    attrs: gridAttrs,
    querySelectorAll: (/** @type {string} */ sel) => (sel === '[data-vs]' ? rows : []),
    setAttribute(/** @type {string} */ k, /** @type {string} */ v) { gridAttrs[k] = String(v); },
    removeAttribute(/** @type {string} */ k) { delete gridAttrs[k]; },
    getAttribute(/** @type {string} */ k) { return k in gridAttrs ? gridAttrs[k] : null; },
  };
  globalThis.document = /** @type {any} */ ({
    querySelector: (/** @type {string} */ sel) => (sel === '.whyus-grid' ? grid : null),
  });
  return { grid, rows };
}

/** Every row currently carrying `.is-lit`. */
const litKeys = (/** @type {any[]} */ rows) => rows.filter((r) => r.lit).map((r) => r.key);

// ---- 1. The rest state IS the no-JS state ----------------------------------

test('at rest the grid carries no focus attribute and nothing is lit', () => {
  const { grid, rows } = mount();
  initWhyUs();

  // home.css scopes every dim/lift rule behind [data-vs-focus]. If merely wiring the
  // module set it, the section would render dimmed before anyone touched it.
  assert.equal(grid.getAttribute('data-vs-focus'), null);
  assert.deepEqual(litKeys(rows), []);
});

// ---- 2. Hover lights exactly the pair --------------------------------------

test('hovering either half lights BOTH halves of that pair and nothing else', () => {
  // Driven from the Others column too, not just Stagify — the pairing has to work in
  // both directions, and a lookup keyed off the wrong list would still pass one way.
  for (const startIndex of [0, KEYS.length]) {
    const { grid, rows } = mount();
    initWhyUs();

    rows[startIndex + 2].btn.fire('pointerenter'); // the 'price' pair
    assert.equal(grid.getAttribute('data-vs-focus'), 'price');
    assert.deepEqual(litKeys(rows), ['price', 'price'], 'exactly the two halves');

    rows[startIndex + 2].btn.fire('pointerleave');
    assert.equal(grid.getAttribute('data-vs-focus'), null);
    assert.deepEqual(litKeys(rows), []);
  }
});

test('keyboard focus lights the same pair as hover', () => {
  const { grid, rows } = mount();
  initWhyUs();

  rows[0].btn.fire('focus');
  assert.equal(grid.getAttribute('data-vs-focus'), 'speed');
  assert.deepEqual(litKeys(rows), ['speed', 'speed']);

  rows[0].btn.fire('blur');
  assert.equal(grid.getAttribute('data-vs-focus'), null);
});

// ---- 3. Pinning ------------------------------------------------------------

test('clicking pins the pair, and a pin locks out hover', () => {
  const { grid, rows } = mount();
  initWhyUs();

  rows[1].btn.fire('click'); // pin 'effort'
  assert.equal(grid.getAttribute('data-vs-focus'), 'effort');
  assert.deepEqual(litKeys(rows), ['effort', 'effort']);

  // aria-pressed must be true on BOTH halves and false everywhere else — the pin is a
  // property of the pair, not of the button that happened to be clicked.
  const pressed = rows.filter((r) => r.btn.getAttribute('aria-pressed') === 'true');
  assert.deepEqual(pressed.map((r) => r.key), ['effort', 'effort']);

  // Hovering elsewhere while pinned must change nothing, or the pin is decorative.
  rows[4].btn.fire('pointerenter');
  assert.equal(grid.getAttribute('data-vs-focus'), 'effort');
  assert.deepEqual(litKeys(rows), ['effort', 'effort']);

  // ...and neither must the pointerleave that follows it.
  rows[4].btn.fire('pointerleave');
  assert.equal(grid.getAttribute('data-vs-focus'), 'effort');
});

test('clicking the pinned pair again releases it', () => {
  const { grid, rows } = mount();
  initWhyUs();

  rows[1].btn.fire('click');
  rows[1].btn.fire('click');
  assert.equal(grid.getAttribute('data-vs-focus'), null);
  assert.deepEqual(litKeys(rows), []);
  assert.equal(
    rows.every((r) => r.btn.getAttribute('aria-pressed') === 'false'),
    true,
    'releasing must clear aria-pressed everywhere, not just visually unlight',
  );
});

test('clicking a different pair moves the pin rather than adding a second one', () => {
  const { grid, rows } = mount();
  initWhyUs();

  rows[1].btn.fire('click');
  rows[5].btn.fire('click');
  assert.equal(grid.getAttribute('data-vs-focus'), 'quality');
  assert.deepEqual(litKeys(rows), ['quality', 'quality']);
});

// ---- 4. A malformed row degrades to inert, not to a dead section ------------

test('a row missing its button is skipped and the other thirteen still work', () => {
  const { grid, rows } = mount({ missingButtonOn: 'yes:price' });
  initWhyUs();

  // The surviving half of the broken pair still lights its (absent) partner's key.
  rows[KEYS.length + 2].btn.fire('pointerenter');
  assert.equal(grid.getAttribute('data-vs-focus'), 'price');

  // And an untouched pair is unaffected — the skip must not have unwired the rest.
  rows[0].btn.fire('click');
  assert.deepEqual(litKeys(rows), ['speed', 'speed']);
});

// ---- 5. Drift guards over the real markup ----------------------------------

/** index.html with comments removed — a comment naming a selector must not satisfy a guard. */
function whyusMarkup() {
  const html = fs
    .readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const start = html.indexOf('class="whyus-grid"');
  const end = html.indexOf('</section>', start);
  assert.ok(start > 0 && end > start, 'index.html no longer has a .whyus-grid section');
  return html.slice(start, end);
}

test('every pair key appears exactly twice — once per column', () => {
  const markup = whyusMarkup();
  const yes = markup.indexOf('whyus-list--yes');
  const no = markup.indexOf('whyus-list--no');
  assert.ok(yes > 0 && no > yes, 'both lists must still be present, Stagify first');

  /** @param {string} chunk */
  const keysIn = (chunk) => [...chunk.matchAll(/data-vs="([^"]+)"/g)].map((m) => m[1]);
  const stagify = keysIn(markup.slice(yes, no));
  const others = keysIn(markup.slice(no));

  assert.deepEqual(
    stagify,
    others,
    'the two columns must carry the same keys in the same order — a row added to one ' +
      'column only leaves a lit row with no partner, which reads as a rendering bug',
  );
  assert.equal(new Set(stagify).size, stagify.length, 'keys must be unique within a column');
  assert.ok(stagify.length >= 2, 'guard would be vacuous with fewer than two pairs');
});

test('data-lang-html sits INSIDE the button, never on the <li>', () => {
  const markup = whyusMarkup();

  // The failing arrangement, spelled out: a key on the <li> means language-loader.js
  // overwrites the li's innerHTML and deletes the button on the first language load.
  assert.equal(
    /<li[^>]*\bdata-lang-html/.test(markup),
    false,
    'a whyus <li> carries data-lang-html directly — language-loader.js:86 assigns ' +
      'innerHTML on that node, so it would delete the .whyus-row button inside it. ' +
      'The section would work in English and go dead after a language switch.',
  );

  const nested = markup.match(
    /<button[^>]*class="whyus-row"[^>]*>\s*<span[^>]*\bdata-lang-html/g,
  );
  const rows = markup.match(/<li[^>]*\bdata-vs=/g);
  assert.equal(
    nested?.length,
    rows?.length,
    'every row must be button > span[data-lang-html], the shape the NAR legend uses',
  );
});
