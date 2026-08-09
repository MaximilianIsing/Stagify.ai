// Wiring tests for lib/staging/staging-generation.js. The retry loop and the Gemini
// client are faked (no real model calls), so these assert the pipeline PLUMBING that
// unit tests of the pure helpers can't: that both generators run their finished image
// through the delivery upscale (upscaleForDelivery) — i.e. the served result is the
// enlarged WebP, not the model's raw ~1 MP PNG.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createStagingGeneration } from '../../lib/staging/staging-generation.js';

const png = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 40, g: 90, b: 160 } } }).png().toBuffer();
const jpg = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 40, g: 90, b: 160 } } }).jpeg().toBuffer();
const meta = (buf) => sharp(buf).metadata();
const decode = (dataUrl) => Buffer.from(dataUrl.split(',')[1], 'base64');

// A fake Gemini client whose generateContent() always returns the given PNG bytes as an
// inlineData part — the shape processStaging / processImageGeneration read.
function fakeGenAI(pngBuffer) {
  return {
    getGenerativeModel: () => ({
      generateContent: async () => ({
        response: { candidates: [{ content: { parts: [{ inlineData: { data: pngBuffer.toString('base64') } }] } }] },
      }),
    }),
  };
}

// A stand-in for the quality-retry loop: run the generator once and return its output
// (we're testing the post-generation delivery step, not the review/retry logic).
const passthroughRetry = async (generateOnce, opts) => {
  const url = await generateOnce(1, null);
  if (opts && typeof opts.onImageProduced === 'function') opts.onImageProduced(1);
  return url;
};

function makeGeneration(modelPng, overrides = {}) {
  const rows = [];
  const api = createStagingGeneration({
    genAI: fakeGenAI(modelPng),
    DEBUG_MODE: false,
    runQualityRetry: passthroughRetry,
    reviewImageQuality: async () => ({ isPerfect: true }),
    QUALITY_MAX_ATTEMPTS: 1,
    logPromptToFile: (...args) => { rows.push(args); },
    ...overrides,
  });
  return { ...api, rows };
}

// The args logPromptToFile is called with, as names.
function loggedRow(rows) {
  assert.equal(rows.length, 1, 'exactly one CSV row per render');
  const [promptText, roomType, , , , , , email, , outcome] = rows[0];
  return { promptText, roomType, email, outcome };
}

test('processStaging: delivers the model output upscaled ×2 as WebP', async () => {
  const modelPng = await png(800, 600);            // stand-in for Gemini's ~1 MP output
  const { processStaging } = makeGeneration(modelPng);
  const roomInput = await jpg(800, 600);           // same AR → the aspect-ratio lock is a no-op
  const out = await processStaging(
    roomInput,
    { roomType: 'Living room', furnitureStyle: 'standard', additionalPrompt: '', removeFurniture: false },
    { body: {} },
    null,
    'gemini-2.5-flash-image',
  );
  assert.match(out, /^data:image\/webp;base64,/, 'staged result is delivered as WebP, not the raw PNG');
  const m = await meta(decode(out));
  assert.equal(m.format, 'webp');
  assert.equal(m.width, 1600, 'width doubled for delivery');
  assert.equal(m.height, 1200, 'height doubled for delivery');
});

test('processImageGeneration: delivers the model output upscaled ×2 as WebP', async () => {
  const modelPng = await png(800, 600);
  const { processImageGeneration } = makeGeneration(modelPng);
  const out = await processImageGeneration('a cozy reading nook', { body: {} }, 'gemini-2.5-flash-image');
  assert.match(out, /^data:image\/webp;base64,/, 'generated image is delivered as WebP, not the raw PNG');
  const m = await meta(decode(out));
  assert.equal(m.format, 'webp');
  assert.equal(m.width, 1600);
  assert.equal(m.height, 1200);
});

test('processStaging: pins imageConfig.aspectRatio to the input\'s nearest supported ratio', async () => {
  // The wiring guarantee behind the anti-drift fix: a non-standard-AR room (1.607) must be
  // pinned to the nearest ratio the model supports (3:2), so iterative re-staging lands in a
  // stable bucket instead of accumulating a stretch. Guards against the pin being dropped.
  const modelPng = await png(1248, 832); // stand-in for the model's honored 3:2 bucket
  let capturedOptions = null;
  const genAI = {
    getGenerativeModel: (opts) => {
      capturedOptions = opts;
      return {
        generateContent: async () => ({
          response: { candidates: [{ content: { parts: [{ inlineData: { data: modelPng.toString('base64') } }] } }] },
        }),
      };
    },
  };
  const { processStaging } = createStagingGeneration({
    genAI, DEBUG_MODE: false, runQualityRetry: passthroughRetry,
    reviewImageQuality: async () => ({ isPerfect: true }), QUALITY_MAX_ATTEMPTS: 1, logPromptToFile: () => {},
  });
  const roomInput = await jpg(900, 560); // AR 1.607 → nearest supported ratio is 3:2
  await processStaging(
    roomInput,
    { roomType: 'Bedroom', furnitureStyle: 'standard', additionalPrompt: '', removeFurniture: false },
    { body: {} }, null, 'gemini-2.5-flash-image',
  );
  assert.equal(
    capturedOptions?.generationConfig?.imageConfig?.aspectRatio, '3:2',
    'staging pins the nearest supported aspect ratio on the model',
  );
});


// ── Outcome logging ─────────────────────────────────────────────────────────
//
// The prompt row used to be written BEFORE the model call, so it recorded an
// attempt and carried no result — the admin dashboard could show volume but not
// whether staging actually worked. These lock in the move: exactly one row per
// render, written from whichever path the request leaves by, carrying the outcome.

test('processStaging: logs exactly one row, after success, with the outcome attached', async () => {
  const modelPng = await png(800, 600);
  const gen = makeGeneration(modelPng);
  await gen.processStaging(
    await jpg(800, 600),
    { roomType: 'Living room', furnitureStyle: 'standard', additionalPrompt: '', removeFurniture: false },
    { body: { authenticatedEmail: 'u@x.com' } },
    null,
    'gemini-3-pro-image',
  );

  const { promptText, roomType, email, outcome } = loggedRow(gen.rows);
  assert.equal(roomType, 'Living room');
  assert.equal(email, 'u@x.com');
  assert.ok(promptText.length > 0, 'the prompt the model saw is still captured');
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.model, 'gemini-3-pro-image', 'the RESOLVED model, not the default');
  assert.equal(outcome.errorCode, '');
  assert.equal(outcome.attempts, 1, 'the metered attempt count rides along');
  assert.ok(Number.isFinite(outcome.durationMs) && outcome.durationMs >= 0);
});

test('processStaging: attempts counts THIS render, not the request-wide running total', async () => {
  // A multi-variation request shares one `req`, and every variation bumps
  // req._stagingGenerations (that total is what enterprise billing meters). The row
  // used to read that shared counter, so variation 3 reported the cost of all three —
  // and once variations run concurrently, which total a row happened to observe was
  // timing-dependent. A row must describe its own render.
  const gen = makeGeneration(await png(80, 60));
  const req = { body: {}, _stagingGenerations: 7 }; // two siblings already finished
  await gen.processStaging(
    await jpg(80, 60),
    { roomType: 'Bedroom', furnitureStyle: 'standard', additionalPrompt: '', removeFurniture: false },
    req,
  );

  const { outcome } = loggedRow(gen.rows);
  assert.equal(outcome.attempts, 1, 'its own generations, not 7 + 1');
  assert.equal(req._stagingGenerations, 8, 'the request-wide billing counter still accumulates');
});

test('processStaging: an unreviewed acceptance is recorded on the request as _qaDegraded', async () => {
  // The reviewer fails open so a QA outage never becomes a user outage — but the render
  // must not then be indistinguishable from a clean one.
  const degradingRetry = async (generateOnce, opts) => {
    const url = await generateOnce(1, null);
    if (opts && typeof opts.onImageProduced === 'function') opts.onImageProduced(1);
    if (opts && typeof opts.onReviewDegraded === 'function') {
      opts.onReviewDegraded(1, { perfect: true, score: 100, reason: 'reviewer error', degraded: true });
    }
    return url;
  };
  const gen = makeGeneration(await png(80, 60), { runQualityRetry: degradingRetry });
  const req = { body: {} };
  await gen.processStaging(
    await jpg(80, 60),
    { roomType: 'Kitchen', furnitureStyle: 'standard', additionalPrompt: '', removeFurniture: false },
    req,
  );
  assert.equal(req._qaDegraded, true);
});

test('processStaging: a normally reviewed render leaves _qaDegraded unset', async () => {
  const gen = makeGeneration(await png(80, 60));
  const req = { body: {} };
  await gen.processStaging(
    await jpg(80, 60),
    { roomType: 'Kitchen', furnitureStyle: 'standard', additionalPrompt: '', removeFurniture: false },
    req,
  );
  assert.ok(!req._qaDegraded, 'a reviewed render must not be flagged as unreviewed');
});

test('processStaging: a failed render still logs one row, marked failed with its code', async () => {
  const modelPng = await png(800, 600);
  const boom = Object.assign(new Error('no image'), { code: 'NO_IMAGE_GENERATED' });
  const gen = makeGeneration(modelPng, { runQualityRetry: async () => { throw boom; } });

  const roomInput = await jpg(800, 600);
  await assert.rejects(() => gen.processStaging(
    roomInput,
    { roomType: 'Kitchen', furnitureStyle: 'standard', additionalPrompt: '', removeFurniture: false },
    { body: {} },
    null,
    'gemini-2.5-flash-image',
  ), /no image/, 'the error still propagates to the caller');

  const { roomType, outcome } = loggedRow(gen.rows);
  assert.equal(roomType, 'Kitchen', 'a failure is still attributed to its room type');
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.errorCode, 'NO_IMAGE_GENERATED');
  assert.equal(outcome.attempts, 0, 'no image was produced');
});

test('processStaging: a failure BEFORE the prompt exists is still counted, with an empty prompt', async () => {
  // No Gemini client → throws at the top, long before the prompt is assembled.
  // That class of failure used to log nothing at all, making it invisible to the
  // error rate; it must now produce a row.
  const gen = makeGeneration(await png(8, 8), { genAI: null });
  const roomInput = await jpg(80, 60);
  await assert.rejects(() => gen.processStaging(
    roomInput,
    { roomType: 'Bedroom', furnitureStyle: 'standard', additionalPrompt: '', removeFurniture: false },
    { body: {} },
  ));

  const { promptText, roomType, outcome } = loggedRow(gen.rows);
  assert.equal(promptText, '');
  assert.equal(roomType, 'Bedroom');
  assert.equal(outcome.status, 'failed');
});

// --- the promptOverride / reviewBasePrompt seams ----------------------------
//
// Two optional StagingParams fields that let a caller whose request is not a
// room-type + furniture-style combination reuse this whole pipeline. The Exterior
// Studio is the first; the failure mode if either regresses is silent and expensive.

test('processStaging: promptOverride REPLACES the generated prompt, it does not prepend to it', async () => {
  // If the override were ever ignored, processStaging would fall back to
  // generatePrompt('Exterior', …) — a room type with no promptMatrix entry, so the
  // generic "Stage this Exterior professionally" fallback. That renders FURNITURE onto a
  // driveway and returns a perfectly plausible-looking image, which is exactly the
  // outcome the shared exteriors predicate exists to prevent.
  const sent = [];
  const gen = makeGeneration(await png(8, 8), {
    genAI: {
      getGenerativeModel: () => ({
        generateContent: async (parts) => {
          sent.push(parts[0].text);
          return { response: { candidates: [{ content: { parts: [{ inlineData: { data: (await png(8, 8)).toString('base64') } }] } }] } };
        },
      }),
    },
  });
  await gen.processStaging(
    await jpg(80, 60),
    { roomType: 'Exterior', promptOverride: 'ENHANCE-THIS-FACADE', additionalPrompt: 'summary text' },
    { body: {} },
  );
  assert.equal(sent[0], 'ENHANCE-THIS-FACADE', 'the override is the whole prompt, verbatim');
  assert.ok(!sent[0].includes('Stage this'), 'generatePrompt never ran');
  // ...and the CSV still records what the model actually saw, not what it would have.
  assert.equal(loggedRow(gen.rows).promptText, 'ENHANCE-THIS-FACADE');
});

test('processStaging: no promptOverride leaves the interior path completely unchanged', async () => {
  // The no-op half. Every pre-existing caller passes nothing here.
  const sent = [];
  const gen = makeGeneration(await png(8, 8), {
    genAI: {
      getGenerativeModel: () => ({
        generateContent: async (parts) => {
          sent.push(parts[0].text);
          return { response: { candidates: [{ content: { parts: [{ inlineData: { data: (await png(8, 8)).toString('base64') } }] } }] } };
        },
      }),
    },
  });
  await gen.processStaging(
    await jpg(80, 60),
    { roomType: 'Bedroom', furnitureStyle: 'standard', additionalPrompt: '', removeFurniture: false },
    { body: {} },
  );
  assert.match(sent[0], /KEEP EXISTING FURNITURE/, 'the assembled interior prompt still ships');
});

test('processStaging: skipQualityReview generates ONCE and never calls the reviewer', async () => {
  // The gate costs a vision pass per attempt and re-rolls up to QUALITY_MAX_ATTEMPTS
  // chasing a better score. Worth it when the model is inventing a room; pure waste when
  // it is relighting a photo it was handed. The regression to catch is a silent one: if
  // the flag stopped being honoured, renders would still succeed — just three times
  // slower and three times dearer, with nothing failing.
  let reviews = 0;
  let generations = 0;
  const gen = makeGeneration(null, {
    genAI: {
      getGenerativeModel: () => ({
        generateContent: async () => {
          generations += 1;
          return { response: { candidates: [{ content: { parts: [{ inlineData: { data: 'iVBORw0KGgo=' } }] } }] } };
        },
      }),
    },
    // The REAL retry loop, not a passthrough — the point is what it does with a reviewer
    // that always passes.
    runQualityRetry: (await import('../../lib/staging/staging-pipeline.js')).generateWithQualityRetry,
    reviewImageQuality: async () => { reviews += 1; return { perfect: false, score: 10 }; },
    QUALITY_MAX_ATTEMPTS: 3,
  });

  await gen.processStaging(
    await jpg(80, 60),
    { roomType: 'Exterior', promptOverride: 'X', skipQualityReview: true },
    { body: {} },
  );
  assert.equal(reviews, 0, 'no vision pass was paid for');
  assert.equal(generations, 1, 'and the image was generated exactly once');
});

test('processStaging: without the flag, a not-perfect verdict still re-rolls', async () => {
  // The other half — proof the test above measures the flag and not a broken harness.
  let reviews = 0;
  let generations = 0;
  const gen = makeGeneration(null, {
    genAI: {
      getGenerativeModel: () => ({
        generateContent: async () => {
          generations += 1;
          return { response: { candidates: [{ content: { parts: [{ inlineData: { data: 'iVBORw0KGgo=' } }] } }] } };
        },
      }),
    },
    runQualityRetry: (await import('../../lib/staging/staging-pipeline.js')).generateWithQualityRetry,
    reviewImageQuality: async () => { reviews += 1; return { perfect: false, score: 10 }; },
    QUALITY_MAX_ATTEMPTS: 3,
  });

  await gen.processStaging(
    await jpg(80, 60),
    { roomType: 'Bedroom', furnitureStyle: 'standard' },
    { body: {} },
  );
  assert.equal(generations, 3, 'the interior path still spends its full attempt budget');
  assert.equal(reviews, 3);
});

test('processStaging: a skipped review is NOT recorded as a degraded (broken-reviewer) run', async () => {
  // `_qaDegraded` means "shipped unreviewed because the reviewer broke" and drives the QA
  // dashboard. Switching the gate off deliberately must not land in the same bucket, or a
  // real reviewer outage disappears into a pile of exterior renders.
  const req = { body: {} };
  const gen = makeGeneration(null, {
    genAI: {
      getGenerativeModel: () => ({
        generateContent: async () => ({
          response: { candidates: [{ content: { parts: [{ inlineData: { data: 'iVBORw0KGgo=' } }] } }] },
        }),
      }),
    },
    runQualityRetry: (await import('../../lib/staging/staging-pipeline.js')).generateWithQualityRetry,
    reviewImageQuality: async () => ({ perfect: true, score: 100 }),
    QUALITY_MAX_ATTEMPTS: 3,
  });
  await gen.processStaging(await jpg(80, 60), { roomType: 'Exterior', promptOverride: 'X', skipQualityReview: true }, req);
  assert.equal(req._qaDegraded, undefined);
  // Metering still counts the generation that really happened.
  assert.equal(req._stagingGenerations, 1);
});

test('processStaging: reviewBasePrompt reaches the reviewer, and its absence keeps the default', async () => {
  const seen = [];
  const roomInput = await jpg(80, 60);
  const make = (params) => {
    const gen = makeGeneration(null, {
      genAI: {
        getGenerativeModel: () => ({
          generateContent: async () => ({
            response: { candidates: [{ content: { parts: [{ inlineData: { data: 'iVBORw0KGgo=' } }] } }] },
          }),
        }),
      },
      // Capture what the pipeline hands the reviewer rather than what the reviewer does
      // with it — the review logic has its own tests.
      runQualityRetry: async (generateOnce, opts) => {
        const url = await generateOnce(1, null);
        await opts.reviewFn(url);
        return url;
      },
      reviewImageQuality: async (_url, opts) => { seen.push(opts); return { perfect: true, score: 100 }; },
    });
    return gen.processStaging(roomInput, params, { body: {} });
  };

  await make({ roomType: 'Exterior', promptOverride: 'X', reviewBasePrompt: 'EXTERIOR-RUBRIC' });
  await make({ roomType: 'Bedroom', furnitureStyle: 'standard' });
  assert.equal(seen.length, 2, 'sanity: the reviewer ran for both renders');
  assert.equal(seen[0].basePrompt, 'EXTERIOR-RUBRIC');
  assert.equal(seen[1].basePrompt, null, 'unset means the reviewer keeps its own default');
});

// ── "Label as virtually staged" (lib/image/stamp-disclosure.js) ──────────────────────
//
// The disclosure is burned into the pixels at ONE call site, deliberately placed between
// the aspect-ratio crop and the onNative hook so that a single call covers both the
// delivered image and the gallery master. These tests exist to make that placement, and the
// fail-closed policy around it, expensive to break by accident.

const BR = { left: 600, top: 400, width: 600, height: 400 }; // bottom-right quadrant of 1200×800
const TL = { left: 0, top: 0, width: 600, height: 400 };     // top-left quadrant

/** Run one render and return the NATIVE (pre-upscale) buffer handed to the gallery hook. */
async function nativeBuffer(params) {
  const modelPng = await png(1200, 800);
  const { processStaging } = makeGeneration(modelPng);
  /** @type {Buffer | null} */
  let native = null;
  await processStaging(
    await jpg(1200, 800),
    { roomType: 'Living room', furnitureStyle: 'standard', additionalPrompt: '', onNative: (buf) => { native = buf; }, ...params },
    { body: {} },
    null,
    'gemini-2.5-flash-image',
  );
  assert.ok(native, 'sanity: the onNative hook fired');
  return native;
}

const quadrant = (buf, box) => sharp(buf).extract(box).raw().toBuffer();

test('labelVirtuallyStaged: the GALLERY MASTER is stamped, in the bottom-right only', async () => {
  // THE TRIPWIRE. Delete the stampVirtuallyStaged call in staging-generation.js and these
  // two renders become byte-identical, so this fails. It asserts against the onNative
  // buffer rather than the returned image on purpose: onNative is what the gallery stores
  // and what the user re-downloads months later, and stamping only the delivered copy
  // would leave that one unlabelled — the failure that actually reaches a buyer.
  const off = await nativeBuffer({ labelVirtuallyStaged: false });
  const on = await nativeBuffer({ labelVirtuallyStaged: true, stampLang: 'english' });

  assert.ok(
    Buffer.compare(await quadrant(on, TL), await quadrant(off, TL)) === 0,
    'top-left quadrant is untouched — the stamp is not painting over the room',
  );
  assert.ok(
    Buffer.compare(await quadrant(on, BR), await quadrant(off, BR)) !== 0,
    'bottom-right quadrant carries the disclosure (if this fails, the stamp call is gone)',
  );
});

test('labelVirtuallyStaged: off means byte-identical to a render that never knew about it', async () => {
  // Nobody who leaves the box unticked should get different pixels than before the feature
  // shipped. Guards an always-on stamp and a truthiness slip on the flag.
  const absent = await nativeBuffer({});
  const explicitlyOff = await nativeBuffer({ labelVirtuallyStaged: false });
  assert.ok(Buffer.compare(absent, explicitlyOff) === 0, 'unset and false produce identical bytes');
});

test('labelVirtuallyStaged: the language reaches the compositor', async () => {
  // If stampLang were dropped anywhere between the form body and the stamp module, every
  // locale would silently ship the English sentence and nothing would look broken.
  const en = await nativeBuffer({ labelVirtuallyStaged: true, stampLang: 'english' });
  const ja = await nativeBuffer({ labelVirtuallyStaged: true, stampLang: 'japanese' });
  assert.ok(Buffer.compare(en, ja) !== 0, 'a Japanese render differs from an English one');
});

test('labelVirtuallyStaged: the delivered image is still upscaled WebP', async () => {
  // The stamp returns PNG; the delivery step must still run after it. A regression here
  // would ship the un-upscaled PNG and quietly triple the payload.
  const modelPng = await png(800, 600);
  const { processStaging } = makeGeneration(modelPng);
  const out = await processStaging(
    await jpg(800, 600),
    { roomType: 'Living room', furnitureStyle: 'standard', additionalPrompt: '', labelVirtuallyStaged: true, stampLang: 'english' },
    { body: {} },
    null,
    'gemini-2.5-flash-image',
  );
  assert.match(out, /^data:image\/webp;base64,/, 'still delivered as WebP');
  const m = await meta(decode(out));
  assert.equal(m.width, 1600, 'still upscaled ×2 for delivery');
  assert.equal(m.height, 1200);
});

test('labelVirtuallyStaged: the QA reviewer grades the UNSTAMPED image', async () => {
  // The reviewer's rubric is about melted sofas, not about a caption it has never been told
  // to expect. Grading a stamped image invites it to score the badge as a defect and burn
  // paid retries chasing a "fix" that cannot happen.
  /** @type {string[]} */
  const reviewed = [];
  const modelPng = await png(1200, 800);
  const gen = createStagingGeneration({
    genAI: fakeGenAI(modelPng),
    DEBUG_MODE: false,
    runQualityRetry: async (generateOnce, opts) => {
      const url = await generateOnce(1, null);
      await opts.reviewFn(url);
      return url;
    },
    reviewImageQuality: async (url) => { reviewed.push(url); return { perfect: true, score: 100 }; },
    QUALITY_MAX_ATTEMPTS: 1,
    logPromptToFile: () => {},
  });
  let native = null;
  await gen.processStaging(
    await jpg(1200, 800),
    { roomType: 'Living room', furnitureStyle: 'standard', additionalPrompt: '', labelVirtuallyStaged: true, stampLang: 'english', onNative: (b) => { native = b; } },
    { body: {} },
    null,
    'gemini-2.5-flash-image',
  );
  assert.equal(reviewed.length, 1, 'sanity: the reviewer ran');
  const graded = decode(reviewed[0]);
  assert.ok(
    Buffer.compare(await quadrant(graded, BR), await quadrant(native, BR)) !== 0,
    'the reviewer saw a different bottom-right than the stamped native — i.e. it graded the clean render',
  );
});

test('labelVirtuallyStaged: the stamp call is NOT wrapped in its own try/catch', async () => {
  // The stamp fails CLOSED (see lib/image/stamp-disclosure.js): a failure must unwind and
  // fail the render, not deliver an unlabelled image the user believes is labelled. The
  // likeliest bad refactor is someone "hardening" this one call with a try/catch, which
  // silently converts a compliance feature into a liability. Comments are stripped first —
  // otherwise the comment at the call site, which says the words "try/catch", would satisfy
  // any naive scan and the guard would pass with the protection removed.
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'staging', 'staging-generation.js'),
    'utf8',
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const idx = code.indexOf('stampVirtuallyStaged(finalDataUrl');
  assert.ok(idx > 0, 'the stamp call is still at the expected call site in processStaging');
  // An unclosed `try {` in the run-up to the call means the call sits inside a fresh try
  // block. The enclosing whole-body try is far above and separated by closed braces.
  const runUp = code.slice(Math.max(0, idx - 400), idx);
  assert.ok(
    !/try\s*\{[^}]*$/.test(runUp),
    'stampVirtuallyStaged must not be wrapped in its own try/catch — it fails closed by design',
  );
});
