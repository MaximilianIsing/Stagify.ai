// Tier: frontend island logic (DOM-stubbed) — public/scripts/app/image-file.js.
//
// The three gates every uploaded room photo passes before anything tries to draw
// it: HEIC/HEIF conversion, a decodable-type allowlist, and the 100MB ceiling.
// They were inline in app.js's handleStageFile and had exactly one caller; the
// standalone Basic Mask uploader is the second, so they moved here rather than
// being copied.
//
// The rule is a pure function on (type, size) so the allowlist can be pinned
// without a File, a FileReader or a DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { fileRejection, readImageFile, MAX_IMAGE_BYTES } = await import(
  '../../../public/scripts/app/image-file.js'
);

// ---- The pure rule ---------------------------------------------------------

test('fileRejection accepts every type the canvas can decode', () => {
  for (const type of ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']) {
    assert.equal(fileRejection(type, 1024), null, type);
  }
});

test('fileRejection rejects types the browser cannot draw', () => {
  // image/heic is deliberately in this list: by the time the gate runs, a HEIC
  // has already been converted to JPEG, so one arriving here is a conversion
  // that silently did nothing — not a file to wave through.
  for (const type of ['image/heic', 'image/heif', 'image/svg+xml', 'application/pdf', 'text/plain', '']) {
    assert.equal(fileRejection(type, 1024), 'fileType', type);
  }
});

test('fileRejection is case-insensitive about the type', () => {
  assert.equal(fileRejection('IMAGE/PNG', 1024), null);
});

test('fileRejection treats a missing type as unusable rather than fine', () => {
  for (const type of [undefined, null]) {
    assert.equal(fileRejection(/** @type {any} */ (type), 1024), 'fileType');
  }
});

test('fileRejection reports the size only for an otherwise-valid file', () => {
  // Order matters for the message: a 200MB PDF is a wrong-type problem, and
  // telling the user to shrink it would send them down a pointless path.
  assert.equal(fileRejection('application/pdf', MAX_IMAGE_BYTES + 1), 'fileType');
  assert.equal(fileRejection('image/png', MAX_IMAGE_BYTES + 1), 'fileTooLarge');
});

test('fileRejection puts the boundary exactly at 100MB inclusive', () => {
  assert.equal(MAX_IMAGE_BYTES, 100 * 1024 * 1024);
  assert.equal(fileRejection('image/png', MAX_IMAGE_BYTES), null, 'exactly at the cap is allowed');
  assert.equal(fileRejection('image/png', MAX_IMAGE_BYTES + 1), 'fileTooLarge');
});

// ---- The async wrapper -----------------------------------------------------

function fakeFile(type, size = 1024, name = 'room.png') {
  return /** @type {any} */ ({ type, size, name });
}

/** @param {{ heic?: any, texts?: Record<string,string>, readFails?: boolean }} opts */
function mount({ heic, texts, readFails = false } = {}) {
  globalThis.window = /** @type {any} */ ({
    StagifyHeic: heic,
    LanguageSystem: texts ? { getText: (k) => texts[k] } : undefined,
  });
  globalThis.FileReader = /** @type {any} */ (class {
    readAsDataURL(file) {
      if (readFails) {
        this.error = new Error('boom');
        queueMicrotask(() => this.onerror());
        return;
      }
      this.result = `data:${file.type};base64,AAAA`;
      queueMicrotask(() => this.onload());
    }
  });
  const errors = [];
  return { errors, showError: (m) => errors.push(m) };
}

test('readImageFile returns the file and its data URL when everything is fine', async () => {
  const { errors, showError } = mount();
  const out = await readImageFile(fakeFile('image/png'), { showError });
  assert.equal(out.dataUrl, 'data:image/png;base64,AAAA');
  assert.equal(out.file.name, 'room.png');
  assert.deepEqual(errors, []);
});

test('readImageFile resolves null and reports, rather than throwing, on a bad type', async () => {
  // Callers bail on a falsy result; a rejection here would surface as an
  // unhandled promise on a perfectly ordinary user mistake.
  const { errors, showError } = mount({ texts: { 'errors.fileType': 'Nope, wrong type' } });
  assert.equal(await readImageFile(fakeFile('application/pdf'), { showError }), null);
  assert.deepEqual(errors, ['Nope, wrong type']);
});

test('readImageFile reports the size ceiling with the localized message', async () => {
  const { errors, showError } = mount({ texts: { 'errors.fileTooLarge': 'Zu groß' } });
  assert.equal(await readImageFile(fakeFile('image/png', MAX_IMAGE_BYTES + 1), { showError }), null);
  assert.deepEqual(errors, ['Zu groß']);
});

test('readImageFile falls back to English before the language pack loads', async () => {
  const { errors, showError } = mount();
  await readImageFile(fakeFile('application/pdf'), { showError });
  assert.match(errors[0], /PNG, JPG/);
});

test('readImageFile converts a HEIC and validates the CONVERTED file', async () => {
  // The gate has to run on the output, not the input: a converter that returned
  // the original untouched would otherwise sail through on the input's identity.
  const converted = fakeFile('image/jpeg', 2048, 'room.jpg');
  const { errors, showError } = mount({
    heic: { isHeic: () => true, toDisplayableFile: async () => converted },
  });
  const out = await readImageFile(fakeFile('image/heic'), { showError });
  assert.equal(out.file, converted);
  assert.equal(out.dataUrl, 'data:image/jpeg;base64,AAAA');
  assert.deepEqual(errors, []);
});

test('readImageFile rejects when the HEIC converter hands back an undecodable file', async () => {
  const { errors, showError } = mount({
    heic: { isHeic: () => true, toDisplayableFile: async (f) => f },
    texts: { 'errors.fileType': 'wrong type' },
  });
  assert.equal(await readImageFile(fakeFile('image/heic'), { showError }), null);
  assert.deepEqual(errors, ['wrong type']);
});

test('readImageFile reports a failed HEIC conversion and stops', async () => {
  const { errors, showError } = mount({
    heic: { isHeic: () => true, toDisplayableFile: async () => { throw new Error('nope'); } },
    texts: { 'errors.heicConvert': 'HEIC failed' },
  });
  assert.equal(await readImageFile(fakeFile('image/heic'), { showError }), null);
  assert.deepEqual(errors, ['HEIC failed']);
});

test('readImageFile leaves a non-HEIC file alone even when the converter exists', async () => {
  let called = false;
  const { showError } = mount({
    heic: { isHeic: () => false, toDisplayableFile: async () => { called = true; } },
  });
  await readImageFile(fakeFile('image/png'), { showError });
  assert.equal(called, false);
});

test('readImageFile rejects when the file genuinely cannot be read', async () => {
  // Distinct from a bad file: this is a real fault, so it propagates rather than
  // resolving null and being read as "the user picked something silly".
  const { showError } = mount({ readFails: true });
  await assert.rejects(() => readImageFile(fakeFile('image/png'), { showError }));
});
