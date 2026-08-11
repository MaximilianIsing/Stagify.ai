// Sending a finished composite to the gallery (public/scripts/masking-studio/gallery-save.js).
//
// The requirement these tests exist for is a negative one: mask OPERATIONS must never create
// gallery entries. That is enforced structurally — nothing but the "Looks Good" handler can
// reach this module — so the last three tests are source scans that fail if the structure
// erodes. The rest is about the way a save goes wrong in practice: firing twice for one
// result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGallerySave, canvasDigest } from '../../../public/scripts/masking-studio/gallery-save.js';

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
    sourceName: 'elm-st-04.jpg',
    savedDigest: '',
    ...over.state,
  };
  const save = createGallerySave({
    state,
    resultCanvas: over.resultCanvas || fakeCanvas(1),
    authToken: () => 'tok',
    onEvicted: (g) => calls.push({ evicted: g }),
    onLabelFailed: (m) => calls.push({ labelFailed: m }),
    badgeFields: over.badgeFields,
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

// ── "Label as virtually staged" ──────────────────────────────────────────────

test('the badge settings ride along, so the SERVER can stamp the stored master', async () => {
  // Stamped server-side rather than here: this request already carries the composite, so
  // routing it through /api/stamp-image first would upload the same megabyte twice.
  const { save, calls } = makeSave({
    badgeFields: () => ({
      labelVirtuallyStaged: true, stampLang: 'german', stampStyle: 'banner', stampScale: 1.4,
    }),
  });
  await save.saveToGallery();
  assert.equal(calls[0].body.labelVirtuallyStaged, true);
  assert.equal(calls[0].body.stampLang, 'german');
  assert.equal(calls[0].body.stampStyle, 'banner');
  assert.equal(calls[0].body.stampScale, 1.4);
  // The disclosure describes the staged result, never the room photo it started from.
  assert.ok(calls[0].body.before, 'the before photo is still sent');
});

test('with no badge supplier the save is unlabelled, exactly as it always was', async () => {
  const { save, calls } = makeSave();
  await save.saveToGallery();
  assert.equal(calls[0].body.labelVirtuallyStaged, undefined);
  assert.equal(calls[0].body.stampStyle, undefined);
});

test('a refused disclosure breaks this module\'s silence, and only that one does', async () => {
  // Saving is a background nicety, so every other failure is swallowed on purpose. This one
  // is different: the user asked for the label, it is why nothing was stored, and unticking
  // the option is an action only they can take. Silence would leave them believing a
  // labelled copy is in their gallery.
  const { save, calls, state } = makeSave({
    fetchImpl: async () => ({
      ok: false,
      json: async () => ({ error: 'We couldn\'t add the label.', code: 'DISCLOSURE_STAMP_FAILED' }),
    }),
  });
  await save.saveToGallery();
  assert.deepEqual(calls, [{ labelFailed: 'We couldn\'t add the label.' }]);
  assert.equal(state.savedDigest, '', 'and the save stays retryable');
});

test('an ordinary save failure stays silent', async () => {
  // The pairing for the test above: without it, "reports the disclosure failure" would
  // also pass on a module that shouted about every 500.
  const { save, calls } = makeSave({
    fetchImpl: async () => ({ ok: false, json: async () => ({ error: 'sqlite is on fire' }) }),
  });
  await save.saveToGallery();
  assert.deepEqual(calls, [], 'nothing is surfaced to the user');
});

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

test('every save sends its "before" and never asks to replace an entry', async () => {
  // There is one outcome now: insert. The studio's input photo is always the right "before"
  // for the composite, and `renderId` — which used to ask for a replace when the photo had
  // been handed off from the gallery — must not come back without that hand-off returning
  // too. A stray one would overwrite an unrelated render.
  const { save, calls } = makeSave();
  await save.saveToGallery();
  assert.equal(calls[0].body.renderId, undefined, 'no replace is ever requested');
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
