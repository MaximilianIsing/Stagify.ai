// The Masking Studio's save handler (lib/staging/masking-save-handler.js).
//
// This is the only gallery writer that does not generate anything — the composite is made in
// the browser and posted back — so the tests that matter are about the one decision it makes
// on arrival: whether the payload is safe to touch at all. Every save inserts; the replace
// path went with the "Refine in Masking Studio" hand-off that used to feed it a renderId.
//
// The absence of METERING is asserted rather than assumed. The generations this image is
// made of were already billed at /api/mask-edit, and the block that looks copyable sits two
// files away in exterior-handler.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMaskingSaveHandler, areasQualifier } from '../../lib/staging/masking-save-handler.js';

const PRO = { id: 'u_pro', email: 'pro@x.com', plan: 'pro' };
const IMG = 'data:image/jpeg;base64,' + Buffer.from('composited-pixels').toString('base64');
const SRC = 'data:image/jpeg;base64,' + Buffer.from('original-pixels').toString('base64');

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function makeHandler(over = {}) {
  const seen = { recorded: [], uploaded: [] };
  const renderPersistence = {
    enabled: () => over.enabled !== false,
    recordPending: (arg) => {
      seen.recorded.push(arg);
      return { entries: [{ id: 'r_new', native: arg.natives[0].buffer }], evicted: over.evicted ?? [] };
    },
    uploadInBackground: async (arg) => { seen.uploaded.push(arg); return { ok: 1, failed: 0 }; },
    ...over.persistence,
  };
  const { handleMaskingSave } = createMaskingSaveHandler({ renderPersistence });
  return { handleMaskingSave, seen };
}

const req = (body) => ({ body });

// ── the qualifier that names the entry ───────────────────────────────────────

test('the areas qualifier is pluralized here, where the count actually is', () => {
  // public/scripts/render-name.js is shared with the public share page, which loads no
  // language pack and has no plural machinery — so the string is built server-side.
  assert.equal(areasQualifier(1), '1 area');
  assert.equal(areasQualifier(3), '3 areas');
});

test('a nonsense area count still yields a sane name', () => {
  assert.equal(areasQualifier(0), '1 area');
  assert.equal(areasQualifier(-5), '1 area');
  assert.equal(areasQualifier(999), '6 areas', 'clamped to the palette size');
  assert.equal(areasQualifier(/** @type {any} */ ('lots')), '1 area');
  assert.equal(areasQualifier(/** @type {any} */ (undefined)), '1 area');
});

// ── validation ───────────────────────────────────────────────────────────────

test('a body with no composited image is a 400, not a 500', () => {
  // `'x'.split(',')[1]` is undefined and Buffer.from(undefined) throws — which the route
  // wrapper would turn into a 500 with an error ref and a reported production incident.
  for (const after of [undefined, '', 'not-a-data-url', 'data:image/png;base64,', 'data:text/plain;base64,QQ==']) {
    const { handleMaskingSave } = makeHandler();
    const res = fakeRes();
    handleMaskingSave(/** @type {any} */ (req({ after })), /** @type {any} */ (res), PRO);
    assert.equal(res.statusCode, 400, `${after} should be refused`);
  }
});

test('a malformed "before" costs the slider, not the save', async () => {
  const { handleMaskingSave, seen } = makeHandler();
  const res = fakeRes();
  await handleMaskingSave(/** @type {any} */ (req({ after: IMG, before: 'garbage' })), /** @type {any} */ (res), PRO);
  assert.equal(res.body.success, true);
  assert.equal(seen.uploaded[0].sourceBuffer, null, 'the entry lands with no before photo');
});

test('an oversized composite is refused before anything is stored', async () => {
  const huge = 'data:image/jpeg;base64,' + Buffer.alloc(9 * 1024 * 1024).toString('base64');
  const { handleMaskingSave, seen } = makeHandler();
  const res = fakeRes();
  await handleMaskingSave(/** @type {any} */ (req({ after: huge })), /** @type {any} */ (res), PRO);
  assert.equal(res.statusCode, 413);
  assert.equal(seen.recorded.length, 0);
});

// ── insert ───────────────────────────────────────────────────────────────────

test('a photo from disk becomes a new entry named after the studio', async () => {
  const { handleMaskingSave, seen } = makeHandler();
  const res = fakeRes();
  await handleMaskingSave(
    /** @type {any} */ (req({ after: IMG, before: SRC, areas: 3, prompts: ['a sofa', 'a rug'], sourceName: 'elm-st.jpg' })),
    /** @type {any} */ (res),
    PRO,
  );
  assert.equal(res.body.success, true);
  assert.deepEqual(res.body.gallery.ids, ['r_new']);
  assert.deepEqual(seen.recorded[0].extra, {
    source: 'masking',
    qualifier: '3 areas',
    sourceName: 'elm-st.jpg',
  });
  assert.equal(seen.recorded[0].isPro, true, 'this route is Pro-only by construction');
  assert.equal(seen.recorded[0].params.roomType, '', 'the studio never asks for one');
  assert.equal(seen.recorded[0].params.additionalPrompt, 'a sofa; a rug');
  assert.equal(seen.uploaded[0].sourceBuffer.toString(), 'original-pixels');
  assert.deepEqual(seen.uploaded[0].refUploads, [], 'furniture references are deferred');
});

test('the joined prompts are clamped, so one long area cannot fill the column', async () => {
  const { handleMaskingSave, seen } = makeHandler();
  await handleMaskingSave(
    /** @type {any} */ (req({ after: IMG, prompts: ['x'.repeat(900)] })),
    /** @type {any} */ (fakeRes()),
    PRO,
  );
  assert.equal(seen.recorded[0].params.additionalPrompt.length, 500);
});

test('a non-array prompts field is ignored rather than crashing', async () => {
  const { handleMaskingSave, seen } = makeHandler();
  await handleMaskingSave(
    /** @type {any} */ (req({ after: IMG, prompts: 'a sofa' })),
    /** @type {any} */ (fakeRes()),
    PRO,
  );
  assert.equal(seen.recorded[0].params.additionalPrompt, '');
});

// ── posture ──────────────────────────────────────────────────────────────────

test('NOTHING is metered here — the generations were already billed at /api/mask-edit', () => {
  // A source-level guard as well as a behavioural one: the handler is constructed with no
  // metering deps at all, so copying the block from exterior-handler.js would not even run.
  const { handleMaskingSave } = createMaskingSaveHandler({ renderPersistence: null });
  assert.equal(typeof handleMaskingSave, 'function');
});

test('with the gallery off it answers 200, because there is nothing to save into', async () => {
  const { handleMaskingSave, seen } = makeHandler({ enabled: false });
  const res = fakeRes();
  await handleMaskingSave(/** @type {any} */ (req({ after: IMG })), /** @type {any} */ (res), PRO);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, gallery: null });
  assert.equal(seen.recorded.length, 0);
});

test('an eviction that broke a share link is reported back to the client', async () => {
  const { handleMaskingSave } = makeHandler({ evicted: [{ id: 'old', hadLiveShare: true }] });
  const res = fakeRes();
  await handleMaskingSave(/** @type {any} */ (req({ after: IMG })), /** @type {any} */ (res), PRO);
  assert.deepEqual(res.body.gallery.evicted, [{ id: 'old', hadLiveShare: true }]);
});

test('a store failure is a 500 with no partial success claimed', async () => {
  const { handleMaskingSave } = makeHandler({
    persistence: { recordPending: () => { throw new Error('sqlite is on fire'); } },
  });
  const res = fakeRes();
  await handleMaskingSave(/** @type {any} */ (req({ after: IMG })), /** @type {any} */ (res), PRO);
  assert.equal(res.statusCode, 500);
});
