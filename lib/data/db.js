import Database from 'better-sqlite3';
import path from 'path';
import { resolveDataDir } from './data-dir.js';

// Historical filename — now the single application database (auth + enterprise +
// memories + uptime all live here, one file so one Litestream stream backs up
// the entire durable state).
const DB_FILENAME = 'auth-store.db';

// The data directory rule lives in data-dir.js so the CSV/log writers can share it
// without importing this module (and better-sqlite3 with it). It is imported rather
// than re-exported straight through because dbPath() below calls it, and
// `export … from` would create no local binding. Re-exported because the stores have
// always reached for it via db.js, the natural import for anything that also wants
// getDb/closeDb.
export { resolveDataDir };

// WAL + NORMAL is the standard durable-yet-fast combo for a single-writer app;
// busy_timeout stops transient "database is locked" errors under brief contention.
//
// Deliberately NOT set: `foreign_keys = ON`. It was redundant twice over. No
// table in this database declares a REFERENCES clause, so there was nothing to
// enforce — and better-sqlite3 enables the pragma on every connection anyway, so
// the line never changed a setting either. All it did was read as though
// referential integrity were guaranteed here. Enforcement therefore stays ON (the
// driver's default); we simply stop restating it.
//
// If FKs are ever wanted — sessions.user_id and password_reset_tokens.user_id are
// the obvious candidates — declare the constraints and note that SQLite cannot add
// one to an existing table: each needs a rebuild via the 12-step ALTER procedure.
// A guard in test/data/db.test.js fails if a table gains an FK, so this comment
// cannot quietly go stale.
/**
 * The pragmas every connection gets, IN ORDER. A list rather than three statements so the
 * order is a value a test can assert on — see the note in `applyPragmas` for why the order
 * is load-bearing, and `test/data/db.test.js` for the guard.
 */
export const PRAGMAS = Object.freeze([
  'busy_timeout = 5000',
  'journal_mode = WAL',
  'synchronous = NORMAL',
]);

/**
 * Apply the connection pragmas, in `PRAGMAS` order.
 *
 * Exported ONLY so `test/data/db.test.js` can drive it with a recording fake and assert the
 * order that is actually applied — asserting the order of the `PRAGMAS` array alone would
 * still pass if someone reintroduced three hand-written `db.pragma(...)` calls beside it.
 * @param {{ pragma: (source: string) => unknown }} db - A better-sqlite3 connection, or any recorder.
 * @returns {any} The same connection.
 */
export function applyPragmas(db) {
  // busy_timeout FIRST, and the order is load-bearing — it is not stylistic.
  //
  // A connection's busy timeout is 0 until this line runs, so any pragma before it FAILS
  // IMMEDIATELY on contention instead of waiting. `journal_mode = WAL` is precisely the
  // statement that contends: switching journal modes needs a moment of exclusive access, so
  // a second process touching the file at that instant makes it throw SQLITE_BUSY.
  //
  // That is not theoretical. With WAL first, a boot that overlapped another process
  // — a deploy while the old instance is still draining, a Litestream restore, an operator
  // with `sqlite3` open, or (how this was found) several test servers starting at once —
  // died at startup with an unhandled SqliteError from `pragma.js` rather than waiting the
  // five seconds it was already configured to wait. Reordering makes the timeout cover the
  // statement it exists for.
  for (const pragma of PRAGMAS) db.pragma(pragma);
  return db;
}

// Low-level: open a fresh connection at an explicit path.
export function openDb(dbPath) {
  return applyPragmas(new Database(dbPath));
}

export function dbPathFor(baseDir) {
  return path.join(resolveDataDir(baseDir), DB_FILENAME);
}

// Shared, memoized connection to the single application database for a data dir.
// Every store (auth, enterprise, memory, uptime) shares ONE connection per data
// dir — exactly right for synchronous better-sqlite3, and it means cross-store
// state lives in one file with one backup target. The `meta` table (used by the
// stores' one-time JSON-import guards) is guaranteed to exist here.
const handles = new Map();
export function getDb(baseDir) {
  const dbPath = dbPathFor(baseDir);
  const existing = handles.get(dbPath);
  if (existing && existing.open) return existing;
  const db = applyPragmas(new Database(dbPath));
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  handles.set(dbPath, db);
  return db;
}

// Close and forget the shared connection for a data dir (idempotent). Used by
// tests so Windows can unlink the temp .db/-wal/-shm files.
export function closeDb(baseDir) {
  const dbPath = dbPathFor(baseDir);
  const db = handles.get(dbPath);
  if (db) {
    handles.delete(dbPath);
    try {
      if (db.open) db.close();
    } catch {
      /* already closed */
    }
  }
}
