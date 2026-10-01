// The new-image dispatch slice of the AI Designer (lib/chat/chat-image-dispatch.js), driven
// directly through its factory with every collaborator faked — no Gemini, no OpenAI, no
// network. What is pinned, and why each one costs money when it regresses:
//
//   - runGenerateRequests: the slice(0,3)-then-filter normalization, per-image failures
//     that must not sink the whole turn, and the apology that appears only when EVERY
//     requested generation produced nothing.
//   - runCadRequests: blueprint + furniture resolution from history (including the
//     bound-check that keeps the blueprint from being fed back as its own furniture), the
//     stamp params handed to blueprintTo3D (eye-level always disclosed), the render's own
//     MIME label, the per-view CAD annotation flag, and the three distinct apologies.
//   - Side effects: a blueprint render (a gemini-3-pro-image call) is counted exactly once
//     per success, and lands in the gallery as one recordPending per result under a shared
//     batch id, tagged with IMAGE_MODEL_CAD from lib/config/model-config.js. A broken
//     gallery must never turn a paid turn into a failure.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import createImageDispatch from '../../lib/chat/chat-image-dispatch.js';
import { IMAGE_MODEL_CAD } from '../../lib/config/model-config.js';
import { STAMP_STYLE_NAMES, DEFAULT_STAMP_STYLE } from '../../lib/image/stamp-disclosure.js';
import { RENDER_ID_PATTERN } from '../../lib/data/object-keys.js';
import { logger } from '../../lib/logger.js';

// A real PNG so detectImageMimeType (sharp) has genuine bytes to sniff.
const RENDER_PNG = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#abcdef' } }).png().toBuffer();

const dataUrl = (s, mime = 'image/png') => `data:${mime};base64,` + Buffer.from(s).toString('base64');
const userImg = (url, filename) => ({ role: 'user', content: [{ type: 'image_url', image_url: { url }, filename }] });
const PRO = { id: 'u_pro', email: 'pro@x.com', plan: 'pro' };
const OTHER_STYLE = STAMP_STYLE_NAMES.find((s) => s !== DEFAULT_STAMP_STYLE);

// Index space is most-recent-first: the LAST message is index 0.
const PLAN_ONLY = [userImg(dataUrl('PLAN', 'image/jpeg'), 'plan.jpg')];
const SOFA_THEN_PLAN = [userImg(dataUrl('SOFA', 'image/webp'), 'sofa.webp'), userImg(dataUrl('PLAN'), 'plan.png')];

let errors;
let debugs;
const origError = logger.error;
const origDebug = logger.debug;
beforeEach(() => {
  errors = [];
  debugs = [];
  logger.error = (...args) => { errors.push(args); };
  logger.debug = (...args) => { debugs.push(args); };
});
afterEach(() => {
  logger.error = origError;
  logger.debug = origDebug;
});

/** A render-persistence double that records every call. */
function fakePersistence(seen, { enabled = true, recordThrows = false, recordReturnsNull = false } = {}) {
  return {
    enabled: () => enabled,
    recordPending: (arg) => {
      if (recordThrows) throw new Error('sqlite is on fire');
      seen.recorded.push(arg);
      if (recordReturnsNull) return null;
      return { entries: [{ id: `r${seen.recorded.length}` }], evicted: [] };
    },
    startUpload: (arg) => { seen.uploaded.push(arg); },
  };
}

function makeDispatch(over = {}, persistOpts = {}) {
  const calls = { model: [], generate: [], annotate: [], cad: [], count: 0 };
  const seen = { recorded: [], uploaded: [] };
  const deps = {
    DEBUG_MODE: false,
    annotateImage: async (url, isCad) => { calls.annotate.push({ url, isCad, argc: isCad === undefined ? 1 : 2 }); return 'annotated'; },
    getGeminiImageModel: (m) => { calls.model.push(m); return `gemini-for-${m}`; },
    processImageGeneration: async (prompt, req, model) => { calls.generate.push({ prompt, req, model }); return `data:image/png;base64,${prompt}`; },
    blueprintTo3D: async (buf, opts) => {
      calls.cad.push({ buf, opts });
      opts.onNative?.(Buffer.from(`native:${buf.toString()}`));
      return RENDER_PNG;
    },
    incPromptCount: () => { calls.count += 1; },
    renderPersistence: fakePersistence(seen, persistOpts),
    ...over,
  };
  return { d: createImageDispatch(deps), calls, seen };
}

const cadArgs = (over = {}) => ({
  history: PLAN_ONLY, baseImageIndex: null, currentMessageHasImage: false, req: { body: {} }, user: PRO, ...over,
});

// ---------------------------------------------------------------- runGenerateRequests

test('generate: a null / absent decision does nothing and apologises for nothing', async () => {
  const { d, calls } = makeDispatch();
  for (const generateRequestFromAI of [null, undefined]) {
    const out = await d.runGenerateRequests({ generateRequestFromAI, req: {}, selectedModel: 'm' });
    assert.deepEqual(out.generatedImages, []);
    assert.equal(out.textSuffix, '');
  }
  assert.equal(calls.generate.length, 0);
});

test('generate: a request that is not generatable (flag off or empty prompt) is dropped without an apology', async () => {
  const { d, calls } = makeDispatch();
  for (const r of [{ shouldGenerate: false, prompt: 'x' }, { shouldGenerate: true, prompt: '' }, { shouldGenerate: true }]) {
    const out = await d.runGenerateRequests({ generateRequestFromAI: r, req: {}, selectedModel: 'm' });
    assert.equal(out.generatedImages.length, 0);
    assert.equal(out.textSuffix, '');
  }
  assert.equal(calls.generate.length, 0);
});

test('generate: a single request resolves the Gemini model from selectedModel and returns the image with its annotation', async () => {
  const { d, calls } = makeDispatch();
  const req = { body: { tag: 'turn' } };
  const out = await d.runGenerateRequests({ generateRequestFromAI: { shouldGenerate: true, prompt: 'loft' }, req, selectedModel: 'pro' });
  assert.deepEqual(calls.model, ['pro']);
  assert.equal(calls.generate.length, 1);
  assert.equal(calls.generate[0].prompt, 'loft');
  assert.equal(calls.generate[0].req, req);
  assert.equal(calls.generate[0].model, 'gemini-for-pro');
  assert.equal(out.generatedImages.length, 1);
  assert.equal(out.generatedImages[0].image, 'data:image/png;base64,loft');
  assert.equal(await out.generatedImages[0].annotationPromise, 'annotated');
  // Generated images are never CAD: annotateImage gets no isCad flag.
  assert.equal(calls.annotate[0].argc, 1);
  assert.equal(out.textSuffix, '');
});

test('generate: an array is capped to the first 3 BEFORE filtering, so a valid 4th entry is dropped', async () => {
  const { d, calls } = makeDispatch();
  const out = await d.runGenerateRequests({
    generateRequestFromAI: [
      { shouldGenerate: true, prompt: 'a' },
      { shouldGenerate: false, prompt: 'b' },
      { shouldGenerate: true, prompt: 'c' },
      { shouldGenerate: true, prompt: 'd' },
    ],
    req: {}, selectedModel: 'm',
  });
  assert.deepEqual(calls.generate.map((c) => c.prompt), ['a', 'c']);
  assert.equal(out.generatedImages.length, 2);
});

test('generate: one throwing and one empty generation do not sink the turn when another succeeds', async () => {
  const { d } = makeDispatch({
    processImageGeneration: async (prompt) => {
      if (prompt === 'boom') throw new Error('gemini 500');
      if (prompt === 'empty') return null;
      return `data:image/png;base64,${prompt}`;
    },
  });
  const out = await d.runGenerateRequests({
    generateRequestFromAI: [{ shouldGenerate: true, prompt: 'boom' }, { shouldGenerate: true, prompt: 'empty' }, { shouldGenerate: true, prompt: 'ok' }],
    req: {}, selectedModel: 'm',
  });
  assert.deepEqual(out.generatedImages.map((g) => g.image), ['data:image/png;base64,ok']);
  assert.equal(out.textSuffix, '');
  assert.equal(errors.length, 1);
});

test('generate: when every generation fails (throw or no image) the apology is appended', async () => {
  for (const processImageGeneration of [async () => { throw new Error('quota'); }, async () => null]) {
    const { d } = makeDispatch({ processImageGeneration });
    const out = await d.runGenerateRequests({
      generateRequestFromAI: [{ shouldGenerate: true, prompt: 'a' }, { shouldGenerate: true, prompt: 'b' }],
      req: {}, selectedModel: 'm',
    });
    assert.equal(out.generatedImages.length, 0);
    assert.match(out.textSuffix, /Sorry, I encountered an error while generating the images/);
  }
});

test('generate: a throwing model resolver is caught per image and ends in the apology', async () => {
  const { d, calls } = makeDispatch({ getGeminiImageModel: () => { throw new Error('unknown model'); } });
  const out = await d.runGenerateRequests({ generateRequestFromAI: { shouldGenerate: true, prompt: 'a' }, req: {}, selectedModel: 'nope' });
  assert.equal(calls.generate.length, 0);
  assert.match(out.textSuffix, /generating the images/);
});

test('generate: a failed annotation resolves to null instead of rejecting', async () => {
  const { d } = makeDispatch({ annotateImage: async () => { throw new Error('vision down'); } });
  const out = await d.runGenerateRequests({ generateRequestFromAI: { shouldGenerate: true, prompt: 'a' }, req: {}, selectedModel: 'm' });
  assert.equal(await out.generatedImages[0].annotationPromise, null);
  assert.ok(errors.some((e) => String(e[0]).includes('Error annotating generated image 1')));
});

test('generate: neither counts a render nor writes to the gallery (that is processImageGeneration\'s job)', async () => {
  const { d, calls, seen } = makeDispatch();
  await d.runGenerateRequests({ generateRequestFromAI: { shouldGenerate: true, prompt: 'a' }, req: {}, selectedModel: 'm' });
  assert.equal(calls.count, 0);
  assert.equal(seen.recorded.length, 0);
});

// ---------------------------------------------------------------- runCadRequests: dispatch

test('cad: a null decision or shouldProcessCAD:false renders nothing, counts nothing, persists nothing', async () => {
  const { d, calls, seen } = makeDispatch();
  for (const cadRequestFromAI of [null, { shouldProcessCAD: false }, [{ shouldProcessCAD: false }]]) {
    const out = await d.runCadRequests({ cadRequestFromAI, ...cadArgs() });
    assert.deepEqual(out, { cadResults: [], textSuffix: '' });
  }
  assert.equal(calls.cad.length, 0);
  assert.equal(calls.count, 0);
  assert.equal(seen.recorded.length, 0);
});

test('cad: a top-down render gets the decoded blueprint, its MIME, and default (off) stamp params', async () => {
  const { d, calls } = makeDispatch();
  const request = { shouldProcessCAD: true };
  const out = await d.runCadRequests({ cadRequestFromAI: request, ...cadArgs() });
  assert.equal(calls.cad.length, 1);
  const { buf, opts } = calls.cad[0];
  assert.equal(buf.toString(), 'PLAN');
  assert.equal(opts.mimeType, 'image/jpeg');
  assert.deepEqual(opts.furnitureImages, []);
  assert.equal(opts.additionalPrompt, null);
  assert.equal(opts.view, 'top-down');
  assert.equal(opts.room, null);
  assert.deepEqual(opts.stamp, { enabled: false, lang: 'english', style: DEFAULT_STAMP_STYLE, scale: 1 });
  assert.equal(out.cadResults.length, 1);
  assert.equal(out.cadResults[0].params, request);
  assert.equal(out.textSuffix, '');
});

test('cad: the result is labelled with the RENDER\'s sniffed MIME, not the blueprint\'s', async () => {
  const { d } = makeDispatch();
  const out = await d.runCadRequests({ cadRequestFromAI: { shouldProcessCAD: true }, ...cadArgs() });
  // Blueprint was image/jpeg; the render bytes are PNG.
  assert.equal(out.cadResults[0].cadImage, `data:image/png;base64,${RENDER_PNG.toString('base64')}`);
});

test('cad: undetectable render bytes fall back to image/png rather than failing the render', async () => {
  const { d } = makeDispatch({ blueprintTo3D: async () => Buffer.from('not an image') });
  const out = await d.runCadRequests({ cadRequestFromAI: { shouldProcessCAD: true }, ...cadArgs() });
  assert.match(out.cadResults[0].cadImage, /^data:image\/png;base64,/);
});

test('cad: annotation CAD flag is per view (top-down true, eye-level false)', async () => {
  const { d, calls } = makeDispatch();
  const out = await d.runCadRequests({
    cadRequestFromAI: [{ shouldProcessCAD: true, view: 'top-down' }, { shouldProcessCAD: true, view: 'eye-level', room: 'Kitchen' }],
    ...cadArgs(),
  });
  assert.deepEqual(calls.annotate.map((a) => a.isCad), [true, false]);
  assert.equal(await out.cadResults[0].annotationPromise, 'annotated');
});

test('cad: eye-level is always stamped even when routing sent no disclosure; room and prompt pass through', async () => {
  const { d, calls } = makeDispatch();
  await d.runCadRequests({
    cadRequestFromAI: { shouldProcessCAD: true, view: 'eye-level', room: 'Living room', additionalPrompt: 'oak floors', disclosure: null },
    ...cadArgs({ req: { body: { stampLang: 'french' } } }),
  });
  const { opts } = calls.cad[0];
  assert.equal(opts.view, 'eye-level');
  assert.equal(opts.room, 'Living room');
  assert.equal(opts.additionalPrompt, 'oak floors');
  assert.deepEqual(opts.stamp, { enabled: true, lang: 'french', style: DEFAULT_STAMP_STYLE, scale: 1 });
});

test('cad: a non-null disclosure turns the stamp on for top-down; style/scale normalized, language from the request', async () => {
  const { d, calls } = makeDispatch();
  await d.runCadRequests({
    cadRequestFromAI: [
      { shouldProcessCAD: true, disclosure: { style: OTHER_STYLE.toUpperCase(), scale: 99 } },
      { shouldProcessCAD: true, disclosure: { style: 'neon', scale: 'x' } },
    ],
    ...cadArgs({ req: { body: { stampLang: 'klingon' } } }),
  });
  assert.deepEqual(calls.cad[0].opts.stamp, { enabled: true, lang: 'english', style: OTHER_STYLE, scale: 1.6 });
  assert.deepEqual(calls.cad[1].opts.stamp, { enabled: true, lang: 'english', style: DEFAULT_STAMP_STYLE, scale: 1 });
});

test('cad: an unknown view (and a missing req) degrade to top-down with english', async () => {
  const { d, calls } = makeDispatch();
  await d.runCadRequests({ cadRequestFromAI: { shouldProcessCAD: true, view: 'isometric' }, ...cadArgs({ req: undefined }) });
  assert.equal(calls.cad[0].opts.view, 'top-down');
  assert.deepEqual(calls.cad[0].opts.stamp, { enabled: false, lang: 'english', style: DEFAULT_STAMP_STYLE, scale: 1 });
});

test('cad: the thumbnail selection overrides the AI index, unless the current message carries an image', async () => {
  const req = { shouldProcessCAD: true, imageIndex: 0 };
  const a = makeDispatch();
  await a.d.runCadRequests({ cadRequestFromAI: req, ...cadArgs({ history: SOFA_THEN_PLAN, baseImageIndex: 1 }) });
  assert.equal(a.calls.cad[0].buf.toString(), 'SOFA');
  const b = makeDispatch();
  await b.d.runCadRequests({ cadRequestFromAI: req, ...cadArgs({ history: SOFA_THEN_PLAN, baseImageIndex: 1, currentMessageHasImage: true }) });
  assert.equal(b.calls.cad[0].buf.toString(), 'PLAN');
});

test('cad: an array is capped to 3 before filtering', async () => {
  const { d, calls } = makeDispatch();
  const out = await d.runCadRequests({
    cadRequestFromAI: [{ shouldProcessCAD: true }, { shouldProcessCAD: false }, { shouldProcessCAD: true }, { shouldProcessCAD: true }],
    ...cadArgs(),
  });
  assert.equal(calls.cad.length, 2);
  assert.equal(out.cadResults.length, 2);
  assert.equal(calls.count, 2);
});

// ---------------------------------------------------------------- runCadRequests: furniture

test('cad: furniture references (single or array) are decoded with their own MIME', async () => {
  for (const furnitureImageIndex of [1, [1]]) {
    const { d, calls } = makeDispatch();
    const out = await d.runCadRequests({
      cadRequestFromAI: { shouldProcessCAD: true, imageIndex: 0, furnitureImageIndex },
      ...cadArgs({ history: SOFA_THEN_PLAN }),
    });
    assert.equal(calls.cad[0].buf.toString(), 'PLAN');
    const f = calls.cad[0].opts.furnitureImages;
    assert.equal(f.length, 1);
    assert.equal(f[0].image.toString(), 'SOFA');
    assert.equal(f[0].mimeType, 'image/webp');
    assert.equal(out.textSuffix, '');
  }
});

test('cad: out-of-range, negative, non-integer and blueprint-self furniture indices are skipped and reported', async () => {
  const one = makeDispatch();
  const outOne = await one.d.runCadRequests({
    cadRequestFromAI: { shouldProcessCAD: true, imageIndex: 0, furnitureImageIndex: 7 },
    ...cadArgs({ history: SOFA_THEN_PLAN }),
  });
  assert.deepEqual(one.calls.cad[0].opts.furnitureImages, []);
  assert.match(outOne.textSuffix, /couldn't find one of the furniture photos/);
  assert.equal(outOne.cadResults.length, 1, 'the render still ships');

  const many = makeDispatch();
  const outMany = await many.d.runCadRequests({
    cadRequestFromAI: { shouldProcessCAD: true, imageIndex: 0, furnitureImageIndex: [0, -1, 1.5, 9, null, 1] },
    ...cadArgs({ history: SOFA_THEN_PLAN }),
  });
  // 0 is the blueprint itself; null entries are ignored, not counted.
  assert.deepEqual(many.calls.cad[0].opts.furnitureImages.map((f) => f.image.toString()), ['SOFA']);
  assert.match(outMany.textSuffix, /couldn't find 4 of the furniture photos/);
});

test('cad: a furniture miss is reported per request, not merged across the turn', async () => {
  const { d } = makeDispatch();
  const out = await d.runCadRequests({
    cadRequestFromAI: [
      { shouldProcessCAD: true, imageIndex: 0, furnitureImageIndex: 5 },
      { shouldProcessCAD: true, imageIndex: 0, furnitureImageIndex: [5, 6] },
    ],
    ...cadArgs({ history: SOFA_THEN_PLAN }),
  });
  assert.match(out.textSuffix, /couldn't find one of the furniture photos/);
  assert.match(out.textSuffix, /couldn't find 2 of the furniture photos/);
});

// An out-of-range blueprint index falls back to image 0 in getImageFromHistory, so an
// index-based "never the blueprint" guard let furniture index 0 hand the floor plan back
// to the renderer as its own furniture reference. The guard compares resolved images.
test('cad: an out-of-range blueprint index cannot make furniture 0 alias the blueprint', async () => {
  const { d, calls } = makeDispatch();
  const out = await d.runCadRequests({
    cadRequestFromAI: { shouldProcessCAD: true, imageIndex: 5, furnitureImageIndex: 0 },
    ...cadArgs({ history: SOFA_THEN_PLAN }),
  });
  assert.equal(calls.cad[0].buf.toString(), 'PLAN', 'index 5 fell back to image 0');
  assert.deepEqual(calls.cad[0].opts.furnitureImages, [], 'the blueprint is never its own reference');
  assert.match(out.textSuffix, /couldn't find/);
});

// ---------------------------------------------------------------- runCadRequests: failures

test('cad: no blueprint in history -> the "couldn\'t find the floor plan" note, no render, no count', async () => {
  const { d, calls } = makeDispatch();
  const out = await d.runCadRequests({ cadRequestFromAI: { shouldProcessCAD: true }, ...cadArgs({ history: [] }) });
  assert.equal(calls.cad.length, 0);
  assert.equal(calls.count, 0);
  assert.match(out.textSuffix, /couldn't find the floor plan I was meant to render/);
});

test('cad: a blueprint URL with no base64 payload -> the "looks corrupted" note', async () => {
  const { d, calls } = makeDispatch();
  for (const url of ['data:image/png;base64,', 'https://cdn.example/plan.png']) {
    const out = await d.runCadRequests({ cadRequestFromAI: { shouldProcessCAD: true }, ...cadArgs({ history: [userImg(url, 'p.png')] }) });
    assert.match(out.textSuffix, /the file looks corrupted/);
  }
  assert.equal(calls.cad.length, 0);
});

test('cad: a lone render that throws gets the generic apology and is neither counted nor persisted', async () => {
  const { d, calls, seen } = makeDispatch({ blueprintTo3D: async () => { throw new Error('gemini 503'); } });
  const out = await d.runCadRequests({ cadRequestFromAI: { shouldProcessCAD: true }, ...cadArgs() });
  assert.equal(out.cadResults.length, 0);
  assert.match(out.textSuffix, /error while processing the CAD blueprint\. Please try again/);
  assert.equal(calls.count, 0);
  assert.equal(seen.recorded.length, 0);
});

test('cad: a withheld render (DISCLOSURE_STAMP_FAILED) gets the no-label note, not "try again"', async () => {
  const err = Object.assign(new Error('stamp failed'), { code: 'DISCLOSURE_STAMP_FAILED' });
  const { d } = makeDispatch({ blueprintTo3D: async () => { throw err; } });
  const out = await d.runCadRequests({ cadRequestFromAI: { shouldProcessCAD: true, view: 'eye-level' }, ...cadArgs() });
  assert.match(out.textSuffix, /couldn't add the "Virtually staged" label/);
  assert.doesNotMatch(out.textSuffix, /try again/i);
});

test('cad: with several requests a failure is silent, and the siblings still render, count and persist', async () => {
  let n = 0;
  const { d, calls, seen } = makeDispatch({
    blueprintTo3D: async (buf, opts) => {
      n += 1;
      if (n === 1) throw new Error('first one dies');
      opts.onNative?.(Buffer.from('native'));
      return RENDER_PNG;
    },
  });
  const out = await d.runCadRequests({ cadRequestFromAI: [{ shouldProcessCAD: true }, { shouldProcessCAD: true }], ...cadArgs() });
  assert.equal(out.cadResults.length, 1);
  assert.equal(out.textSuffix, '');
  assert.equal(calls.count, 1);
  assert.equal(seen.recorded.length, 1);
});

test('cad: when every one of several requests throws, the user gets one apology', async () => {
  const { d } = makeDispatch({ blueprintTo3D: async () => { throw new Error('down'); } });
  const out = await d.runCadRequests({ cadRequestFromAI: [{ shouldProcessCAD: true }, { shouldProcessCAD: true }], ...cadArgs() });
  assert.equal(out.cadResults.length, 0);
  assert.equal(out.textSuffix.match(/Please try again/g)?.length, 1);
});

test('cad: a failed CAD annotation resolves to null instead of rejecting', async () => {
  const { d } = makeDispatch({ annotateImage: async () => { throw new Error('vision down'); } });
  const out = await d.runCadRequests({ cadRequestFromAI: { shouldProcessCAD: true }, ...cadArgs() });
  assert.equal(await out.cadResults[0].annotationPromise, null);
  assert.ok(errors.some((e) => String(e[0]).includes('Error annotating CAD render 1')));
});

// ---------------------------------------------------------------- counting + gallery

test('cad: each successful render is counted once; an absent counter / persistence degrades silently', async () => {
  const { d, calls } = makeDispatch();
  await d.runCadRequests({ cadRequestFromAI: [{ shouldProcessCAD: true }, { shouldProcessCAD: true }], ...cadArgs() });
  assert.equal(calls.count, 2);

  const bare = makeDispatch({ incPromptCount: undefined, renderPersistence: undefined });
  const out = await bare.d.runCadRequests({ cadRequestFromAI: { shouldProcessCAD: true }, ...cadArgs() });
  assert.equal(out.cadResults.length, 1);
  assert.equal(bare.calls.cad[0].opts.onNative, null);
});

test('gallery: one recordPending per result, shared batch id, tagged with IMAGE_MODEL_CAD', async () => {
  const { d, calls, seen } = makeDispatch();
  await d.runCadRequests({
    cadRequestFromAI: [
      { shouldProcessCAD: true, imageIndex: 1, view: 'top-down' },
      { shouldProcessCAD: true, imageIndex: 0, view: 'eye-level', room: 'Den' },
      { shouldProcessCAD: true, imageIndex: 0, view: 'eye-level' },
    ],
    ...cadArgs({ history: SOFA_THEN_PLAN }),
  });
  assert.equal(typeof calls.cad[0].opts.onNative, 'function');
  assert.equal(calls.model.length, 0, 'the CAD path never consults the chat model resolver');
  assert.equal(seen.recorded.length, 3);
  const [a, b, c] = seen.recorded;
  assert.match(a.batchId, RENDER_ID_PATTERN);
  assert.ok(seen.recorded.every((r) => r.batchId === a.batchId));
  assert.deepEqual(seen.recorded.map((r) => r.variationBase), [0, 1, 2]);
  assert.ok(seen.recorded.every((r) => r.model === IMAGE_MODEL_CAD && r.isPro === true && r.user === PRO));
  // The NATIVE bytes (via onNative), never the delivered upscale.
  assert.equal(a.natives[0].buffer.toString(), 'native:SOFA');
  assert.equal(b.natives[0].buffer.toString(), 'native:PLAN');
  assert.deepEqual(a.extra, { source: 'designer', sourceName: 'sofa.webp', qualifier: 'Floor plan' });
  assert.deepEqual(b.extra, { source: 'designer', sourceName: 'plan.png', qualifier: 'Den' });
  assert.equal(c.extra.qualifier, 'Interior view');
  assert.equal(b.params.room, 'Den');
  // Each upload carries ITS OWN plan behind the before/after slider.
  assert.deepEqual(seen.uploaded.map((u) => u.sourceBuffer.toString()), ['SOFA', 'PLAN', 'PLAN']);
  assert.ok(seen.uploaded.every((u) => u.user === PRO && u.refUploads.length === 0));
  assert.deepEqual(seen.uploaded[0].entries, [{ id: 'r1' }]);
});

test('gallery: a blueprint with no filename is recorded as "Floor plan"', async () => {
  const { d, seen } = makeDispatch();
  await d.runCadRequests({ cadRequestFromAI: { shouldProcessCAD: true }, ...cadArgs({ history: [userImg(dataUrl('P'))] }) });
  assert.equal(seen.recorded[0].extra.sourceName, 'Floor plan');
});

test('gallery: disabled persistence or no user -> no native capture and nothing recorded', async () => {
  const off = makeDispatch({}, { enabled: false });
  await off.d.runCadRequests({ cadRequestFromAI: { shouldProcessCAD: true }, ...cadArgs() });
  assert.equal(off.calls.cad[0].opts.onNative, null);
  assert.equal(off.seen.recorded.length, 0);

  const anon = makeDispatch();
  await anon.d.runCadRequests({ cadRequestFromAI: { shouldProcessCAD: true }, ...cadArgs({ user: null }) });
  assert.equal(anon.calls.cad[0].opts.onNative, null);
  assert.equal(anon.seen.recorded.length, 0);
  assert.equal(anon.calls.count, 1, 'counting does not depend on the gallery');
});

test('gallery: a render whose native bytes never arrived is not recorded', async () => {
  const { d, seen } = makeDispatch({ blueprintTo3D: async () => RENDER_PNG });
  const out = await d.runCadRequests({ cadRequestFromAI: { shouldProcessCAD: true }, ...cadArgs() });
  assert.equal(out.cadResults.length, 1);
  assert.equal(seen.recorded.length, 0);
});

test('gallery: recordPending throwing is logged and never fails the paid turn', async () => {
  const { d } = makeDispatch({}, { recordThrows: true });
  const out = await d.runCadRequests({ cadRequestFromAI: { shouldProcessCAD: true }, ...cadArgs() });
  assert.equal(out.cadResults.length, 1);
  assert.equal(out.textSuffix, '');
  assert.ok(errors.some((e) => String(e[0]).startsWith('[gallery]')));
});

test('gallery: a null pending result skips the upload', async () => {
  // A rejected upload is startUpload's concern: test/staging/render-persistence.test.js.
  const { d, seen } = makeDispatch({}, { recordReturnsNull: true });
  await d.runCadRequests({ cadRequestFromAI: { shouldProcessCAD: true }, ...cadArgs() });
  assert.equal(seen.recorded.length, 1);
  assert.equal(seen.uploaded.length, 0);
});

// ---------------------------------------------------------------- DEBUG_MODE

test('DEBUG_MODE: both paths log progress through logger.debug and still return the same results', async () => {
  const { d } = makeDispatch({ DEBUG_MODE: true });
  const gen = await d.runGenerateRequests({ generateRequestFromAI: { shouldGenerate: true, prompt: 'x'.repeat(150) }, req: {}, selectedModel: 'm' });
  const cad = await d.runCadRequests({
    cadRequestFromAI: { shouldProcessCAD: true, imageIndex: 0, furnitureImageIndex: [1, 9], additionalPrompt: 'warm light '.repeat(10) },
    ...cadArgs({ history: SOFA_THEN_PLAN }),
  });
  await gen.generatedImages[0].annotationPromise;
  await cad.cadResults[0].annotationPromise;
  assert.equal(gen.generatedImages.length, 1);
  assert.equal(cad.cadResults.length, 1);
  const lines = debugs.map((a) => String(a[0]));
  assert.ok(lines.some((l) => l.includes('[Image Generation] Processing 1 generation request')));
  assert.ok(lines.some((l) => l.includes('[CAD] Found furniture image at index 1')));
  assert.ok(lines.some((l) => l.includes('[CAD] Furniture image at index 9 not found')));
  assert.ok(lines.some((l) => l.includes('with 1 furniture image(s)')));
  assert.ok(lines.some((l) => l.includes('[Image Annotation] Annotation for CAD render 1: annotated')));
});
