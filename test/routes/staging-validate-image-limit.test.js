// The dedicated rate limit + payload prechecks on POST /api/validate-image.
//
// WHY ITS OWN FILE: the endpoint spends a paid Gemini vision call per accepted
// request, and it is the cheapest paid surface to drive — one JSON POST, where
// staging itself needs a multipart upload and burns a daily quota. It used to sit
// behind `genLimiter` alone (60 per 5 min, sized for a whole staging session), so
// `validateImageLimiter` is the thing that keeps the pre-check from being a bulk
// vision API. That limiter is a module-level singleton constructed ONCE, at import
// time, from `RL_VALIDATE_IMAGE` — so a small deterministic ceiling only exists if
// the env var is set BEFORE lib/http/rate-limiters.js is first imported. Hence the
// override + dynamic import below, and hence a separate file:
// test/helpers/staging-app.js mounts a pass-through limiter so the many behavioural
// cases in staging-routes.test.js don't share one bucket, which is exactly the
// wiring this file must NOT use.
//
// The important assertion is that the limiter is armed WITHOUT being injected —
// routes/staging.js falls back to the shared limiter, so forgetting it in the
// server.js dep bag cannot silently leave the pre-check on genLimiter alone.
// Passing `validateImageLimiter: null` asks the helper for that production wiring.
//
// No network and no AI: `validateStageableImage` is an in-process fake that counts
// how often it was reached, which is what "did this cost money?" means here.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Set the ceiling before anything can import the limiter module. 2 keeps the burst
// short; the production default is 20 per 5 minutes.
const RL_SNAPSHOT = process.env.RL_VALIDATE_IMAGE;
process.env.RL_VALIDATE_IMAGE = '2';

// Dynamic import taken AFTER the override, so the router's fallback limiter is the
// limit=2 one. A static import at the top of the file would run first and freeze
// the default in.
const { mountStaging } = await import('../helpers/staging-app.js');

after(() => {
  if (RL_SNAPSHOT === undefined) delete process.env.RL_VALIDATE_IMAGE;
  else process.env.RL_VALIDATE_IMAGE = RL_SNAPSHOT;
});

const SIGNED_IN = { getAuthUserFromRequest: () => ({ id: 'u_test', plan: 'free' }) };
const IMAGE = 'data:image/jpeg;base64,' + Buffer.from('a room photo').toString('base64');

const postJson = (base, body) =>
  fetch(`${base}/api/validate-image`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Mount with production limiter wiring and a vision fake that counts its calls. */
async function mountCounted() {
  const calls = { vision: 0 };
  const app = await mountStaging({
    ...SIGNED_IN,
    validateImageLimiter: null, // no injected middleware → exactly what production mounts
    validateStageableImage: async () => {
      calls.vision += 1;
      return { valid: true, code: null, reason: '' };
    },
  });
  return { ...app, calls };
}

test('validate-image is rate limited by default — the router falls back to the shared limiter', async () => {
  const app = await mountCounted();
  try {
    // The first RL_VALIDATE_IMAGE (=2) requests go through and do spend a vision call.
    for (let i = 0; i < 2; i += 1) {
      const ok = await postJson(app.baseUrl, { image: IMAGE });
      assert.equal(ok.status, 200, `request ${i + 1} is under the ceiling`);
    }
    assert.equal(app.calls.vision, 2);

    // The next one is refused, and — the point of the limit — never reaches the model.
    const blocked = await postJson(app.baseUrl, { image: IMAGE });
    assert.equal(blocked.status, 429, 'over the ceiling → refused');
    assert.equal(app.calls.vision, 2, 'a rate-limited request costs nothing');

    // Still refused on the next attempt: the window does not reset per request.
    assert.equal((await postJson(app.baseUrl, { image: IMAGE })).status, 429);
    assert.equal(app.calls.vision, 2);
  } finally {
    await app.close();
  }
});

test('a payload that cannot be an upload is refused before the paid call', async () => {
  // The pass-through limiter here keeps this file's two tests out of one bucket.
  const calls = { vision: 0 };
  const app = await mountStaging({
    ...SIGNED_IN,
    validateStageableImage: async () => {
      calls.vision += 1;
      return { valid: true, code: null, reason: '' };
    },
  });
  try {
    // A comma alone used to be enough to reach the model.
    const notADataUrl = await postJson(app.baseUrl, { image: 'hello,world' });
    assert.equal(notADataUrl.status, 400);
    assert.equal(calls.vision, 0, 'a non-data-URL never reaches the model');

    // A data URL for something that is not an image is equally not an upload.
    const notAnImage = await postJson(app.baseUrl, { image: 'data:text/html;base64,PGh0bWw+' });
    assert.equal(notAnImage.status, 400);
    assert.equal(calls.vision, 0);

    // Oversized: the studios post a few hundred KB, the JSON parser allows 25MB.
    // Past MAX_VALIDATE_IMAGE_BYTES (8MB decoded) we refuse rather than pay to look.
    const huge = 'data:image/jpeg;base64,' + 'A'.repeat(12 * 1024 * 1024);
    const tooBig = await postJson(app.baseUrl, { image: huge });
    assert.equal(tooBig.status, 413);
    assert.equal(calls.vision, 0, 'an oversized payload never reaches the model');

    // A real one still does.
    assert.equal((await postJson(app.baseUrl, { image: IMAGE })).status, 200);
    assert.equal(calls.vision, 1);
  } finally {
    await app.close();
  }
});
