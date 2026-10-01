// routes/object-local.js — the signed local blob route, over real HTTP.
//
// A storage key contains slashes (`renders/<id>/after.webp`), so the route captures it
// with a wildcard. Express 5 changed wildcard syntax and hands the match back as an array
// of segments; these tests pin that a multi-segment key still round-trips, and that a
// tampered signature is still a bare 404.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import createObjectLocalRouter from '../../routes/object-local.js';
import { createLocalObjectStore } from '../../lib/data/object-store-local.js';
import { keyForRender } from '../../lib/data/object-keys.js';

const KEY = keyForRender({ renderId: '0123456789abcdef0123456789abcdef', role: 'after' });

async function boot(t) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-object-route-'));
  const objectStore = createLocalObjectStore({ baseDir, secret: 'route-secret' });
  const app = express();
  app.use(createObjectLocalRouter({ objectStore }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => {
    server.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });
  return { objectStore, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test('a presigned multi-segment key serves its bytes', async (t) => {
  const { objectStore, baseUrl } = await boot(t);
  assert.ok(KEY.includes('/'), 'the key under test must span several path segments');
  const bytes = Buffer.from('staged room pixels');
  await objectStore.put(KEY, bytes, 'image/webp');

  const r = await fetch(baseUrl + objectStore.presignGet(KEY));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/webp');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes);
});

test('a tampered signature is a bare 404', async (t) => {
  const { objectStore, baseUrl } = await boot(t);
  await objectStore.put(KEY, Buffer.from('x'), 'image/webp');

  const url = objectStore.presignGet(KEY).replace(/sig=([0-9a-f])/, (_m, c) => `sig=${c === '0' ? '1' : '0'}`);
  const r = await fetch(baseUrl + url);
  assert.equal(r.status, 404);
  assert.equal((await r.arrayBuffer()).byteLength, 0);
});
