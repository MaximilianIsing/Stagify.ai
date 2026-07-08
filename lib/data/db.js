import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// Historical filename — now the single application database (auth + enterprise +
// memories + uptime all live here, one file so one Litestream stream backs up
// the entire durable state).
const DB_FILENAME = 'auth-store.db';

// Resolve the directory the data lives in — the SAME rule the legacy JSON stores
// used, so the SQLite file sits next to (and can import from) the old *.json:
//   Render: the mounted persistent disk at /data
//   local : <baseDir>/data
export function resolveDataDir(baseDir) {
  const dir =
    process.env.RENDER && fs.existsSync('/data') ? '/data' : path.join(baseDir, 'data');
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      return baseDir; // last-resort: keep the DB beside the app rather than crash
    }
  }
  return dir;
}

// WAL + NORMAL is the standard durable-yet-fast combo for a single-writer app;
// busy_timeout stops transient "database is locked" errors under brief contention.
function applyPragmas(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
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
