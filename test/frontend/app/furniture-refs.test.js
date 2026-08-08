// Tier: frontend island logic (DOM-stubbed) — public/scripts/app/furniture-refs.js.
//
// The pro "furniture reference photos" picker: up to five photos, added by the file
// picker or dropped onto the add button, each with a hover preview and a remove row.
//
// Unlike its sibling islands this one is NOT purely injected — it looks its three
// elements up through `document` itself at construction, so the harness has to stand
// up a document before the factory runs rather than handing elements in.
//
// The behaviours worth pinning:
//
//   - OBJECT URLS ARE REVOKED ON EVERY RE-RENDER. Each preview is a blob: URL held
//     against a File. The list re-renders on every add and every remove, so a missing
//     revoke leaks one full-size image per interaction for the lifetime of the tab.
//   - THE ACCEPT FILTER TAKES EITHER SIGNAL. The OS picker honours `accept`, but a
//     DROPPED file often arrives with an empty `type` — hence the extension fallback.
//     Checking only `type` silently discards perfectly good dropped JPEGs.
//   - THE CAP HOLDS ON BOTH PATHS. Adding six at once and adding one at a time have
//     to reach the same place, which is why the loop guard and the trailing slice
//     both exist.
//   - THE PREVIEW FLIPS RATHER THAN LEAVING THE VIEWPORT. A photo near the right edge
//     opens to the left instead of off-screen.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installMaskDom, FakeEl } from '../../helpers/mask-dom.js';
import {
  createFurnitureRefs,
  FURNITURE_LIMIT,
} from '../../../public/scripts/app/furniture-refs.js';

const REAL = {
  window: globalThis.window,
  URL: globalThis.URL,
  DataTransfer: globalThis.DataTransfer,
  requestAnimationFrame: globalThis.requestAnimationFrame,
};

let dom = null;
afterEach(() => {
  if (dom) dom.restore();
  dom = null;
  globalThis.window = REAL.window;
  globalThis.URL = REAL.URL;
  globalThis.DataTransfer = REAL.DataTransfer;
  globalThis.requestAnimationFrame = REAL.requestAnimationFrame;
});

const settle = () => new Promise((r) => setTimeout(r, 5));

const file = (name = 'sofa.jpg', type = 'image/jpeg') => ({ name, type, size: 100 });

function mount({ bare = false, heic = null, innerWidth = 1200, innerHeight = 800 } = {}) {
  dom = installMaskDom();

  const input = new FakeEl('input');
  input.files = [];
  // A real <input type=file> carries the picked path here, and it is NOT cleared by
  // assigning .files. Starting it empty made "reset clears the input" pass without
  // reset doing anything, so pick() below sets it the way the browser would.
  input.value = '';
  input.opened = 0;
  input.click = () => { input.opened += 1; };
  const list = new FakeEl('div');
  const addBtn = new FakeEl('button');

  dom.doc.getElementById = (id) => {
    if (bare) return null;
    if (id === 'stagify-furniture-file') return input;
    if (id === 'stagify-furniture-list') return list;
    if (id === 'stagify-furniture-add-btn') return addBtn;
    return null;
  };

  const urls = { created: [], revoked: [] };
  let seq = 0;
  globalThis.URL = /** @type {any} */ ({
    createObjectURL: (f) => {
      const u = `blob:${f.name}#${++seq}`;
      urls.created.push(u);
      return u;
    },
    revokeObjectURL: (u) => urls.revoked.push(u),
  });
  globalThis.DataTransfer = /** @type {any} */ (
    class {
      constructor() {
        const held = [];
        this.items = { add: (f) => held.push(f) };
        this.files = held;
      }
    }
  );
  globalThis.window = /** @type {any} */ ({ innerWidth, innerHeight, StagifyHeic: heic, LanguageSystem: null });
  // The HEIC failure path routes through the shared toast, which schedules its
  // entrance on a frame. Synchronous here so the toast is done by the time the
  // assertion runs.
  globalThis.requestAnimationFrame = /** @type {any} */ ((fn) => { fn(); return 1; });

  const island = createFurnitureRefs({ getStagingAlt: (key, r) => `${key}:${(r && r.filename) || ''}` });

  const drag = (files) => ({
    dataTransfer: { types: ['Files'], files, dropEffect: '' },
    preventDefault() {},
  });

  return {
    island,
    input,
    list,
    addBtn,
    urls,
    body: dom.body,
    /** Rows currently rendered in the list. */
    rows: () => list.children,
    /** Pick files through the hidden input, the way the OS picker does. */
    pick: async (files) => {
      input.files = files;
      input.value = `C:\\fakepath\\${(files[0] && files[0].name) || ''}`;
      input.emit('change', {});
      await settle();
    },
    dropOn: async (zone, files) => { zone.emit('drop', drag(files)); await settle(); },
    dragOver: (zone, files) => zone.emit('dragenter', drag(files)),
    dragOut: (zone) => zone.emit('dragleave', {}),
  };
}

/** The popover the island lazily appends to <body>. */
const popover = (h) => h.body.children.find((c) => c.id === 'furniture-image-preview');

// ---- adding ------------------------------------------------------------------

test('picked photos are listed and readable back', async () => {
  const h = mount();

  await h.pick([file('sofa.jpg'), file('lamp.png', 'image/png')]);

  assert.equal(h.rows().length, 2);
  assert.deepEqual(h.island.getFiles().map((f) => f.name), ['sofa.jpg', 'lamp.png']);
  assert.equal(h.list.style.display, 'block');
});

test('a dropped file with no MIME type is accepted on its extension', async () => {
  // The OS picker applies `accept`; a drop does not, and a dropped file frequently
  // arrives with type ''. Filtering on type alone throws away valid photos with no
  // feedback at all.
  const h = mount();

  await h.dropOn(h.addBtn, [file('sofa.jpeg', '')]);

  assert.equal(h.island.getFiles().length, 1);
});

test('a non-image is refused however it arrives', async () => {
  const h = mount();

  await h.pick([file('notes.pdf', 'application/pdf')]);
  await h.dropOn(h.addBtn, [file('notes.pdf', 'application/pdf')]);

  assert.deepEqual(h.island.getFiles(), []);
  assert.equal(h.rows().length, 0);
  // A batch with nothing usable returns before re-rendering, so it also costs no
  // object-URL churn — the list is untouched rather than torn down and rebuilt.
  assert.deepEqual(h.urls.created, []);
});

test('a mixed batch keeps the images and drops the rest', async () => {
  // The filter is per-file, not all-or-nothing: dragging a folder's worth of files
  // must not be refused wholesale because one CSV came along.
  const h = mount();

  await h.dropOn(h.addBtn, [file('notes.pdf', 'application/pdf'), file('sofa.jpg')]);

  assert.deepEqual(h.island.getFiles().map((f) => f.name), ['sofa.jpg']);
});

test('the cap holds when the photos arrive all at once', async () => {
  const h = mount();

  await h.pick(Array.from({ length: FURNITURE_LIMIT + 3 }, (_, i) => file(`f${i}.jpg`)));

  assert.equal(h.island.getFiles().length, FURNITURE_LIMIT);
});

test('the cap holds when they arrive one at a time', async () => {
  const h = mount();

  for (let i = 0; i < FURNITURE_LIMIT + 3; i += 1) await h.pick([file(`f${i}.jpg`)]);

  assert.equal(h.island.getFiles().length, FURNITURE_LIMIT);
  assert.deepEqual(
    h.island.getFiles().map((f) => f.name),
    ['f0.jpg', 'f1.jpg', 'f2.jpg', 'f3.jpg', 'f4.jpg'],
    'the FIRST five are kept, not the last five',
  );
});

test('the add button retires at the cap and comes back below it', async () => {
  const h = mount();

  await h.pick(Array.from({ length: FURNITURE_LIMIT }, (_, i) => file(`f${i}.jpg`)));
  assert.equal(h.addBtn.classList.contains('hidden'), true);

  h.rows()[0].children[2].emit('click', {});
  await settle();
  assert.equal(h.addBtn.classList.contains('hidden'), false);
});

test('the picker will not open once the cap is reached', async () => {
  const h = mount();
  await h.pick(Array.from({ length: FURNITURE_LIMIT }, (_, i) => file(`f${i}.jpg`)));
  const before = h.input.opened;

  h.addBtn.emit('click', {});

  assert.equal(h.input.opened, before, 'no picker for photos that cannot be added');
});

// ---- HEIC --------------------------------------------------------------------

test('a HEIC pick is converted so it survives the accept filter', async () => {
  const h = mount({
    heic: {
      isHeic: (f) => /heic/i.test(f.type),
      toDisplayableFile: async () => file('IMG_1.jpg'),
    },
  });

  await h.pick([file('IMG_1.HEIC', 'image/heic')]);

  assert.deepEqual(h.island.getFiles().map((f) => f.name), ['IMG_1.jpg']);
});

test('a HEIC conversion failure is reported and adds nothing', async () => {
  const h = mount({
    heic: { isHeic: () => true, toDisplayableFile: async () => { throw new Error('bad'); } },
  });

  await h.pick([file('IMG_1.HEIC', 'image/heic')]);

  assert.deepEqual(h.island.getFiles(), []);
});

// ---- removing and object URLs ----------------------------------------------------

test('removing a row drops that photo and keeps the rest', async () => {
  const h = mount();
  await h.pick([file('a.jpg'), file('b.jpg'), file('c.jpg')]);

  h.rows()[1].children[2].emit('click', {});
  await settle();

  assert.deepEqual(h.island.getFiles().map((f) => f.name), ['a.jpg', 'c.jpg']);
  assert.equal(h.rows().length, 2);
});

test('every preview URL is revoked when the list is rebuilt', async () => {
  // One blob: URL per photo, minted fresh on every render. Without the revoke each
  // add or remove leaks a full-size image for the lifetime of the tab.
  const h = mount();

  await h.pick([file('a.jpg'), file('b.jpg')]);
  const firstBatch = [...h.urls.created];

  await h.pick([file('c.jpg')]);

  for (const u of firstBatch) {
    assert.ok(h.urls.revoked.includes(u), `${u} was not revoked before the re-render`);
  }
});

test('resetting drops the photos, the input and the URLs', async () => {
  const h = mount();
  await h.pick([file('a.jpg'), file('b.jpg')]);
  const minted = [...h.urls.created];

  h.island.reset();
  await settle();

  assert.deepEqual(h.island.getFiles(), []);
  assert.equal(h.input.value, '', 'the input is cleared so the same file can be re-picked');
  assert.equal(h.rows().length, 0);
  for (const u of minted) assert.ok(h.urls.revoked.includes(u));
});

test('the hidden input is kept in step so the form submits what is listed', async () => {
  const h = mount();

  await h.pick([file('a.jpg'), file('b.jpg')]);
  h.rows()[0].children[2].emit('click', {});
  await settle();

  assert.deepEqual([...h.input.files].map((f) => f.name), ['b.jpg']);
});

// ---- the row itself ---------------------------------------------------------------

test('a long filename is abbreviated but kept in full on hover', async () => {
  const h = mount();
  const long = `${'x'.repeat(60)}.jpg`;

  await h.pick([file(long)]);

  const name = h.rows()[0].children[0];
  assert.ok(name.textContent.length < long.length, 'the visible label is shortened');
  assert.match(name.textContent, /\.\.\.$/);
  assert.equal(name.title, long, 'and the full name is still available');
});

test('a short filename is left alone and gets no tooltip', async () => {
  const h = mount();

  await h.pick([file('sofa.jpg')]);

  const name = h.rows()[0].children[0];
  assert.equal(name.textContent, 'sofa.jpg');
  assert.equal(name.title, undefined, 'no redundant tooltip repeating the visible text');
});

// ---- the preview popover -------------------------------------------------------------

test('hovering a photo opens its preview beside the button', async () => {
  const h = mount();
  await h.pick([file('sofa.jpg')]);

  const btn = h.rows()[0].children[1];
  btn.getBoundingClientRect = () => ({ left: 100, right: 130, top: 300, height: 20 });
  btn.emit('mouseenter', {});

  const pop = popover(h);
  assert.equal(pop.classList.contains('hidden'), false);
  assert.equal(pop.getAttribute('aria-hidden'), 'false');
  assert.equal(pop.querySelector('img').src, h.urls.created[0]);
  assert.equal(pop.style.left, '140px', 'to the right of the button');
});

test('a preview near the right edge opens to the left instead of off-screen', async () => {
  const h = mount({ innerWidth: 400 });
  await h.pick([file('sofa.jpg')]);

  const btn = h.rows()[0].children[1];
  btn.getBoundingClientRect = () => ({ left: 350, right: 380, top: 300, height: 20 });
  btn.emit('mouseenter', {});

  assert.equal(popover(h).style.left, '60px', 'flipped to the left of the button');
});

test('a preview is clamped inside the viewport rather than running off the top', async () => {
  const h = mount();
  await h.pick([file('sofa.jpg')]);

  const btn = h.rows()[0].children[1];
  btn.getBoundingClientRect = () => ({ left: 100, right: 130, top: 0, height: 20 });
  btn.emit('mouseenter', {});

  assert.equal(popover(h).style.top, '8px');
});

test('the preview is reachable by keyboard, not only by mouse', async () => {
  // The preview button is focusable, so focus/blur have to do what hover does or a
  // keyboard user has no way to see which photo a row refers to.
  const h = mount();
  await h.pick([file('sofa.jpg')]);
  const btn = h.rows()[0].children[1];
  btn.getBoundingClientRect = () => ({ left: 100, right: 130, top: 300, height: 20 });

  btn.emit('focus', {});
  assert.equal(popover(h).classList.contains('hidden'), false);

  btn.emit('blur', {});
  assert.equal(popover(h).classList.contains('hidden'), true);
});

test('leaving a row hides the preview', async () => {
  const h = mount();
  await h.pick([file('sofa.jpg')]);
  const btn = h.rows()[0].children[1];
  btn.getBoundingClientRect = () => ({ left: 100, right: 130, top: 300, height: 20 });

  btn.emit('mouseenter', {});
  btn.emit('mouseleave', {});

  assert.equal(popover(h).getAttribute('aria-hidden'), 'true');
});

// ---- drag and drop ------------------------------------------------------------------

test('dragging photos over the add button highlights it', async () => {
  const h = mount();

  h.dragOver(h.addBtn, [file()]);
  assert.equal(h.addBtn.classList.contains('is-drag-over'), true);

  h.dragOut(h.addBtn);
  assert.equal(h.addBtn.classList.contains('is-drag-over'), false);
});

test('a drag over a full picker is not invited in', async () => {
  const h = mount();
  await h.pick(Array.from({ length: FURNITURE_LIMIT }, (_, i) => file(`f${i}.jpg`)));

  h.dragOver(h.addBtn, [file()]);

  assert.equal(h.addBtn.classList.contains('is-drag-over'), false, 'no highlight for a drop that would do nothing');
});

test('dragging over the list counts as dragging over the picker', async () => {
  const h = mount();
  await h.pick([file('a.jpg')]);

  h.dragOver(h.list, [file()]);

  assert.equal(h.addBtn.classList.contains('is-drag-over'), true);
});

test('a drag that leaves after entering two zones still clears the highlight', async () => {
  // Entering a child fires dragenter again before the parent's dragleave. Without the
  // depth counter the highlight is cleared on the first leave and the button looks
  // inert while a drag is still over it — or worse, sticks on after the drag ends.
  const h = mount();
  await h.pick([file('a.jpg')]);

  h.dragOver(h.addBtn, [file()]);
  h.dragOver(h.list, [file()]);
  h.dragOut(h.addBtn);
  assert.equal(h.addBtn.classList.contains('is-drag-over'), true, 'still over the picker');

  h.dragOut(h.list);
  assert.equal(h.addBtn.classList.contains('is-drag-over'), false);
});

test('a drop carrying no files is ignored', async () => {
  const h = mount();

  h.addBtn.emit('drop', { dataTransfer: { types: ['text/plain'], files: [] }, preventDefault() { throw new Error('must not'); } });
  await settle();

  assert.deepEqual(h.island.getFiles(), []);
});

// ---- pages without the markup ----------------------------------------------------------

test('a page without the picker still gets a working API', async () => {
  // app.js builds this island everywhere. The entry calls getFiles() before every
  // stage, so it has to answer even where the markup does not exist.
  const h = mount({ bare: true });

  assert.deepEqual(h.island.getFiles(), []);
  assert.doesNotThrow(() => h.island.reset());
});
