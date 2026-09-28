// Tier: frontend island logic (DOM-stubbed) — public/scripts/home/home-review-stars.js.
//
// The home outro's "Leave a Google review" link grows its five stars in a 0.06s-per-star
// wave. The module's whole job is deciding where that wave STARTS: it writes each star's
// distance in positions from the star nearest the cursor into `--qr-star-step`, and
// home.css multiplies that by 0.06s.
//
// WHAT THESE TESTS EXIST TO CATCH. Two earlier cuts of this module looked right in review
// and still ran left to right on every real hover:
//
//   - Reading the cursor on `pointerenter` is not enough. That event fires as the cursor
//     crosses the link's EDGE, and the link is the last item in its row, so the reported
//     position is the first star however the visitor was aiming. The module therefore
//     pins the stars at rest (inline scale, which outranks the stylesheet) and releases
//     the wave from wherever the cursor is SETTLE_MS later. The hold is the fix, so the
//     hold is what is pinned here.
//   - The wave is asked for once per hover. Re-aiming it when the cursor moves on means
//     dropping grown stars back to rest so they can grow again, which reads as the link
//     flickering; the stars stay up instead.
//   - The hold has to end. Restarting the settle timer on every pointermove sounds right
//     and is not: a hand at rest still produces a pixel of tremor several times a second,
//     so the wave was pushed back indefinitely and the stars sat dead for about a second.
//     Tremor under JITTER_PX counts as stillness. That is the third test below.
//
// Fake DOM rather than jsdom (there is none in this repo) — same approach as
// home-whyus.test.js — plus a drift guard over the real markup and stylesheet, because
// the module and the CSS each look perfectly fine alone while the effect is dead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The module runs its init at eval time unless the document is still loading, so stub that
// before importing — the 'loading' branch only registers a listener.
globalThis.document = /** @type {any} */ ({ readyState: 'loading', addEventListener() {} });

const { initReviewStars } = await import('../../public/scripts/home/home-review-stars.js');

/** The settle delay inside the module, in ms. Ticked past, never waited on. */
const SETTLE_MS = 60;
/** The ceiling on the opening hold, measured from pointerenter. */
const MAX_HOLD_MS = 350;
/** Movement at or below this many pixels is treated as a resting hand. */
const JITTER_PX = 4;

// ---- Minimal fake DOM ------------------------------------------------------

/** Five 20px stars with 3px gaps, laid out from x=100: centres at 110, 133, 156, 179, 202. */
const LEFT = 100;
const PITCH = 23;

function mount({ stars = 5 } = {}) {
  const svgs = Array.from({ length: stars }, (_, i) => {
    /** @type {Record<string, string>} */
    const props = {};
    const left = LEFT + i * PITCH;
    return {
      props,
      style: {
        setProperty: (/** @type {string} */ k, /** @type {string} */ v) => { props[k] = v; },
        removeProperty: (/** @type {string} */ k) => { delete props[k]; },
        // Plain properties (`style.scale = '1'`) land on this object directly; mirror them
        // into `props` so one assertion helper can read either kind.
        set transition(/** @type {string} */ v) { props.transition = v; },
        set scale(/** @type {string} */ v) { props.scale = v; },
      },
      getBoundingClientRect: () => ({ left, right: left + 20 }),
    };
  });

  /** @type {Record<string, Function[]>} */
  const handlers = {};
  /** Counts the forced reflow reads, i.e. how many waves have been released. */
  const flushes = { count: 0 };
  const link = {
    flushes,
    get offsetWidth() { flushes.count += 1; return 220; },
    addEventListener: (/** @type {string} */ t, /** @type {Function} */ fn) => {
      (handlers[t] ||= []).push(fn);
    },
    querySelectorAll: (/** @type {string} */ sel) => (sel === '.qr__stars svg' ? svgs : []),
    fire: (/** @type {string} */ t, /** @type {object} */ ev = {}) => {
      for (const fn of handlers[t] || []) fn(ev);
    },
  };

  globalThis.document = /** @type {any} */ ({
    readyState: 'complete',
    addEventListener() {},
    querySelector: (/** @type {string} */ sel) => (sel === '.qr__review' ? link : null),
  });
  return { link, svgs };
}

/** The `--qr-star-step` currently written on each star, as numbers (NaN when unset). */
const steps = (/** @type {any[]} */ svgs) => svgs.map((s) => Number(s.props['--qr-star-step']));

/** True when every star is pinned at rest by an inline scale the stylesheet cannot beat. */
const held = (/** @type {any[]} */ svgs) =>
  svgs.every((s) => s.props.scale === '1' && s.props.transition === 'none');

/** True when no inline animation state is left behind for the stylesheet to fight. */
const released = (/** @type {any[]} */ svgs) =>
  svgs.every((s) => !('scale' in s.props) && !('transition' in s.props));

/** The horizontal centre of star `i` in the fake layout. */
const centreOf = (/** @type {number} */ i) => LEFT + i * PITCH + 10;

// ---- 1. The wave starts where the cursor settles, not where it entered ------

test('approaching from the left and stopping on the middle star ripples outward', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { link, svgs } = mount();
  initReviewStars();

  // The sequence a real cursor produces: the enter event reports the LEFT EDGE, because
  // that is the boundary being crossed, and the aimed-at star only shows up in the moves
  // that follow. Two earlier cuts read the first number and always waved left to right.
  link.fire('pointerenter', { clientX: LEFT });
  link.fire('pointermove', { clientX: centreOf(2) });
  assert.ok(held(svgs), 'the stars must stay at rest until the cursor settles');
  assert.deepEqual(steps(svgs).map(Number.isNaN), [true, true, true, true, true]);

  t.mock.timers.tick(SETTLE_MS + 1);
  assert.deepEqual(steps(svgs), [2, 1, 0, 1, 2]);
  assert.ok(released(svgs), 'the hold must be let go so the hover rule can grow the stars');
});

test('settling on the label, past the last star, ripples right to left', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { link, svgs } = mount();
  initReviewStars();

  link.fire('pointerenter', { clientX: LEFT });
  link.fire('pointermove', { clientX: 400 });
  t.mock.timers.tick(SETTLE_MS + 1);

  assert.deepEqual(steps(svgs), [4, 3, 2, 1, 0]);
});

test('stopping on the first star still gives the left-to-right wave', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { link, svgs } = mount();
  initReviewStars();

  link.fire('pointerenter', { clientX: LEFT });
  t.mock.timers.tick(SETTLE_MS + 1);

  assert.deepEqual(steps(svgs), [0, 1, 2, 3, 4]);
});

test('a cursor in the gap between two stars resolves to the nearer one', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { link, svgs } = mount();
  initReviewStars();

  // The 3px gaps are not inside any star. Nearest-centre means they still pick an origin
  // instead of silently falling back to star 1 — this x sits in the gap between stars 3
  // and 4, a shade past the midpoint of their centres.
  link.fire('pointerenter', { clientX: LEFT + 3 * PITCH - 1 });
  t.mock.timers.tick(SETTLE_MS + 1);

  assert.deepEqual(steps(svgs), [3, 2, 1, 0, 1]);
});

test('tremor on the target star does not postpone the wave', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { link, svgs } = mount();
  initReviewStars();

  // THE BUG THIS PINS. Every move used to re-arm the release, so the 1px wobble of a hand
  // holding still pushed the wave back for as long as the cursor stayed there — which is
  // the "it takes about a second before they start" this replaced.
  link.fire('pointerenter', { clientX: LEFT });
  link.fire('pointermove', { clientX: centreOf(2) });
  for (let i = 0; i < 12; i += 1) {
    // Alternating +/- half the threshold: consecutive moves differ by JITTER_PX exactly,
    // which is the most a resting hand is allowed to wobble.
    link.fire('pointermove', { clientX: centreOf(2) + (i % 2 ? JITTER_PX / 2 : -JITTER_PX / 2) });
    t.mock.timers.tick(16);
  }

  assert.equal(link.flushes.count, 1, 'the wave must go off while the hand is still shaking');
  assert.deepEqual(steps(svgs), [2, 1, 0, 1, 2]);
});

test('a cursor still travelling pushes the wave ahead of itself', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { link, svgs } = mount();
  initReviewStars();

  // Real movement is the opposite case: releasing mid-journey fires the wave from a star
  // the cursor is only passing over, and then has to replay when it finally stops.
  link.fire('pointerenter', { clientX: LEFT });
  for (let x = LEFT; x < centreOf(4); x += 12) {
    link.fire('pointermove', { clientX: x });
    t.mock.timers.tick(20); // inside SETTLE_MS, and the whole trip inside MAX_HOLD_MS
  }
  assert.equal(link.flushes.count, 0, 'nothing should have been released yet');

  link.fire('pointermove', { clientX: centreOf(4) });
  t.mock.timers.tick(SETTLE_MS + 1);
  assert.equal(link.flushes.count, 1);
  assert.deepEqual(steps(svgs), [4, 3, 2, 1, 0]);
});

test('a cursor that crosses without ever stopping still gets its wave', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { link } = mount();
  initReviewStars();

  // The backstop. Pushing the release ahead of a moving cursor cannot mean never.
  link.fire('pointerenter', { clientX: LEFT });
  for (let elapsed = 0; elapsed <= MAX_HOLD_MS + 40; elapsed += 20) {
    link.fire('pointermove', { clientX: LEFT + elapsed / 4 });
    t.mock.timers.tick(20);
  }

  assert.equal(link.flushes.count, 1, 'the opening hold must be capped at MAX_HOLD_MS');
});

test('crossing the whole row releases one wave, at the far end', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { link, svgs } = mount();
  initReviewStars();

  link.fire('pointerenter', { clientX: LEFT });
  for (let i = 1; i <= 4; i += 1) {
    link.fire('pointermove', { clientX: centreOf(i) });
    t.mock.timers.tick(20); // faster than the settle, as a real sweep is
  }
  t.mock.timers.tick(SETTLE_MS + 1);

  assert.equal(link.flushes.count, 1, 'one wave, not one per star crossed');
  assert.deepEqual(steps(svgs), [4, 3, 2, 1, 0]);
});

// ---- 2. Once the wave has run, it is done ---------------------------------

test('moving between the stars afterwards leaves them grown', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { link, svgs } = mount();
  initReviewStars();

  link.fire('pointerenter', { clientX: LEFT });
  t.mock.timers.tick(SETTLE_MS + 1);
  assert.deepEqual(steps(svgs), [0, 1, 2, 3, 4]);

  // Wandering across the row must not take the stars back down to rest — an inline hold
  // here is exactly the flicker this behaviour exists to avoid.
  for (let i = 1; i <= 4; i += 1) {
    link.fire('pointermove', { clientX: centreOf(i) });
    t.mock.timers.tick(SETTLE_MS + 1);
    assert.ok(released(svgs), 'the stars must never be pinned back to rest mid-hover');
  }

  assert.equal(link.flushes.count, 1, 'one wave per hover, whatever the cursor does after');
  assert.deepEqual(steps(svgs), [0, 1, 2, 3, 4], 'and it keeps the origin it was aimed at');
});

// ---- 3. Handing the defaults back ------------------------------------------

test('leaving clears every inline value, so a keyboard focus gets the CSS defaults', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { link, svgs } = mount();
  initReviewStars();

  link.fire('pointerenter', { clientX: 400 });
  t.mock.timers.tick(SETTLE_MS + 1);
  link.fire('pointermove', { clientX: centreOf(0) });
  link.fire('pointerleave', {});
  t.mock.timers.tick(SETTLE_MS + 1);


  // REMOVED, not zeroed: home.css authors 0..4 per nth-child, and a focus-visible wave
  // with no cursor must get those back rather than all five firing at once.
  for (const svg of svgs) {
    assert.equal('--qr-star-step' in svg.props, false);
  }
  assert.ok(released(svgs), 'a hold must never outlive the cursor — it would freeze the stars');
  assert.equal(link.flushes.count, 1, 'and no second wave was ever released');
});

test('leaving during the hold lets the stars go rather than pinning them at rest', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { link, svgs } = mount();
  initReviewStars();

  link.fire('pointerenter', { clientX: LEFT });
  assert.ok(held(svgs));
  link.fire('pointerleave', {});
  t.mock.timers.tick(SETTLE_MS + 1);

  assert.ok(released(svgs));
  assert.equal(link.flushes.count, 0, 'no wave was ever released');
});

// ---- 4. Absent markup is not an error --------------------------------------

test('a page without the review link wires nothing and does not throw', () => {
  globalThis.document = /** @type {any} */ ({
    readyState: 'complete',
    addEventListener() {},
    querySelector: () => null,
  });
  assert.doesNotThrow(() => initReviewStars());

  // And a link that somehow has no stars is skipped rather than half-wired.
  const { link } = mount({ stars: 0 });
  assert.doesNotThrow(() => initReviewStars());
  assert.doesNotThrow(() => link.fire('pointerenter', { clientX: 0 }));
});

// ---- 5. Drift guard over the real page -------------------------------------

test('index.html and home.css still hold up the two ends of --qr-star-step', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles', 'home.css'), 'utf8');

  const stars = html.match(/<span class="qr__stars"[\s\S]*?<\/span>/);
  assert.ok(stars, 'index.html no longer has a .qr__stars row');
  assert.equal(
    (stars[0].match(/<svg\b/g) || []).length,
    5,
    'the wave arithmetic and the CSS defaults below both assume five stars',
  );

  for (let i = 1; i <= 5; i += 1) {
    assert.match(
      css,
      new RegExp(`\\.qr__stars svg:nth-child\\(${i}\\)\\s*\\{[^}]*--qr-star-step:\\s*${i - 1}`),
      `home.css must author the no-JS default --qr-star-step: ${i - 1} for star ${i}`,
    );
  }
  assert.match(
    css,
    /transition-delay:\s*calc\(var\(--qr-star-step[^)]*\)\s*\*\s*0\.06s\)/,
    'home.css must still turn --qr-star-step into the hover transition-delay — without ' +
      'this rule the module writes a property nothing reads and the wave is gone',
  );
  // The module pins the stars with an inline `scale`, which only outranks the stylesheet
  // because the stylesheet animates `scale` too. A refactor back to `transform` would
  // leave the hold fighting a property nothing sets — and the hold is the whole fix.
  assert.match(
    css,
    /\.qr__review:hover \.qr__stars svg,[\s\S]{0,120}?scale:\s*1\.22/,
    'the hover rule must still grow the stars with `scale`, not `transform`',
  );
});
