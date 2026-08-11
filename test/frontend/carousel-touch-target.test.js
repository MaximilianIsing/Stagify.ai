// Tier: drift guard (static analysis of public/styles/carousel.css) — the hero carousel's
// indicator dots meet the 24px touch-target floor.
//
// WHAT THIS COVERS
// carousel.js paints the seven style dots as real <button>s (indicatorsMarkup, ~line 124).
// They shipped as 8x8 boxes inside a 150px row (120px on mobile), which put them at a
// ~13px pitch on desktop and ~10.7px on phones, and PageSpeed Insights flagged all seven
// under axe `target-size`: under 24x24, and too close together for WCAG 2.5.8's spacing
// exception as well, since 24px circles centred 13px apart overlap.
//
// The widening is not a style preference and this guard is not decoration. That geometry
// has now been changed in BOTH directions — widened once to 32x24, reverted for looking
// wrong beside the hero, and widened again here — and the stylesheet's own comment used to
// instruct readers to keep it tight. Nothing else stops a third round trip: the row is
// injected by JS so no HTML fixture shows it, and Playwright asserts that the row adopts,
// not how wide its buttons are.
//
// TWO SIZES, ONE FLOOR
// The hit box and the painted dot are set separately — `.carousel-indicator` is the target,
// `.carousel-indicator::before` is the paint. Only the first one is an accessibility
// concern. The shipped button is 32px, comfortably over the 24px floor, around a 12px dot;
// what this file defends is the FLOOR, so dropping to 24px is allowed and 23px is not.
//
// WHY THE ROW WIDTH IS COMPUTED, NOT WRITTEN DOWN
// 224px is only correct for SEVEN buttons at 32px. Both halves of that product can move
// independently — someone adds an eighth style to carousel.js, or trims the buttons back
// toward the floor — and either one leaves a row that looks deliberate and silently
// overlaps its own targets. So the requirement is derived: the item count is read out of
// carousel.js and multiplied by the button size the stylesheet actually declares.
//
// WHY A STATIC GUARD
// There is no jsdom here, and the row does not exist in any HTML file to assert against —
// carousel.js builds it at runtime. Button geometry is a property of the stylesheet, so the
// stylesheet is what is checked. The rendered result is covered by the browser pass in the
// change's own verification, which a test cannot repeat without a real layout engine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'styles', 'carousel.css'), 'utf8');
const JS = fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'carousel.js'), 'utf8');

/** WCAG 2.5.8 (AA) minimum target edge, in px. */
const FLOOR = 24;

/** The painted dot, in px. A look, not an accessibility number — see the header. */
const DOT = 12;

/**
 * The sheet split into its top-level part plus one entry per `@media` block, with
 * `/* … *\/` comments removed FIRST.
 *
 * Stripping is mandatory, not tidiness — the same call test/frontend/hero-stat-pill-swap
 * .test.js makes over these sheets. The rules pinned below sit under a long comment that
 * spells out `8px`, `150px`, `120px`, `24px`, `168px`, `width` and `padding` in prose while
 * explaining the history. A scan of the raw text is satisfied by that prose with the
 * declarations DELETED, so an unstripped guard would be grading its own explanation.
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
 * Declaration blocks for an exact selector within one region.
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
 * Every declaration in a block, as name -> value.
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
    map.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim().replace(/\s+/g, ' '));
  }
  return map;
}

/**
 * A length in px, or null for anything this guard cannot reason about (a var(), a calc(),
 * a percentage). Null is treated as a FAILURE at every call site rather than skipped — an
 * unreadable width is exactly how a narrowing slips through a static check.
 *
 * @param {string | undefined} v
 * @returns {number | null}
 */
function px(v) {
  if (v === undefined) return null;
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(v.trim());
  return m ? Number(m[1]) : null;
}

/**
 * The winning value of one property across a set of blocks, i.e. the last declared.
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

/**
 * How many dots carousel.js actually builds, read from the `items` array it passes to the
 * Carousel constructor. This is what makes the row-width floor below self-correcting.
 *
 * @returns {number}
 */
function dotCount() {
  const open = JS.indexOf('const items = [');
  assert.notEqual(open, -1, 'carousel.js no longer declares `const items = [` — this guard has gone blind');
  const close = JS.indexOf('\n  ];', open);
  assert.notEqual(close, -1, 'could not find the end of carousel.js\'s items array — this guard has gone blind');
  const count = [...JS.slice(open, close).matchAll(/^\s*key:\s*'/gm)].length;
  assert.ok(count >= 2, `parsed ${count} carousel items — the item parser is broken, not the CSS`);
  return count;
}

/**
 * The declared button edge, which is both the thing checked against the floor and the
 * multiplier the row has to satisfy. Read once, used by two tests.
 *
 * @returns {{ width: number | null, height: number | null, size: number }}
 */
function buttonBox() {
  const blocks = blocksFor(regions(CSS)[0].css, '.carousel-indicator');
  assert.equal(
    blocks.length,
    1,
    `expected one top-level \`.carousel-indicator\` rule in carousel.css, found ${blocks.length} — this guard has gone blind`,
  );
  const rule = decls(blocks[0]);
  const width = px(rule.get('width'));
  const height = px(rule.get('height'));
  // The row only has to clear the widest thing in it, but an unreadable width must not
  // quietly relax the requirement to the floor — fall back UP, never down.
  return { width, height, size: Math.max(FLOOR, width ?? 0, height ?? 0) };
}

test('the indicator buttons are at least 24x24', () => {
  const blocks = blocksFor(regions(CSS)[0].css, '.carousel-indicator');
  const rule = decls(blocks[0]);
  // Anti-vacuity: an empty map has no width and no height, and a "must be >= 24" check
  // against `null` would still need the null branch below to fire. Current count is 11.
  assert.ok(rule.size >= 8, `parsed ${rule.size} declarations — the block parser is broken, not the CSS`);

  for (const prop of ['width', 'height']) {
    const value = px(rule.get(prop));
    assert.ok(
      value !== null && value >= FLOOR,
      `.carousel-indicator { ${prop}: ${rule.get(prop) ?? '(nothing)'} } — it must be at least ${FLOOR}px. `
        + 'These seven dots are the hero carousel\'s only discrete control and its only keyboard '
        + 'control (there are no prev/next arrows), so they are real targets and axe `target-size` '
        + 'fails the page under 24px. Note this is the FLOOR, not the shipped size: the button is '
        + '32px by choice. Shrinking it does not make the row look lighter either — the visible '
        + 'circle is painted by .carousel-indicator::before and is unaffected by this rule, so a '
        + 'row that reads too heavy is fixed there, and a row that reads too wide is a hero design '
        + 'question. Neither is a reason to go under the floor.',
    );
  }
});

test('the row is wide enough that the buttons do not overlap, at their declared size', () => {
  const dots = dotCount();
  const button = buttonBox().size;
  const needed = dots * button;
  const blocks = blocksFor(regions(CSS)[0].css, '.carousel-indicators');
  assert.equal(
    blocks.length,
    1,
    `expected one top-level \`.carousel-indicators\` rule in carousel.css, found ${blocks.length} — this guard has gone blind`,
  );
  const rule = decls(blocks[0]);

  const width = px(rule.get('width'));
  assert.ok(
    width !== null && width >= needed,
    `.carousel-indicators { width: ${rule.get('width') ?? '(nothing)'} } — with ${dots} buttons at `
      + `${button}px the row needs at least ${needed}px. Below that they overlap, which is not merely `
      + 'a size failure but takes the WCAG 2.5.8 spacing exception away too. Both factors move: if a '
      + 'style was added to carousel.js, widen the row to match; if the buttons were made bigger, '
      + 'widen it by that much. Shrinking the buttons back toward 24px is the other legal fix.',
  );

  // Side padding subtracts from the same budget: the row shipped as `width:150px; padding:0 32px`,
  // i.e. 86px of usable track behind a 150px number. Only a shorthand of `0` (or none) is
  // accepted rather than trying to parse arbitrary shorthands — a padded row should restate
  // its width instead, and this guard should fail loudly rather than guess.
  const padding = rule.get('padding');
  assert.ok(
    padding === undefined || /^0(px)?$/.test(padding),
    `.carousel-indicators { padding: ${padding} } — horizontal padding comes straight off the `
      + `${needed}px the dots need, so a padded row is narrower than its own width says. This is how `
      + 'the original 150px row only ever gave the dots 86px.',
  );
});

test('no media query narrows the row or the buttons back down', () => {
  const dots = dotCount();
  const base = buttonBox().size;
  const baseWidth = px(decls(blocksFor(regions(CSS)[0].css, '.carousel-indicators')[0]).get('width'));
  assert.ok(baseWidth, 'the base .carousel-indicators rule declares no px width — this guard has gone blind');

  /** @type {string[]} */
  const offenders = [];

  for (const region of regions(CSS).slice(1)) {
    // Each breakpoint is checked at its EFFECTIVE geometry — what it declares, or what it
    // inherits from the base rule where it declares nothing. Checking only the pairs that a
    // region happens to restate misses the two interesting one-sided cases: a region that
    // shrinks the buttons while inheriting a wide row (fine), and a region that GROWS them
    // while inheriting a row too narrow to hold them (an overlap the base rule cannot see).
    /** null until this region declares a size of its own; the base rule applies until then. */
    let declaredSize = null;
    for (const prop of ['width', 'height']) {
      const declared = winning(blocksFor(region.css, '.carousel-indicator'), prop);
      if (declared === undefined) continue;
      const value = px(declared);
      if (value === null || value < FLOOR) {
        offenders.push(`${region.at}: .carousel-indicator { ${prop}: ${declared} }`);
        continue;
      }
      declaredSize = Math.max(declaredSize ?? 0, value);
    }
    const size = declaredSize ?? base;

    const row = blocksFor(region.css, '.carousel-indicators');
    const declaredWidth = winning(row, 'width');
    let width = baseWidth;
    if (declaredWidth !== undefined) {
      width = px(declaredWidth) ?? 0;
      if (!width) offenders.push(`${region.at}: .carousel-indicators { width: ${declaredWidth} } is not a readable px value`);
    }

    const needed = dots * size;
    if (width && width < needed) {
      offenders.push(`${region.at}: row is ${width}px${declaredWidth === undefined ? ' (inherited)' : ''} but ${dots} buttons at ${size}px need ${needed}px`);
    }

    const padding = winning(row, 'padding');
    if (padding !== undefined && !/^0(px)?$/.test(padding)) {
      offenders.push(`${region.at}: .carousel-indicators { padding: ${padding} }`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'A media query has taken the indicator row or its buttons below the touch-target floor, or has '
      + 'narrowed the row past what its own buttons need. This is exactly what the deleted mobile '
      + 'clamp did — `width:120px; padding:0 24px` left ~10.7px of pitch, the worst offender in the '
      + `audit — and phones are the one place the floor matters most. The full ${dots * base}px row `
      + 'fits inside .carousel-container even at a 320px viewport, so no breakpoint needs a narrower '
      + 'one.',
  );
});

test('the dot is sized independently of the hit box, and the focus ring stays on it', () => {
  const top = regions(CSS)[0].css;

  const dot = blocksFor(top, '.carousel-indicator::before');
  assert.equal(dot.length, 1, 'expected one `.carousel-indicator::before` rule — this guard has gone blind');
  const painted = decls(dot[0]);
  const box = buttonBox().size;
  for (const prop of ['width', 'height']) {
    const value = px(painted.get(prop));
    assert.equal(
      value,
      DOT,
      `.carousel-indicator::before { ${prop}: ${painted.get(prop) ?? '(nothing)'} } — the painted dot is `
        + `${DOT}px. It is set here and NOWHERE else: this rule is the only thing that decides how heavy `
        + 'the row looks, and the button size is the only thing that decides where a tap lands. Change '
        + 'this one to restyle the row; changing it does not affect the touch target either way.',
    );
    assert.ok(
      value !== null && value < box,
      `the ${value}px dot has caught up with the ${box}px hit box. The hit box exists to be BIGGER than `
        + 'what it paints — once they are equal the extra target area is gone and the row is back to '
        + 'being as tappable as it looks, which is the bug this whole file exists to prevent.',
    );
  }

  // The ring belongs to the dot, not the hit box. On the button it would draw a halo wider
  // than the pitch, touching its neighbours — a visible regression from what shipped.
  assert.equal(
    winning(blocksFor(top, '.carousel-indicator:focus-visible'), 'outline'),
    'none',
    '`.carousel-indicator:focus-visible` must clear its own outline — the ring lives on '
      + `\`.carousel-indicator:focus-visible::before\` so it hugs the ${DOT}px dot rather than the `
      + `${box}px hit box.`,
  );
  const ring = blocksFor(top, '.carousel-indicator:focus-visible::before');
  assert.equal(
    ring.length,
    1,
    'There is no `.carousel-indicator:focus-visible::before` rule. The dots are focusable buttons, so '
      + 'removing the ring from the button without putting one on the pseudo leaves keyboard users with '
      + 'no focus indicator at all.',
  );
  assert.match(
    decls(ring[0]).get('outline') ?? '',
    /solid/,
    'the focus ring on `.carousel-indicator:focus-visible::before` is no longer a solid outline',
  );
});
