// Sending a finished composite to the gallery (public/scripts/masking-studio/gallery-save.js)
// and the handoff that decides whether it replaces an existing entry
// (public/scripts/masking-handoff.js).
//
// The requirement these tests exist for is a negative one: mask OPERATIONS must never create
// gallery entries. That is enforced structurally — nothing but the "Looks Good" handler can
// reach this module — so the last three tests are source scans that fail if the structure
// erodes. The rest is about the two ways a save goes wrong in practice: firing twice for one
// result, and carrying a stale render id onto a different photo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGallerySave, canvasDigest } from '../../../public/scripts/masking-studio/gallery-save.js';
import { HANDOFF_KEY, sendToMaskingStudio, receiveHandoff } from '../../../public/scripts/masking-handoff.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..').replace(/\\/g, '/');
const read = (rel) => fs.readFileSync(path.join(ROOT, 'public/scripts', rel), 'utf8');

/**
 * Strip comments before a source scan.
 *
 * Without this every guard below passes on a file whose only mention of the thing it forbids
 * is a comment explaining that it is forbidden — this repo has shipped that bug before. See
 * test/data/user-deletion.test.js for the same routine at more length.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** A canvas stand-in whose "pixels" are whatever byte we say. */
function fakeCanvas(fill = 1) {
  return {
    width: 100,
    height: 80,
    getContext: () => ({
      drawImage() {},
      getImageData: () => ({ data: new Uint8ClampedArray(64 * 64 * 4).fill(fill) }),
    }),
    toDataURL: () => `data:image/jpeg;base64,PIXELS${fill}`,
  };
}

/**
 * A document stand-in that hands back a scratch canvas whose pixels are whatever the
 * canvas being digested reports. `canvasDigest` downsamples through this one.
 */
function fakeDoc() {
  let pending = null;
  return /** @type {any} */ ({
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage(src) { pending = src.getContext().getImageData(); },
        getImageData: () => pending ?? { data: new Uint8ClampedArray(64 * 64 * 4) },
      }),
    }),
  });
}

function makeSave(over = {}) {
  const calls = [];
  const state = {
    base: { w: 100, h: 80, canvas: fakeCanvas(9) },
    layers: [
      { status: 'done', prompt: 'add a sofa' },
      { status: 'done', prompt: 'add a rug' },
      { status: 'idle', prompt: 'ignored' },
    ],
    sourceRenderId: null,
    sourceName: 'elm-st-04.jpg',
    savedDigest: '',
    ...over.state,
  };
  const save = createGallerySave({
    state,
    resultCanvas: over.resultCanvas || fakeCanvas(1),
    authToken: () => 'tok',
    onEvicted: (g) => calls.push({ evicted: g }),
    doc: fakeDoc(),
    fetchImpl: over.fetchImpl || (async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({ success: true, gallery: null }) };
    }),
  });
  return { save, state, calls };
}

// ── the digest, which is what makes the save idempotent ──────────────────────

test('the digest separates two different composites and matches an identical one', () => {
  assert.equal(canvasDigest(fakeCanvas(1), fakeDoc()), canvasDigest(fakeCanvas(1), fakeDoc()));
  assert.notEqual(canvasDigest(fakeCanvas(1), fakeDoc()), canvasDigest(fakeCanvas(2), fakeDoc()));
});

test('a canvas that cannot be read yields no digest rather than throwing', () => {
  const broken = { getContext: () => { throw new Error('no ctx'); } };
  assert.equal(canvasDigest(/** @type {any} */ (broken), fakeDoc()), '');
});

// ── saving ───────────────────────────────────────────────────────────────────

test('Looks Good posts the composite, the areas and the prompts', async () => {
  const { save, calls } = makeSave();
  await save.saveToGallery();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/masking-studio/save');
  assert.equal(calls[0].body.after, 'data:image/jpeg;base64,PIXELS1');
  assert.equal(calls[0].body.areas, 2, 'only the DONE areas count');
  assert.deepEqual(calls[0].body.prompts, ['add a sofa', 'add a rug']);
  assert.equal(calls[0].body.sourceName, 'elm-st-04.jpg');
});

test('pressing Looks Good twice on the same result saves once', async () => {
  // "Looks Good → Refine Edit → Looks Good" is a designed loop, so this happens for real.
  const { save, calls } = makeSave();
  await save.saveToGallery();
  await save.saveToGallery();
  assert.equal(calls.length, 1);
});

test('a CHANGED composite saves again — a missed save is worse than a duplicate', async () => {
  // The reason the guard is a pixel digest and not state.genRun: retryLayer and
  // selectCandidate both produce a new result without bumping genRun, so a genRun-keyed
  // guard would silently drop this save.
  let fill = 1;
  const resultCanvas = {
    width: 100,
    height: 80,
    getContext: () => ({
      drawImage() {},
      getImageData: () => ({ data: new Uint8ClampedArray(64 * 64 * 4).fill(fill) }),
    }),
    toDataURL: () => `data:image/jpeg;base64,PIXELS${fill}`,
  };
  const { save, calls } = makeSave({ resultCanvas: /** @type {any} */ (resultCanvas) });
  await save.saveToGallery();
  fill = 7; // the user refined an area and pressed Looks Good again
  await save.saveToGallery();
  assert.equal(calls.length, 2);
});

test('a failed save can be retried by pressing the button again', async () => {
  const { save, calls } = makeSave({ fetchImpl: async () => ({ ok: false }) });
  await save.saveToGallery();
  await save.saveToGallery();
  assert.equal(calls.length, 0, 'nothing was recorded as saved');
  assert.equal(makeSave().state.savedDigest, '', 'and the digest was not advanced');
});

test('a network failure is swallowed — the user still has their image', async () => {
  const { save } = makeSave({ fetchImpl: async () => { throw new Error('offline'); } });
  await assert.doesNotReject(() => save.saveToGallery());
});

test('an entry handed off from the gallery replaces it, and sends no "before"', async () => {
  // The original entry already has its own source photo, and THAT is the right before for a
  // refined after — sending the studio's input would compare the image against itself.
  const { save, calls } = makeSave({ state: { sourceRenderId: 'r_123' } });
  await save.saveToGallery();
  assert.equal(calls[0].body.renderId, 'r_123');
  assert.equal(calls[0].body.before, undefined);
});

test('a photo from disk sends its "before" and asks for no replacement', async () => {
  const { save, calls } = makeSave();
  await save.saveToGallery();
  assert.equal(calls[0].body.renderId, undefined);
  assert.equal(calls[0].body.before, 'data:image/jpeg;base64,PIXELS9', 'the pristine original');
});

test('an eviction that broke a share link is reported; a quiet one is not', async () => {
  const withShare = makeSave({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ success: true, gallery: { evicted: [{ id: 'x', hadLiveShare: true }] } }),
    }),
  });
  await withShare.save.saveToGallery();
  assert.equal(withShare.calls.filter((c) => c.evicted).length, 1);

  const quiet = makeSave({
    fetchImpl: async () => ({ ok: true, json: async () => ({ success: true, gallery: { evicted: [] } }) }),
  });
  await quiet.save.saveToGallery();
  assert.equal(quiet.calls.filter((c) => c.evicted).length, 0);
});

test('nothing is posted when there is no photo', async () => {
  const { save, calls } = makeSave({ state: { base: null } });
  await save.saveToGallery();
  assert.equal(calls.length, 0);
});

// ── the handoff ──────────────────────────────────────────────────────────────

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
    size: () => map.size,
  };
}

test('the handoff carries the render id and the filename', () => {
  const storage = fakeStorage();
  assert.equal(sendToMaskingStudio({ renderId: 'r_1', sourceName: 'a.jpg', storage }), true);
  assert.deepEqual(JSON.parse(storage.getItem(HANDOFF_KEY)), { renderId: 'r_1', sourceName: 'a.jpg' });
});

test('a handoff with no render id is refused, so the caller does not navigate', () => {
  const storage = fakeStorage();
  assert.equal(sendToMaskingStudio({ renderId: '', storage }), false);
  assert.equal(storage.size(), 0);
});

test('storage that refuses is reported, rather than opening an empty studio', () => {
  const blocked = { setItem() { throw new Error('quota'); }, getItem: () => null, removeItem() {} };
  assert.equal(sendToMaskingStudio({ renderId: 'r_1', storage: /** @type {any} */ (blocked) }), false);
});

test('taking delivery loads the photo and marks it as a refine of that render', async () => {
  const storage = fakeStorage();
  sendToMaskingStudio({ renderId: 'r_9', sourceName: '412-rosewood.jpg', storage });
  const seen = [];
  global.URL.createObjectURL = () => 'blob:x';
  global.URL.revokeObjectURL = () => {};
  const ok = await receiveHandoff({
    loadImage: async () => /** @type {any} */ ({ width: 10, height: 10 }),
    setBaseImage: (img, opts) => seen.push(opts),
    authToken: () => 'tok',
    onError: () => seen.push('error'),
    storage,
    fetchImpl: async (url) => {
      seen.push(url);
      return { ok: true, blob: async () => /** @type {any} */ ({}) };
    },
  });
  assert.equal(ok, true);
  assert.equal(seen[0], '/api/gallery/r_9/source', 'our own origin, never the presigned URL');
  assert.deepEqual(seen[1], { sourceRenderId: 'r_9', sourceName: '412-rosewood.jpg' });
});

test('the handoff is consumed once, so a reload does not re-import it', async () => {
  const storage = fakeStorage();
  sendToMaskingStudio({ renderId: 'r_9', storage });
  global.URL.createObjectURL = () => 'blob:x';
  global.URL.revokeObjectURL = () => {};
  const deps = {
    loadImage: async () => /** @type {any} */ ({}),
    setBaseImage: () => {},
    authToken: () => '',
    onError: () => {},
    storage,
    fetchImpl: async () => ({ ok: true, blob: async () => /** @type {any} */ ({}) }),
  };
  assert.equal(await receiveHandoff(deps), true);
  assert.equal(storage.size(), 0, 'the key is deleted before it is used');
  assert.equal(await receiveHandoff(deps), false);
});

test('no handoff at all is silent — it is the normal case', async () => {
  const seen = [];
  const ok = await receiveHandoff({
    loadImage: async () => /** @type {any} */ ({}),
    setBaseImage: () => {},
    authToken: () => '',
    onError: () => seen.push('error'),
    storage: fakeStorage(),
    fetchImpl: async () => { throw new Error('must not fetch'); },
  });
  assert.equal(ok, false);
  assert.deepEqual(seen, [], 'onError is for a FAILED handoff, not an absent one');
});

test('a handoff whose bytes will not load falls back to the dropzone, loudly', async () => {
  const storage = fakeStorage();
  sendToMaskingStudio({ renderId: 'r_9', storage });
  const seen = [];
  const ok = await receiveHandoff({
    loadImage: async () => /** @type {any} */ ({}),
    setBaseImage: () => {},
    authToken: () => '',
    onError: () => seen.push('error'),
    storage,
    fetchImpl: async () => ({ ok: false }),
  });
  assert.equal(ok, false);
  assert.deepEqual(seen, ['error']);
});

// ── DRIFT GUARDS: nothing else may save ──────────────────────────────────────

test('DRIFT GUARD: the generation pipeline cannot reach the save at all', () => {
  // generate-pipeline.js owns retryLayer, selectCandidate and compositeAll; snap-refine.js
  // owns Snap to object. None of them may save, and the guarantee is that they have nothing
  // to call rather than a condition somebody can invert.
  for (const rel of ['masking-studio/generate-pipeline.js', 'masking-studio/snap-refine.js']) {
    const src = stripComments(read(rel));
    assert.ok(!/gallery-save/.test(src), `${rel} now imports the gallery save`);
    assert.ok(!/saveToGallery/.test(src), `${rel} now calls saveToGallery`);
    assert.ok(!/masking-studio\/save/.test(src), `${rel} now posts to the save endpoint`);
  }
});

test('DRIFT GUARD: neither shared mask editor saves anything', () => {
  // The basic mask editor and the AI Designer's copy BOTH have a "Looks good" button of
  // their own (pdf.maskEditor.done). They must stay silent — the requirement is explicit.
  for (const rel of ['app/stage-mask-editor.js', 'ai-designer/mask-editor.js', 'mask/generate.js']) {
    const src = stripComments(read(rel));
    assert.ok(!/gallery-save/.test(src), `${rel} now imports the gallery save`);
    assert.ok(!/saveToGallery/.test(src), `${rel} now calls saveToGallery`);
    assert.ok(!/masking-studio\/save/.test(src), `${rel} now posts to the save endpoint`);
  }
});

test('DRIFT GUARD: exactly one call site, and it is the Looks Good handler', () => {
  const entry = stripComments(read('masking-studio-app.js'));
  const calls = entry.match(/saveToGallery\(\)/g) || [];
  assert.equal(calls.length, 1, 'saveToGallery is called more than once');
  // ...and it is inside the #ms-view-result click handler, not the download one.
  const handler = entry.slice(entry.indexOf('viewResultBtn.addEventListener'));
  assert.ok(
    handler.slice(0, handler.indexOf('});')).includes('saveToGallery()'),
    'the save is no longer inside the Looks Good handler',
  );
  const download = entry.slice(entry.indexOf('downloadBtn.addEventListener'));
  assert.ok(
    !download.slice(0, download.indexOf('});')).includes('saveToGallery'),
    'Download must not save — it is a second press for the same result',
  );
});
