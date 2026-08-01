// The single rule for "where does durable state live on disk".
//
// Render mounts a persistent disk at /data; everywhere else (local dev, CI, the
// test harness) state goes in <baseDir>/data. That rule used to be copy-pasted
// inline at ten call sites — the SQLite file, the uptime JSON, the counter seeds,
// and every CSV writer each re-derived it, three of them inside the very file
// that already exported a resolver for it. Any change to the storage layout had
// to be made ten times or not at all, and a miss would silently split state
// across two directories.
//
// It lives in its own module rather than in db.js so the CSV/log writers can use
// it without importing better-sqlite3.
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';

// The resolved directory is stable for the life of the process, but the mkdir
// fallback below can differ per baseDir, so memoize the *log line* rather than
// the result: callers pass different baseDirs (repo root vs lib/services) and
// each still resolves independently.
let announced = false;

// Where Render mounts the persistent disk. Exported and injectable purely so the
// tests can drive both sides of the mount check against a path they control: the
// literal '/data' is real on some dev machines (on Windows it resolves to
// C:\data), which used to make the "not mounted" test unobservable and skip.
// Production always takes the default.
export const RENDER_DISK_MOUNT = '/data';

/**
 * Resolve the directory durable state lives in, creating it if needed.
 *
 * On Render (`RENDER` set and the disk actually mounted) this is the persistent
 * disk at `/data`. Otherwise it is `<baseDir>/data`, created on demand. If that
 * directory cannot be created the caller gets `baseDir` itself — writing beside
 * the app is wrong but recoverable; crashing the boot over a log directory is not.
 *
 * @param {string} baseDir - Root to resolve `data/` against when not on Render.
 * @param {string} [mountPath] - Render disk mount point; tests only, defaults to `/data`.
 * @returns {string} Absolute path to the data directory.
 */
export function resolveDataDir(baseDir, mountPath = RENDER_DISK_MOUNT) {
  if (process.env.RENDER && fs.existsSync(mountPath)) {
    if (!announced) {
      announced = true;
      logger.debug(`[data-dir] Using Render persistent disk at ${mountPath}`);
    }
    return mountPath;
  }
  // An explicit override, checked AFTER the Render branch so production can never take it.
  //
  // This exists for one reason: the e2e/boot suites spawn EIGHT separate `server.js`
  // processes, and with no override every one of them opened the same
  // `<repo>/data/auth-store.db`. Under load that intermittently killed a boot outright —
  // `SqliteError: disk I/O error` (and, before the pragma reorder, SQLITE_BUSY) out of
  // `applyPragmas`, which surfaced in the suite as a bare `TypeError: fetch failed` in a
  // DIFFERENT file each run, because the server the test was about had died before
  // listening. `npm test` gates the deploy, so that was an intermittently red deploy gate.
  //
  // It also stopped those tests writing to the developer's real database, which they had
  // been doing all along.
  const override = String(process.env.STAGIFY_DATA_DIR || '').trim();
  if (override) {
    try {
      fs.mkdirSync(override, { recursive: true });
      return override;
    } catch {
      // An unusable override falls through to the normal path rather than failing the boot.
    }
  }
  const dir = path.join(baseDir, 'data');
  try {
    // mkdirSync is a no-op on an existing directory, so this both creates and
    // validates in one syscall. An existsSync check would not: something that is
    // not a directory at that path (a stray `data` FILE) passes existsSync and
    // would then be handed back as a log destination, and every write against it
    // would fail. Here it throws ENOTDIR/EEXIST and takes the fallback below.
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Last resort: keep the data beside the app rather than fail the write.
    return baseDir;
  }
  return dir;
}
