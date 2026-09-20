// Tier: frontend island logic (DOM-stubbed) + cross-file drift guards —
// public/scripts/hero-van.js and public/scripts/hero-van-art.js.
//
// On desktop, #hero-upload is a drawn night street: hero-van.js puts the SVG for the
// picker's furniture style inside the button and swaps it when the style changes; the
// motion is CSS in styles/hero-picker.css. Three files and a markup hook have to agree
// for any of it to show, and each looks fine alone while the feature is dead:
//
//   - the button must carry `.hu`, `.hu-scene` and `.hu-veil` (index.html);
//   - hero-picker.js must publish the style (`data-hp-style` + the event), or the street
//     is drawn for the wrong house and never changes;
//   - index-deferred.js must list hero-van.js, or nothing ever mounts;
//   - the CSS gate and the script's media gate must be the SAME condition, or one of
//     them paints a plate with no street in it (or a street on the mobile button).
//
// The art itself is checked for the failure modes a string-built SVG actually has: an
// id reused within one plate (the second gradient silently wins), a `url(#…)` that points
// at nothing (the fill drops), an unbalanced <g> (everything after it re-parents), and a
// template that leaked `${` / `undefined` into the markup.
//
// Fake DOM rather than jsdom (there is none in this repo), same as home-review-stars.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// The module mounts at eval time unless the document is still loading; the 'loading'
// branch only registers a listener, so stub that before importing.
globalThis.document = /** @type {any} */ ({ readyState: 'loading', addEventListener() {} });

const { buildScene, initHeroVan, SCENE_MEDIA, STYLE_EVENT } = await import('../../public/scripts/hero-van.js');
const { STYLE_HOUSE } = await import('../../public/scripts/hero-van-art.js');

// ---- the art ---------------------------------------------------------------

test('one house per furniture style, keyed exactly like hero-picker.js STYLES', () => {
  const picker = read('public/scripts/hero-picker.js');
  const keys = [...picker.matchAll(/\{ key: '([a-z]+)', slug: '[a-z]+', label: 'furnitureStyles\./g)].map((m) => m[1]);
  assert.deepEqual(STYLE_HOUSE.map((m) => m.key), keys, 'STYLE_HOUSE must list the picker’s styles, in its order');
  assert.equal(new Set(STYLE_HOUSE.map((m) => m.house)).size, keys.length, 'every style gets its own house');
});

test('every plate is well-formed SVG: unique ids, resolved refs, balanced groups, no leaks', () => {
  for (const { key } of STYLE_HOUSE) {
    const svg = buildScene(key, key);
    const ids = [...svg.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
    assert.deepEqual(dup, [], `${key}: duplicate ids ${dup}`);
    const refs = [...svg.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]);
    const missing = refs.filter((r) => !ids.includes(r));
    assert.deepEqual(missing, [], `${key}: url(#…) to nothing: ${missing}`);
    const open = (svg.match(/<g\b/g) || []).length;
    const close = (svg.match(/<\/g>/g) || []).length;
    assert.equal(open, close, `${key}: <g> ${open} vs </g> ${close}`);
    assert.doesNotMatch(svg, /\$\{|undefined|NaN/, `${key}: a template leaked into the markup`);
    // The moving parts the CSS keys off. Lose a class and that part simply stops moving.
    for (const cls of ['van', 'wheelspin', 'far', 'mid', 'near', 'home', 'ent', 'leaf', 'spill', 'lantern', 'lit', 'puff']) {
      assert.match(svg, new RegExp(`class="[^"]*\\b${cls}\\b`), `${key}: nothing carries .${cls}`);
    }
  }
});

test('two plates in one document never share an entrance clip id', () => {
  const a = buildScene('modern', 1);
  const b = buildScene('modern', 2);
  const clipsA = [...a.matchAll(/<clipPath id="([^"]+)"/g)].map((m) => m[1]);
  const clipsB = [...b.matchAll(/<clipPath id="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(clipsA.length >= 1);
  assert.deepEqual(clipsA.filter((id) => clipsB.includes(id)), []);
});

test('an unknown style draws the default house rather than throwing', () => {
  const svg = buildScene('not-a-style');
  assert.match(svg, /data-k="modern"/);
});

// ---- mounting ----------------------------------------------------------------

/** A stub of the little DOM initHeroVan touches. */
function makeDom({ matches = true, style = 'luxury' } = {}) {
  /** @type {Record<string, Function[]>} */
  const docListeners = {};
  /** @type {Record<string, Function[]>} */
  const btnListeners = {};
  const classes = new Set();
  const scene = { innerHTML: '' };
  const btn = {
    classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    querySelector: (sel) => (sel === '.hu-scene' ? scene : null),
    addEventListener: (type, fn) => (btnListeners[type] = btnListeners[type] || []).push(fn),
  };
  const stage = { getAttribute: (n) => (n === 'data-hp-style' ? style : null) };
  const doc = {
    getElementById: (id) => (id === 'hero-upload' ? btn : null),
    querySelector: (sel) => (sel === '[data-hp-stage]' ? stage : null),
    addEventListener: (type, fn) => (docListeners[type] = docListeners[type] || []).push(fn),
  };
  let now = 0;
  const win = {
    matchMedia: (q) => ({ matches: q === SCENE_MEDIA && matches }),
    performance: { now: () => now },
  };
  return {
    doc, win, btn, scene, classes,
    fire: (type, detail) => (docListeners[type] || []).forEach((fn) => fn({ detail })),
    pointer: (type) => (btnListeners[type] || []).forEach((fn) => fn({})),
    tick: (ms) => { now += ms; },
  };
}

test('mounts the picker’s current style, marks the button, and swaps on the event', () => {
  const d = makeDom({ style: 'luxury' });
  const ctl = initHeroVan(/** @type {any} */ (d.doc), /** @type {any} */ (d.win));
  assert.ok(ctl);
  assert.equal(ctl.current(), 'luxury');
  assert.match(d.scene.innerHTML, /data-k="georgian"/, 'Luxury is the Georgian townhouse');
  assert.ok(d.classes.has('hu-mounted'));

  d.fire(STYLE_EVENT, { style: 'farmhouse' });
  assert.equal(ctl.current(), 'farmhouse');
  assert.match(d.scene.innerHTML, /data-k="farmhouse"/);

  const before = d.scene.innerHTML;
  d.fire(STYLE_EVENT, { style: 'farmhouse' });
  assert.equal(d.scene.innerHTML, before, 'same style again is a no-op, not a rebuild');
  d.fire(STYLE_EVENT, {});
  assert.equal(ctl.current(), 'farmhouse', 'a malformed event changes nothing');
});

test('does not mount below the desktop gate, and never mounts twice', () => {
  const phone = makeDom({ matches: false });
  assert.equal(initHeroVan(/** @type {any} */ (phone.doc), /** @type {any} */ (phone.win)), null);
  assert.equal(phone.scene.innerHTML, '', 'the mobile button keeps its empty scene span');

  const d = makeDom();
  assert.ok(initHeroVan(/** @type {any} */ (d.doc), /** @type {any} */ (d.win)));
  assert.equal(initHeroVan(/** @type {any} */ (d.doc), /** @type {any} */ (d.win)), null);
});

test('a leave before the door has opened is marked quick; a full visit is not', () => {
  const d = makeDom();
  initHeroVan(/** @type {any} */ (d.doc), /** @type {any} */ (d.win));
  d.pointer('pointerenter'); d.tick(400); d.pointer('pointerleave');
  assert.ok(d.classes.has('hu-quick'), 'left mid-drive: reverse at once');
  d.pointer('pointerenter');
  assert.ok(!d.classes.has('hu-quick'), 'cleared on the next hover');
  d.tick(1500); d.pointer('pointerleave');
  assert.ok(!d.classes.has('hu-quick'), 'door had opened: the ordered leave applies');
});

// ---- drift guards -------------------------------------------------------------

test('index.html carries the plate hooks on #hero-upload', () => {
  const html = read('public/index.html');
  const m = /<button id="hero-upload" class="([^"]*)">([\s\S]*?)<\/button>/.exec(html);
  assert.ok(m, '#hero-upload not found');
  assert.ok(m[1].split(/\s+/).includes('hu'), 'the button needs .hu for the desktop plate CSS');
  assert.match(m[2], /<span class="hu-scene" aria-hidden="true"><\/span>/);
  assert.match(m[2], /<span class="hu-veil" aria-hidden="true"><\/span>/);
  assert.match(m[2], /<strong data-lang="hero\.cta">/, 'the label keeps its data-lang');
});

test('hero-picker.js publishes the style both ways hero-van.js reads it', () => {
  const src = read('public/scripts/hero-picker.js').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(src, /setAttribute\('data-hp-style', style\.key\)/);
  assert.match(src, new RegExp(`new CustomEvent\\('${STYLE_EVENT}'`));
  // Published after a pick AND once at init, or a returning visitor's restored style is drawn as the default.
  assert.ok((src.match(/publishStyle\(\)/g) || []).length >= 3, 'publishStyle() must be defined, called from pick() and called at init');
});

test('index-deferred.js loads hero-van.js', () => {
  assert.match(read('public/scripts/index-deferred.js'), /\{ src: 'scripts\/hero-van\.js', module: true \}/);
});

test('the CSS gate and the script gate are the same media condition', () => {
  const css = read('public/styles/hero-picker.css');
  const gates = css.match(/@media \(min-width: 769px\) and \(hover: hover\) and \(pointer: fine\)/g) || [];
  assert.ok(gates.length >= 1, 'hero-picker.css has no desktop gate for #hero-upload.hu');
  assert.equal(SCENE_MEDIA, '(min-width: 769px) and (hover: hover) and (pointer: fine)');
  assert.match(css, /#hero-upload\.hu \{/);
  assert.match(css, /#hero-upload\.hu\.hu-quick/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('the old desktop button rules are gone (the mobile ones stay)', () => {
  const index = read('public/styles/index.css');
  assert.doesNotMatch(index, /#hero-upload \{[^}]*!important/, 'index.css’s !important desktop sizing would override the plate');
  const styles = read('public/styles/styles.css');
  assert.doesNotMatch(styles, /#hero-upload::before,\.nav-link::before/, 'the global shimmer must not target #hero-upload');
  // The max-width:768px block keeps its own #hero-upload shimmer: that is the mobile button.
  const mobile = styles.slice(styles.indexOf('@media (max-width:768px)'));
  assert.match(mobile, /#hero-upload::before \{/);
});
