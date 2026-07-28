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

/**
 * Resolve the directory durable state lives in, creating it if needed.
 *
 * On Render (`RENDER` set and the disk actually mounted) this is the persistent
 * disk at `/data`. Otherwise it is `<baseDir>/data`, created on demand. If that
 * directory cannot be created the caller gets `baseDir` itself — writing beside
 * the app is wrong but recoverable; crashing the boot over a log directory is not.
 *
 * @param {string} baseDir - Root to resolve `data/` against when not on Render.
 * @returns {string} Absolute path to the data directory.
 */
export function resolveDataDir(baseDir) {
  if (process.env.RENDER && fs.existsSync('/data')) {
    if (!announced) {
      announced = true;
      logger.debug('[data-dir] Using Render persistent disk at /data');
    }
    return '/data';
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
