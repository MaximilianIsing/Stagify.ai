// Listing projects — the durable spine of the multi-photo staging flow.
//
// A "project" is one real-estate listing: a whole shoot, grouped into rooms, staged so that
// every frame of the same room shows the SAME furniture. Four tables:
//   projects       one listing, owned by a user.
//   project_shares the public client links into it (lib/data/project-shares.js — composed
//                  in here, and exposed as `.shares`, so that its rows are DELETED BY THE
//                  SAME TRANSACTION as the listing they publish; a share that outlives its
//                  project is not a stray row, it is a live URL into deleted data).
//   project_photos the uploaded frames. Each carries a room and a `frame_role`: exactly one
//                  'hero' per room (the frame the room's look is authored from), the rest
//                  'support' (staged to match it), plus 'excluded' for frames kept unstaged.
//   design_bibles  the versioned per-room description of that look — palette, lighting and
//                  the individual pieces, pinned down precisely enough to reproduce.
//   renders        one row per (photo, variation) attempt. Its lease-based queue lives in
//                  lib/data/project-renders.js and is composed back into this store's API,
//                  so callers see one object; the schema for it is still created here.
//
// THE BIBLE BARRIER. A support frame must not be rendered before its room's bible exists,
// or it is staged against nothing and shows different furniture from the hero. That rule
// lives inside `claimNextRender`'s single UPDATE statement (project-renders.js) rather than
// in the JS around it, because the queue outlives the process — read the long note there
// before changing anything about the queue.
//
// NO FOREIGN KEYS. Nothing here declares a REFERENCES clause; that is the standing rule for
// this database (the note in lib/data/db.js, pinned by test/data/db.test.js, which fails the
// build if a table gains one). Every parent/child delete is therefore spelled out EXPLICITLY
// inside a db.transaction — `deleteProject`, `deleteProjectsForUser`, `deletePhoto` — exactly
// as lib/data/user-deletion.js does for accounts. Add a table here and you must add it to
// those three.
//
// BYTES LIVE ELSEWHERE. Photos and renders point at their pixels through a relative
// `storage_key` into lib/data/project-storage.js. The row deletes here do NOT remove blobs —
// they can't: SQLite work here is synchronous and blob removal is async fs work that must not
// hold the write lock. So `deletePhoto` returns the keys it orphaned, and `deleteProject`'s
// caller pairs it with `storage.removeProject` (or `removeProjectSync`, which is what account
// erasure uses).
//
// TIMESTAMPS are epoch-ms INTEGER throughout, following `referral_links` rather than `users`'
// ISO text: every read is then a numeric comparison (a lease that expired before `now`). Every
// mutator takes an injectable `now`, so tests are deterministic.
import crypto from 'crypto';
import { getDb } from './db.js';
import { logger } from '../logger.js';
import { createProjectRenders } from './project-renders.js';
import { createProjectShares } from './project-shares.js';
import { createShareFeedback } from './share-feedback.js';

/** @typedef {import('../types/projects.js').Project} Project */
/** @typedef {import('../types/projects.js').ProjectPhoto} ProjectPhoto */
/** @typedef {import('../types/projects.js').DesignBibleRow} DesignBibleRow */

// Re-exported so the render-queue constants stay importable from the store's front door.
export { RENDER_STATUSES, DEFAULT_LEASE_MS } from './project-renders.js';

/** Mirror the CHECK constraints below, exported so routes and tests share one list. */
export const PROJECT_STATUSES = Object.freeze(['draft', 'staging', 'ready', 'archived']);
export const FRAME_ROLES = Object.freeze(['hero', 'support', 'excluded']);

/** Page-size ceiling for listProjects, so a bad caller cannot ask for everything. */
export const MAX_LIST_LIMIT = 200;

/**
 * 16 random bytes as 32 lowercase hex characters. Hex rather than base64url because these ids
 * become path segments in a `storage_key`, and STORAGE_KEY_PATTERN in project-storage.js
 * accepts only `[a-f0-9]`. Exported so tests can assert the shape. @returns {string}
 */
export function newId() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Parse a JSON column, degrading to null rather than throwing: an unparseable `doc_json`
 * deserves an operator's attention but must not take down a whole project listing.
 * @param {string | null | undefined} text @param {string} label @returns {any}
 */
export function parseJsonColumn(text, label) {
  if (text == null || text === '') return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    logger.warn(`[projects] unparseable ${label}:`, e && e.message ? e.message : e);
    return null;
  }
}

/**
 * Coerce a value for a SQLite bind: better-sqlite3 refuses `undefined` and booleans outright,
 * and both turn up constantly in patch objects.
 * @param {unknown} value @returns {string | number | Buffer | null}
 */
export function toDbValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value;
  return String(value);
}

/**
 * Patchable columns, keyed by their camelCase API name. These maps are the ONLY source of
 * column names for the generated UPDATEs — a caller-supplied key that is not in the map is
 * dropped rather than interpolated, so `updatePhoto` cannot be talked into writing a column
 * (or SQL) of the caller's choosing.
 */
const PROJECT_PATCH_COLUMNS = Object.freeze({ title: 'title', address: 'address', status: 'status', extraJson: 'extra_json' });
const PHOTO_PATCH_COLUMNS = Object.freeze({
  roomKey: 'room_key', roomType: 'room_type', frameRole: 'frame_role',
  stageable: 'stageable', unstageableCode: 'unstageable_code', seq: 'seq',
});

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','staging','ready','archived')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, extra_json TEXT
  );
  -- The dashboard's only query: this user's listings, most recently touched first.
  CREATE INDEX IF NOT EXISTS idx_projects_user_updated ON projects (user_id, updated_at DESC);

  -- No REFERENCES on project_id: this database declares no foreign keys (see the note in
  -- lib/data/db.js) — deleteProject/deletePhoto cascade explicitly instead.
  CREATE TABLE IF NOT EXISTS project_photos (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, storage_key TEXT NOT NULL,
    seq INTEGER NOT NULL, room_key TEXT, room_type TEXT,
    frame_role TEXT NOT NULL DEFAULT 'support' CHECK (frame_role IN ('hero','support','excluded')),
    width INTEGER, height INTEGER, ar_label TEXT, stageable INTEGER, unstageable_code TEXT,
    sha256 TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_photos_project_seq  ON project_photos (project_id, seq);
  CREATE INDEX IF NOT EXISTS idx_photos_project_room ON project_photos (project_id, room_key);
  -- The dedup key: re-uploading a shoot must not double every photo, and this index is what
  -- makes addPhoto's duplicate answer authoritative rather than a race.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_photos_project_sha ON project_photos (project_id, sha256);

  -- No REFERENCES on project_id/hero_render_id, same rule as above (db.js); deleteProject
  -- removes these rows explicitly.
  CREATE TABLE IF NOT EXISTS design_bibles (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, room_key TEXT NOT NULL,
    version INTEGER NOT NULL, hero_render_id TEXT, doc_json TEXT NOT NULL,
    furniture_style TEXT NOT NULL, room_type TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  -- Versions are per room and never reused, so createBible's auto-increment cannot quietly
  -- produce two v3s for one room.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_bibles_project_room_version ON design_bibles (project_id, room_key, version);

  -- No REFERENCES on project_id/photo_id/bible_id, same rule as above (db.js); deleteProject
  -- and deletePhoto remove these rows explicitly, and claimNextRender's JOIN is what keeps an
  -- orphaned render inert instead of dequeuing it into a crash.
  CREATE TABLE IF NOT EXISTS renders (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, photo_id TEXT NOT NULL, bible_id TEXT,
    variation INTEGER NOT NULL DEFAULT 1, storage_key TEXT,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ok','failed','superseded')),
    prompt_text TEXT, model TEXT, gen_attempts INTEGER NOT NULL DEFAULT 0,
    quality_score INTEGER, consistency_score INTEGER, error_code TEXT, duration_ms INTEGER,
    claimed_at INTEGER, created_at INTEGER NOT NULL, extra_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_renders_project_created ON renders (project_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_renders_photo_variation ON renders (photo_id, variation);
  -- Serves both the claim (status='queued', FIFO) and lease reclamation.
  CREATE INDEX IF NOT EXISTS idx_renders_status_claimed  ON renders (status, claimed_at);
`;

/**
 * Open the listing-project store against the shared application database.
 * @param {string} baseDir - Repo/base dir, resolved to the data dir by db.js — the same
 *   argument `createProjectStorage` takes, so rows and blobs share one volume.
 */
export function createProjects(baseDir) {
  const db = getDb(baseDir);
  db.exec(SCHEMA);

  const q = {
    insertProject: db.prepare("INSERT INTO projects (id, user_id, title, address, status, created_at, updated_at, extra_json) VALUES (?, ?, ?, ?, 'draft', ?, ?, NULL) RETURNING *"),
    getProject: db.prepare('SELECT * FROM projects WHERE id = ?'),
    listProjects: db.prepare('SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?'),
    projectIdsForUser: db.prepare('SELECT id FROM projects WHERE user_id = ?'),
    touchProject: db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?'),
    delProject: db.prepare('DELETE FROM projects WHERE id = ?'),
    delProjectsForUser: db.prepare('DELETE FROM projects WHERE user_id = ?'),
    insertPhoto: db.prepare(`INSERT INTO project_photos
      (id, project_id, storage_key, seq, room_key, room_type, frame_role, width, height, ar_label, stageable, unstageable_code, sha256, created_at)
      VALUES (@id, @project_id, @storage_key, @seq, @room_key, @room_type, @frame_role, @width, @height, @ar_label, @stageable, @unstageable_code, @sha256, @created_at)
      RETURNING *`),
    getPhoto: db.prepare('SELECT * FROM project_photos WHERE id = ?'),
    photoBySha: db.prepare('SELECT * FROM project_photos WHERE project_id = ? AND sha256 = ?'),
    listPhotos: db.prepare('SELECT * FROM project_photos WHERE project_id = ? ORDER BY seq ASC, rowid ASC'),
    nextSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM project_photos WHERE project_id = ?'),
    delPhoto: db.prepare('DELETE FROM project_photos WHERE id = ?'),
    delPhotosForProject: db.prepare('DELETE FROM project_photos WHERE project_id = ?'),
    demoteHeroes: db.prepare("UPDATE project_photos SET frame_role = 'support' WHERE project_id = ? AND room_key IS ? AND frame_role = 'hero' AND id <> ?"),
    promoteHero: db.prepare("UPDATE project_photos SET frame_role = 'hero', room_key = ? WHERE id = ? RETURNING *"),
    insertBible: db.prepare(`INSERT INTO design_bibles
      (id, project_id, room_key, version, hero_render_id, doc_json, furniture_style, room_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`),
    getBible: db.prepare('SELECT * FROM design_bibles WHERE id = ?'),
    latestBible: db.prepare('SELECT * FROM design_bibles WHERE project_id = ? AND room_key = ? ORDER BY version DESC LIMIT 1'),
    listBibles: db.prepare('SELECT * FROM design_bibles WHERE project_id = ? ORDER BY room_key ASC, version ASC'),
    maxBibleVersion: db.prepare('SELECT COALESCE(MAX(version), 0) AS n FROM design_bibles WHERE project_id = ? AND room_key = ?'),
    delBiblesForProject: db.prepare('DELETE FROM design_bibles WHERE project_id = ?'),
    countProjects: db.prepare('SELECT COUNT(*) AS n FROM projects'),
    countPhotos: db.prepare('SELECT COUNT(*) AS n FROM project_photos'),
    countBibles: db.prepare('SELECT COUNT(*) AS n FROM design_bibles'),
  };

  /**
   * One transaction runner instead of a named `db.transaction` constant per call site:
   * better-sqlite3 wants the function shape up front, and every multi-statement write here
   * is a one-off closure over its own arguments. Nesting is safe (savepoints), which is what
   * lets deleteProjectsForUser call deleteProject. Shared with project-renders.js so a
   * cross-table write is ONE transaction.
   */
  const withTxn = db.transaction((/** @type {() => any} */ fn) => fn());

  /** @param {number} now @param {string} projectId @returns {void} */
  const touch = (now, projectId) => void q.touchProject.run(now, String(projectId));

  const renders = createProjectRenders({ db, withTxn, touchProject: touch, newId, toDbValue, parseJsonColumn });

  // Composed rather than constructed separately in server.js, for one reason: the cascade.
  // `getDb` hands back the SAME connection, so a `shares.deleteForProject` call made inside
  // this file's `withTxn` is genuinely inside that transaction — which is the only way a
  // listing and its public links can be guaranteed to die together. Two independent
  // instances would each work, and would leave a window where the rows were gone and the
  // link still resolved.
  const shares = createProjectShares(baseDir);

  // Same reasoning as `shares`: one connection, so the cascade below is genuinely inside
  // this file's transaction. Exposed as `.feedback`.
  const feedback = createShareFeedback(baseDir);

  // ---- Mappers. `row` is deliberately untyped: better-sqlite3 hands back plain objects,
  // and the named shapes live in lib/types/projects.d.ts on the way OUT.

  /** @returns {Project | null} */
  const rowToProject = (row) => (row ? {
    id: row.id, userId: row.user_id, title: row.title || '', address: row.address || '',
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
    extra: parseJsonColumn(row.extra_json, `projects.extra_json for ${row.id}`),
  } : null);

  /** @returns {ProjectPhoto | null} */
  const rowToPhoto = (row) => (row ? {
    id: row.id, projectId: row.project_id, storageKey: row.storage_key, seq: row.seq,
    roomKey: row.room_key ?? null, roomType: row.room_type ?? null, frameRole: row.frame_role,
    width: row.width ?? null, height: row.height ?? null, arLabel: row.ar_label ?? null,
    // Tri-state on purpose: null means "not checked yet", which is NOT "checked and rejected"
    // — the studio shows a spinner for one and a reason for the other, so a `!!row.stageable`
    // here would collapse them.
    stageable: row.stageable == null ? null : row.stageable === 1,
    unstageableCode: row.unstageable_code ?? null, sha256: row.sha256, createdAt: row.created_at,
  } : null);

  /** @returns {DesignBibleRow | null} */
  const rowToBible = (row) => (row ? {
    id: row.id, projectId: row.project_id, roomKey: row.room_key, version: row.version,
    heroRenderId: row.hero_render_id ?? null, furnitureStyle: row.furniture_style,
    roomType: row.room_type, createdAt: row.created_at,
    doc: parseJsonColumn(row.doc_json, `design_bibles.doc_json for ${row.id}`),
  } : null);

  /** @param {any} row @returns {number} */
  const countOf = (row) => (row && typeof row.n === 'number' ? row.n : 0);

  // ---- Projects -------------------------------------------------------------

  /** Create a listing. @param {{ userId?: string, title?: string, address?: string, now?: number }} [arg] @returns {Project} */
  function createProject({ userId, title = '', address = '', now = Date.now() } = {}) {
    const row = q.insertProject.get(newId(), String(userId || ''), String(title || ''), String(address || ''), now, now);
    return /** @type {Project} */ (rowToProject(row));
  }

  /** @param {string} id @returns {Project | null} */
  const getProject = (id) => rowToProject(q.getProject.get(String(id)));

  /**
   * One user's listings, newest activity first — the query the (user_id, updated_at DESC)
   * index exists for. @param {string} userId @param {{ limit?: number, offset?: number }} [opts] @returns {Project[]}
   */
  function listProjects(userId, { limit = 50, offset = 0 } = {}) {
    const take = Math.max(1, Math.min(MAX_LIST_LIMIT, Number(limit) || 50));
    return q.listProjects.all(String(userId), take, Math.max(0, Number(offset) || 0)).map(rowToProject);
  }

  const patchCache = new Map();
  /**
   * Reduce a caller's patch to the columns it may touch, and prepare (once, memoized) the
   * UPDATE for exactly that column set. Unknown keys are dropped silently — see the note on
   * the *_PATCH_COLUMNS maps for why the column names may only come from there.
   * @param {string} table @param {Record<string, string>} allowed @param {Record<string, any>} patch
   * @param {string} [extraSet] Assignment appended verbatim, e.g. `updated_at = @updated_at`.
   * @returns {{ stmt: any, values: Record<string, any> } | null} null when nothing patchable was given.
   */
  function patchFor(table, allowed, patch, extraSet = '') {
    const columns = [];
    /** @type {Record<string, any>} */
    const values = {};
    for (const [key, column] of Object.entries(allowed)) {
      if (!patch || !Object.prototype.hasOwnProperty.call(patch, key)) continue;
      columns.push(column);
      values[column] = toDbValue(patch[key]);
    }
    if (!columns.length) return null;
    const cacheKey = `${table}|${columns.join(',')}|${extraSet}`;
    let stmt = patchCache.get(cacheKey);
    if (!stmt) {
      const sets = columns.map((c) => `${c} = @${c}`);
      if (extraSet) sets.push(extraSet);
      stmt = db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = @id RETURNING *`);
      patchCache.set(cacheKey, stmt);
    }
    return { stmt, values };
  }

  /**
   * Bump `updated_at`. Every write that changes what a listing looks like calls this, so the
   * dashboard's order reflects activity. @param {string} id @param {number} [now] @returns {Project | null}
   */
  function touchProject(id, now = Date.now()) {
    touch(now, id);
    return getProject(id);
  }

  /**
   * Patch a listing. `now` may travel inside the patch (it is not a column, so the allowlist
   * ignores it) to keep the mutator deterministic in tests.
   * @param {string} id @param {{ title?: string, address?: string, status?: string, extraJson?: string, now?: number }} [patch]
   * @returns {Project | null} The updated row, or null when there is no such project.
   */
  function updateProject(id, patch = {}) {
    const now = typeof patch.now === 'number' ? patch.now : Date.now();
    const patched = patchFor('projects', PROJECT_PATCH_COLUMNS, patch, 'updated_at = @updated_at');
    // Nothing patchable given: still a touch, so a no-op patch behaves like a save.
    if (!patched) return touchProject(id, now);
    return rowToProject(patched.stmt.get({ ...patched.values, updated_at: now, id: String(id) }));
  }

  /**
   * Erase a listing and everything under it, in ONE transaction — a half-deleted project
   * leaves renders pointing at a photo that no longer exists, and no foreign key will clean
   * them up. Blobs are NOT touched: pair this with `storage.removeProject(id)`.
   * @param {string} id @returns {{ photos: number, renders: number, bibles: number, shares: number, feedback: number }}
   */
  function deleteProject(id) {
    const pid = String(id);
    return withTxn(() => {
      const removed = renders.deleteForProject(pid);
      const bibles = q.delBiblesForProject.run(pid).changes;
      const photos = q.delPhotosForProject.run(pid).changes;
      // Shares go with the listing, not after it. A surviving row is a URL that still
      // resolves to a project id — and while the manifest would find nothing to show, the
      // link having outlived the delete is the part a customer would object to.
      const links = shares.deleteForProject(pid);
      const notes = feedback.deleteForProject(pid);
      q.delProject.run(pid);
      return { photos, renders: removed, bibles, shares: links, feedback: notes };
    });
  }

  /**
   * Erase every listing of one user — the hook GDPR erasure needs (user-deletion.js owns the
   * account row itself, and pairs this with `storage.removeProjectSync` per project).
   * @param {string} userId @returns {{ projects: number, photos: number, renders: number, bibles: number, shares: number, feedback: number }}
   */
  function deleteProjectsForUser(userId) {
    const uid = String(userId);
    return withTxn(() => {
      const totals = { projects: 0, photos: 0, renders: 0, bibles: 0, shares: 0, feedback: 0 };
      for (const row of q.projectIdsForUser.all(uid)) {
        const removed = deleteProject(row.id);
        totals.projects += 1;
        totals.photos += removed.photos;
        totals.renders += removed.renders;
        totals.bibles += removed.bibles;
        totals.shares += removed.shares;
        totals.feedback += removed.feedback;
      }
      // Belt and braces: drop anything for this user the loop missed, so no orphan project
      // row can survive an erasure request. The share sweep is by `user_id` — the column
      // that exists on that table precisely so this pass does not need the projects it is
      // in the middle of deleting.
      totals.shares += shares.deleteForUser(uid);
      totals.feedback += feedback.deleteForUser(uid);
      q.delProjectsForUser.run(uid);
      return totals;
    });
  }

  // ---- Photos ---------------------------------------------------------------

  /**
   * Add a source photo. IDEMPOTENT by content hash: a second upload of the same bytes into
   * the same project returns the EXISTING row with `duplicate: true` instead of throwing.
   * Re-dragging a folder of 30 photos because one failed is normal behaviour, and a
   * UNIQUE-constraint exception at that moment reads as data loss.
   * @param {{ projectId?: string, storageKey?: string, seq?: number, sha256?: string, width?: number,
   *   height?: number, arLabel?: string, roomKey?: string, roomType?: string, frameRole?: string, now?: number }} [arg]
   * @returns {{ ok: true, photo: ProjectPhoto, duplicate: boolean } | { ok: false, code: string, error: string }}
   */
  function addPhoto(arg = {}) {
    const projectId = String(arg.projectId || '');
    const sha256 = String(arg.sha256 || '');
    const now = typeof arg.now === 'number' ? arg.now : Date.now();
    if (!sha256) return { ok: false, code: 'SHA_REQUIRED', error: 'A content hash is required to de-duplicate the upload.' };
    if (!arg.storageKey) return { ok: false, code: 'KEY_REQUIRED', error: 'A storage key is required.' };
    // The foreign key this database cannot declare, enforced at the one place that inserts:
    // an orphan photo is invisible in every listing and impossible to bill for.
    if (!q.getProject.get(projectId)) return { ok: false, code: 'PROJECT_NOT_FOUND', error: 'That listing no longer exists.' };
    return withTxn(() => {
      const existing = q.photoBySha.get(projectId, sha256);
      if (existing) return { ok: true, photo: /** @type {ProjectPhoto} */ (rowToPhoto(existing)), duplicate: true };
      const row = q.insertPhoto.get({
        id: newId(), project_id: projectId, storage_key: String(arg.storageKey),
        seq: typeof arg.seq === 'number' ? arg.seq : countOf(q.nextSeq.get(projectId)),
        room_key: toDbValue(arg.roomKey), room_type: toDbValue(arg.roomType),
        frame_role: FRAME_ROLES.includes(String(arg.frameRole)) ? String(arg.frameRole) : 'support',
        width: toDbValue(arg.width), height: toDbValue(arg.height), ar_label: toDbValue(arg.arLabel),
        stageable: null, unstageable_code: null, sha256, created_at: now,
      });
      touch(now, projectId);
      return { ok: true, photo: /** @type {ProjectPhoto} */ (rowToPhoto(row)), duplicate: false };
    });
  }

  /** @param {string} id @returns {ProjectPhoto | null} */
  const getPhoto = (id) => rowToPhoto(q.getPhoto.get(String(id)));
  /** @param {string} projectId @returns {ProjectPhoto[]} */
  const listPhotos = (projectId) => q.listPhotos.all(String(projectId)).map(rowToPhoto);

  /**
   * Patch a photo's grouping/verdict fields. Accepts ONLY roomKey, roomType, frameRole,
   * stageable, unstageableCode and seq; anything else is ignored.
   * @param {string} id @param {{ roomKey?: string|null, roomType?: string|null, frameRole?: string,
   *   stageable?: boolean|null, unstageableCode?: string|null, seq?: number, now?: number }} [patch]
   * @returns {ProjectPhoto | null}
   */
  function updatePhoto(id, patch = {}) {
    const patched = patchFor('project_photos', PHOTO_PATCH_COLUMNS, patch);
    if (!patched) return getPhoto(id);
    const now = typeof patch.now === 'number' ? patch.now : Date.now();
    return withTxn(() => {
      const row = patched.stmt.get({ ...patched.values, id: String(id) });
      if (row) touch(now, row.project_id);
      return rowToPhoto(row);
    });
  }

  /**
   * Remove one photo and every render of it, returning the orphaned storage keys so the
   * caller can delete the blobs (rows are synchronous, blob removal is async — header).
   * @param {string} id
   * @returns {{ ok: true, photoId: string, renders: number, storageKeys: string[] } | { ok: false, code: string, error: string }}
   */
  function deletePhoto(id) {
    const pid = String(id);
    const photo = q.getPhoto.get(pid);
    if (!photo) return { ok: false, code: 'NOT_FOUND', error: 'That photo no longer exists.' };
    return withTxn(() => {
      const keys = renders.storageKeysForPhoto(pid);
      const removed = renders.deleteForPhoto(pid);
      q.delPhoto.run(pid);
      return { ok: true, photoId: pid, renders: removed, storageKeys: [photo.storage_key, ...keys] };
    });
  }

  /**
   * Make one photo the hero of its room, demoting whoever held the role. One transaction,
   * because a room with two heroes is the state the bible flow cannot recover from — the
   * second hero would author a competing bible for the same room. Also assigns `room_key`,
   * since choosing a hero is how a room gets named in the first place.
   * @param {string} projectId @param {string | null} roomKey @param {string} photoId
   * @returns {{ ok: true, photo: ProjectPhoto, demoted: number } | { ok: false, code: string, error: string }}
   */
  function setHero(projectId, roomKey, photoId) {
    const pid = String(projectId);
    const photo = q.getPhoto.get(String(photoId));
    if (!photo) return { ok: false, code: 'NOT_FOUND', error: 'That photo no longer exists.' };
    if (photo.project_id !== pid) return { ok: false, code: 'WRONG_PROJECT', error: 'That photo belongs to another listing.' };
    const room = roomKey == null ? null : String(roomKey);
    return withTxn(() => {
      const demoted = q.demoteHeroes.run(pid, room, photo.id).changes;
      return { ok: true, photo: /** @type {ProjectPhoto} */ (rowToPhoto(q.promoteHero.get(room, photo.id))), demoted };
    });
  }

  // ---- Design bibles --------------------------------------------------------

  /**
   * Author a new bible version for one room. The version is assigned as MAX(version)+1 INSIDE
   * the transaction, so two concurrent authors cannot both compute 3; the UNIQUE index on
   * (project_id, room_key, version) is the backstop if they somehow do.
   * @param {{ projectId?: string, roomKey?: string, heroRenderId?: string|null, doc?: any,
   *   roomType?: string, furnitureStyle?: string, now?: number }} [arg] @returns {DesignBibleRow}
   */
  function createBible(arg = {}) {
    const pid = String(arg.projectId || '');
    const room = String(arg.roomKey || '');
    const now = typeof arg.now === 'number' ? arg.now : Date.now();
    return withTxn(() => {
      const version = countOf(q.maxBibleVersion.get(pid, room)) + 1;
      // The document carries its own version/room so a bible handed to a prompt builder (or
      // dumped for support) is self-describing without its row.
      const doc = arg.doc && typeof arg.doc === 'object' ? { ...arg.doc, version, roomKey: room } : arg.doc;
      const row = q.insertBible.get(newId(), pid, room, version, toDbValue(arg.heroRenderId),
        JSON.stringify(doc ?? {}), String(arg.furnitureStyle || ''), String(arg.roomType || ''), now);
      touch(now, pid);
      return /** @type {DesignBibleRow} */ (rowToBible(row));
    });
  }

  /** @param {string} id @returns {DesignBibleRow | null} */
  const getBible = (id) => rowToBible(q.getBible.get(String(id)));
  /** The newest bible for a room — what a support frame is staged against. @param {string} projectId @param {string} roomKey @returns {DesignBibleRow | null} */
  const latestBible = (projectId, roomKey) => rowToBible(q.latestBible.get(String(projectId), String(roomKey ?? '')));
  /** @param {string} projectId @returns {DesignBibleRow[]} */
  const listBibles = (projectId) => q.listBibles.all(String(projectId)).map(rowToBible);

  /** Row counts across all four tables — for the admin dashboard and the tests. */
  const countAll = () => ({
    projects: countOf(q.countProjects.get()), photos: countOf(q.countPhotos.get()),
    bibles: countOf(q.countBibles.get()), renders: renders.count(), shares: shares.count(),
    feedback: feedback.count(),
  });

  const {
    enqueueRender, claimNextRender, releaseRender, completeRender, failRender,
    supersedeRendersForRoom, attachBibleToQueuedRenders, reclaimStaleClaims,
    getRender, listRenders, rendersForPhoto, progressFor, hasPendingWork,
    requeueRenderForRetry, failBlockedRendersForRoom,
  } = renders;

  /**
   * Author a room's design bible AND release the barrier on its queued support frames, as
   * ONE transaction.
   *
   * These were two separate writes, and the gap between them was a permanent-stall window:
   * a crash after `createBible` but before `attachBibleToQueuedRenders` leaves a room that
   * HAS a bible whose support frames are still barred, so nothing will ever claim them and
   * nothing will ever author a second bible to unblock them. That state is worse than the
   * no-bible one, because the "no bible for this room" recovery path does not recognise it.
   *
   * Composed here rather than in either half because this file owns `withTxn` and the
   * bibles table, and the render queue lives in project-renders.js — the seam between them
   * is exactly where the atomicity had gone missing.
   *
   * @param {{ projectId?: string, roomKey?: string, heroRenderId?: string|null, doc?: any,
   *   roomType?: string, furnitureStyle?: string, now?: number }} arg
   * @returns {{ bible: import('../types/projects.js').DesignBibleRow, unblocked: number }}
   */
  function createBibleAndUnblockRoom(arg = {}) {
    return withTxn(() => {
      const bible = createBible(arg);
      // createBible coerces these itself; do the same here so the pair agrees on what an
      // omitted room key means (the empty string, matching the `room_key IS ?` comparison).
      const unblocked = attachBibleToQueuedRenders(String(arg.projectId || ''), String(arg.roomKey || ''), bible.id);
      return { bible, unblocked };
    });
  }

  return {
    // Namespaced rather than flattened like the render queue: the share API is a whole
    // separate surface (a public one), and spreading its nine names across this object
    // would make `projects.revokeShare` read as if listings themselves were shareable.
    shares,
    // Seller sign-off coming BACK through a share link (lib/data/share-feedback.js).
    feedback,
    createBibleAndUnblockRoom,
    createProject, getProject, listProjects, updateProject, touchProject,
    deleteProject, deleteProjectsForUser,
    addPhoto, getPhoto, listPhotos, updatePhoto, deletePhoto, setHero,
    createBible, getBible, latestBible, listBibles,
    enqueueRender, claimNextRender, releaseRender, completeRender, failRender,
    supersedeRendersForRoom, attachBibleToQueuedRenders, reclaimStaleClaims,
    getRender, listRenders, rendersForPhoto, progressFor, hasPendingWork, countAll,
    requeueRenderForRetry, failBlockedRendersForRoom,
  };
}
