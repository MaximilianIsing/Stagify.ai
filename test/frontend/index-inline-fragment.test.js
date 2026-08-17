// Tier: frontend island logic (DOM-stubbed) — block 1 of public/scripts/index-inline.js,
// the fragment-landing correction.
//
// THE BUG THIS PINS. index-deferred.js runs the below-fold modules AFTER `load`, which is
// after the browser has already performed its one and only fragment scroll. One of those
// modules changes the height of the page ABOVE the anchors: home-testimonials.js adds
// `.tw-deck--ready`, collapsing #testimonials from the no-JS column of five stacked quotes
// (~2000px) into a ~375px deck. Everything below it — #compare, #why, #plans, #faq — then
// slides ~1.6k px up the document while the scroll offset stays put, so the Stagify+ page's
// "Questions before you buy?" link (`index.html#faq`) landed in the footer, a page and a
// half BELOW the FAQ it names. Measured in Chrome before the fix: the FAQ's top went from
// +209px to −1290px relative to the scrollport the instant `.tw-deck--ready` landed.
//
// Neither end of that is fixable where it happens. The collapse has to stay late (it is
// LCP relief) and it has to stay behind the ready class (it is the progressive-enhancement
// contract — see test/frontend/home-testimonials.test.js). So the landing is re-asserted
// instead, and these tests hold the three properties that make that safe: it corrects,
// it corrects the RIGHT box, and it stops the moment the visitor takes over.
//
// No jsdom in this repo — same fake-DOM approach as test/frontend/home-whyus.test.js. The
// module is an IIFE with no exports, so each case re-evaluates it through a cache-busting
// import query with the globals already staged.

import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A fake element that records what was asked of it.
 * @param {string} id
 * @param {any} [section] the `.home-section` ancestor `closest()` should report
 */
function el(id, section) {
  /** @type {any} */
  const node = {
    id,
    scrolls: /** @type {any[]} */ ([]),
    scrollIntoView(opts) { node.scrolls.push(opts); },
    closest(sel) { return sel === '.home-section' ? (section || null) : null; },
  };
  return node;
}

/**
 * Stage `location` / `document` / `window` for one evaluation of the module and return the
 * handles a test needs to drive it. Every case must call `teardown()`, which fires the
 * visitor-took-over signal — that is what disarms the module's 8s timer, and without it
 * `node --test` would sit on a live handle after the assertions have passed.
 *
 * @param {{ hash: string, nodes: Record<string, any>, sections?: any[], resizeObserver?: boolean }} opts
 */
function stage(opts) {
  const nodes = opts.nodes;
  const sections = opts.sections || Object.values(nodes);
  /** @type {any[]} */
  const observed = [];
  /** @type {Array<{ cb: () => void, alive: boolean }>} */
  const resizeCallbacks = [];
  /** @type {Record<string, Array<(e?: any) => void>>} */
  const listeners = {};
  let disconnected = 0;

  const win = /** @type {any} */ ({
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    },
  });
  if (opts.resizeObserver !== false) {
    win.ResizeObserver = class {
      constructor(cb) {
        this.entry = { cb, alive: true };
        resizeCallbacks.push(this.entry);
      }
      observe(node) { observed.push(node); }
      // Honoured, not just counted: a disconnected observer delivers nothing, so a test
      // that forgets to disconnect cannot pass by accident.
      disconnect() { this.entry.alive = false; disconnected += 1; }
    };
  }

  const previous = {
    location: globalThis.location,
    document: globalThis.document,
    window: globalThis.window,
    ResizeObserver: globalThis.ResizeObserver,
  };
  globalThis.location = /** @type {any} */ ({ hash: opts.hash });
  globalThis.document = /** @type {any} */ ({
    readyState: 'complete',
    getElementById: (id) => nodes[id] || null,
    querySelector: (sel) => (sel === 'main' ? { children: sections } : null),
    // Block 2 of the module (the cursor spotlight) bails on an empty list, which keeps
    // matchMedia and requestAnimationFrame out of this harness entirely.
    querySelectorAll: () => [],
  });
  globalThis.window = win;
  globalThis.ResizeObserver = win.ResizeObserver;

  return {
    observed,
    /** Simulate the deck collapsing: a watched section changed height. */
    resize() { resizeCallbacks.forEach((e) => { if (e.alive) e.cb(); }); },
    /** Simulate the visitor scrolling for themselves. */
    interact() { (listeners.wheel || []).slice().forEach((fn) => fn()); },
    get disconnected() { return disconnected; },
    teardown() {
      this.interact();
      Object.assign(globalThis, previous);
    },
  };
}

test('a fragment landing is re-asserted when the page resizes under it', async () => {
  const faq = el('faq');
  const harness = stage({ hash: '#faq', nodes: { faq, testimonials: el('testimonials') } });
  await import(`../../public/scripts/index-inline.js?case=resize`);

  assert.deepEqual(faq.scrolls, [{ block: 'start' }], 'lands on the FAQ at load');
  // The deck collapses. Before the fix this is where the visitor silently ended up in
  // the footer, because nothing re-ran.
  harness.resize();
  assert.equal(faq.scrolls.length, 2, 're-asserts the landing after the page shrinks');
  assert.deepEqual(faq.scrolls[1], { block: 'start' });

  harness.teardown();
});

test('every section is watched, since any of them can be the one that resizes', async () => {
  const faq = el('faq');
  const testimonials = el('testimonials');
  const harness = stage({
    hash: '#faq',
    nodes: { faq, testimonials },
    sections: [testimonials, faq],
  });
  await import(`../../public/scripts/index-inline.js?case=observe`);

  // `main` is the scroll container, so its OWN border box is viewport-sized and never
  // changes — watching it would report nothing. The movers are the sections inside it.
  assert.deepEqual(harness.observed, [testimonials, faq]);

  harness.teardown();
});

test('#ai-designer-demo still scrolls its section, not the transformed panel', async () => {
  const section = el('studio-showcase');
  const panel = el('ai-designer-demo', section);
  const harness = stage({ hash: '#ai-designer-demo', nodes: { 'ai-designer-demo': panel } });
  await import(`../../public/scripts/index-inline.js?case=demo`);

  // The panel is absolutely positioned and 3D-transformed inside the showcase carousel,
  // so its own box is a poor scroll target.
  assert.deepEqual(panel.scrolls, []);
  assert.deepEqual(section.scrolls, [{ block: 'start' }]);

  harness.teardown();
});

test('once the visitor scrolls, a later resize is left alone', async () => {
  const faq = el('faq');
  const harness = stage({ hash: '#faq', nodes: { faq } });
  await import(`../../public/scripts/index-inline.js?case=bail`);
  assert.equal(faq.scrolls.length, 1);

  harness.interact();
  assert.equal(harness.disconnected, 1, 'stops watching');
  harness.resize();
  assert.equal(faq.scrolls.length, 1, 'the visitor now owns the scroll position');

  harness.teardown();
});

test('a fragment that names nothing on the page arms nothing', async () => {
  const harness = stage({ hash: '#not-a-section', nodes: { faq: el('faq') } });
  await import(`../../public/scripts/index-inline.js?case=miss`);

  assert.deepEqual(harness.observed, [], 'no observer, no timer, no scroll');

  harness.teardown();
});
