// Tier: frontend island logic (DOM/fetch-shimmed) — public/scripts/app/staging-pipeline.js.
//
// This is the flagship path: upload a photo, spend a generation, get a staged room.
// It had no unit coverage. The failures it can produce are all quiet ones — nobody
// sees an exception, they see the wrong outcome — so the assertions target exactly
// those, and nothing else:
//
//  1. THE UNSTAGEABLE GATE HAS THREE ARMS AND THEY ARE NOT INTERCHANGEABLE. The
//     stageability pre-check starts at upload and races the generation. If it has
//     already said no, we must refuse BEFORE fetch (a wasted generation is money).
//     If it says no mid-flight, we must ABORT and show the reason, not let the
//     abort surface as a generic network error. If it only lands after a 200 came
//     back, we must DISCARD the finished image rather than display it. Losing any
//     one arm looks like nothing at all from the outside — the app keeps working,
//     it just stages photos it promised not to, or bills for them.
//  2. THE REJECTION MUST NOT LEAVE THE SPINNER UP. Every refusal path tears the
//     loading UI back down before it throws. Forget it and the user is stuck
//     staring at a progress bar that will never move.
//  3. keepFurniture IS GATED ON THE CHECKBOX. Sending the "keep these" text while
//     "remove existing furniture" is off contradicts the prompt server-side.
//  4. FURNITURE REFERENCES ARE PRO-ONLY AND CAPPED. The panel is hidden for free
//     users, so reading its files without checking would ship them anyway.
//  5. SERVER ERRORS MAP TO CODES, NOT PROSE. The caller (stageImage) branches on
//     err.code; a mapping that falls through to a bare Error silently turns a
//     "you hit your daily limit" into "something went wrong".
//
// Deliberately NOT asserted: which progress percentages appear when, how many
// intervals are used, or the wording of the loading lines. Those are cosmetics a
// refactor should be free to change.
//
// TIME IS COMPRESSED, not mocked: setTimeout/setInterval are wrapped so every delay
// becomes ~1ms. The module's real waits (an 800ms pro upload animation, a 3s error
// banner) would otherwise dominate the suite, and none of them are under test.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createStagingPipeline } from '../../../public/scripts/app/staging-pipeline.js';

// Every case here awaits a promise the pipeline is supposed to settle. A pipeline
// that stops settling it — a dropped `throw`, a gate that returns instead of
// rejecting — would otherwise hang the runner forever instead of failing, so each
// case gets a wall-clock ceiling. They all finish in single-digit milliseconds.
/** @type {(name: string, fn: () => any) => void} */
const timed = (name, fn) => test(name, { timeout: 5000 }, fn);

// ── shim ───────────────────────────────────────────────────────────────────────

const classList = () => {
  const set = new Set();
  return {
    add: (...n) => n.forEach((x) => set.add(x)),
    remove: (...n) => n.forEach((x) => set.delete(x)),
    contains: (n) => set.has(n),
    has: (n) => set.has(n),
  };
};
const el = () => ({ classList: classList(), style: {}, textContent: '' });

const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

/** Let the pipeline's pending microtasks/timers run. */
const tick = () => new Promise((r) => setTimeout(r, 2));

// Captured once, at module load, so a test that builds two harnesses cannot save
// the first harness's shims as if they were the originals.
const REAL = {
  document: globalThis.document,
  window: globalThis.window,
  localStorage: globalThis.localStorage,
  fetch: globalThis.fetch,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
};

/**
 * Intervals the pipeline started. The module clears its own on every exit path,
 * but a mutant (or a future bug) that stops clearing them would leave 1ms timers
 * spinning and the runner would never exit — a hang instead of a red test. These
 * are swept after each case so a failure stays a failure.
 */
const openTimers = new Set();
const realClearInterval = clearInterval;

afterEach(() => {
  openTimers.forEach((id) => realClearInterval(id));
  openTimers.clear();
  Object.assign(globalThis, REAL);
});

/**
 * @param {{
 *   pro?: boolean,
 *   proPanel?: 'visible' | 'hidden-class' | 'display-none' | 'absent',
 *   removeFurniture?: boolean,
 *   keepFurniture?: string,
 *   labelVirtuallyStaged?: boolean,
 *   labelCheckboxPresent?: boolean,
 *   stampStyle?: string | null,
 *   stampScale?: string | null,
 *   selectedLanguage?: string | null,
 *   furnitureFiles?: File[],
 *   validationResult?: { valid: boolean, code?: string, reason?: string } | null,
 *   validationPromise?: Promise<any> | null,
 *   hasProcessedImage?: boolean,
 *   stagingTimeoutMs?: number,
 * }} opts
 */
function harness(opts = {}) {
  const {
    pro = false,
    proPanel = 'visible',
    removeFurniture = false,
    keepFurniture = '',
    labelVirtuallyStaged = false,
    labelCheckboxPresent = true,
    // The badge style/size strip. `null` means the control is absent from the page, which
    // is the real state on every studio that reuses this pipeline without the strip.
    stampStyle = 'dark',
    stampScale = '1',
    selectedLanguage = null,
    furnitureFiles = [],
    validationResult = null,
    validationPromise = null,
    hasProcessedImage = false,
    // Default well above the shim's squash threshold so it never fires unless a
    // test is deliberately exercising it.
    stagingTimeoutMs = 180000,
  } = opts;

  const dom = {
    stagePreview: el(),
    progress: el(),
    progressBar: el(),
    progressText: el(),
    loadingMessage: el(),
    processingPlaceholder: el(),
  };

  const byId = new Map();
  const removeCheckbox = el();
  removeCheckbox.checked = removeFurniture;
  byId.set('remove-furniture', removeCheckbox);
  const keepEl = el();
  keepEl.value = keepFurniture;
  byId.set('keep-furniture', keepEl);
  // Registered UNCONDITIONALLY, outside the `if (pro)` block below that builds the pro
  // panel — the disclosure checkbox exists for every plan, and putting it there would
  // make the free-account test below silently vacuous.
  if (labelCheckboxPresent) {
    const labelCheckbox = el();
    labelCheckbox.checked = labelVirtuallyStaged;
    byId.set('label-virtually-staged', labelCheckbox);
  }
  // The badge strip as a CONTAINER, which is how the pipeline reads it: index.html now
  // carries two of these (staging's and the Basic Mask dialog's), so the read is scoped to
  // #stamp-opts rather than sweeping the document — an unscoped one would hand staging the
  // style the user picked in the other modal.
  const stampOpts = el();
  stampOpts.querySelector = (sel) => {
    if (sel === '.stamp-swatch__input:checked') {
      if (stampStyle === null) return null;
      const radio = el();
      radio.value = stampStyle;
      radio.checked = true;
      return radio;
    }
    if (sel === '.stamp-opts__size') {
      if (stampScale === null) return null;
      const scaleInput = el();
      scaleInput.value = stampScale;
      return scaleInput;
    }
    return null;
  };
  // Absent entirely when neither control is modelled — that is the "page with no strip"
  // case, and registering an empty container would make it assert nothing.
  if (stampStyle !== null || stampScale !== null) byId.set('stamp-opts', stampOpts);
  // The Cancel control under the progress bar. A minimal event-target stand-in:
  // `click()` runs whatever the pipeline registered, so a test can press it.
  const cancelBtn = el();
  cancelBtn.listeners = new Set();
  cancelBtn.addEventListener = (type, fn) => { if (type === 'click') cancelBtn.listeners.add(fn); };
  cancelBtn.removeEventListener = (type, fn) => { if (type === 'click') cancelBtn.listeners.delete(fn); };
  cancelBtn.click = () => { for (const fn of [...cancelBtn.listeners]) fn(); };
  cancelBtn.classList.add('hidden');
  byId.set('stage-cancel-btn', cancelBtn);
  if (proPanel !== 'absent') {
    const panel = el();
    if (proPanel === 'hidden-class') panel.classList.add('hidden');
    panel.style.display = proPanel === 'display-none' ? 'none' : 'block';
    panel.style.visibility = 'visible';
    byId.set('stagify-pro-panel', panel);
    const model = el(); model.value = 'gpt-image-1'; byId.set('stagify-model-select', model);
    const variation = el(); variation.value = '2'; byId.set('stagify-variation-count', variation);
  }

  const calls = {
    fetch: [],
    showStagingError: [],
    // The second argument, recorded alongside rather than folded in, so the many
    // message-only assertions below stay readable. It is what decides whether the
    // Exterior Studio button appears under the sentence.
    showStagingErrorVerdicts: [],
    showStagingLimitInViewer: [],
    hideStagingLimitInViewer: 0,
    hideStagingError: 0,
    showBeforeView: 0,
    lastEmptyRoomUrl: undefined,
    furnitureReset: 0,
    timeoutIds: [],
    clearedTimeouts: [],
  };

  /** @type {{ resolve: (r: any) => void, reject: (e: any) => void } | null} */
  let pendingFetch = null;

  // See the header: delays are squashed, not faked. Ordering between two squashed
  // delays is not meaningful, and nothing here asserts on it.
  //
  // Only SHORT delays are squashed. The staging timeout is a three-minute "something
  // has gone wrong" ceiling, and collapsing it to 1ms made it fire during every test,
  // aborting each fetch before it could be settled. A test that wants to exercise the
  // timeout passes a small `stagingTimeoutMs` instead, which lands under the threshold
  // and is squashed like any other short delay.
  const SQUASH_BELOW_MS = 10000;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const id = REAL.setTimeout(fn, ms && ms < SQUASH_BELOW_MS ? 1 : ms, ...rest);
    // Remember which id was armed with the staging ceiling, so a test can prove it
    // gets cleared rather than inferring it from timing (which is a race).
    if (ms === stagingTimeoutMs) calls.timeoutIds.push(id);
    return id;
  };
  globalThis.clearTimeout = (id) => { calls.clearedTimeouts.push(id); return REAL.clearTimeout(id); };
  globalThis.setInterval = (fn, ms, ...rest) => {
    const id = REAL.setInterval(fn, Math.max(1, Math.min(ms || 1, 5)), ...rest);
    openTimers.add(id);
    return id;
  };

  globalThis.document = {
    getElementById: (id) => byId.get(id) || null,
    // Nothing resolves the strip's controls from the document any more — they are found
    // within #stamp-opts above. Left throwing-by-absence (null) so a regression back to a
    // document-wide sweep shows up as a missing value rather than quietly working here and
    // reading the wrong modal's controls in the browser.
    querySelector: () => null,
  };
  globalThis.localStorage = {
    getItem: (k) => ({ userRole: 'agent', userReferralSource: 'google', userEmail: 'a@b.co', selectedLanguage })[k] ?? null,
  };
  globalThis.window = {
    StagifyAuth: { getToken: () => 'tok-123', user: null, applyUserToUI() { this.appliedToUI = true; } },
    LanguageSystem: null,
    getComputedStyle: (node) => ({ display: node.style.display || 'block', visibility: node.style.visibility || 'visible' }),
  };
  globalThis.fetch = (url, init) => {
    calls.fetch.push({ url, init, body: init.body });
    return new Promise((resolve, reject) => {
      pendingFetch = { resolve, reject };
      init.signal?.addEventListener('abort', () => {
        const e = new Error('The user aborted a request.');
        e.name = 'AbortError';
        reject(e);
      });
    });
  };

  const pipeline = createStagingPipeline({
    ...dom,
    roomSelect: { value: 'Bedroom' },
    styleSelect: { value: 'modern' },
    additionalPrompt: /** @type {any} */ ({ value: 'add a rug' }),
    furnitureRefs: { getFiles: () => furnitureFiles, reset: () => { calls.furnitureReset += 1; } },
    FURNITURE_LIMIT: 3,
    getStageValidation: () => validationPromise,
    getStageValidationResult: () => validationResult,
    getHasProcessedImage: () => hasProcessedImage,
    setLastEmptyRoomUrl: (u) => { calls.lastEmptyRoomUrl = u; },
    hideStagingLimitInViewer: () => { calls.hideStagingLimitInViewer += 1; },
    hideStagingError: () => { calls.hideStagingError += 1; },
    showBeforeView: () => { calls.showBeforeView += 1; },
    isProUser: () => pro,
    showStagingError: (m, verdict) => {
      calls.showStagingError.push(m);
      calls.showStagingErrorVerdicts.push(verdict);
    },
    messageForDailyLimitResponse: (d) => `limit: ${d.error || 'reached'}`,
    showStagingLimitInViewer: (m) => calls.showStagingLimitInViewer.push(m),
    stagingTimeoutMs,
  });

  return {
    pipeline,
    dom,
    cancelBtn,
    calls,
    /** The multipart body of the Nth (default first) fetch. */
    form: (n = 0) => /** @type {FormData} */ (calls.fetch[n].body),
    settleFetch: (r) => { pendingFetch.resolve(r); },
    file: () => new File(['room'], 'room.jpg', { type: 'image/jpeg' }),
  };
}

/** A fetch Response stand-in; `jsonCalls` proves whether the body was ever read. */
function response({ ok = true, status = 200, body = {} } = {}) {
  const r = { ok, status, jsonCalls: 0 };
  r.json = async () => { r.jsonCalls += 1; return body; };
  return r;
}

const OK_BODY = { success: true, images: ['https://cdn/a.png', 'https://cdn/b.png'], emptyRoom: 'https://cdn/empty.png' };

/** Run the pipeline to completion against a single canned response. */
async function run(h, resp) {
  const p = h.pipeline.processWithAI(h.file());
  await tick();
  h.settleFetch(resp);
  return p;
}

// ── arm 1: refuse before spending a generation ────────────────────────────────

timed('a photo the pre-check already rejected never reaches the server', async () => {
  const h = harness({ validationResult: { valid: false, code: 'PERSON_PORTRAIT', reason: 'That is a selfie.' } });
  const p = h.pipeline.processWithAI(h.file());
  p.catch(() => {}); // asserted below; this only stops an unhandled-rejection warning
  await tick();
  // Checked BEFORE awaiting the rejection: if the gate is gone the pipeline is
  // sitting on a fetch nobody will settle, and this fails now rather than at the
  // case timeout.
  assert.equal(h.calls.fetch.length, 0, 'a rejected photo must not cost a generation');
  await assert.rejects(p, (e) => e.code === 'NOT_STAGEABLE' && /selfie/i.test(e.message));
  assert.deepEqual(h.calls.showStagingError, ['That is a selfie.']);
});

timed('the whole verdict is handed on, not just its sentence', async () => {
  // The panel needs the CODE, not only the copy: EXTERIOR earns a link to the Exterior
  // Studio beside the message (public/scripts/app/staging-error-cta.js), and every other
  // category earns that link being taken away. Dropping the second argument here would
  // leave both studios showing the right sentence and no hand-off, silently.
  const result = { valid: false, code: 'EXTERIOR', reason: 'That is the outside of a house.' };
  const h = harness({ validationResult: result });
  const p = h.pipeline.processWithAI(h.file());
  p.catch(() => {});
  await tick();
  await assert.rejects(p, (e) => e.code === 'NOT_STAGEABLE');
  assert.deepEqual(h.calls.showStagingErrorVerdicts, [result], 'the verdict object itself must reach the panel');
});

timed('the refusal tears the loading UI down before it throws', async () => {
  const h = harness({ validationResult: { valid: false, reason: 'Not a room.' } });
  await assert.rejects(h.pipeline.processWithAI(h.file()));
  assert.equal(h.dom.stagePreview.classList.has('processing'), false, 'spinner class left on the preview');
  assert.equal(h.dom.progress.classList.has('hidden'), true, 'progress bar left on screen');
  assert.equal(h.dom.loadingMessage.classList.has('hidden'), true);
  assert.equal(h.dom.progressBar.style.width, '0%');
});

timed('a pre-check that PASSED does not block the generation', async () => {
  const h = harness({ validationResult: { valid: true, reason: '' } });
  const urls = await run(h, response({ body: OK_BODY }));
  assert.deepEqual(urls, OK_BODY.images);
  assert.equal(h.calls.fetch.length, 1);
});

// ── arm 2: abort a generation the pre-check overtakes ─────────────────────────

timed('a pre-check that rejects mid-flight aborts the generation and shows the reason', async () => {
  // Without the abort the user waits out a full generation for an image that is
  // then thrown away. Without the validationRejection branch in the catch, the
  // abort surfaces as a bare network error and the reason is never shown.
  const d = deferred();
  const h = harness({ validationPromise: d.promise, validationResult: null });
  const p = h.pipeline.processWithAI(h.file());
  p.catch(() => {}); // asserted below; this only stops an unhandled-rejection warning
  await tick();
  assert.equal(h.calls.fetch.length, 1, 'the generation did start — the race is real');
  assert.ok(h.calls.fetch[0].init.signal, 'the fetch must be abortable');

  d.resolve({ valid: false, code: 'FOOD', reason: 'That is a plate of food.' });
  await tick();
  // Same reason as above: assert the abort first, so a dropped abort() is a red
  // assertion and not a hung case.
  assert.equal(h.calls.fetch[0].init.signal.aborted, true, 'the in-flight generation must be aborted');
  await assert.rejects(p, (e) => e.code === 'NOT_STAGEABLE' && /plate of food/.test(e.message));
  assert.deepEqual(h.calls.showStagingError, ['That is a plate of food.']);
  assert.equal(h.dom.stagePreview.classList.has('processing'), false);
});

timed('a genuine network failure is NOT dressed up as a stageability rejection', async () => {
  const d = deferred();
  const h = harness({ validationPromise: d.promise });
  const p = h.pipeline.processWithAI(h.file());
  await tick();
  d.resolve({ valid: true, reason: '' });
  await tick();
  h.calls.fetch[0].init.signal.dispatchEvent(new Event('abort'));
  await assert.rejects(p, (e) => e.code !== 'NOT_STAGEABLE');
  assert.deepEqual(h.calls.showStagingError, [], 'no unstageable copy for a transport error');
});

// ── arm 3: discard a finished image the pre-check later rejects ────────────────

timed('an image that came back BEFORE the verdict is discarded, not displayed', async () => {
  // The narrow race: generation finishes first, the pre-check lands after. The
  // 200 is already in hand and it would be very easy to just show it.
  const d = deferred();
  const h = harness({ validationPromise: d.promise, validationResult: null });
  const p = h.pipeline.processWithAI(h.file());
  await tick();
  const resp = response({ body: OK_BODY });
  h.settleFetch(resp);
  await tick();
  d.resolve({ valid: false, code: 'FLOOR_PLAN', reason: 'That is a floor plan.' });

  await assert.rejects(p, (e) => e.code === 'NOT_STAGEABLE' && /floor plan/.test(e.message));
  assert.equal(resp.jsonCalls, 0, 'the staged image must never even be read out of the response');
  assert.equal(h.calls.lastEmptyRoomUrl, undefined, 'nor its empty-room URL published');
});

timed('a verdict that lands late and PASSES lets the image through', async () => {
  const d = deferred();
  const h = harness({ validationPromise: d.promise, validationResult: null });
  const p = h.pipeline.processWithAI(h.file());
  await tick();
  h.settleFetch(response({ body: OK_BODY }));
  await tick();
  d.resolve({ valid: true, reason: '' });
  assert.deepEqual(await p, OK_BODY.images);
});

// ── the request body ───────────────────────────────────────────────────────────

timed('the multipart body carries the room, style, prompt and identity fields', async () => {
  const h = harness();
  await run(h, response({ body: OK_BODY }));
  const fd = h.form();
  assert.equal(fd.get('roomType'), 'Bedroom');
  assert.equal(fd.get('furnitureStyle'), 'modern');
  assert.equal(fd.get('additionalPrompt'), 'add a rug');
  assert.equal(fd.get('authToken'), 'tok-123');
  assert.equal(fd.get('userRole'), 'agent');
  assert.equal(/** @type {File} */ (fd.get('image')).name, 'room.jpg');
});

timed('keepFurniture is only sent when "remove existing furniture" is actually on', async () => {
  // Both halves matter: the text without the flag contradicts the server prompt,
  // and the flag without the text loses what the user asked to keep.
  const off = harness({ removeFurniture: false, keepFurniture: 'the grand piano' });
  await run(off, response({ body: OK_BODY }));
  assert.equal(off.form().get('removeFurniture'), 'false');
  assert.equal(off.form().get('keepFurniture'), '', 'stale keep-list leaked while the gate was off');

  const on = harness({ removeFurniture: true, keepFurniture: '  the grand piano  ' });
  await run(on, response({ body: OK_BODY }));
  assert.equal(on.form().get('removeFurniture'), 'true');
  assert.equal(on.form().get('keepFurniture'), 'the grand piano', 'trimmed and sent');
});

const refFiles = (n) => Array.from({ length: n }, (_, i) => new File(['x'], `ref${i}.png`, { type: 'image/png' }));

timed('furniture references and model choice are pro-only', async () => {
  const free = harness({ pro: false, furnitureFiles: refFiles(2) });
  await run(free, response({ body: OK_BODY }));
  assert.equal(free.form().getAll('furnitureImage').length, 0, 'free plan must not upload reference photos');
  assert.equal(free.form().get('model'), null);
  assert.equal(free.form().get('variationCount'), null);

  const paid = harness({ pro: true, furnitureFiles: refFiles(2) });
  await run(paid, response({ body: OK_BODY }));
  assert.equal(paid.form().getAll('furnitureImage').length, 2);
  assert.equal(paid.form().get('model'), 'gpt-image-1');
  assert.equal(paid.form().get('variationCount'), '2');
});

timed('a pro panel that is not on screen contributes nothing, however it is hidden', async () => {
  // Three ways the panel can be down. All of them mean "the user cannot see these
  // controls", so none of them may contribute their stale values to the request.
  for (const proPanel of /** @type {const} */ (['hidden-class', 'display-none', 'absent'])) {
    const h = harness({ pro: true, proPanel, furnitureFiles: refFiles(2) });
    await run(h, response({ body: OK_BODY }));
    assert.equal(h.form().getAll('furnitureImage').length, 0, `panel ${proPanel} leaked reference photos`);
    assert.equal(h.form().get('model'), null, `panel ${proPanel} leaked a model choice`);
  }
});

timed('FURNITURE_LIMIT caps how many reference photos are uploaded', async () => {
  const h = harness({ pro: true, furnitureFiles: refFiles(9) });
  await run(h, response({ body: OK_BODY }));
  const names = h.form().getAll('furnitureImage').map((f) => /** @type {File} */ (f).name);
  assert.deepEqual(names, ['ref0.png', 'ref1.png', 'ref2.png'], 'capped at FURNITURE_LIMIT, keeping the first');
});

// ── server errors map to codes the caller branches on ─────────────────────────

timed('a daily-limit refusal is coded and shown in the viewer, not thrown bare', async () => {
  for (const resp of [
    response({ ok: false, status: 403, body: { code: 'DAILY_LIMIT', error: 'out of renders' } }),
    response({ ok: false, status: 429, body: { error: 'out of renders' } }), // status alone, no code
  ]) {
    const h = harness();
    await assert.rejects(run(h, resp), (e) => e.code === 'DAILY_LIMIT');
    assert.deepEqual(h.calls.showStagingLimitInViewer, ['limit: out of renders']);
  }
});

timed('an auth refusal is coded AUTH_REQUIRED so the caller can open the sign-in modal', async () => {
  const h = harness();
  await assert.rejects(
    run(h, response({ ok: false, status: 401, body: { code: 'AUTH_REQUIRED', error: 'Please sign in.' } })),
    (e) => e.code === 'AUTH_REQUIRED' && e.message === 'Please sign in.',
  );
  assert.deepEqual(h.calls.showStagingLimitInViewer, [], 'not a limit — must not show the upgrade banner');
});

timed('a 422 / NO_IMAGE_GENERATED explains itself instead of failing silently', async () => {
  const h = harness();
  await assert.rejects(
    run(h, response({ ok: false, status: 422, body: { code: 'NO_IMAGE_GENERATED', error: 'Try another photo.' } })),
    (e) => e.code === 'NO_IMAGE_GENERATED',
  );
  assert.deepEqual(h.calls.showStagingError, ['Try another photo.']);
});

timed('an unmapped server error still throws with a message and clears the spinner', async () => {
  const h = harness();
  await assert.rejects(
    run(h, response({ ok: false, status: 503, body: { message: 'upstream is down' } })),
    (e) => e.message === 'upstream is down' && e.code === undefined,
  );
  assert.equal(h.dom.stagePreview.classList.has('processing'), false);
});

timed('an error body that is not JSON does not become an unhandled rejection', async () => {
  const h = harness();
  const resp = response({ ok: false, status: 500 });
  resp.json = async () => { throw new SyntaxError('Unexpected token <'); };
  await assert.rejects(run(h, resp), (e) => e instanceof Error && e.message.length > 0);
});

// ── the success path ───────────────────────────────────────────────────────────

timed('a single-image response is normalised to a one-element list', async () => {
  const h = harness();
  const urls = await run(h, response({ body: { success: true, image: 'https://cdn/one.png' } }));
  assert.deepEqual(urls, ['https://cdn/one.png']);
});

timed('the empty-room URL is published on success and cleared when absent', async () => {
  const withEmpty = harness();
  await run(withEmpty, response({ body: OK_BODY }));
  assert.equal(withEmpty.calls.lastEmptyRoomUrl, 'https://cdn/empty.png');

  const without = harness();
  await run(without, response({ body: { success: true, images: ['https://cdn/a.png'] } }));
  assert.equal(without.calls.lastEmptyRoomUrl, null, 'a stale empty room from the previous run must be cleared');
});

timed('a 200 with success:false but no images is an error, not an empty gallery', async () => {
  const h = harness();
  await assert.rejects(run(h, response({ body: { success: true, images: [] } })), /No image data/);
});

timed('a refreshed user record on the response is pushed back into the auth UI', async () => {
  // This is how the remaining-renders counter updates after a generation.
  const h = harness();
  await run(h, response({ body: { ...OK_BODY, user: { id: 'u1', rendersLeft: 4 } } }));
  assert.deepEqual(globalThis.window.StagifyAuth.user, { id: 'u1', rendersLeft: 4 });
  assert.equal(globalThis.window.StagifyAuth.appliedToUI, true);
});

timed('the success path leaves no spinner behind', async () => {
  const h = harness();
  await run(h, response({ body: OK_BODY }));
  assert.equal(h.dom.stagePreview.classList.has('processing'), false);
  assert.equal(h.dom.loadingMessage.classList.has('hidden'), true);
});

// ── the wait: a render that never comes back ─────────────────────────────────
//
// There was no client timeout and no server-side one either, so a hung provider
// left the progress bar frozen at 70% for as long as the socket stayed open, with
// nothing to click. The guides' answer was "refresh after a minute", which throws
// away renders that are still legitimately running — a Stagify+ job is several
// variations, each of which may retry for quality.
//
// Three aborts reach the same catch and MUST NOT be reported alike: a photo the
// pre-check refused, the ceiling, and the user pressing Cancel.

timed('a request that passes the ceiling is stopped and explained, not left spinning', async () => {
  const h = harness({ stagingTimeoutMs: 5 });
  const p = h.pipeline.processWithAI(h.file());
  await assert.rejects(p, (err) => {
    assert.equal(err.code, 'STAGING_TIMEOUT');
    return true;
  });
  assert.equal(h.calls.showStagingError.length, 1, 'the user is told why it stopped');
  assert.match(h.calls.showStagingError[0], /longer than usual/i);
  assert.equal(h.dom.stagePreview.classList.has('processing'), false, 'the spinner is torn down');
  assert.equal(h.dom.progress.classList.has('hidden'), true);
});

timed('pressing Cancel stops the request without painting an error', async () => {
  const h = harness();
  const p = h.pipeline.processWithAI(h.file());
  await tick();
  assert.equal(h.cancelBtn.classList.has('hidden'), false, 'the way out is offered while waiting');

  h.cancelBtn.click();
  await assert.rejects(p, (err) => {
    assert.equal(err.code, 'STAGING_CANCELLED');
    // Marked surfaced so the caller does not stack an error banner on top of
    // something the user deliberately did.
    assert.equal(err.stagingMessageShown, true);
    return true;
  });
  assert.deepEqual(h.calls.showStagingError, [], 'a deliberate cancel is not a failure');
  assert.equal(h.cancelBtn.classList.has('hidden'), true, 'the button goes away with the wait');
});

timed('a completed render clears the timeout and hides Cancel', async () => {
  // The ceiling must not survive the request that armed it — a leaked timer would
  // abort the NEXT render, and a leftover Cancel button would do nothing.
  //
  // Asserted by watching clearTimeout rather than by waiting for a short ceiling to
  // not fire: that would be a race between the timer and the fetch settling.
  const h = harness();
  const urls = await run(h, response({ body: OK_BODY }));

  assert.equal(urls.length, 2, 'the render still delivers normally');
  assert.ok(h.calls.timeoutIds.length >= 1, 'a ceiling is armed for the request');
  const leaked = h.calls.timeoutIds.filter((id) => !h.calls.clearedTimeouts.includes(id));
  assert.deepEqual(leaked, [], 'every staging ceiling must be cleared once the response is in');
  assert.equal(h.cancelBtn.classList.has('hidden'), true);
  assert.deepEqual(h.calls.showStagingError, []);
});

timed('a pre-check rejection still wins over the timeout wording', async () => {
  // Both abort the same fetch. The photo-specific reason is the useful one.
  const v = deferred();
  const h = harness({ validationPromise: v.promise, stagingTimeoutMs: 180000 });
  const p = h.pipeline.processWithAI(h.file());
  await tick();
  v.resolve({ valid: false, code: 'ANIMAL', reason: 'This looks like a pet.' });
  await assert.rejects(p, (err) => {
    assert.equal(err.code, 'NOT_STAGEABLE');
    return true;
  });
  assert.equal(h.calls.showStagingError.length, 1);
  assert.match(h.calls.showStagingError[0], /pet/i);
});

// ── arm: "Label as virtually staged" ─────────────────────────────────────────
//
// The disclosure option is the only staging control that is available on every plan, so
// the thing worth pinning is that it is sent by a FREE account. The pro-only fields are
// appended inside an `isProUser() && proPanelUsable` block a few lines below these two
// appends; sliding them in there is the easy mistake, and it would break nothing visible
// — the server would simply stop stamping for everyone who is not paying.

test('label: a FREE account sends the disclosure flag (it is not gated with the pro fields)', async () => {
  const h = harness({ pro: false, proPanel: 'absent', labelVirtuallyStaged: true });
  await run(h, response({ body: OK_BODY }));
  assert.equal(h.form().get('labelVirtuallyStaged'), 'true');
  assert.equal(h.form().get('model'), null, 'sanity: the pro-only fields really were skipped');
});

test('label: the checkbox state is sent verbatim as "true"/"false"', async () => {
  const on = harness({ labelVirtuallyStaged: true });
  await run(on, response({ body: OK_BODY }));
  assert.equal(on.form().get('labelVirtuallyStaged'), 'true');

  const off = harness({ labelVirtuallyStaged: false });
  await run(off, response({ body: OK_BODY }));
  assert.equal(off.form().get('labelVirtuallyStaged'), 'false',
    'sent explicitly rather than omitted — the server default must never be the source of truth');
});

test('label: the UI language rides along, defaulting to English when unset', async () => {
  const withLang = harness({ labelVirtuallyStaged: true, selectedLanguage: 'japanese' });
  await run(withLang, response({ body: OK_BODY }));
  assert.equal(withLang.form().get('stampLang'), 'japanese');

  const noLang = harness({ labelVirtuallyStaged: true, selectedLanguage: null });
  await run(noLang, response({ body: OK_BODY }));
  assert.equal(noLang.form().get('stampLang'), 'english', 'a browser that never picked a language');
});

test('label: the chosen style and size ride along with the flag', async () => {
  const h = harness({ labelVirtuallyStaged: true, stampStyle: 'minimal', stampScale: '1.4' });
  await run(h, response({ body: OK_BODY }));
  assert.equal(h.form().get('stampStyle'), 'minimal');
  assert.equal(h.form().get('stampScale'), '1.4');
});

test('label: style and size are sent even with the option OFF', async () => {
  // Deliberate, and the opposite of keepFurniture (which IS gated on its checkbox). These
  // two are inert server-side unless the flag is set, so gating them here would buy nothing
  // and cost the one thing that matters: the values would then depend on whether the strip
  // happened to be visible when the user pressed the button, rather than on what they picked.
  const h = harness({ labelVirtuallyStaged: false, stampStyle: 'light', stampScale: '0.8' });
  await run(h, response({ body: OK_BODY }));
  assert.equal(h.form().get('labelVirtuallyStaged'), 'false');
  assert.equal(h.form().get('stampStyle'), 'light');
  assert.equal(h.form().get('stampScale'), '0.8');
});

test('label: a page without the style strip still posts usable defaults', async () => {
  // The studios that reuse this pipeline do not render the strip, and neither does the
  // modal before app.js wires it. A bare read there would post `undefined`/`NaN`, which the
  // server would have to guess at — so the reader falls back instead.
  const h = harness({ labelVirtuallyStaged: true, stampStyle: null, stampScale: null });
  await run(h, response({ body: OK_BODY }));
  assert.equal(h.form().get('stampStyle'), 'dark');
  assert.equal(h.form().get('stampScale'), '1');
});

test('label: a missing checkbox element does not break staging', async () => {
  // The pipeline reads the box straight out of the DOM with getElementById, which returns
  // null on any page that mounts this module without the staging modal markup. A bare
  // `.checked` read there would throw and take the whole render down.
  const h = harness({ labelCheckboxPresent: false });
  await run(h, response({ body: OK_BODY }));
  assert.equal(h.form().get('labelVirtuallyStaged'), 'false', 'absent box reads as unticked');
});

test('label: DISCLOSURE_STAMP_FAILED surfaces its own message, not "Bad prompt inputted"', async () => {
  // It arrives as a 500, and the generic 500 branch rewrites every message to
  // errors.badPrompt — which would send the user off to rewrite a prompt that was never
  // the problem. The coded branch has to win.
  const h = harness({ labelVirtuallyStaged: true });
  const err = await run(h, response({
    ok: false,
    status: 500,
    body: { code: 'DISCLOSURE_STAMP_FAILED', error: 'We couldn\'t add the "virtually staged" label, so your image wasn\'t delivered.' },
  })).then(() => null, (e) => e);

  assert.ok(err, 'the render rejects rather than resolving with an unlabelled image');
  assert.equal(err.code, 'DISCLOSURE_STAMP_FAILED');
  assert.equal(h.calls.showStagingError.length, 1, 'the user is told, once');
  assert.match(h.calls.showStagingError[0], /virtually staged/i);
  assert.doesNotMatch(h.calls.showStagingError[0], /Bad prompt/i);
});
