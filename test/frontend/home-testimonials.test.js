// Tier: frontend island logic (DOM-stubbed) — public/scripts/home-testimonials.js.
//
// #testimonials went from a two-up grid of 2 quotes to a DECK, now of 5. The grid could
// not carry that many: they ran ~5 screens tall between the two heaviest blocks on the
// page, and the phone rule "fixed" that by hiding every card after the first outright,
// so a phone visitor saw one quote and the rest were simply thrown away.
//
// Three kinds of assertion live here:
//
//   1. Behaviour, against a fake DOM (no jsdom in this repo — same approach as
//      test/frontend/home-whyus.test.js). The interesting cases are the ones a
//      screenshot cannot show: that `inert` tracks the top card so the buried cards
//      never sit in the tab order, and that a deck of one BAILS rather than arming a
//      widget whose arrows cycle a single quote. These run against a synthetic 6-card
//      deck on purpose — the logic is count-agnostic, and pinning it to the shipped
//      count would make every future testimonial a test edit.
//
//   2. Drift guards over the real index.html / home.css / index-deferred.js. The
//      progressive-enhancement contract is the one worth pinning: every deck rule must
//      stay scoped behind `.tw-deck--ready`. Lift one out and a JS failure stops
//      degrading to "a readable column of six quotes" and starts rendering a pile of
//      overlapping cards with no way to advance — which looks fine in every local check,
//      because locally the JS always loads.
//
//   3. A guard against the four placeholder testimonials ever coming back. It shipped
//      skipped while they were still on the page; the real quotes landed, so it runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');

const INDEX = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const HOME_CSS_RAW = fs.readFileSync(path.join(PUBLIC, 'styles', 'home.css'), 'utf8');

/**
 * Strip CSS comments before scanning for rules.
 *
 * Not optional. The deck's own comment block QUOTES the rule this file forbids
 * (".tw-card:nth-child(n + 2) { display: none }") to explain what was removed and why —
 * so an unstripped scan matches the explanation and fails while the CSS is correct. The
 * mirror image is worse: a comment mentioning a rule could keep a guard green after the
 * real rule came back. Same reasoning as stripComments() in index-deferred.test.js.
 */
const HOME_CSS = HOME_CSS_RAW.replace(/\/\*[\s\S]*?\*\//g, '');
const ENGLISH = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'languages', 'english.json'), 'utf8'));

// Imported with `document` still undefined, so the module's own auto-init at the bottom
// does not fire and each test can drive a fresh fake DOM. ORDER MATTERS — stubbing the
// globals first would arm the deck against a DOM that does not exist yet.
const { initTestimonialDeck } = await import('../../public/scripts/home-testimonials.js');

// index-deferred.js, by contrast, touches both globals at eval time. readyState
// 'loading' takes the branch that only registers a listener, so nothing is scheduled.
globalThis.document = /** @type {any} */ ({ readyState: 'loading' });
globalThis.window = /** @type {any} */ ({ addEventListener() {} });
const { DEFERRED } = await import('../../public/scripts/index-deferred.js');

// ---- Minimal fake DOM ------------------------------------------------------

/**
 * @param {string[]} sels selectors this node answers to
 * @param {any[]} [children]
 */
function el(sels, children = []) {
  /** @type {Record<string, Function[]>} */
  const handlers = {};
  /** @type {Record<string, string>} */
  const attrs = {};
  /** @type {Set<string>} */
  const classes = new Set();
  /** @type {Record<string, string>} */
  const props = {};

  const node = {
    sels: new Set(sels),
    children,
    dataset: /** @type {Record<string, string|undefined>} */ ({}),
    props,
    textContent: '',
    style: {
      transform: '',
      setProperty(/** @type {string} */ k, /** @type {string} */ v) { props[k] = v; },
    },
    classList: {
      add: (/** @type {string} */ c) => classes.add(c),
      remove: (/** @type {string} */ c) => classes.delete(c),
      contains: (/** @type {string} */ c) => classes.has(c),
    },
    setAttribute(/** @type {string} */ k, /** @type {string} */ v) { attrs[k] = String(v); },
    removeAttribute(/** @type {string} */ k) { delete attrs[k]; },
    getAttribute(/** @type {string} */ k) { return k in attrs ? attrs[k] : null; },
    hasAttribute(/** @type {string} */ k) { return k in attrs; },
    addEventListener(/** @type {string} */ t, /** @type {Function} */ fn) {
      (handlers[t] ||= []).push(fn);
    },
    fire(/** @type {string} */ t, /** @type {any} */ ev = {}) {
      for (const fn of handlers[t] || []) fn.call(node, ev);
    },
    querySelector(/** @type {string} */ s) {
      return descendants(node).find((n) => n.sels.has(s)) || null;
    },
    querySelectorAll(/** @type {string} */ s) {
      return descendants(node).filter((n) => n.sels.has(s));
    },
  };
  return node;
}

/** @param {any} node */
function descendants(node) {
  /** @type {any[]} */
  const out = [];
  for (const child of node.children) {
    out.push(child);
    out.push(...descendants(child));
  }
  return out;
}

/** Build a deck of `n` cards plus the controls, and install it as `document`. */
function mountDeck(n = 6) {
  const cards = Array.from({ length: n }, () => el(['.tw-card']));
  const stack = el(['[data-deck-stack]'], cards);
  const prev = el(['[data-deck-prev]']);
  const next = el(['[data-deck-next]']);
  const at = el(['[data-deck-at]']);
  const of = el(['[data-deck-of]']);
  const deck = el(['[data-deck]'], [stack, ...cards, prev, next, at, of]);

  globalThis.document = /** @type {any} */ ({
    querySelector: (/** @type {string} */ s) => (deck.sels.has(s) ? deck : deck.querySelector(s)),
  });
  globalThis.window = /** @type {any} */ ({ setTimeout: globalThis.setTimeout });

  return { deck, stack, cards, prev, next, at, of };
}

/** Index into `cards` of the card currently on top. */
function topIndex(/** @type {any[]} */ cards) {
  return cards.findIndex((c) => c.dataset.top !== undefined);
}

// ---- Behaviour -------------------------------------------------------------

test('arms the deck and reports the real card count', () => {
  const { deck, at, of } = mountDeck(6);
  assert.equal(initTestimonialDeck({ reducedMotion: true }), true);

  assert.ok(deck.classList.contains('tw-deck--ready'), 'ready class arms the CSS');
  assert.equal(at.textContent, '1');
  // Written from cards.length, not trusted from the markup, so a seventh testimonial
  // cannot leave the total silently reading "6".
  assert.equal(of.textContent, '6');
});

test('only the top card is interactive; the other five are inert', () => {
  const { cards } = mountDeck(6);
  initTestimonialDeck({ reducedMotion: true });

  assert.equal(topIndex(cards), 0);
  assert.equal(cards[0].hasAttribute('inert'), false);
  for (let i = 1; i < 6; i += 1) {
    assert.equal(cards[i].hasAttribute('inert'), true, `card ${i} should be inert`);
    assert.equal(cards[i].dataset.top, undefined);
  }
  // --i is the fan depth the CSS transform reads; data-i is what it can select on.
  assert.deepEqual(cards.map((c) => c.props['--i']), ['0', '1', '2', '3', '4', '5']);
  assert.deepEqual(cards.map((c) => c.dataset.i), ['0', '1', '2', '3', '4', '5']);
});

test('next and prev cycle, and inert follows the top card', () => {
  const { cards, prev, next, at } = mountDeck(6);
  initTestimonialDeck({ reducedMotion: true });

  next.fire('click');
  assert.equal(topIndex(cards), 1);
  assert.equal(at.textContent, '2');
  assert.equal(cards[0].hasAttribute('inert'), true, 'the card just advanced past is inert');
  assert.equal(cards[1].hasAttribute('inert'), false);

  prev.fire('click');
  assert.equal(topIndex(cards), 0);
  assert.equal(at.textContent, '1');

  // Wraps backwards rather than dead-ending on the first card.
  prev.fire('click');
  assert.equal(topIndex(cards), 5);
  assert.equal(at.textContent, '6');
});

test('arrow keys advance the stack and Home returns to the first quote', () => {
  const { stack, cards, at } = mountDeck(6);
  initTestimonialDeck({ reducedMotion: true });

  let prevented = 0;
  const ev = (/** @type {string} */ key) => ({ key, preventDefault: () => { prevented += 1; } });

  stack.fire('keydown', ev('ArrowRight'));
  stack.fire('keydown', ev('ArrowRight'));
  assert.equal(topIndex(cards), 2);

  stack.fire('keydown', ev('ArrowLeft'));
  assert.equal(topIndex(cards), 1);

  stack.fire('keydown', ev('Home'));
  assert.equal(topIndex(cards), 0);
  assert.equal(at.textContent, '1');
  assert.equal(prevented, 4, 'arrow/Home keys must not also scroll the page');

  // An unhandled key is left alone for the browser.
  stack.fire('keydown', ev('Tab'));
  assert.equal(prevented, 4);
  assert.equal(topIndex(cards), 0);

  assert.equal(stack.getAttribute('role'), 'group');
  assert.equal(stack.getAttribute('tabindex'), '0');
});

test('a drag past the threshold advances; a short drag springs back', () => {
  const { cards, at } = mountDeck(6);
  initTestimonialDeck({ reducedMotion: true });

  // Short drag: transform is cleared (handing the card back to the CSS fan) and the
  // deck does NOT advance.
  cards[0].fire('pointerdown', { clientX: 200, pointerId: 1 });
  cards[0].fire('pointermove', { clientX: 240 });
  assert.notEqual(cards[0].style.transform, '', 'card follows the pointer while dragging');
  cards[0].fire('pointerup', { clientX: 240 });
  assert.equal(cards[0].style.transform, '');
  assert.equal(topIndex(cards), 0);
  assert.equal(at.textContent, '1');

  // Past the threshold. reducedMotion skips the fly-out, so this advances synchronously
  // instead of leaving the assertion racing a 420ms timer.
  cards[0].fire('pointerdown', { clientX: 200, pointerId: 1 });
  cards[0].fire('pointerup', { clientX: 400 });
  assert.equal(topIndex(cards), 1);
  assert.equal(at.textContent, '2');
});

test('a buried card cannot start a drag even if it receives the event', () => {
  const { cards } = mountDeck(6);
  initTestimonialDeck({ reducedMotion: true });

  // CSS gives buried cards pointer-events:none, but a stale paint or a failed
  // stylesheet must not let the wrong card be thrown.
  cards[3].fire('pointerdown', { clientX: 200, pointerId: 1 });
  cards[3].fire('pointermove', { clientX: 500 });
  assert.equal(cards[3].style.transform, '');
  assert.equal(topIndex(cards), 0);
});

test('a deck of one bails instead of arming a widget with nothing to advance', () => {
  const { deck } = mountDeck(1);
  assert.equal(initTestimonialDeck({ reducedMotion: true }), false);
  assert.equal(
    deck.classList.contains('tw-deck--ready'),
    false,
    'without the ready class the section stays a plain readable quote',
  );
});

test('no deck in the DOM is a no-op, not a throw', () => {
  globalThis.document = /** @type {any} */ ({ querySelector: () => null });
  assert.equal(initTestimonialDeck({ reducedMotion: true }), false);
});

// ---- Drift guards over the real files --------------------------------------

/** The `#testimonials` section as it appears in the shipped index.html. */
function testimonialsSection() {
  const start = INDEX.indexOf('<section class="home-section home-testimonials"');
  assert.ok(start > -1, 'index.html should still have the testimonials section');
  const end = INDEX.indexOf('</section>', start);
  return INDEX.slice(start, end);
}

test('index.html ships seven cards in one deck, all keyed to english.json', () => {
  const section = testimonialsSection();

  const cards = section.match(/<figure class="tw-card"/g) || [];
  assert.equal(cards.length, 7, 'seven testimonials, all in the deck');
  assert.ok(section.includes('data-deck-stack'), 'the deck needs its stack hook');
  assert.match(section, /data-deck-of/, 'the total is written by JS into this span');

  // Every visible string must resolve, or a language switch blanks it. The
  // english→others parity gate in test/server/static.test.js covers the other 10 packs.
  const keys = [...section.matchAll(/data-lang(?:-attr)?="([^"|]+)/g)].map((m) => m[1]);
  assert.ok(keys.length >= 31, `expected 7 cards x 4 keys + controls, saw ${keys.length}`);
  for (const key of keys) {
    const value = key.split('.').reduce((/** @type {any} */ o, k) => (o == null ? o : o[k]), ENGLISH);
    assert.equal(typeof value, 'string', `english.json is missing ${key}`);
  }
});

test('the phone rule that hid five of six quotes is gone for good', () => {
  // This is the regression the whole redesign exists to prevent. The old rule read
  // `.tw-card:nth-child(n + 2) { display: none }` inside the 768px block, so a phone
  // showed exactly one testimonial. Nothing about that is visible on a desktop check.
  assert.doesNotMatch(
    HOME_CSS,
    /\.tw-card:nth-child\([^)]*\)\s*\{[^}]*display:\s*none/,
    'testimonial cards must never be hidden by position again',
  );
});

test('every deck rule stays scoped behind .tw-deck--ready', () => {
  // The progressive-enhancement contract. `var(--i)` is the fan transform and
  // `grid-area` is what collapses six cards onto one cell — either one applied without
  // the ready class turns a JS failure into a pile of overlapping cards.
  const blocks = [...HOME_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const leaked = blocks
    .filter(([, sel]) => /\.tw-(card|stack|ctl|hint)\b/.test(sel))
    .filter(([, , body]) => /var\(--i\)|grid-area/.test(body))
    .filter(([, sel]) => !sel.includes('.tw-deck--ready'))
    .map(([, sel]) => sel.trim());

  assert.deepEqual(leaked, [], 'these deck rules would apply with no JS');
});

test('the deck script is registered in index-deferred.js', () => {
  // A module that is never injected fails silently — no error, the deck just never arms.
  assert.ok(
    DEFERRED.some((entry) => entry.src === 'scripts/home-testimonials.js' && entry.module),
    'home-testimonials.js must be in the deferred list, as a module',
  );
});

test('the brokerage logos are decode-warmed', () => {
  // All but the top one sit behind it when the section scrolls in, so without this
  // each one decodes as you reach it and pops in. A stale selector here does not throw.
  const reveal = fs.readFileSync(path.join(PUBLIC, 'scripts', 'home-reveal.js'), 'utf8');
  assert.match(reveal, /\.tw-logo/, 'home-reveal.js warmImages() should cover .tw-logo');
});

// ---- The placeholder guard -------------------------------------------------

// Live since the three real agents landed and the six-card deck became five. Every
// visible string on this section is a named person's endorsement, so nothing invented
// may ship here — not in the markup, not in any of the 11 packs.
test('no placeholder testimonials remain', () => {
  const section = testimonialsSection();
  assert.doesNotMatch(section, /data-placeholder/, 'index.html still has placeholder cards');
  assert.doesNotMatch(section, /Placeholder Agent/, 'index.html still has placeholder names');
  assert.doesNotMatch(section, /placeholder-\d\.svg/, 'index.html still has placeholder logos');

  // The English pack is what the parity gate copies outward, but a placeholder could
  // just as easily be left behind in a translation — so check all 11.
  for (const file of fs.readdirSync(path.join(PUBLIC, 'languages'))) {
    const pack = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'languages', file), 'utf8'));
    const items = pack.home.testimonials.items;
    for (const [key, item] of Object.entries(items)) {
      assert.doesNotMatch(
        /** @type {any} */ (item).quote,
        /PLACEHOLDER/i,
        `${file} home.testimonials.items.${key} is still a placeholder`,
      );
    }
  }
});
