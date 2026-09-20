// Tier: frontend behaviour — public/scripts/hero-restore.js, the pre-paint half of the
// homepage hero's remembered pick.
//
// The hero photo is the page's LCP element, so it ships static in index.html, and the pair
// it ships is the DEFAULT one because index.html is one file cached for everybody.
// hero-picker.js restores the visitor's remembered pick, but it is a module and therefore
// runs at the end of parsing, so a returning visitor watched the default photo paint and
// then cross-fade into theirs. hero-restore.js is a classic, parser-blocking script sitting
// next to the element that repoints it before any of that.
//
// Four things hold it together, and three of them fail silently:
//   • it must run AFTER the <img> and BEFORE the paint — that is purely a matter of where
//     the tag sits and what kind of tag it is, so the markup is pinned here;
//   • it must know nothing about rooms or styles. The tables live in hero-picker.js and a
//     second copy is how they drift, so it substitutes a stored basename into the src/srcset
//     already on the node. That contract has two ends and both are checked;
//   • a stored value it does not recognise, or cannot load, must leave the shipped markup
//     alone — the failure mode is an empty LCP frame, which is worse than the flash;
//   • it must hand over to hero-picker.js, which adopts what is on screen rather than
//     re-fetching it (data-hp-restored).
//
// Like the other classic head scripts this runs the SHIPPED SOURCE with `window` and
// `document` injected as parameters that shadow the globals inside it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const SOURCE = fs.readFileSync(path.join(PUBLIC, 'scripts', 'hero-restore.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const PICKER = fs.readFileSync(path.join(PUBLIC, 'scripts', 'hero-picker.js'), 'utf8');

const DEFAULT_BASE = 'modern-bedroom';
const DIR = 'media-webp/example/';
const SRC = `${DIR}${DEFAULT_BASE}.webp`;
const SRCSET = [
  `${DIR}${DEFAULT_BASE}-900.webp 900w`,
  `${DIR}${DEFAULT_BASE}.webp 1248w`,
  `${DIR}${DEFAULT_BASE}-1872.webp 1872w`,
  `${DIR}${DEFAULT_BASE}-2496.webp 2496w`,
].join(', ');
const SIZES = '(min-width: 1180px) 1110px, 94vw';

/**
 * A stand-in for the static <img>, recording the ORDER of the writes as well as the values:
 * srcset has to be set before src or the browser can commit to a URL before it has the
 * candidate list, which is the wasted request hero-picker.js's setCandidates() avoids too.
 */
function fakeImg() {
  /** @type {Record<string, string>} */
  const attrs = { src: SRC, srcset: SRCSET, sizes: SIZES, 'data-hp-img': '' };
  /** @type {string[]} */
  const writes = [];
  /** @type {Array<(...a: any[]) => void>} */
  const errorHandlers = [];
  return {
    attrs,
    writes,
    get src() { return attrs.src; },
    set src(v) { writes.push('src'); attrs.src = v; },
    get srcset() { return attrs.srcset; },
    set srcset(v) { writes.push('srcset'); attrs.srcset = v; },
    get sizes() { return attrs.sizes; },
    set sizes(v) { writes.push('sizes'); attrs.sizes = v; },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = String(v); },
    removeAttribute: (k) => { delete attrs[k]; },
    addEventListener: (type, fn) => { if (type === 'error') errorHandlers.push(fn); },
    removeEventListener: (type, fn) => {
      if (type !== 'error') return;
      const i = errorHandlers.indexOf(fn);
      if (i >= 0) errorHandlers.splice(i, 1);
    },
    fireError: () => errorHandlers.slice().forEach((fn) => fn()),
    handlerCount: () => errorHandlers.length,
  };
}

/**
 * Run the real script against stored state.
 * @param {{ stored?: string|null, throws?: boolean, img?: any }} opts
 */
function run({ stored = null, throws = false, img = fakeImg() } = {}) {
  const win = {
    localStorage: {
      getItem: (k) => {
        if (throws) throw new Error('storage unavailable');
        return k === 'heroPickImg' ? stored : null;
      },
    },
  };
  const doc = { querySelector: (sel) => (sel === '[data-hp-img]' ? img : null) };
  new Function('window', 'document', 'localStorage', SOURCE)(win, doc, win.localStorage);
  return img;
}

// ── the swap ─────────────────────────────────────────────────────────────────

test('a remembered pair replaces the shipped one everywhere it is spelled', () => {
  const img = run({ stored: 'coastal-living-room' });
  assert.equal(img.src, `${DIR}coastal-living-room.webp`);
  assert.equal(
    img.srcset,
    [
      `${DIR}coastal-living-room-900.webp 900w`,
      `${DIR}coastal-living-room.webp 1248w`,
      `${DIR}coastal-living-room-1872.webp 1872w`,
      `${DIR}coastal-living-room-2496.webp 2496w`,
    ].join(', '),
    'every candidate in the ladder moves, not just the src fallback'
  );
});

test('srcset is written before src', () => {
  // Set src first and the browser may start fetching that URL before it has the candidate
  // list — a wasted request on exactly the element whose bytes are the LCP.
  const img = run({ stored: 'luxury-office' });
  assert.deepEqual(img.writes, ['srcset', 'src']);
});

test('`sizes` is left alone', () => {
  // The canvas is the same size whatever is in it, and `sizes` is one of the three copies
  // test/frontend/hero-picker-lcp.test.js keeps in agreement.
  const img = run({ stored: 'luxury-office' });
  assert.equal(img.sizes, SIZES);
  assert.ok(!img.writes.includes('sizes'));
});

test('the pair it applied is left on the node for hero-picker.js to adopt', () => {
  const img = run({ stored: 'farmhouse-kitchen' });
  assert.equal(img.getAttribute('data-hp-restored'), 'farmhouse-kitchen');
});

test('the node is never replaced, only repointed', () => {
  // Rule 3 of the contract in index.html: replacing the <img>, even with an identical src,
  // restarts the LCP candidate at the later time. Nothing here may create an element.
  assert.ok(!/document\.(createElement|write)|new Image|innerHTML|replaceWith/.test(SOURCE));
});

// ── when it must do nothing ──────────────────────────────────────────────────

const INERT = [
  ['nothing stored', null],
  ['an empty value', ''],
  ['the pair the markup already ships', DEFAULT_BASE],
  ['a traversal attempt', '../../secret'],
  ['an absolute URL', 'https://evil.example/x'],
  ['a protocol-relative URL', '//evil.example/x'],
  ['an extension', 'modern-bedroom.webp'],
  ['a query string', 'modern-bedroom?x=1'],
  ['uppercase', 'Modern-Bedroom'],
  ['a single word', 'modern'],
  ['too many segments', 'a-b-c-d-e'],
  ['whitespace', 'modern bedroom'],
];

INERT.forEach(([what, stored]) => {
  test(`${what} leaves the shipped markup exactly as it is`, () => {
    const img = run({ stored });
    assert.equal(img.src, SRC);
    assert.equal(img.srcset, SRCSET);
    assert.equal(img.getAttribute('data-hp-restored'), null);
    assert.deepEqual(img.writes, [], 'not even a no-op write, which would restart the fetch');
  });
});

test('unreadable storage falls back to the shipped pair instead of throwing', () => {
  // A throw aborts a render-blocking script; everything parsed below it would be lost.
  let img;
  assert.doesNotThrow(() => { img = run({ throws: true }); });
  assert.equal(img.src, SRC);
});

test('a hero-less page is not an error', () => {
  const win = { localStorage: { getItem: () => 'coastal-living-room' } };
  assert.doesNotThrow(() => {
    new Function('window', 'document', 'localStorage', SOURCE)(
      win, { querySelector: () => null }, win.localStorage
    );
  });
});

// ── the 404 path ─────────────────────────────────────────────────────────────

test('a pair whose renders are gone reverts to the shipped one', () => {
  // An empty LCP frame is worse than the flash this removes, so one error and the markup's
  // own pair comes back — data attribute included, so hero-picker.js adopts the default.
  const img = run({ stored: 'standard-bathroom' });
  img.fireError();
  assert.equal(img.src, SRC);
  assert.equal(img.srcset, SRCSET);
  assert.equal(img.getAttribute('data-hp-restored'), null);
  assert.equal(img.handlerCount(), 0, 'the revert unbinds itself; the fallback must not loop');
});

// ── the contract with hero-picker.js ─────────────────────────────────────────

test('hero-picker.js writes the key this reads, as <style>-<room>', () => {
  assert.match(PICKER, /const IMG_KEY = 'heroPickImg';/);
  assert.match(
    PICKER,
    /setItem\(IMG_KEY, s\.slug \+ '-' \+ r\.slug\)/,
    'the basename must be composed where the slug tables are, never re-derived in hero-restore.js'
  );
  assert.match(SOURCE, /getItem\('heroPickImg'\)/);
});

test('hero-picker.js adopts what was pre-restored rather than re-fetching it', () => {
  assert.match(PICKER, /getAttribute\('data-hp-restored'\)/);
});

test('hero-restore.js carries no room or style table', () => {
  // The whole reason it substitutes into the attributes already on the node. A slug list
  // here is a second copy of ROOMS/STYLES that nothing keeps in step. Comments are stripped
  // first: the header names a pair as an EXAMPLE, which is documentation, not a table.
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ['living-room', 'dining-room', 'scandinavian', 'midcentury', 'farmhouse']
    .forEach((slug) => assert.ok(!code.includes(slug), `hero-restore.js names ${slug}`));
  assert.ok(!code.includes(DIR), 'it must not hard-code the media path either');
});

test('the shape check accepts every render that actually exists', () => {
  const shape = SOURCE.match(/\/\^\[a-z\][^/]*\/(?=\.test)/);
  assert.ok(shape, 'could not find the slug regex in hero-restore.js');
  const re = new RegExp(shape[0].slice(1, -1));
  const bases = [...new Set(
    fs.readdirSync(path.join(PUBLIC, 'media-webp', 'example'))
      .filter((f) => f.endsWith('.webp') && !f.startsWith('Original'))
      .map((f) => f.replace(/(-\d+)?\.webp$/, ''))
  )];
  assert.ok(bases.length >= 20, 'the example renders went missing');
  bases.forEach((b) => assert.ok(re.test(b), `the shape check would reject the real render ${b}`));
});

// ── the markup that makes it work at all ─────────────────────────────────────

test('the tag sits inside .hp-canvas, after the <img>, and blocks the parser', () => {
  const canvas = INDEX.indexOf('<div class="hp-canvas"');
  const img = INDEX.indexOf('data-hp-img', canvas);
  const tag = INDEX.indexOf('scripts/hero-restore.js"></script>', img);
  const canvasEnd = INDEX.indexOf('</section>', canvas);
  assert.ok(canvas !== -1 && img !== -1, 'the hero markup was restructured — update this test');
  assert.ok(tag !== -1 && tag < canvasEnd, 'hero-restore.js must load inside the hero, after the image');
  const tagStart = INDEX.lastIndexOf('<script', tag);
  assert.ok(
    !/type="module"|\bdefer\b|\basync\b/.test(INDEX.slice(tagStart, tag)),
    'it has to run before the first paint: a module, a defer or an async runs too late'
  );
});

test('the script is preloaded from <head>', () => {
  // Parser-blocking and discovered low in the body, it would queue behind ~60 module tags.
  // Same lesson as the session-class.js preload two lines below it.
  const head = INDEX.slice(0, INDEX.indexOf('</head>'));
  assert.match(head, /<link rel="preload" as="script" href="scripts\/hero-restore\.js"/);
});

test('it is a classic script with no imports, so the tag above stays legal', () => {
  assert.ok(!/^\s*(import|export)\b/m.test(SOURCE));
});
