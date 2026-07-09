// Hosted-image manifest store (lib/image/hosted-images.js). It persists the list of
// uploaded logos/assets served back by URL, under <dataDir>/hosted-images/index.json.
// The reads fail OPEN to [] (a corrupt manifest must never crash a request), so we pin
// that contract plus the dir/path derivation and a write→read round-trip. Real fs in a
// temp dir; getDataLogDir is injected, so no server state is touched.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHostedImages } from '../lib/image/hosted-images.js';

const tmps = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-hosted-'));
  tmps.push(dir);
  return dir;
}
function freshStore() {
  const dataDir = tmpDir();
  const store = createHostedImages({ getDataLogDir: () => dataDir });
  return { store, dataDir };
}
afterEach(() => {
  while (tmps.length) {
    try { fs.rmSync(tmps.pop(), { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('getHostedImagesDir: derives <dataDir>/hosted-images and creates it', () => {
  const { store, dataDir } = freshStore();
  const expected = path.join(dataDir, 'hosted-images');
  assert.equal(fs.existsSync(expected), false, 'not created until requested');
  assert.equal(store.getHostedImagesDir(), expected);
  assert.equal(fs.existsSync(expected), true, 'the dir is created on demand');
});

test('getHostedImagesManifestPath: index.json inside the hosted-images dir', () => {
  const { store, dataDir } = freshStore();
  assert.equal(store.getHostedImagesManifestPath(), path.join(dataDir, 'hosted-images', 'index.json'));
});

test('readHostedImagesManifest: missing manifest → [] (not an error)', () => {
  const { store } = freshStore();
  assert.deepEqual(store.readHostedImagesManifest(), []);
});

test('write then read round-trips the array of entries', () => {
  const { store } = freshStore();
  const entries = [
    { id: 'img_1', url: '/hosted-images/img_1.png', name: 'logo.png' },
    { id: 'img_2', url: '/hosted-images/img_2.webp', name: 'hero.webp' },
  ];
  assert.equal(store.writeHostedImagesManifest(entries), true, 'write reports success');
  assert.deepEqual(store.readHostedImagesManifest(), entries);
});

test('readHostedImagesManifest: corrupt JSON fails open to []', () => {
  const { store } = freshStore();
  fs.writeFileSync(store.getHostedImagesManifestPath(), '{ this is not json');
  assert.deepEqual(store.readHostedImagesManifest(), [], 'unparseable manifest → []');
});

test('readHostedImagesManifest: a non-array JSON value is rejected as []', () => {
  const { store } = freshStore();
  fs.writeFileSync(store.getHostedImagesManifestPath(), JSON.stringify({ not: 'an array' }));
  assert.deepEqual(store.readHostedImagesManifest(), [], 'object payload → [] (Array.isArray guard)');
});
