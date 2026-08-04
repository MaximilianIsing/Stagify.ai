// POST /api/masking-studio/save, through the real staging router.
//
// The handler's own decisions are covered in test/staging/masking-save-handler.test.js.
// What can only be checked HERE is the wiring — the gate, the two limiters, and the body
// size, which is the one that fails silently and confusingly if forgotten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountStaging } from '../helpers/staging-app.js';
import { JSON_LARGE_LIMIT_PATHS } from '../../lib/http/app-middleware.js';

const PRO = { id: 'u_pro', email: 'pro@x.com', plan: 'pro' };

async function post(baseUrl, body) {
  const res = await fetch(`${baseUrl}/api/masking-studio/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('an anonymous caller is refused before the handler runs', async () => {
  let reached = false;
  const app = await mountStaging({ handleMaskingSave: async () => { reached = true; } });
  try {
    const res = await post(app.baseUrl, { after: 'data:image/png;base64,AAAA' });
    assert.equal(res.status, 401);
    assert.equal(reached, false, 'the pro gate is the real boundary, not the page');
  } finally { await app.close(); }
});

test('a signed-in Stagify+ account reaches the handler with its own user', async () => {
  const seen = [];
  const app = await mountStaging({
    requireProAccount: () => PRO,
    handleMaskingSave: async (req, res, user) => { seen.push(user); res.json({ success: true }); },
  });
  try {
    const res = await post(app.baseUrl, { after: 'data:image/png;base64,AAAA' });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, [PRO]);
  } finally { await app.close(); }
});

test('a ~2MB body is NOT rejected — the large-JSON registration is real', async () => {
  // THE TRAP THIS PINS: without '/api/masking-studio/save' in JSON_LARGE_LIMIT_PATHS the
  // route gets the 1MB parser and 413s before the handler ever runs, with a message that
  // says nothing about which limit was hit. Two canvas exports are ~1.6MB of base64, so
  // this is the normal case, not an edge one.
  assert.ok(
    JSON_LARGE_LIMIT_PATHS.has('/api/masking-studio/save'),
    'the save route is missing from JSON_LARGE_LIMIT_PATHS in lib/http/app-middleware.js',
  );
  // ...and the router really does accept a payload that size once it is registered.
  const app = await mountStaging({
    requireProAccount: () => PRO,
    handleMaskingSave: async (req, res) => res.json({ success: true, bytes: req.body.after.length }),
  });
  try {
    const big = 'data:image/jpeg;base64,' + 'A'.repeat(2 * 1024 * 1024);
    const res = await post(app.baseUrl, { after: big });
    assert.equal(res.status, 200);
    assert.ok(res.body.bytes > 2_000_000);
  } finally { await app.close(); }
});

test('the dedicated import limiter is armed by default, not just injected', async () => {
  // Same reasoning as validateImageLimiter: this endpoint accepts megabytes of client
  // pixels and PUTs them to object storage with no model call in between, so an omitted
  // dep must never leave it unlimited. The helper injects a pass-through; this asserts the
  // router falls back to the real one when nothing is injected.
  const { default: createStagingRouter } = await import('../../routes/staging.js');
  const { baseDeps } = await import('../helpers/staging-app.js');
  const deps = baseDeps();
  delete deps.galleryImportLimiter;
  const layers = [];
  const router = createStagingRouter(deps);
  for (const layer of router.stack) {
    if (layer.route?.path === '/api/masking-studio/save') layers.push(layer.route.stack.length);
  }
  assert.deepEqual(layers, [3], 'expected galleryImportLimiter + genLimiter + the handler');
});

test('a handler that throws becomes a 500 with a reference, never a hung socket', async () => {
  const app = await mountStaging({
    requireProAccount: () => PRO,
    handleMaskingSave: async () => { throw new Error('boom'); },
  });
  try {
    const res = await post(app.baseUrl, { after: 'data:image/png;base64,AAAA' });
    assert.equal(res.status, 500);
    assert.ok(res.body.ref, 'the client gets a reference, not a stack');
    assert.ok(!/boom/.test(JSON.stringify(res.body)), 'and never the message');
  } finally { await app.close(); }
});

test('DRIFT GUARD: the staging router never receives renderPersistence', async () => {
  // This is what makes it structurally impossible for createMaskEditHandler to write to the
  // gallery. handleMaskingSave arrives pre-built from server.js instead, exactly as
  // handleExteriorMultipart does.
  const { baseDeps } = await import('../helpers/staging-app.js');
  assert.equal(baseDeps().renderPersistence, undefined);
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../routes/staging.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(!/renderPersistence/.test(src), 'routes/staging.js now names renderPersistence');
});
