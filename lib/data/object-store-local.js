// The filesystem backend for the gallery's bytes — `<dataDir>/objects/<key>`.
//
// THIS IS NOT A TOY. It is what lets `npm test`, CI, the test harness and local dev
// exercise the IDENTICAL manifest, router and persistence code with no R2 account and
// no network. Every behaviour the R2 adapter has to get right — a missing object is
// `false` rather than a throw, `get` rejects rather than resolving null, `presignGet`
// is pure and synchronous — is pinned by tests that run against this backend on every
// machine. It is also the same-day fallback if the R2 signing path ever misbehaves:
// `presignGet` already returns a same-origin URL, so nothing above the adapter changes.
//
// GATE 2 LIVES HERE, and only here. lib/data/object-keys.js holds gate 1 (the strict
// whole-string regex). `resolveWithinRoot` is the second, deliberately independent gate
// — the one that still holds if the pattern is ever loosened, and the only one that
// sees what the operating system actually does with a path (Windows normalises `\`
// into a separator, `..` segments collapse). It is meaningless against a bucket, which
// is why the R2 adapter does not have it.
//
// THE PRESIGNED URL. `presignGet` returns `/api/object/<key>?exp=<ms>&sig=<hmac>`,
// served by routes/object-local.js. The HMAC is over the key AND the expiry together,
// so neither can be edited without invalidating the other — signing only the key would
// let anyone extend their own access forever. The secret defaults to per-process random
// bytes: a restart invalidating outstanding URLs is correct here, because the client's
// re-mint path (public/scripts/share/refresh.js) already recovers from an expired URL,
// and a secret that survives a restart would have to live somewhere durable for no
// benefit in dev.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { resolveDataDir } from './data-dir.js';
import { isSafeObjectKey, unsafeKey } from './object-keys.js';
import { logger } from '../logger.js';

/** How long a locally-presigned URL stays valid when the caller does not say. */
export const DEFAULT_TTL_MS = 15 * 60 * 1000;

/** The path prefix routes/object-local.js mounts on. One constant, two users. */
export const LOCAL_OBJECT_ROUTE = '/api/object';

/**
 * Gate 2: resolve `relative` against `root` and refuse anything that does not land
 * strictly inside it.
 *
 * Equality with the root is a failure too — the argument has to name something inside.
 * Exported so it can be tested directly rather than only through a write.
 *
 * @param {string} root - Absolute directory the path must stay inside.
 * @param {string} relative - Relative (or, hostilely, absolute) path.
 * @returns {string} The absolute path.
 * @throws {Error} With `code: 'EUNSAFEKEY'` when it escapes.
 */
export function resolveWithinRoot(root, relative) {
  const base = path.resolve(root);
  const abs = path.resolve(base, String(relative));
  if (!abs.startsWith(base + path.sep)) throw unsafeKey('object key resolves outside the object store');
  return abs;
}

/**
 * Sign a key+expiry pair. Separate from the factory so the route can verify without
 * constructing a store.
 * @param {string} secret - HMAC key.
 * @param {string} key - Storage key.
 * @param {number} exp - Absolute expiry, epoch ms.
 * @returns {string} Hex digest.
 */
export function signLocalObject(secret, key, exp) {
  return crypto.createHmac('sha256', secret).update(`${key}\n${exp}`).digest('hex');
}

/**
 * Constant-time check of a presigned local URL.
 *
 * Compares as fixed-length buffers via `timingSafeEqual`, which throws on a length
 * mismatch — hence the length guard first. A plain `===` here would leak the digest a
 * byte at a time to anything that can time a request.
 *
 * @param {string} secret - HMAC key.
 * @param {string} key - Storage key from the path.
 * @param {unknown} exp - `exp` query parameter, still a string off the wire.
 * @param {unknown} sig - `sig` query parameter.
 * @param {number} [now] - Clock, injectable for tests.
 * @returns {boolean} True when the signature matches and the URL has not expired.
 */
export function verifyLocalObject(secret, key, exp, sig, now = Date.now()) {
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum <= now) return false;
  if (typeof sig !== 'string') return false;
  const expected = signLocalObject(secret, key, expNum);
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

/**
 * Open the filesystem object store.
 *
 * @param {{ baseDir: string, secret?: string }} deps - `baseDir` is handed to
 *   resolveDataDir, exactly as the SQLite stores hand it to getDb, so rows and bytes
 *   always land on one volume. `secret` signs presigned URLs; defaults to per-process
 *   random.
 * @returns {import('./object-store.js').ObjectStore & {
 *   objectsRoot: () => string,
 *   absolutePathFor: (key: string) => string,
 *   secret: string,
 * }} The store, plus the two filesystem-only helpers its tests and route need.
 */
export function createLocalObjectStore({ baseDir, secret }) {
  const hmacSecret = secret || crypto.randomBytes(32).toString('hex');

  /**
   * `<dataDir>/objects`, created on demand. mkdirSync is a no-op on an existing
   * directory, so this both creates and validates in one syscall; a failure is logged
   * and the path still returned, matching lib/image/hosted-images.js — a write against
   * it fails loudly on its own, and throwing from a path helper would take down callers
   * that only wanted to name a file.
   * @returns {string} Absolute path.
   */
  function objectsRoot() {
    const dir = path.join(resolveDataDir(baseDir), 'objects');
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {
        logger.error('[object-store-local] failed to create the objects dir', e);
      }
    }
    return dir;
  }

  /**
   * THE one place a key becomes a filesystem path, through both gates.
   * @param {string} key - Relative storage key.
   * @returns {string} Absolute path on the data volume.
   * @throws {Error} `code: 'EUNSAFEKEY'` for anything that fails either gate.
   */
  function absolutePathFor(key) {
    if (!isSafeObjectKey(key)) throw unsafeKey('unsafe object storage key');
    return resolveWithinRoot(objectsRoot(), key);
  }

  return {
    configured: true,
    backend: 'local',
    objectsRoot,
    absolutePathFor,
    secret: hmacSecret,

    /**
     * Write one blob, creating its directory on the way.
     * @param {string} key - Relative storage key.
     * @param {Buffer | Uint8Array} buffer - The bytes.
     * @returns {Promise<{ key: string, bytes: number }>} The key back (so callers can
     *   persist it straight into `storage_key`) and the byte count.
     */
    async put(key, buffer) {
      const abs = absolutePathFor(key);
      // `typeof buffer.length === 'number'` would be the obvious guard and is what the
      // module this was adapted from used — but a STRING has a numeric `.length`, so it
      // passes, and fs.writeFile then happily encodes it as UTF-8. The row would record
      // a byte count that is the character count, and the object would not be an image.
      // Check the type, not the shape.
      if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
        throw new TypeError('[object-store-local] put needs a Buffer or Uint8Array');
      }
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, buffer);
      return { key, bytes: buffer.length };
    },

    /**
     * Read one blob.
     * @param {string} key - Relative storage key.
     * @returns {Promise<Buffer>} The bytes. Rejects with ENOENT when the blob is gone
     *   (a row can outlive its object — the caller decides what that means) and with
     *   `EUNSAFEKEY` when the key is not one of ours.
     */
    async get(key) {
      return fs.promises.readFile(absolutePathFor(key));
    },

    /**
     * Delete one blob. Idempotent: a missing object is `false`, not a throw, because
     * "make sure this is gone" is what every caller actually wants — and the tombstone
     * reaper retries forever, so a throw on an already-deleted key would never drain.
     * @param {string} key - Relative storage key.
     * @returns {Promise<boolean>} True when an object was actually deleted.
     */
    async remove(key) {
      try {
        await fs.promises.unlink(absolutePathFor(key));
        return true;
      } catch (e) {
        if (/** @type {any} */ (e)?.code === 'ENOENT') return false;
        throw e;
      }
    },

    /**
     * Size and mtime of one blob, or null when it is not there.
     * @param {string} key - Relative storage key.
     * @returns {Promise<{ bytes: number, mtimeMs: number } | null>}
     */
    async head(key) {
      try {
        const st = await fs.promises.stat(absolutePathFor(key));
        return { bytes: st.size, mtimeMs: st.mtimeMs };
      } catch (e) {
        if (/** @type {any} */ (e)?.code === 'ENOENT') return null;
        throw e;
      }
    },

    /**
     * A same-origin URL that serves this object until it expires.
     *
     * PURE AND SYNCHRONOUS, which is load-bearing rather than incidental: a manifest
     * with twenty thumbnails mints twenty URLs in microseconds with no I/O. If this
     * were async you would be tempted to cache the results, and a cached presigned URL
     * is a revocation bug.
     *
     * @param {string} key - Relative storage key.
     * @param {{ ttlMs?: number, filename?: string, now?: number }} [opts] - `filename`
     *   sets a download name; `now` is injectable for tests.
     * @returns {string} A relative URL.
     */
    presignGet(key, opts = {}) {
      if (!isSafeObjectKey(key)) throw unsafeKey('unsafe object storage key');
      const now = opts.now ?? Date.now();
      const exp = now + (opts.ttlMs ?? DEFAULT_TTL_MS);
      const params = new URLSearchParams({ exp: String(exp), sig: signLocalObject(hmacSecret, key, exp) });
      if (opts.filename) params.set('filename', opts.filename);
      return `${LOCAL_OBJECT_ROUTE}/${key}?${params.toString()}`;
    },
  };
}
