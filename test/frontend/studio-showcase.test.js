// Tier: pure frontend logic + markup/i18n drift guards — public/scripts/studio-showcase.js.
//
// The showcase carousel folded four homepage sections into panels of one widget (five
// now, since the main staging flow was added at the front).
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

import { offsetOf, geometryFor, indexForHash, stageHeightFor } from '../../public/scripts/studio-showcase.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

/**
 * The panels, in document order, as `{ id, labelledBy, index }`.
 *
 * They are plain <div>s ON PURPOSE: studio-showcase.js puts role="tabpanel" on them at
 * runtime, and `tabpanel` is not an allowed role on <article> (its implicit `article`
 * role only permits document/feed/main/region/none/presentation/application), which
 * Lighthouse flags as a malformed accessibility tree. A <div> has no implicit role, so
 * the applied one is legal. Do not turn these back into <article>s.
 */
function panelsFromMarkup() {
  return [...INDEX.matchAll(/<div\b([^>]*\bclass="shw__panel"[^>]*)>/g)].map((m) => {
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

/**
 * One panel's markup, sliced out of index.html.
 *
 * Bounded by the NEXT panel (or the end of the showcase section for the last one)
 * rather than by a closing tag: the panels are <div>s, so `</div>` says nothing about
 * where one ends. See the note on panelsFromMarkup for why they are not <article>s.
 *
 * @param {string} id
 * @returns {string}
 */
function panelMarkup(id) {
  const start = INDEX.indexOf(`id="${id}"`);
  const next = INDEX.indexOf('class="shw__panel"', start);
  const end = next === -1 ? INDEX.indexOf('</section>', start) : next;
  return INDEX.slice(start, end === -1 ? INDEX.length : end);
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

test('the shipped odd ring (n=5) still gives one neighbour per side', () => {
  // The staging panel made the ring ODD, which is the case the n=4 assertions above
  // cannot exercise: with n=5 the wrap threshold falls between two integers, so a
  // panel is either a side (|d|=1) or hidden (|d|=2) and never lands exactly on n/2.
  for (let active = 0; active < 5; active++) {
    const dists = [0, 1, 2, 3, 4].map((i) => offsetOf(i, active, 5));
    assert.equal(dists.filter((d) => d === 1).length, 1, 'exactly one right neighbour');
    assert.equal(dists.filter((d) => d === -1).length, 1, 'exactly one left neighbour');
    assert.ok(
      dists.every((d) => Math.abs(d) <= 2),
      `nothing travels more than half the ring (active=${active})`
    );
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
// Stage height
// --------------------------------------------------------------------------

test('the arc sizes every panel to the tallest one', () => {
  // The neighbours are on show, so cards of visibly different heights sitting side by
  // side is exactly what a shared height exists to prevent — and the section must not
  // resize as you cycle. Whichever panel is in front, the answer is the same number.
  const heights = [444, 415, 457, 422, 486];
  for (let i = 0; i < heights.length; i++) {
    assert.equal(stageHeightFor(heights, i, false), 486, `front panel ${i} still measures the tallest`);
  }
});

test('the flat layout sizes the stage to the FRONT panel, not the tallest', () => {
  // Below 900px geometryFor sends every non-front panel to `hidden` (see the test
  // above), so there is nothing left for a shared height to line up with — it only
  // pads the short panels out to the tallest one's height. On the shipped content that
  // is ~260px of empty glass inside the card, on the viewport that can least afford it.
  const heights = [790, 718, 807, 740, 978];
  assert.equal(stageHeightFor(heights, 1, true), 718, 'the shortest panel keeps its own height');
  assert.equal(stageHeightFor(heights, 4, true), 978, 'and the tallest still gets all of its own');
  assert.notEqual(
    stageHeightFor(heights, 1, true),
    stageHeightFor(heights, 1, false),
    'flat and arc must not agree here, or the flat branch is doing nothing'
  );
});

test('stageHeightFor survives an empty or out-of-range read', () => {
  // measure() bails on <= 0 rather than writing a height, so returning 0 is the
  // contract for "nothing measurable" — never NaN or -Infinity from a bare Math.max.
  assert.equal(stageHeightFor([], 0, false), 0);
  assert.equal(stageHeightFor([], 0, true), 0);
  assert.equal(stageHeightFor([300], 7, true), 0, 'an index past the end is not a height');
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

test('the homepage ships five panels, four carrying the old section ids', () => {
  const panels = panelsFromMarkup();
  assert.deepEqual(
    panels.map((p) => p.id),
    ['staging-studio-demo', 'ai-designer-demo', 'masking-studio-demo', 'exterior-studio-demo', 'gallery-showcase'],
    'panel ids, in order'
  );
});

test('the old standalone sections are gone, so each id appears exactly once', () => {
  for (const id of ['staging-studio-demo', 'ai-designer-demo', 'masking-studio-demo', 'exterior-studio-demo', 'gallery-showcase']) {
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

  const LEAVES = ['title', 'tablistAria', 'prevAria', 'nextAria'];
  const TABS = ['staging', 'designer', 'masking', 'exterior', 'gallery'];

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

test('the walkthrough panels have their full aside copy in all eleven packs', () => {
  // The AI Designer and Masking panels grew a copy column beside their walkthrough
  // (kicker / title / body / three points) to match the exterior panel's shape. Same
  // gap as above: nothing else checks that a namespace exists in every pack, and a
  // missing key here falls back to English silently rather than failing a build.
  const dir = path.join(ROOT, 'public', 'languages');
  const shape = {
    staging: ['upload', 'styles', 'restage', 'rights'],
    designer: ['iterate', 'furniture', 'saved'],
    masking: ['snap', 'areas', 'own', 'repeat'],
    gallery: ['auto', 'versions', 'search', 'private', 'share'],
  };
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const home = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).home;
    for (const [section, points] of Object.entries(shape)) {
      const block = home?.[section];
      assert.ok(block, `${file}: home.${section} is missing`);
      for (const key of ['kicker', 'panelTitle', 'panelBody']) {
        assert.equal(typeof block[key], 'string', `${file}: home.${section}.${key} is a string`);
        assert.ok(block[key].trim().length > 0, `${file}: home.${section}.${key} is not blank`);
      }
      for (const key of points) {
        const point = block.points?.[key];
        assert.equal(typeof point, 'string', `${file}: home.${section}.points.${key} is a string`);
        assert.ok(point.trim().length > 0, `${file}: home.${section}.points.${key} is not blank`);
      }
    }
  }
});

test('every walkthrough key the panels ask for exists in demo-data.js', () => {
  // designer-demo.js's demoByKey() returns null for an unknown key and mount() then
  // returns without a word — the panel keeps its skeleton spinner for as long as the
  // page is open, which looks like a slow load rather than a typo. Nothing else in the
  // suite connects the homepage's data-demo attributes to the generated demo data.
  const keys = [...INDEX.matchAll(/class="designer-demo" data-demo="([\w-]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length >= 3, `expected the walkthrough panels, saw ${keys.length}`);
  const data = fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'demo-data.js'), 'utf8');
  /** @type {{ demos: { key: string }[] }} */
  const demos = JSON.parse(data.slice(data.indexOf('{'), data.lastIndexOf('}') + 1));
  const known = new Set(demos.demos.map((d) => d.key));
  for (const key of keys) {
    assert.ok(known.has(key), `data-demo="${key}" names no demo in demo-data.js (spinner forever)`);
  }
});

test('every panel uses the shared split markup', () => {
  // The class began as the exterior section's `hex-shell` and was renamed as each
  // panel adopted it — the demo pair first, then the gallery. All four are on it now,
  // which is what keeps their heights within ~44px of each other; a panel that opts
  // out goes back to being whatever height its content wants and drags the shared
  // card height with it. If a rename ever half-lands, this catches the stragglers.
  const panels = panelsFromMarkup().length;
  assert.equal([...INDEX.matchAll(/class="shw__split"/g)].length, panels, 'every panel splits');
  assert.equal([...INDEX.matchAll(/class="shw__aside"/g)].length, panels, 'every panel has a copy column');
  for (const dead of ['hex-shell', 'hex-copy']) {
    assert.equal(INDEX.includes(dead), false, `the old ${dead} class is fully retired`);
  }
});

// --------------------------------------------------------------------------
// The gallery mock's seven cards
// --------------------------------------------------------------------------

/** The gallery panel's markup, sliced out of index.html. */
function galleryMarkup() {
  return panelMarkup('gallery-showcase');
}

test('the gallery mock ships seven cards, each with its own image', () => {
  const gal = galleryMarkup();
  const cards = [...gal.matchAll(/<figure class="hgal-card">/g)].length;
  assert.equal(cards, 7, 'seven cards');
  const srcs = [...gal.matchAll(/src="(media-webp\/Homepage\/Gallery\/[^"]+)"/g)].map((m) => m[1]);
  assert.equal(srcs.length, 7, 'one image per card');
  assert.equal(new Set(srcs).size, 7, 'no image is used twice');
});

test('every gallery image the markup points at exists on disk', () => {
  // srcset as well as src: a variant named in the markup but never exported is a 404
  // the browser picks silently, on whichever device the descriptor selected it for.
  const gal = galleryMarkup();
  const refs = new Set();
  for (const [, src] of gal.matchAll(/src="(media-webp\/Homepage\/Gallery\/[^"]+)"/g)) refs.add(src);
  for (const [, set] of gal.matchAll(/srcset="([^"]+)"/g)) {
    for (const part of set.split(',')) refs.add(part.trim().split(/\s+/)[0]);
  }
  assert.equal(refs.size, 14, 'seven cards, each offering a 480 and a 1200 wide file');
  for (const src of refs) {
    const file = path.join(ROOT, 'public', ...src.split('/'));
    assert.ok(fs.existsSync(file), `${src} is missing — the card would render a broken image`);
  }
});

/* The cards paint at ~239 CSS px in the panel's two-column grid, and every one of them
   used to be a 1200 px file: 626 KB decoded at five times the size it is drawn at. They
   are NOT simply downscaled, because below 768px the grid drops to one column and hides
   six of the seven, so a phone shows a single card at ~325 CSS px — which at 3x wants
   ~975 px of source. Both widths are offered and the browser picks; desktop takes ~116 KB
   for the set, a high-DPR phone keeps what it had. Generate with
   `node scripts/build-gallery-thumbs.js`. */
test('the gallery cards offer a desktop-sized variant, not just the full-size file', () => {
  const gal = galleryMarkup();
  const imgs = [...gal.matchAll(/<img class="hgal-card__img"[^>]*>/g)].map((m) => m[0]);
  assert.equal(imgs.length, 7, 'seven card images');
  for (const img of imgs) {
    const name = (img.match(/src="media-webp\/Homepage\/Gallery\/(room-[a-z]+)\.webp"/) || [])[1];
    assert.ok(name, `a card image has an unexpected src: ${img.slice(0, 80)}`);
    const srcset = (img.match(/srcset="([^"]+)"/) || [])[1];
    assert.ok(srcset, `${name} needs a srcset — without one every visitor takes the 1200px file`);
    assert.match(srcset, new RegExp(`${name}-480\\.webp 480w`), `${name} offers its 480w variant`);
    assert.match(srcset, new RegExp(`${name}\\.webp 1200w`), `${name} still offers the full size`);
    // Without sizes, the UA assumes 100vw and picks the 1200 anyway on a desktop.
    assert.match(img, /sizes="\(max-width: 768px\) 92vw, 240px"/, `${name} needs matching sizes`);
    // The attributes that keep this panel off the critical path must survive the edit.
    assert.match(img, /loading="lazy"/, `${name} stays lazy`);
    assert.match(img, /width="1200"/, `${name} keeps its intrinsic width, which sizes the box`);
  }
});

test('the "N staged rooms" count names the number of cards, in every pack', () => {
  // The count is a literal number in prose, so it silently goes stale the moment a
  // card is added or removed — the very thing that just happened going 3 -> 7. It is
  // hidden below 768px where only one card survives, so the number only has to be
  // true at the widths it is actually visible.
  const cards = [...galleryMarkup().matchAll(/<figure class="hgal-card">/g)].length;
  const dir = path.join(ROOT, 'public', 'languages');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const count = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).home?.gallery?.mock?.count;
    assert.equal(typeof count, 'string', `${file}: home.gallery.mock.count is a string`);
    assert.match(
      count,
      new RegExp(`\\b${cards}\\b|${cards}`),
      `${file}: mock.count is "${count}" but the mock ships ${cards} cards`
    );
  }
});

test('every card key the gallery markup asks for exists in all eleven packs', () => {
  const keys = [...galleryMarkup().matchAll(/data-lang(?:-attr)?="([^"|]+)/g)].map((m) => m[1]);
  const unique = [...new Set(keys)];
  assert.ok(unique.length >= 25, `expected the full card set, saw ${unique.length} keys`);
  const dir = path.join(ROOT, 'public', 'languages');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const pack = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    for (const key of unique) {
      const value = key.split('.').reduce((/** @type {any} */ o, k) => (o || {})[k], pack);
      assert.equal(typeof value, 'string', `${file}: ${key} is missing`);
      assert.ok(value.trim().length > 0, `${file}: ${key} is blank`);
    }
  }
});

test('the mock grid scrolls rather than growing the panel', () => {
  // These four together are what keep seven cards from making the gallery panel
  // taller than the other three: the grid takes the leftover row height and scrolls
  // inside it. Drop min-height:0 and a grid child refuses to shrink below its
  // content, so the panel grows instead and the shared card height goes with it.
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles', 'home.css'), 'utf8');
  const rule = css.slice(css.indexOf('.hgal-grid {'), css.indexOf('}', css.indexOf('.hgal-grid {')));
  for (const decl of [
    'flex: 1',
    'min-height: 0',
    'max-height:',
    'overflow-y: auto',
    'overscroll-behavior: contain',
    // The subtle one. With a definite height, implicit `auto` rows are fitted to the
    // container rather than to their content — the rows collapsed to 51px and the
    // images were clipped by .hgal-card's overflow:hidden, leaving nothing to scroll.
    'grid-auto-rows: max-content',
  ]) {
    assert.ok(rule.includes(decl), `.hgal-grid needs "${decl}"`);
  }
});

// --------------------------------------------------------------------------
// The pre-mount skeleton, the touch contract, and the [hidden] restatement
// --------------------------------------------------------------------------

/**
 * The `{ … }` body of the rule whose selector list is EXACTLY `selector`, comments
 * stripped. Exact, because a substring match would also hit
 * `.shw__media:fullscreen .designer-demo` — a different rule, for a different job,
 * which happens to sit above the base one.
 *
 * @param {string} selector e.g. '.designer-demo'
 */
function ruleBody(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
  const m = homeCss().match(new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, 'm'));
  return m ? m[1] : null;
}

/** Every demo's declared aspect ratio, read out of the generated data file. */
function demoAspects() {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'demo-data.js'), 'utf8');
  /** @type {Record<string, number>} */
  const out = {};
  for (const m of src.matchAll(/"key":"([a-z]+)"[\s\S]*?"aspect":([0-9.]+)/g)) out[m[1]] = Number(m[2]);
  return out;
}

/* The skeleton box (.designer-demo) and the mounted player's frame (.sdp__frame, via
   --ar) are two different boxes showing the same thing back to back: the host holds the
   ratio until the player arrives, then `.designer-demo.sdp { aspect-ratio: auto }` hands
   it over. Disagree and the media JUMPS on mount and re-measures the stage under
   everything below the section — 12.5% on the staging panel, which is the one in front
   on load. The expectation is derived from demo-data.js rather than written down here,
   so re-recording a walkthrough at a new ratio fails this instead of drifting. */
test('each demo host is shaped like the demo it mounts', () => {
  const css = homeCss();
  const aspects = demoAspects();
  const base = ruleBody('.designer-demo');
  assert.ok(base, '.designer-demo has a rule');
  const baseAr = base.match(/aspect-ratio:\s*([^;]+);/);
  assert.ok(baseAr, '.designer-demo declares a default aspect-ratio for the skeleton');
  const evaluate = (/** @type {string} */ v) => {
    const frac = v.match(/^\s*([\d.]+)\s*\/\s*([\d.]+)\s*$/);
    return frac ? Number(frac[1]) / Number(frac[2]) : Number(v);
  };

  const hosts = panelsFromMarkup()
    .map(({ id }) => ({ panel: id, key: (panelMarkup(id).match(/\bdata-demo="([a-z]+)"/) || [])[1] }))
    .filter(({ key }) => key);
  assert.equal(hosts.length, 3, 'three panels mount a walkthrough player');

  for (const { panel, key } of hosts) {
    const declared = aspects[key];
    assert.ok(declared, `${key} is a demo in demo-data.js`);
    // An id-scoped override if there is one, otherwise the shared default.
    const override = css.match(new RegExp(`#${panel}\\s+\\.designer-demo\\s*\\{([^}]*)\\}`));
    const value = override ? (override[1].match(/aspect-ratio:\s*([^;]+);/) || [])[1] : baseAr[1];
    assert.ok(value, `${panel} resolves an aspect-ratio`);
    const drift = Math.abs(evaluate(value) - declared) / declared;
    assert.ok(
      drift < 0.005,
      `${panel} skeleton is ${evaluate(value).toFixed(4)} but ${key} records at ${declared} `
        + `(${(drift * 100).toFixed(1)}% jump on mount) — fix the host rule, not this test`
    );
  }
});

/* wireDrag() never calls preventDefault, so the browser has to be told which axis it
   may keep for itself. Without touch-action it owns both and can fire pointercancel —
   which end() treats as an abort — before the pointer clears the 60px threshold, so the
   swipe fails intermittently on exactly the layout where it is the natural gesture.
   .ba next door has carried this declaration for the same reason all along. */
test('the carousel stage hands the browser vertical panning and keeps the rest', () => {
  const body = ruleBody('.shw__stage');
  assert.ok(body, '.shw__stage has a rule');
  assert.match(body, /touch-action:\s*pan-y/, '.shw__stage needs touch-action: pan-y');
});

/* [hidden] is a UA rule at (0,0,0) and `.shw__fs { display: inline-flex }` is an author
   one, so it wins outright and `btn.hidden = true` in wireFullscreen() did nothing.
   That branch returns BEFORE wiring the click handler, while `@media (hover: none)`
   forces the button visible — a permanent tap target that does nothing. jsdom applies
   no stylesheets, so this tier can only read the rule; the computed value is checked
   in the browser instead.

   guides.css carries the identical pair and was MISSING the restatement entirely, so
   both are asserted here rather than leaving the twin unguarded. */
test('hiding the fullscreen button actually hides it', () => {
  assert.match(
    homeCss(),
    /\.shw__fs\[hidden\]\s*\{[^}]*display:\s*none/,
    'home.css must restate [hidden] for .shw__fs, or the author display: inline-flex beats it'
  );
  const guides = fs.readFileSync(path.join(ROOT, 'public', 'styles', 'guides.css'), 'utf8');
  assert.match(
    guides,
    /\.guide-demo-fs\[hidden\]\s*\{[^}]*display:\s*none/,
    'guides.css must restate [hidden] for its twin control too'
  );
  const js = fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'showcase', 'fullscreen.js'), 'utf8');
  assert.match(js, /\bhidden\s*=\s*true/, 'and the script still sets it');
  /* But CONDITIONALLY. The hide branch used to be unconditional on
     !document.fullscreenEnabled, which is falsy on every iPhone — and a phone is now
     exactly where the button has a job to do, because the rotate-to-landscape path
     needs no fullscreen support at all. Hiding it there would re-break the control on
     the one platform it was broken on to begin with. */
  const guard = js.match(/if \(!document\.fullscreenEnabled[^)]*\)/);
  assert.ok(guard, 'the hide is still guarded on fullscreenEnabled');
  assert.match(guard[0], /isPhone\(\)/, 'and must NOT fire on a phone, which uses the rotate path');
});

/* Every pointer listener lives on the stage, which is ~520px tall inside a section the
   side panels bleed out of. Release outside it and end() never ran: id and startX stayed
   stale, and because a mouse keeps its pointerId for the session, the next plain mouse
   move across the stage measured dx against that dead origin, cleared 60px and flicked
   the carousel with no button held. Capture is what guarantees the release comes back. */
test('a drag cannot be left half-finished when the pointer leaves the stage', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'studio-showcase.js'), 'utf8');
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.match(code, /setPointerCapture\(/, 'the stage must capture the pointer it is tracking');
  assert.match(code, /isPrimary/, 'and ignore a second finger / non-primary button');
});

/* The roving tabindex normally keeps the focused tab and the active panel equal, but the
   wheel, a drag, a side-panel click, the arrow buttons and a hashchange all move
   sc.active without moving focus. Arrowing from sc.active after any of those skipped a
   studio relative to where the user actually was. */
test('tablist arrow keys step from the focused tab, not the active panel', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'studio-showcase.js'), 'utf8');
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const handler = code.match(/ArrowRight[\s\S]{0,400}?ArrowLeft[^\n]*\n/);
  assert.ok(handler, 'the arrow-key branch exists');
  assert.ok(
    !/next\s*=\s*sc\.active/.test(handler[0]),
    'the step base must come from the focused tab, not sc.active'
  );
  assert.match(code, /sc\.tabs\.indexOf\(/, 'resolve the focused tab against sc.tabs');
});

// --------------------------------------------------------------------------
// Fullscreen
// --------------------------------------------------------------------------

test('every media panel carries a fullscreen control; the gallery does not', () => {
  const panels = panelsFromMarkup().map((p) => p.id);
  for (const id of panels) {
    const markup = panelMarkup(id);
    const wants = id !== 'gallery-showcase';
    assert.equal(
      markup.includes('data-shw-fullscreen'),
      wants,
      wants
        ? `${id} should have a fullscreen button`
        : // The gallery mock is a static mock, and its .hgal-mock MUST stay a stretched
          // grid item so its card scroller has a definite height — wrapping it in a
          // .shw__media would take that away.
          `${id} deliberately has none`
    );
    assert.equal(markup.includes('class="shw__media"'), wants, `${id} media wrapper`);
  }
});

test('the fullscreen button is a labelled toggle', () => {
  const btn = INDEX.match(/<button[^>]*data-shw-fullscreen[^>]*>/);
  assert.ok(btn, 'the fullscreen button exists');
  // aria-pressed carries the state, which is why the label can stay constant and the
  // packs need one key rather than separate enter/exit strings.
  assert.match(btn[0], /aria-pressed="false"/, 'starts unpressed');
  assert.match(btn[0], /data-lang-attr="home\.showcase\.fullscreen\|aria-label"/, 'localised label');
  assert.match(btn[0], /type="button"/, 'not a submit button');
});

test('fullscreen degrades and does not fight the carousel', () => {
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const island = strip(fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'showcase', 'fullscreen.js'), 'utf8'));
  const code = strip(fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'studio-showcase.js'), 'utf8'));
  assert.match(island, /document\.fullscreenEnabled/, 'hides the control where fullscreen is unavailable');

  /* Cycling while the front media is expanded would swap the content out from under a
     viewer who cannot see the carousel behind it. There are now TWO ways to be
     expanded — natively, and portaled into the rotate-to-landscape overlay — so the
     predicate has to name both, or a phone swipe cycles the carousel behind an open
     overlay and orphans the DOM move that overlay is holding. */
  const pred = island.match(/function expanded\(\)\s*\{[^}]*\}/);
  assert.ok(pred, 'expanded() is the single predicate');
  assert.match(pred[0], /document\.fullscreenElement/, 'it covers native fullscreen');
  assert.match(pred[0], /anyImmersiveOpen\(\)/, 'and the immersive overlay');

  const bails = [...code.matchAll(/if \(expanded\(\)\) return;/g)].length;
  // drag, wheel AND select() — the last is what covers the arrows, the tabs, the dots
  // and a deep link in one place rather than four more copies.
  assert.ok(bails >= 3, `drag, wheel and select must all bail while expanded (found ${bails})`);
  assert.match(
    code,
    /function select\(sc, next, opts\) \{\s*if \(expanded\(\)\) return;/,
    'select() bails first, before it relayouts around a portaled-out panel'
  );
  // measure() is the other half: the panel is genuinely short while its media is away,
  // so a measurement taken then would park the wrong height on the stage for good.
  assert.match(
    code,
    /function measure\(sc\) \{\s*if \(anyImmersiveOpen\(\)\) return;/,
    'measure() skips the portaled state'
  );
});

/* The regression this guards: .shw__media:fullscreen used to pin height:100% on the
   ratio carriers and cap the width with max-width:100%. Once the ratio-derived width
   exceeded the available width the cap won, the height stayed pinned, and the box
   rendered at the viewport's ratio instead of its own. .sdp__img is object-fit:cover,
   so the capture got cropped while .sdp__area kept positioning itself in percentages
   of the un-cropped frame box — every highlight in the walkthrough drifted off its
   target, but only in fullscreen. The sizing has to derive WIDTH from the viewport
   height and leave the height to aspect-ratio, which cannot be squashed. */
test('fullscreen derives the demo width from the height, never the reverse', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles', 'home.css'), 'utf8');
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // Every :fullscreen rule that sizes a box carrying an aspect ratio.
  const rules = [...code.matchAll(/\.shw__media:fullscreen\s+[^{}]*\{([^}]*)\}/g)]
    .map((m) => ({ sel: m[0].slice(0, m[0].indexOf('{')), body: m[1] }))
    .filter((r) => /\.ba\b|\.designer-demo\b|\.sdp\b/.test(r.sel));
  assert.ok(rules.length >= 2, 'the ratio carriers are sized under :fullscreen');
  for (const r of rules) {
    assert.ok(
      !/height:\s*100%/.test(r.body),
      `a definite height distorts the box once max-width clamps: ${r.sel.trim()}`
    );
  }
  const demo = rules.find((r) => /\.designer-demo\b/.test(r.sel));
  assert.ok(demo, '.designer-demo is sized under :fullscreen');
  // --ar is the player's own ratio, set inline on the .sdp root by demo-player.js.
  assert.match(demo.body, /var\(--ar/, 'the width comes from the demo aspect ratio');
  assert.match(demo.body, /100vh/, 'and from the viewport height, not the container width');
  assert.match(demo.body, /height:\s*auto/, 'so aspect-ratio computes the height back');
});

/* The callout card is placed in frame PIXELS and the player only recomputes it on
   window.resize, which entering element-fullscreen is not guaranteed to fire (and
   never fires when the browser is already in F11 fullscreen). guides.js reflows its
   players on fullscreenchange; the homepage did not, and threw away the instance
   mount() returns, so it had nothing to reflow. */
test('the showcase keeps its players and reflows them on fullscreen change', () => {
  const mount = fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'designer-demo.js'), 'utf8');
  assert.match(
    mount,
    /__player\s*=\s*SupademoPlayer\.mount\(/,
    'designer-demo.js must keep the mounted instance for the host page'
  );
  const js = fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'studio-showcase.js'), 'utf8');
  assert.match(js, /__player\.reflow\(\)/, 'the showcase reflows the mounted player');
  // One named hook rather than a body repeated per path, because there are now two
  // routes into a size change: the native fullscreenchange, and the immersive
  // controller's onChange.
  assert.match(
    js,
    /function afterViewChange\(sc\) \{[\s\S]*?reflowDemos\(sc\)/,
    'afterViewChange re-measures and reflows'
  );
  const island = fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'showcase', 'fullscreen.js'), 'utf8');
  const handler = island.match(/'fullscreenchange',[\s\S]*?\n {2}\}\);/);
  assert.ok(handler, 'the fullscreenchange handler exists');
  assert.match(handler[0], /onViewChange\(\)/, 'and it reflows the demos');
  assert.match(island, /onChange: \(\) => onViewChange\(\)/, 'the immersive path lands on the same hook');
});

test('fullscreen sizes the element that actually carries the aspect ratio', () => {
  // The subtle one. .ba has aspect-ratio directly, but .designer-shell does NOT — the
  // walkthrough's ratio sits on .designer-demo before the player mounts and moves to
  // .sdp__frame after. Height-driven sizing applied only to the shell would leave the
  // demo sized by width and spilling off the bottom of the screen.
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles', 'home.css'), 'utf8');
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const sel of ['.ba', '.designer-demo', '.sdp__frame']) {
    assert.ok(
      new RegExp(`\\.shw__media:fullscreen\\s+\\${sel}\\b`).test(code) ||
        new RegExp(`\\.shw__media:fullscreen\\s+[^{]*\\${sel}[,\\s{]`).test(code),
      `:fullscreen must size ${sel}`
    );
  }
});

test('the fullscreen label is in all eleven packs', () => {
  const dir = path.join(ROOT, 'public', 'languages');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const showcase = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).home?.showcase;
    // Two keys, because the control has two jobs: `fullscreen` under a desktop pointer,
    // `rotate` on a phone, where it opens the landscape view instead. The English
    // fallback in immersive-view.js would otherwise hide a missing translation.
    for (const key of ['fullscreen', 'rotate']) {
      const value = showcase?.[key];
      assert.equal(typeof value, 'string', `${file}: home.showcase.${key} is missing`);
      assert.ok(value.trim().length > 0, `${file}: home.showcase.${key} is blank`);
    }
  }
});

/* --- The class-path twin -------------------------------------------------
   Phones never enter native fullscreen (iPhone Safari has no element fullscreen at
   all), so the rotate-to-landscape view portals .shw__media into an overlay and
   presents it with `.is-immersive` instead. That block is a deliberate DUPLICATE of
   the `:fullscreen` one — a CSS selector list is invalidated whole if one component
   fails to parse, and the browsers that need the fallback are exactly the ones that
   might not parse `:fullscreen`.

   Duplication nothing checks is duplication that rots, so: the same sizing assertions
   run against the twin, and the property SETS must match. Only values may differ, and
   only in the one documented way — `100vh` becomes `var(--imv-box)`, because under
   rotation the box the media must fit is the viewport's WIDTH. */
test('the immersive block sizes the demo exactly like the fullscreen one', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles', 'home.css'), 'utf8');
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...code.matchAll(/\.shw__media\.is-immersive\s+[^{}]*\{([^}]*)\}/g)]
    .map((m) => ({ sel: m[0].slice(0, m[0].indexOf('{')), body: m[1] }))
    .filter((r) => /\.ba\b|\.designer-demo\b|\.sdp\b/.test(r.sel));
  assert.ok(rules.length >= 2, 'the ratio carriers are sized under .is-immersive too');
  for (const r of rules) {
    assert.ok(!/height:\s*100%/.test(r.body), `a definite height distorts the box: ${r.sel.trim()}`);
  }
  const demo = rules.find((r) => /\.designer-demo\b/.test(r.sel));
  assert.ok(demo, '.designer-demo is sized under .is-immersive');
  assert.match(demo.body, /var\(--ar/, 'the width comes from the demo aspect ratio');
  assert.match(demo.body, /var\(--imv-box/, 'and from the overlay stage height, not a literal vh');
  assert.match(demo.body, /height:\s*auto/, 'so aspect-ratio computes the height back');
});

test('the fullscreen and immersive blocks cannot drift apart', () => {
  /** selector (minus its state hook) -> the sorted property names it declares */
  const shape = (css, hook) => {
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const out = new Map();
    for (const m of code.matchAll(new RegExp(hook + '([^{}]*)\\{([^}]*)\\}', 'g'))) {
      // A multi-selector rule repeats the hook after the comma, so strip every copy —
      // otherwise `.designer-demo, <hook> .sdp` keys differently under the two hooks
      // and the comparison fails on the prefix rather than on any real drift.
      const key = m[1].replace(new RegExp(hook, 'g'), '').replace(/\s+/g, ' ').trim();
      out.set(key, [...m[2].matchAll(/([a-z-]+)\s*:/g)].map((d) => d[1]).sort().join(','));
    }
    return out;
  };
  for (const [file, fsHook, imHook] of [
    ['home.css', '\\.shw__media:fullscreen', '\\.shw__media\\.is-immersive'],
    ['guides.css', '\\.guide-demo-panel:fullscreen', '\\.guide-demo-panel\\.is-immersive'],
  ]) {
    const css = fs.readFileSync(path.join(ROOT, 'public', 'styles', file), 'utf8');
    const native = shape(css, fsHook);
    const immersive = shape(css, imHook);
    assert.ok(native.size > 0, `${file}: the :fullscreen block exists`);
    assert.deepEqual(
      [...immersive.keys()].sort(),
      [...native.keys()].sort(),
      `${file}: the two blocks must cover the same selectors`
    );
    for (const [sel, props] of native) {
      assert.equal(
        immersive.get(sel),
        props,
        `${file}: "${sel || '(root)'}" declares different properties in the two blocks`
      );
    }
  }
});

/* The glyph swap. On a phone the control is not a fullscreen toggle, so showing the
   expand arrows would promise something the platform cannot do — it shows a rotating
   phone instead. Once the view is OPEN it is a close affordance again, which is why
   `.is-fs` has to beat `.is-mobile-rotate`. Both pages carry the identical trio. */
test('the rotate glyph replaces the expand arrows on phones, on both pages', () => {
  for (const [page, css, btn, glyph] of [
    ['index.html', 'home.css', 'shw__fs', 'shw__fs-rotate'],
    ['guides.html', 'guides.css', 'guide-demo-fs', 'guide-demo-fs__rotate'],
  ]) {
    const html = fs.readFileSync(path.join(ROOT, 'public', page), 'utf8');
    const buttons = [...html.matchAll(new RegExp('<button[^>]*class="' + btn + '"[\\s\\S]*?</button>', 'g'))];
    assert.ok(buttons.length >= 4, `${page}: found ${buttons.length} controls`);
    for (const b of buttons) {
      assert.ok(b[0].includes('class="' + glyph + '"'), `${page}: every control carries the rotate glyph`);
    }
    const sheet = fs.readFileSync(path.join(ROOT, 'public', 'styles', css), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(
      sheet,
      new RegExp('\\.' + btn + '\\.is-mobile-rotate \\.' + glyph + '\\s*\\{[^}]*display:\\s*block'),
      `${css}: the rotate glyph shows on a phone`
    );
    assert.match(
      sheet,
      new RegExp('\\.' + btn + '\\.is-mobile-rotate\\.is-fs \\.' + glyph + '\\s*\\{[^}]*display:\\s*none'),
      `${css}: and gives way to the close glyph once open`
    );
  }
});

test('the homepage clips the arc that bleeds past the viewport', () => {
  // The side panels are translated well past the section so the arc runs off-screen.
  // `body, main { overflow-y: auto }` (styles.css) makes <main> the scroll container,
  // and overflow-y:auto next to overflow-x:visible resolves overflow-x to `auto` —
  // which turned that deliberate bleed into ~220px of real horizontal scrolling on the
  // homepage. html and body clip already, but main scrolls inside them, so it needs
  // its own rule. Without this the page scrolls sideways into empty space.
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles', 'home.css'), 'utf8');
  // Comments stripped FIRST: the fix carries a long explanatory comment that names
  // `overflow-x` several times, so a scan of the raw file would still pass with the
  // declaration itself deleted.
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = code.match(/body\.page-home\s+main\s*\{([^}]*)\}/);
  assert.ok(rule, 'home.css still scopes an overflow rule to body.page-home main');
  assert.match(
    rule[1],
    /overflow-x:\s*(clip|hidden)/,
    'body.page-home main must clip horizontally, or the showcase arc becomes scrollable space'
  );
});

test('the carousel drag ignores the gallery scroller', () => {
  // Without this the mock cannot be scrolled by dragging: the pointer gesture is
  // taken by the carousel and flicks to the next studio instead.
  const js = fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'studio-showcase.js'), 'utf8');
  const guard = js.match(/if \(target\.closest\((['"])(.+?)\1\)\) return;/);
  assert.ok(guard, 'wireDrag still has its ignore list');
  assert.match(guard[2], /\.hgal-grid/, 'the gallery scroller is in the drag ignore list');
});

test('the tab labels the markup asks for are the ones the packs define', () => {
  // The markup names its keys; the packs must answer to exactly those names. Catches a
  // rename on either side, which the English fallback would otherwise paper over.
  const asked = [...INDEX.matchAll(/data-lang="home\.showcase\.tabs\.(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(asked, ['staging', 'designer', 'masking', 'exterior', 'gallery']);
  const english = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'public', 'languages', 'english.json'), 'utf8')
  );
  assert.deepEqual(Object.keys(english.home.showcase.tabs).sort(), [...asked].sort());
});

// --------------------------------------------------------------------------
// The narrow-viewport stepper
// --------------------------------------------------------------------------
//
// Five tab labels do not fit across a phone in any of the eleven packs. That used to be
// answered with a masked horizontal scroller, which read as clipped text rather than as
// something to swipe — a sideways gesture inside a page that scrolls downwards is not one
// anybody goes looking for, so four of the five studios were effectively invisible on
// mobile. It is now a `‹ Masking Studio ›` stepper: the active tab is the label, the four
// others are display:none, and two arrow buttons step through them.
//
// Nothing here can be asserted from behaviour — there is no DOM in this tier and the
// difference is entirely CSS — so these are markup/stylesheet guards. The important one
// is the one that fails if the scroller comes back.

/** home.css with comments stripped, so a guard cannot pass on the strength of a comment. */
function homeCss() {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles', 'home.css'), 'utf8');
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * The `@media` block whose body declares `needle`, as `{ condition, body }`.
 * Brace-matched rather than regexed: a media block contains nested rules, so `[^}]*`
 * would stop at the first inner closing brace.
 *
 * @param {string} code comment-stripped CSS
 * @param {string} needle e.g. '.shw__arrow {'
 */
function mediaBlockWith(code, needle) {
  const opener = /@media\s*([^{]+)\{/g;
  for (let m = opener.exec(code); m; m = opener.exec(code)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < code.length && depth > 0; i += 1) {
      if (code[i] === '{') depth += 1;
      else if (code[i] === '}') depth -= 1;
    }
    const body = code.slice(start, i - 1);
    if (body.includes(needle)) return { condition: m[1].trim(), body };
  }
  return null;
}

test('the showcase ships prev/next arrows outside the tablist', () => {
  // Outside role="tablist" on purpose: a tablist may contain only tabs. They are the
  // narrow layout's only way to reach the four studios the CSS has hidden.
  const arrows = [...INDEX.matchAll(/<button\b([^>]*\bdata-shw-arrow="(-?\d+)"[^>]*)>/g)].map((m) => ({
    attrs: m[1],
    step: Number(m[2]),
  }));
  assert.equal(arrows.length, 2, 'exactly two stepper arrows');
  assert.deepEqual(arrows.map((a) => a.step).sort((a, b) => a - b), [-1, 1], 'one back, one forward');
  for (const arrow of arrows) {
    assert.doesNotMatch(arrow.attrs, /\brole="tab"/, 'an arrow is not a tab');
    assert.match(
      arrow.attrs,
      /data-lang-attr="home\.showcase\.(prev|next)Aria\|aria-label"/,
      'each arrow localises its aria-label'
    );
    assert.match(arrow.attrs, /\baria-label="/, 'each arrow ships an English aria-label to fall back on');
  }
  // The wrapper is what the flex row and the arrow/label/arrow order hang off.
  assert.match(INDEX, /<div class="shw__nav">/, 'the tablist is wrapped in .shw__nav');

  const english = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'languages', 'english.json'), 'utf8'));
  assert.ok(english.home.showcase.prevAria && english.home.showcase.nextAria, 'both keys exist in English');
});

test('the arrows are wired to step the carousel', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'studio-showcase.js'), 'utf8');
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /querySelectorAll\('\[data-shw-arrow\]'\)/, 'wireArrows reads the arrows from the markup');
  assert.match(code, /select\(sc,\s*sc\.active \+ step\)/, 'a click steps by the arrow\'s own delta');
  assert.match(code, /\bwireArrows\(sc\);/, 'init actually calls wireArrows');
});

test('all five tabs stay in the markup — the narrow layout hides them in CSS', () => {
  // The stepper shows one label, but the other four tabs are what carry the
  // tab->panel ARIA pairing (and the deep-linkable roving focus). Hiding them must
  // stay a CSS concern; dropping them from the markup would take the wiring with it.
  assert.equal(tabsFromMarkup().length, 5, 'five tab buttons in index.html');
  const code = homeCss();
  const flat = mediaBlockWith(code, '.shw__arrow {');
  assert.ok(flat, 'the arrows are styled inside a media block');
  assert.match(
    flat.body,
    /\.shw__tab:not\(\.is-active\)\s*\{\s*display:\s*none/,
    'the narrow layout hides the inactive tabs rather than the markup dropping them'
  );
});

test('the narrow tablist is not a hidden horizontal scroller', () => {
  // THE POINT OF THIS FILE'S NEWEST GUARD. The scroller looked fine in a desktop
  // emulator — it only failed as a thing nobody discovers, which no snapshot catches.
  // Comments are stripped above, so the note in home.css explaining why the scroller
  // was removed cannot itself satisfy this scan.
  const code = homeCss();
  const flat = mediaBlockWith(code, '.shw__arrow {');
  assert.ok(flat, 'the stepper block is still there');
  const tabs = flat.body.match(/\.shw__tabs\s*\{([^}]*)\}/);
  assert.ok(tabs, 'the narrow layout still has a .shw__tabs rule');
  for (const banned of ['overflow-x', 'mask-image', 'scroll-snap-type']) {
    assert.doesNotMatch(
      tabs[1],
      new RegExp(banned),
      `the narrow tablist must not scroll sideways again (${banned})`
    );
  }
  assert.doesNotMatch(flat.body, /scroll-snap-align/, 'no leftover snap points on the tabs');
});

test('the stepper switches on at the same width as the flat carousel', () => {
  // studio-showcase.js stops positioning the neighbouring panels at FLAT_QUERY. The
  // stepper has to appear at exactly that width: a gap between the two leaves either a
  // scrolling tab strip or an arc with no room, and the coupling was comment-only.
  const js = fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'studio-showcase.js'), 'utf8');
  const flatQuery = js.match(/const FLAT_QUERY = '([^']+)'/);
  assert.ok(flatQuery, 'studio-showcase.js still declares FLAT_QUERY');

  const code = homeCss();
  const normalise = (/** @type {string} */ s) => s.replace(/[()\s]/g, '');
  const block = mediaBlockWith(code, '.shw__arrow {');
  assert.ok(block, 'the arrows are styled inside a media block');
  assert.equal(
    normalise(block.condition),
    normalise(flatQuery[1]),
    'the stepper breakpoint and FLAT_QUERY must move together'
  );
});
