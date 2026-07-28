// Characterization tests for the mask editor's reference-photo slice.
//
// Written BEFORE consolidating the two mask editors, to pin the behaviour that
// consolidation must not change: the validation rules, the 1536px downscale, the
// preview/add-button swap, and which error copy each rejection produces. The
// stage editor (public/scripts/app/stage-mask-editor.js) carries a second,
// hand-maintained copy of all of this; these tests describe the copy that is
// becoming the shared one.
//
// Downscaling runs through a real @napi-rs/canvas, so the dimension assertions
// are about actual output pixels, not a mocked toDataURL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Image as NapiImage } from '@napi-rs/canvas';
import { installMaskDom, installFileStack, fakeFile } from '../../helpers/mask-dom.js';

const lang = (_key, fallback) => fallback;

/** Decode a PNG data URL back to its real pixel dimensions. */
function dimensionsOf(dataUrl) {
  const img = new NapiImage();
  img.src = Buffer.from(String(dataUrl).split(',')[1], 'base64');
  return { w: img.width, h: img.height };
}

/** Let the promise chain inside wire()'s change handler settle. */
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

/** Stand up the DOM the slice expects, plus the three elements wire() takes. */
function setup({ width = 800, height = 600, failRead = false, failDecode = false } = {}) {
  const dom = installMaskDom();
  installFileStack({ width, height, failRead, failDecode });
  const fileInput = dom.el('input', 'mask-editor-ref-file');
  const preview = dom.el('div', 'mask-editor-ref-preview');
  const img = dom.el('img', 'mask-editor-ref-img');
  const addBtn = dom.el('button', 'mask-editor-ref-add');
  const removeBtn = dom.el('button', 'mask-editor-ref-remove');
  const toasts = [];
  const changes = { n: 0 };
  return {
    dom, fileInput, preview, img, addBtn, removeBtn, toasts, changes,
    showError: (msg) => toasts.push(msg),
    onChange: () => { changes.n += 1; },
  };
}

async function importSlice() {
  return (await import('../../../public/scripts/mask/reference.js')).createMaskReference;
}

test('starts empty and clear() resets every control + notifies', async (t) => {
  const s = setup();
  t.after(() => s.dom.restore());
  const createMaskReference = await importSlice();
  const ref = createMaskReference({ lang, showError: s.showError, onChange: s.onChange });
  ref.wire({ fileInput: s.fileInput, addBtn: s.addBtn, removeBtn: s.removeBtn, preview: s.preview, img: s.img });

  assert.equal(ref.getDataUrl(), null, 'no reference until one is chosen');

  s.preview.classList.remove('hidden');
  s.addBtn.classList.add('hidden');
  ref.clear();

  assert.ok(s.preview.classList.contains('hidden'), 'preview hidden');
  assert.ok(!s.addBtn.classList.contains('hidden'), '"+ Add photo" comes back');
  assert.equal(s.fileInput.value, '', 'file input reset so the same file can be re-picked');
  assert.equal(s.changes.n, 1, 'onChange fires — the editor re-fits around the thumbnail');
});

test('accepts a valid image, downscaling the long edge to 1536 and keeping aspect', async (t) => {
  const s = setup({ width: 3072, height: 1536 });
  t.after(() => s.dom.restore());
  const createMaskReference = await importSlice();
  const ref = createMaskReference({ lang, showError: s.showError, onChange: s.onChange });
  ref.wire({ fileInput: s.fileInput, addBtn: s.addBtn, removeBtn: s.removeBtn, preview: s.preview, img: s.img });

  s.fileInput.files = [fakeFile({ type: 'image/jpeg', size: 5000 })];
  s.fileInput.emit('change');
  await settle();

  const url = ref.getDataUrl();
  assert.ok(url && url.startsWith('data:image/png'), 're-encoded as PNG');
  assert.deepEqual(dimensionsOf(url), { w: 1536, h: 768 },
    'long edge capped at 1536 with the 2:1 aspect preserved');
  assert.equal(s.toasts.length, 0, 'no error for a valid file');
  assert.ok(!s.preview.classList.contains('hidden'), 'preview shown');
  assert.ok(s.addBtn.classList.contains('hidden'), '"+ Add photo" hidden while one is set');
  assert.equal(s.img.src, url, 'thumbnail shows the prepared image');
});

test('does not upscale an image already under the cap', async (t) => {
  const s = setup({ width: 400, height: 300 });
  t.after(() => s.dom.restore());
  const createMaskReference = await importSlice();
  const ref = createMaskReference({ lang, showError: s.showError, onChange: s.onChange });
  ref.wire({ fileInput: s.fileInput, addBtn: s.addBtn, removeBtn: s.removeBtn, preview: s.preview, img: s.img });

  s.fileInput.files = [fakeFile({ type: 'image/webp', size: 900 })];
  s.fileInput.emit('change');
  await settle();

  assert.deepEqual(dimensionsOf(ref.getDataUrl()), { w: 400, h: 300 },
    'kept at its original size — the cap only ever shrinks');
  assert.equal(s.toasts.length, 0);
});

// The two rejection paths produce DIFFERENT copy; the stage editor's duplicate
// picks its message the same way, so this is the behaviour that has to survive.
for (const [label, file, expected] of [
  ['a non-image type', fakeFile({ type: 'application/pdf', size: 100 }), 'Please choose a valid JPG, PNG, or WebP image.'],
  ['a GIF (not in the allow-list)', fakeFile({ type: 'image/gif', size: 100 }), 'Please choose a valid JPG, PNG, or WebP image.'],
  ['an oversized file', fakeFile({ type: 'image/png', size: 26 * 1024 * 1024 }), 'That image is too large — please choose one under 25 MB.'],
]) {
  test(`rejects ${label} with its own message and keeps the reference empty`, async (t) => {
    const s = setup();
    t.after(() => s.dom.restore());
    const createMaskReference = await importSlice();
    const ref = createMaskReference({ lang, showError: s.showError, onChange: s.onChange });
    ref.wire({ fileInput: s.fileInput, addBtn: s.addBtn, removeBtn: s.removeBtn, preview: s.preview, img: s.img });

    s.fileInput.files = [file];
    s.fileInput.emit('change');
    await settle();

    assert.equal(ref.getDataUrl(), null, 'nothing is attached');
    assert.deepEqual(s.toasts, [expected]);
    assert.ok(!s.addBtn.classList.contains('hidden'), 'the add button is restored after a rejection');
  });
}

test('a file that fails to decode is reported, not silently attached', async (t) => {
  const s = setup({ failDecode: true });
  t.after(() => s.dom.restore());
  const createMaskReference = await importSlice();
  const ref = createMaskReference({ lang, showError: s.showError, onChange: s.onChange });
  ref.wire({ fileInput: s.fileInput, addBtn: s.addBtn, removeBtn: s.removeBtn, preview: s.preview, img: s.img });

  s.fileInput.files = [fakeFile({ type: 'image/png', size: 100 })];
  s.fileInput.emit('change');
  await settle();

  assert.equal(ref.getDataUrl(), null);
  assert.equal(s.toasts.length, 1, 'the user is told');
});

test('the remove button clears an attached reference', async (t) => {
  const s = setup({ width: 100, height: 100 });
  t.after(() => s.dom.restore());
  const createMaskReference = await importSlice();
  const ref = createMaskReference({ lang, showError: s.showError, onChange: s.onChange });
  ref.wire({ fileInput: s.fileInput, addBtn: s.addBtn, removeBtn: s.removeBtn, preview: s.preview, img: s.img });

  s.fileInput.files = [fakeFile()];
  s.fileInput.emit('change');
  await settle();
  assert.ok(ref.getDataUrl(), 'attached first');

  s.removeBtn.click();
  assert.equal(ref.getDataUrl(), null, 'remove detaches it');
  assert.ok(!s.addBtn.classList.contains('hidden'));
});

test('"+ Add photo" opens the file picker', async (t) => {
  const s = setup();
  t.after(() => s.dom.restore());
  let opened = 0;
  s.fileInput.click = () => { opened += 1; };
  const createMaskReference = await importSlice();
  const ref = createMaskReference({ lang, showError: s.showError, onChange: s.onChange });
  ref.wire({ fileInput: s.fileInput, addBtn: s.addBtn, removeBtn: s.removeBtn, preview: s.preview, img: s.img });

  s.addBtn.click();
  assert.equal(opened, 1);
});

test('a HEIC file is converted before validation instead of being rejected', async (t) => {
  const s = setup({ width: 200, height: 200 });
  // restore() swaps the whole fake window out, taking StagifyHeic with it.
  t.after(() => s.dom.restore());
  let converted = 0;
  globalThis.window.StagifyHeic = {
    isHeic: (f) => /heic/i.test(f.type || ''),
    // Real conversion yields a JPEG; the point is that validation sees the
    // CONVERTED file, so a .heic pick doesn't hit the type rejection.
    toDisplayableFile: () => { converted += 1; return Promise.resolve(fakeFile({ type: 'image/jpeg', size: 4000 })); },
  };
  const createMaskReference = await importSlice();
  const ref = createMaskReference({ lang, showError: s.showError, onChange: s.onChange });
  ref.wire({ fileInput: s.fileInput, addBtn: s.addBtn, removeBtn: s.removeBtn, preview: s.preview, img: s.img });

  s.fileInput.files = [fakeFile({ type: 'image/heic', size: 4000 })];
  s.fileInput.emit('change');
  await settle();

  assert.equal(converted, 1, 'the HEIC shim was consulted');
  assert.ok(ref.getDataUrl(), 'the converted file was accepted');
  assert.equal(s.toasts.length, 0, 'no "invalid image" error for a HEIC pick');
});
