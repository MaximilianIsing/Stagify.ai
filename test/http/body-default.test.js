// lib/http/app-middleware.js — req.body defaults to {} after the JSON parser.
//
// Express 5's body-parser leaves req.body undefined when it parsed nothing; Express 4's
// defaulted it to {}. Handlers that destructure req.body unguarded rely on the old
// contract, so a body-less or non-JSON request would otherwise be a TypeError 500.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { applyBodyAndStatic } from '../../lib/http/app-middleware.js';

async function boot(t) {
  const app = express();
  applyBodyAndStatic(app);
  app.post('/echo', (req, res) => {
    const { name = 'none' } = req.body;
    res.json({ type: typeof req.body, name });
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('a POST with no body still sees req.body as {}', async (t) => {
  const baseUrl = await boot(t);
  const r = await fetch(baseUrl + '/echo', { method: 'POST' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { type: 'object', name: 'none' });
});

test('a non-JSON Content-Type still sees req.body as {}', async (t) => {
  const baseUrl = await boot(t);
  const r = await fetch(baseUrl + '/echo', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'hello',
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { type: 'object', name: 'none' });
});

test('a JSON body is still parsed', async (t) => {
  const baseUrl = await boot(t);
  const r = await fetch(baseUrl + '/echo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'room' }),
  });
  assert.deepEqual(await r.json(), { type: 'object', name: 'room' });
});
