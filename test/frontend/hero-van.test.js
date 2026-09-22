// Tier: frontend island logic (DOM-stubbed) + cross-file drift guards —
// public/scripts/hero-van.js and public/scripts/hero-van-art.js.
//
// On desktop, #hero-upload is a drawn night street: hero-van.js puts the SVG for the
// picker's furniture style inside the button and, when the style changes, grafts the new
// style's bands into the live scene beside the old ones (the "rolling road" swap); the
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

const { buildScene, initHeroVan, planSegment, speedAt, SCENE_MEDIA, STYLE_EVENT } = await import('../../public/scripts/hero-van.js');
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
    // The entrance is a nested <svg> built from a string with its own wrapper; a dangling
    // open tag there is invisible in a browser (the parser recovers) but re-parents in ours.
    const svgOpen = (svg.match(/<svg\b/g) || []).length;
    const svgClose = (svg.match(/<\/svg>/g) || []).length;
    assert.equal(svgOpen, svgClose, `${key}: <svg> ${svgOpen} vs </svg> ${svgClose}`);
    assert.doesNotMatch(svg, /\$\{|undefined|NaN/, `${key}: a template leaked into the markup`);
    // The moving parts the CSS keys off. Lose a class and that part simply stops moving.
    for (const cls of ['van', 'wheelspin', 'far', 'mid', 'near', 'home', 'ent', 'leaf', 'spill', 'lantern', 'lit', 'puff']) {
      assert.match(svg, new RegExp(`class="[^"]*\\b${cls}\\b`), `${key}: nothing carries .${cls}`);
    }
  }
});

test('every house has its own street lamp, and the lamp sits where the van and tree expect it', () => {
  const lamps = new Map();
  for (const { key, house } of STYLE_HOUSE) {
    const svg = buildScene(key, key);
    const m = /<g class="lamp" data-lamp="([a-z]+)">([\s\S]*?)<\/g>/.exec(svg);
    assert.ok(m, `${key}: no lamp`);
    assert.equal(m[1], house, `${key}: the lamp is drawn for its own house, not the fallback`);
    assert.match(m[2], /class="lamplit"/, `${key}: the lamp has a lit head`);
    lamps.set(m[1], m[2]);
    // Footprint: nothing left of the tree's crown (118 + 9) or into the van's parking bay (210).
    for (const [, sx] of m[2].matchAll(/\b(?:x|cx)="(-?[\d.]+)"/g)) {
      const v = parseFloat(sx);
      assert.ok(v >= 185 && v <= 214, `${key}: lamp part at x ${v} is outside the lamp's slot`);
    }
  }
  assert.equal(new Set(lamps.values()).size, STYLE_HOUSE.length, 'eight different lamps, not one drawn eight times');
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
    style: { setProperty: (k, v) => { props[k] = v; }, removeProperty: (k) => { delete props[k]; } },
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

/**
 * A fake of the SVG DOM the rolling-road swap touches, on top of makeDom(): the scene
 * span parses `innerHTML` into a tree of top-level <svg> children (a tag-depth scan of
 * the string, enough to tell `<g class="mid">…</g>` from its neighbours), and elements
 * support the graft's operations: `:scope > .x` lookups, classList, insertBefore,
 * nextSibling and remove(). `doc.createElement('div')` returns the same kind of holder.
 */
function makeSvgDom(opts) {
  const d = makeDom(opts);
  class El {
    constructor(tag, cls, html) {
      this.tag = tag;
      this.cls = new Set(cls ? cls.split(/\s+/).filter(Boolean) : []);
      this.html = html;
      /** @type {El[]} */ this.children = [];
      /** @type {El | null} */ this.parent = null;
      this.classList = { add: (c) => this.cls.add(c), remove: (c) => this.cls.delete(c), contains: (c) => this.cls.has(c) };
    }
    get nextSibling() { const p = this.parent; if (!p) return null; return p.children[p.children.indexOf(this) + 1] || null; }
    insertBefore(el, ref) {
      if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1);
      el.parent = this;
      const i = ref ? this.children.indexOf(ref) : this.children.length;
      this.children.splice(i < 0 ? this.children.length : i, 0, el);
      return el;
    }
    remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
    /** `svg`, `:scope > .cls`, or a plain `.cls` anywhere below (the van lookup). */
    querySelector(sel) {
      if (sel === 'svg') return this.children.find((c) => c.tag === 'svg') || null;
      const child = /^:scope > \.(\S+)$/.exec(sel);
      if (child) return this.children.find((c) => c.cls.has(child[1])) || null;
      const deep = /^\.(\S+)$/.exec(sel);
      if (deep) {
        for (const c of this.children) {
          if (c.cls.has(deep[1])) return c;
          const hit = c.querySelector(sel);
          if (hit) return hit;
        }
        return null;
      }
      throw new Error('fake DOM: selector not supported: ' + sel);
    }
    set innerHTML(markup) {
      this.children = [];
      const outer = /^<svg[^>]*>([\s\S]*)<\/svg>$/.exec(markup.trim());
      if (!outer) return;
      const svg = new El('svg', '', '');
      this.insertBefore(svg, null);
      // Split the svg's content into top-level elements by tag depth.
      const body = outer[1];
      const tagRe = /<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g;
      let depth = 0; let start = -1; let tag = ''; let cls = ''; let m;
      while ((m = tagRe.exec(body))) {
        const [whole, closing, name, attrs, selfClose] = m;
        if (!closing && depth === 0) { start = m.index; tag = name; cls = (/class="([^"]*)"/.exec(attrs) || [])[1] || ''; }
        if (!closing && !selfClose) depth += 1;
        if (closing) depth -= 1;
        if (depth === 0 && start >= 0) {
          svg.insertBefore(new El(tag, cls, body.slice(start, m.index + whole.length)), null);
          start = -1;
        }
      }
    }
    get innerHTML() { return this.children.map((c) => c.outerHTML).join(''); }
    get outerHTML() { return this.tag === 'svg' ? `<svg>${this.innerHTML}</svg>` : this.html; }
  }
  const scene = new El('span', 'hu-scene', '');
  d.btn.querySelector = (sel) => (sel === '.hu-scene' ? scene : null);
  d.doc.createElement = (tag) => new El(tag, '', '');
  const svg = () => scene.querySelector('svg');
  return {
    ...d,
    scene,
    svg,
    /** The classes of the scene's top-level bands, in order, e.g. "far skyline hu-leave". */
    bands: () => svg().children.map((c) => [...c.cls].join(' ')),
    house: (el) => (/data-k="([a-z]+)"/.exec(el.html) || [])[1],
  };
}

test('a style change on a mounted scene grafts the new bands in beside the old, keeping sky, road and van', () => {
  const d = makeSvgDom({ style: 'modern' });
  const ctl = initHeroVan(/** @type {any} */ (d.doc), /** @type {any} */ (d.win));
  const before = d.bands();
  assert.ok(before.includes('van') && before.filter((b) => b.includes('road')).length === 1, 'sanity: one road, one van');
  const sky = d.svg().children[1];

  d.fire(STYLE_EVENT, { style: 'farmhouse' });
  assert.equal(ctl.current(), 'farmhouse');
  assert.ok(d.classes.has('hu-swap'), 'the road rolls for the duration');
  const bands = d.bands();
  // Each swapped band is followed by its incoming twin; nothing else is duplicated.
  for (const cls of ['skyline', 'mid', 'home', 'props']) {
    const i = bands.findIndex((b) => b.split(' ').includes(cls) && b.includes('hu-leave'));
    assert.ok(i >= 0, `${cls}: the outgoing band carries .hu-leave`);
    assert.ok(bands[i + 1].split(' ').includes(cls) && bands[i + 1].includes('hu-in'), `${cls}: the incoming band sits right behind it with .hu-in`);
  }
  assert.equal(bands.filter((b) => b === 'van').length, 1, 'the van is the same element, not rebuilt');
  assert.equal(bands.filter((b) => b.includes('road')).length, 1, 'one road');
  assert.equal(d.svg().children[1], sky, 'the sky is untouched');
  const homes = d.svg().children.filter((c) => c.cls.has('home'));
  assert.deepEqual(homes.map(d.house), ['modern', 'farmhouse'], 'old house leaving, new house arriving');
  assert.equal(d.bands().filter((b) => b.split(' ').includes('far') && !b.includes('skyline')).length, 1, 'the stars are not swapped');

  // The home's slide-in ending ends the swap: old bands gone, new ones settled, road still.
  d.pointer('animationend', { animationName: 'hu-mid-in' });
  assert.ok(d.classes.has('hu-swap'), 'the mid finishing is not the end');
  d.pointer('animationend', { animationName: 'hu-home-in' });
  assert.ok(!d.classes.has('hu-swap'));
  const after = d.bands();
  assert.equal(after.length, before.length, 'back to one band of each');
  assert.ok(!after.some((b) => /hu-(in|leave)/.test(b)), 'no swap classes left behind');
  assert.deepEqual(d.svg().children.filter((c) => c.cls.has('home')).map(d.house), ['farmhouse']);
});

test('a style change mid-swap finishes the running swap first; the fallback timer ends a swap with no animationend', () => {
  const d = makeSvgDom({ style: 'modern' });
  initHeroVan(/** @type {any} */ (d.doc), /** @type {any} */ (d.win));
  d.fire(STYLE_EVENT, { style: 'luxury' });
  d.fire(STYLE_EVENT, { style: 'modern' });
  const homes = d.svg().children.filter((c) => c.cls.has('home'));
  assert.deepEqual(homes.map(d.house), ['georgian', 'modern'], 'the interrupted swap settled on luxury, which now leaves');
  assert.equal(homes[0].cls.has('hu-leave'), true);
  assert.equal(d.bands().filter((b) => b.includes('home')).length, 2, 'never three houses');

  const t = d.timers[d.timers.length - 1];
  assert.equal(t.ms, 950 + 150, 'the CSS duration plus a margin');
  t.fn();
  assert.ok(!d.classes.has('hu-swap'));
  assert.deepEqual(d.svg().children.filter((c) => c.cls.has('home')).map(d.house), ['modern']);
});

test('under prefers-reduced-motion a style change is a plain rebuild', () => {
  const d = makeSvgDom({ style: 'modern' });
  const inner = d.win.matchMedia;
  d.win.matchMedia = (q) => (q === '(prefers-reduced-motion: reduce)' ? { matches: true } : inner(q));
  initHeroVan(/** @type {any} */ (d.doc), /** @type {any} */ (d.win));
  d.fire(STYLE_EVENT, { style: 'coastal' });
  assert.ok(!d.classes.has('hu-swap'));
  assert.deepEqual(d.svg().children.filter((c) => c.cls.has('home')).map(d.house), ['mediterranean']);
  assert.ok(!d.bands().some((b) => /hu-(in|leave)/.test(b)));
});

test('the swap hooks agree across the art, the script and the CSS', () => {
  const css = read('public/styles/hero-picker.css');
  for (const { key } of STYLE_HOUSE) {
    const svg = buildScene(key, key);
    for (const cls of ['skyline', 'props', 'road', 'road-dash']) {
      assert.match(svg, new RegExp(`class="[^"]*\\b${cls}\\b`), `${key}: nothing carries .${cls}`);
    }
    assert.equal((svg.match(/class="[^"]*\bskyline\b/g) || []).length, 1, `${key}: exactly one skyline`);
    assert.match(svg, /<path class="road-dash" d="M-2 70h380"[^>]*stroke-dasharray="6 8"/, `${key}: the dash roll below is 27 periods of 14, over a path that runs past both edges`);
  }
  assert.match(css, /#hero-upload\.hu \.home\.hu-in \{ animation: hu-home-in /, 'the swap ends on the home slide-in animation, by name');
  assert.match(css, /#hero-upload\.hu \.props\.hu-in \{ animation: hu-home-in /, 'the lamp and tree ride the road at the home’s speed, not a crossfade');
  assert.match(css, /#hero-upload\.hu \.skyline\.hu-in \{ animation: hu-band-in /, 'only the skyline crossfades');
  assert.match(css, /#hero-upload\.hu\.hu-swap \.road-dash \{ animation: hu-road-roll /);
  assert.match(css, /@keyframes hu-road-roll \{\s*from \{ stroke-dashoffset: 0; \}\s*to \{ stroke-dashoffset: 378; \}/);
  assert.match(css, /--hu-swap-ms: 0\.95s;/, 'hero-van.js SWAP_MS mirrors this');
  assert.match(css, /#hero-upload\.hu:is\(:hover, \.hu-hold\):not\(\.hu-out\) \.home \{ --hu-pan: -8px; \}/, 'the pan is the custom property the slide-in keyframes end on');
  assert.match(css, /@keyframes hu-home-in \{\s*from \{ transform: translateX\(calc\(var\(--hu-pan, 0px\) \+ 378px\)\); \}\s*to \{ transform: translateX\(var\(--hu-pan, 0px\)\); \}/);
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
  initHeroVan(/** @type {any} */ (d.doc), /** @type {any} */ (d.win));
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
  assert.equal(t.ms, parseInt(d.props['--hu-out-ms'], 10) + 450, 'wait + drive + margin');
  t.fn();
  assert.ok(!d.classes.has('hu-out'), 'fallback timer released it');

});

test('a style change mid-drive-out keeps the van: the drive-out carries on and ends on its own', () => {
  const d = makeSvgDom();
  const ctl = initHeroVan(/** @type {any} */ (d.doc), /** @type {any} */ (d.win));
  d.pointer('pointerenter'); d.tick(2000); d.pointer('pointerleave');
  assert.ok(d.classes.has('hu-out'));
  const van = d.svg().children.find((c) => c.cls.has('van'));
  d.fire(STYLE_EVENT, { style: 'coastal' });
  assert.equal(ctl.current(), 'coastal');
  assert.ok(d.classes.has('hu-out'), 'the swap grafts houses; the van and its drive-out are untouched');
  assert.equal(d.svg().children.find((c) => c.cls.has('van')), van, 'same van element');
  d.pointer('animationend', { animationName: 'hu-home-in' });
  assert.ok(d.classes.has('hu-out'), 'the swap ending is not the drive-out ending');
  d.pointer('animationend', { animationName: 'hu-drive-out' });
  assert.ok(!d.classes.has('hu-out'));
});

test('the drive-out starts from where the van is, falling back to the parking bay', () => {
  const d = makeDom();
  initHeroVan(/** @type {any} */ (d.doc), /** @type {any} */ (d.win));
  d.pointer('pointerenter'); d.tick(1500); d.pointer('pointerleave');
  assert.equal(d.props['--hu-van-x'], '210px', 'no computed style available: parked');
  assert.equal(d.props['--hu-out-ms'], '850ms', 'the parked drive-out is the reference speed');

  const e = makeDom();
  e.scene.querySelector = (sel) => (sel === '.van' ? { tag: 'van' } : null);
  e.win.getComputedStyle = () => ({ transform: 'matrix(1, 0, 0, 1, 37.5, 0)' });
  initHeroVan(/** @type {any} */ (e.doc), /** @type {any} */ (e.win));
  e.pointer('pointerenter'); e.tick(200); e.pointer('pointerleave');
  assert.equal(e.props['--hu-van-x'], '37.5px', 'mid-arrival: keep going from here');
  // Rolling: planned from the drive-in's speed at x 37.5 (about 640 u/s, near its peak)
  // down to the cruise of 250, so 382.5 units at a mean of ~445 is ~0.86s.
  const v0 = speedAt({ from: -150, to: 210, ms: 1250, x1: 0.32, y1: 0.06, x2: 0.2, y2: 1 }, 37.5);
  assert.ok(v0 > 550 && v0 < 720, `drive-in speed at its middle: ${v0}`);
  const ms = parseInt(e.props['--hu-out-ms'], 10);
  assert.ok(ms > 780 && ms < 950, `rolling exit duration: ${ms}`);
  assert.ok(Math.abs(speedAt(planSegment(37.5, 420, v0, 250, 2.2), 420) - 250) < 1, 'settles to the cruise');
  assert.match(e.props['--hu-out-ease'], /^cubic-bezier\(0\.350, 0\.\d{3}, 0\.650, 0\.\d{3}\)$/);
  assert.equal(e.timers[e.timers.length - 1].ms, ms + 450, 'the fallback timer follows the duration');
  // The wheel angle carries over from the drive-in: 187.5 units in, 1452° → 12° into a turn.
  const DEG = 360 / (2 * Math.PI * 7.4);
  assert.ok(Math.abs(parseFloat(e.props['--hu-spin-from']) - (187.5 * DEG) % 360) < 0.2, 'spin picks up where the drive-in had it');
  assert.ok(Math.abs(parseFloat(e.props['--hu-spin-to']) - parseFloat(e.props['--hu-spin-from']) - 382.5 * DEG) < 0.2, 'and turns by the exit distance');

  // The same distance after a full visit (the van parked, then the picker reset it) is slower:
  // a pull-away from a standstill.
  const g = makeDom();
  g.scene.querySelector = (sel) => (sel === '.van' ? { tag: 'van' } : null);
  g.win.getComputedStyle = () => ({ transform: 'matrix(1, 0, 0, 1, 37.5, 0)' });
  initHeroVan(/** @type {any} */ (g.doc), /** @type {any} */ (g.win));
  g.pointer('pointerenter'); g.tick(1500); g.pointer('pointerleave');
  assert.equal(g.props['--hu-out-ms'], '1548ms', 'same distance, pull-away pace');
  assert.equal(g.props['--hu-out-ease'], undefined, 'the pull-away keeps its CSS curve');
});

test('speedAt and planSegment: speed is continuous across a join', () => {
  const din = { from: -150, to: 210, ms: 1250, x1: 0.32, y1: 0.06, x2: 0.2, y2: 1 };
  assert.ok(speedAt(din, -150) > 40 && speedAt(din, -150) < 70, 'sets off slowly (initial slope 0.06/0.32)');
  assert.ok(speedAt(din, 40) > speedAt(din, -150), 'faster mid-drive');
  assert.equal(Math.round(speedAt(din, 210)), 0, 'eases to a stop at the bay');

  const out = planSegment(40, 420, 500, 500, 2.2);
  assert.equal(out.from, 40); assert.equal(out.to, 420);
  assert.equal(out.ms, 760, '380 units at 500 u/s');
  assert.ok(Math.abs(speedAt(out, 40) - 500) < 1, `starts at the speed it was given: ${speedAt(out, 40)}`);

  const parkSeg = planSegment(100, 210, 450, 0, 1.4);
  assert.ok(Math.abs(speedAt(parkSeg, 100) - 450) < 1, 'park starts at the current speed');
  assert.equal(Math.round(speedAt(parkSeg, 210)), 0, 'and ends at rest');
  assert.equal(parkSeg.y2, 1, 'ease-out end');

  const crawl = planSegment(-149, 420, 55, 480, 2.2);
  assert.equal(crawl.ms, 2127, '569 units at a mean of 267.5');
  const still = planSegment(210, 420, 0, 480, 2.2);
  assert.equal(still.y1, 0, 'from a standstill the curve starts flat');
});

test('a hover before the van has passed the door cuts the exit and parks from there', () => {
  const d = makeDom();
  let x = 60;
  d.scene.querySelector = (sel) => (sel === '.van' ? { tag: 'van' } : null);
  d.win.getComputedStyle = () => ({ transform: `matrix(1, 0, 0, 1, ${x}, 0)` });
  initHeroVan(/** @type {any} */ (d.doc), /** @type {any} */ (d.win));
  d.pointer('pointerenter'); d.tick(300); d.pointer('pointerleave');
  assert.ok(d.classes.has('hu-out') && d.classes.has('hu-quick'));
  x = 120;
  d.pointer('pointerenter');
  assert.ok(d.classes.has('hu-park'), 'short of the door: park');
  assert.ok(!d.classes.has('hu-out') && !d.classes.has('hu-quick'), 'the exit is cut');
  assert.equal(d.props['--hu-van-x'], '120px');
  const ms = parseInt(d.props['--hu-out-ms'], 10);
  assert.ok(ms >= 300 && ms <= 1400, `park duration ${ms}`);
  assert.match(d.props['--hu-out-ease'], /, 1\.000\)$/, 'ends at rest');
  // Wheels: the park turns them by its distance (90 units → 697°), from the angle they had.
  const DEG = 360 / (2 * Math.PI * 7.4);
  const from = parseFloat(d.props['--hu-spin-from']);
  const to = parseFloat(d.props['--hu-spin-to']);
  assert.ok(Math.abs(to - from - 90 * DEG) < 0.2, `park spin ${to - from} for 90 units`);
  assert.ok(from >= 0 && from < 360, 'start angle is kept within one turn');
  // The next leave is an ordinary one, from wherever the park segment has the van.
  x = 210; d.tick(2000); d.pointer('pointerleave');
  assert.ok(!d.classes.has('hu-park') && d.classes.has('hu-out'));
  assert.equal(d.props['--hu-out-ms'], '850ms', 'parked, full visit: the pull-away');

  // Past the door: no retarget, the van finishes leaving and a new one arrives.
  d.pointer('animationend', { animationName: 'hu-drive-out' });
  d.pointer('pointerenter'); d.tick(300); d.pointer('pointerleave');
  x = 260;
  d.pointer('pointerenter');
  assert.ok(!d.classes.has('hu-park') && d.classes.has('hu-out'), 'past the door: let it go');
});

test('a hover back while the van is still in the bay cancels the leave and reopens the door', () => {
  const d = makeDom();
  let x = 210;
  d.scene.querySelector = (sel) => (sel === '.van' ? { tag: 'van' } : null);
  d.win.getComputedStyle = () => ({ transform: `matrix(1, 0, 0, 1, ${x}, 0)` });
  initHeroVan(/** @type {any} */ (d.doc), /** @type {any} */ (d.win));
  d.pointer('pointerenter'); d.tick(2000); d.pointer('pointerleave');
  assert.ok(d.classes.has('hu-out') && !d.classes.has('hu-quick'), 'full visit: the ordered leave');

  // Back within the wait: the van has not moved.
  d.tick(100); d.pointer('pointerenter');
  assert.ok(!d.classes.has('hu-out'), 'the leave is cancelled');
  assert.ok(d.classes.has('hu-park'), 'the van holds the bay (no drive-in from the left)');
  assert.ok(d.classes.has('hu-reopen'), 'the door reopens without the arrival delays');
  assert.equal(d.props['--hu-van-x'], '210px');
  assert.equal(d.props['--hu-out-ms'], '0ms', 'a zero-length park');
  assert.equal(d.props['--hu-out-ease'], undefined);
  const from = parseFloat(d.props['--hu-spin-from']);
  const to = parseFloat(d.props['--hu-spin-to']);
  assert.equal(from, to, 'the wheels hold their angle');
  const DEG = 360 / (2 * Math.PI * 7.4);
  assert.ok(Math.abs(from - ((360 * DEG) % 360)) < 0.2, 'the angle the drive-in left them at');

  // A leave soon after is still a FULL visit: the door was open the whole time.
  d.tick(200); d.pointer('pointerleave');
  assert.ok(d.classes.has('hu-out') && !d.classes.has('hu-quick'), 'ordered leave, not quick');
  assert.ok(!d.classes.has('hu-park') && !d.classes.has('hu-reopen'), 'both go with the leave');
  assert.equal(d.props['--hu-out-ms'], '850ms', 'the pull-away from a standstill');
  assert.ok(Math.abs(parseFloat(d.props['--hu-spin-from']) - from) < 0.2, 'the pull-away spins on from the held angle, no snap');

  // Stay again, and again: the angle survives every round.
  d.tick(100); d.pointer('pointerenter');
  assert.ok(d.classes.has('hu-park') && Math.abs(parseFloat(d.props['--hu-spin-from']) - from) < 0.2);
  d.pointer('pointerleave');
  assert.ok(Math.abs(parseFloat(d.props['--hu-spin-from']) - from) < 0.2);

  // Once the van has left the bay the existing rules apply: park from short of the door.
  x = 230; d.pointer('animationend', { animationName: 'hu-drive-out' });
  d.pointer('pointerenter'); d.tick(300); d.pointer('pointerleave');
  x = 150; d.pointer('pointerenter');
  assert.ok(d.classes.has('hu-park') && !d.classes.has('hu-reopen'), 'a real park is not a reopen');
});

test('a rolling exit passing through the bay is not a stay, and a stay makes any later leave ordered', () => {
  const d = makeDom();
  let x = 120;
  d.scene.querySelector = (sel) => (sel === '.van' ? { tag: 'van' } : null);
  d.win.getComputedStyle = () => ({ transform: `matrix(1, 0, 0, 1, ${x}, 0)` });
  initHeroVan(/** @type {any} */ (d.doc), /** @type {any} */ (d.win));
  // Quick leave mid-arrival: the van rolls on and off, through x 210.
  d.pointer('pointerenter'); d.tick(500); d.pointer('pointerleave');
  assert.ok(d.classes.has('hu-out') && d.classes.has('hu-quick'));
  x = 210.1; d.pointer('pointerenter');
  assert.ok(d.classes.has('hu-out') && !d.classes.has('hu-park') && !d.classes.has('hu-reopen'), 'at the bay but moving: let it go');
  d.pointer('pointerleave'); d.pointer('animationend', { animationName: 'hu-drive-out' });

  // A full visit whose pull-away is stayed 1.1s after the first arrival: the leave 100ms
  // later would be "quick" by the original clock, but the door was open, so it is ordered.
  x = 210; d.pointer('pointerenter'); d.tick(1100); d.pointer('pointerleave');
  assert.ok(!d.classes.has('hu-quick'));
  d.tick(50); d.pointer('pointerenter');
  assert.ok(d.classes.has('hu-park') && d.classes.has('hu-reopen'));
  d.tick(50); d.pointer('pointerleave');
  assert.ok(d.classes.has('hu-out') && !d.classes.has('hu-quick'), 'never quick after a stay');
  assert.equal(d.props['--hu-out-ms'], '850ms');
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
  assert.match(css, /#hero-upload\.hu\.hu-reopen:is\(:hover, \.hu-hold\):not\(\.hu-out\) \.ent \.leaf,[\s\S]*?\{\s*transition-delay: 0s;/, 'the reopen must outrank the hover rule that delays the door by 1s');
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
