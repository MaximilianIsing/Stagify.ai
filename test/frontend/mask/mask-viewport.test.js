// Characterization tests for the mask editor's mobile viewport-pinning slice.
//
// Written before consolidating the two mask editors. The stage editor carries a
// byte-for-byte equivalent of this logic inline (syncEditorToViewport /
// bindViewportSync / unbindViewportSync); these tests pin the behaviour that the
// shared version has to keep, in particular the two easy-to-lose details:
// desktop must CLEAR the inline styles rather than skip them, and unbind must
// clear them too or the dialog stays stuck at the last mobile geometry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMaskDom } from '../../helpers/mask-dom.js';

const VV = { offsetTop: 40, offsetLeft: 5, width: 390, height: 640 };

async function importSlice() {
  return (await import('../../../public/scripts/mask/viewport.js')).createMaskViewport;
}

function setup({ mobile, visualViewport }) {
  const dom = installMaskDom({ mobile, visualViewport });
  const modal = dom.el('div', 'mask-editor-modal');
  modal.classList.add('active');
  return { dom, modal };
}

test('on mobile it pins the modal to the visual viewport', async (t) => {
  const s = setup({ mobile: true, visualViewport: VV });
  t.after(() => s.dom.restore());
  const createMaskViewport = await importSlice();

  createMaskViewport({ getModal: () => s.modal }).sync();

  assert.deepEqual(
    { top: s.modal.style.top, left: s.modal.style.left, width: s.modal.style.width, height: s.modal.style.height },
    { top: '40px', left: '5px', width: '390px', height: '640px' },
  );
});

test('on desktop it CLEARS the inline geometry instead of leaving it', async (t) => {
  const s = setup({ mobile: false, visualViewport: VV });
  t.after(() => s.dom.restore());
  const createMaskViewport = await importSlice();
  // Simulate a resize across the breakpoint: mobile values already applied.
  Object.assign(s.modal.style, { top: '40px', left: '5px', width: '390px', height: '640px' });

  createMaskViewport({ getModal: () => s.modal }).sync();

  assert.deepEqual(
    { top: s.modal.style.top, left: s.modal.style.left, width: s.modal.style.width, height: s.modal.style.height },
    { top: '', left: '', width: '', height: '' },
    'a phone rotated to a wide layout must not keep the pinned box',
  );
});

test('a browser with no visualViewport falls back to the untouched modal', async (t) => {
  const s = setup({ mobile: true, visualViewport: null });
  t.after(() => s.dom.restore());
  const createMaskViewport = await importSlice();

  createMaskViewport({ getModal: () => s.modal }).sync();
  assert.equal(s.modal.style.top, '');
});

test('sync does nothing while the modal is closed', async (t) => {
  const s = setup({ mobile: true, visualViewport: VV });
  t.after(() => s.dom.restore());
  s.modal.classList.remove('active');
  const createMaskViewport = await importSlice();

  createMaskViewport({ getModal: () => s.modal }).sync();
  assert.equal(s.modal.style.top, '', 'a closed dialog is not repositioned');
});

test('bind registers resize + scroll once, and unbind removes them', async (t) => {
  const listeners = [];
  const vv = {
    ...VV,
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    removeEventListener: (type, fn) => {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i !== -1) listeners.splice(i, 1);
    },
  };
  const s = setup({ mobile: true, visualViewport: vv });
  t.after(() => s.dom.restore());
  const createMaskViewport = await importSlice();
  const viewport = createMaskViewport({ getModal: () => s.modal });

  viewport.bind();
  assert.deepEqual(listeners.map((l) => l.type).sort(), ['resize', 'scroll']);

  // Re-binding on a second open must not stack duplicate handlers.
  viewport.bind();
  assert.equal(listeners.length, 2, 'bind is idempotent');

  viewport.unbind();
  assert.equal(listeners.length, 0, 'both handlers removed');
});

test('unbind clears the pinned geometry so the next open starts clean', async (t) => {
  const listeners = [];
  const vv = { ...VV, addEventListener: (t2, fn) => listeners.push({ t2, fn }), removeEventListener: () => {} };
  const s = setup({ mobile: true, visualViewport: vv });
  t.after(() => s.dom.restore());
  const createMaskViewport = await importSlice();
  const viewport = createMaskViewport({ getModal: () => s.modal });

  viewport.bind();
  viewport.sync();
  assert.equal(s.modal.style.height, '640px', 'pinned while open');

  viewport.unbind();
  assert.deepEqual(
    { top: s.modal.style.top, width: s.modal.style.width, height: s.modal.style.height },
    { top: '', width: '', height: '' },
  );
});

test('the bound handler re-pins when the visual viewport moves', async (t) => {
  let handler = null;
  const vv = { ...VV, addEventListener: (type, fn) => { if (type === 'resize') handler = fn; }, removeEventListener: () => {} };
  const s = setup({ mobile: true, visualViewport: vv });
  t.after(() => s.dom.restore());
  const createMaskViewport = await importSlice();

  createMaskViewport({ getModal: () => s.modal }).bind();
  assert.ok(handler, 'a resize handler was registered');

  // The on-screen keyboard opening shrinks the visual viewport.
  vv.height = 320;
  vv.offsetTop = 100;
  handler();

  assert.equal(s.modal.style.height, '320px', 'follows the keyboard');
  assert.equal(s.modal.style.top, '100px');
});
