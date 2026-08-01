// The orphan-blob sweep — the thing `routes/projects.js` promised existed.
//
// WHY IT HAD TO BE WRITTEN
// Deleting a listing removes its ROWS first and its BLOBS second, and that order is
// deliberate (a failed unlink must not leave rows the user can still see pointing at files
// that are gone). The comment justifying it said the resulting leak was "findable,
// sweepable" — and nothing swept. Every failed unlink, every process killed between the two
// steps, and every render that landed after its row vanished left megabytes on the volume
// with nothing referencing them, forever. On a 20 GB Render disk holding customers' property
// photographs that is not a tidiness problem: it is the disk filling up, and then a broker
// who cannot upload.
//
// WHAT IT IS SAFE TO DELETE, AND HOW THAT IS DECIDED
// A blob is an orphan when NO row references its key. The set of live keys is read from the
// database in one pass (`project_photos.storage_key` and `renders.storage_key`), and every
// file under `<dataDir>/projects/` that is not in that set is a candidate.
//
// THE RACE IS THE WHOLE PROBLEM, and it is why `minAgeMs` exists. A render in flight writes
// its blob BEFORE `completeRender` writes the row — so between those two moments the file is
// on disk with no row pointing at it, and is indistinguishable from an orphan. A sweep with
// no age floor would delete the render a customer is waiting for. So a candidate must also
// be OLDER than `minAgeMs` (default one hour, far beyond any single render) before it is
// touched. That check is on the file's own mtime, not on a clock this module keeps, so it
// survives a restart mid-sweep.
//
// DRY RUN BY DEFAULT. `sweep()` reports what it would remove and removes nothing unless
// `apply: true`. An operator should be able to see the number before anything is deleted,
// and the admin route exposes both.
//
// IT NEVER WALKS OUTSIDE THE PROJECTS ROOT. Paths come from `readdir` beneath
// `projectsRoot()`, and each candidate is re-checked with the storage module's own
// `isSafeStorageKey` before deletion — the same predicate the byte routes trust. A directory
// that does not match the layout is reported and skipped, never recursed into blindly.
import fs from 'fs';
import path from 'path';
import { getDb } from './db.js';
import { resolveDataDir } from './data-dir.js';
import { isSafeStorageKey, KEY_PREFIX, STORAGE_KINDS } from './project-storage.js';
import { logger } from '../logger.js';

/**
 * How old an unreferenced file must be before the sweep will remove it.
 *
 * One hour. A render's write-then-record window is seconds; an hour is three orders of
 * magnitude of headroom and still short enough that a leak is reclaimed the same day. Lower
 * it and the sweep starts racing live renders — that is the failure this constant prevents.
 */
export const DEFAULT_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * @typedef {Object} SweepReport
 * @property {number} scanned Files examined under the projects root.
 * @property {number} orphans Unreferenced files old enough to remove.
 * @property {number} removed Files actually removed (0 on a dry run).
 * @property {number} bytes Bytes the orphans occupy.
 * @property {number} tooYoung Unreferenced but inside `minAgeMs` — a render may be mid-flight.
 * @property {number} skipped Entries that did not match the storage layout; reported, never deleted.
 * @property {string[]} sample Up to 20 orphan keys, so an operator can eyeball before applying.
 */

/**
 * Every storage key the database still references.
 *
 * Both columns in one pass, because a sweep that read them at different times could see a
 * photo deleted between the two queries and treat its render's source as unreferenced.
 * @param {import('better-sqlite3').Database} db - The shared connection.
 * @returns {Set<string>} Live keys, lowercased for comparison.
 */
export function liveKeys(db) {
  /** @type {Set<string>} */
  const keys = new Set();
  // `rows` is `unknown[]` off better-sqlite3, so the shape is read defensively rather than
  // asserted — a NULL or a column that stopped existing must not throw mid-sweep.
  const add = (/** @type {unknown[]} */ rows) => {
    for (const row of rows) {
      const value = row && typeof row === 'object' ? /** @type {Record<string, unknown>} */ (row).storage_key : null;
      const key = value ? String(value).toLowerCase() : '';
      if (key) keys.add(key);
    }
  };
  add(db.prepare('SELECT storage_key FROM project_photos WHERE storage_key IS NOT NULL').all());
  add(db.prepare('SELECT storage_key FROM renders WHERE storage_key IS NOT NULL').all());
  return keys;
}

/**
 * Build the sweeper.
 * @param {{ baseDir: string, now?: () => number }} deps - Data dir root, and an injectable clock.
 */
export function createProjectBlobGc({ baseDir, now = Date.now }) {
  const root = () => path.join(resolveDataDir(baseDir), 'projects');

  /**
   * Walk the projects root and report — or remove — every unreferenced blob.
   *
   * @param {{ apply?: boolean, minAgeMs?: number, sampleLimit?: number }} [opts] - `apply`
   *   defaults to FALSE: this reports by default and deletes only when asked.
   * @returns {Promise<SweepReport>} What was found, and what was done about it.
   */
  async function sweep(opts = {}) {
    const apply = opts.apply === true;
    const minAgeMs = typeof opts.minAgeMs === 'number' && opts.minAgeMs >= 0 ? opts.minAgeMs : DEFAULT_MIN_AGE_MS;
    const sampleLimit = typeof opts.sampleLimit === 'number' ? Math.max(0, opts.sampleLimit) : 20;

    /** @type {SweepReport} */
    const report = { scanned: 0, orphans: 0, removed: 0, bytes: 0, tooYoung: 0, skipped: 0, sample: [] };
    const dir = root();
    if (!fs.existsSync(dir)) return report;

    const live = liveKeys(getDb(baseDir));
    const cutoff = now() - minAgeMs;

    // One level of project directories, then the two known kinds. Deliberately NOT a
    // recursive walk: the layout is fixed (projects/<id>/{src,out}/<file>), and anything
    // that does not fit it is something this module did not create and must not delete.
    const projectDirs = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const projectEntry of projectDirs) {
      if (!projectEntry.isDirectory()) {
        report.skipped += 1;
        continue;
      }
      for (const kind of STORAGE_KINDS) {
        const kindDir = path.join(dir, projectEntry.name, kind);
        const files = await fs.promises.readdir(kindDir, { withFileTypes: true }).catch(() => []);
        for (const fileEntry of files) {
          if (!fileEntry.isFile()) {
            report.skipped += 1;
            continue;
          }
          report.scanned += 1;
          const key = `${KEY_PREFIX}${projectEntry.name}/${kind}/${fileEntry.name}`.toLowerCase();
          if (live.has(key)) continue;
          // Re-check against the storage module's own predicate before deleting anything.
          // A name that cannot be a legal key was not written by this app.
          if (!isSafeStorageKey(key)) {
            report.skipped += 1;
            continue;
          }
          const abs = path.join(kindDir, fileEntry.name);
          const info = await fs.promises.stat(abs).catch(() => null);
          if (!info) continue;
          // The write-then-record window: a blob younger than the floor may be a render
          // whose row is still being written. See the header.
          if (info.mtimeMs > cutoff) {
            report.tooYoung += 1;
            continue;
          }
          report.orphans += 1;
          report.bytes += info.size;
          if (report.sample.length < sampleLimit) report.sample.push(key);
          if (!apply) continue;
          const gone = await fs.promises.unlink(abs).then(() => true).catch((err) => {
            // A file that cannot be unlinked is reported, not fatal — the next sweep
            // retries it, and one locked file must not abandon the rest of the reclaim.
            logger.warn(`[blob-gc] could not remove ${key}:`, err && err.message ? err.message : err);
            return false;
          });
          if (gone) report.removed += 1;
        }
      }
    }

    if (report.orphans) {
      logger.info(`[blob-gc] ${apply ? 'removed' : 'found'} ${apply ? report.removed : report.orphans} orphan blob(s), `
        + `${Math.round(report.bytes / 1024)} KB${report.tooYoung ? `; ${report.tooYoung} too young to touch` : ''}`);
    }
    return report;
  }

  return { sweep };
}
