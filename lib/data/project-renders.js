// The `renders` table: the work queue behind a listing's staging run.
//
// Split out of lib/data/projects.js (which owns the listing, its photos and its design
// bibles) because the two halves are different jobs. This one is a lease-based job queue —
// claim, run, complete or fail, reclaim what a crashed worker abandoned — and it carries
// the one piece of ordering logic the whole feature depends on, the BIBLE BARRIER in
// `claimNextRender`. `createProjects` composes the two back into a single store object, so
// no caller sees the seam.
//
// Everything here is reached through `createProjects`; this module is not opened directly.
// It takes the shared connection, transaction runner and helpers as an explicit dep bag
// rather than importing them back out of projects.js, which would make the pair a cycle.
//
// No REFERENCES on project_id/photo_id/bible_id — the table is created in projects.js,
// where the standing no-foreign-keys rule (lib/data/db.js) is written up. The consequence
// that matters here is in `claimNextRender`'s JOIN.

/** @typedef {import('../types/projects.js').Render} Render */

/** Mirrors the CHECK constraint on `renders.status` in projects.js. */
export const RENDER_STATUSES = Object.freeze(['queued', 'running', 'ok', 'failed', 'superseded']);

/**
 * How long a claimed render may stay 'running' before another worker may take it. Generous
 * on purpose: a slow generation must not be stolen mid-flight, because a duplicate render
 * costs a paid API call.
 */
export const DEFAULT_LEASE_MS = 10 * 60 * 1000;

/**
 * @typedef {object} RenderStoreDeps
 * @property {any} db The shared better-sqlite3 connection (lib/data/db.js `getDb`).
 * @property {(fn: () => any) => any} withTxn projects.js's transaction runner, shared so a
 *   cross-table write (deleting a photo and its renders) is ONE transaction.
 * @property {(now: number, projectId: string) => void} touchProject Bumps `projects.updated_at`.
 * @property {() => string} newId 32-hex id minter.
 * @property {(value: unknown) => string | number | Buffer | null} toDbValue SQLite bind coercion.
 * @property {(text: string | null | undefined, label: string) => any} parseJsonColumn Lenient JSON column read.
 */

// Exactly what makes a queued render eligible to run: the FIFO status check and the BIBLE
// BARRIER, as one SQL fragment shared by the claim and the claimable count below.
//
// Shared rather than written twice on purpose. "How many can still run" is the negation of
// "which one runs next", and a hand-written negation is precisely how the two drift — the
// same defect class as the doubled-path bug in project-storage.js, where two independently
// composed answers to one question disagreed and deletion silently stopped working. Both
// callers also inherit the JOIN, so a render whose photo row is gone counts as ineligible
// in both, without either having to remember that.
const CLAIMABLE_WHERE = "r.status = 'queued' AND (p.frame_role = 'hero' OR r.bible_id IS NOT NULL)";

// The exact set of rows the BIBLE BARRIER can bar: queued work on a NON-hero frame of one
// room. Shared by `attachBible`, which RELEASES that set, and `failBlockedRoom`, which
// BURIES it when no bible is ever going to arrive — the two must address the same rows or
// one of them is wrong. Written as one fragment for the same reason CLAIMABLE_WHERE is.
//
// The `frame_role <> 'hero'` half is load-bearing, not cosmetic. Stamping a bible onto a
// queued HERO render is a lie about how that image was produced (a hero AUTHORS its room's
// bible; it is never conditioned on one), and it used to be worse than a lie: the worker
// read the role off `bible_id`, so a stamped hero was dispatched down the support path and
// staged against a bible extracted from a different frame. The worker now derives the role
// from the photo, but the row must still tell the truth — /renders, the audit trail and any
// future re-run all read `bible_id` as "this is what conditioned it".
const BARRED_PHOTOS_IN_ROOM = "photo_id IN (SELECT id FROM project_photos WHERE project_id = ? AND room_key IS ? AND frame_role <> 'hero')";

// What "this render row is still mine to write" means, shared by `complete`, `fail` and the
// retry requeue. Its job is to make a LOST RACE DETECTABLE: with the guard, zero rows come
// back (`RETURNING` yields nothing) and the caller learns the row is no longer live work —
// deleted along with its project, or retired by a newer bible — instead of the UPDATE
// matching nothing and looking exactly like success.
//
// That is what closes a real hole: a generation finishing AFTER `DELETE /api/projects/:id`
// used to be reported as a completed render of a listing the user had deleted, with its
// blob written back into the directory the delete had just removed. The worker now removes
// the blob it wrote when this guard bites (see lib/staging/listing-worker.js `storeRender`).
//
// 'ok' and 'superseded' are the two states that are FINAL — published, or deliberately
// retired in favour of a newer bible. 'failed' stays writable on purpose: the retry path
// takes a failed row back to 'queued', so failure is not final here until its attempt
// budget is spent.
const STILL_WRITABLE = "status NOT IN ('ok', 'superseded')";

/**
 * Build the render-queue half of the project store.
 * @param {RenderStoreDeps} deps
 */
export function createProjectRenders({ db, withTxn, touchProject, newId, toDbValue, parseJsonColumn }) {
  const q = {
    insert: db.prepare("INSERT INTO renders (id, project_id, photo_id, bible_id, variation, status, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?) RETURNING *"),
    byId: db.prepare('SELECT * FROM renders WHERE id = ?'),
    byProject: db.prepare('SELECT * FROM renders WHERE project_id = ? ORDER BY created_at DESC, rowid DESC'),
    byPhoto: db.prepare('SELECT * FROM renders WHERE photo_id = ? ORDER BY variation ASC, rowid ASC'),
    keysForPhoto: db.prepare('SELECT storage_key FROM renders WHERE photo_id = ? AND storage_key IS NOT NULL'),
    delForPhoto: db.prepare('DELETE FROM renders WHERE photo_id = ?'),
    delForProject: db.prepare('DELETE FROM renders WHERE project_id = ?'),
    // The claim. BOTH invariants are inside this ONE statement — see claimNextRender.
    claimNext: db.prepare(`UPDATE renders SET status = 'running', claimed_at = ?
       WHERE id = (SELECT r.id FROM renders r JOIN project_photos p ON p.id = r.photo_id
                    WHERE ${CLAIMABLE_WHERE}
                    ORDER BY r.created_at ASC, r.rowid ASC LIMIT 1)
       RETURNING *`),
    release: db.prepare("UPDATE renders SET status = 'queued', claimed_at = NULL WHERE id = ? AND status = 'running' RETURNING *"),
    complete: db.prepare(`UPDATE renders SET status = 'ok', storage_key = @storage_key, prompt_text = @prompt_text,
             model = @model, quality_score = @quality_score, consistency_score = @consistency_score,
             gen_attempts = COALESCE(@gen_attempts, gen_attempts), duration_ms = @duration_ms,
             extra_json = COALESCE(@extra_json, extra_json),
             error_code = NULL, claimed_at = NULL WHERE id = @id AND ${STILL_WRITABLE} RETURNING *`),
    fail: db.prepare(`UPDATE renders SET status = 'failed', error_code = ?, duration_ms = ?,
             gen_attempts = gen_attempts + 1, claimed_at = NULL WHERE id = ? AND ${STILL_WRITABLE} RETURNING *`),
    // The bounded retry. The budget test is INSIDE the statement, next to the increment it
    // guards, so a caller cannot requeue past it and two workers cannot both read
    // `gen_attempts` as 2 and both decide there is one try left.
    requeue: db.prepare(`UPDATE renders SET status = 'queued', claimed_at = NULL, error_code = @error_code,
             duration_ms = @duration_ms, gen_attempts = gen_attempts + 1
           WHERE id = @id AND ${STILL_WRITABLE} AND gen_attempts + 1 < @max_attempts RETURNING *`),
    supersedeRoom: db.prepare(`UPDATE renders SET status = 'superseded' WHERE project_id = ? AND status = 'ok'
         AND photo_id IN (SELECT id FROM project_photos WHERE project_id = ? AND room_key IS ?)`),
    attachBible: db.prepare(`UPDATE renders SET bible_id = ? WHERE project_id = ? AND status = 'queued'
         AND ${BARRED_PHOTOS_IN_ROOM}`),
    // The other half of the barrier: bury what `attachBible` will never be called for.
    // `gen_attempts` is NOT incremented — nothing was ever attempted; the room simply has no
    // bible to attempt it against.
    failBlockedRoom: db.prepare(`UPDATE renders SET status = 'failed', error_code = ?, claimed_at = NULL
         WHERE project_id = ? AND status = 'queued' AND bible_id IS NULL AND ${BARRED_PHOTOS_IN_ROOM}`),
    reclaim: db.prepare("UPDATE renders SET status = 'queued', claimed_at = NULL WHERE status = 'running' AND (claimed_at IS NULL OR claimed_at <= ?)"),
    // How many queued renders could still run, using the SAME predicate and JOIN as the
    // claim above. `blocked` is then derived as queued − claimable, so the two answers can
    // never disagree about what "eligible" means.
    claimable: db.prepare(`SELECT COUNT(*) AS n FROM renders r JOIN project_photos p ON p.id = r.photo_id
        WHERE r.project_id = ? AND ${CLAIMABLE_WHERE}`),
    progress: db.prepare(`SELECT COALESCE(SUM(status = 'queued'), 0) AS queued, COALESCE(SUM(status = 'running'), 0) AS running,
             COALESCE(SUM(status = 'ok'), 0) AS ok, COALESCE(SUM(status = 'failed'), 0) AS failed,
             COALESCE(SUM(status = 'superseded'), 0) AS superseded, COUNT(*) AS total
        FROM renders WHERE project_id = ?`),
    count: db.prepare('SELECT COUNT(*) AS n FROM renders'),
  };

  /**
   * `row` is deliberately untyped: better-sqlite3 hands back plain objects, and the named
   * shape lives in lib/types/projects.d.ts on the way out.
   * @returns {Render | null}
   */
  const rowToRender = (row) => (row ? {
    id: row.id, projectId: row.project_id, photoId: row.photo_id, bibleId: row.bible_id ?? null,
    variation: row.variation, storageKey: row.storage_key ?? null, status: row.status,
    promptText: row.prompt_text ?? null, model: row.model ?? null, genAttempts: row.gen_attempts,
    qualityScore: row.quality_score ?? null, consistencyScore: row.consistency_score ?? null,
    errorCode: row.error_code ?? null, durationMs: row.duration_ms ?? null,
    claimedAt: row.claimed_at ?? null, createdAt: row.created_at,
    extra: parseJsonColumn(row.extra_json, `renders.extra_json for ${row.id}`),
  } : null);

  /** Queue one attempt. @param {{ projectId?: string, photoId?: string, bibleId?: string|null, variation?: number, now?: number }} [arg] @returns {Render} */
  function enqueueRender(arg = {}) {
    const pid = String(arg.projectId || '');
    const now = typeof arg.now === 'number' ? arg.now : Date.now();
    return withTxn(() => {
      const row = q.insert.get(newId(), pid, String(arg.photoId || ''), toDbValue(arg.bibleId),
        typeof arg.variation === 'number' ? arg.variation : 1, now);
      touchProject(now, pid);
      return /** @type {Render} */ (rowToRender(row));
    });
  }

  /**
   * Take the next render a worker may run, atomically.
   *
   * THE WHOLE SELECTION IS ONE STATEMENT (`UPDATE … WHERE id = (SELECT …) RETURNING *`).
   * Not "read a candidate, then mark it running": between those two steps a second worker
   * reads the same candidate and the listing is billed twice for one image. SQLite
   * serialises the statement, so the row is chosen and leased, or not at all.
   *
   * Two invariants live in that subquery, deliberately NOT in JS:
   *   1. THE BIBLE BARRIER — `p.frame_role = 'hero' OR r.bible_id IS NOT NULL`. A support
   *      frame is unclaimable until its room's bible is attached (see
   *      `attachBibleToQueuedRenders`, the call that releases it). It is in SQL because the
   *      queue OUTLIVES THE PROCESS: rows sit in the database across restarts, a second
   *      worker can start at any time, and an operator can poke the table by hand — a JS
   *      filter binds only the one code path that runs it, a WHERE clause binds everyone.
   *      It also makes the claim SKIP a barred row and take the next eligible one, where a
   *      JS post-filter would return nothing and stall the queue behind its own first row.
   *      That difference is what test/data/projects.test.js asserts, because a test that
   *      only checks "a barred row is not returned" passes either way.
   *   2. FIFO — `status = 'queued'` only, ordered by created_at then rowid. Hero frames are
   *      enqueued first so they naturally lead; rowid breaks same-millisecond ties.
   *
   * The JOIN also means a render whose photo row is gone is never claimable, which is right
   * in a database with no foreign keys: an orphan stays inert rather than being dequeued
   * into a crash. `leaseMs` is optional; when given, expired leases are reclaimed first
   * (same transaction) so a crashed worker's row is available to this very call.
   * @param {{ now?: number, leaseMs?: number }} [opts]
   * @returns {Render | null} The leased render, or null when nothing is eligible.
   */
  function claimNextRender({ now = Date.now(), leaseMs } = {}) {
    if (typeof leaseMs !== 'number') return rowToRender(q.claimNext.get(now));
    return withTxn(() => {
      q.reclaim.run(now - leaseMs);
      return rowToRender(q.claimNext.get(now));
    });
  }

  /**
   * Hand a claimed render back unrun (a worker shutting down cleanly). Only a 'running' row
   * moves, so this cannot resurrect a finished render.
   * @param {string} id @param {{ now?: number }} [opts] @returns {Render | null}
   */
  function releaseRender(id, { now = Date.now() } = {}) {
    return withTxn(() => {
      const row = q.release.get(String(id));
      if (row) touchProject(now, row.project_id);
      return rowToRender(row);
    });
  }

  /**
   * Record a successful render.
   *
   * A null return is NOT nothing to worry about: it means the row stopped being live work
   * while the render was in flight (its project was deleted, or a newer bible superseded
   * it), so the bytes the caller just wrote belong to nobody. See `STILL_WRITABLE`; the
   * worker treats null as "unlink the blob you wrote and do not count a success".
   * @param {string} id @param {{ storageKey?: string, promptText?: string, model?: string, genAttempts?: number,
   *   qualityScore?: number, consistencyScore?: number, durationMs?: number,
   *   extra?: Record<string, unknown> | null, now?: number }} [arg]
   *   `extra` is stored as `extra_json` — the per-render side-channel the audit trail has no
   *   column for, today the list of bible slots that drifted (`mismatchedSlots`), which is
   *   literally the answer to "why is this frame's consistency score low". Omit it to leave
   *   whatever is already there alone.
   * @returns {Render | null} null when there is no such render, or it is no longer writable.
   */
  function completeRender(id, arg = {}) {
    const now = typeof arg.now === 'number' ? arg.now : Date.now();
    // Kept a JSON OBJECT rather than a bare array: extra_json is a bag other fields will
    // join, and a top-level array could never grow one.
    const extra = arg.extra && typeof arg.extra === 'object' ? JSON.stringify(arg.extra) : null;
    return withTxn(() => {
      const row = q.complete.get({
        id: String(id), storage_key: toDbValue(arg.storageKey), prompt_text: toDbValue(arg.promptText),
        model: toDbValue(arg.model), gen_attempts: toDbValue(arg.genAttempts),
        quality_score: toDbValue(arg.qualityScore), consistency_score: toDbValue(arg.consistencyScore),
        duration_ms: toDbValue(arg.durationMs), extra_json: extra,
      });
      if (row) touchProject(now, row.project_id);
      return rowToRender(row);
    });
  }

  /**
   * Record a TERMINAL failure — this frame is not coming back. `gen_attempts` is incremented
   * HERE rather than passed in: the number of tries is the database's business, and a retry
   * loop that forgot to pass it would otherwise retry forever.
   *
   * A transient failure should go through `requeueRenderForRetry` first; this is where a row
   * lands once its attempt budget is spent or the failure is one no retry can fix.
   * @param {string} id @param {{ errorCode?: string, durationMs?: number, now?: number }} [arg] @returns {Render | null}
   */
  function failRender(id, arg = {}) {
    const now = typeof arg.now === 'number' ? arg.now : Date.now();
    return withTxn(() => {
      const row = q.fail.get(toDbValue(arg.errorCode), toDbValue(arg.durationMs), String(id));
      if (row) touchProject(now, row.project_id);
      return rowToRender(row);
    });
  }

  /**
   * Put a failed attempt BACK on the queue, if its attempt budget allows — the difference
   * between "one 503 on frame 2 of 3" and "the operator is told staging finished and
   * silently gets 2 of 3". Nothing else ever requeues a failure: `reclaimStaleClaims` only
   * touches 'running', so before this existed a single transient error lost that frame
   * permanently while `isProgressComplete` reported success.
   *
   * The attempt is counted whether or not the requeue happens, so a caller that falls back
   * to `failRender` on null does not double-count it — and the budget cannot be escaped by
   * calling this in a loop.
   * @param {string} id
   * @param {{ errorCode?: string, durationMs?: number, maxAttempts?: number, now?: number }} [arg]
   *   `maxAttempts` is the TOTAL generations allowed for the row (the worker's
   *   `MAX_RENDER_ATTEMPTS`), not the number of retries left.
   * @returns {Render | null} The requeued row, or null when the budget is spent, the row is
   *   gone, or it is no longer live work — in every one of those cases the caller must NOT
   *   treat the render as pending.
   */
  function requeueRenderForRetry(id, arg = {}) {
    const now = typeof arg.now === 'number' ? arg.now : Date.now();
    const maxAttempts = typeof arg.maxAttempts === 'number' && arg.maxAttempts > 0 ? Math.floor(arg.maxAttempts) : 1;
    return withTxn(() => {
      const row = q.requeue.get({
        id: String(id), error_code: toDbValue(arg.errorCode),
        duration_ms: toDbValue(arg.durationMs), max_attempts: maxAttempts,
      });
      if (row) touchProject(now, row.project_id);
      return rowToRender(row);
    });
  }

  /**
   * Fail the renders of one room that the BIBLE BARRIER will never release, because bible
   * extraction failed for that room's hero.
   *
   * Those rows are queued with `bible_id IS NULL` on a non-hero frame, which makes them
   * structurally UNCLAIMABLE — `progressFor().blocked` makes that visible, but visible is not
   * drained: `queued` stayed non-zero forever, so the listing never read as finished and
   * `/stage` answered 409 "already queued" with no way out. Marking them failed with a code
   * is the honest end state: the queue drains, the UI can say which rooms lost their
   * consistency pass, and the operator can regenerate that room.
   *
   * Heroes are excluded (BARRED_PHOTOS_IN_ROOM) — a queued hero variation is claimable and
   * must be left to run. This is emphatically NOT "render them unconditioned": an
   * unconditioned support frame is the one outcome the whole feature exists to prevent.
   * @param {string} projectId @param {string | null} roomKey
   * @param {{ errorCode?: string, now?: number }} [arg]
   * @returns {number} Rows failed.
   */
  function failBlockedRendersForRoom(projectId, roomKey, { errorCode = 'BIBLE_MISSING', now = Date.now() } = {}) {
    const pid = String(projectId);
    return withTxn(() => {
      const changed = q.failBlockedRoom.run(String(errorCode), pid, pid, roomKey == null ? null : String(roomKey)).changes;
      if (changed) touchProject(now, pid);
      return changed;
    });
  }

  /**
   * Retire the finished renders of one room, because its bible changed. 'superseded' rather
   * than deleted: the old image is still on disk and still the best thing to show while the
   * replacement generates, and an operator comparing two bible versions needs both.
   * @param {string} projectId @param {string | null} roomKey @param {{ now?: number }} [opts] @returns {number} Rows retired.
   */
  function supersedeRendersForRoom(projectId, roomKey, { now = Date.now() } = {}) {
    const pid = String(projectId);
    return withTxn(() => {
      const changed = q.supersedeRoom.run(pid, pid, roomKey == null ? null : String(roomKey)).changes;
      if (changed) touchProject(now, pid);
      return changed;
    });
  }

  /**
   * Point a room's QUEUED SUPPORT renders at a bible — the call that releases the barrier in
   * `claimNextRender`. Re-pointing an already-attached render is intentional: a newer bible
   * version supersedes an older one for work that has not started yet.
   *
   * Queued HERO renders are deliberately NOT stamped; see BARRED_PHOTOS_IN_ROOM for why a
   * hero carrying a `bible_id` is both a lie and, until the worker stopped reading the role
   * off that column, an actively wrong dispatch.
   * @param {string} projectId @param {string | null} roomKey @param {string} bibleId @returns {number} Rows updated.
   */
  function attachBibleToQueuedRenders(projectId, roomKey, bibleId) {
    const pid = String(projectId);
    return q.attachBible.run(String(bibleId), pid, pid, roomKey == null ? null : String(roomKey)).changes;
  }

  /**
   * Return expired leases to the queue. A 'running' row with a NULL claimed_at counts as
   * stale too: that state is unreachable through this module, so if it exists something
   * wrote the table by hand and the row would otherwise be stuck 'running' forever.
   * @param {{ now?: number, leaseMs?: number }} [opts] @returns {number} Rows requeued.
   */
  function reclaimStaleClaims({ now = Date.now(), leaseMs = DEFAULT_LEASE_MS } = {}) {
    return q.reclaim.run(now - leaseMs).changes;
  }

  /**
   * The progress bar's numbers, in one query.
   * @param {string} projectId
   * @returns {{ queued: number, running: number, ok: number, failed: number, superseded: number, total: number, blocked: number }}
   *   `blocked` is the subset of `queued` that is not claimable, so `queued - blocked` is
   *   the work a worker can still pick up.
   */
  function progressFor(projectId) {
    const id = String(projectId);
    const r = q.progress.get(id);
    // `blocked` is the honest half of `queued`: rows that are waiting on something no
    // amount of waiting will deliver. Today that is a support frame whose room never got a
    // design bible (extraction failed), so the claim's barrier will never let it run.
    //
    // Without this the queue looked busy forever: `queued` stayed non-zero, so the project
    // never read as finished, the browser polled every 2.5s indefinitely, and `/stage`
    // answered 409 "already queued" — a dead end whose only escape was regenerating the
    // room's look. Derived from the shared claimable count rather than counted separately,
    // so it means exactly "not claimable" and cannot drift from the claim.
    const claimable = q.claimable.get(id).n;
    const blocked = Math.max(0, r.queued - claimable);
    return {
      queued: r.queued, running: r.running, ok: r.ok, failed: r.failed,
      superseded: r.superseded, total: r.total, blocked,
    };
  }

  /**
   * Whether this project still has work a worker could pick up — nothing claimable and
   * nothing running. The worker uses it to decide when a listing is finished, which is what
   * finally moves the project off `status: 'staging'`.
   * @param {string} projectId
   * @returns {boolean}
   */
  function hasPendingWork(projectId) {
    const id = String(projectId);
    const r = q.progress.get(id);
    return r.running > 0 || q.claimable.get(id).n > 0;
  }

  return {
    enqueueRender, claimNextRender, releaseRender, completeRender, failRender,
    requeueRenderForRetry, failBlockedRendersForRoom,
    supersedeRendersForRoom, attachBibleToQueuedRenders, reclaimStaleClaims, progressFor, hasPendingWork,
    /** @param {string} id @returns {Render | null} */
    getRender: (id) => rowToRender(q.byId.get(String(id))),
    /** @param {string} projectId @returns {Render[]} */
    listRenders: (projectId) => q.byProject.all(String(projectId)).map(rowToRender),
    /** @param {string} photoId @returns {Render[]} */
    rendersForPhoto: (photoId) => q.byPhoto.all(String(photoId)).map(rowToRender),
    // ---- Used by projects.js's explicit cascades and countAll, not part of the queue API.
    /** Storage keys of one photo's renders, so a caller can delete the blobs. @param {string} photoId @returns {string[]} */
    storageKeysForPhoto: (photoId) => q.keysForPhoto.all(String(photoId)).map((r) => r.storage_key),
    /** @param {string} photoId @returns {number} Rows deleted. */
    deleteForPhoto: (photoId) => q.delForPhoto.run(String(photoId)).changes,
    /** @param {string} projectId @returns {number} Rows deleted. */
    deleteForProject: (projectId) => q.delForProject.run(String(projectId)).changes,
    /** @returns {number} Every render row in the database. */
    count: () => {
      const row = q.count.get();
      return row && typeof row.n === 'number' ? row.n : 0;
    },
  };
}
