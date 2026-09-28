// Tier: drift guard — the hero picker's menu glyphs, and the rules they are drawn to.
//
// WHY A SOURCE-LEVEL GUARD. The glyphs replaced the 46 by 31 render crop each menu row used
// to carry, and they live in three places that have to agree: the ROOMS/STYLES tables in
// scripts/home/hero-picker.js name the keys, the sprite in index.html draws one symbol per key,
// and rowFor() joins them with `<use href="#hp-ico-<key>">`. Nothing in the browser complains
// when they stop agreeing. A `<use>` pointing at a symbol that does not exist renders NOTHING,
// silently — no console error, no broken-image glyph, no layout shift, because the tile is
// sized by CSS. So adding a room type would ship a menu with one empty blue square in it and
// every existing test would still pass.
//
// The second half of the file is the art direction. Those rules are written out at length in
// the sprite's own comment; they are checked here because an icon set decays one well-meaning
// exception at a time, and every one of them is invisible in a diff: a second viewBox, a fill
// on an open path, a stroke that is 1.2 in the new one and 1.7 in the other thirteen, a room
// added without a halo colour so its blob falls back to the generic wash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const INDEX = read('public/index.html');
const JS = read('public/scripts/home/hero-picker.js');
const CSS = read('public/styles/hero-picker.css');

/** Source with comments stripped, so prose describing a rule never satisfies a check for it. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const JS_CODE = code(JS);
const CSS_CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const INDEX_CODE = INDEX.replace(/<!--[\s\S]*?-->/g, '');

/** The `key:` values of one table in hero-picker.js, in source order. */
function keysOf(table) {
  const block = new RegExp(`const ${table} = \\[([\\s\\S]*?)\\n\\];`).exec(JS_CODE);
  assert.ok(block, `scripts/home/hero-picker.js no longer declares a ${table} table`);
  const keys = [...block[1].matchAll(/\bkey:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(keys.length > 0, `${table} parsed to zero entries — the regex above has rotted`);
  return keys;
}

const PICKER_KEYS = [...keysOf('ROOMS'), ...keysOf('STYLES')];

/** Every `<symbol id="hp-ico-…">` in index.html, as { key: openingTag + body }. */
const SYMBOLS = Object.fromEntries(
  [...INDEX_CODE.matchAll(/<symbol id="hp-ico-([^"]+)"([^>]*)>([\s\S]*?)<\/symbol>/g)]
    .map((m) => [m[1], { attrs: m[2], body: m[3] }]),
);

test('every room and style the picker offers has a glyph, and nothing else does', () => {
  // Set equality in both directions. A missing symbol renders an empty tile; a leftover one
  // is dead weight in the document every visitor downloads.
  assert.deepEqual(
    Object.keys(SYMBOLS).sort(),
    [...PICKER_KEYS].sort(),
    'the hp-ico-* sprite in public/index.html and the ROOMS/STYLES tables in '
    + 'scripts/home/hero-picker.js have drifted apart',
  );
});

test('the rows reference the sprite by the table key, not by a second hand-written list', () => {
  // The `use` href has to be built from the item, or the two lists are free to drift and the
  // test above stops meaning anything.
  assert.match(
    JS_CODE,
    /use\.setAttribute\('href',\s*`#hp-ico-\$\{item\.key\}`\)/,
    'rowFor() no longer derives the symbol id from the ROOMS/STYLES key',
  );
  // createElement('svg') yields an HTMLUnknownElement that renders nothing at all. This has
  // bitten enough people that it is worth pinning rather than rediscovering.
  assert.match(JS_CODE, /createElementNS\(SVG_NS, 'svg'\)/, 'the glyph must be built in the SVG namespace');
  assert.match(JS_CODE, /const SVG_NS = 'http:\/\/www\.w3\.org\/2000\/svg'/, 'SVG_NS went missing');
});

test('the thumbnail crop is gone from every layer', () => {
  // It was an <img> per row, a 900w candidate per open, and a CSS rule. Leaving any one of
  // them behind is how a "removed" feature half-ships.
  assert.doesNotMatch(JS_CODE, /hp-menu__thumb/, 'scripts/home/hero-picker.js still builds a menu thumbnail');
  assert.doesNotMatch(CSS_CODE, /\.hp-menu__thumb\b/, 'styles/hero-picker.css still styles a menu thumbnail');
  assert.doesNotMatch(
    JS_CODE, /rowFor\([^)]*-900\.webp/,
    'a menu row is still being handed a render URL',
  );
});

test('the glyph is hidden from assistive tech and takes no tab stop', () => {
  // The row's own text is its accessible name. A second, wordless node beside it announces as
  // nothing useful, and a focusable SVG inside a button is a tab stop that goes nowhere.
  assert.match(JS_CODE, /svg\.setAttribute\('aria-hidden', 'true'\)/, 'the glyph lost aria-hidden');
  assert.match(JS_CODE, /svg\.setAttribute\('focusable', 'false'\)/, 'the glyph lost focusable="false"');
  assert.match(
    INDEX_CODE, /<svg class="hp-icon-sprite"[^>]*aria-hidden="true"/,
    'the sprite itself must stay out of the accessibility tree',
  );
});

test('the sprite is taken out of layout by the stylesheet', () => {
  // width="0" height="0" is not enough on its own: the element still takes a line box on some
  // engines, which shows as a stray gap between the hero and the sponsor strip.
  assert.match(CSS_CODE, /\.hp-icon-sprite\s*\{[^}]*display:\s*none/, '.hp-icon-sprite is no longer display: none');
});

test('every glyph is a scene, not a pictogram', () => {
  // The first draft of this set was three shapes per glyph and read as "bed", "sofa", and
  // nothing more, which is what the word beside it already says. Seven is the floor at which
  // the room glyphs carry a second object (the pendant over the dining table, the mug on the
  // desk) and the style glyphs carry the signature accessory. Drop below it and the redraw
  // has quietly reverted.
  for (const [key, { body }] of Object.entries(SYMBOLS)) {
    const shapes = (body.match(/<(rect|circle|path|line|ellipse)\b/g) || []).length;
    assert.ok(shapes >= 7, `hp-ico-${key} is down to ${shapes} shapes — this set is drawn as scenes, not pictograms`);
  }
  // No square-cornered rectangles: they turn a drawing into a wireframe.
  for (const [key, { body }] of Object.entries(SYMBOLS)) {
    for (const rect of body.match(/<rect[^>]*>/g) || []) {
      assert.match(rect, /\brx="/, `hp-ico-${key} has a rect with no rx`);
    }
  }
});

test('the set is one viewBox, one stroke weight, ink from CSS and colour from the sprite', () => {
  for (const [key, { attrs, body }] of Object.entries(SYMBOLS)) {
    // Mixed viewBoxes are how an icon set drifts in optical weight: the same stroke number is
    // a different thickness in each one.
    assert.match(attrs, /viewBox="0 0 32 32"/, `hp-ico-${key} is not drawn in the 32 by 32 box`);
    // Weight lives on the symbol, next to the geometry it applies to, and is the same number
    // for all fourteen.
    assert.match(attrs, /stroke-width="1\.7"/, `hp-ico-${key} does not carry the set's 1.7 stroke`);
    // Ink is one colour for the whole set and it comes from the stylesheet. A hardcoded stroke
    // on one shape is the one glyph that stops matching when --fg is retuned.
    assert.doesNotMatch(body, /\bstroke="/, `hp-ico-${key} hardcodes a stroke colour`);
    assert.ok(body.trim().length > 0, `hp-ico-${key} is an empty symbol`);

    // Colour is baked into the drawing: every closed shape carries its material fill (or plain
    // white), and no open path does. A fill on an open path paints a sliver between its two
    // ends; a closed shape without one is a hole in the sticker that shows the halo through it.
    for (const shape of body.match(/<(rect|circle|path)[^>]*>/g) || []) {
      const isPath = shape.startsWith('<path');
      const d = /\bd="([^"]*)"/.exec(shape);
      const closed = !isPath || /z\s*$/i.test(d ? d[1] : '');
      const filled = /\bfill="#[0-9a-f]{6}"/i.test(shape);
      if (closed) assert.ok(filled, `hp-ico-${key}: a closed shape has no fill — ${shape}`);
      else assert.ok(!filled, `hp-ico-${key}: an open path carries a fill — ${shape}`);
      assert.doesNotMatch(shape, /\bfill="none"/, `hp-ico-${key}: fill="none" on a shape is dead weight`);
    }
  }
});

test('no glyph crosses the 2-unit margin', () => {
  // The tile is 42px with an 11px radius and the glyph sits centred in it, so art that reaches
  // the edge of the viewBox collides with that corner visually even though it never overlaps
  // it. Coordinates are read off the primitives rather than off the path data: `rect`/`circle`
  // are the shapes most likely to be nudged outward by hand, and a path's numbers include
  // relative deltas that are not positions at all.
  const LO = 2;
  const HI = 30;
  const num = (tag, attr) => {
    const m = new RegExp(`${attr}="(-?[\\d.]+)"`).exec(tag);
    return m ? parseFloat(m[1]) : null;
  };
  for (const [key, { body }] of Object.entries(SYMBOLS)) {
    for (const rect of body.match(/<rect[^>]*>/g) || []) {
      const [x, y, w, h] = ['x', 'y', 'width', 'height'].map((a) => num(rect, a));
      assert.ok(x >= LO && y >= LO, `hp-ico-${key}: a rect starts inside the margin at ${x},${y}`);
      assert.ok(
        x + w <= HI && y + h <= HI,
        `hp-ico-${key}: a rect ends at ${x + w},${y + h}, past the ${HI} margin`,
      );
    }
    for (const circle of body.match(/<circle[^>]*>/g) || []) {
      const [cx, cy, r] = ['cx', 'cy', 'r'].map((a) => num(circle, a));
      assert.ok(
        cx - r >= LO && cy - r >= LO && cx + r <= HI && cy + r <= HI,
        `hp-ico-${key}: a circle at ${cx},${cy} r${r} reaches past the margin`,
      );
    }
  }
});

test('every row is a sticker on a halo, and the halo is coloured per key', () => {
  // The row is three layers: the tile span (row height), its ::before (the halo blob) and the
  // svg (the sticker). rowFor() has to build all three and expose the key the halo is coloured
  // by, or the stylesheet below is styling nothing.
  assert.match(JS_CODE, /tile\.className = 'hp-menu__tile'/, 'rowFor() no longer builds the tile span');
  assert.match(JS_CODE, /btn\.dataset\.key = item\.key/, 'rowFor() no longer exposes the key the halo is keyed by');
  assert.match(JS_CODE, /tile\.appendChild\(svg\)/, 'the sticker is no longer inside the tile');
  assert.match(CSS_CODE, /\.hp-menu__tile::before\s*\{[^}]*background:\s*var\(--hp-halo/, 'the halo lost its colour hook');

  // One halo colour per picker key, no more, no fewer. A key without a rule falls back to the
  // generic wash silently; a rule for a key that is gone is dead CSS on every page.
  const haloKeys = [...CSS_CODE.matchAll(/\.hp-menu__item\[data-key="([^"]+)"\]\s*\{[^}]*--hp-halo:/g)].map((m) => m[1]);
  assert.deepEqual(haloKeys.sort(), [...PICKER_KEYS].sort(), 'the --hp-halo rules and the picker keys have drifted apart');
});

test('the sticker has its cut edge, and the peel is gated on reduced motion', () => {
  // The white die-cut edge is the stacked drop-shadows; it is what separates the sticker from
  // the navy selected row, since fixed fills cannot invert the way a line glyph could.
  const icon = /\.hp-menu__icon\s*\{([^}]*)\}/.exec(CSS_CODE);
  assert.ok(icon, '.hp-menu__icon rule is gone');
  assert.ok((icon[1].match(/drop-shadow\(/g) || []).length >= 3, 'the sticker lost its die-cut edge');
  assert.match(icon[1], /overflow:\s*visible/, 'without overflow: visible the edge and the lift are clipped');
  assert.match(icon[1], /stroke:\s*var\(--fg\)/, 'ink is no longer the shared --fg token');
  assert.doesNotMatch(icon[1], /stroke-width/, 'stroke-width belongs on the symbols, not here (two numbers drift)');

  // The peel: hover lifts, selected keeps a resting tilt, and reduced-motion turns the lift off
  // while leaving the blob and the tilt alone.
  assert.match(CSS_CODE, /\.hp-menu__item:hover \.hp-menu__icon\s*\{[^}]*transform:\s*rotate\(/, 'the hover peel is gone');
  assert.match(CSS_CODE, /\.hp-menu__item\[aria-selected="true"\] \.hp-menu__icon\s*\{[^}]*transform:\s*rotate\(/, 'the selected row lost its resting tilt');
  const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(CSS_CODE);
  assert.ok(reduced, 'no prefers-reduced-motion block for the peel');
  assert.match(reduced[1], /\.hp-menu__item:hover \.hp-menu__icon\s*\{[^}]*transform:\s*none/, 'the peel is not switched off for reduced motion');
});
