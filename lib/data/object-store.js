// Which object-store backend the gallery uses, decided once at boot.
//
// THE SELECTION RULE, and the one case that is not obvious
//   R2 configured                  -> R2. The production answer.
//   not configured, not on Render  -> local disk. Dev, CI, `npm test`.
//   not configured, ON Render      -> DISABLED, and the gallery is off.
//
// That last branch is the point of this module. Falling back to the local disk in
// production would "work" — and would write ~220 KB per staged entry onto the same 1 GB
// volume that holds auth-store.db and its WAL, which is the exact failure this whole
// feature was designed to avoid. A misconfigured bucket must degrade to "no gallery",
// never to "quietly fill the disk that auth and Stripe depend on".
//
// FAILING SAFE IS THE HOUSE POSTURE. scripts/start.sh already boots without Litestream
// when the R2 credentials are absent rather than refusing to start: a backup
// misconfiguration must not take down the paid product. Same rule here — a storage
// misconfiguration turns the gallery off and leaves staging completely untouched.
import { createLocalObjectStore } from './object-store-local.js';
import { createR2ObjectStore, r2ConfigFromEnv } from './object-store-r2.js';
import { logger } from '../logger.js';

/**
 * @typedef {Object} ObjectStore
 * @property {boolean} configured Whether bytes can actually be stored. When false every
 *   method is a no-op and callers must skip persistence entirely.
 * @property {string} backend Which implementation answered — `r2`, `local` or `disabled`.
 * @property {(key: string, buffer: Buffer | Uint8Array, contentType?: string) => Promise<{key: string, bytes: number}>} put
 * @property {(key: string) => Promise<Buffer>} get Rejects on absence; never resolves null.
 * @property {(key: string) => Promise<boolean>} remove Idempotent; a missing object is false.
 * @property {(key: string) => Promise<{bytes: number, mtimeMs: number} | null>} head
 * @property {(key: string, opts?: {ttlMs?: number, filename?: string, now?: number}) => string} presignGet
 *   PURE and SYNCHRONOUS — no network, no await, and nothing that should ever be cached.
 */

/**
 * The store you get when nothing is configured: every call is a safe no-op.
 *
 * `put` resolves rather than rejecting so a caller that forgot to check `configured`
 * degrades to "the entry never appears in the gallery" instead of throwing inside a
 * paid render's response path. `presignGet` returns an empty string, which the manifest
 * builders treat as "no URL" and omit.
 *
 * @returns {ObjectStore}
 */
export function createDisabledObjectStore() {
  return {
    configured: false,
    backend: 'disabled',
    async put(key, buffer) {
      return { key, bytes: buffer?.length ?? 0 };
    },
    async get(key) {
      const err = new Error(`[object-store] disabled: cannot read ${key}`);
      /** @type {any} */ (err).code = 'ENOENT';
      throw err;
    },
    async remove() {
      return false;
    },
    async head() {
      return null;
    },
    presignGet() {
      return '';
    },
  };
}

/**
 * Build the object store for this process.
 *
 * @param {{ baseDir: string, env?: Record<string, string | undefined>, fetchImpl?: typeof fetch,
 *   localSecret?: string }} deps - `baseDir` is handed to resolveDataDir by the local
 *   backend, exactly as the SQLite stores hand it to getDb, so rows and bytes land on
 *   one volume. `env` and `fetchImpl` are injectable so tests can drive every branch.
 * @returns {ObjectStore} Never throws — an unusable configuration yields the disabled store.
 */
export function createObjectStore({ baseDir, env = process.env, fetchImpl, localSecret }) {
  const r2 = r2ConfigFromEnv(env);
  if (r2) {
    logger.info(`[object-store] using R2 bucket ${r2.bucket}`);
    return createR2ObjectStore({ ...r2, fetchImpl });
  }

  if (env.RENDER) {
    logger.warn(
      '[object-store] R2 is not configured and this is Render — the gallery is DISABLED. '
      + 'Falling back to the local disk here would write render bytes onto the same volume as '
      + 'auth-store.db. Set R2_ACCOUNT_ENDPOINT, R2_RENDERS_BUCKET, R2_ACCESS_KEY_ID and '
      + 'R2_SECRET_ACCESS_KEY to turn it on.',
    );
    return createDisabledObjectStore();
  }

  logger.debug('[object-store] R2 not configured — using local object storage');
  return createLocalObjectStore({ baseDir, secret: localSecret });
}
