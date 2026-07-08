// Tier: core pipeline (fake AI) — /api/segment response parser.
//
// The Masking Studio "magic wand" turns Gemini's free-text reply into normalized
// bounding boxes. That parsing/normalization is deterministic and full of edge
// cases (fenced JSON, prose, out-of-range or degenerate boxes, junk) — exactly the
// kind of thing that breaks silently. We drive it with a fake genAI (canned text),
// so it's fast, free, and never hits Google.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mountStaging } from './helpers/staging-app.js';
import { fakeGenAI } from './helpers/fake-ai.js';
import sharp from 'sharp';

// A real, decodable image — /api/segment runs the upload through sharp before it
// segments, so a bogus buffer would 400 before the parser under test ever runs.
const IMAGE = 'data:image/png;base64,'
  + (await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 210, g: 210, b: 210 } } })
      .png().toBuffer()).toString('base64');
// A requireProAccount that passes (returns a user, sends nothing).
const proPass = () => ({ id: 'u_test', plan: 'pro' });

let app;
afterEach(async () => { if (app) { await app.close(); app = null; } });

async function segment(genAI, body = { image: IMAGE }) {
  app = await mountStaging({ genAI, requireProAccount: proPass });
  const res = await fetch(`${app.baseUrl}/api/segment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

test('parses a clean JSON list into normalized boxes with labels', async () => {
  const genAI = fakeGenAI(JSON.stringify([
    { box_2d: [10, 20, 300, 400], label: 'sofa' },
    { box_2d: [500, 500, 900, 900], label: 'floor lamp' },
  ]));
  const body = await (await segment(genAI)).json();
  assert.equal(body.success, true);
  assert.equal(body.items.length, 2);
  assert.deepEqual(body.items[0].box_2d, [10, 20, 300, 400]);
  assert.equal(body.items[0].label, 'sofa');
});

test('extracts a list wrapped in a ```json code fence', async () => {
  const genAI = fakeGenAI('Here you go:\n```json\n[{"box_2d":[1,2,3,4],"label":"rug"}]\n```\nHope that helps!');
  const body = await (await segment(genAI)).json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].label, 'rug');
});

test('falls back to the embedded array when the reply is prose + JSON', async () => {
  const genAI = fakeGenAI('Sure! The objects are [{"box_2d":[5,5,50,50],"label":"chair"}] in the scene.');
  const body = await (await segment(genAI)).json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].label, 'chair');
});

test('clamps out-of-range coordinates to 0..1000', async () => {
  const genAI = fakeGenAI(JSON.stringify([{ box_2d: [-50, 20, 1200, 400.7], label: 'wide' }]));
  const body = await (await segment(genAI)).json();
  assert.deepEqual(body.items[0].box_2d, [0, 20, 1000, 401]);
});

test('drops degenerate boxes and malformed entries', async () => {
  const genAI = fakeGenAI(JSON.stringify([
    { box_2d: [300, 20, 100, 400], label: 'inverted' }, // x2 < x1 → dropped
    { box_2d: [1, 2, 3], label: 'too short' },           // not 4 coords → dropped
    { label: 'no box' },                                 // no box_2d → dropped
    { box_2d: [10, 10, 90, 90], label: 'keep' },         // valid → kept
  ]));
  const body = await (await segment(genAI)).json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].label, 'keep');
});

test('caps the list at 24 items', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ box_2d: [0, 0, 100, 100], label: 'obj' + i }));
  const genAI = fakeGenAI(JSON.stringify(many));
  const body = await (await segment(genAI)).json();
  assert.equal(body.items.length, 24);
});

test('returns an empty list (after a retry) when the reply is junk', async () => {
  const genAI = fakeGenAI('I could not find any objects in this image, sorry.');
  const res = await segment(genAI);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.items, []);
  assert.equal(genAI.callCount, 2, 'an empty first pass should trigger exactly one retry');
});

test('400 without an image, 500 when the AI is not configured', async () => {
  app = await mountStaging({ genAI: fakeGenAI('[]'), requireProAccount: proPass });
  assert.equal((await fetch(`${app.baseUrl}/api/segment`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  })).status, 400);
  await app.close();

  app = await mountStaging({ genAI: null, requireProAccount: proPass });
  assert.equal((await fetch(`${app.baseUrl}/api/segment`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: IMAGE }),
  })).status, 500);
});
