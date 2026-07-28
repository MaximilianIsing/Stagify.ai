// Unit tests for the shared refine maths (public/scripts/mask/refine.js) and the
// /api/mask-edit request (public/scripts/mask/generate.js).
//
// Both were duplicated verbatim across the two mask editors, magic ratios and
// all. The growth radii are worth pinning precisely: they decide how far beyond
// the user's brush the model is allowed to edit, so a drifted constant changes
// every mask edit subtly and silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMaskDom, installFileStack, drawCanvas } from '../../helpers/mask-dom.js';
import { maskGrowths, snapshotCanvas, renderRefinePreview } from '../../../public/scripts/mask/refine.js';

test('growth radii scale with the long edge', () => {
  // 2000px long edge: 2000 * 0.02275 = 45.5 -> 46; 2000 * 0.04 = 80.
  assert.deepEqual(maskGrowths(2000, 1000), { coreGrow: 46, featherPx: 80 });
  // Orientation must not matter — it is the LONG edge either way.
  assert.deepEqual(maskGrowths(1000, 2000), { coreGrow: 46, featherPx: 80 });
});

test('small images get the floor values, not a vanishing grow', () => {
  // 100 * 0.02275 = 2.3 and 100 * 0.04 = 4, both below the floors.
  assert.deepEqual(maskGrowths(100, 80), { coreGrow: 12, featherPx: 20 });
});

test('the floors hand over to the ratios at the documented sizes', () => {
  // coreGrow floor holds until maxDim * 0.02275 exceeds 12 (~528px).
  assert.equal(maskGrowths(500, 500).coreGrow, 12);
  assert.equal(maskGrowths(600, 600).coreGrow, 14);
  // featherPx floor holds until maxDim * 0.04 exceeds 20 (500px).
  assert.equal(maskGrowths(400, 400).featherPx, 20);
  assert.equal(maskGrowths(600, 600).featherPx, 24);
});

test('snapshotCanvas copies pixels into a detached canvas of the given size', (t) => {
  const dom = installMaskDom();
  t.after(() => dom.restore());
  const src = drawCanvas({ w: 40, h: 20 });
  const ctx = src.getContext('2d');
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 40, 20);

  const snap = snapshotCanvas(src, 40, 20);

  assert.equal(snap.width, 40);
  assert.equal(snap.height, 20);
  const [r, g, b] = snap.getContext('2d').getImageData(10, 10, 1, 1).data;
  assert.deepEqual([r, g, b], [255, 0, 0], 'the snapshot really holds the source pixels');
});

test('the refine preview composites the edit inside the strokes and ghosts the rest', (t) => {
  const dom = installMaskDom();
  t.after(() => dom.restore());

  const W = 80, H = 40;
  // Original: solid blue. Edited: solid red. Strokes: a blob on the left half.
  const origCanvas = drawCanvas({ w: W, h: H });
  const octx = origCanvas.getContext('2d');
  octx.fillStyle = '#0000ff';
  octx.fillRect(0, 0, W, H);

  const editedImg = drawCanvas({ w: W, h: H });
  const ectx = editedImg.getContext('2d');
  ectx.fillStyle = '#ff0000';
  ectx.fillRect(0, 0, W, H);

  const drawCv = drawCanvas({ w: W, h: H });
  const dctx = drawCv.getContext('2d');
  dctx.fillStyle = '#2563eb';
  dctx.fillRect(0, 0, 20, H); // strokes cover only the left edge

  const baseCanvas = drawCanvas({ w: W, h: H });

  renderRefinePreview({
    baseCanvas,
    drawCanvas: drawCv,
    state: { origCanvas, w: W, h: H, coreGrow: 2, featherPx: 2, editedImg },
  });

  // Inside the strokes the edit wins outright (then the ghost sits on top, but it
  // is the same red, so the pixel stays red).
  const [ir, ig, ib] = baseCanvas.getContext('2d').getImageData(5, H / 2, 1, 1).data;
  assert.ok(ir > 200 && ig < 60 && ib < 60, `inside the mask should read as the edit, got rgb(${ir},${ig},${ib})`);

  // Far outside, the original shows through the 55% ghost — so it is neither
  // pure blue (the ghost is visible) nor pure red (the edit was not committed there).
  const [or_, og, ob] = baseCanvas.getContext('2d').getImageData(W - 3, H / 2, 1, 1).data;
  assert.ok(ob > 60, `outside the mask should retain the original, got rgb(${or_},${og},${ob})`);
  assert.ok(or_ > 60, 'and should show the ghosted preview over it');
});

test('the refine preview is a no-op without state rather than a crash', (t) => {
  const dom = installMaskDom();
  t.after(() => dom.restore());
  assert.doesNotThrow(() => renderRefinePreview({ baseCanvas: null, drawCanvas: null, state: null }));
});

// Regression: the two editors named the snapshot differently (origCanvas vs
// originCanvas), so one of them passed undefined here and got only a generic
// "the provided value is not of type ..." from inside drawImage.
test('a refine state missing its snapshot names the field it is missing', (t) => {
  const dom = installMaskDom();
  t.after(() => dom.restore());
  const canvas = drawCanvas({ w: 10, h: 10 });

  assert.throws(
    () => renderRefinePreview({
      baseCanvas: canvas,
      drawCanvas: canvas,
      state: { originCanvas: canvas, w: 10, h: 10, coreGrow: 2, featherPx: 2, editedImg: canvas },
    }),
    /missing origCanvas/,
  );

  assert.throws(
    () => renderRefinePreview({
      baseCanvas: canvas,
      drawCanvas: canvas,
      state: { origCanvas: canvas, w: 10, h: 10, coreGrow: 2, featherPx: 2 },
    }),
    /missing editedImg/,
  );
});

// ---- generate.js ----------------------------------------------------------

async function importGenerate() {
  return import('../../../public/scripts/mask/generate.js');
}

function stubFetch(response) {
  const calls = [];
  globalThis.fetch = (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return Promise.resolve(response);
  };
  return calls;
}

const okResponse = (editedImage = 'data:image/png;base64,AAAA') => ({
  ok: true,
  json: () => Promise.resolve({ editedImage }),
});

test('the request carries the image, the grown mask, the prompt and the model', async (t) => {
  const dom = installMaskDom();
  installFileStack({ width: 10, height: 10 });
  const savedFetch = globalThis.fetch;
  t.after(() => { dom.restore(); globalThis.fetch = savedFetch; });
  globalThis.window.StagifyAuth = { getToken: () => 'tok-123' };

  const calls = stubFetch(okResponse());
  const { requestMaskEdit } = await importGenerate();

  await requestMaskEdit({
    image: 'data:image/png;base64,SOURCE',
    drawCanvas: drawCanvas({ w: 20, h: 10 }),
    w: 20, h: 10,
    prompt: 'repaint the wall',
    coreGrow: 4,
    model: 'gemini-x',
    referenceImage: null,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/mask-edit');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].body.image, 'data:image/png;base64,SOURCE');
  assert.equal(calls[0].body.prompt, 'repaint the wall');
  assert.equal(calls[0].body.model, 'gemini-x');
  assert.ok(String(calls[0].body.mask).startsWith('data:image/png'), 'a rendered mask is sent');
  assert.equal('referenceImage' in calls[0].body, false, 'omitted entirely when there is none');
});

test('the bearer token goes in the header and the body', async (t) => {
  const dom = installMaskDom();
  installFileStack({ width: 10, height: 10 });
  const savedFetch = globalThis.fetch;
  t.after(() => { dom.restore(); globalThis.fetch = savedFetch; });
  globalThis.window.StagifyAuth = { getToken: () => 'tok-abc' };

  const calls = stubFetch(okResponse());
  const { requestMaskEdit } = await importGenerate();
  await requestMaskEdit({
    image: 'x', drawCanvas: drawCanvas({ w: 10, h: 10 }), w: 10, h: 10,
    prompt: 'p', coreGrow: 2, model: 'm',
  });

  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-abc');
  assert.equal(calls[0].body.authToken, 'tok-abc');
});

test('a signed-out caller sends no Authorization header at all', async (t) => {
  const dom = installMaskDom();
  installFileStack({ width: 10, height: 10 });
  const savedFetch = globalThis.fetch;
  t.after(() => { dom.restore(); globalThis.fetch = savedFetch; });
  globalThis.window.StagifyAuth = { getToken: () => null };

  const calls = stubFetch(okResponse());
  const { requestMaskEdit } = await importGenerate();
  await requestMaskEdit({
    image: 'x', drawCanvas: drawCanvas({ w: 10, h: 10 }), w: 10, h: 10,
    prompt: 'p', coreGrow: 2, model: 'm',
  });

  assert.equal('Authorization' in calls[0].init.headers, false);
  assert.equal(calls[0].body.authToken, undefined);
});

test('a reference photo is forwarded when one is attached', async (t) => {
  const dom = installMaskDom();
  installFileStack({ width: 10, height: 10 });
  const savedFetch = globalThis.fetch;
  t.after(() => { dom.restore(); globalThis.fetch = savedFetch; });
  globalThis.window.StagifyAuth = null;

  const calls = stubFetch(okResponse());
  const { requestMaskEdit } = await importGenerate();
  await requestMaskEdit({
    image: 'x', drawCanvas: drawCanvas({ w: 10, h: 10 }), w: 10, h: 10,
    prompt: 'p', coreGrow: 2, model: 'm', referenceImage: 'data:image/png;base64,REF',
  });

  assert.equal(calls[0].body.referenceImage, 'data:image/png;base64,REF');
});

for (const [label, response, expected] of [
  ['a non-ok response', { ok: false, json: () => Promise.resolve({ error: 'Rate limited' }) }, /Rate limited/],
  ['an ok response with no image', { ok: true, json: () => Promise.resolve({}) }, /Failed to process masked edit/],
]) {
  test(`${label} throws rather than resolving to nothing`, async (t) => {
    const dom = installMaskDom();
    installFileStack({ width: 10, height: 10 });
    const savedFetch = globalThis.fetch;
    t.after(() => { dom.restore(); globalThis.fetch = savedFetch; });
    globalThis.window.StagifyAuth = null;

    stubFetch(response);
    const { requestMaskEdit } = await importGenerate();

    await assert.rejects(
      () => requestMaskEdit({
        image: 'x', drawCanvas: drawCanvas({ w: 10, h: 10 }), w: 10, h: 10,
        prompt: 'p', coreGrow: 2, model: 'm',
      }),
      expected,
    );
  });
}
