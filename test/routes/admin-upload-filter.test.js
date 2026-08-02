// POST /api/host-image driven through the REAL multer instance.
//
// WHY THIS EXISTS: every other admin test replaces the upload middleware with a
// pass-through (test/helpers/admin-app.js), and the only test that touched the
// filter called `hostedImageFileFilter` as a bare function, with its own header
// admitting it "never touch[es] multer's request pipeline". Nothing asserted the
// filter was ATTACHED to the instance the route uses — so deleting
// `fileFilter: hostedImageFileFilter` from lib/http/uploads.js kept the whole suite
// green.
//
// That gap matters because the route does not re-check the type:
//   routes/admin.js  — `HOSTED_IMAGE_MIME_EXT[req.file.mimetype] || 'bin'` SAVES an
//                      unknown type rather than refusing it, and stores the client's
//                      mimetype verbatim in the manifest;
//   routes/public.js — serves /i/<id> back with that stored mime and
//                      `Content-Disposition: inline`.
// So an image/svg+xml upload would be persisted and served inline, from our own
// origin, where it can carry script. `X-Content-Type-Options: nosniff` does not help
// — the declared type IS the dangerous one. The upload is behind the admin key, so
// this is defence in depth rather than an open door, but it is exactly the kind of
// control that must not be silently deletable.
//
// These tests post REAL multipart bodies (FormData + Blob) so the filter, the
// storage engine and the route's error branch all run for real.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mountAdmin } from '../helpers/admin-app.js';

let app;
afterEach(async () => {
  if (app) { await app.close(); app = null; }
});

/** A minimal, genuinely-decodable 1x1 PNG. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function postImage(app, { bytes, filename, type }) {
  const form = new FormData();
  form.append('image', new Blob([bytes], { type }), filename);
  return fetch(`${app.baseUrl}/api/host-image`, {
    method: 'POST',
    headers: { 'X-Stagify-Endpoint-Key': app.key },
    body: form,
  });
}

test('a real PNG upload is accepted and hosted', async () => {
  app = await mountAdmin({ realUpload: true });

  const res = await postImage(app, { bytes: PNG_BYTES, filename: 'ok.png', type: 'image/png' });
  // NB: read the body ONCE. Passing `await res.text()` as the assertion message
  // consumes it eagerly, and the res.json() below then throws "Body is unusable".
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.match(body.path, /^\/i\/[a-f0-9]{32}$/, 'an unguessable id is minted');

  const manifest = app.getManifest();
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].mime, 'image/png');
  assert.equal(manifest[0].ext, 'png');
});

// The positive case above is what makes this negative one meaningful: without it, a
// filter that rejected EVERYTHING would also pass.
test('an SVG is refused by the real multer instance, not saved as .bin', async () => {
  app = await mountAdmin({ realUpload: true });

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const res = await postImage(app, { bytes: svg, filename: 'x.svg', type: 'image/svg+xml' });

  assert.equal(res.status, 400, 'the filter must reject it before the route ever sees a file');
  assert.match((await res.json()).error, /can be hosted/i);
  assert.deepEqual(app.getManifest(), [], 'nothing is recorded');
});

test('the other dangerous-by-inline types are refused too', async () => {
  for (const [type, filename] of [
    ['text/html', 'x.html'],
    ['application/xhtml+xml', 'x.xhtml'],
    ['image/svg+xml', 'x.svg'],
    ['application/javascript', 'x.js'],
    ['application/octet-stream', 'x.bin'],
  ]) {
    app = await mountAdmin({ realUpload: true });
    const res = await postImage(app, { bytes: Buffer.from('<html>hi</html>'), filename, type });
    assert.equal(res.status, 400, `${type} must be refused`);
    assert.deepEqual(app.getManifest(), [], `${type} must not be recorded`);
    await app.close();
    app = null;
  }
});

test('every mime the route can map to an extension is actually accepted', async () => {
  // HOSTED_IMAGE_MIME_EXT and the filter must agree. If the filter ever narrows
  // without the map narrowing, the extra keys become unreachable dead config; if the
  // map narrows without the filter, an accepted upload lands as .bin.
  for (const [type, ext] of [
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/webp', 'webp'],
    ['image/gif', 'gif'],
  ]) {
    app = await mountAdmin({ realUpload: true });
    const res = await postImage(app, { bytes: PNG_BYTES, filename: `a.${ext}`, type });
    assert.equal(res.status, 200, `${type} must be accepted`);
    assert.equal(app.getManifest()[0].ext, ext, `${type} must be stored as .${ext}`);
    await app.close();
    app = null;
  }
});

test('a request with no file at all is a 400, not a crash', async () => {
  app = await mountAdmin({ realUpload: true });
  const res = await fetch(`${app.baseUrl}/api/host-image`, {
    method: 'POST',
    headers: { 'X-Stagify-Endpoint-Key': app.key },
    body: new FormData(),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(app.getManifest(), []);
});

test('the upload still requires the admin key', async () => {
  app = await mountAdmin({ realUpload: true });
  const form = new FormData();
  form.append('image', new Blob([PNG_BYTES], { type: 'image/png' }), 'ok.png');
  const res = await fetch(`${app.baseUrl}/api/host-image`, { method: 'POST', body: form });
  assert.equal(res.status, 403);
  assert.deepEqual(app.getManifest(), [], 'an unauthenticated upload writes nothing');
});
