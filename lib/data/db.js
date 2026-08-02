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
function applyPragmas(db) {
  // ORDER IS LOAD-BEARING: busy_timeout must come FIRST. It is the only setting
  // here that changes how the OTHER statements behave, and `journal_mode = WAL`
  // is the one that needs a brief EXCLUSIVE lock. Set last, busy_timeout was
  // still SQLite's default 0 while WAL ran, so a moment's contention failed
  // instantly with SQLITE_BUSY instead of retrying — the exact case the timeout
  // exists for. That is reachable in production: scripts/start.sh runs the app
  // under `litestream replicate -exec`, so litestream and node hold the same
  // file open, and a restart during a checkpoint threw at boot.
  // test/data/db.test.js asserts the ORDER, not just the final values — end-state
  // assertions passed with these three lines in any arrangement.
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
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
