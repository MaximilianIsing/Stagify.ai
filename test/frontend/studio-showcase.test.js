// Tier: pure frontend logic + markup/i18n drift guards — public/scripts/studio-showcase.js.
//
// The showcase carousel folded four homepage sections into four panels of one widget.
// Two things about that are genuinely fragile, and this file exists for them:
//
//  1. THE PANEL IDS ARE REDIRECT TARGETS, not just anchors. ai-designer-gate.js and
//     ai-designer-app.js send signed-out / free / mobile visitors to
//     `index.html#ai-designer-demo`. Renaming the panel silently turns that redirect
//     into a no-op scroll — the visitor lands on the homepage showing whichever studio
//     happened to be first. The guard below reads the hash out of the REAL gate script
//     and asserts a panel still carries it, so the two cannot drift apart.
//
//  2. THE FRONT PANEL'S TRANSFORM MUST BE IDENTITY. The walkthrough player and the .ba
//     before/after slider both hit-test with getBoundingClientRect(), which reports
//     post-transform boxes. A scale(1.02) on the front panel would not look wrong — it
//     would just move every click inside it by a few pixels, which is the kind of bug
//     that gets blamed on the player.
//
// Plus a cross-pack check on the new keys: there is no general key-parity test in this
// repo (a key present only in english.json ships green), so each new namespace has to
// bring its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { offsetOf, geometryFor, indexForHash } from '../../public/scripts/studio-showcase.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

/** The four panels, in document order, as `{ id, tabIndexAttr, labelledBy }`. */
function panelsFromMarkup() {
  return [...INDEX.matchAll(/<article\b([^>]*\bclass="shw__panel"[^>]*)>/g)].map((m) => {
    const attrs = m[1];
    const pick = (/** @type {string} */ name) => (attrs.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];
    return { id: pick('id'), labelledBy: pick('aria-labelledby'), index: pick('data-shw-panel') };
  });
}

/** The tablist buttons, in document order. */
function tabsFromMarkup() {
  return [...INDEX.matchAll(/<button\b([^>]*\bclass="shw__tab[^"]*"[^>]*)>/g)].map((m) => {
    const attrs = m[1];
    const pick = (/** @type {string} */ name) => (attrs.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];
    return { id: pick('id'), controls: pick('aria-controls'), index: pick('data-shw-tab') };
  });
}

// --------------------------------------------------------------------------
// Ring maths
// --------------------------------------------------------------------------

test('offsetOf gives the shortest signed way round the ring', () => {
  // n=4, front = 0 → one neighbour each side and one panel parked at distance 2.
  assert.equal(offsetOf(0, 0, 4), 0);
  assert.equal(offsetOf(1, 0, 4), 1, 'next panel sits to the right');
  assert.equal(offsetOf(3, 0, 4), -1, 'last panel wraps to the LEFT, not to +3');
  assert.equal(offsetOf(2, 0, 4), 2, 'the opposite panel stays at distance 2');
});

test('offsetOf wraps from either end', () => {
  assert.equal(offsetOf(0, 3, 4), 1, 'first panel is one step past the last');
  assert.equal(offsetOf(3, 1, 4), 2);
  assert.equal(offsetOf(1, 3, 4), -2);
  // Never reports a distance longer than half the ring — that is the whole point.
  for (let active = 0; active < 4; active++) {
    for (let i = 0; i < 4; i++) {
      assert.ok(Math.abs(offsetOf(i, active, 4)) <= 2, `|offset| <= n/2 for i=${i} active=${active}`);
    }
  }
});

// --------------------------------------------------------------------------
// The transform ladder
// --------------------------------------------------------------------------

test('the front panel resolves to an IDENTITY transform', () => {
  const g = geometryFor(0, false);
  assert.equal(g.state, 'front');
  assert.equal(g.opacity, 1);
  // Every component is a no-op. If this ever gains a real translate/rotate/scale,
  // getBoundingClientRect() stops agreeing with what the user sees and the demo
  // player's hotspots and the exterior slider both start missing by that offset.
  assert.match(g.transform, /translate3d\(\s*0(px)?,\s*0(px)?,\s*0(px)?\s*\)/, 'no translation');
  assert.match(g.transform, /rotateY\(\s*0deg\s*\)/, 'no rotation');
  assert.match(g.transform, /scale\(\s*1\s*\)/, 'no scale');
});

/**
 * Pull the numbers out of a `translate3d(x%, 0, zpx) rotateY(rdeg) scale(s)` string.
 * Asserting the RELATIONSHIPS between these rather than the literal values, because
 * the exact magnitudes are look-and-feel and get tuned; what must not change is that
 * the two sides mirror each other and that depth goes the right way.
 */
function partsOf(transform) {
  const t = transform.match(/translate3d\(\s*(-?[\d.]+)%,\s*0,\s*(-?[\d.]+)px\)/);
  const r = transform.match(/rotateY\(\s*(-?[\d.]+)deg\)/);
  const s = transform.match(/scale\(\s*(-?[\d.]+)\)/);
  assert.ok(t && r && s, `unparseable transform: ${transform}`);
  return { x: Number(t[1]), z: Number(t[2]), ry: Number(r[1]), scale: Number(s[1]) };
}

test('neighbours mirror each other and lean back into the arc', () => {
  const right = partsOf(geometryFor(1, false).transform);
  const left = partsOf(geometryFor(-1, false).transform);
  const rMeta = geometryFor(1, false);
  const lMeta = geometryFor(-1, false);

  assert.equal(rMeta.state, 'side');
  assert.equal(lMeta.state, 'side');
  assert.ok(rMeta.opacity > 0 && rMeta.opacity < 1, 'a side panel is visible but dimmed');
  assert.equal(rMeta.opacity, lMeta.opacity, 'both sides are dimmed equally');
  assert.ok(rMeta.z < 3 && rMeta.z > 1, 'sits behind the front panel and above the hidden ones');

  assert.ok(right.x > 0, 'the next panel sits to the right');
  assert.equal(left.x, -right.x, 'the two sides are mirrored horizontally');
  // Rotated TOWARD the centre: a panel on the right turns its face back leftward.
  assert.ok(right.ry < 0, 'the right neighbour rotates negative');
  assert.equal(left.ry, -right.ry, 'the two sides are mirrored in rotation');
  assert.ok(right.z < 0 && left.z < 0, 'both are pushed away from the viewer');
  assert.equal(left.z, right.z, 'both sides sit at the same depth');
  assert.ok(right.scale <= 1, 'a side panel is never larger than the front one');
});

test('a hidden panel is further out and deeper than a side panel', () => {
  const side = partsOf(geometryFor(1, false).transform);
  const hidden = partsOf(geometryFor(2, false).transform);
  // Depth is ordered, so a panel cycling out keeps travelling the same direction
  // instead of jumping back toward the viewer on its way off.
  assert.ok(Math.abs(hidden.x) > Math.abs(side.x), 'hidden is further off-centre');
  assert.ok(hidden.z < side.z, 'hidden is deeper');
  assert.ok(hidden.scale <= side.scale, 'hidden is no larger than a side panel');
});

test('anything further than one step away is fully hidden', () => {
  for (const d of [2, -2, 3, -3]) {
    const g = geometryFor(d, false);
    assert.equal(g.state, 'hidden', `distance ${d} is hidden`);
    assert.equal(g.opacity, 0, `distance ${d} is transparent`);
  }
});

test('the flat (narrow) layout hides every panel but the front one', () => {
  assert.equal(geometryFor(0, true).state, 'front', 'the front panel is unaffected by flat mode');
  for (const d of [1, -1, 2, -2]) {
    assert.equal(geometryFor(d, true).state, 'hidden', `distance ${d} is hidden when flat`);
  }
});

// --------------------------------------------------------------------------
// Deep links
// --------------------------------------------------------------------------

test('indexForHash maps a fragment onto its panel', () => {
  const ids = ['ai-designer-demo', 'masking-studio-demo', 'exterior-studio-demo', 'gallery-showcase'];
  assert.equal(indexForHash(ids, '#ai-designer-demo'), 0);
  assert.equal(indexForHash(ids, '#gallery-showcase'), 3);
  assert.equal(indexForHash(ids, 'exterior-studio-demo'), 2, 'a bare id works too');
});

test('indexForHash reports -1 rather than defaulting to the first panel', () => {
  const ids = ['ai-designer-demo', 'masking-studio-demo'];
  // -1 and not 0: init() uses the distinction to leave the carousel on its default
  // panel for a normal visit, instead of treating every hashless load as a deep link.
  assert.equal(indexForHash(ids, ''), -1);
  assert.equal(indexForHash(ids, '#'), -1);
  assert.equal(indexForHash(ids, '#faq'), -1, 'a fragment belonging to another section');
});

// --------------------------------------------------------------------------
// Markup contract
// --------------------------------------------------------------------------

test('the homepage ships four panels carrying the four old section ids', () => {
  const panels = panelsFromMarkup();
  assert.deepEqual(
    panels.map((p) => p.id),
    ['ai-designer-demo', 'masking-studio-demo', 'exterior-studio-demo', 'gallery-showcase'],
    'panel ids, in order'
  );
});

test('the old standalone sections are gone, so each id appears exactly once', () => {
  for (const id of ['ai-designer-demo', 'masking-studio-demo', 'exterior-studio-demo', 'gallery-showcase']) {
    const hits = [...INDEX.matchAll(new RegExp(`\\bid="${id}"`, 'g'))].length;
    assert.equal(hits, 1, `id="${id}" is declared once (duplicate ids break getElementById)`);
  }
});

test('every tab is wired to its panel and back', () => {
  const panels = panelsFromMarkup();
  const tabs = tabsFromMarkup();
  assert.equal(tabs.length, panels.length, 'one tab per panel');
  tabs.forEach((tab, i) => {
    assert.equal(tab.controls, panels[i].id, `tab ${i} controls panel ${i}`);
    assert.equal(panels[i].labelledBy, tab.id, `panel ${i} is labelled by tab ${i}`);
    // studio-showcase.js indexes tabs and panels positionally; these attributes are
    // what a reader (and a screen reader) uses to check that pairing is right.
    assert.equal(tab.index, String(i), `tab ${i} carries data-shw-tab="${i}"`);
    assert.equal(panels[i].index, String(i), `panel ${i} carries data-shw-panel="${i}"`);
  });
});

test('the panels live inside the showcase root the script looks for', () => {
  const root = INDEX.indexOf('data-showcase');
  assert.ok(root > -1, 'index.html has a [data-showcase] root');
  const firstPanel = INDEX.indexOf('class="shw__panel"');
  const closingSection = INDEX.indexOf('</section>', root);
  assert.ok(firstPanel > root, 'panels come after the root opens');
  assert.ok(firstPanel < closingSection, 'panels are inside the showcase section');
});

// --------------------------------------------------------------------------
// The redirect coupling — the reason the ids may not be renamed
// --------------------------------------------------------------------------

test('every homepage fragment the gate scripts redirect to is a real panel', () => {
  const panelIds = panelsFromMarkup().map((p) => p.id);
  const sources = ['ai-designer-gate.js', 'ai-designer-app.js'].map((f) =>
    fs.readFileSync(path.join(ROOT, 'public', 'scripts', f), 'utf8')
  );
  const targets = new Set();
  for (const src of sources) {
    for (const m of src.matchAll(/index\.html#([\w-]+)/g)) targets.add(m[1]);
  }
  assert.ok(targets.size > 0, 'the gate scripts still redirect somewhere on the homepage');
  for (const id of targets) {
    assert.notEqual(
      indexForHash(panelIds, `#${id}`),
      -1,
      `the gate redirects to index.html#${id}, but no showcase panel has that id — ` +
        'the redirect would land on the homepage showing the wrong studio'
    );
  }
});

// --------------------------------------------------------------------------
// i18n
// --------------------------------------------------------------------------

test('home.showcase is complete in all eleven packs', () => {
  const dir = path.join(ROOT, 'public', 'languages');
  const packs = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(packs.length, 11, 'eleven language packs');

  const LEAVES = ['title', 'subtitle', 'tablistAria', 'prevAria', 'nextAria'];
  const TABS = ['designer', 'masking', 'exterior', 'gallery'];

  for (const file of packs) {
    const showcase = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).home?.showcase;
    assert.ok(showcase, `${file}: home.showcase is missing`);
    for (const key of LEAVES) {
      assert.equal(typeof showcase[key], 'string', `${file}: home.showcase.${key} is a string`);
      assert.ok(showcase[key].trim().length > 0, `${file}: home.showcase.${key} is not blank`);
    }
    for (const key of TABS) {
      const label = showcase.tabs?.[key];
      assert.equal(typeof label, 'string', `${file}: home.showcase.tabs.${key} is a string`);
      assert.ok(label.trim().length > 0, `${file}: home.showcase.tabs.${key} is not blank`);
    }
  }
});

test('the tab labels the markup asks for are the ones the packs define', () => {
  // The markup names its keys; the packs must answer to exactly those names. Catches a
  // rename on either side, which the English fallback would otherwise paper over.
  const asked = [...INDEX.matchAll(/data-lang="home\.showcase\.tabs\.(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(asked, ['designer', 'masking', 'exterior', 'gallery']);
  const english = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'public', 'languages', 'english.json'), 'utf8')
  );
  assert.deepEqual(Object.keys(english.home.showcase.tabs).sort(), [...asked].sort());
});
