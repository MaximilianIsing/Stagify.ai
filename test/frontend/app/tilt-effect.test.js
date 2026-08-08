// Tier: frontend island logic (DOM-stubbed) — public/scripts/app/tilt-effect.js.
//
// The contact cards get a cursor-following 3D tilt. It is a HOVER effect, so on a touch
// device it is not merely useless — it is harmful: the synthetic mouseenter/mousemove
// pair a tap emits buys a forced layout read plus a transform write, and because no
// mouseleave follows a tap the card is left stuck mid-rotation. The inline transform it
// writes also outranks the `.contact-card:hover{transform:none}` phone rule in
// styles.css, so the deliberate "no card transform on phones" decision loses.
//
// What is asserted here is therefore stronger than "the tilt looks off on mobile": that
// ZERO listeners are attached, which is the only version of the fix that actually removes
// the work. A CSS gate would pass a visual check and fail this file.
//
// The positive cases (1 and 5) are load-bearing in the other direction — without them the
// gate assertions would still pass with the whole feature deleted.
//
// Exercised against a minimal fake DOM (no jsdom), matching the other island suites.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- Minimal fake DOM ------------------------------------------------------

/**
 * A `.contact-card` stand-in that records every listener it is given and can replay
 * them, so a test can assert both "nothing was attached" and "what was attached works".
 */
function makeCard() {
  /** @type {Record<string, Function[]>} */
  const handlers = {};
  return {
    handlers,
    style: /** @type {Record<string, string>} */ ({}),
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    getBoundingClientRect: () => ({ left: 100, top: 100, width: 200, height: 100 }),
    /** Count of listeners across every event type. */
    get listenerCount() { return Object.values(handlers).reduce((n, l) => n + l.length, 0); },
    /** Replay one event through every handler registered for it. */
    fire(type, event = {}) { for (const fn of handlers[type] || []) fn.call(this, event); },
  };
}

/**
 * Install a fake document/window with `count` contact cards.
 *
 * `media` maps a media-query string to whether it matches. Passing `null` omits
 * `matchMedia` from the window entirely — the "ancient/unknown browser" case.
 */
function mount({ media, count = 4 } = {}) {
  const cards = Array.from({ length: count }, makeCard);
  globalThis.document = /** @type {any} */ ({
    querySelectorAll: (sel) => (sel === '.contact-card' ? cards : []),
  });
  globalThis.window = /** @type {any} */ (
    media === null ? {} : { matchMedia: (q) => ({ matches: !!media[q] }) }
  );
  // Synchronous rAF: the module coalesces transform writes into one frame, and we want
  // that frame to have happened by the time fire() returns.
  globalThis.requestAnimationFrame = /** @type {any} */ ((fn) => { fn(); return 1; });
  globalThis.cancelAnimationFrame = /** @type {any} */ (() => {});
  return cards;
}

const HOVER = '(hover: hover) and (pointer: fine)';
const REDUCE = '(prefers-reduced-motion: reduce)';

/** A mouse-driven machine with animations allowed. */
const PC = { [HOVER]: true, [REDUCE]: false };

const { init3DTiltEffect } = await import('../../../public/scripts/app/tilt-effect.js');

// ---- 1. The effect still exists on a PC ------------------------------------

test('a fine-pointer device gets the tilt listeners on every contact card', () => {
  const cards = mount({ media: PC });
  init3DTiltEffect();

  for (const card of cards) {
    assert.deepEqual(
      Object.keys(card.handlers).sort(),
      ['mouseenter', 'mouseleave', 'mousemove'],
      'a PC should keep the full tilt',
    );
  }
});

// ---- 2-4. It does not exist anywhere else ----------------------------------

test('a touch device attaches no listeners at all', () => {
  // Both halves independently: a phone reports neither, but an iPad-class device with a
  // trackpad-ish pointer must still be excluded — it cannot hover, so it cannot aim this.
  for (const media of [
    { [HOVER]: false, [REDUCE]: false },
    { [HOVER]: false, [REDUCE]: true },
  ]) {
    const cards = mount({ media });
    init3DTiltEffect();
    for (const card of cards) {
      assert.equal(card.listenerCount, 0, 'touch must cost nothing, not merely look right');
    }
  }
});

test('prefers-reduced-motion suppresses the tilt on a PC', () => {
  const cards = mount({ media: { [HOVER]: true, [REDUCE]: true } });
  init3DTiltEffect();

  for (const card of cards) assert.equal(card.listenerCount, 0);
});

test('a window without matchMedia fails CLOSED', () => {
  // The opposite of ai-designer-gate.js, which fails open because it redirects. This
  // effect is decorative, so an unclassifiable device is better off without it.
  const cards = mount({ media: null });
  init3DTiltEffect();

  for (const card of cards) assert.equal(card.listenerCount, 0);
});

test('no contact cards on the page is a silent no-op', () => {
  mount({ media: PC, count: 0 });
  assert.doesNotThrow(() => init3DTiltEffect(), 'app.js calls this on every page');
});

// ---- 5. The listeners a PC does get actually tilt the card ------------------

test('on a PC, mouseenter then mousemove writes a rotation, and mouseleave resets it', () => {
  const [card] = mount({ media: PC, count: 1 });
  init3DTiltEffect();

  // Card spans x 100-300, y 100-200, so its centre is (200, 150).
  card.fire('mouseenter');
  card.fire('mousemove', { clientX: 300, clientY: 100 });

  assert.match(
    card.style.transform,
    /^rotateX\(-?[\d.]+deg\) rotateY\(-?[\d.]+deg\)$/,
    'the tilt must still work where it is supposed to',
  );

  // Far right of centre tilts one way, far above centre the other — sign matters, since a
  // transform of "rotateX(0deg) rotateY(0deg)" would match the shape above but be inert.
  const [, rx, ry] = card.style.transform.match(/rotateX\((-?[\d.]+)deg\) rotateY\((-?[\d.]+)deg\)/);
  assert.equal(Number(ry), 8, 'right edge is the +8deg extreme');
  assert.equal(Number(rx), 8, 'above centre tilts back');

  card.fire('mouseleave');
  assert.equal(card.style.transform, 'rotateX(0deg) rotateY(0deg)', 'leaving must reset');
});

test('a mousemove without a preceding mouseenter is ignored', () => {
  // Guards the cached-rect path: reading a null rect would throw into the console on any
  // page where a move lands before the enter (or after a leave).
  const [card] = mount({ media: PC, count: 1 });
  init3DTiltEffect();

  card.fire('mousemove', { clientX: 300, clientY: 100 });
  assert.equal(card.style.transform, undefined, 'no rect cached yet, so no write');
});
