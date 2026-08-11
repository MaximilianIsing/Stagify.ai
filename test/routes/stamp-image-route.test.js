// POST /api/stamp-image — the "virtually staged" badge, applied to an image the CLIENT built.
//
// WHY ITS OWN FILE: this is the only endpoint that stamps a payload the server did not
// produce. Everywhere else the badge goes on inside a render we were already holding, so the
// image is trusted by construction. Here Basic Mask composites its result in the browser and
// posts it back purely to have the badge burned in, which puts three properties on this route
// that exist nowhere else in the disclosure path:
//
//   1. IT FAILS CLOSED, LOUDLY. The caller is about to write a file the user believes carries
//      a disclosure. A response that quietly handed back the input unstamped would be worse
//      than an error, so a stamping failure must be a distinguishable 500 and never a 200.
//   2. IT ACCEPTS MEGABYTES WITH NO MODEL CALL. Nothing about the work is bounded by an AI
//      round trip, so the size ceiling and the limiter are the only things bounding it.
//   3. IT IS PRO-GATED. Basic Mask is Stagify+ only; the nav row being locked is a UI
//      affordance, not a boundary.
//
// Runs against the real stampVirtuallyStaged and the real committed badge masters — the
// question is whether an actually-labelled image comes back, and a fake would assert nothing.

import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

// Set the ceiling before anything imports the limiter — it is a singleton built at import
// time from the env var. The production default is 30 per 15 minutes.
const RL_SNAPSHOT = process.env.RL_STAMP_IMAGE;
process.env.RL_STAMP_IMAGE = '3';

const { mountStaging } = await import('../helpers/staging-app.js');

after(() => {
  if (RL_SNAPSHOT === undefined) delete process.env.RL_STAMP_IMAGE;
  else process.env.RL_STAMP_IMAGE = RL_SNAPSHOT;
});

let app;
afterEach(async () => {
  if (app) { await app.close(); app = null; }
});

/** A pro session, for the routes that need to get past requireProAccount. */
const asPro = { requireProAccount: () => ({ id: 'u1', email: 'pro@example.com' }) };

/**
 * A real solid-colour PNG as a data URL, big enough for the badge to land in its
 * proportional size regime rather than bottoming out on the readability floor.
 * @param {number} [w] - Width in px.
 * @param {number} [h] - Height in px.
 * @returns {Promise<string>} `data:image/png;base64,…`
 */
async function photo(w = 1200, h = 800) {
  const buf = await sharp({
    create: { width: w, height: h, channels: 3, background: { r: 90, g: 110, b: 130 } },
  }).png().toBuffer();
  return `data:image/png;base64,${buf.toString('base64')}`;
}

const post = (base, body) => fetch(`${base}/api/stamp-image`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('stamps the image and hands back a data URL', async () => {
  app = await mountStaging(asPro);
  const image = await photo();
  const res = await post(app.baseUrl, { image, lang: 'english', style: 'dark', scale: 1 });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.success, true);
  assert.match(body.image, /^data:image\/png;base64,/);
  assert.notEqual(body.image, image, 'the pixels changed — something was actually drawn on');

  // And it is still the same photo, not a badge on its own.
  const meta = await sharp(Buffer.from(body.image.split(',')[1], 'base64')).metadata();
  assert.equal(meta.width, 1200);
  assert.equal(meta.height, 800);
});

test('the style, size and language all reach the stamper', async () => {
  // The user configures these in the panel and then judges the result by the file they
  // download. If any of them were dropped between the request and the compositor, every
  // download would carry the default badge and the controls would be decorative.
  app = await mountStaging(asPro);
  const image = await photo();
  const bytes = async (extra) => {
    const res = await post(app.baseUrl, { image, lang: 'english', style: 'dark', scale: 1, ...extra });
    return Buffer.from((await res.json()).image.split(',')[1], 'base64');
  };
  const base = await bytes({});
  assert.ok(Buffer.compare(base, await bytes({ style: 'banner' })) !== 0, 'a different style draws differently');
  assert.ok(Buffer.compare(base, await bytes({ scale: 1.6 })) !== 0, 'a different size draws differently');
  assert.ok(Buffer.compare(base, await bytes({ lang: 'japanese' })) !== 0, 'a different language draws differently');
});

test('junk style and language snap to the defaults instead of failing the download', async () => {
  // Same rule the preview route follows, and for the same reason stamp-disclosure.js gives:
  // a badge in the wrong style still discloses, and no badge does not. A stale or
  // hand-rolled value must not cost the user their image.
  app = await mountStaging(asPro);
  const image = await photo();
  const bytes = async (body) => {
    const res = await post(app.baseUrl, { image, ...body });
    assert.equal(res.status, 200, `${JSON.stringify(body)} is answered, not rejected`);
    return Buffer.from((await res.json()).image.split(',')[1], 'base64');
  };
  const fallback = await bytes({ lang: 'english', style: 'dark', scale: 1 });
  for (const body of [
    {},
    { lang: 'klingon', style: 'neon', scale: 'abc' },
    { lang: '../../etc/passwd', style: '../../lib' },
  ]) {
    assert.ok(Buffer.compare(await bytes(body), fallback) === 0, `${JSON.stringify(body)} renders the default badge`);
  }
});

test('signed-out and free accounts are refused', async () => {
  // The helper's default requireProAccount answers 401 itself. Basic Mask is Stagify+ only,
  // and this route is CPU the caller does not otherwise pay for.
  app = await mountStaging();
  const res = await post(app.baseUrl, { image: await photo() });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'AUTH_REQUIRED');
});

test('the gate runs before the image is even looked at', async () => {
  // Order matters: validating (and decoding) a stranger's megabytes before deciding whether
  // they may be here is the work the gate exists to avoid.
  app = await mountStaging();
  const res = await post(app.baseUrl, { image: 'not-a-data-url' });
  assert.equal(res.status, 401, 'auth answers first, not the 400');
});

test('a payload that is not an image data URL is a 400, not a 500', async () => {
  // `'x'.split(',')[1]` is undefined and Buffer.from(undefined) throws — which would surface
  // as a 500 with an error ref and a reported incident. A malformed client body is a 400.
  app = await mountStaging(asPro);
  for (const image of [undefined, null, 42, '', 'not-a-data-url', 'data:text/plain;base64,AAAA', 'data:image/png;base64,']) {
    const res = await post(app.baseUrl, { image });
    assert.equal(res.status, 400, `${JSON.stringify(image)} is rejected as malformed`);
  }
});

test('an oversized image is refused before it is decoded', async () => {
  // The ceiling is enforced from the ENCODED length precisely so no buffer is ever allocated
  // for the payload being refused.
  app = await mountStaging(asPro);
  // Just past MAX_STAMP_IMAGE_BYTES (16MB decoded) without building a real 16MB image.
  const image = `data:image/png;base64,${'A'.repeat(23 * 1024 * 1024)}`;
  const res = await post(app.baseUrl, { image });
  assert.equal(res.status, 413);
});

test('a stamping failure is a distinguishable 500 — never the unstamped image', async () => {
  // THE point of this file. stampVirtuallyStaged fails closed, and this route has to carry
  // that all the way to the browser: the client branches on the code to say "untick the
  // option", and a 200 carrying the input would put an unlabelled file on the user's disk
  // under a name they believe is labelled.
  app = await mountStaging(asPro);
  // Shaped like a PNG data URL, decodes to four bytes that sharp cannot read.
  const image = 'data:image/png;base64,AAAA';
  const res = await post(app.baseUrl, { image });
  assert.equal(res.status, 500);

  const body = await res.json();
  assert.equal(body.code, 'DISCLOSURE_STAMP_FAILED');
  assert.ok(body.ref, 'reported — this is an environment/asset fault worth seeing');
  assert.equal(body.image, undefined, 'and no image came back at all');
});

test('the route is rate limited by default — the router falls back to the shared limiter', async () => {
  // `stampImageLimiter: null` asks the helper for the production wiring. Unlike /api/mask-edit
  // there is no genLimiter in front of this one, so an omitted dep would leave a
  // CPU-spending endpoint with no ceiling whatsoever.
  app = await mountStaging({ ...asPro, stampImageLimiter: null });
  // Small, to keep four renders quick — but not tiny: below a few hundred pixels the badge
  // no longer fits the frame and stampVirtuallyStaged fails closed, which would make this
  // test about geometry rather than about the ceiling.
  const image = await photo(600, 400);
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await post(app.baseUrl, { image })).status, 200, `request ${i + 1} is under the ceiling`);
  }
  assert.equal((await post(app.baseUrl, { image })).status, 429, 'over the ceiling → refused');
});
