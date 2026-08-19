// Tier: route (routes/admin-renders.js) — the operator's render inspector.
//
// This endpoint is pointed at the production database and hands back presigned
// URLs, so the risks are not "does it return rows":
//
//   - **It must not leak the shape of the row.** `staged_renders` carries
//     `user_id` and `render_blobs` carries `storage_key`. A `...row` spread would
//     publish both, and would publish every column added afterwards. The response
//     is asserted field by field.
//   - **It must show what the owner's gallery hides.** Failed, pending and evicted
//     rows are the entire reason this exists; a listing that quietly filtered to
//     `ok` would look like it worked and answer no support question.
//   - **It must not be N+1.** One blob read per page, not one per row.
//   - **No object store is not an error.** A deployment without R2 has no gallery;
//     the panel says so and the console keeps working.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAdminRendersRouter, shapeAdminRender } from '../../routes/admin-renders.js';

const KEY = 'test-endpoint-key';
const auth = { 'X-Stagify-Endpoint-Key': KEY };

/** Every server opened by a test, so none is left holding the runner open. */
const servers = [];
afterEach(() => { while (servers.length) servers.pop().close(); });

/** Count how often each store method is called, so N+1 is observable. */
function makeStore(rows, blobs = new Map()) {
  const calls = { list: 0, blobsForRenders: 0, blobsFor: 0, count: 0 };
  return {
    calls,
    listAllForUser({ userId, limit, offset }) {
      calls.list += 1;
      calls.lastArgs = { userId, limit, offset };
      return rows.slice(offset || 0, (offset || 0) + limit);
    },
    countAllForUser() { calls.count += 1; return rows.length; },
    blobsForRenders(ids) { calls.blobsForRenders += 1; calls.lastIds = ids; return blobs; },
    blobsFor() { calls.blobsFor += 1; return []; },
  };
}

async function mount({ store, configured = true } = {}) {
  const app = express();
  const protectLogs = (req, res, next) => (
    req.get('X-Stagify-Endpoint-Key') === KEY ? next() : res.status(403).json({ error: 'Forbidden' })
  );
  app.use(createAdminRendersRouter({
    stagedRenders: store,
    objectStore: {
      configured,
      presignGet: (key, opts) => `https://cdn.example/${key}?exp=${opts.ttlMs}`,
    },
    protectLogs,
    setSensitiveHeaders: (res) => res.set('Referrer-Policy', 'no-referrer'),
  }));
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  servers.push(srv);
  return `http://127.0.0.1:${srv.address().port}`;
}

const OK_ROW = {
  id: 'r_1', user_id: 'u_secret', created_at: 1750000000000, status: 'ok',
  width: 1024, height: 768, room_type: 'Living Room', furniture_style: 'Modern',
  additional_prompt: 'warmer lighting', remove_furniture: 1, model: 'gemini-x',
  variation: 2, batch_id: 'b_1', evicted_at: null, custom_name: 'Wilson viewing',
};

// ---- What must never appear in the body ------------------------------------

test('the response carries no storage_key and no user_id, however the row grows', async () => {
  const blobs = new Map([['r_1', [
    { role: 'thumb', storage_key: 'renders/u_secret/r_1/thumb.webp', bytes: 100 },
    { role: 'after', storage_key: 'renders/u_secret/r_1/after.webp', bytes: 900 },
  ]]]);
  // A column nobody shaped, standing in for the next one someone adds.
  const store = makeStore([{ ...OK_ROW, some_future_column: 'must not ship' }], blobs);
  const base = await mount({ store });

  const res = await fetch(`${base}/api/admin/renders?userId=u_secret`, { headers: auth });
  assert.equal(res.status, 200);
  const text = await res.text();

  assert.ok(!text.includes('"user_id"'), 'the owner id column must not be serialized');
  assert.ok(!text.includes('storage_key'), 'the bucket key must not be serialized');
  assert.ok(!text.includes('must not ship'), 'an unshaped column must not ride along');
  // The presigned URL legitimately contains the key — that is the credential the
  // browser needs — but the raw key field itself never appears.
  const body = JSON.parse(text);
  assert.equal(body.entries[0].urls.thumb, 'https://cdn.example/renders/u_secret/r_1/thumb.webp?exp=300000');
});

test('the shaped entry has exactly the documented fields', () => {
  const entry = shapeAdminRender({ render: OK_ROW, blobs: [], presign: () => 'x' });
  assert.deepEqual(Object.keys(entry).sort(), [
    'additionalPrompt', 'batchId', 'bytes', 'createdAt', 'evicted', 'evictedAt',
    'furnitureStyle', 'height', 'id', 'model', 'name', 'removeFurniture',
    'roomType', 'source', 'sourceName', 'status', 'urls', 'variation', 'width',
  ]);
});

// ---- The rows the owner's gallery hides ------------------------------------

test('failed, pending and evicted rows are all returned and distinguishable', async () => {
  const store = makeStore([
    { ...OK_ROW, id: 'r_ok' },
    { ...OK_ROW, id: 'r_fail', status: 'failed' },
    { ...OK_ROW, id: 'r_pend', status: 'pending' },
    { ...OK_ROW, id: 'r_evict', evicted_at: 1750000009999 },
  ]);
  const base = await mount({ store });
  const body = await (await fetch(`${base}/api/admin/renders?userId=u_secret`, { headers: auth })).json();

  assert.equal(body.entries.length, 4, 'nothing is filtered out');
  const byId = Object.fromEntries(body.entries.map((e) => [e.id, e]));
  assert.equal(byId.r_fail.status, 'failed');
  assert.equal(byId.r_pend.status, 'pending');
  assert.equal(byId.r_evict.evicted, true);
  assert.equal(byId.r_ok.evicted, false);
});

test('an evicted row gets no URLs — its bytes are gone, and a 404 link reads as a broken viewer', async () => {
  const blobs = new Map([['r_evict', [{ role: 'thumb', storage_key: 'k', bytes: 10 }]]]);
  const store = makeStore([{ ...OK_ROW, id: 'r_evict', evicted_at: 123 }], blobs);
  const base = await mount({ store });
  const body = await (await fetch(`${base}/api/admin/renders?userId=u_secret`, { headers: auth })).json();
  assert.deepEqual(body.entries[0].urls, { after: '', before: '', thumb: '' });
  assert.equal(body.entries[0].evicted, true);
});

test('a row whose blobs were tombstoned away does not 500 the panel', async () => {
  // status still 'ok', blob map empty — the rarer real case.
  const store = makeStore([OK_ROW], new Map());
  const base = await mount({ store });
  const res = await fetch(`${base}/api/admin/renders?userId=u_secret`, { headers: auth });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.entries[0].urls, { after: '', before: '', thumb: '' });
  assert.equal(body.entries[0].bytes, 0);
});

// ---- Not N+1 ---------------------------------------------------------------

test('one blob read per page, no matter how many rows', async () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ ...OK_ROW, id: `r_${i}` }));
  const store = makeStore(rows);
  const base = await mount({ store });
  await fetch(`${base}/api/admin/renders?userId=u_secret&limit=40`, { headers: auth });

  assert.equal(store.calls.blobsForRenders, 1, 'the page is read in one statement');
  assert.equal(store.calls.blobsFor, 0, 'never the per-row read');
  assert.equal(store.calls.lastIds.length, 40);
});

test('an empty page does not go looking for blobs at all', async () => {
  const store = makeStore([]);
  const base = await mount({ store });
  const body = await (await fetch(`${base}/api/admin/renders?userId=nobody`, { headers: auth })).json();
  assert.deepEqual(body.entries, []);
  assert.equal(store.calls.blobsForRenders, 0);
});

// ---- Inputs ----------------------------------------------------------------

test('limit is clamped and defaulted; a hostile one cannot page the whole table', async () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ ...OK_ROW, id: `r_${i}` }));

  for (const [q, expected] of [['', 24], ['&limit=10', 10], ['&limit=99999', 100], ['&limit=0', 1], ['&limit=-5', 1], ['&limit=abc', 24]]) {
    const store = makeStore(rows);
    const base = await mount({ store });
    await fetch(`${base}/api/admin/renders?userId=u${q}`, { headers: auth });
    assert.equal(store.calls.lastArgs.limit, expected, `limit${q || ' (default)'} → ${expected}`);
  }
});

test('a missing userId is a 400, and never reaches the store', async () => {
  const store = makeStore([OK_ROW]);
  const base = await mount({ store });
  const res = await fetch(`${base}/api/admin/renders`, { headers: auth });
  assert.equal(res.status, 400);
  assert.equal(store.calls.list, 0);
});

test('an unknown account is an empty list, not a 404 — absence is the answer', async () => {
  const base = await mount({ store: makeStore([]) });
  const res = await fetch(`${base}/api/admin/renders?userId=ghost`, { headers: auth });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).entries, []);
});

// ---- Guard and headers -----------------------------------------------------

test('without the key it is a 403, and the store is never touched', async () => {
  const store = makeStore([OK_ROW]);
  const base = await mount({ store });
  const res = await fetch(`${base}/api/admin/renders?userId=u_secret`);
  assert.equal(res.status, 403);
  assert.equal(store.calls.list, 0);
});

test('the body is no-store, because it carries bearer URLs', async () => {
  const base = await mount({ store: makeStore([OK_ROW]) });
  const res = await fetch(`${base}/api/admin/renders?userId=u_secret`, { headers: auth });
  assert.match(res.headers.get('cache-control') || '', /no-store/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer', 'setSensitiveHeaders ran');
});

test('no object store means "the gallery is off", not an error', async () => {
  const store = makeStore([OK_ROW]);
  const base = await mount({ store, configured: false });
  const res = await fetch(`${base}/api/admin/renders?userId=u_secret`, { headers: auth });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.enabled, false);
  assert.deepEqual(body.entries, []);
  assert.equal(store.calls.list, 0, 'no point reading rows whose bytes are unreachable');
});

// ---- Which tool made it ----------------------------------------------------

test('the source is carried, so an API render is distinguishable from a studio one', async () => {
  // The gap this closes: for its first weeks the API wrote extra_json NULL, so every render
  // it sold looked exactly like a studio render here AND bucketed as 'unknown' in
  // renders.bySource. See test/data/render-extra.test.js for the guard that now catches it.
  const store = makeStore([
    { ...OK_ROW, id: 'r_api', extra_json: JSON.stringify({ source: 'api', sourceName: '412-rosewood' }) },
    { ...OK_ROW, id: 'r_web', extra_json: JSON.stringify({ source: 'interior', sourceName: 'kitchen' }) },
  ]);
  const base = await mount({ store });
  const body = await (await fetch(`${base}/api/admin/renders?userId=u_secret`, { headers: auth })).json();

  const byId = Object.fromEntries(body.entries.map((e) => [e.id, e]));
  assert.equal(byId.r_api.source, 'api');
  assert.equal(byId.r_api.sourceName, '412-rosewood');
  assert.equal(byId.r_web.source, 'interior');
});

test('a row with no naming payload reports an empty source rather than throwing', async () => {
  // Legacy rows predate the column, and a damaged one must degrade the same way it does in
  // the owner's gallery — the console and the customer must not disagree about a row.
  const store = makeStore([
    { ...OK_ROW, id: 'r_legacy', extra_json: null },
    { ...OK_ROW, id: 'r_broken', extra_json: '{not json' },
    { ...OK_ROW, id: 'r_retired', extra_json: JSON.stringify({ source: 'retired-studio', sourceName: 'x' }) },
  ]);
  const base = await mount({ store });
  const res = await fetch(`${base}/api/admin/renders?userId=u_secret`, { headers: auth });
  assert.equal(res.status, 200);
  const byId = Object.fromEntries((await res.json()).entries.map((e) => [e.id, e]));
  assert.equal(byId.r_legacy.source, '');
  assert.equal(byId.r_broken.source, '');
  // A retired studio loses its source but keeps the rest of the row.
  assert.equal(byId.r_retired.source, '');
  assert.equal(byId.r_retired.sourceName, 'x');
});
