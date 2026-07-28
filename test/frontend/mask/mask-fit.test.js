// Tier: frontend island logic (DOM-shimmed) — public/scripts/mask/fit.js.
//
// This module sizes the mask-editor canvases, and it exists because of a bug that
// shipped: the original code handed the image a FLAT FRACTION of the viewport
// height and let flex sort out the rest. The header, tool row, brush slider,
// prompt, reference block and buttons need ~300px more than that leaves, and the
// dialog is capped near the viewport height, so the column overflowed. In the AI
// Designer the canvas container is `overflow: hidden`, which drops a flex item's
// automatic minimum size to 0 — flex silently shrank the image BOX while the
// canvas kept its explicit pixel height, and the photo was CLIPPED. In the stage
// editor the content scrolls instead, so the prompt field and the Apply button
// ended up below the fold. Neither throws. Both are invisible to any assertion
// that only checks "a size was set".
//
// So the assertions here are about the INVARIANT the rewrite buys, not the
// arithmetic: chrome + image must fit the height budget, measured at the width the
// image actually ends up at. The "hugging dialog" case below is the exact shape
// that defeats a single measuring pass — a narrower image means a narrower dialog
// means re-wrapped rows means TALLER chrome — and a one-pass implementation
// overshoots it by 80px, which is precisely the clipping that shipped.
//
// The DOM is a hand-rolled shim (house style — see test/helpers/mask-dom.js for the
// same note). It models inline styles and one measurement hook, not layout: it can
// prove "the module asked for a box that fits", never "the box fits on a screen".
// Real geometry is e2e's job (e2e/stage-mask-*.spec.js).

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createMaskFit } from '../../../public/scripts/mask/fit.js';

// ── shim ───────────────────────────────────────────────────────────────────────

/** A style bag that reports '' for anything never set, like a real CSSStyleDeclaration. */
const styleBag = () => new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : ''),
  set: (t, k, v) => { t[k] = v; return true; },
});

// Captured once, at module load. Several cases build two fixtures to compare them,
// and re-reading the globals inside fixture() would save the FIRST fixture's shims
// as if they were the originals — the restore below would then leak them into every
// later case.
const REAL = {
  window: globalThis.window,
  getComputedStyle: globalThis.getComputedStyle,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
};
afterEach(() => { Object.assign(globalThis, REAL); });

/**
 * `chrome` is the height of everything except the image, as a function of the
 * image width — a dialog that hugs its content re-wraps its rows as it narrows.
 *
 * @param {{
 *   chrome?: (width: number) => number,
 *   viewportW?: number, viewportH?: number,
 *   mobile?: boolean, active?: boolean,
 *   padding?: number, border?: number,
 *   visualViewport?: { width: number, height: number } | null,
 * }} opts
 */
function fixture({
  chrome = () => 300,
  viewportW = 1200,
  viewportH = 900,
  mobile = false,
  active = true,
  padding = 20,
  border = 0,
  visualViewport = null,
} = {}) {
  const container = { style: styleBag() };
  const canvases = [{ style: styleBag() }, { style: styleBag() }];
  let measurements = 0;

  const content = {
    style: styleBag(),
    getBoundingClientRect() {
      measurements += 1;
      // The real thing reports the whole column: chrome at the current image
      // width, plus whatever height the image container is currently claiming.
      const w = parseFloat(String(container.style.width)) || 0;
      const h = parseFloat(String(container.style.height)) || 0;
      return { height: chrome(w) + h };
    },
  };

  const modalClasses = new Set(active ? ['active'] : []);
  const modal = {
    classList: { contains: (n) => modalClasses.has(n) },
    querySelector: (sel) => (sel === '.content' ? content : sel === '.container' ? container : null),
    querySelectorAll: (sel) => (sel === 'canvas' ? canvases : []),
  };

  const winListeners = new Map();
  const vvListeners = new Map();
  const listenerStore = (map) => ({
    addEventListener: (t, fn) => { if (!map.has(t)) map.set(t, []); map.get(t).push(fn); },
    removeEventListener: (t, fn) => {
      const l = map.get(t) || []; const i = l.indexOf(fn); if (i !== -1) l.splice(i, 1);
    },
    count: (t) => (map.get(t) || []).length,
    fire: (t) => (map.get(t) || []).slice().forEach((fn) => fn()),
  });
  const winEvents = listenerStore(winListeners);
  const vvEvents = visualViewport ? listenerStore(vvListeners) : null;

  const vv = visualViewport
    ? { ...visualViewport, addEventListener: vvEvents.addEventListener, removeEventListener: vvEvents.removeEventListener }
    : null;

  globalThis.window = {
    innerWidth: viewportW,
    innerHeight: viewportH,
    visualViewport: vv,
    matchMedia: (q) => ({ matches: mobile && /max-width/.test(q), media: q }),
    addEventListener: winEvents.addEventListener,
    removeEventListener: winEvents.removeEventListener,
  };
  globalThis.getComputedStyle = (el) => (/** @type {unknown} */ (el) === content
    ? { paddingLeft: `${padding}px`, paddingRight: `${padding}px`, borderLeftWidth: '0px', borderRightWidth: '0px' }
    : { paddingLeft: '0px', paddingRight: '0px', borderLeftWidth: `${border}px`, borderRightWidth: `${border}px` });

  // A manual rAF queue: nothing runs until flushRaf() is called, which is what
  // makes "the burst coalesced into one fit" observable.
  const frames = new Map();
  let frameSeq = 0;
  globalThis.requestAnimationFrame = (fn) => { frames.set(++frameSeq, fn); return frameSeq; };
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };

  const make = (config = {}) => createMaskFit({
    getModal: () => modal,
    contentSelector: '.content',
    containerSelector: '.container',
    canvasSelector: 'canvas',
    ...config,
  });

  return {
    make, modal, content, container, canvases, winEvents, vvEvents,
    size: () => ({
      width: parseFloat(String(canvases[0].style.width)),
      height: parseFloat(String(canvases[0].style.height)),
    }),
    measurements: () => measurements,
    pendingFrames: () => frames.size,
    flushRaf: () => { const q = [...frames.values()]; frames.clear(); q.forEach((fn) => fn()); },
    setActive: (on) => { if (on) modalClasses.add('active'); else modalClasses.delete('active'); },
  };
}

// Defaults from the module's own doc block, restated so the expectations below are
// checkable by hand rather than by re-running the implementation.
const boxHeight = (viewportH = 900, heightShare = 0.9, padding = 20) =>
  Math.min(viewportH * heightShare, viewportH - padding * 2);

// ── the bug this module was written to fix ─────────────────────────────────────

test('a hugging dialog: the image is sized against the chrome at its FINAL width, not its first', () => {
  // The shape that defeats one measuring pass. Chrome is 300px while the image is
  // wide, but re-wraps to 380px once the dialog narrows — and this image is tall
  // enough that it always narrows.
  const f = fixture({ chrome: (w) => (w >= 900 ? 300 : 380) });
  const fit = f.make();
  fit.setImage(4000, 3000);
  fit.fit();

  const { width, height } = f.size();
  const boxH = boxHeight(); // 810

  // A single-pass implementation measures 300px of chrome, hands the image 510px,
  // and the re-wrapped 380px chrome then pushes the column to 890px — 80px past
  // the budget. That overflow is the clipping that shipped.
  assert.notEqual(height, 510, 'sized against the chrome measured before the dialog narrowed');
  assert.equal(height, 430);
  assert.ok(
    height + 380 <= boxH,
    `image ${height}px + re-wrapped chrome 380px must fit the ${boxH}px budget`,
  );
  assert.ok(width < 900, 'this image does narrow the dialog — otherwise the case is vacuous');
});

test('chrome + image fits the height budget for every chrome shape', () => {
  // The invariant, stated once over several dialog shapes. Not arithmetic: any
  // implementation that measures honestly satisfies it; the flat-fraction one
  // fails the tall-chrome rows.
  const shapes = [
    { name: 'fixed-width dialog', chrome: () => 300 },
    { name: 'tall chrome', chrome: () => 520 },
    { name: 'chrome that grows as the dialog narrows', chrome: (w) => (w >= 900 ? 240 : 400) },
    // Two re-wrap thresholds. This one needs genuine iteration: measure once and
    // apply a single correction and the image lands at a width whose chrome is
    // 300px taller again, overflowing by 267px.
    { name: 'chrome that grows twice', chrome: (w) => (w >= 1000 ? 200 : w >= 700 ? 300 : 600) },
  ];
  for (const shape of shapes) {
    const f = fixture({ chrome: shape.chrome });
    const fit = f.make();
    fit.setImage(4000, 3000);
    fit.fit();
    const { width, height } = f.size();
    const boxH = boxHeight();
    const floorH = Math.max(120, boxH * 0.3);
    const budget = Math.max(floorH, boxH - shape.chrome(width));
    assert.ok(
      height <= budget + 1,
      `${shape.name}: image ${height}px exceeds the ${Math.round(budget)}px left by ${shape.chrome(width)}px of chrome`,
    );
  }
});

// ── the floor: a mask you cannot see is worse than a dialog you scroll ─────────

test('chrome taller than the whole dialog does not collapse the image to nothing', () => {
  const f = fixture({ chrome: () => 800 }); // more chrome than the 810px budget
  const fit = f.make();
  fit.setImage(2000, 1000);
  fit.fit();

  const { width, height } = f.size();
  assert.equal(height, Math.round(boxHeight() * 0.3), 'desktop floor is 30% of the budget');
  assert.ok(height >= 120, 'and never below the absolute 120px minimum');
  assert.ok(width > 0 && Number.isFinite(width));
});

test('on mobile the image keeps half the viewport, because those layouts scroll', () => {
  const f = fixture({ chrome: () => 800, mobile: true });
  const fit = f.make();
  fit.setImage(2000, 1000);
  fit.fit();
  assert.equal(f.size().height, 450, 'half of the 900px viewport, not the 30% desktop share');
});

// ── proportions ────────────────────────────────────────────────────────────────

test('the photo is never stretched — both axes scale together', () => {
  for (const [nw, nh] of [[4000, 3000], [1000, 2500], [2000, 1000]]) {
    const f = fixture({ chrome: () => 420 });
    const fit = f.make();
    fit.setImage(nw, nh);
    fit.fit();
    const { width, height } = f.size();
    assert.ok(
      Math.abs(width / height - nw / nh) < 0.02,
      `${nw}x${nh} was rendered at ${width}x${height} — aspect ratio drifted`,
    );
  }
});

test('a small image is shown at its natural size, never blown up to fill the box', () => {
  const f = fixture();
  const fit = f.make();
  fit.setImage(240, 120);
  fit.fit();
  assert.deepEqual(f.size(), { width: 240, height: 120 });
});

test('both canvases get the same size — the mask must land on the photo', () => {
  const f = fixture({ chrome: () => 300 });
  const fit = f.make();
  fit.setImage(4000, 3000);
  fit.fit();
  assert.deepEqual(f.canvases[1].style.width, f.canvases[0].style.width);
  assert.deepEqual(f.canvases[1].style.height, f.canvases[0].style.height);
});

test("maxContentWidth honours the stage editor's 920px cap", () => {
  // The AI Designer is 90vw; the stage editor is min(920px, 100%). Same module,
  // different CSS regime — that is why the caps are parameters.
  const wide = fixture({ chrome: () => 300 });
  const wideFit = wide.make();
  wideFit.setImage(4000, 1000);
  wideFit.fit();

  const capped = fixture({ chrome: () => 300 });
  const cappedFit = capped.make({ modalPadding: 16, maxContentWidth: 920, heightShare: 1 });
  cappedFit.setImage(4000, 1000);
  cappedFit.fit();

  assert.ok(capped.size().width <= 920 - 40, 'the 920px content cap must bind');
  assert.ok(capped.size().width < wide.size().width, 'the uncapped dialog is genuinely wider');
});

// ── measurement must not leave a mark ──────────────────────────────────────────

test('measuring the chrome restores the container inline styles it borrowed', () => {
  // chromeHeightAt collapses the container to 0px to weigh everything else. If it
  // failed to put the previous values back, the image container would be left
  // 0px high — a blank dialog, with no error anywhere.
  const f = fixture();
  f.container.style.width = '640px';
  f.container.style.height = '480px';
  const fit = f.make();
  fit.setImage(2000, 1000);
  fit.fit();
  assert.equal(f.container.style.width, '640px');
  assert.equal(f.container.style.height, '480px');
});

test('measuring an untouched container leaves it untouched', () => {
  const f = fixture();
  const fit = f.make();
  fit.setImage(2000, 1000);
  fit.fit();
  assert.equal(f.container.style.width, '', 'a never-set inline style must stay unset');
  assert.equal(f.container.style.height, '');
});

// ── when not to do anything ────────────────────────────────────────────────────

test('a closed dialog is not sized', () => {
  const f = fixture({ active: false });
  const fit = f.make();
  fit.setImage(2000, 1000);
  fit.fit();
  assert.equal(f.canvases[0].style.width, '', 'nothing written while the modal is inactive');
  assert.equal(f.canvases[0].style.height, '');
  assert.equal(f.measurements(), 0, 'and no forced reflow either');
});

test('fitting before an image is known is a no-op, not a division by zero', () => {
  const f = fixture();
  const fit = f.make();
  fit.fit();
  assert.equal(f.canvases[0].style.width, '');
  fit.setImage(0, 0);
  fit.fit();
  assert.equal(f.canvases[0].style.width, '', 'a 0x0 image must not produce NaNpx');
});

// ── resize wiring ──────────────────────────────────────────────────────────────

test('a burst of resize events costs one reflow, not one per event', () => {
  // Drag-resizing a window, or the mobile URL bar collapsing, fires resize
  // continuously. Each fit() is several forced reflows, so they are coalesced
  // into one animation frame.
  const f = fixture({ visualViewport: { width: 1200, height: 900 } });
  const fit = f.make();
  fit.setImage(2000, 1000);
  fit.bind();

  f.winEvents.fire('resize');
  f.winEvents.fire('resize');
  f.vvEvents.fire('resize');
  assert.equal(f.measurements(), 0, 'nothing runs until the frame does');
  assert.equal(f.pendingFrames(), 1, 'three events, one pending frame');

  f.flushRaf();
  assert.ok(f.measurements() > 0, 'and then it fits exactly once');
  assert.ok(f.size().width > 0);
});

test('bind is idempotent, so re-opening the dialog does not stack handlers', () => {
  const f = fixture({ visualViewport: { width: 1200, height: 900 } });
  const fit = f.make();
  fit.bind();
  fit.bind();
  fit.bind();
  assert.equal(f.winEvents.count('resize'), 1);
  assert.equal(f.vvEvents.count('resize'), 1);
});

test('unbind removes both listeners and cancels a frame already queued', () => {
  // A fit() landing after the dialog closed writes sizes onto canvases of a
  // hidden modal — harmless-looking, and the reason the rAF id is tracked.
  const f = fixture({ visualViewport: { width: 1200, height: 900 } });
  const fit = f.make();
  fit.setImage(2000, 1000);
  fit.bind();
  f.winEvents.fire('resize');
  assert.equal(f.pendingFrames(), 1);

  fit.unbind();
  assert.equal(f.pendingFrames(), 0, 'the queued frame must be cancelled');
  assert.equal(f.winEvents.count('resize'), 0);
  assert.equal(f.vvEvents.count('resize'), 0);

  f.flushRaf();
  assert.equal(f.measurements(), 0, 'and nothing runs afterwards');
});

test('unbind before bind, and twice in a row, are both safe', () => {
  const f = fixture();
  const fit = f.make();
  fit.unbind();
  fit.bind();
  fit.unbind();
  fit.unbind();
  assert.equal(f.winEvents.count('resize'), 0);
});

test('the visual viewport wins over innerWidth/innerHeight when present', () => {
  // On mobile the visual viewport shrinks when the keyboard opens while
  // innerHeight does not; sizing off innerHeight puts the Apply button under the
  // keyboard.
  // Portrait on purpose: a landscape photo is width-bound, so it fits either way
  // and the case proves nothing. Only a tall image is bound by the height that
  // differs (visual 400px vs layout 900px).
  const f = fixture({ chrome: () => 200, visualViewport: { width: 600, height: 400 } });
  const fit = f.make();
  fit.setImage(1000, 2000);
  fit.fit();
  const { width, height } = f.size();
  assert.ok(height <= 400, `sized ${height}px against a 400px visual viewport`);
  assert.ok(width > 0 && height > 0);

  // And the same for the width, which needs a wide photo to be the binding axis.
  const wide = fixture({ chrome: () => 200, visualViewport: { width: 600, height: 400 } });
  const wideFit = wide.make();
  wideFit.setImage(4000, 1000);
  wideFit.fit();
  assert.ok(wide.size().width <= 600, `sized ${wide.size().width}px against a 600px visual viewport`);
});
