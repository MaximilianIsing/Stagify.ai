// Every table the gallery owns, in one place.
//
// WHY ONE SCHEMA MODULE RATHER THAN ONE PER STORE
// The same reason auth-store.js holds the CREATE TABLE for `sessions` and
// `password_reset_tokens` while session-tokens.js owns their queries: these tables
// reference each other across store boundaries. The eviction query in
// staged-renders.js has to know whether a render has a live share, which lives in
// `gallery_shares`; the reference sweep in render-refs.js reads `render_refs`. If each
// factory created only its own tables, construction ORDER would become load-bearing —
// open the wrong store first and better-sqlite3 throws "no such table" at boot, which
// is exactly the trap lib/data/user-deletion.js documents avoiding.
//
// So: one `exec` that every gallery store calls, `IF NOT EXISTS` so the second and
// third calls are free. Indexes live beside the statements that need them, in the
// module that owns those queries.
//
// THERE ARE NO FOREIGN KEYS, and that is deliberate and enforced —
// test/data/db.test.js fails the build on one. It is also why every table below
// carries `user_id` even where it is derivable: that column is what makes the GDPR
// drift guard in test/data/user-deletion.test.js SEE the table. The parked Listing
// Studio's child tables were invisible to that guard precisely because they had none.
//
// There is no migration runner either (a documented tradeoff — see
// docs/reference/data-stores.md), so a new field rides in `extra_json` rather than a
// new column, and anything that truly needs a column gets an `ALTER TABLE` guarded by
// a `PRAGMA table_info` check.

/**
 * The gallery's tables. Exec'd by every gallery store factory.
 *
 * `staged_renders.status` is `pending` until the bytes land in the object store, then
 * `ok`. The manifest builders filter on `ok`, so a render whose upload failed is simply
 * absent from the gallery rather than a broken image — one predicate, used by both the
 * owner's list and the public share, so the listed set and the servable set cannot drift.
 *
 * `evicted_at` is a soft delete. The row stays so the free-tier notice can say what was
 * removed; the BYTES are tombstoned in the same transaction that sets it.
 */
export const GALLERY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS staged_renders (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending',
    width             INTEGER,
    height            INTEGER,
    room_type         TEXT,
    furniture_style   TEXT,
    additional_prompt TEXT,
    remove_furniture  INTEGER NOT NULL DEFAULT 0,
    model             TEXT,
    variation         INTEGER NOT NULL DEFAULT 0,
    batch_id          TEXT,
    evicted_at        INTEGER,
    extra_json        TEXT
  );

  CREATE TABLE IF NOT EXISTS render_blobs (
    render_id   TEXT NOT NULL,
    role        TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    bytes       INTEGER NOT NULL DEFAULT 0,
    user_id     TEXT NOT NULL,
    PRIMARY KEY (render_id, role)
  );

  CREATE TABLE IF NOT EXISTS ref_objects (
    ref_hash    TEXT PRIMARY KEY,
    storage_key TEXT NOT NULL,
    bytes       INTEGER NOT NULL DEFAULT 0,
    width       INTEGER,
    height      INTEGER,
    created_at  INTEGER NOT NULL,
    user_id     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS render_refs (
    render_id TEXT NOT NULL,
    seq       INTEGER NOT NULL,
    ref_hash  TEXT NOT NULL,
    user_id   TEXT NOT NULL,
    PRIMARY KEY (render_id, seq)
  );

  CREATE TABLE IF NOT EXISTS gallery_shares (
    token_hash     TEXT PRIMARY KEY,
    render_id      TEXT NOT NULL,
    user_id        TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    expires_at     INTEGER,
    revoked_at     INTEGER,
    view_count     INTEGER NOT NULL DEFAULT 0,
    last_viewed_at INTEGER,
    settings_json  TEXT
  );

  -- No rowid in the index: SQLite rejects it as a column here ("no such column: rowid"),
  -- even though the eviction ORDER BY uses it as a tiebreaker. That tiebreak only has to
  -- make the order TOTAL — two renders in the same millisecond must not be able to swap
  -- places between the SELECT and the next one — so it costs a sort on a handful of ties
  -- rather than needing to be covered.
  CREATE INDEX IF NOT EXISTS idx_sr_user     ON staged_renders (user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sr_status   ON staged_renders (status, created_at);
  CREATE INDEX IF NOT EXISTS idx_rb_user     ON render_blobs (user_id);
  CREATE INDEX IF NOT EXISTS idx_ro_user     ON ref_objects (user_id);
  CREATE INDEX IF NOT EXISTS idx_rr_hash     ON render_refs (ref_hash);
  CREATE INDEX IF NOT EXISTS idx_rr_user     ON render_refs (user_id);
  CREATE INDEX IF NOT EXISTS idx_gs_render   ON gallery_shares (render_id);
  CREATE INDEX IF NOT EXISTS idx_gs_user     ON gallery_shares (user_id);
`;

/**
 * Add a column to an existing table, once.
 *
 * There is no migration runner, so this is the escape hatch for the rare field that
 * genuinely cannot ride in `extra_json` — one that has to be readable from SQL, like
 * `users.gallery_grace_until`, which the eviction query consults. Guarded by
 * `PRAGMA table_info` rather than a try/catch, so a real error is not swallowed along
 * with the expected "duplicate column name".
 *
 * @param {{ prepare: (sql: string) => any, exec: (sql: string) => any }} db - Shared connection.
 * @param {string} table - Table to extend.
 * @param {string} column - Column name.
 * @param {string} definition - SQL type and default, e.g. `INTEGER`.
 * @returns {boolean} True when the column was added by this call.
 */
export function ensureColumn(db, table, column, definition) {
  // A missing TABLE is not an error here. `users` is created by createAuthStore, and the
  // gallery stores must be constructible without it — a route test that mounts only the
  // gallery, or any construction order that opens this store first, would otherwise fail
  // at boot with "no such table". The column lands on the next open once the owning
  // store has run.
  if (!tableExists(db, table)) return false;
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (existing.includes(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

/**
 * Does this table exist yet?
 * @param {{ prepare: (sql: string) => any }} db @param {string} table @returns {boolean}
 */
export function tableExists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}
