// POST /api/download-result — server-side resize + re-encode for the homepage staging
// tool's download button and resolution menu (public/scripts/app/download-menu.js).
//
// UNLIKE /api/stamp-image, this route is NOT Pro-gated: it backs the plain staging tool,
// which any signed-in session (free or Pro) can already use, so the one behavioral
// difference worth pinning here is that a FREE account succeeds. The other point of this
// file is that the output actually carries Stagify's invisible provenance metadata
// (lib/image/output-metadata.js) — the entire reason this route exists is that a browser
// canvas export never could.

import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { STAGIFY_SOFTWARE_TAG, DIGITAL_SOURCE_TYPE, DISCLOSURE_DESCRIPTIONS } from '../../lib/image/output-metadata.js';

// Set the ceiling before anything imports the limiter — it is a singleton built at import
// time from the env var. The production default is 60 per 15 minutes.
const RL_SNAPSHOT = process.env.RL_DOWNLOAD_RESULT;
process.env.RL_DOWNLOAD_RESULT = '3';

const { mountStaging } = await import('../helpers/staging-app.js');

after(() => {
  if (RL_SNAPSHOT === undefined) delete process.env.RL_DOWNLOAD_RESULT;
  else process.env.RL_DOWNLOAD_RESULT = RL_SNAPSHOT;
});

let app;
afterEach(async () => {
  if (app) { await app.close(); app = null; }
});

/** A free (non-Pro) signed-in session — the access level this route actually requires. */
const asFree = { getAuthUserFromRequest: () => ({ id: 'u1', email: 'free@example.com' }) };

/**
 * A real solid-colour JPEG as a data URL.
 * @param {number} [w] - Width in px.
 * @param {number} [h] - Height in px.
 * @returns {Promise<string>} `data:image/jpeg;base64,…`
 */
async function photo(w = 1200, h = 800) {
  const buf = await sharp({
    create: { width: w, height: h, channels: 3, background: { r: 90, g: 110, b: 130 } },
  }).jpeg().toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

const post = (base, body) => fetch(`${base}/api/download-result`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('a FREE (non-Pro) signed-in session can download — this route is not Pro-gated', async () => {
  app = await mountStaging(asFree);
  const image = await photo();
  const res = await post(app.baseUrl, { image, width: 600, height: 400 });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.success, true);
  assert.match(body.image, /^data:image\/jpeg;base64,/, 'output is JPEG, matching the format the button always downloaded');

  const meta = await sharp(Buffer.from(body.image.split(',')[1], 'base64')).metadata();
  assert.equal(meta.width, 600, 'resized to the requested width');
  assert.equal(meta.height, 400, 'resized to the requested height');
  assert.equal(meta.format, 'jpeg');
});

test('the output carries Stagify invisible provenance metadata', async () => {
  app = await mountStaging(asFree);
  const image = await photo();
  const res = await post(app.baseUrl, { image, width: 300, height: 200 });
  const body = await res.json();

  const meta = await sharp(Buffer.from(body.image.split(',')[1], 'base64')).metadata();
  assert.ok(meta.exif, 'EXIF block present');
  const exifText = meta.exif.toString('latin1');
  assert.ok(exifText.includes(STAGIFY_SOFTWARE_TAG));
  assert.ok(exifText.includes(DISCLOSURE_DESCRIPTIONS.staged), 'mode is "staged" — this is a staging-result download');
  assert.ok(meta.xmp, 'XMP block present');
  assert.ok(meta.xmp.toString('utf8').includes(DIGITAL_SOURCE_TYPE));
});

test('no session → 401 AUTH_REQUIRED, matching /api/process-image\'s access level', async () => {
  app = await mountStaging(); // default getAuthUserFromRequest → null
  const res = await post(app.baseUrl, { image: await photo(), width: 100, height: 100 });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'AUTH_REQUIRED');
});

test('the auth gate runs before the image is even looked at', async () => {
  app = await mountStaging();
  const res = await post(app.baseUrl, { image: 'not-a-data-url', width: 100, height: 100 });
  assert.equal(res.status, 401, 'auth answers first, not the 400');
});

test('a payload that is not an image data URL is a 400, not a 500', async () => {
  app = await mountStaging(asFree);
  for (const image of [undefined, null, 42, '', 'not-a-data-url', 'data:text/plain;base64,AAAA', 'data:image/png;base64,']) {
    const res = await post(app.baseUrl, { image, width: 100, height: 100 });
    assert.equal(res.status, 400, `${JSON.stringify(image)} is rejected as malformed`);
  }
});

test('an oversized image is refused before it is decoded', async () => {
  app = await mountStaging(asFree);
  // Just past MAX_DOWNLOAD_RESULT_BYTES (16MB decoded) without building a real 16MB image.
  const image = `data:image/jpeg;base64,${'A'.repeat(23 * 1024 * 1024)}`;
  const res = await post(app.baseUrl, { image, width: 100, height: 100 });
  assert.equal(res.status, 413);
});

test('width/height must be positive, finite, and within the resize ceiling', async () => {
  app = await mountStaging(asFree);
  const image = await photo();
  for (const [width, height] of [
    [0, 400], [600, 0], [-1, 400], [600, -1],
    [NaN, 400], [Infinity, 400], ['abc', 400],
    [20000, 400], [600, 20000], // past MAX_DOWNLOAD_RESULT_EDGE (2 * DELIVERY_MAX_EDGE = 8192)
  ]) {
    const res = await post(app.baseUrl, { image, width, height });
    assert.equal(res.status, 400, `width=${width} height=${height} should be rejected`);
  }
});

test('the route is rate limited by default — the router falls back to the shared limiter', async () => {
  app = await mountStaging({ ...asFree, downloadResultLimiter: null });
  const image = await photo(300, 200);
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await post(app.baseUrl, { image, width: 150, height: 100 })).status, 200, `request ${i + 1} is under the ceiling`);
  }
  assert.equal((await post(app.baseUrl, { image, width: 150, height: 100 })).status, 429, 'over the ceiling → refused');
});
