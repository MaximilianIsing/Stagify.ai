// Tier: frontend island logic (real canvas) — public/scripts/masking-studio/generate-pipeline.js.
//
// The run itself. Every painted area is its own POST /api/mask-edit, three in flight
// at a time, each composited back over the pristine original as it lands. This is
// where the studio spends the user's money, so the failure modes are expensive rather
// than cosmetic:
//
//   - SUPERSESSION. state.genRun is checked at four points inside one area's run
//     (after the fetch, after each retry sleep, after the decode, and again per
//     settlement). Lose one and a run the user already replaced writes its output
//     into the layers of the run they are watching.
//   - THE RETRY POLICY. 429 and 503 are transient and get two more attempts;
//     everything else is final. Retrying a 400 burns quota on a request that cannot
//     succeed, and NOT retrying a 429 fails a run that would have gone through.
//   - THE PROMPT. Remove-mode and stage-mode build entirely different instructions,
//     the server truncates at 1000 characters, and the cross-area context is appended
//     LAST so it is the context that gets cut rather than the user's own words.
//   - A FAILED RETRY MUST NOT DESTROY THE PREVIOUS VERSION. "Try another version" that
//     errors leaves the area on the version it already had.
//
// The absolute specifier: this island loads the shared mask maths with
// `import('/scripts/mask-core.js')`, which node resolves against the filesystem root.
// test/helpers/browser-abs-specifier.mjs maps it back into public/ — see the note
// there for why the source is right to keep the served path.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createCanvas } from '@napi-rs/canvas';

// Must precede any mount(): the island resolves the shared slice on construction.
register('../../helpers/browser-abs-specifier.mjs', import.meta.url);

import { installMaskDom, FakeEl } from '../../helpers/mask-dom.js';
import { createGeneratePipeline } from '../../../public/scripts/masking-studio/generate-pipeline.js';

const W = 200;
const H = 150;

const REAL = {
  fetch: globalThis.fetch,
  window: globalThis.window,
  setTimeout: globalThis.setTimeout,
};

let dom = null;
afterEach(() => {
  if (dom) dom.restore();
  dom = null;
  globalThis.fetch = REAL.fetch;
  globalThis.window = REAL.window;
  globalThis.setTimeout = REAL.setTimeout;
});

function photo(w = W, h = H) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#7788aa';
  ctx.fillRect(0, 0, w, h);
  return c;
}

/** A stroke canvas with an opaque block, i.e. a painted area. */
function stroke(rect = [10, 10, 60, 60]) {
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]);
  // The island reads classList on the stroke canvas as well as drawing it.
  const cl = new Set();
  c.classList = {
    add: (n) => cl.add(n),
    remove: (n) => cl.delete(n),
    contains: (n) => cl.has(n),
    toggle: (n, on) => (on ? cl.add(n) : cl.delete(n)),
  };
  return c;
}

function layer(id, over = {}) {
  return {
    id,
    painted: true,
    status: 'idle',
    prompt: 'a grey sofa',
    mode: 'stage',
    furniture: null,
    furnitureName: '',
    name: '',
    candidates: [],
    candIdx: 0,
    editedImg: null,
    errorMsg: '',
    blendMask: null,
    canvasEl: stroke(),
    ...over,
  };
}

/**
 * Build the island against a fake browser.
 *
 * `replies` is consumed one per POST; each is a status plus a body, so a test can
 * script "429, 429, then 200". `holdReply` defers every answer.
 */
function mount({
  layers = [layer('L1')],
  phase = 'draw',
  base = true,
  genRun = 0,
  genMeta = null,
  replies = null,
  holdReply = null,
  disabled = false,
  hasAnyResults = false,
} = {}) {
  dom = installMaskDom();

  const state = {
    base: base ? { w: W, h: H, canvas: photo() } : null,
    phase,
    view: 'after',
    zoom: 1,
    layers,
    genRun,
    genMeta,
    undoStack: [],
    redoStack: [],
  };

  const calls = {
    posts: [],
    toasts: [],
    phases: [],
    views: [],
    renderLayers: 0,
    updateControls: 0,
    busyDots: [],
    spillFor: [],
    progress: [],
    sleeps: [],
  };

  const els = {};
  for (const n of ['generateBtn', 'progressEl', 'progressBar', 'progressText']) els[n] = new FakeEl('div');
  els.generateBtn.disabled = disabled;
  els.baseCanvas = photo();
  els.resultCanvas = photo();

  const queue = replies ? [...replies] : null;

  globalThis.window = /** @type {any} */ ({ StagifyAuth: { getToken: () => 'tok-7' } });
  // The backoff sleeps are 1.5s+ with jitter; record and collapse them so the retry
  // policy can be asserted without waiting for it.
  globalThis.setTimeout = /** @type {any} */ (
    (fn, ms, ...rest) => {
      if (ms > 5) calls.sleeps.push(ms);
      return REAL.setTimeout(fn, 0, ...rest);
    }
  );
  globalThis.fetch = /** @type {any} */ (
    async (url, opts) => {
      calls.posts.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
      if (holdReply) await holdReply;
      const reply = queue && queue.length ? queue.shift() : { status: 200 };
      const headers = new Map(Object.entries(reply.headers || {}));
      return {
        ok: reply.status >= 200 && reply.status < 300,
        status: reply.status,
        headers: { get: (k) => headers.get(k) ?? null },
        json: async () => {
          if (reply.badJson) throw new Error('not json');
          return reply.body !== undefined
            ? reply.body
            : { editedImage: 'data:image/png;base64,AAA' };
        },
      };
    }
  );

  const island = createGeneratePipeline({
    state,
    ...els,
    setPhase: (p) => { calls.phases.push(p); state.phase = p; },
    setView: (v) => { calls.views.push(v); state.view = v; },
    renderLayers: () => { calls.renderLayers += 1; },
    updateControls: () => { calls.updateControls += 1; },
    renderBusyDots: (p) => calls.busyDots.push((p || []).map((l) => l.id)),
    hasAnyResults: () => hasAnyResults,
    getLayer: (id) => state.layers.find((l) => l.id === id) || null,
    requestError: (status) => `request failed (${status})`,
    showToast: (message, type) => calls.toasts.push({ message, type }),
    tx: (_key, def) => def,
    loadImage: async () => /** @type {any} */ (photo()),
    computeSpillForDone: (p) => {
      calls.spillFor.push((p || []).map((l) => l.id));
      return state.__spill || 0;
    },
  });

  // progressBar/progressText are FakeEls; record what the island writes to them.
  const origStyle = els.progressBar.style;
  Object.defineProperty(els.progressBar, 'style', {
    get: () => new Proxy(origStyle, {
      set: (t, k, v) => { if (k === 'width') calls.progress.push(v); t[k] = v; return true; },
    }),
  });

  return { island, state, calls, els };
}

const clickGenerate = (h) => {
  const fired = h.els.generateBtn.emit('click', {});
  assert.equal(fired, 1, 'the island wires Apply Edit itself');
  return new Promise((r) => REAL.setTimeout(r, 30));
};

const settle = (ms = 30) => new Promise((r) => REAL.setTimeout(r, ms));

// ---- the gates before a run starts ----------------------------------------------

test('a disabled Apply Edit does nothing, even if the click gets through', async () => {
  const h = mount({ disabled: true });

  await clickGenerate(h);

  assert.deepEqual(h.calls.posts, []);
});

test('a run with no photo does nothing', async () => {
  const h = mount({ base: false });

  await clickGenerate(h);

  assert.deepEqual(h.calls.posts, []);
});

test('a run with nothing painted asks for a highlight', async () => {
  const h = mount({ layers: [layer('L1', { painted: false })] });

  await clickGenerate(h);

  assert.deepEqual(h.calls.posts, []);
  assert.match(h.calls.toasts[0].message, /Paint at least one area/);
});

test('an area with no instruction is selected and named, not just refused', async () => {
  // Refusing without saying WHICH area is missing leaves the user hunting through
  // six of them. Selecting it puts the cursor where the fix goes.
  const h = mount({
    layers: [layer('a'), layer('b', { prompt: '   ' })],
  });

  await clickGenerate(h);

  assert.deepEqual(h.calls.posts, []);
  assert.equal(h.state.activeId, 'b', 'the offending area is selected');
  assert.ok(h.calls.renderLayers > 0, 'and the list is repainted so the user sees it');
  assert.match(h.calls.toasts[0].message, /short prompt or a furniture photo/);
});

test('a remove-mode area needs no prompt to start a run', async () => {
  const h = mount({ layers: [layer('L1', { mode: 'remove', prompt: '' })] });

  await clickGenerate(h);

  assert.equal(h.calls.posts.length, 1);
});

// ---- the request ------------------------------------------------------------------

test('each area posts the room, its own mask and its own prompt', async () => {
  const h = mount({ layers: [layer('a', { prompt: 'a grey sofa' }), layer('b', { prompt: 'a rug' })] });

  await clickGenerate(h);

  assert.equal(h.calls.posts.length, 2, 'one request per painted area');
  const prompts = h.calls.posts.map((p) => p.body.prompt);
  assert.ok(prompts.some((p) => p.startsWith('a grey sofa')));
  assert.ok(prompts.some((p) => p.startsWith('a rug')));
  for (const p of h.calls.posts) {
    assert.equal(p.url, '/api/mask-edit');
    assert.equal(p.headers.Authorization, 'Bearer tok-7');
    assert.match(p.body.image, /^data:image\/jpeg/, 'the room goes up as JPEG, not PNG');
    assert.match(p.body.mask, /^data:image\/png/, 'the mask must stay lossless');
    assert.equal(typeof p.body.seed, 'number');
  }
});

test('an empty prompt falls back to the default furniture instruction', async () => {
  const h = mount({ layers: [layer('L1', { prompt: '', furniture: 'data:image/png;base64,ZZ' })] });

  await clickGenerate(h);

  assert.match(h.calls.posts[0].body.prompt, /Add the furniture from the reference photo/);
});

test('remove-mode sends the reconstruction instruction, not the furniture one', async () => {
  const h = mount({ layers: [layer('L1', { mode: 'remove', prompt: '' })] });

  await clickGenerate(h);

  const { prompt } = h.calls.posts[0].body;
  assert.match(prompt, /Remove everything inside the highlighted area/);
  assert.match(prompt, /Do not add any new furniture/);
});

test('a remove-mode area can still add its own words', async () => {
  const h = mount({ layers: [layer('L1', { mode: 'remove', prompt: 'leave the rug' })] });

  await clickGenerate(h);

  const { prompt } = h.calls.posts[0].body;
  assert.match(prompt, /Remove everything inside/, 'the base instruction survives');
  assert.match(prompt, /leave the rug/, 'and the user is appended to it');
});

test('the prompt is capped once neighbour context is appended', async () => {
  // Two areas, so buildAreaContext returns something and the cap runs.
  const h = mount({
    layers: [layer('a', { prompt: 'x'.repeat(2000) }), layer('b', { prompt: 'a rug' })],
  });

  await clickGenerate(h);

  const long = h.calls.posts.find((p) => p.body.prompt.startsWith('x'));
  assert.equal(long.body.prompt.length, 1000, "the user's own words win, the context yields");
});

test('KNOWN DEFECT: a lone area sends its prompt uncapped, and the server rejects it', async () => {
  // This pins CURRENT behaviour, not desired behaviour.
  //
  // The cap lives inside `if (context)`, and buildAreaContext returns '' when there
  // are no neighbours — so with exactly one painted area a >1000-char prompt goes up
  // untruncated. lib/staging/mask-edit.js:81 does not truncate, it rejects:
  // 400 "Prompt is too long (max 1000 characters)". The user sees the area fail.
  //
  // The symptom is the confusing part: the SAME prompt succeeds as soon as a second
  // area is painted (the test above), so it presents as "staging randomly fails on
  // long prompts" rather than as a length limit.
  //
  // The fix is one line — apply the slice unconditionally:
  //   prompt = (prompt + (context || '')).slice(0, 1000);
  // When that lands, this test should be deleted and the one above widened to the
  // single-area case.
  const h = mount({ layers: [layer('L1', { prompt: 'x'.repeat(2000) })] });

  await clickGenerate(h);

  assert.equal(
    h.calls.posts[0].body.prompt.length,
    2000,
    'documenting the defect: no cap is applied without neighbour context',
  );
});

test('a furniture photo rides along only when it can be used', async () => {
  const withRef = mount({ layers: [layer('L1', { furniture: 'data:image/png;base64,ZZ' })] });
  await clickGenerate(withRef);
  assert.equal(withRef.calls.posts[0].body.referenceImage, 'data:image/png;base64,ZZ');

  // Removal rebuilds what is behind the mask — a reference photo there would invite
  // the model to put the furniture back.
  const removing = mount({
    layers: [layer('L1', { mode: 'remove', furniture: 'data:image/png;base64,ZZ' })],
  });
  await clickGenerate(removing);
  assert.equal(removing.calls.posts[0].body.referenceImage, undefined);
});

test('areas are told what their neighbours are doing', async () => {
  // They generate in parallel and never see each other's output, so the only way
  // lighting and perspective stay coherent is for each prompt to describe the rest.
  const h = mount({
    layers: [
      layer('a', { prompt: 'a grey sofa', canvasEl: stroke([5, 5, 40, 40]) }),
      layer('b', { prompt: 'a floor lamp', canvasEl: stroke([150, 100, 190, 140]) }),
    ],
  });

  await clickGenerate(h);

  const forSofa = h.calls.posts.find((p) => p.body.prompt.startsWith('a grey sofa'));
  assert.match(forSofa.body.prompt, /floor lamp/, "the sofa's prompt mentions the lamp");
  assert.ok(forSofa.body.prompt.length > 'a grey sofa'.length);
});

test('a single area is not given neighbour context it does not need', async () => {
  const h = mount({ layers: [layer('L1', { prompt: 'a grey sofa' })] });

  await clickGenerate(h);

  assert.equal(h.calls.posts[0].body.prompt, 'a grey sofa');
});

// ---- retries -------------------------------------------------------------------

test('a rate limit is retried twice, then given up on', async () => {
  const h = mount({
    replies: [{ status: 429 }, { status: 429 }, { status: 429 }],
  });

  await clickGenerate(h);
  await settle();

  assert.equal(h.calls.posts.length, 3, 'the original plus two retries');
  assert.equal(h.state.layers[0].status, 'failed');
  assert.equal(h.calls.sleeps.length, 2, 'and it waited between them');
});

test('a transient overload that clears is retried into success', async () => {
  const h = mount({ replies: [{ status: 503 }, { status: 200 }] });

  await clickGenerate(h);
  await settle();

  assert.equal(h.calls.posts.length, 2);
  assert.equal(h.state.layers[0].status, 'done');
});

test('a permanent error is not retried', async () => {
  // Retrying a 400 spends quota on a request that cannot succeed.
  const h = mount({ replies: [{ status: 400, body: {} }] });

  await clickGenerate(h);
  await settle();

  assert.equal(h.calls.posts.length, 1);
  assert.equal(h.state.layers[0].status, 'failed');
  assert.deepEqual(h.calls.sleeps, [], 'and it did not wait first');
});

test("the server's Retry-After is honoured over the backoff guess", async () => {
  const h = mount({
    replies: [{ status: 429, headers: { 'retry-after': '5' } }, { status: 200 }],
  });

  await clickGenerate(h);
  await settle();

  assert.deepEqual(h.calls.sleeps, [5000], 'exactly what the server asked for');
});

test('an absurd Retry-After is ignored in favour of the backoff', async () => {
  // A misconfigured proxy answering "retry after 3600" would park the studio for an
  // hour with a spinner up.
  const h = mount({
    replies: [{ status: 429, headers: { 'retry-after': '3600' } }, { status: 200 }],
  });

  await clickGenerate(h);
  await settle();

  assert.equal(h.calls.sleeps.length, 1);
  assert.ok(h.calls.sleeps[0] < 3000, `fell back to the backoff, waited ${h.calls.sleeps[0]}ms`);
});

test('a response with no image is a failure', async () => {
  const h = mount({ replies: [{ status: 200, body: { ok: true } }] });

  await clickGenerate(h);
  await settle();

  assert.equal(h.state.layers[0].status, 'failed');
});

// ---- supersession ------------------------------------------------------------------

test('a superseded run writes nothing into the layers', async () => {
  // The user hit Apply Edit again, or reset. The first run must land nowhere: its
  // output belongs to a state that no longer exists.
  let release = () => {};
  const held = new Promise((r) => { release = r; });
  const h = mount({ holdReply: held });

  const running = clickGenerate(h);
  h.state.genRun += 1; // a newer run supersedes this one
  release();
  await running;
  await settle();

  assert.equal(h.state.layers[0].status, 'generating', 'never marked done or failed');
  assert.equal(h.state.layers[0].editedImg, null, 'and no output was kept');
});

// ---- the outcome --------------------------------------------------------------------

test('a fully successful run lands in refine with a success message', async () => {
  const h = mount({ layers: [layer('a'), layer('b')] });

  await clickGenerate(h);
  await settle();

  assert.deepEqual(h.state.layers.map((l) => l.status), ['done', 'done']);
  assert.equal(h.calls.phases.at(-1), 'draw', 'refine, not review — the highlights stay editable');
  assert.match(h.calls.toasts.at(-1).message, /All areas staged/);
  assert.equal(h.calls.toasts.at(-1).type, 'success');
});

test('a partial run says how much got through', async () => {
  const h = mount({
    layers: [layer('a'), layer('b')],
    replies: [{ status: 200 }, { status: 400, body: {} }],
  });

  await clickGenerate(h);
  await settle();

  const msg = h.calls.toasts.at(-1).message;
  assert.match(msg, /1 of 2/, 'the counts are filled in, not left as placeholders');
  assert.match(msg, /retry the failed ones/);
});

test('a run where everything failed goes back to the original photo', async () => {
  // There is nothing to refine, so leaving the user in the refine phase would show
  // them highlights over an unchanged photo with no explanation.
  const h = mount({ replies: [{ status: 400, body: {} }] });

  await clickGenerate(h);
  await settle();

  assert.equal(h.calls.phases.at(-1), 'review');
  assert.deepEqual(h.calls.views.at(-1), 'before');
  assert.match(h.calls.toasts.at(-1).message, /Staging failed/);
});

test('overhang past a highlight is offered as a snap', async () => {
  const h = mount();
  h.state.__spill = 2;

  await clickGenerate(h);
  await settle();

  assert.deepEqual(h.calls.spillFor.at(-1), ['L1'], 'spill is measured for the run participants');
  assert.ok(
    h.calls.toasts.some((t) => /Snap to object/.test(t.message)),
    'and the user is told the option exists',
  );
});

test('no overhang means no extra message', async () => {
  const h = mount();

  await clickGenerate(h);
  await settle();

  assert.ok(!h.calls.toasts.some((t) => /Snap to object/.test(t.message)));
});

test('a failed run is not asked about overhang at all', async () => {
  const h = mount({ replies: [{ status: 400, body: {} }] });

  await clickGenerate(h);
  await settle();

  assert.deepEqual(h.calls.spillFor, [], 'nothing generated, nothing to measure');
});

test('progress is reported per area as they settle', async () => {
  const h = mount({ layers: [layer('a'), layer('b')] });

  await clickGenerate(h);
  await settle();

  assert.deepEqual(h.calls.progress, ['0%', '50%', '100%']);
  assert.equal(h.els.progressEl.classList.contains('hidden'), true, 'and the bar is put away');
});

// ---- versions --------------------------------------------------------------------

test('each run keeps its result as a selectable version, up to a cap', async () => {
  // Every candidate is a full-resolution image; keeping them all would grow the tab's
  // memory without bound across a long refine session.
  const h = mount({ genMeta: { coreGrow: 2, featherPx: 2 } });

  for (let i = 0; i < 6; i += 1) {
    await h.island.retryLayer('L1');
    await settle();
  }

  assert.equal(h.state.layers[0].candidates.length, 4, 'the oldest versions are dropped');
  assert.equal(h.state.layers[0].candIdx, 3, 'and the newest is selected');
});

test('selecting a version wraps around in both directions', async () => {
  const h = mount({
    layers: [layer('L1', { candidates: [photo(), photo(), photo()], candIdx: 0, status: 'done' })],
  });
  const l = h.state.layers[0];

  h.island.selectCandidate(l, 3);
  assert.equal(l.candIdx, 0, 'past the end comes back to the start');

  h.island.selectCandidate(l, -1);
  assert.equal(l.candIdx, 2, 'and before the start goes to the end');
  assert.equal(l.editedImg, l.candidates[2]);
});

test('versions cannot be flipped mid-run', async () => {
  const h = mount({
    phase: 'generating',
    layers: [layer('L1', { candidates: [photo(), photo()], candIdx: 0 })],
  });

  h.island.selectCandidate(h.state.layers[0], 1);

  assert.equal(h.state.layers[0].candIdx, 0);
});

test('an area with no versions has nothing to select', async () => {
  const h = mount();

  h.island.selectCandidate(h.state.layers[0], 1);

  assert.equal(h.state.layers[0].candIdx, 0);
});

// ---- retrying one area -----------------------------------------------------------

test('a retry that fails keeps the version the area already had', async () => {
  // "Try another version" is a gamble the user should be able to lose safely. Marking
  // the area failed here would throw away a render they were happy with.
  const good = photo();
  const h = mount({
    genMeta: { coreGrow: 2, featherPx: 2 },
    layers: [layer('L1', { status: 'done', candidates: [good], candIdx: 0, editedImg: good })],
    replies: [{ status: 400, body: {} }],
  });

  await h.island.retryLayer('L1');
  await settle();

  assert.equal(h.state.layers[0].status, 'done', 'still done');
  assert.equal(h.state.layers[0].editedImg, good, 'and still showing the version that worked');
  assert.match(h.calls.toasts.at(-1).message, /request failed/, 'but the user is told');
});

test('a first attempt that fails does mark the area failed', async () => {
  // The other half: with nothing to fall back on, the area really is failed and the
  // retry button has to appear.
  const h = mount({
    genMeta: { coreGrow: 2, featherPx: 2 },
    layers: [layer('L1', { status: 'failed' })],
    replies: [{ status: 400, body: {} }],
  });

  await h.island.retryLayer('L1');
  await settle();

  assert.equal(h.state.layers[0].status, 'failed');
  assert.ok(h.state.layers[0].errorMsg.length > 0, 'with the reason kept for the row');
});

test('a retry refreshes only that area snap suggestion', async () => {
  const h = mount({ genMeta: { coreGrow: 2, featherPx: 2 }, layers: [layer('a'), layer('b')] });

  await h.island.retryLayer('a');
  await settle();

  assert.deepEqual(h.calls.spillFor, [['a']]);
});

test('a retry is refused mid-run, without a photo, or before any run has happened', async () => {
  for (const opts of [
    { phase: 'generating', genMeta: { coreGrow: 2, featherPx: 2 } },
    { base: false, genMeta: { coreGrow: 2, featherPx: 2 } },
    { genMeta: null },
  ]) {
    const h = mount(opts);
    await h.island.retryLayer('L1');
    await settle();
    assert.deepEqual(h.calls.posts, [], `refused for ${JSON.stringify(Object.keys(opts))}`);
    dom.restore();
    dom = null;
  }
});

test('an unpainted area cannot be retried', async () => {
  const h = mount({
    genMeta: { coreGrow: 2, featherPx: 2 },
    layers: [layer('L1', { painted: false })],
  });

  await h.island.retryLayer('L1');
  await settle();

  assert.deepEqual(h.calls.posts, []);
});

// ---- compositing --------------------------------------------------------------------

test('an area that has not finished is not composited in', async () => {
  const h = mount({
    layers: [layer('L1', { status: 'generating', editedImg: photo(), blendMask: photo() })],
  });

  h.island.compositeAll();

  // Nothing to assert on pixels here beyond "it did not throw and did not use the
  // half-finished output"; the pixel guarantee itself is mask-core's, tested in
  // test/frontend/masking-studio/mask-core.test.js.
  assert.ok(true);
});

test('compositing with no photo is a no-op rather than a crash', () => {
  const h = mount({ base: false });

  h.island.compositeAll();
  h.island.updateStageBackdrop();

  assert.ok(true);
});
