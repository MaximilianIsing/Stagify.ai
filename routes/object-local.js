// Serves the locally-stored gallery blobs that lib/data/object-store-local.js presigns.
//
// DEV AND CI ONLY. It is mounted only when the local object backend is the one that
// answered at boot (see server.js) — in production R2 presigns straight at the bucket
// and no byte of a render ever passes through this process, which is the entire egress
// argument for using R2 at all. This route exists so that the manifest builders, the
// gallery page and the share page can be exercised end to end by `npm test` and by a
// developer with no R2 account, against the IDENTICAL code path.
//
// The security model is the presigned URL, not the session: the signature covers the
// key AND the expiry together, so neither can be edited without invalidating the other.
// That deliberately mirrors what R2 enforces, so a bug in how the app hands out URLs
// shows up in dev rather than only in production.
import fs from 'fs';
import path from 'path';
import { createAsyncRouter } from '../lib/http/async-router.js';
import { isSafeObjectKey } from '../lib/data/object-keys.js';
import { verifyLocalObject, LOCAL_OBJECT_ROUTE } from '../lib/data/object-store-local.js';

/** Extension → Content-Type. Only what the gallery actually stores. */
const CONTENT_TYPES = Object.freeze({
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
});

/**
 * Build the local blob route.
 *
 * @param {{ objectStore: { absolutePathFor: (key: string) => string, secret: string } }} deps -
 *   The LOCAL object store; the R2 store has neither member, which is the type-level
 *   reason this router cannot be mounted against it by accident.
 * @returns {import('express').Router}
 */
export default function createObjectLocalRouter({ objectStore }) {
  const router = createAsyncRouter();

  // A wildcard, because a storage key contains slashes (`renders/<id>/after.webp`) and
  // a single `:param` would only capture the first segment.
  router.get(`${LOCAL_OBJECT_ROUTE}/*`, async (req, res) => {
    const key = String(/** @type {any} */ (req.params)[0] ?? '');

    // Gate 1 before anything touches the filesystem. Every refusal below is the same
    // bare 404 with no body: a route that says "bad signature" for a real key and
    // "not found" for a fake one is an oracle for which renders exist.
    if (!isSafeObjectKey(key)) return res.status(404).end();
    if (!verifyLocalObject(objectStore.secret, key, req.query.exp, req.query.sig)) {
      return res.status(404).end();
    }

    let abs;
    try {
      abs = objectStore.absolutePathFor(key);
    } catch {
      return res.status(404).end();
    }
    if (!fs.existsSync(abs)) return res.status(404).end();

    const ext = path.extname(abs).slice(1).toLowerCase();
    res.setHeader('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
    // The URL is already time-limited by its signature, so a cache would only ever
    // serve bytes the signature still covers. `no-store` keeps dev honest anyway —
    // a stale local cache masking a revocation bug is exactly what this route exists
    // to let you observe.
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (typeof req.query.filename === 'string' && req.query.filename) {
      res.setHeader('Content-Disposition', `attachment; filename="${req.query.filename.replace(/["\\]/g, '')}"`);
    }
    return res.sendFile(abs);
  });

  return router;
}
