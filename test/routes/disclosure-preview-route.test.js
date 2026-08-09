// GET /api/disclosure-preview — the image behind the staging modal's badge preview.
//
// WHY ITS OWN FILE: this is an UNAUTHENTICATED endpoint that runs a sharp composite and a
// WebP encode per cold request, which makes it the only route in this router a stranger can
// spend CPU on without a session. Two properties keep that safe and neither is visible from
// reading the handler alone:
//
//   1. THE PARAMETER SPACE IS CLOSED. Every query value is snapped to a known set before it
//      is used or cached. If it were not, `?lang=<anything>` would be an unlimited cache-key
//      generator — each miss another render — and the cache would stop being a ceiling.
//   2. THE LIMITER IS ARMED WITHOUT BEING INJECTED. routes/staging.js falls back to the
//      shared limiter, so forgetting it in server.js's dep bag cannot leave this unlimited.
//      test/helpers/staging-app.js mounts a pass-through, which is exactly the wiring the
//      last test here must NOT use.
//
// Everything runs against the real renderer and the real committed badge masters: the thing
// under test is whether an actual image comes back, and a fake would assert nothing.

import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

// Set the ceiling before anything can import the limiter module — it is a singleton built
// at import time from the env var. The production default is 120 per 5 minutes.
const RL_SNAPSHOT = process.env.RL_DISCLOSURE_PREVIEW;
process.env.RL_DISCLOSURE_PREVIEW = '3';

// Dynamic import AFTER the override, so the router's fallback limiter is the limit=3 one.
const { mountStaging } = await import('../helpers/staging-app.js');
const { resetDisclosurePreviewCache } = await import('../../lib/image/disclosure-preview.js');

after(() => {
  if (RL_SNAPSHOT === undefined) delete process.env.RL_DISCLOSURE_PREVIEW;
  else process.env.RL_DISCLOSURE_PREVIEW = RL_SNAPSHOT;
});

let app;
afterEach(async () => {
  if (app) { await app.close(); app = null; }
  resetDisclosurePreviewCache();
});

const get = (base, query) => fetch(`${base}/api/disclosure-preview${query}`);

test('serves a real image for a valid configuration', async () => {
  app = await mountStaging();
  const res = await get(app.baseUrl, '?lang=english&style=dark&scale=1');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/webp');
  assert.match(res.headers.get('cache-control') || '', /max-age=\d+/, 'cached, or the slider re-renders on every hover');

  const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
  assert.equal(meta.format, 'webp');
  assert.ok(meta.width && meta.width > 200, `a real photo came back, not a placeholder (${meta.width}px)`);
});

test('the style and the size both reach the renderer', async () => {
  // The preview's entire job is to show the user THEIR configuration. If either parameter
  // were dropped between the query string and the compositor, every preview would look the
  // same and nobody would notice until a render came back different from what it promised.
  app = await mountStaging();
  const bytes = async (q) => Buffer.from(await (await get(app.baseUrl, q)).arrayBuffer());
  const base = await bytes('?lang=english&style=dark&scale=1');
  const otherStyle = await bytes('?lang=english&style=minimal&scale=1');
  const otherSize = await bytes('?lang=english&style=dark&scale=1.6');
  const otherLang = await bytes('?lang=japanese&style=dark&scale=1');

  assert.ok(Buffer.compare(base, otherStyle) !== 0, 'a different style renders differently');
  assert.ok(Buffer.compare(base, otherSize) !== 0, 'a different size renders differently');
  assert.ok(Buffer.compare(base, otherLang) !== 0, 'a different language renders differently');
});

test('junk parameters are snapped to the defaults, not rendered and not cached separately', async () => {
  // The closed-set property from the header comment. Byte-identity with the default is the
  // assertion that matters: it proves the junk did not reach sharp AND that it collapsed to
  // an existing cache key rather than minting a new one.
  app = await mountStaging();
  const bytes = async (q) => Buffer.from(await (await get(app.baseUrl, q)).arrayBuffer());
  const fallback = await bytes('?lang=english&style=dark&scale=1');

  for (const q of [
    '',
    '?lang=klingon&style=neon&scale=abc',
    // A traversal-shaped language would select a file on disk if it were ever trusted; a
    // traversal-shaped style would select a code path. Both collapse. `scale` is left out
    // of this row on purpose — a numeric scale CLAMPS rather than falling back, which the
    // next test covers, so including one here would be asserting the wrong rule.
    '?lang=../../etc/passwd&style=../../lib',
    '?scale=not-a-number',
  ]) {
    const res = await get(app.baseUrl, q);
    assert.equal(res.status, 200, `${q || '(no query)'} is answered, not rejected`);
    assert.ok(
      Buffer.compare(Buffer.from(await res.arrayBuffer()), fallback) === 0,
      `${q || '(no query)'} renders exactly the default preview`,
    );
  }
});

test('an out-of-range size clamps to the end of the slider rather than the default', async () => {
  // Distinct from the junk case above: 99 is a NUMBER, and the honest reading of it is
  // "as big as this goes". Falling back to 1.0 instead would quietly show the user a
  // different badge than the one their (tampered, but numeric) request described.
  app = await mountStaging();
  const bytes = async (q) => Buffer.from(await (await get(app.baseUrl, q)).arrayBuffer());
  const max = await bytes('?lang=english&style=dark&scale=1.6');
  const overshoot = await bytes('?lang=english&style=dark&scale=99');
  assert.ok(Buffer.compare(max, overshoot) === 0, '99 clamps to the top of the range');
});

test('the preview is rate limited by default — the router falls back to the shared limiter', async () => {
  // `disclosurePreviewLimiter: null` asks the helper for the production wiring. Without
  // this fallback, an omitted dep would leave a CPU-spending anonymous endpoint unlimited.
  app = await mountStaging({ disclosurePreviewLimiter: null });
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await get(app.baseUrl, '?lang=english&style=dark&scale=1')).status, 200, `request ${i + 1} is under the ceiling`);
  }
  assert.equal((await get(app.baseUrl, '?lang=english&style=dark&scale=1')).status, 429, 'over the ceiling → refused');
});
