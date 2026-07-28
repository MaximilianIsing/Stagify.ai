// Tier: frontend island logic (Image/canvas/fetch-shimmed) — public/scripts/app/stage-validation.js.
//
// This asks /api/validate-image whether an upload is a stageable space. It is the
// only gate between a user and a wasted generation, and its governing rule is that
// it FAILS OPEN: every way it can go wrong — a dead network, a 500, a truncated
// body, an undecodable image — must resolve `{ valid: true }`, never reject and
// never block. A fail-CLOSED regression here is the worst outcome this module has:
// every upload is refused as "not a room" and the product simply stops working,
// with no error in the console because the promise resolved just fine.
//
// The second property is that the promise ALWAYS SETTLES. The caller stores it and
// later awaits it inside the staging pipeline (getStageValidation), which has no
// timeout of its own; a path that forgets to resolve hangs the staging button
// forever rather than failing.
//
// The third is the downscale. The body is JSON, and a modern phone photo as a raw
// data URL is tens of megabytes; 512px matches the server's low-detail vision tile,
// so anything larger is downsampled away server-side anyway. Sending the original
// is invisible locally and only shows up as slow uploads and token spend.
//
// Image/canvas/fetch are shimmed per-test; there is no jsdom (house style).

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { validateStageableUpload } from '../../../public/scripts/app/stage-validation.js';

/** A settle-or-fail wrapper: a promise this module leaves pending is a bug, not a hang. */
const settles = (p, ms = 2000) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error('validateStageableUpload never settled')), ms)),
]);

const REAL = {
  Image: globalThis.Image,
  document: globalThis.document,
  window: globalThis.window,
  fetch: globalThis.fetch,
};
afterEach(() => { Object.assign(globalThis, REAL); });

/**
 * @param {{
 *   decode?: boolean, imgWidth?: number, imgHeight?: number,
 *   canvas?: 'ok' | 'throws',
 *   token?: string | null,
 *   respond?: (req: { url: string, init: any }) => any,
 * }} opts
 */
function shim({
  decode = true,
  imgWidth = 4032,
  imgHeight = 3024,
  canvas = 'ok',
  token = 'tok-123',
  respond = () => ({ ok: true, json: async () => ({ valid: true, reason: '' }) }),
} = {}) {
  const calls = { fetch: [], drawn: [], encoded: [] };

  globalThis.Image = class {
    constructor() { this.width = imgWidth; this.height = imgHeight; }
    set src(_v) {
      queueMicrotask(() => { if (decode) this.onload?.(); else this.onerror?.(); });
    }
  };

  globalThis.document = {
    createElement: (tag) => {
      assert.equal(tag, 'canvas');
      const c = { width: 0, height: 0 };
      c.getContext = () => {
        if (canvas === 'throws') throw new Error('canvas unavailable');
        return { drawImage: (_img, x, y, w, h) => calls.drawn.push({ x, y, w, h }) };
      };
      c.toDataURL = (type, quality) => {
        calls.encoded.push({ type, quality, width: c.width, height: c.height });
        return `data:${type};base64,DOWNSCALED`;
      };
      return c;
    },
  };

  globalThis.window = { StagifyAuth: token === null ? null : { getToken: () => token } };

  globalThis.fetch = async (url, init) => {
    calls.fetch.push({ url, init, body: JSON.parse(init.body) });
    const r = respond({ url, init });
    if (r instanceof Error) throw r;
    return r;
  };

  return calls;
}

const DATA_URL = 'data:image/jpeg;base64,ORIGINAL';

// ── fail open, always ──────────────────────────────────────────────────────────

test('an image the browser cannot decode does not block the upload', async () => {
  shim({ decode: false });
  assert.deepEqual(await settles(validateStageableUpload(DATA_URL)), { valid: true, reason: '' });
});

test('a network failure does not block the upload', async () => {
  shim({ respond: () => new TypeError('Failed to fetch') });
  assert.deepEqual(await settles(validateStageableUpload(DATA_URL)), { valid: true, reason: '' });
});

test('a non-2xx response does not block the upload', async () => {
  for (const status of [401, 429, 500, 503]) {
    shim({ respond: () => ({ ok: false, status, json: async () => ({ valid: false, reason: 'nope' }) }) });
    assert.deepEqual(
      await settles(validateStageableUpload(DATA_URL)),
      { valid: true, reason: '' },
      `HTTP ${status} must not be read as a rejection`,
    );
  }
});

test('a body that is not JSON does not block the upload', async () => {
  shim({ respond: () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } }) });
  assert.deepEqual(await settles(validateStageableUpload(DATA_URL)), { valid: true, reason: '' });
});

test('a body missing the `valid` boolean does not block the upload', async () => {
  // A shape change on the server, or an older cached bundle: `valid` absent, or
  // present but a string. Trusting either would reject every photo.
  for (const body of [null, {}, { reason: 'nope' }, { valid: 'false' }, { valid: 0 }]) {
    shim({ respond: () => ({ ok: true, json: async () => body }) });
    assert.deepEqual(
      await settles(validateStageableUpload(DATA_URL)),
      { valid: true, reason: '' },
      `body ${JSON.stringify(body)} must not be read as a rejection`,
    );
  }
});

test('the promise never rejects, whatever happens', async () => {
  // The caller stores this promise and awaits it later inside the staging
  // pipeline; a rejection there surfaces as an unhandled rejection, not an error
  // message.
  const cases = [
    () => shim({ decode: false }),
    () => shim({ respond: () => new TypeError('Failed to fetch') }),
    () => shim({ respond: () => ({ ok: true, json: async () => { throw new Error('x'); } }) }),
    () => shim({ canvas: 'throws', respond: () => new Error('boom') }),
  ];
  for (const setup of cases) {
    setup();
    await assert.doesNotReject(() => settles(validateStageableUpload(DATA_URL)));
  }
});

// ── a real verdict is passed through untouched ────────────────────────────────

test('a genuine rejection reaches the caller with its code and reason intact', async () => {
  // The pipeline localizes by `code` and falls back to `reason`; dropping either
  // degrades the message to generic copy.
  const verdict = { valid: false, code: 'PERSON_PORTRAIT', reason: 'That looks like a selfie.' };
  shim({ respond: () => ({ ok: true, json: async () => verdict }) });
  assert.deepEqual(await settles(validateStageableUpload(DATA_URL)), verdict);
});

test('a genuine pass reaches the caller as valid', async () => {
  shim({ respond: () => ({ ok: true, json: async () => ({ valid: true, reason: '' }) }) });
  assert.deepEqual(await settles(validateStageableUpload(DATA_URL)), { valid: true, reason: '' });
});

// ── the downscale ──────────────────────────────────────────────────────────────

test('a phone-sized photo is downscaled to a 512px long edge before being posted', async () => {
  const calls = shim({ imgWidth: 4032, imgHeight: 3024 });
  await settles(validateStageableUpload(DATA_URL));

  assert.deepEqual(calls.encoded, [{ type: 'image/jpeg', quality: 0.9, width: 512, height: 384 }]);
  assert.deepEqual(calls.drawn, [{ x: 0, y: 0, w: 512, h: 384 }], 'the canvas must actually be painted');
  assert.equal(calls.fetch[0].body.image, 'data:image/jpeg;base64,DOWNSCALED',
    'the ORIGINAL data URL must not be what goes over the wire');
});

test('the long edge is whichever it is — portrait scales off the height', async () => {
  const calls = shim({ imgWidth: 3024, imgHeight: 4032 });
  await settles(validateStageableUpload(DATA_URL));
  assert.deepEqual(calls.encoded[0], { type: 'image/jpeg', quality: 0.9, width: 384, height: 512 });
});

test('an image already under 512px is not upscaled', async () => {
  const calls = shim({ imgWidth: 300, imgHeight: 200 });
  await settles(validateStageableUpload(DATA_URL));
  assert.deepEqual(calls.encoded[0], { type: 'image/jpeg', quality: 0.9, width: 300, height: 200 });
});

test('a sliver of an image still produces at least one pixel per side', async () => {
  // A 4000x1 panorama scales to 0.128px of height, and a 0-height canvas throws
  // in some browsers and encodes to nothing in others.
  const calls = shim({ imgWidth: 4000, imgHeight: 1 });
  await settles(validateStageableUpload(DATA_URL));
  assert.ok(calls.encoded[0].width >= 1 && calls.encoded[0].height >= 1, 'no zero-sized canvas');
});

test('a canvas that cannot be used falls back to the original rather than sending nothing', async () => {
  const calls = shim({ canvas: 'throws' });
  await settles(validateStageableUpload(DATA_URL));
  assert.equal(calls.fetch.length, 1, 'the check still runs');
  assert.equal(calls.fetch[0].body.image, DATA_URL);
});

// ── auth ───────────────────────────────────────────────────────────────────────

test('a signed-in user is identified in both the header and the body', async () => {
  const calls = shim({ token: 'tok-123' });
  await settles(validateStageableUpload(DATA_URL));
  const { init, body } = calls.fetch[0];
  assert.equal(calls.fetch[0].url, '/api/validate-image');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer tok-123');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(body.authToken, 'tok-123');
});

test('an anonymous visitor sends no Authorization header at all', async () => {
  // An `Authorization: Bearer undefined` is worse than none: it looks like a
  // malformed credential rather than an absent one.
  // null  -> the auth island never loaded on this page
  // ''    -> it loaded and reports "signed out"
  for (const [name, token] of [['no StagifyAuth', null], ['signed out', '']]) {
    const calls = shim({ token });
    await settles(validateStageableUpload(DATA_URL));
    const { init, body } = calls.fetch[0];
    assert.equal('Authorization' in init.headers, false, `${name} leaked a header`);
    assert.equal(body.authToken, undefined, `${name} leaked a body token`);
  }
});
