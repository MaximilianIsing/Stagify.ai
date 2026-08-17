// Tier: drift guard (static analysis of public/styles/) — the hero stat pills' two states.
//
// WHAT THIS COVERS
// index.html ships two `<div class="stat-pill">` inside #hero-stats. They become visible
// a few hundred ms in, when count-up.js adds .is-ready after the two count endpoints
// resolve, styled by the `.stat-pill` rules in index.css. Then, a second or two later,
// star-border.js — injected after `load` behind a requestIdleCallback(…, {timeout:2000})
// by index-deferred.js — REPLACES each of those divs with
// `.star-border-container > .inner-content`, moving the two spans across. From that
// instant the pill is painted by star-border.css, and index.css's rules are attached to
// an element that no longer exists.
//
// The two boxes had drifted apart, so the swap was a visible recolour and a 14px
// downward jump one to two seconds after the page opened: translucent navy at padding
// 6px/14px with a shadow and a backdrop blur, becoming solid --brand at padding 8px/16px
// inside a 5px ring band. The fix makes the fallback a pixel- and colour-accurate
// stand-in, so the only thing the swap adds is the animated glow. This guard is what
// keeps them in step — nothing else can. The fallback is on screen for about a second
// and a half and appears in no screenshot.
//
// It also makes star-border.js's init-guard comment true for the first time. That
// comment says index.css "carries fallback styling for exactly this case and the pills
// still look fine" if the glow never mounts. It did not.
//
// WHY A STATIC GUARD AND NOT A RENDERED TEST
// There is no jsdom here, deliberately, and e2e cannot see it either: by the time
// Playwright's `#hero-stats` assertion resolves the swap may or may not have happened,
// and both states are "visible" — which is the whole problem. Two stylesheets agreeing
// is a property of the stylesheets, so the stylesheets are what is checked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** @param {string} name */
const sheet = (name) => fs.readFileSync(path.join(ROOT, 'public', 'styles', name), 'utf8');

const INDEX = sheet('index.css');
const STAR = sheet('star-border.css');
// hero-picker.css replaced carousel.css in the same slot: the hero's own sheet, loaded
// before index.css. The duplication risk this file guards belongs to whatever sits there.
const HERO_SHEET = sheet('hero-picker.css');

const RING = '--star-pill-ring';

/**
 * A sheet split into its top-level part plus one entry per `@media` block, with
 * `/* … *\/` comments removed FIRST.
 *
 * Stripping is mandatory, not tidiness. The declarations pinned below are the subject of
 * a long comment in index.css that names `padding`, `background`, `box-shadow`,
 * `backdrop-filter`, `--star-pill-ring`, `margin` and `.inner-content` in prose. A scan
 * of the raw text is satisfied by that prose with the rules DELETED — the guard would be
 * measuring its own explanation. Mutation 4 in this file's history is exactly that case.
 *
 * @param {string} src
 * @returns {{ at: string, css: string }[]}
 */
function regions(src) {
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, '');
  /** @type {{ at: string, css: string }[]} */
  const media = [];
  let top = '';
  let i = 0;
  for (;;) {
    const at = bare.indexOf('@media', i);
    if (at === -1) { top += bare.slice(i); break; }
    top += bare.slice(i, at);
    const open = bare.indexOf('{', at);
    if (open === -1) { top += bare.slice(at); break; }
    let depth = 0;
    let j = open;
    for (; j < bare.length; j += 1) {
      if (bare[j] === '{') depth += 1;
      else if (bare[j] === '}') { depth -= 1; if (depth === 0) break; }
    }
    media.push({ at: bare.slice(at, open).replace(/\s+/g, ' ').trim(), css: bare.slice(open + 1, j) });
    i = j + 1;
  }
  return [{ at: '<top level>', css: top }, ...media];
}

/**
 * The top-level (unmediated) part of a sheet.
 *
 * @param {string} src
 * @returns {string}
 */
const topLevel = (src) => regions(src)[0].css;

/**
 * EVERY `@media` region whose prelude matches, joined.
 *
 * All of them, not the first: index.css has two separate `@media (max-width: 768px)`
 * blocks — one at the top of the file for `.desktop-only` and the hero title, and the
 * pill one further down — so a `.find()` here silently reads the wrong block and every
 * assertion downstream goes vacuous. (It did, on the first run of this file.) Joining is
 * safe because each `css` is the balanced interior of its block.
 *
 * The regexp rather than an exact string because the three sheets spell the same query
 * differently: `max-width: 768px` expanded in index.css, `max-width:768px` minified in
 * the other two.
 *
 * @param {string} src
 * @param {RegExp} at
 * @returns {string}
 */
function mediaRegions(src, at) {
  const found = regions(src).slice(1).filter((r) => at.test(r.at));
  assert.ok(found.length, `no @media region matching ${at} — this guard is reading a sheet it does not recognise`);
  return found.map((r) => r.css).join('\n');
}

/**
 * Declaration blocks for an exact selector within one region. Innermost rules only,
 * which is what this matches: a selector run cannot cross a brace, so a nested block
 * yields the inner rule rather than its wrapper.
 *
 * @param {string} css
 * @param {string} selector
 * @returns {string[]}
 */
function blocksFor(css, selector) {
  /** @type {string[]} */
  const out = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
    if (selectors.includes(selector)) out.push(m[2]);
  }
  return out;
}

/**
 * index.css is expanded and star-border.css is minified, so the same value is spelled
 * `rgba(255, 255, 255, 0.2)` in one and `rgba(255,255,255,.2)` in the other. Compare the
 * value, not the typography. Also the canonicaliser for the expected literals below, so
 * they can be written the way a human writes CSS.
 *
 * @param {string} v
 * @returns {string}
 */
const value = (v) => v.toLowerCase().replace(/\s+/g, '').replace(/(^|[,(])0\./g, '$1.');

/**
 * Every declaration in a block, as name -> canonical value.
 *
 * @param {string} block
 * @returns {Map<string, string>}
 */
function decls(block) {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const part of block.split(';')) {
    const at = part.indexOf(':');
    if (at === -1) continue;
    map.set(part.slice(0, at).trim().toLowerCase(), value(part.slice(at + 1)));
  }
  return map;
}

// The four properties that decide what the pill looks like. The rest of the two rules is
// either already identical (display / flex-direction / align-items / white-space) or
// provably invisible: `.inner-content`'s font-size never reaches the two spans (both size
// themselves in rem, and `.stat-pill-number`'s `min-width: 1ch` and its `translateY(calc(
// 0.05em - 1px))` both resolve against that span's own font-size), a flex container has
// no line-box strut, and text-align cannot move a content-sized flex item.
const BOX = ['padding', 'border', 'background', 'border-radius'];

test('the fallback pill paints the same box as the star-border inner content', () => {
  const fallback = blocksFor(topLevel(INDEX), '.stat-pill');
  const settled = blocksFor(topLevel(STAR), '.inner-content');
  assert.equal(fallback.length, 1, 'expected one top-level `.stat-pill` rule in index.css — this guard has gone blind');
  assert.equal(settled.length, 1, 'expected one top-level `.inner-content` rule in star-border.css — this guard has gone blind');

  const before = decls(fallback[0]);
  const after = decls(settled[0]);
  // Anti-vacuity: two empty maps agree on every property in BOX, so a broken block parser
  // would report a clean pass. Current counts are 10 and 14.
  assert.ok(
    before.size >= 8 && after.size >= 10,
    `parsed ${before.size} and ${after.size} declarations — the block parser is broken, not the CSS`,
  );

  const offenders = BOX
    .filter((prop) => before.get(prop) !== after.get(prop))
    .map((prop) => `${prop}: .stat-pill has ${before.get(prop) ?? '(nothing)'}, .inner-content has ${after.get(prop) ?? '(nothing)'}`);

  assert.deepEqual(
    offenders,
    [],
    'The pre-swap `.stat-pill` fallback in index.css and the post-swap `.inner-content` in '
      + 'star-border.css no longer paint the same box. star-border.js replaces one element with '
      + 'the other one to two seconds after the homepage opens, so any difference here is a '
      + 'recolour and a jump the user watches happen. Change index.css to match star-border.css '
      + '(the settled look is the intended one), not the other way round.',
  );
});

test('no sheet gives .stat-pill a shadow or a backdrop blur', () => {
  // Both are absent from `.inner-content`, so either one is a visible change at the swap.
  // Scanned across all three sheets because the declarations this replaced lived in the
  // hero's own sheet (carousel.css at the time, hero-picker.css now): index.css never
  // declared backdrop-filter, so deleting it there would have left that copy winning.
  const banned = /^(box-shadow|backdrop-filter|-webkit-backdrop-filter)$/;
  /** @type {string[]} */
  const offenders = [];
  let seen = 0;
  for (const [name, src] of [['index.css', INDEX], ['hero-picker.css', HERO_SHEET], ['star-border.css', STAR]]) {
    for (const region of regions(src)) {
      for (const block of blocksFor(region.css, '.stat-pill')) {
        seen += 1;
        for (const prop of decls(block).keys()) {
          if (banned.test(prop)) offenders.push(`${name} ${region.at}: .stat-pill { ${prop} }`);
        }
      }
    }
  }
  assert.ok(
    seen >= 2,
    `found ${seen} \`.stat-pill\` rules across the three sheets (expected at least the base one `
      + 'and the <=768px one) — this guard has gone blind',
  );
  assert.deepEqual(
    offenders,
    [],
    'A shadow or a backdrop blur is back on .stat-pill. `.inner-content` has neither, so it '
      + 'vanishes the moment star-border.js swaps the element. The blur is also pure cost: the '
      + 'pill background is now the opaque var(--brand), so nothing shows through it, while '
      + 'backdrop-filter still makes a backdrop root that re-snapshots over the fixed autoplaying '
      + '#background-video every frame — the same call carousel.css already makes for '
      + '.carousel-item.',
  );
});

test('the fallback reserves the ring band, from the one token the ring itself uses', () => {
  const top = topLevel(INDEX);
  const owner = blocksFor(top, '.stats-pills');
  const pill = blocksFor(top, '.stat-pill');
  const ring = blocksFor(top, '.stats-pills .star-border-container');

  assert.equal(owner.length, 1, 'expected one `.stats-pills` rule in index.css — this guard has gone blind');
  assert.equal(pill.length, 1, 'expected one top-level `.stat-pill` rule in index.css — this guard has gone blind');
  assert.equal(
    ring.length,
    1,
    '`.stats-pills .star-border-container` is gone from index.css. The glow ring band is back to '
      + 'an inline style written by star-border.js, which no stylesheet can override and nothing '
      + "can keep in step with .stat-pill's margin below.",
  );

  assert.ok(
    decls(owner[0]).has(RING),
    `${RING} must be DEFINED on .stats-pills. Both rules below reference it, and a var() that `
      + 'resolves to nothing drops its whole declaration silently — .stat-pill would fall back to '
      + 'margin 0 and the 14px jump would be back with no error anywhere.',
  );
  assert.equal(
    decls(pill[0]).get('margin'),
    value(`var(${RING}) 0`),
    `.stat-pill must reserve the ring band with \`margin: var(${RING}) 0\`. Margin, not padding: `
      + '.stat-pill carries a background and padding would paint var(--brand) across the band the '
      + 'animated glow needs to show through. A literal instead of the token re-opens the drift '
      + 'this token exists to close.',
  );
  assert.equal(
    decls(ring[0]).get('padding'),
    value(`var(${RING}) 0`),
    `.star-border-container must take its band from the same ${RING} token. If the two sides stop `
      + 'reading one value they can differ, which is a jump at the swap by definition.',
  );
});

test('the hero sheet carries no second copy of the pill rules', () => {
  // carousel.css used to carry a near-complete stale duplicate of all four selectors plus
  // <=768 and <=480 blocks. index.css shadowed almost all of it, which is why nobody
  // noticed — but `backdrop-filter` and `box-shadow` were only ever declared there, so
  // index.css could not remove them. A duplicate is not a style question here; it is how
  // the fix is undone. hero-picker.css inherits the risk along with the slot.
  /** @type {string[]} */
  const offenders = [];
  for (const region of regions(HERO_SHEET)) {
    for (const sel of ['.stats-pills', '.stat-pill', '.stat-pill-number', '.stat-pill-text']) {
      if (blocksFor(region.css, sel).length) offenders.push(`hero-picker.css ${region.at}: ${sel}`);
    }
  }
  assert.ok(
    blocksFor(topLevel(HERO_SHEET), '.hp-frame').length > 0,
    'hero-picker.css no longer defines .hp-frame — this guard is reading the wrong file',
  );
  assert.deepEqual(
    offenders,
    [],
    'hero-picker.css has grown a copy of the hero stat-pill rules again. index.css is their '
      + 'sole owner: it loads after hero-picker.css and shadows it at equal specificity, so a '
      + 'second copy is invisible until it declares something index.css does not — which is '
      + 'precisely how an unused backdrop-filter survived on these pills.',
  );
});

/**
 * The winning value of one property for one selector across a set of rules, i.e. the last
 * one declared. Written against the effective value rather than against "the two
 * selectors are grouped in one rule", because the grouping is a nicety and the equality
 * is the invariant — splitting the group back into two rules is fine, letting them differ
 * is not.
 *
 * @param {string[]} blocks
 * @param {string} prop
 * @returns {string | undefined}
 */
function winning(blocks, prop) {
  let out;
  for (const b of blocks) {
    const v = decls(b).get(prop);
    if (v !== undefined) out = v;
  }
  return out;
}

test('at <=768px the fallback and the settled body still agree', () => {
  // Both @media (max-width: 768px) blocks in index.css, since the pills' one is the
  // second — see mediaRegions.
  const mobile = mediaRegions(INDEX, /max-width:\s*768px/);
  const pill = blocksFor(mobile, '.stat-pill');
  const inner = blocksFor(mobile, '.stats-pills .inner-content');

  assert.ok(pill.length >= 1, 'no `.stat-pill` rule at <=768px in index.css — this guard has gone blind');
  assert.ok(
    inner.length >= 1,
    'index.css no longer trims `.stats-pills .inner-content` at <=768px, so star-border.css\'s own '
      + '6px/12px takes over and the settled pill grows away from the fallback.',
  );

  const settled = winning(inner, 'padding');
  const fallback = winning(pill, 'padding');
  assert.ok(settled, 'the <=768px `.stats-pills .inner-content` rule declares no padding');
  assert.ok(fallback, 'no <=768px `.stat-pill` rule declares padding, so the desktop 8px/16px applies on phones');
  assert.equal(
    fallback,
    settled,
    'At <=768px the pre-swap `.stat-pill` and the post-swap `.stats-pills .inner-content` have '
      + 'different padding, so star-border.js mounting is a visible jump on phones as well as on '
      + 'desktop. Note the desktop rules do NOT cover this: the mobile block overrides padding on '
      + 'both, and it has to override them by the same amount.',
  );

  // The ring band is inherited from the base rule and deliberately not restated here. If
  // anyone does restate it, it still has to be the token.
  const band = winning(pill, 'margin');
  assert.ok(
    band === undefined || band === value(`var(${RING}) 0`),
    `a <=768px .stat-pill rule overrides margin with \`${band}\`; the ring band must stay var(${RING})`,
  );
});
