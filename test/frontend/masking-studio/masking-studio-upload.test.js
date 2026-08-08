// Tier: frontend island logic (DOM-stubbed, real canvas) — public/scripts/masking-studio/upload.js.
//
// Everything that gets a file into the Masking Studio: the room photo (picker, drop,
// paste, replace) and the per-area furniture reference. It is the studio's entire
// trust boundary — type, size, decodability and "is this even a room" are all decided
// here — and almost every rejection path ends in a toast rather than an exception, so
// a broken gate is invisible from the outside.
//
// Two behaviours are worth the file on their own:
//
//   1. THE STALE-VERDICT RACE. The photo is shown immediately and the "is this a
//      stageable room" check runs behind it. Upload a second photo before the first
//      verdict lands and, without the `token` capture, a rejection meant for the photo
//      the user already replaced tears down the one they are now looking at.
//   2. THE SIZE CEILING. This gate read 100 MB while multer enforces 25 MB, so the
//      studio accepted files the server then refused. It is pinned against the shared
//      MAX_IMAGE_BYTES rather than a literal, so the two cannot drift apart again;
//      test/http/upload-limit-consistency.test.js guards the same constant by source
//      scan, which proves the number is written down, not that this gate reads it.
//
// Canvases are real (@napi-rs/canvas via test/helpers/mask-dom.js) so the downscale
// before the vision round-trip, and the 1536px furniture downscale, actually rasterise.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';

import { installMaskDom, FakeEl } from '../../helpers/mask-dom.js';
import { createUpload } from '../../../public/scripts/masking-studio/upload.js';
import { MAX_IMAGE_BYTES } from '../../../public/scripts/app/image-file.js';

const REAL = {
  fetch: globalThis.fetch,
  FileReader: globalThis.FileReader,
  Image: globalThis.Image,
  window: globalThis.window,
};

let dom = null;
afterEach(() => {
  if (dom) dom.restore();
  dom = null;
  globalThis.fetch = REAL.fetch;
  globalThis.FileReader = REAL.FileReader;
  globalThis.Image = REAL.Image;
  globalThis.window = REAL.window;
});

const settle = () => new Promise((r) => setTimeout(r, 0));

/** A File-shaped object; the island reads type, size and name. */
const file = (over = {}) => ({
  type: 'image/jpeg',
  size: 1024,
  name: 'room.jpg',
  ...over,
});

/** An <input type=file>-shaped element that records the picker being opened. */
function fakeInput() {
  const el = new FakeEl('input');
  el.files = null;
  el.value = 'C:\\fakepath\\prev.jpg';
  el.opened = 0;
  el.click = () => { el.opened += 1; };
  /** Pick a file the way the browser does: set files, then fire change. */
  el.pick = (f) => { el.files = f ? [f] : []; el.emit('change', {}); };
  return el;
}

/** A DataTransfer-shaped drop/paste payload. */
const transfer = (f, { types = ['Files'] } = {}) => ({
  types,
  files: f ? [f] : [],
  dropEffect: '',
});

function layer(id, over = {}) {
  return { id, furniture: null, furnitureName: '', name: '', ...over };
}

/**
 * Build the island against a fake browser.
 *
 * `verdict` is what /api/validate-image answers — an object, 'not-ok' for a non-2xx,
 * 'garbage' for a body that is not the documented shape, or 'throw' for a dead
 * network. `holdVerdict` defers the answer so a test can act while it is in flight.
 */
function mount({
  layers = [layer('L1')],
  phase = 'draw',
  base = null,
  verdict = { valid: true },
  holdVerdict = null,
  heic = null,
  readFails = false,
  decodeFails = false,
  loadImageFails = false,
} = {}) {
  dom = installMaskDom();

  const docListeners = new Map();
  dom.doc.addEventListener = (type, fn) => {
    if (!docListeners.has(type)) docListeners.set(type, []);
    docListeners.get(type).push(fn);
  };

  // Every scratch canvas the island rasterises into, so the downscales can be checked
  // by dimension. Asserting on encoded payload length instead would drift with the
  // encoder and could not tell 1536 from 1600.
  const canvases = [];
  const realCreate = dom.doc.createElement.bind(dom.doc);
  dom.doc.createElement = (tag) => {
    const el = realCreate(tag);
    if (tag === 'canvas') canvases.push(el);
    return el;
  };

  const state = { base, layers, phase };
  const calls = {
    toasts: [],
    setBaseImage: [],
    clearBaseImage: 0,
    renderLayers: 0,
    updateControls: 0,
    sessionSaves: 0,
    discards: [],
    validatePosts: [],
  };

  const dropzone = new FakeEl('div');
  const stack = new FakeEl('div');
  const fileInput = fakeInput();
  const furnitureInput = fakeInput();
  const replaceBtn = new FakeEl('button');

  globalThis.window = /** @type {any} */ ({
    StagifyAuth: { getToken: () => 'tok-123' },
    StagifyHeic: heic,
  });
  globalThis.FileReader = /** @type {any} */ (
    class {
      readAsDataURL() {
        queueMicrotask(() => {
          if (readFails) { if (this.onerror) this.onerror(); return; }
          this.result = 'data:image/jpeg;base64,AAAA';
          if (this.onload) this.onload();
        });
      }
    }
  );
  // A real canvas wearing an Image's clothes: the island passes it straight to
  // ctx.drawImage, which the native canvas rejects for anything it does not know.
  globalThis.Image = /** @type {any} */ (
    function FakeImage() {
      const c = createCanvas(2000, 1200);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#c33';
      ctx.fillRect(0, 0, 2000, 1200);
      Object.defineProperty(c, 'src', {
        configurable: true,
        set() {
          queueMicrotask(() => {
            if (decodeFails) { if (c.onerror) c.onerror(); return; }
            if (c.onload) c.onload();
          });
        },
      });
      return c;
    }
  );
  globalThis.fetch = /** @type {any} */ (
    async (url, opts) => {
      calls.validatePosts.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
      if (holdVerdict) await holdVerdict;
      if (verdict === 'throw') throw new Error('offline');
      if (verdict === 'not-ok') return { ok: false, json: async () => ({}) };
      if (verdict === 'garbage') return { ok: true, json: async () => ({ nope: 1 }) };
      return { ok: true, json: async () => verdict };
    }
  );

  const island = createUpload({
    state,
    dropzone,
    fileInput,
    furnitureInput,
    stack,
    replaceBtn,
    showToast: (message, type) => calls.toasts.push({ message, type }),
    tx: (_key, def) => def,
    loadImage: async (src) => {
      if (loadImageFails) throw new Error('decode');
      const c = createCanvas(2000, 1200);
      c.src = src;
      return /** @type {any} */ (c);
    },
    setBaseImage: (img, opts) => {
      calls.setBaseImage.push(opts || {});
      state.base = { w: img.width, h: img.height, canvas: img, tag: calls.setBaseImage.length };
    },
    clearBaseImage: () => { calls.clearBaseImage += 1; state.base = null; },
    requestDiscard: (action, strict) => { calls.discards.push({ strict: !!strict }); action(); },
    activeLayer: () => state.layers[0] || null,
    getLayer: (id) => state.layers.find((l) => l.id === id) || null,
    renderLayers: () => { calls.renderLayers += 1; },
    updateControls: () => { calls.updateControls += 1; },
    layerTitle: (l) => l.name || `Area ${l.id}`,
    scheduleSessionSave: () => { calls.sessionSaves += 1; },
  });

  const firePaste = (event) => (docListeners.get('paste') || []).forEach((fn) => fn(event));

  return {
    island, state, calls, canvases, dropzone, stack, fileInput, furnitureInput, replaceBtn, firePaste,
  };
}

/** A paste event carrying `f`, targeted at a plain element by default. */
const pasteEvent = (f, { target = { closest: () => null } } = {}) => ({
  target,
  clipboardData: { files: f ? [f] : [] },
  prevented: 0,
  preventDefault() { this.prevented += 1; },
});

/** A drag event carrying `f`. */
const dragEvent = (f, opts) => ({
  dataTransfer: transfer(f, opts),
  prevented: 0,
  preventDefault() { this.prevented += 1; },
});

// ---- the room photo gate ----------------------------------------------------

test('a good room photo is shown immediately, with its filename', async () => {
  const h = mount();

  await h.island.handleRoomFile(file({ name: 'living-room.jpg' }));
  await settle();

  assert.deepEqual(
    h.calls.setBaseImage,
    [{ sourceName: 'living-room.jpg' }],
    'the name rides along so the gallery entry can be told apart',
  );
  assert.deepEqual(h.calls.toasts, [], 'a valid photo produces no complaint');
});

test('a file type the server will not take is refused here', async () => {
  const h = mount();

  await h.island.handleRoomFile(file({ type: 'image/gif' }));
  await settle();

  assert.equal(h.calls.setBaseImage.length, 0);
  assert.match(h.calls.toasts[0].message, /JPG, PNG, or WebP/);
  assert.equal(h.calls.toasts[0].type, 'error');
});

test('a file at the shared ceiling is accepted and one byte over is not', async () => {
  // Pinned to MAX_IMAGE_BYTES, not to 25 MB written out: this gate once read 100 MB
  // while multer enforced 25, so the studio accepted uploads the server refused.
  const ok = mount();
  await ok.island.handleRoomFile(file({ size: MAX_IMAGE_BYTES }));
  await settle();
  assert.equal(ok.calls.setBaseImage.length, 1, 'exactly at the ceiling is fine');

  const over = mount();
  await over.island.handleRoomFile(file({ size: MAX_IMAGE_BYTES + 1 }));
  await settle();
  assert.equal(over.calls.setBaseImage.length, 0);
  assert.match(over.calls.toasts[0].message, /too large/i);
});

test('an unreadable file reports rather than failing silently', async () => {
  const h = mount({ readFails: true });

  await h.island.handleRoomFile(file());
  await settle();

  assert.equal(h.calls.setBaseImage.length, 0);
  assert.match(h.calls.toasts[0].message, /went wrong/i);
});

test('a file that will not decode is reported as a bad image', async () => {
  const h = mount({ loadImageFails: true });

  await h.island.handleRoomFile(file());
  await settle();

  assert.equal(h.calls.setBaseImage.length, 0);
  assert.match(h.calls.toasts[0].message, /JPG, PNG, or WebP/);
});

test('no file at all is a no-op', async () => {
  const h = mount();

  await h.island.handleRoomFile(null);
  await settle();

  assert.deepEqual(h.calls.toasts, []);
  assert.equal(h.calls.setBaseImage.length, 0);
});

// ---- HEIC ---------------------------------------------------------------------

test('a HEIC photo is converted before the type gate sees it', async () => {
  // Without the conversion the type check rejects image/heic outright, so an iPhone
  // upload would bounce off a "please use JPG" toast.
  const h = mount({
    heic: {
      isHeic: (f) => /heic/i.test(f.type),
      toDisplayableFile: async () => file({ type: 'image/jpeg', name: 'IMG_0042.jpg' }),
    },
  });

  await h.island.handleRoomFile(file({ type: 'image/heic', name: 'IMG_0042.HEIC' }));
  await settle();

  assert.equal(h.calls.setBaseImage.length, 1, 'the converted file passes the gate');
  assert.equal(h.calls.setBaseImage[0].sourceName, 'IMG_0042.jpg');
});

test('a HEIC conversion that fails is reported, not passed through', async () => {
  const h = mount({
    heic: {
      isHeic: () => true,
      toDisplayableFile: async () => { throw new Error('nope'); },
    },
  });

  await h.island.handleRoomFile(file({ type: 'image/heic' }));
  await settle();

  assert.equal(h.calls.setBaseImage.length, 0);
  assert.equal(h.calls.toasts.length, 1, 'one message, and it is the HEIC one');
  assert.match(h.calls.toasts[0].message, /HEIC/);
  // Exactly one: without the `return`, the unconverted HEIC falls through to the type
  // gate and the user gets a second, contradictory "use a JPG" toast on top.
});

// ---- the stageable-room pre-check ---------------------------------------------

test('a non-room photo is pulled back out once the verdict lands', async () => {
  const h = mount({ verdict: { valid: false, reason: 'SELFIE' } });

  await h.island.handleRoomFile(file());
  await settle();

  assert.equal(h.calls.setBaseImage.length, 1, 'it was shown first — the check never blocks');
  assert.equal(h.calls.clearBaseImage, 1, 'and withdrawn when the verdict arrived');
  assert.equal(h.calls.toasts.length, 1);
  assert.equal(h.calls.toasts[0].type, 'error');
});

test('a stale rejection cannot tear down the photo that replaced it', async () => {
  // The documented race: photo A is uploaded and its check is still in flight when the
  // user picks photo B. Without the `token` capture, A's rejection lands and clears
  // B — the user watches a photo they just chose vanish for a reason about a
  // different one.
  let release = () => {};
  const held = new Promise((r) => { release = r; });
  const h = mount({ verdict: { valid: false, reason: 'SELFIE' }, holdVerdict: held });

  await h.island.handleRoomFile(file({ name: 'a.jpg' }));
  await settle();
  assert.equal(h.calls.setBaseImage.length, 1, 'A is showing');

  // B replaces A while A's verdict is still pending. Its own check is held too.
  await h.island.handleRoomFile(file({ name: 'b.jpg' }));
  await settle();
  assert.equal(h.calls.setBaseImage.length, 2, 'B is showing');

  release();
  await settle();
  await settle();

  assert.equal(h.calls.clearBaseImage, 1, "only B's own verdict may withdraw B");
  assert.ok(h.state.base === null, 'and it did');
});

test('the pre-check fails open on a server error', async () => {
  // Our own hiccup must never block a legitimate upload.
  for (const verdict of ['not-ok', 'garbage', 'throw']) {
    const h = mount({ verdict });
    await h.island.handleRoomFile(file());
    await settle();
    assert.equal(h.calls.clearBaseImage, 0, `verdict "${verdict}" must not reject the photo`);
    assert.deepEqual(h.calls.toasts, [], `verdict "${verdict}" must not toast`);
    dom.restore();
    dom = null;
  }
});

test('the pre-check posts a downscaled image and the session token', async () => {
  const h = mount();

  await h.island.handleRoomFile(file());
  await settle();

  assert.equal(h.calls.validatePosts.length, 1);
  const post = h.calls.validatePosts[0];
  assert.equal(post.url, '/api/validate-image');
  assert.equal(post.headers.Authorization, 'Bearer tok-123', 'the check is attributed to the user');
  assert.match(post.body.image, /^data:image\/jpeg/, 'a JPEG, not the original PNG/HEIC bytes');
  // 2000x1200 scaled to a 1024 long edge. Sending the full frame would multiply every
  // upload's round-trip for a check that only needs to recognise a room.
  assert.equal(h.canvases.length, 1, 'one scratch canvas — the downscale target');
  assert.deepEqual(
    { w: h.canvases[0].width, h: h.canvases[0].height },
    { w: 1024, h: 614 },
    'the vision payload is downscaled to a 1024px long edge',
  );
});

// ---- furniture references ------------------------------------------------------

test('a furniture photo lands on the area and is persisted', async () => {
  const h = mount();
  const target = h.state.layers[0];

  h.island.acceptFurnitureFile(target, file({ name: 'sofa.png', type: 'image/png' }));
  await settle();

  assert.match(target.furniture, /^data:image\/png/, 'stored as a PNG data URL');
  assert.equal(target.furnitureName, 'sofa.png');
  assert.ok(h.calls.renderLayers > 0 && h.calls.updateControls > 0, 'the UI is repainted');
  assert.equal(h.calls.sessionSaves, 1, 'and the work is saved');
  // 2000x1200 scaled to a 1536 long edge — the same ceiling the single-mask editor
  // uses, so the backend sees identical payloads from both studios.
  assert.deepEqual(
    { w: h.canvases[0].width, h: h.canvases[0].height },
    { w: 1536, h: 922 },
    'the reference photo is downscaled to 1536px on its long edge',
  );
});

test('a furniture photo of the wrong type is refused with the type message', async () => {
  const h = mount();
  const target = h.state.layers[0];

  h.island.acceptFurnitureFile(target, file({ type: 'application/pdf' }));
  await settle();

  assert.equal(target.furniture, null);
  assert.match(h.calls.toasts[0].message, /valid JPG, PNG, or WebP/);
});

test('an oversized furniture photo gets the size message, not the type one', async () => {
  // Two different failures with two different fixes — telling the user "wrong format"
  // when the format was fine sends them to re-export an image that only needed
  // shrinking.
  const h = mount();

  h.island.acceptFurnitureFile(h.state.layers[0], file({ size: 26 * 1024 * 1024 }));
  await settle();

  assert.match(h.calls.toasts[0].message, /too large/i);
});

test('a furniture paste announces itself only while its area still exists', async () => {
  // The read is async; deleting the area meanwhile must not pop a toast naming an
  // area that is no longer on screen.
  const h = mount();
  const target = h.state.layers[0];

  h.island.acceptFurnitureFile(target, file({ type: 'image/png' }), true);
  h.state.layers = [];
  await settle();

  assert.deepEqual(h.calls.toasts, [], 'no announcement for a deleted area');
});

test('a furniture paste into a live area does announce', async () => {
  // The positive half: without it the assertion above would pass with the toast
  // deleted outright.
  const h = mount();

  h.island.acceptFurnitureFile(h.state.layers[0], file({ type: 'image/png' }), true);
  await settle();

  assert.equal(h.calls.toasts.length, 1);
  assert.equal(h.calls.toasts[0].type, 'success');
  assert.match(h.calls.toasts[0].message, /Area L1/);
});

test('the shared furniture picker routes to the area that opened it', async () => {
  // One <input> serves every area, so the pending-area cursor is the only thing
  // keeping a reference photo from landing on the wrong one.
  const h = mount({ layers: [layer('L1'), layer('L2')] });

  h.island.beginFurniturePick('L2');
  assert.equal(h.furnitureInput.opened, 1, 'the picker opens');

  h.furnitureInput.pick(file({ type: 'image/png', name: 'chair.png' }));
  await settle();

  assert.equal(h.state.layers[1].furnitureName, 'chair.png');
  assert.equal(h.state.layers[0].furniture, null, 'the other area is untouched');
});

test('the picker cursor is cleared after use, so a stray change goes nowhere', async () => {
  const h = mount({ layers: [layer('L1'), layer('L2')] });

  h.island.beginFurniturePick('L2');
  h.furnitureInput.pick(file({ type: 'image/png', name: 'chair.png' }));
  await settle();

  h.furnitureInput.pick(file({ type: 'image/png', name: 'stray.png' }));
  await settle();

  assert.equal(h.state.layers[1].furnitureName, 'chair.png', 'the second change is not routed');
});

test('picking the same file twice in a row still fires', async () => {
  // A file input does not emit change when re-picking an identical path, so the value
  // has to be cleared. Without it, "choose the wrong photo, then choose the right one,
  // then change your mind back" silently does nothing.
  const h = mount();

  h.fileInput.pick(file());
  await settle();

  assert.equal(h.fileInput.value, '', 'the input resets itself after every pick');
});

// ---- paste routing ---------------------------------------------------------------

test('pasting before a photo is loaded sets the room photo', async () => {
  const h = mount({ base: null });

  h.firePaste(pasteEvent(file()));
  await settle();

  assert.equal(h.calls.setBaseImage.length, 1);
});

test('pasting after a photo is loaded attaches furniture to the active area', async () => {
  const h = mount({ base: { tag: 1 } });

  h.firePaste(pasteEvent(file({ type: 'image/png', name: 'lamp.png' })));
  await settle();

  assert.equal(h.state.layers[0].furnitureName, 'lamp.png');
  assert.equal(h.calls.setBaseImage.length, 0, 'the room photo is not replaced');
});

test('pasting into a text field is left to the text field', async () => {
  // The area prompt boxes are on this page. Swallowing their paste would make typing
  // a prompt by clipboard impossible.
  const h = mount({ base: { tag: 1 } });
  const evt = pasteEvent(file({ type: 'image/png' }), { target: { closest: () => ({}) } });

  h.firePaste(evt);
  await settle();

  assert.equal(evt.prevented, 0, 'the event is not intercepted');
  assert.equal(h.state.layers[0].furniture, null);
});

test('pasting mid-generation is ignored, and not swallowed either', async () => {
  const h = mount({ base: { tag: 1 }, phase: 'generating' });
  const evt = pasteEvent(file({ type: 'image/png' }));

  h.firePaste(evt);
  await settle();

  assert.equal(h.state.layers[0].furniture, null, 'nothing is attached');
  // preventDefault matters independently: the "is it draw phase" check further down
  // also happens to stop the attach, so without this the early return could be
  // deleted and every test would stay green — while the studio quietly ate a paste
  // it had no intention of using.
  assert.equal(evt.prevented, 0, 'the event is left alone rather than consumed');
});

test('pasting text rather than an image is ignored', async () => {
  const h = mount({ base: null });
  const evt = pasteEvent(null);

  h.firePaste(evt);
  await settle();

  assert.equal(evt.prevented, 0);
  assert.equal(h.calls.setBaseImage.length, 0);
});

// ---- drop, click and replace wiring ------------------------------------------------

test('the dropzone opens the picker by click and by keyboard', () => {
  const h = mount();

  h.dropzone.emit('click', {});
  assert.equal(h.fileInput.opened, 1);

  for (const key of ['Enter', ' ']) {
    const evt = { key, prevented: 0, preventDefault() { this.prevented += 1; } };
    h.dropzone.emit('keydown', evt);
    assert.equal(evt.prevented, 1, `${key} activates the dropzone`);
  }
  assert.equal(h.fileInput.opened, 3, 'both keys opened it');
});

test('a key that is not Enter or Space leaves the dropzone alone', () => {
  const h = mount();

  h.dropzone.emit('keydown', { key: 'Tab', preventDefault() { throw new Error('must not'); } });

  assert.equal(h.fileInput.opened, 0);
});

test('dropping on the photo itself guards unsaved work more strictly than the dropzone', () => {
  // Aiming for the furniture button and hitting the photo is easy; replacing the room
  // photo throws away every mask. The dropzone is an explicit target, the photo is not.
  const onZone = mount({ base: { tag: 1 } });
  onZone.dropzone.emit('drop', dragEvent(file()));
  assert.deepEqual(onZone.calls.discards, [{ strict: false }]);

  const onStack = mount({ base: { tag: 1 } });
  onStack.stack.emit('drop', dragEvent(file()));
  assert.deepEqual(onStack.calls.discards, [{ strict: true }]);
});

test('a drop carrying no files is ignored', () => {
  const h = mount();
  const evt = dragEvent(null, { types: ['text/plain'] });

  h.dropzone.emit('drop', evt);

  assert.equal(evt.prevented, 0);
  assert.deepEqual(h.calls.discards, []);
});

test('a drop mid-generation is refused', () => {
  const h = mount({ base: { tag: 1 }, phase: 'generating' });

  h.dropzone.emit('drop', dragEvent(file()));

  assert.deepEqual(h.calls.discards, [], 'no discard prompt while a run is in flight');
});

test('dragging over the dropzone marks it, and leaving clears the mark', () => {
  const h = mount();

  h.dropzone.emit('dragover', dragEvent(file()));
  assert.equal(h.dropzone.classList.contains('is-drag-over'), true);

  h.dropzone.emit('dragleave', {});
  assert.equal(h.dropzone.classList.contains('is-drag-over'), false);
});

test('replace asks before discarding, and is refused mid-generation', () => {
  const h = mount({ base: { tag: 1 } });

  h.replaceBtn.emit('click', {});
  assert.deepEqual(h.calls.discards, [{ strict: false }]);
  assert.equal(h.fileInput.opened, 1);

  h.state.phase = 'generating';
  h.replaceBtn.emit('click', {});
  assert.equal(h.calls.discards.length, 1, 'no second prompt while generating');
  assert.equal(h.fileInput.opened, 1);
});

test('a furniture dropzone accepts a drop onto its own area', async () => {
  const h = mount({ layers: [layer('L1'), layer('L2')] });
  const zone = new FakeEl('div');

  h.island.wireFurnitureDrop(zone, h.state.layers[1]);
  zone.emit('dragenter', dragEvent(file({ type: 'image/png' })));
  assert.equal(zone.classList.contains('is-drag-over'), true);

  zone.emit('drop', dragEvent(file({ type: 'image/png', name: 'rug.png' })));
  await settle();

  assert.equal(h.state.layers[1].furnitureName, 'rug.png');
  assert.equal(zone.classList.contains('is-drag-over'), false, 'the mark is cleared');
  assert.equal(h.state.layers[0].furniture, null);
});
