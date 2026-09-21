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
  const scene = { innerHTML: '', querySelector: () => null };
  const props = {};
  const btn = {
    style: { setProperty: (k, v) => { props[k] = v; } },
    classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    querySelector: (sel) => (sel === '.hu-scene' ? scene : null),
    addEventListener: (type, fn) => (btnListeners[type] = btnListeners[type] || []).push(fn),
  };
  const stage = { getAttribute: (n) => (n === 'data-hp-style' ? style : null) };
  /** The two modals a click can open, each a class set plus the observer it wakes. */
  const modalWatchers = [];
  const makeModal = () => {
    const cls = new Set(['hidden']);
    return {
      classList: { contains: (c) => cls.has(c), add: (c) => { cls.add(c); modalWatchers.forEach((fn) => fn()); }, remove: (c) => { cls.delete(c); modalWatchers.forEach((fn) => fn()); } },
    };
  };
  const modals = { 'stage-modal': makeModal(), 'auth-modal': makeModal() };
  const doc = {
    getElementById: (id) => (id === 'hero-upload' ? btn : modals[id] || null),
    querySelector: (sel) => (sel === '[data-hp-stage]' ? stage : null),
    addEventListener: (type, fn) => (docListeners[type] = docListeners[type] || []).push(fn),
  };
  let now = 0;
  /** Pending setTimeout callbacks, fired by hand. */
  const timers = [];
  const win = {
    setTimeout: (fn, ms) => timers.push({ fn, ms }) && timers.length,
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    matchMedia: (q) => ({ matches: q === SCENE_MEDIA && matches }),
    performance: { now: () => now },
    MutationObserver: class { constructor(fn) { this.fn = fn; } observe() { modalWatchers.push(this.fn); } },
  };
  return {
    doc, win, btn, scene, classes, modals, props,
    fire: (type, detail) => (docListeners[type] || []).forEach((fn) => fn({ detail })),
    pointer: (type, ev = {}) => (btnListeners[type] || []).forEach((fn) => fn(ev)),
    timers,
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
  assert.ok(d.classes.has('hu-quick'), 'left mid-drive: roll on at once');
  assert.ok(d.classes.has('hu-out'), 'every leave plays the drive-out');
  d.pointer('pointerenter');
  assert.ok(d.classes.has('hu-quick'), 'kept while the drive-out runs: dropping it would re-time the animation');
  assert.ok(d.classes.has('hu-out'), 'the hover waits: the van is still driving out');
  d.pointer('animationend', { animationName: 'hu-drive-out' });
  assert.ok(!d.classes.has('hu-out'), 'drive-out over: the drive-in can start');
  assert.ok(!d.classes.has('hu-quick'), 'and quick goes with it');
  d.tick(1500); d.pointer('pointerleave');
  assert.ok(!d.classes.has('hu-quick'), 'door had opened: the ordered leave applies');
  assert.ok(d.classes.has('hu-out'));
});

test('a hover during the drive-out waits for it to end; a leave during it changes nothing', () => {
  const d = makeDom();
  const ctl = initHeroVan(/** @type {any} */ (d.doc), /** @type {any} */ (d.win));
  d.pointer('pointerenter'); d.tick(2000); d.pointer('pointerleave');
  assert.ok(d.classes.has('hu-out'));
  d.pointer('pointerenter');
  assert.ok(d.classes.has('hu-out'), 'still driving out: the hover rules stay gated');
  d.props['--hu-van-x'] = 'untouched';
  d.pointer('pointerleave');
  assert.equal(d.props['--hu-van-x'], 'untouched', 'a leave mid-drive-out must not move the from keyframe');
  d.pointer('animationend', { animationName: 'hu-bump' });
  assert.ok(d.classes.has('hu-out'), 'some other animation ending is not the drive-out ending');
  d.pointer('animationend', { animationName: 'hu-drive-out' });
  assert.ok(!d.classes.has('hu-out'), 'the drive-out ended: hover can arrive again');

  // No animationend at all (reduced motion): the fallback timer clears it.
  d.pointer('pointerenter'); d.pointer('pointerleave');
  assert.ok(d.classes.has('hu-out'));
  const t = d.timers[d.timers.length - 1];
  assert.equal(t.ms, 1200);
  t.fn();
  assert.ok(!d.classes.has('hu-out'), 'fallback timer released it');

  // A style swap rebuilds the scene and discards the animating van: the drive-out is over.
  d.pointer('pointerenter'); d.pointer('pointerleave');
  assert.ok(d.classes.has('hu-out'));
  d.fire(STYLE_EVENT, { style: 'coastal' });
  assert.equal(ctl.current(), 'coastal');
  assert.ok(!d.classes.has('hu-out'), 'rebuild ends the drive-out');
});

test('the drive-out starts from where the van is, falling back to the parking bay', () => {
  const d = makeDom();
  initHeroVan(/** @type {any} */ (d.doc), /** @type {any} */ (d.win));
  d.pointer('pointerenter'); d.tick(1500); d.pointer('pointerleave');
  assert.equal(d.props['--hu-van-x'], '210px', 'no computed style available: parked');
  assert.equal(d.props['--hu-out-ms'], '750ms', 'the parked drive-out is the reference speed');

  const e = makeDom();
  e.scene.querySelector = (sel) => (sel === '.van' ? { tag: 'van' } : null);
  e.win.getComputedStyle = () => ({ transform: 'matrix(1, 0, 0, 1, 37.5, 0)' });
  initHeroVan(/** @type {any} */ (e.doc), /** @type {any} */ (e.win));
  e.pointer('pointerenter'); e.tick(200); e.pointer('pointerleave');
  assert.equal(e.props['--hu-van-x'], '37.5px', 'mid-arrival: keep going from here');
  assert.equal(e.props['--hu-out-ms'], '956ms', 'still rolling: 382.5 units at the arrival pace (0.7 × 210 per 0.75s)');
  assert.equal(e.timers[e.timers.length - 1].ms, 956 + 450, 'the fallback timer follows the duration');

  // The same distance after a full visit (the van parked, then the picker reset it) is slower:
  // a pull-away from a standstill.
  const g = makeDom();
  g.scene.querySelector = (sel) => (sel === '.van' ? { tag: 'van' } : null);
  g.win.getComputedStyle = () => ({ transform: 'matrix(1, 0, 0, 1, 37.5, 0)' });
  initHeroVan(/** @type {any} */ (g.doc), /** @type {any} */ (g.win));
  g.pointer('pointerenter'); g.tick(1500); g.pointer('pointerleave');
  assert.equal(g.props['--hu-out-ms'], '1366ms', 'same distance, pull-away pace');
});

test('a click holds the end state while the modal it opened is up, and lets go when it closes', () => {
  const d = makeDom();
  initHeroVan(/** @type {any} */ (d.doc), /** @type {any} */ (d.win));
  d.pointer('pointerenter'); d.tick(300); d.pointer('click');
  assert.ok(d.classes.has('hu-hold'), 'the click pins the scene');
  assert.ok(!d.classes.has('hu-quick'), 'a quick click is still a full visit');
  d.modals['stage-modal'].classList.remove('hidden');   // the modal covers the button…
  d.pointer('pointerleave');                              // …so the pointer "leaves" it
  assert.ok(d.classes.has('hu-hold'), 'held while the modal is open');
  assert.ok(!d.classes.has('hu-quick'));
  d.modals['stage-modal'].classList.add('hidden');
  assert.ok(!d.classes.has('hu-hold'), 'released when the modal closes');
  assert.ok(d.classes.has('hu-out'), 'and the release is a leave: the van drives off');

  // The sign-in modal is the other thing a click can open.
  d.pointer('pointerenter'); d.pointer('click');
  d.modals['auth-modal'].classList.remove('hidden'); d.pointer('pointerleave');
  assert.ok(d.classes.has('hu-hold'));
  d.modals['auth-modal'].classList.add('hidden');
  assert.ok(!d.classes.has('hu-hold'));

  // A click that opened nothing (app.js failed to arrive) must not pin the scene forever.
  d.pointer('pointerenter'); d.pointer('click'); d.pointer('pointerleave');
  assert.ok(!d.classes.has('hu-hold'), 'no modal: the leave releases it');
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

test('index.html loads hero-van.js as a module tag right after hero-picker.js, with its art preloaded', () => {
  const html = read('public/index.html').replace(/<!--[\s\S]*?-->/g, '');
  const tags = [...html.matchAll(/<script type="module" src="scripts\/([\w-]+\.js)"><\/script>/g)].map((m) => m[1]);
  assert.equal(tags.indexOf('hero-van.js'), tags.indexOf('hero-picker.js') + 1, `module order: ${tags.slice(0, 3)}`);
  assert.match(html, /<link rel="modulepreload" href="scripts\/hero-van-art\.js">/);
  assert.doesNotMatch(read('public/scripts/index-deferred.js').replace(/\/\/.*$/gm, ''), /hero-van\.js/, 'must not ALSO be in the deferred list');
});

test('the CSS gate and the script gate are the same media condition', () => {
  const css = read('public/styles/hero-picker.css');
  const gates = css.match(/@media \(min-width: 769px\) and \(hover: hover\) and \(pointer: fine\)/g) || [];
  assert.ok(gates.length >= 1, 'hero-picker.css has no desktop gate for #hero-upload.hu');
  assert.equal(SCENE_MEDIA, '(min-width: 769px) and (hover: hover) and (pointer: fine)');
  assert.match(css, /#hero-upload\.hu \{/);
  assert.match(css, /#hero-upload\.hu\.hu-quick/);
  assert.match(css, /#hero-upload\.hu:is\(:hover, \.hu-hold\):not\(\.hu-out\) \.van/, 'the drive must key off the hold class as well as :hover, and wait out a drive-out');
  assert.doesNotMatch(css, /#hero-upload\.hu:is\(:hover, \.hu-hold\) /, 'every hover rule must be gated on :not(.hu-out)');
  assert.doesNotMatch(css, /#hero-upload\.hu:hover/, 'a bare :hover rule would not hold while the modal is up');
  assert.match(css, /#hero-upload\.hu\.hu-out \.van \{\s*animation: hu-drive-out/, 'the leave is the drive-out animation');
  assert.match(css, /@keyframes hu-drive-out \{\s*from \{ transform: translateX\(var\(--hu-van-x, 210px\)\); \}\s*to \{ transform: translateX\(420px\); \}/, 'drive-out: from wherever the van is, off the right edge');
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
