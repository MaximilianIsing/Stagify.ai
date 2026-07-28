// Characterization tests for the mask editor's processing-overlay slice.
//
// Written before consolidating the two mask editors. The stage editor carries an
// equivalent inline (ensureOverlay / startOverlay / stopOverlay + LOAD_MESSAGES),
// with two deliberate differences the shared version must be able to express:
// it marks the container busy with `smask-busy` rather than `processing`, and it
// injects one extra CSS rule to blur its own canvas class. Both copies currently
// write DIFFERENT stylesheet bodies under the SAME `smask-refine-styles` id,
// which only works because they never share a page.
//
// The timer assertions use node:test mock timers — the message rotation is a
// 2s setInterval and should not be tested by waiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMaskDom } from '../../helpers/mask-dom.js';

const lang = (_key, fallback) => fallback;

async function importSlice() {
  return (await import('../../../public/scripts/mask/overlay.js')).createMaskOverlay;
}

function setup() {
  const dom = installMaskDom();
  const container = dom.el('div', null, 'mask-editor-canvas-container');
  return { dom, container };
}

const overlayIn = (container) => container.querySelector('.smask-overlay');
const msgIn = (container) => container.querySelector('.smask-overlay__msg');

test('ensure injects the stylesheet once and builds the overlay once', async (t) => {
  const s = setup();
  t.after(() => s.dom.restore());
  const createMaskOverlay = await importSlice();
  const overlay = createMaskOverlay({ lang, getContainer: () => s.container });

  overlay.ensure();
  overlay.ensure();
  overlay.ensure();

  const styles = s.dom.head.children.filter((c) => c.id === 'smask-refine-styles');
  assert.equal(styles.length, 1, 'the <style> is injected exactly once');
  assert.equal(s.container.querySelectorAll('.smask-overlay').length, 1, 'one overlay, not three');
  assert.ok(/smask-overlay__spin/.test(styles[0].textContent), 'the spinner rule is in the sheet');
});

test('ensure makes a statically-positioned container a positioning context', async (t) => {
  const s = setup();
  t.after(() => s.dom.restore());
  const createMaskOverlay = await importSlice();

  createMaskOverlay({ lang, getContainer: () => s.container }).ensure();

  assert.equal(s.container.style.position, 'relative',
    'the overlay is absolutely positioned; a static parent would let it escape');
});

test('start marks the container busy, reveals the overlay, and shows the first message', async (t) => {
  const s = setup();
  t.after(() => s.dom.restore());
  t.mock.timers.enable({ apis: ['setInterval'] });
  const createMaskOverlay = await importSlice();

  createMaskOverlay({ lang, getContainer: () => s.container }).start();

  assert.ok(s.container.classList.contains('processing'), 'container marked busy');
  assert.ok(!overlayIn(s.container).classList.contains('hidden'), 'overlay visible');
  assert.equal(msgIn(s.container).textContent, 'Applying your edit…');
});

test('the status message rotates every 2s and wraps around', async (t) => {
  const s = setup();
  t.after(() => s.dom.restore());
  t.mock.timers.enable({ apis: ['setInterval'] });
  const createMaskOverlay = await importSlice();

  createMaskOverlay({ lang, getContainer: () => s.container }).start();
  const seen = [msgIn(s.container).textContent];
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(2000);
    seen.push(msgIn(s.container).textContent);
  }

  assert.deepEqual(seen, [
    'Applying your edit…',
    'Reworking the masked area…',
    'Blending in the new details…',
    'Refining textures and lighting…',
    'Adding finishing touches…',
    'Applying your edit…',
  ], 'five messages, then back to the first');
});

test('stop hides the overlay, clears busy, and halts the rotation', async (t) => {
  const s = setup();
  t.after(() => s.dom.restore());
  t.mock.timers.enable({ apis: ['setInterval'] });
  const createMaskOverlay = await importSlice();
  const overlay = createMaskOverlay({ lang, getContainer: () => s.container });

  overlay.start();
  t.mock.timers.tick(2000);
  const atStop = msgIn(s.container).textContent;
  overlay.stop();

  assert.ok(!s.container.classList.contains('processing'), 'busy flag cleared');
  assert.ok(overlayIn(s.container).classList.contains('hidden'), 'overlay hidden');

  // A leaked interval would keep mutating a hidden node forever.
  t.mock.timers.tick(10000);
  assert.equal(msgIn(s.container).textContent, atStop, 'the rotation timer was cleared');
});

test('a second start does not stack a second rotation timer', async (t) => {
  const s = setup();
  t.after(() => s.dom.restore());
  t.mock.timers.enable({ apis: ['setInterval'] });
  const createMaskOverlay = await importSlice();
  const overlay = createMaskOverlay({ lang, getContainer: () => s.container });

  overlay.start();
  overlay.start(); // e.g. Regenerate pressed straight after Apply
  t.mock.timers.tick(2000);

  // With two live intervals the index would advance twice per tick and land on
  // the third message instead of the second.
  assert.equal(msgIn(s.container).textContent, 'Reworking the masked area…');
});

test('start without a canvas container is a no-op rather than a crash', async (t) => {
  const dom = installMaskDom(); // no .mask-editor-canvas-container in the tree
  t.after(() => dom.restore());
  const createMaskOverlay = await importSlice();

  assert.doesNotThrow(() => {
    const overlay = createMaskOverlay({ lang, getContainer: () => null });
    overlay.start();
    overlay.stop();
  });
});
