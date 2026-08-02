// The Cloudflare R2 backend for the gallery's bytes.
//
// WHY THE BYTES ARE NOT ON THE RENDER DISK
// A staged entry is ~220 KB (after + before + thumb). The Render volume is also where
// auth-store.db and its WAL live, so filling it does not merely break the gallery — it
// takes auth and the Stripe webhook down with it. But the decisive property is not
// storage price, it is EGRESS: a share link means a buyer's browser downloading images,
// repeatedly, and served from the disk that is this single Node process pushing bytes
// through its event loop. R2 charges nothing for egress and, because reads go direct
// via presigned URLs, those bytes never enter this process at all.
//
// TWO SIGNERS, ON PURPOSE
// PUT/DELETE/HEAD are network calls, so aws4fetch's async WebCrypto signer costs
// nothing and gets full credit for correctness. GET is presigned on the request path,
// once per blob in a manifest, and must stay synchronous and cacheless — see the header
// of lib/data/s3-presign.js for why, and test/data/s3-presign.test.js for the
// differential test that keeps the hand-rolled half honest.
//
// A SEPARATE BUCKET AND A SEPARATE TOKEN FROM LITESTREAM
// litestream.yml already replicates auth-store.db to R2 with LITESTREAM_ACCESS_KEY_ID.
// That token can overwrite the replica of the entire application database. Reusing it
// here would mean an app-level bug that writes a WebP to the wrong key can corrupt
// disaster recovery. Same account, new bucket, new scoped token.
import { AwsClient } from 'aws4fetch';
import { isSafeObjectKey, unsafeKey } from './object-keys.js';
import { presignGetUrl } from './s3-presign.js';
import { logger } from '../logger.js';

/** How long a presigned URL stays valid when the caller does not say. */
export const DEFAULT_TTL_MS = 15 * 60 * 1000;

/**
 * The refusal a failed R2 call throws. Carries the status so a caller can tell "gone"
 * from "R2 is broken" — the tombstone reaper retries the latter forever and must not
 * treat it as done.
 * @param {string} op - The operation that failed.
 * @param {string} key - The key it was for.
 * @param {number} status - HTTP status from R2.
 * @param {string} [body] - Response text, truncated by the caller.
 * @returns {Error}
 */
function r2Error(op, key, status, body) {
  const err = new Error(`[object-store-r2] ${op} ${key} failed: HTTP ${status}${body ? ` ${body}` : ''}`);
  /** @type {any} */ (err).status = status;
  /** @type {any} */ (err).code = status === 404 ? 'ENOENT' : 'ER2';
  return err;
}

/**
 * Open the R2 object store.
 *
 * @param {{ endpoint: string, bucket: string, accessKeyId: string, secretAccessKey: string,
 *   region?: string, fetchImpl?: typeof fetch }} deps - `endpoint` is the account-level
 *   `https://<account>.r2.cloudflarestorage.com` (no bucket); `fetchImpl` is injectable
 *   so tests can drive every branch without a network or an account.
 * @returns {import('./object-store.js').ObjectStore & { backend: 'r2', urlFor: (key: string) => string }}
 */
export function createR2ObjectStore({ endpoint, bucket, accessKeyId, secretAccessKey, region = 'auto', fetchImpl }) {
  const aws = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region });
  const doFetch = fetchImpl ?? fetch;
  const origin = String(endpoint).replace(/\/+$/, '');

  /**
   * Sign a request, then send it with OUR fetch.
   *
   * Deliberately `aws.sign()` + `doFetch(...)` rather than `aws.fetch(...)`: aws4fetch's
   * own `fetch` closes over the GLOBAL fetch and offers no injection point, so passing a
   * `fetch` in its init is silently ignored. Going through `sign` is what makes
   * `fetchImpl` real — without it every test here would be hitting the network, or
   * (worse) quietly passing while exercising nothing.
   *
   * @param {string} url - Absolute object URL.
   * @param {RequestInit} init - Method, body and headers.
   * @returns {Promise<Response>}
   */
  async function signedFetch(url, init) {
    return doFetch(await aws.sign(url, init));
  }

  /**
   * The unsigned object URL. Path-style (`/<bucket>/<key>`), which is what R2's S3
   * endpoint serves — virtual-host style would need a per-bucket hostname.
   * @param {string} key - Relative storage key.
   * @returns {string} Absolute URL.
   */
  function urlFor(key) {
    if (!isSafeObjectKey(key)) throw unsafeKey('unsafe object storage key');
    return `${origin}/${bucket}/${key}`;
  }

  return {
    configured: true,
    backend: /** @type {'r2'} */ ('r2'),
    urlFor,

    /**
     * Upload one blob.
     * @param {string} key - Relative storage key.
     * @param {Buffer | Uint8Array} buffer - The bytes.
     * @param {string} [contentType] - Stored as the object's Content-Type, so a
     *   presigned GET serves it with the right header and the browser renders it.
     * @returns {Promise<{ key: string, bytes: number }>}
     */
    async put(key, buffer, contentType = 'application/octet-stream') {
      // Type, not shape — a string has a numeric `.length` and would otherwise be
      // uploaded as UTF-8 text under an image content-type. See the local adapter.
      if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
        throw new TypeError('[object-store-r2] put needs a Buffer or Uint8Array');
      }
      const res = await signedFetch(urlFor(key), {
        method: 'PUT',
        body: buffer,
        headers: { 'content-type': contentType },
      });
      if (!res.ok) throw r2Error('put', key, res.status, (await res.text().catch(() => '')).slice(0, 200));
      return { key, bytes: buffer.length };
    },

    /**
     * Download one blob.
     *
     * Rejects on absence rather than resolving null, matching the local adapter and the
     * filesystem it mirrors — a row can outlive its object, and the caller decides what
     * that means.
     * @param {string} key - Relative storage key.
     * @returns {Promise<Buffer>} The bytes.
     */
    async get(key) {
      const res = await signedFetch(urlFor(key), { method: 'GET' });
      if (!res.ok) throw r2Error('get', key, res.status);
      return Buffer.from(await res.arrayBuffer());
    },

    /**
     * Delete one blob. Idempotent: an object that is already gone is `false`, not a
     * throw. That is what the tombstone reaper needs — it retries until it wins, so a
     * throw on an already-deleted key would mean a queue entry that never drains.
     *
     * S3 semantics answer 204 for a delete of something absent, so the 404 branch is
     * belt-and-braces for a backend that reports it differently.
     * @param {string} key - Relative storage key.
     * @returns {Promise<boolean>} True when R2 accepted the delete.
     */
    async remove(key) {
      const res = await signedFetch(urlFor(key), { method: 'DELETE' });
      if (res.status === 404) return false;
      if (!res.ok && res.status !== 204) {
        throw r2Error('remove', key, res.status, (await res.text().catch(() => '')).slice(0, 200));
      }
      return true;
    },

    /**
     * Size and last-modified of one blob, or null when it is not there.
     * @param {string} key - Relative storage key.
     * @returns {Promise<{ bytes: number, mtimeMs: number } | null>}
     */
    async head(key) {
      const res = await signedFetch(urlFor(key), { method: 'HEAD' });
      if (res.status === 404) return null;
      if (!res.ok) throw r2Error('head', key, res.status);
      const lastModified = res.headers.get('last-modified');
      const parsed = lastModified ? Date.parse(lastModified) : NaN;
      return {
        bytes: Number(res.headers.get('content-length') ?? 0),
        mtimeMs: Number.isFinite(parsed) ? parsed : 0,
      };
    },

    /**
     * A URL that serves this object directly from R2 until it expires.
     *
     * PURE AND SYNCHRONOUS. See lib/data/s3-presign.js — the short version is that a
     * manifest mints one of these per blob on the request path, and an async signature
     * would invite a cache, and a cached presigned URL is a revocation bug.
     *
     * REVOCATION IS EVENTUAL, BY CONSTRUCTION. Revoking a share stops NEW URLs being
     * minted immediately, but one already handed out keeps working until it expires —
     * at most `ttlMs`. Any UI that says otherwise is wrong; the copy must say "stops
     * working within 15 minutes". Deleting the entry is the hard revoke, because a
     * presigned URL to a deleted object 404s regardless of how valid its signature is.
     *
     * @param {string} key - Relative storage key.
     * @param {{ ttlMs?: number, filename?: string, now?: number }} [opts]
     * @returns {string} The signed URL.
     */
    presignGet(key, opts = {}) {
      return presignGetUrl({
        url: urlFor(key),
        accessKeyId,
        secretAccessKey,
        region,
        expiresSec: Math.max(1, Math.round((opts.ttlMs ?? DEFAULT_TTL_MS) / 1000)),
        now: opts.now,
        contentDisposition: opts.filename ? `attachment; filename="${opts.filename.replace(/["\\]/g, '')}"` : undefined,
      });
    },
  };
}

/**
 * Read the R2 settings out of an environment bag.
 *
 * Deliberately NOT reading `LITESTREAM_*` as a fallback — see the header. A partial
 * configuration (endpoint set, secret missing) returns null rather than half-opening a
 * store that would fail on its first write.
 *
 * @param {Record<string, string | undefined>} env - Usually `process.env`.
 * @returns {{ endpoint: string, bucket: string, accessKeyId: string, secretAccessKey: string } | null}
 */
export function r2ConfigFromEnv(env) {
  const endpoint = env.R2_ACCOUNT_ENDPOINT;
  const bucket = env.R2_RENDERS_BUCKET;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    const partial = [endpoint, bucket, accessKeyId, secretAccessKey].some(Boolean);
    if (partial) {
      logger.warn(
        '[object-store-r2] R2 is partially configured (need R2_ACCOUNT_ENDPOINT, R2_RENDERS_BUCKET, '
        + 'R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY) — falling back to local object storage.',
      );
    }
    return null;
  }
  return { endpoint, bucket, accessKeyId, secretAccessKey };
}
