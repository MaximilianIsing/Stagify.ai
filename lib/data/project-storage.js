// Blob storage for a listing project's photos and renders — the bytes, not the rows.
//
// WHY THIS IS NOT IN SQLITE
// A listing project is a whole shoot: 30 source photos, each rendered at up to three
// variations, every file a multi-megabyte WebP. That is ~90 blobs and a few hundred
// megabytes for ONE listing. All structured state in this app lives in a single SQLite
// database (see lib/data/db.js) that Litestream replicates row by row to R2 — putting
// image blobs in it would mean every re-render shipping the whole payload through the
// replication stream, on the same single-writer connection that answers logins. So the
// rows live in `projects`/`project_photos`/`renders` (lib/data/projects.js) and the bytes
// live here, on the same mounted disk, referenced by a `storage_key`.
//
// THE LAYOUT, and the one rule that keeps it honest
//   key:  projects/<projectId>/src/<photoId>.<ext>     (an uploaded source photo)
//         projects/<projectId>/out/<renderId>.<ext>    (a render)
//   path: <dataDir>/projects/<projectId>/src/<photoId>.<ext>
// The key's leading `projects/` segment IS `projectsRoot()`. Every key→path conversion
// therefore goes through ONE function, `resolveKey`, and `removeProject` uses it too
// rather than composing `projectsRoot()` + projectId on its own. That is not tidiness:
// the first version of this module resolved the raw key against `projectsRoot()`, so
// reads and writes landed in `<dataDir>/projects/projects/<pid>/…` while `removeProject`
// deleted `<dataDir>/projects/<pid>/…` — it reported success and removed nothing, which
// silently defeated GDPR erasure of a user's room photographs. Two independently
// composed paths for one layout is the defect; the shared resolver is the fix.
//
// WHY THE KEY IS RELATIVE
// `storage_key` is stored RELATIVE and backend-agnostic: no data-dir prefix, no drive
// letter, no bucket name. The absolute path is derived at read time from resolveDataDir
// (lib/data/data-dir.js — the ONE place that decides where durable state lives; never
// re-derive it). Moving this store to S3/R2 later is then one adapter behind these
// methods and NOT a data migration: the same key becomes an object key unchanged, with
// the `projects/` prefix exactly where a bucket wants it. Store an absolute path in the
// column instead and every row has to be rewritten the day the disk moves.
//
// WHY THE VALIDATION IS DOUBLED
// These keys come out of the database and will eventually reach an HTTP route that serves
// the bytes back, which makes them the classic path-traversal vector: one
// `../../auth-store.db` in a storage_key and that route hands out the password hashes.
// Two independent gates, and a key must pass both:
//   1. isSafeStorageKey — a strict whole-string regex. Only lowercase hex ids, only the
//      two known kinds, only a short lowercase extension. No dots, no backslashes, no
//      percent signs, no absolute paths, no NUL — none of those characters are in any
//      allowed class, so they fail before any fs call.
//   2. resolveWithinRoot — path.resolve the result and require it to sit strictly under
//      projectsRoot(). This is what catches anything the regex ever stops catching (and
//      it normalises Windows `\` and `..` for us, which is exactly why a string check on
//      its own is not enough).
// Gate 2 is unreachable while gate 1 holds — that is the point of defence in depth, not a
// reason to delete it. Both are exported so both can be tested directly.
import fs from 'fs';
import path from 'path';
import { resolveDataDir } from './data-dir.js';
import { logger } from '../logger.js';

/**
 * The only key shape this store accepts. Ids are 32 lowercase hex characters in practice
 * (see `newId` in projects.js); the 8–64 range leaves room for a shorter or longer minter
 * without reopening this regex.
 */
export const STORAGE_KEY_PATTERN = /^projects\/[a-f0-9]{8,64}\/(src|out)\/[a-f0-9]{8,64}\.[a-z0-9]{2,5}$/;

/** Project ids, used on their own by `removeProject` (which takes no full key). */
export const PROJECT_ID_PATTERN = /^[a-f0-9]{8,64}$/;

/**
 * The segment every key starts with, which is also the directory `projectsRoot()` names.
 * One constant, used by `keyFor` when building a key and by `resolveKey` when taking one
 * apart, so the two halves cannot drift into disagreeing about the layout.
 */
export const KEY_PREFIX = 'projects/';

/** The two subdirectories a project's blobs are split into. */
export const STORAGE_KINDS = Object.freeze(['src', 'out']);

/**
 * Gate 1: is this string a storage key this store is willing to touch?
 *
 * Whole-string match, so nothing can be smuggled in a prefix or a suffix. Rejects (by
 * construction, because the characters are simply not in any allowed class) `..`,
 * absolute paths, backslashes, percent-encoding and NUL bytes.
 * @param {unknown} key - Candidate key, usually straight out of a database row.
 * @returns {boolean}
 */
export function isSafeStorageKey(key) {
  return typeof key === 'string' && STORAGE_KEY_PATTERN.test(key);
}

/**
 * Gate 2: resolve `relative` against `root` and refuse anything that does not land
 * strictly inside it.
 *
 * Deliberately independent of the regex above — it is the gate that still holds if the
 * pattern is ever loosened, and the only one that sees what the operating system actually
 * does with a path (Windows normalises `\` into a separator, `..` segments collapse).
 * Equality with the root is a failure too: the argument has to name something inside.
 * @param {string} root - Absolute directory the path must stay inside.
 * @param {string} relative - Relative (or, hostilely, absolute) path.
 * @returns {string} The absolute path.
 * @throws {Error} With `code: 'EUNSAFEKEY'` when it escapes.
 */
export function resolveWithinRoot(root, relative) {
  const base = path.resolve(root);
  const abs = path.resolve(base, String(relative));
  if (!abs.startsWith(base + path.sep)) throw unsafeKey('storage key resolves outside the project store');
  return abs;
}

/**
 * The refusal every gate throws, carrying a `code` so a route can answer 400/404 instead
 * of leaking a path in a 500.
 * @param {string} message @returns {Error}
 */
function unsafeKey(message) {
  const err = new Error(`[project-storage] ${message}`);
  /** @type {any} */ (err).code = 'EUNSAFEKEY';
  return err;
}

/**
 * Open the blob store for a data directory.
 *
 * @param {{ baseDir: string }} deps - `baseDir` is handed to resolveDataDir, exactly as
 *   the SQLite stores hand it to getDb, so rows and bytes always land on one volume.
 * @returns {{
 *   projectsRoot: () => string,
 *   keyFor: (arg: { projectId: string, kind: string, id: string, ext: string }) => string,
 *   absolutePathFor: (key: string) => string,
 *   projectDir: (projectId: string) => string,
 *   write: (key: string, buffer: Buffer | Uint8Array) => Promise<{ key: string, bytes: number }>,
 *   read: (key: string) => Promise<Buffer>,
 *   remove: (key: string) => Promise<boolean>,
 *   removeProject: (projectId: string) => Promise<boolean>,
 *   removeProjectSync: (projectId: string) => boolean,
 *   stat: (key: string) => Promise<{ bytes: number, mtimeMs: number } | null>,
 * }} The blob-store API.
 */
export function createProjectStorage({ baseDir }) {
  /**
   * `<dataDir>/projects`, created on demand. mkdirSync is a no-op on an existing directory,
   * so this both creates and validates in one syscall; a failure is logged and the path
   * still returned, matching lib/image/hosted-images.js — a write against it fails loudly
   * on its own, and throwing from a path helper would take down callers that only wanted
   * to name a file.
   * @returns {string} Absolute path.
   */
  function projectsRoot() {
    const dir = path.join(resolveDataDir(baseDir), 'projects');
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {
        logger.error('[project-storage] failed to create the projects dir', e);
      }
    }
    return dir;
  }

  /**
   * THE one place a key becomes a filesystem path — see THE LAYOUT in the header. The
   * leading `projects/` segment is stripped because it IS `projectsRoot()`; resolving the
   * raw key against that root is the doubling bug this function exists to make impossible.
   * @param {string} keyish - A full storage key, or the `projects/<projectId>` prefix of one.
   * @returns {string} Absolute path, verified to sit inside projectsRoot().
   */
  function resolveKey(keyish) {
    const s = String(keyish);
    if (!s.startsWith(KEY_PREFIX)) throw unsafeKey(`key must start with ${KEY_PREFIX}`);
    return resolveWithinRoot(projectsRoot(), s.slice(KEY_PREFIX.length));
  }

  /**
   * Build the canonical relative key for one blob. POSIX separators always, on every
   * platform, because this string is persisted: a key written on Windows has to resolve on
   * Render's Linux disk. Throws rather than returning a bad key — a caller that gets this
   * wrong would otherwise persist an unservable `storage_key` and only find out when
   * somebody asked for the image back.
   * @param {{ projectId: string, kind: string, id: string, ext: string }} arg - `kind` is
   *   'src' (an uploaded photo) or 'out' (a render); `ext` may carry a leading dot or not.
   * @returns {string} e.g. `projects/<pid>/src/<photoId>.webp`
   */
  function keyFor({ projectId, kind, id, ext }) {
    const cleanExt = String(ext == null ? '' : ext).replace(/^\.+/, '').toLowerCase();
    const key = `${KEY_PREFIX}${String(projectId).toLowerCase()}/${kind}/${String(id).toLowerCase()}.${cleanExt}`;
    if (!STORAGE_KINDS.includes(kind) || !isSafeStorageKey(key)) {
      throw unsafeKey(`refusing to build a key from ${JSON.stringify({ projectId, kind, id, ext })}`);
    }
    return key;
  }

  /**
   * The absolute path for a stored key, through both gates.
   * @param {string} key - Relative storage key.
   * @returns {string} Absolute path on the data volume.
   * @throws {Error} `code: 'EUNSAFEKEY'` for anything that fails either gate.
   */
  function absolutePathFor(key) {
    if (!isSafeStorageKey(key)) throw unsafeKey('unsafe project storage key');
    return resolveKey(key);
  }

  /**
   * The directory holding one project's blobs — the same resolution `absolutePathFor` uses,
   * which is the whole point (see the header).
   * @param {string} projectId - Hex project id.
   * @returns {string} Absolute path to `<dataDir>/projects/<projectId>`.
   */
  function projectDir(projectId) {
    const id = String(projectId).toLowerCase();
    if (!PROJECT_ID_PATTERN.test(id)) throw unsafeKey('unsafe project id');
    return resolveKey(`${KEY_PREFIX}${id}`);
  }

  /**
   * Write one blob, creating `src/`/`out/` on the way.
   * @param {string} key - Relative storage key. @param {Buffer | Uint8Array} buffer - The bytes.
   * @returns {Promise<{ key: string, bytes: number }>} The key back (so callers can persist
   *   it straight into `storage_key`) and the byte count.
   */
  async function write(key, buffer) {
    const abs = absolutePathFor(key);
    if (!buffer || typeof (/** @type {any} */ (buffer).length) !== 'number') {
      throw new TypeError('[project-storage] write needs a Buffer or Uint8Array');
    }
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, buffer);
    return { key, bytes: buffer.length };
  }

  /**
   * Read one blob.
   * @param {string} key - Relative storage key.
   * @returns {Promise<Buffer>} The bytes. Rejects with ENOENT when the blob is gone (a row
   *   can outlive its file — the caller decides what that means) and with `EUNSAFEKEY`
   *   when the key is not one of ours.
   */
  async function read(key) {
    return fs.promises.readFile(absolutePathFor(key));
  }

  /**
   * Delete one blob. Idempotent: a missing file is a success, because "make sure this is
   * gone" is what every caller actually wants.
   * @param {string} key - Relative storage key.
   * @returns {Promise<boolean>} True when a file was actually deleted.
   */
  async function remove(key) {
    try {
      await fs.promises.unlink(absolutePathFor(key));
      return true;
    } catch (e) {
      if (/** @type {any} */ (e)?.code === 'ENOENT') return false;
      throw e;
    }
  }

  /**
   * Delete every blob of one project, source photos and renders together.
   *
   * The row-side counterpart is `deleteProject` in projects.js; neither calls the other,
   * because the rows go in a synchronous SQLite transaction and this is async filesystem
   * work that must not hold the write lock. Callers do both.
   * @param {string} projectId - Hex project id.
   * @returns {Promise<boolean>} True once the directory is gone (idempotent — an
   *   already-absent project is also true).
   */
  async function removeProject(projectId) {
    await fs.promises.rm(projectDir(projectId), { recursive: true, force: true });
    return true;
  }

  /**
   * The synchronous twin of `removeProject`, for `deleteUser` in lib/data/user-deletion.js:
   * an account erasure is a synchronous transaction and cannot await. It lives HERE rather
   * than in server.js's wiring so the path resolution stays in the one module that owns the
   * layout — a caller re-deriving `<dataDir>/projects/<id>` for itself is precisely the
   * mistake the header describes.
   * @param {string} projectId - Hex project id.
   * @returns {boolean} True once the directory is gone (idempotent).
   */
  function removeProjectSync(projectId) {
    fs.rmSync(projectDir(projectId), { recursive: true, force: true });
    return true;
  }

  /**
   * Size and mtime of one blob, or null when it is not there.
   * @param {string} key - Relative storage key.
   * @returns {Promise<{ bytes: number, mtimeMs: number } | null>}
   */
  async function stat(key) {
    try {
      const st = await fs.promises.stat(absolutePathFor(key));
      return { bytes: st.size, mtimeMs: st.mtimeMs };
    } catch (e) {
      if (/** @type {any} */ (e)?.code === 'ENOENT') return null;
      throw e;
    }
  }

  return {
    projectsRoot, keyFor, absolutePathFor, projectDir,
    write, read, remove, removeProject, removeProjectSync, stat,
  };
}
