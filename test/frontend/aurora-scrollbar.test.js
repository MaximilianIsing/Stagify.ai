// Tier: unit — the geometry of the custom scrollbar's track and thumb.
//
// WHAT THIS COVERS
// `<main>` is the scroll container on this site, not the window: styles.css gives
// `body,html{height:100%}`, makes the body a flex column, and sets `main{flex:1}` +
// `body,main{overflow-y:auto}`. The sticky header and the shared <footer> are flow
// SIBLINGS of <main>, so main's border box is only the band between them — roughly
// [89, 831] on a 1440x900 viewport.
//
// aurora-scrollbar.js used to mirror that box exactly (`bar.style.height = r.height`),
// which put the bottom of the rail ~70px above the bottom of the window, level with
// the top of the footer. Scrolling to the very end therefore looked like it had
// stopped early: the thumb parked against a rail that ended in mid-air. The fix runs
// the TRACK down to the window's bottom edge while leaving the scroll container, the
// layout and the pinned footer exactly as they are — the footer stays outside <main>
// on purpose (see site-footer-parity.test.js).
//
// WHY A UNIT TEST AND NOT A RENDERED ONE
// There is no jsdom in this repo. The bar's position is a pure function of six
// numbers, so that function is exported and checked directly; the DOM plumbing
// around it (createElement, rAF loop, pointer drag) is the part e2e/eyes cover.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { auroraBarGeometry } from '../../public/scripts/aurora-scrollbar.js';

/** The shape every page with a header AND a footer has: main is the middle band. */
function withFooter(over = {}) {
  return {
    rectTop: 89, // below the sticky header
    rectRight: 1440,
    viewportW: 1440,
    viewportH: 900,
    clientH: 742, // main's own height — 900 - 89 header - 69 footer
    scrollH: 8800,
    scrollTop: 0,
    ...over,
  };
}

test('the track runs past the footer to the bottom of the window', () => {
  const g = auroraBarGeometry(withFooter());

  assert.equal(g.top, 89, 'the track still starts at main’s top, below the sticky header');
  assert.equal(g.height, 811, 'the track reaches y=900, the bottom of the window');

  // The regression, pinned explicitly: main's border box stops at the footer, and a
  // rail that stops with it is the reported "you cannot scroll all the way down".
  // Anyone "tidying" this back to `r.height` has to delete this line to do it.
  assert.notEqual(g.height, withFooter().clientH, 'the track must NOT mirror main’s own height');
  assert.equal(g.height - withFooter().clientH, 69, 'the extra span is exactly the footer band');
});

test('at the end of the scroll the thumb is flush with the bottom of the window', () => {
  const m = withFooter({ scrollTop: 8800 - 742 });
  const g = auroraBarGeometry(m);

  // top + thumbTop + thumbHeight === viewportH, i.e. the last pixel of the thumb is
  // the last pixel of the window. This is the thing the user actually sees.
  assert.equal(g.thumbTop + g.thumbHeight, g.height);
  assert.equal(g.top + g.thumbTop + g.thumbHeight, m.viewportH);
});

test('a page whose main already reaches the bottom is unchanged', () => {
  // gallery and the studios ship no shared footer, so main runs to the window's edge
  // already and `viewportH - rectTop` is just main's height. No-op by construction.
  const g = auroraBarGeometry(withFooter({ clientH: 811, scrollH: 4000 }));
  assert.equal(g.height, 811);
});

test('the bar hides when the content fits', () => {
  assert.equal(auroraBarGeometry(withFooter({ scrollH: 742 })).visible, false);
  assert.equal(auroraBarGeometry(withFooter({ scrollH: 743 })).visible, false, 'the 1px tolerance is kept');
  assert.equal(auroraBarGeometry(withFooter({ scrollH: 744 })).visible, true);
});

test('the bar sits on the scroll container’s right edge, never off-screen', () => {
  assert.equal(auroraBarGeometry(withFooter()).right, 0);
  // A narrower main (an inner-wrapper page is still full-width, but a rect can lag a
  // resize by a frame) offsets the bar rather than pushing it out of the window.
  assert.equal(auroraBarGeometry(withFooter({ rectRight: 1200 })).right, 240);
  assert.equal(auroraBarGeometry(withFooter({ rectRight: 1600 })).right, 0, 'clamped, not negative');
});

test('the thumb keeps its minimum height and never overflows a short track', () => {
  // 742/8800 of an 811px track is 68px, comfortably over the 40px floor.
  assert.equal(auroraBarGeometry(withFooter()).thumbHeight, 68);

  // A very long page would compute a sub-40px thumb; the floor wins.
  assert.equal(auroraBarGeometry(withFooter({ scrollH: 200000 })).thumbHeight, 40);

  // ...unless the track itself is shorter than the floor, in which case the thumb is
  // capped to the track so `height - thumbHeight` cannot go negative.
  const tiny = auroraBarGeometry(withFooter({ rectTop: 880, scrollH: 200000 }));
  assert.equal(tiny.height, 20);
  assert.equal(tiny.thumbHeight, 20);
  assert.equal(tiny.thumbTop, 0);
});

test('a scrollport pushed below the window degrades to zero, not to NaN', () => {
  const g = auroraBarGeometry(withFooter({ rectTop: 1200, scrollTop: 4000 }));
  assert.equal(g.height, 0);
  assert.equal(g.thumbHeight, 0);
  assert.equal(g.thumbTop, 0);
  for (const [k, v] of Object.entries(g)) {
    if (typeof v === 'number') assert.ok(Number.isFinite(v) && v >= 0, `${k} is ${v}`);
  }
});
