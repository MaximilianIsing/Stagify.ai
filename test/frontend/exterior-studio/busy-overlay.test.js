// Tier: frontend island logic — public/scripts/exterior-studio/busy-overlay.js.
//
// The overlay stands in for progress on a call that reports none, so the failure that
// matters is not "it never appeared" — that one is obvious the first time anyone runs a
// render. It is the overlay that never LEAVES, or the interval that outlives its own
// overlay and keeps repainting a label nobody can see. Both are silent, and both come
// from the same place: a timer handle dropped on the floor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBusyOverlay } from '../../../public/scripts/exterior-studio/busy-overlay.js';

/**
 * A stand-in exposing just the surface the island touches.
 *
 * `className` and `classList` are backed by the SAME set, as in a real element. A fake
 * that keeps them apart passes this whole file while the shipped code — which writes the
 * class string once and then toggles `hidden` through classList — never actually hides
 * anything.
 */
function el(tag = 'div') {
  /** @type {Set<string>} */
  const classes = new Set();
  /** @type {Record<string, string>} */
  const attrs = {};
  const node = {
    tag,
    textContent: '',
    children: /** @type {any[]} */ ([]),
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    appendChild: (c) => { node.children.push(c); return c; },
    get attrs() { return { ...attrs }; },
  };
  Object.defineProperty(node, 'className', {
    get: () => [...classes].join(' '),
    set: (v) => { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
  });
  return node;
}

/** Find the overlay among the host's children, by the class the stylesheet keys off. */
const overlayOf = (host) => host.children.find((c) => c.classList.contains('ex-busy'));
const msgOf = (host) => overlayOf(host)?.children.find((c) => c.classList.contains('ex-busy__msg'));
const isHidden = (node) => node.classList.contains('hidden');

/**
 * Mount the island against fake timers.
 *
 * Fake timers are not an optimisation here — `start()` arms a real repeating interval that
 * nothing in the test would ever clear, and `node --test` will not exit while one is live.
 * Every test that starts the overlay has to go through here.
 * @param {{ messages?: string[], pack?: any }} [opts] - Override the copy the overlay
 *   cycles, or install a `window.LanguageSystem` for it to read instead.
 */
function mount({ messages, pack } = {}) {
  const host = el('figure');
  const doc = /** @type {any} */ ({ createElement: (tag) => el(tag) });
  const ticks = [];
  let nextId = 1;
  const prevSet = globalThis.setInterval;
  const prevClear = globalThis.clearInterval;
  const prevWin = globalThis.window;
  if (pack !== undefined) {
    globalThis.window = /** @type {any} */ ({ LanguageSystem: { getText: () => pack } });
  }
  globalThis.setInterval = /** @type {any} */ ((fn, ms) => {
    const id = nextId++;
    ticks.push({ id, fn, ms });
    return id;
  });
  globalThis.clearInterval = /** @type {any} */ ((id) => {
    const i = ticks.findIndex((t) => t.id === id);
    if (i >= 0) ticks.splice(i, 1);
  });

  const api = createBusyOverlay({
    host,
    doc,
    ...(messages ? { getMessages: () => messages } : {}),
  });

  return {
    api,
    host,
    /** Every interval still armed. Length is the assertion that matters. */
    ticks,
    /** Advance every live timer once. */
    tick: () => ticks.slice().forEach((t) => t.fn()),
    restore() {
      globalThis.setInterval = prevSet;
      globalThis.clearInterval = prevClear;
      globalThis.window = prevWin;
    },
  };
}

test('start() covers the photo and stop() uncovers it', (t) => {
  const m = mount();
  t.after(m.restore);

  assert.equal(overlayOf(m.host), undefined, 'nothing is built until a render starts');

  m.api.start();
  const overlay = overlayOf(m.host);
  assert.ok(overlay, 'the overlay is attached to the preview figure');
  assert.ok(m.host.classList.contains('is-busy'), 'the class the blur hangs off');
  assert.ok(!isHidden(overlay), 'and it is visible');

  m.api.stop();
  assert.ok(!m.host.classList.contains('is-busy'), 'the blur comes off with the overlay');
  assert.ok(isHidden(overlay), 'a spinner left running over a finished photo reads as a hang');
});

test('the overlay is built once, however many renders run', (t) => {
  const m = mount();
  t.after(m.restore);
  m.api.start();
  m.api.stop();
  m.api.start();
  const found = m.host.children.filter((c) => c.classList.contains('ex-busy'));
  assert.equal(found.length, 1, 'a second overlay would stack a second spinner on the first');
});

test('the copy advances and wraps rather than running out', (t) => {
  // A render can take three minutes; five lines at 2.2s is eleven seconds. Stopping on the
  // last line would leave "Adding finishing touches…" up for most of the wait.
  const m = mount({ messages: ['one', 'two', 'three'] });
  t.after(m.restore);

  m.api.start();
  assert.equal(msgOf(m.host).textContent, 'one', 'the first line paints immediately');
  m.tick();
  assert.equal(msgOf(m.host).textContent, 'two');
  m.tick();
  assert.equal(msgOf(m.host).textContent, 'three');
  m.tick();
  assert.equal(msgOf(m.host).textContent, 'one', 'and back round');
});

test('stop() disarms the timer', (t) => {
  const m = mount({ messages: ['one', 'two'] });
  t.after(m.restore);
  m.api.start();
  assert.equal(m.ticks.length, 1);
  m.api.stop();
  assert.equal(m.ticks.length, 0, 'an interval outliving the overlay repaints a hidden label forever');
});

test('a restart never leaves two timers racing over the label', (t) => {
  // Not hypothetical: the submit handler guards on state.busy, but setBusy(true) is one
  // call away from being reachable twice, and two intervals on one node produce a label
  // that flickers between two positions in the list.
  const m = mount({ messages: ['one', 'two'] });
  t.after(m.restore);
  m.api.start();
  m.api.start();
  assert.equal(m.ticks.length, 1);
});

test('stop() is safe before anything ever started', (t) => {
  // The submit handler's `finally` runs even when the request threw before the overlay
  // was built — a throw out of stop() there would swallow the real error.
  const m = mount();
  t.after(m.restore);
  assert.doesNotThrow(() => m.api.stop());
});

test('a host that is not on the page is a no-op, not a crash', () => {
  // access.js can leave the tool hidden for a non-pro visitor, and the app looks its
  // elements up by id — `host` being null has to be survivable. No mount(): a null host
  // never reaches the timer, so there is nothing to fake.
  const doc = /** @type {any} */ ({ createElement: (tag) => el(tag) });
  const api = createBusyOverlay({ host: null, doc });
  assert.doesNotThrow(() => { api.start(); api.stop(); });
});

test('the language pack supplies the copy when it has it', (t) => {
  const m = mount({ pack: ['traducido…'] });
  t.after(m.restore);
  m.api.start();
  assert.equal(msgOf(m.host).textContent, 'traducido…');
});

test('a pack that cannot answer falls back to English rather than blanking the label', (t) => {
  // The string case is the one worth pinning: every OTHER key in the pack is a string, so
  // a translator "fixing" this one to match would produce a label that paints one
  // character per tick instead of one line.
  for (const answer of [null, [], 'Cleaning up…']) {
    const m = mount({ pack: answer });
    t.after(m.restore);
    m.api.start();
    assert.equal(msgOf(m.host).textContent, 'Cleaning up the exterior…', `for ${JSON.stringify(answer)}`);
  }
});

test('no language system at all still paints a label', (t) => {
  const m = mount();
  t.after(m.restore);
  m.api.start();
  assert.equal(msgOf(m.host).textContent, 'Cleaning up the exterior…');
});

test('the overlay announces itself politely and the spinner stays out of the tree', (t) => {
  // The page has no live region but the toast host, so without this a screen-reader user
  // gets no signal at all that a three-minute render is under way.
  const m = mount();
  t.after(m.restore);
  m.api.start();
  assert.equal(overlayOf(m.host).getAttribute('role'), 'status');
  assert.equal(msgOf(m.host).getAttribute('aria-live'), 'polite');
  assert.equal(msgOf(m.host).getAttribute('aria-atomic'), 'true');
  const spin = overlayOf(m.host).children.find((c) => c.className === 'ex-busy__spin');
  assert.equal(spin.getAttribute('aria-hidden'), 'true', 'a decorative ring is not content');
});
