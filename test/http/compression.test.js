// Tier 2 — response compression (the compression() config in lib/http/app-middleware.js).
//
// There was no test here at all, which is how a real regression sat in production
// unnoticed: `compression` defaults brotli to quality 4, and at that setting brotli
// was LARGER than the same middleware's gzip — styles.css served as 23,292 bytes via
// br vs 22,136 via gzip. Browsers advertise and prefer br, so every visitor was
// handed the worse of the two encodings.
//
// These tests pin the PROPERTY, not the setting. Asserting
// `BROTLI_PARAM_QUALITY === 6` would keep passing if a dependency bump changed what
// that number means; asserting "br must not lose to gzip" is what we actually care
// about and is what would have caught the original bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { applyEdgeMiddleware } from '../../lib/http/app-middleware.js';

const CSS = path.join(process.cwd(), 'public', 'styles', 'styles.css');

/** Boot a throwaway express app on a random port. */
function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ port, close: () => server.close() });
    });
  });
}

/**
 * GET over raw http so the body is NOT transparently decompressed — fetch()/undici
 * inflates automatically, which would measure the original size and silently make
 * every assertion here vacuous.
 */
function rawGet(port, pathname, acceptEncoding) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: pathname, headers: { 'Accept-Encoding': acceptEncoding } },
      (res) => {
        let bytes = 0;
        res.on('data', (c) => {
          bytes += c.length;
        });
        res.on('end', () =>
          resolve({ bytes, encoding: res.headers['content-encoding'] || null, status: res.statusCode })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** The real edge stack, plus fixtures that exercise each branch of the filter. */
async function bootApp() {
  const app = express();
  applyEdgeMiddleware(app);

  const css = fs.readFileSync(CSS, 'utf8');
  app.get('/fixture.css', (req, res) => res.type('css').send(css));

  // Must stay uncompressed: compressing an SSE stream buffers it and breaks the
  // AI Designer's token-by-token output.
  app.get('/fixture-sse', (req, res) => {
    res.set('Content-Type', 'text/event-stream');
    res.send('data: ' + 'x'.repeat(50_000) + '\n\n');
  });

  // Must stay uncompressed: already-compressed image bytes, so this is pure CPU burn.
  app.post('/api/process-image', (req, res) => res.type('json').send(JSON.stringify({ b64: 'x'.repeat(50_000) })));

  return listen(app);
}

test('brotli is never larger than gzip for CSS (the original regression)', async () => {
  const { port, close } = await bootApp();
  try {
    const br = await rawGet(port, '/fixture.css', 'br');
    const gz = await rawGet(port, '/fixture.css', 'gzip');

    assert.equal(br.encoding, 'br', 'br should be negotiated when offered');
    assert.equal(gz.encoding, 'gzip', 'gzip should be negotiated when br is not offered');

    assert.ok(
      br.bytes <= gz.bytes,
      `brotli (${br.bytes} B) must not be larger than gzip (${gz.bytes} B) — this is the ` +
        'quality-4 regression. Browsers prefer br, so losing here means shipping the worse ' +
        'encoding to everyone. Raise BROTLI_PARAM_QUALITY in lib/http/app-middleware.js.'
    );
  } finally {
    close();
  }
});

test('CSS is actually compressed, and substantially', async () => {
  const { port, close } = await bootApp();
  try {
    const raw = fs.statSync(CSS).size;
    const br = await rawGet(port, '/fixture.css', 'br');
    // A wide floor: this asserts compression is ON and roughly sane, without pinning
    // a ratio that ordinary CSS edits would churn.
    assert.ok(
      br.bytes < raw * 0.5,
      `expected the compressed sheet to be well under half of ${raw} B, got ${br.bytes} B`
    );
  } finally {
    close();
  }
});

test('Server-Sent Events are never compressed', async () => {
  const { port, close } = await bootApp();
  try {
    const res = await rawGet(port, '/fixture-sse', 'br, gzip');
    assert.equal(
      res.encoding,
      null,
      'compressing text/event-stream buffers the stream and breaks live token output'
    );
  } finally {
    close();
  }
});

test('the image-generation routes are never compressed', async () => {
  const { port, close } = await bootApp();
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          method: 'POST',
          hostname: '127.0.0.1',
          port,
          path: '/api/process-image',
          headers: { 'Accept-Encoding': 'br, gzip' },
        },
        (r) => {
          let bytes = 0;
          r.on('data', (c) => {
            bytes += c.length;
          });
          r.on('end', () => resolve({ bytes, encoding: r.headers['content-encoding'] || null }));
        }
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.encoding, null, '/api/process-image returns already-compressed image bytes');
  } finally {
    close();
  }
});
