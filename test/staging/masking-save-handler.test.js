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
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createMaskingSaveHandler, areasQualifier } from '../../lib/staging/masking-save-handler.js';
import { createRenderPersistence } from '../../lib/staging/render-persistence.js';
import { createLocalObjectStore } from '../../lib/data/object-store-local.js';
import { createAuthStore } from '../../lib/data/auth-store.js';
import { createStagedRenders } from '../../lib/data/staged-renders.js';
import { createRenderRefs } from '../../lib/data/render-refs.js';
import { closeDb } from '../../lib/data/db.js';
import { STAGIFY_SOFTWARE_TAG } from '../../lib/image/output-metadata.js';

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

// ── "Label as virtually staged" ──────────────────────────────────────────────
// The badge is burned in HERE for the gallery copy, rather than by the client posting an
// already-stamped image, because this request is already carrying those bytes. The stored
// master is also the copy that outlives the session: it is what the owner re-downloads
// months later and what a share link serves, so an unlabelled one is the version that
// actually reaches a buyer.

/** A real image, since these cases run the real stamper. @returns {Promise<string>} */
async function realPhoto(w = 1200, h = 800) {
  const buf = await sharp({ create: { width: w, height: h, channels: 3, background: { r: 90, g: 110, b: 130 } } })
    .jpeg().toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

test('with the option OFF the stored bytes are exactly what was posted', async () => {
  // The baseline the two tests below are measured against. Without it, "stamped" could be
  // passing because the handler mangles every save the same way.
  const after = await realPhoto();
  const { handleMaskingSave, seen } = makeHandler();
  await handleMaskingSave(/** @type {any} */ (req({ after })), /** @type {any} */ (fakeRes()), PRO);
  assert.deepEqual(
    seen.recorded[0].natives[0].buffer,
    Buffer.from(after.split(',')[1], 'base64'),
    'untouched',
  );
});

test('with the option ON the gallery master is stamped before it is stored', async () => {
  const after = await realPhoto();
  const { handleMaskingSave, seen } = makeHandler();
  const res = fakeRes();
  await handleMaskingSave(
    /** @type {any} */ (req({ after, labelVirtuallyStaged: true, stampLang: 'english', stampStyle: 'dark', stampScale: 1 })),
    /** @type {any} */ (res),
    PRO,
  );
  assert.equal(res.body.success, true);

  const stored = seen.recorded[0].natives[0].buffer;
  assert.notDeepEqual(stored, Buffer.from(after.split(',')[1], 'base64'), 'something was drawn on');
  // Still the same photo at the same size — a badge, not a replacement.
  const meta = await sharp(stored).metadata();
  assert.equal(meta.width, 1200);
  assert.equal(meta.height, 800);
});

test('the BEFORE photo is never stamped — it is not virtually staged', async () => {
  // The one image in the pair that is honest by construction. Labelling it would be a false
  // claim, and it is the half a share page shows as the original room.
  const after = await realPhoto();
  const before = await realPhoto(800, 600);
  const { handleMaskingSave, seen } = makeHandler();
  await handleMaskingSave(
    /** @type {any} */ (req({ after, before, labelVirtuallyStaged: true, stampStyle: 'banner' })),
    /** @type {any} */ (fakeRes()),
    PRO,
  );
  assert.deepEqual(
    seen.uploaded[0].sourceBuffer,
    Buffer.from(before.split(',')[1], 'base64'),
    'the source photo goes to storage byte-for-byte',
  );
});

test('the style and size the user picked are the ones burned in', async () => {
  const after = await realPhoto();
  const store = async (body) => {
    const { handleMaskingSave, seen } = makeHandler();
    await handleMaskingSave(/** @type {any} */ (req({ after, labelVirtuallyStaged: true, ...body })), /** @type {any} */ (fakeRes()), PRO);
    return seen.recorded[0].natives[0].buffer;
  };
  const base = await store({ stampStyle: 'dark', stampScale: 1, stampLang: 'english' });
  assert.notDeepEqual(await store({ stampStyle: 'banner', stampScale: 1, stampLang: 'english' }), base);
  assert.notDeepEqual(await store({ stampStyle: 'dark', stampScale: 1.6, stampLang: 'english' }), base);
  assert.notDeepEqual(await store({ stampStyle: 'dark', stampScale: 1, stampLang: 'japanese' }), base);
});

test('junk style and language fall back rather than costing the user their save', async () => {
  // Same rule as every other path to this badge: a badge in the wrong style still
  // discloses, and no badge does not.
  const after = await realPhoto();
  const { handleMaskingSave, seen } = makeHandler();
  const res = fakeRes();
  await handleMaskingSave(
    /** @type {any} */ (req({ after, labelVirtuallyStaged: true, stampStyle: '../../lib', stampLang: 'klingon', stampScale: 'abc' })),
    /** @type {any} */ (res),
    PRO,
  );
  assert.equal(res.body.success, true);
  assert.notDeepEqual(seen.recorded[0].natives[0].buffer, Buffer.from(after.split(',')[1], 'base64'));
});

test('the flag survives the wire as a string, not just a boolean', async () => {
  // It arrives as JSON from this studio but as multipart text from /api/process-image, and
  // both go through the same readStampRequest.
  const after = await realPhoto();
  const { handleMaskingSave, seen } = makeHandler();
  await handleMaskingSave(/** @type {any} */ (req({ after, labelVirtuallyStaged: 'true' })), /** @type {any} */ (fakeRes()), PRO);
  assert.notDeepEqual(seen.recorded[0].natives[0].buffer, Buffer.from(after.split(',')[1], 'base64'));
});

test('a stamp failure saves NOTHING and says why', async () => {
  // FAILS CLOSED, like every other path to this badge. Storing the unlabelled composite
  // would put an undisclosed photo in the gallery under a request that asked for a
  // disclosure — and unlike a failed download, nothing on screen would ever say so.
  // The code is what lets the studio break its own silence about save failures.
  const { handleMaskingSave, seen } = makeHandler();
  const res = fakeRes();
  await handleMaskingSave(
    // Shaped like an image data URL; decodes to four bytes sharp cannot read.
    /** @type {any} */ (req({ after: 'data:image/png;base64,AAAA', labelVirtuallyStaged: true })),
    /** @type {any} */ (res),
    PRO,
  );
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, 'DISCLOSURE_STAMP_FAILED');
  assert.equal(seen.recorded.length, 0, 'nothing reached the store');
  assert.equal(seen.uploaded.length, 0, 'and nothing reached object storage');
});

test('the size ceiling is measured on what the CLIENT sent, before any stamping', async () => {
  // Stamping re-encodes to PNG, which is larger than the posted JPEG — so checking after
  // would reject saves that are perfectly legal, and checking only after would let a
  // hostile payload allocate its buffer first. The gate has to come first.
  const huge = 'data:image/jpeg;base64,' + Buffer.alloc(9 * 1024 * 1024).toString('base64');
  const { handleMaskingSave, seen } = makeHandler();
  const res = fakeRes();
  await handleMaskingSave(/** @type {any} */ (req({ after: huge, labelVirtuallyStaged: true })), /** @type {any} */ (res), PRO);
  assert.equal(res.statusCode, 413, 'the size refusal wins over the stamp attempt');
  assert.equal(seen.recorded.length, 0);
});

// ── invisible provenance metadata — inherited via render-persistence, no code here ──
// lib/staging/render-persistence.js's encode() tags the `after` role with Stagify EXIF/XMP
// whenever it runs, regardless of the visible badge. This handler makes no separate call for
// it, so these run the REAL renderPersistence (not the recording fake above) end-to-end, to
// prove the inheritance rather than just reading the code and assuming it.

const dirs = [];
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    try { closeDb(d); } catch { /* not open */ }
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ }
  }
});

function realHandler() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-masking-save-'));
  dirs.push(dir);
  const authStore = createAuthStore(dir);
  const stagedRenders = createStagedRenders(dir);
  const renderRefs = createRenderRefs(dir);
  const store = createLocalObjectStore({ baseDir: dir, secret: 's' });
  const renderPersistence = createRenderPersistence({ objectStore: store, stagedRenders, renderRefs });
  const start = authStore.startRegistration('masker@example.com', 'CorrectHorse9!');
  const { user } = authStore.completeRegistration('masker@example.com', start.code);
  const { handleMaskingSave } = createMaskingSaveHandler({ renderPersistence });
  return { handleMaskingSave, stagedRenders, store, user: { id: user.id, email: user.email, plan: 'pro' } };
}

async function afterBlobIsTagged(stagedRenders, store, renderId) {
  const blob = stagedRenders.blobsFor(renderId).find((b) => b.role === 'after');
  const meta = await sharp(await store.get(blob.storage_key)).metadata();
  return !!meta.exif?.toString('latin1').includes(STAGIFY_SOFTWARE_TAG);
}

test('the stored gallery master carries provenance metadata with the badge OFF', async () => {
  const { handleMaskingSave, stagedRenders, store, user } = realHandler();
  const after = await realPhoto();
  const res = fakeRes();
  await handleMaskingSave(/** @type {any} */ (req({ after })), /** @type {any} */ (res), user);
  assert.equal(res.body.success, true);
  assert.ok(
    await afterBlobIsTagged(stagedRenders, store, res.body.gallery.ids[0]),
    'metadata is inherited via render-persistence.encode(), independent of the visible badge',
  );
});

test('the stored gallery master carries provenance metadata with the badge ON', async () => {
  const { handleMaskingSave, stagedRenders, store, user } = realHandler();
  const after = await realPhoto();
  const res = fakeRes();
  await handleMaskingSave(
    /** @type {any} */ (req({ after, labelVirtuallyStaged: true, stampLang: 'english', stampStyle: 'dark', stampScale: 1 })),
    /** @type {any} */ (res),
    user,
  );
  assert.equal(res.body.success, true);
  assert.ok(await afterBlobIsTagged(stagedRenders, store, res.body.gallery.ids[0]));
});
