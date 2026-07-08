import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

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

// Open a better-sqlite3 handle with the pragmas we want everywhere.
// WAL + NORMAL is the standard durable-yet-fast combo for a single-writer app;
// busy_timeout stops transient "database is locked" errors under brief contention.
export function openDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}
