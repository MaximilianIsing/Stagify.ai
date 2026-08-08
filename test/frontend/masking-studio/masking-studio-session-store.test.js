// Tier: frontend island logic (DOM-stubbed) — public/scripts/masking-studio/session-store.js.
//
// The crash-recovery island: the photo, strokes and prompts go to IndexedDB on a
// 1.5s debounce so a closed tab does not lose the work, and a returning visitor is
// offered the session back. Its pure half (the plain-object projection) is already
// covered by masking-studio-session.test.js; what lives HERE is everything that
// suite deliberately left out — the transport, the debounce, and the save/discard
// choreography. Those are where the data-loss bugs live, because every storage call
// swallows its own errors and a broken one therefore looks exactly like a working
// one from the outside.
//
// The case worth the file on its own is "a discard mid-encode wins". saveSessionNow
// awaits a JPEG encode of the photo and a PNG encode of every painted mask before it
// writes; the user can discard the session inside that window, and without the
// `saveSeq` check the write lands afterwards and resurrects exactly the work they
// just threw away. It is asserted below by holding the encode open across the
// discard, which is the only ordering that reaches it.
//
// TIME IS COMPRESSED, not mocked: setTimeout is wrapped so the 1.5s debounce becomes
// ~1ms, matching test/frontend/app/staging-pipeline.test.js. The delay's exact value
// is not under test; that it is debounced at all, and that the pending timer is
// flushed when the tab hides, are.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createSessionStore } from '../../../public/scripts/masking-studio/session-store.js';

// Captured once, at module load, so a test that builds two harnesses cannot save the
// first harness's shims as if they were the originals.
const REAL = {
  document: globalThis.document,
  indexedDB: globalThis.indexedDB,
  URL: globalThis.URL,
  Image: globalThis.Image,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
};

/**
 * Let the island's pending work settle.
 *
 * Every fake below completes on a MICROTASK, not a timer, so the only real clock in
 * play is the compressed debounce. A single fixed wall-clock wait was measurably
 * flaky — the save chain is `timer → open → transaction → complete`, and on a loaded
 * machine the tail of that landed after the wait — so this drains repeatedly instead
 * of betting on one duration.
 */
const tick = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => REAL.setTimeout(r, 2));
};

const PALETTE = [{ hex: '#f00' }, { hex: '#0f0' }, { hex: '#00f' }];
const MAX_LAYERS = 3;

// ---- Fakes -----------------------------------------------------------------

/**
 * A canvas whose toBlob can be held open, to reach the mid-encode orderings, and
 * which counts how often it was asked to encode.
 */
function fakeCanvas({ hold = null, label = 'canvas' } = {}) {
  return {
    label,
    width: 0,
    height: 0,
    className: '',
    encodes: 0,
    getContext: () => ({ drawImage: () => {} }),
    toBlob(cb) {
      this.encodes += 1;
      if (hold) hold.then(() => cb({ blob: label }));
      else cb({ blob: label });
    },
  };
}

/** A layer as layers.js builds one, minus the fields this island never reads. */
function fakeLayer(id, { painted = true, name = '', prompt = '' } = {}) {
  return {
    id,
    colorIdx: 0,
    canvasEl: fakeCanvas({ label: `mask-${id}` }),
    painted,
    name,
    prompt,
    mode: 'stage',
    furniture: null,
    furnitureName: '',
  };
}

/** A button that records its listeners and can replay them, awaiting async ones. */
function fakeButton() {
  const handlers = [];
  return {
    focused: 0,
    focus() { this.focused += 1; },
    addEventListener: (_type, fn) => handlers.push(fn),
    get listenerCount() { return handlers.length; },
    click: () => Promise.all(handlers.map((fn) => fn())),
  };
}

function fakeClassList() {
  const classes = new Set();
  return {
    add: (c) => classes.add(c),
    remove: (c) => classes.delete(c),
    contains: (c) => classes.has(c),
  };
}

/**
 * An IndexedDB stand-in recording every write, with the failure modes the island
 * claims to survive: `openFails` is private-browsing/old-browser, `txFails` is a
 * quota error mid-transaction.
 */
function fakeIndexedDB({ openFails = false, txFails = false, stored = null } = {}) {
  const calls = { puts: [], deletes: 0, gets: 0, opens: 0 };
  const objectStore = {
    put(value) { calls.puts.push(value); return {}; },
    get() { calls.gets += 1; return { result: stored }; },
    delete() { calls.deletes += 1; return {}; },
  };
  const db = {
    createObjectStore: () => objectStore,
    transaction() {
      if (txFails) throw new Error('QuotaExceededError');
      const tr = { objectStore: () => objectStore };
      // oncomplete is assigned by the island AFTER the operation call returns, so
      // firing it has to be deferred or the island never sees it. A microtask is the
      // shortest deferral that still lands after that synchronous assignment.
      queueMicrotask(() => tr.oncomplete && tr.oncomplete());
      return tr;
    },
  };
  return {
    calls,
    api: {
      open() {
        calls.opens += 1;
        const req = { result: db };
        queueMicrotask(() => {
          if (openFails) { if (req.onerror) req.onerror(); return; }
          if (req.onupgradeneeded) req.onupgradeneeded();
          if (req.onsuccess) req.onsuccess();
        });
        return req;
      },
    },
  };
}

/**
 * Build the island against a fake browser, handing back every collaborator a test
 * needs to drive or inspect.
 *
 * `decodeFails` is how a corrupt stored record behaves — 'all' kills the photo decode
 * too (the whole restore aborts), 'masks' kills only the per-area masks (the restore
 * should survive). The two are NOT interchangeable: a fake that failed everything
 * would make the per-mask catch untestable, because the photo decode throws first and
 * the layer loop is never reached.
 *
 * `holdEncode` is a promise the photo encode waits on, so a test can act while a save
 * is mid-flight.
 */
function mount({
  base = false,
  phase = 'draw',
  layers = [],
  sourceName = '',
  stored = null,
  openFails = false,
  txFails = false,
  decodeFails = null,
  holdEncode = null,
  holdMaskDecode = null,
} = {}) {
  const idb = fakeIndexedDB({ openFails, txFails, stored });
  const state = {
    base: base ? { w: 800, h: 600, canvas: fakeCanvas({ hold: holdEncode, label: 'base' }) } : null,
    layers: [...layers],
    layerSeq: 0,
    activeId: null,
    phase,
    sourceName,
  };
  const calls = {
    setBaseImage: [],
    addLayer: 0,
    renderLayers: 0,
    updateControls: 0,
    toasts: [],
    inserted: [],
  };
  const visibility = { handlers: [], state: 'visible' };
  const yes = fakeButton();
  const no = fakeButton();
  const resumeEl = { classList: fakeClassList() };

  // Compress the 1.5s debounce to ~1ms. Re-applied per mount rather than once at
  // module load because afterEach restores the real timer between cases.
  globalThis.setTimeout = /** @type {any} */ (
    (fn, ms, ...rest) => REAL.setTimeout(fn, ms > 1 ? 1 : ms, ...rest)
  );
  globalThis.indexedDB = /** @type {any} */ (idb.api);
  // The object URL carries the blob's label so the Image fake can tell the photo
  // decode apart from a mask decode.
  globalThis.URL = /** @type {any} */ ({
    createObjectURL: (b) => `blob:${(b && b.blob) || 'unknown'}`,
    revokeObjectURL: () => {},
  });
  globalThis.Image = /** @type {any} */ (
    class {
      set src(v) {
        const isMask = String(v).includes('mask');
        const fails = decodeFails === 'all' || (decodeFails === 'masks' && isMask);
        const settle = () => {
          if (fails) { if (this.onerror) this.onerror(); }
          else if (this.onload) this.onload();
        };
        // A real mask decode takes milliseconds, which is long enough for a debounced
        // save to fire in the middle of a restore. Microtask-fast fakes close that
        // window and make the `restoring` latch look untestable, so a test can hold
        // the decode open to reopen it.
        if (isMask && holdMaskDecode) holdMaskDecode.then(settle);
        else queueMicrotask(settle);
      }
    }
  );
  globalThis.document = /** @type {any} */ ({
    get visibilityState() { return visibility.state; },
    addEventListener: (type, fn) => { if (type === 'visibilitychange') visibility.handlers.push(fn); },
    createElement: () => fakeCanvas({ label: 'restored-layer' }),
  });

  /** @type {any} */
  let built = null;

  const store = createSessionStore({
    state,
    MAX_LAYERS,
    PALETTE,
    stack: { insertBefore: (c) => calls.inserted.push(c) },
    resultCanvas: fakeCanvas({ label: 'result' }),
    resumeEl,
    resumeYesBtn: yes,
    resumeNoBtn: no,
    setBaseImage: (_img, opts) => {
      calls.setBaseImage.push(opts || {});
      state.base = { w: 800, h: 600, canvas: fakeCanvas({ label: 'restored-base' }) };
      // Accepting a photo schedules a save in the real entry, and during a restore
      // that call lands BEFORE the areas are rebuilt. Reproducing it here is what
      // puts the island's `restoring` latch under test.
      if (built) built.scheduleSessionSave();
    },
    addLayer: () => {
      calls.addLayer += 1;
      state.layers.push(fakeLayer(`A${state.layers.length}`));
    },
    renderLayers: () => { calls.renderLayers += 1; },
    updateControls: () => { calls.updateControls += 1; },
    showToast: (message, type) => calls.toasts.push({ message, type }),
    tx: (_key, def) => def,
  });

  built = store;
  return { store, state, calls, idb, visibility, yes, no, resumeEl };
}

/** A stored record the island should consider restorable. */
const savedSession = (layers = []) => ({
  savedAt: 1700000000000,
  baseBlob: { blob: 'stored-base' },
  layers,
  sourceName: 'living-room.jpg',
});

const storedLayer = (over = {}) => ({
  colorIdx: 1,
  name: 'Sofa',
  prompt: 'a grey sofa',
  mode: 'stage',
  furniture: null,
  furnitureName: '',
  painted: true,
  mask: { blob: 'mask' },
  ...over,
});

afterEach(() => {
  globalThis.document = REAL.document;
  globalThis.indexedDB = REAL.indexedDB;
  globalThis.URL = REAL.URL;
  globalThis.Image = REAL.Image;
  globalThis.setTimeout = REAL.setTimeout;
  globalThis.clearTimeout = REAL.clearTimeout;
});


// ---- saving ----------------------------------------------------------------

test('nothing is written until a photo exists', async () => {
  const { store, idb } = mount();

  store.scheduleSessionSave();
  await tick();

  assert.deepEqual(idb.calls.puts, [], 'an empty studio must not write a session record');
});

test('a scheduled save stores the photo, the layers and the filename', async () => {
  const { store, idb } = mount({
    base: true,
    sourceName: 'kitchen.jpg',
    layers: [fakeLayer('L1', { name: 'Sofa', prompt: 'grey sofa' })],
  });

  store.scheduleSessionSave();
  await tick();

  assert.equal(idb.calls.puts.length, 1, 'exactly one record is written');
  const [record] = idb.calls.puts;
  assert.deepEqual(record.baseBlob, { blob: 'base' }, 'the photo is encoded into the record');
  assert.equal(record.sourceName, 'kitchen.jpg', 'the filename survives, or the gallery entry is misnamed');
  assert.equal(record.layers.length, 1);
  assert.equal(record.layers[0].prompt, 'grey sofa');
  assert.deepEqual(record.layers[0].mask, { blob: 'mask-L1' }, 'a painted area stores its mask');
});

test('an unpainted area is never encoded', async () => {
  // That the RECORD holds no mask is session.js's guard and is covered there. What
  // belongs to this island is not doing the work: a PNG encode per empty area, on
  // every debounce tick, for the whole session.
  const blank = fakeLayer('L1', { painted: false });
  const drawn = fakeLayer('L2', { painted: true });
  const { store, idb } = mount({ base: true, layers: [blank, drawn] });

  store.scheduleSessionSave();
  await tick();

  assert.equal(blank.canvasEl.encodes, 0, 'an empty area must not be encoded at all');
  assert.equal(drawn.canvasEl.encodes, 1, 'a painted one is');
  assert.equal(idb.calls.puts[0].layers[0].mask, null, 'and stores no mask');
});

test('repeated edits debounce into a single write', async () => {
  const { store, idb } = mount({ base: true, layers: [fakeLayer('L1')] });

  store.scheduleSessionSave();
  store.scheduleSessionSave();
  store.scheduleSessionSave();
  await tick();

  assert.equal(idb.calls.puts.length, 1, 'three strokes in a row must not mean three writes');
});

test('a save during generation is deferred, not dropped', async () => {
  // The edits made just before Apply Edit are the ones most worth keeping. The
  // island reschedules instead of returning, so they land once the run leaves the
  // generating phase — a plain `return` here would lose them silently.
  const h = mount({ base: true, phase: 'generating', layers: [fakeLayer('L1')] });

  h.store.scheduleSessionSave();
  await tick();
  assert.deepEqual(h.idb.calls.puts, [], 'nothing is written while generating');

  h.state.phase = 'draw';
  await tick();

  assert.equal(h.idb.calls.puts.length, 1, 'the deferred save lands once the run finishes');
});

test('hiding the tab flushes a pending save immediately', async () => {
  const h = mount({ base: true, layers: [fakeLayer('L1')] });

  h.store.scheduleSessionSave();
  h.visibility.state = 'hidden';
  h.visibility.handlers.forEach((fn) => fn());
  await tick();

  assert.equal(h.idb.calls.puts.length, 1, 'a backgrounded tab must not lose the debounced write');
});

test('a visibility change with nothing pending writes nothing', async () => {
  // The positive case above would still pass with the `saveTimer` guard deleted; this
  // is what stops every tab switch from re-encoding the photo.
  const h = mount({ base: true, layers: [fakeLayer('L1')] });

  h.visibility.state = 'hidden';
  h.visibility.handlers.forEach((fn) => fn());
  await tick();

  assert.deepEqual(h.idb.calls.puts, []);
});

// ---- the discard-mid-encode race -------------------------------------------

test('discarding the session while a save is encoding does not resurrect it', async () => {
  // The ordering that reaches the `saveSeq` guard: the resume dialog is open (so the
  // discard button is live), a photo arrives, its save starts and blocks in the JPEG
  // encode, and the discard lands inside that window. Without the guard the encode
  // finishes afterwards and writes the record straight back.
  let releaseEncode = () => {};
  const held = new Promise((r) => { releaseEncode = r; });

  const h = mount({ stored: savedSession(), holdEncode: held });

  const offered = await h.store.maybeOfferResume();
  assert.equal(offered, true, 'a stored session is offered');

  // The photo the user uploads while the dialog is still up.
  h.state.base = { w: 800, h: 600, canvas: fakeCanvas({ hold: held, label: 'base' }) };
  h.state.layers = [fakeLayer('L1')];
  h.store.scheduleSessionSave();
  await tick();

  await h.no.click();          // discard — bumps saveSeq and clears the record
  releaseEncode();
  await tick();
  await tick();

  assert.equal(h.idb.calls.deletes, 1, 'the stored record is deleted');
  assert.deepEqual(
    h.idb.calls.puts,
    [],
    'the in-flight save must abort — writing here restores work the user just discarded',
  );
});

// ---- the resume offer ------------------------------------------------------

test('no stored session means no dialog', async () => {
  const h = mount({ stored: null });

  assert.equal(await h.store.maybeOfferResume(), false);
  assert.equal(h.resumeEl.classList.contains('active'), false);
});

test('a malformed record with no photo is dropped silently', async () => {
  const h = mount({ stored: { savedAt: 1, layers: [] } });

  assert.equal(await h.store.maybeOfferResume(), false, 'a record with no baseBlob is not restorable');
  assert.equal(h.resumeEl.classList.contains('active'), false);
});

test('a session already in progress is never interrupted by the offer', async () => {
  const h = mount({ stored: savedSession(), base: true });

  assert.equal(await h.store.maybeOfferResume(), false, 'live work outranks a stored record');
  assert.equal(h.resumeEl.classList.contains('active'), false);
});

test('the offer opens the dialog and moves focus to it', async () => {
  const h = mount({ stored: savedSession() });

  assert.equal(await h.store.maybeOfferResume(), true);
  assert.equal(h.resumeEl.classList.contains('active'), true);
  assert.equal(h.yes.focused, 1, 'the dialog takes focus, or a keyboard user cannot answer it');
});

test('accepting the offer restores the photo, its filename and its areas', async () => {
  const h = mount({
    stored: savedSession([storedLayer({ name: 'Sofa' }), storedLayer({ name: 'Rug' })]),
  });

  await h.store.maybeOfferResume();
  await h.yes.click();
  await tick();

  assert.equal(h.resumeEl.classList.contains('active'), false, 'the dialog closes');
  assert.deepEqual(
    h.calls.setBaseImage,
    [{ noLayer: true, sourceName: 'living-room.jpg' }],
    'the filename must be restored WITH the photo — setBaseImage clears it by default',
  );
  assert.equal(h.state.layers.length, 2, 'both stored areas come back');
  assert.deepEqual(h.state.layers.map((l) => l.name), ['Sofa', 'Rug']);
  assert.equal(h.state.activeId, h.state.layers[0].id, 'the first area is selected');
  assert.equal(h.calls.addLayer, 0, 'a restored session does not get an extra empty area');
  assert.ok(h.calls.renderLayers > 0 && h.calls.updateControls > 0, 'the UI is repainted');
});

test('a save requested mid-restore cannot overwrite the record being restored', async () => {
  // The photo lands before the areas do, and accepting a photo schedules a save. If
  // the `restoring` latch is dropped, that debounced save fires against a state with
  // ZERO rebuilt areas and writes it over the stored record — the user accepts the
  // resume offer and their masks are destroyed by the act of restoring them.
  let releaseMasks = () => {};
  const held = new Promise((r) => { releaseMasks = r; });
  const h = mount({
    stored: savedSession([storedLayer({ name: 'Sofa' }), storedLayer({ name: 'Rug' })]),
    holdMaskDecode: held,
  });

  await h.store.maybeOfferResume();
  const restored = h.yes.click();
  await tick();

  // The photo is in, the areas are still decoding, and the debounce has had time to
  // fire. Anything written here is the half-built session.
  assert.deepEqual(h.calls.setBaseImage.length, 1, 'the photo landed, so a save was requested');
  assert.deepEqual(h.idb.calls.puts, [], 'nothing may be written while the areas are missing');

  releaseMasks();
  await restored;
  await tick();

  assert.equal(h.idb.calls.puts.length, 1, 'one write, once the restore finished');
  assert.equal(
    h.idb.calls.puts[0].layers.length,
    2,
    'it carries the whole restored session, not the half-built one',
  );
});

test('a restored session with no areas gets a fresh one', async () => {
  const h = mount({ stored: savedSession([]) });

  await h.store.maybeOfferResume();
  await h.yes.click();
  await tick();

  assert.equal(h.calls.addLayer, 1, 'there must always be something to draw on');
  assert.equal(h.state.layers.length, 1);
});

test('a stored session with more areas than the studio allows is truncated', async () => {
  const many = Array.from({ length: MAX_LAYERS + 2 }, (_, i) => storedLayer({ name: `Area ${i}` }));
  const h = mount({ stored: savedSession(many) });

  await h.store.maybeOfferResume();
  await h.yes.click();
  await tick();

  assert.equal(h.state.layers.length, MAX_LAYERS, 'the cap holds across a restore, not just a live add');
});

test('an area whose mask will not decode still comes back, just unpainted', async () => {
  // Losing one corrupt mask is recoverable; losing the whole session is not. The name
  // and prompt survive so the user can repaint rather than retype, and the area is
  // marked unpainted so nothing downstream tries to generate from an empty canvas.
  const h = mount({
    stored: savedSession([storedLayer({ name: 'Sofa', prompt: 'a grey sofa' })]),
    decodeFails: 'masks',
  });

  await h.store.maybeOfferResume();
  await h.yes.click();
  await tick();

  assert.deepEqual(h.calls.toasts, [], 'one bad mask is not a failed restore');
  assert.equal(h.state.layers.length, 1, 'the area still comes back');
  assert.equal(h.state.layers[0].name, 'Sofa');
  assert.equal(h.state.layers[0].prompt, 'a grey sofa', 'the typing survives');
  assert.equal(h.state.layers[0].painted, false, 'but with no paint on it');
});

test('declining the offer discards the stored session', async () => {
  const h = mount({ stored: savedSession() });

  await h.store.maybeOfferResume();
  await h.no.click();
  await tick();

  assert.equal(h.resumeEl.classList.contains('active'), false);
  assert.equal(h.idb.calls.deletes, 1, '"No" must actually delete, or the offer returns forever');
  assert.deepEqual(h.calls.setBaseImage, [], 'nothing is restored');
});

test('a restore that throws reports it and clears the poisoned record', async () => {
  const h = mount({ stored: savedSession(), decodeFails: 'all' });

  await h.store.maybeOfferResume();
  await h.yes.click();
  await tick();

  assert.equal(h.calls.toasts.length, 1, 'the user is told, rather than left on a dead dialog');
  assert.equal(h.calls.toasts[0].type, 'error');
  assert.equal(h.idb.calls.deletes, 1, 'the unreadable record is dropped so it cannot be offered again');
});

// ---- storage failures are survivable ---------------------------------------

test('a browser with no usable IndexedDB degrades to no persistence', async () => {
  // Private mode, or a storage-disabled profile. Every call resolves null rather
  // than rejecting, so nothing here may throw.
  const h = mount({ stored: savedSession(), openFails: true, base: true });

  assert.equal(await h.store.maybeOfferResume(), false);
  h.store.scheduleSessionSave();
  await tick();

  assert.deepEqual(h.idb.calls.puts, []);
});

test('a transaction that throws mid-save is swallowed', async () => {
  const h = mount({ txFails: true, base: true, layers: [fakeLayer('L1')] });

  h.store.scheduleSessionSave();
  await tick();

  assert.deepEqual(h.idb.calls.puts, [], 'a quota error must not surface as an unhandled rejection');
});

test('the island reuses one connection instead of reopening per write', async () => {
  const h = mount({ base: true, layers: [fakeLayer('L1')] });

  h.store.scheduleSessionSave();
  await tick();
  h.store.scheduleSessionSave();
  await tick();

  assert.equal(h.idb.calls.puts.length, 2, 'both saves land');
  assert.equal(h.idb.calls.opens, 1, 'open() is memoized — one connection for the page');
});
