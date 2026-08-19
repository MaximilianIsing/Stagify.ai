// The gallery's rows: one per staged result, plus the object keys for its bytes.
//
// THE CAP IS ENFORCED IN THE INSERT TRANSACTION, OR IT IS NOT A CAP
// The free tier is capped at FREE_GALLERY_LIMIT; Stagify+ is not capped at all. Checking
// the count and then inserting would be a read-modify-write across two statements, and
// two renders finishing at once would both see "one under" and both insert. So the insert,
// the blob rows, the reference rows and the eviction all run in ONE better-sqlite3
// transaction — synchronous, so it is genuinely atomic and genuinely unraceable.
//
// An uncapped tier does not get a separate code path: `capFor` returns Infinity and
// `evictBeyondCap` returns early on a non-finite cap, which is the same door the
// downgrade grace window already went through. One eviction path, exercised by every
// free render, rather than a second one that only pro accounts ever reach.
//
// The object-store DELETE is not in that transaction and cannot be: it is an async
// network call. The TOMBSTONE is (lib/data/blob-tombstones.js), which is the whole
// reason that queue is a general mechanism rather than an erasure-only hack. Rows and
// obligations commit together; bytes are cleaned up afterwards, with retries.
//
// SHARED ENTRIES EVICT LAST
// One ORDER BY clause buys "do not break the link the agent just texted a buyer". It is
// not a pin: shared entries still COUNT against the cap, so nobody can grow their
// gallery without limit by sharing everything. And when an account has more live shares
// than the cap, eviction revokes the share in the same transaction rather than leaving a
// link pointing at deleted bytes — the buyer then gets the same uniform 404 as a
// manually revoked link, which is correct but must not be silent (the staging response
// carries what was evicted so the UI can say so).
//
// WHY LIMIT -1 OFFSET cap RATHER THAN "DELETE ONE WHEN count = cap + 1"
// A user can be arbitrarily over the cap — the constant can change, and a lapsed Pro
// account arrives with however much history it accumulated while uncapped, which is now
// genuinely unbounded. Evicting one per insert would never converge.
import { getDb } from './db.js';
import { GALLERY_SCHEMA, ensureColumn, tableExists } from './gallery-schema.js';
import { newRenderId } from './object-keys.js';
import { sanitizeLabel } from './render-extra.js';
import { searchTerms, likePattern, createSearchStatements } from './render-search.js';
import { BLOB_TOMBSTONE_SCHEMA } from './blob-tombstones.js';
import { BLOBS_FOR_RENDERS_SQL } from './gallery-page-reads.js';
import { logger } from '../logger.js';

/** How many entries a free account keeps. Env-overridable so it can be tuned without a deploy. */
// Re-exported so `q`-handling callers and specs keep one import site. The definitions
// moved to render-search.js when this file hit its line cap; the SEAM moved, not the API.
export { searchTerms, MAX_SEARCH_QUERY, MAX_SEARCH_TERMS } from './render-search.js';

export const FREE_GALLERY_LIMIT = Number(process.env.FREE_GALLERY_LIMIT) || 10;

/**
 * How many a Stagify+ account keeps: UNLIMITED, as of 2026-08-03.
 *
 * The default is `Infinity`, not a very large number. "Unlimited" in the compare table on
 * stagify-plus.html has to be literally true, and a ceiling set high enough that nobody
 * reaches it is still a ceiling that eventually deletes somebody's render after they were
 * told it would not.
 *
 * THE ENV OVERRIDE IS KEPT, and it is why this is still a constant rather than a bare
 * `Infinity` inside capFor. Per-account gallery storage is now unbounded for paying
 * users, so if one account's history ever threatens the R2 bill this is the single lever
 * that re-imposes a ceiling without a deploy. Using it makes the pricing page wrong —
 * that is an operator's call to make in an incident, and it is why
 * test/frontend/pricing-copy.test.js pins the DEFAULT rather than the resolved value.
 *
 * `Number(undefined) || Infinity` is Infinity and `Number('200') || Infinity` is 200, so
 * the override itself behaves exactly as it did when the default was finite.
 *
 * Independent of any of that: an eviction that breaks a LIVE SHARE LINK is still reported
 * to the owner (see the `tier` field on the staging response and
 * public/scripts/app/gallery-notice.js). That path is now reached by free accounts, by
 * lapsed subscribers once their grace window closes, and by pro accounts only under the
 * override above — letting a client's link die in silence would be a broken product in
 * every one of those cases, so none of the reporting is conditional on tier.
 */
export const PRO_GALLERY_LIMIT = Number(process.env.PRO_GALLERY_LIMIT) || Infinity;

/**
 * The cap for one account.
 * @param {boolean} isPro
 * @returns {number} `Infinity` for Stagify+ unless an operator has set PRO_GALLERY_LIMIT.
 *   Callers must not assume this is finite — `evictBeyondCap` is the only thing that
 *   consumes it, and it checks.
 */
export function capFor(isPro) {
  return isPro ? PRO_GALLERY_LIMIT : FREE_GALLERY_LIMIT;
}

/** How long a lapsed Pro account keeps its full history before the cap applies. */
export const DOWNGRADE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/** A row stuck at `pending` for longer than this had its upload die; sweep it. */
export const STALE_PENDING_MS = 60 * 60 * 1000;

/**
 * How long a name the owner gives one of their renders may be.
 *
 * The ceiling lives HERE rather than in the route, for the same reason the seller
 * sign-off's does: the store is the only thing every writer goes through, so a second
 * caller added later cannot skip it. 80 is generous for "412 Rosewood Lane — master
 * bedroom" and still short enough that the card's single ellipsised line is the
 * exception rather than the rule.
 */
export const MAX_RENDER_NAME = 80;


/**
 * Clean one owner-supplied name into what gets stored.
 *
 * Returns `null` for "no name", which is the column's own default and the value that
 * makes the page fall back to the derived `<Style> <Room type>`. So clearing the box is
 * a reset rather than a render called "".
 *
 * The cleaning itself is `sanitizeLabel` (lib/data/render-extra.js), shared with the
 * filename suffix the derived name appends. One definition of "what may appear in a
 * render's name", so the owner's typed name and the suffix printed beside it cannot
 * disagree about which control characters get through — see that function for why the
 * strip runs first and the astral-safe clamp runs last.
 *
 * The `'' -> null` conversion stays HERE, because it is this column's meaning rather than
 * the cleaner's: an empty name is the ABSENCE of a name, and null is how the column says so.
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeRenderName(raw) {
  return sanitizeLabel(raw, MAX_RENDER_NAME) || null;
}

/**
 * Open the staged-render store.
 * @param {string} baseDir - Handed to getDb, as every store in lib/data does.
 */
export function createStagedRenders(baseDir) {
  const db = getDb(baseDir);
  db.exec(GALLERY_SCHEMA);
  db.exec(BLOB_TOMBSTONE_SCHEMA);
  // Read from SQL by the eviction query, so it cannot live in extra_json. `users` belongs
  // to createAuthStore; when that has not run (a route test mounting only the gallery, or
  // a different construction order) there is simply no grace window to consult, and the
  // cap applies as normal.
  const hasUsers = tableExists(db, 'users');
  ensureColumn(db, 'users', 'gallery_grace_until', 'INTEGER');
  // The owner's own label for a render. Rides the guarded-ALTER escape hatch rather than
  // extra_json for the same reason gallery_shares.token_plain does: the listing selects it
  // on every page load, and a column the listing filters and sorts by should be a column.
  // (extra_json IS read back now — lib/data/render-extra.js — but only as an opaque blob
  // deserialized per row, which is exactly what this column must not be.) NULL is
  // "unnamed", which is what makes the page derive `<Style> <Room type>` instead — a
  // default that is computed rather than stored also means it is not frozen at the moment
  // the render was made.
  //
  // MUST run before the statements below are prepared: better-sqlite3 resolves `SELECT *`
  // and the column list at prepare time, so an ALTER afterwards would not be seen.
  ensureColumn(db, 'staged_renders', 'custom_name', 'TEXT');

  const q = {
    insRender: db.prepare(`
      INSERT INTO staged_renders
        (id, user_id, created_at, status, width, height, room_type, furniture_style,
         additional_prompt, remove_furniture, model, variation, batch_id, extra_json)
      VALUES (@id, @userId, @createdAt, @status, @width, @height, @roomType, @furnitureStyle,
              @additionalPrompt, @removeFurniture, @model, @variation, @batchId, @extraJson)
    `),
    insBlob: db.prepare(`
      INSERT OR REPLACE INTO render_blobs (render_id, role, storage_key, bytes, user_id)
      VALUES (?, ?, ?, ?, ?)
    `),

    // Everything past the cap, in "keep this first" order. `status <> 'failed'` keeps a
    // failed upload from consuming a slot the user never got any value from.
    //
    // Three sort terms, and the FIRST one is not decoration. The render being inserted
    // right now is pinned to the front so it can never be its own eviction victim:
    // without it, a free account whose entries are all shared inserts a 21st, the
    // share-protection sorts all twenty ahead of it, and the brand-new render — the one
    // the user just spent a generation on — is what falls off the end. Protecting a
    // shared link is worth breaking; making a render vanish the instant it is created is
    // not.
    //
    // Share-protection is second: it buys "do not break the link the agent just texted a
    // buyer" without being a pin, because shared entries still occupy slots.
    evictionCandidates: db.prepare(`
      SELECT r.id FROM staged_renders r
      WHERE r.user_id = ? AND r.evicted_at IS NULL AND r.status <> 'failed'
      ORDER BY (r.id = ?) DESC,
               EXISTS(SELECT 1 FROM gallery_shares s
                      WHERE s.render_id = r.id AND s.revoked_at IS NULL) DESC,
               r.created_at DESC, r.rowid DESC
      LIMIT -1 OFFSET ?
    `),
    hadLiveShare: db.prepare('SELECT 1 FROM gallery_shares WHERE render_id = ? AND revoked_at IS NULL'),

    tombstoneBlobs: db.prepare(`
      INSERT OR IGNORE INTO blob_tombstones (storage_key, created_at)
      SELECT storage_key, ? FROM render_blobs WHERE render_id = ?
    `),
    dropBlobs: db.prepare('DELETE FROM render_blobs WHERE render_id = ?'),
    revokeShares: db.prepare('UPDATE gallery_shares SET revoked_at = ? WHERE render_id = ? AND revoked_at IS NULL'),
    markEvicted: db.prepare('UPDATE staged_renders SET evicted_at = ? WHERE id = ?'),
    dropRefs: db.prepare('DELETE FROM render_refs WHERE render_id = ?'),
    // Derive, never count: a reference object dies when no render_refs row names it any
    // more. A denormalized ref_count has two failure modes and one is user-visible — a
    // lost decrement leaks an object (harmless), a double-decrement deletes bytes a live
    // gallery entry still points at (a broken image, forever). There is no counter to
    // get wrong if there is no counter.
    tombstoneOrphanRefs: db.prepare(`
      INSERT OR IGNORE INTO blob_tombstones (storage_key, created_at)
      SELECT o.storage_key, ? FROM ref_objects o
      WHERE o.user_id = ? AND NOT EXISTS (SELECT 1 FROM render_refs rr WHERE rr.ref_hash = o.ref_hash)
    `),
    dropOrphanRefs: db.prepare(`
      DELETE FROM ref_objects
      WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM render_refs rr WHERE rr.ref_hash = ref_objects.ref_hash)
    `),

    graceFor: hasUsers ? db.prepare('SELECT gallery_grace_until FROM users WHERE id = ?') : null,
    setGrace: hasUsers ? db.prepare('UPDATE users SET gallery_grace_until = ? WHERE id = ?') : null,
    markOk: db.prepare('UPDATE staged_renders SET status = ?, width = ?, height = ? WHERE id = ?'),
    // `user_id` is in the WHERE, not checked in JS beforehand: the id in the path is
    // untrusted, and a check-then-write is a second statement somebody can forget. An
    // evicted row is excluded too — renaming something the cap already took would
    // succeed against a row the gallery no longer lists.
    rename: db.prepare('UPDATE staged_renders SET custom_name = ? WHERE id = ? AND user_id = ? AND evicted_at IS NULL'),
    markFailed: db.prepare("UPDATE staged_renders SET status = 'failed' WHERE id = ?"),
    getRender: db.prepare('SELECT * FROM staged_renders WHERE id = ?'),
    blobsFor: db.prepare('SELECT role, storage_key, bytes FROM render_blobs WHERE render_id = ?'),
    // The same read for a PAGE of renders — see BLOBS_FOR_RENDERS_SQL for why json_each.
    blobsForRenders: db.prepare(BLOBS_FOR_RENDERS_SQL),
    listForUser: db.prepare(`
      SELECT * FROM staged_renders
      WHERE user_id = ? AND evicted_at IS NULL AND status = 'ok'
      ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?
    `),
    countForUser: db.prepare(`
      SELECT COUNT(*) AS n FROM staged_renders
      WHERE user_id = ? AND evicted_at IS NULL AND status = 'ok'
    `),
    // The OPERATOR's view of one account: every row, whatever its status, including
    // the ones the owner's gallery deliberately hides. `listForUser` filters to
    // `ok AND evicted_at IS NULL` because a customer should not see a broken tile —
    // but "it failed", "it is stuck pending" and "it was reaped" are exactly the
    // states a support question is about, so this one filters nothing.
    listAllForUser: db.prepare(`
      SELECT * FROM staged_renders
      WHERE user_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?
    `),
    countAllForUser: db.prepare('SELECT COUNT(*) AS n FROM staged_renders WHERE user_id = ?'),
    stalePending: db.prepare("SELECT id FROM staged_renders WHERE status = 'pending' AND created_at < ?"),
  };

  const searchStatement = createSearchStatements(db);

  /**
   * Is this account inside its post-downgrade grace window?
   *
   * Evicting hundreds of entries on a lapsed subscriber's next render is brutal, silent,
   * and lands at the worst possible moment. During the window the cap is not applied at
   * all — suppressed, not merely deferred per row — and a lifecycle email tells them
   * when it ends. That is one of the better win-back triggers this product has, and it
   * falls out of a decision that had to be made anyway.
   *
   * @param {string} userId
   * @param {number} now
   * @returns {boolean}
   */
  function inGracePeriod(userId, now) {
    if (!q.graceFor) return false;
    const row = /** @type {any} */ (q.graceFor.get(userId));
    return !!row?.gallery_grace_until && row.gallery_grace_until > now;
  }

  /**
   * The eviction half, inside whatever transaction calls it.
   * @param {string} userId
   * @param {number} cap - Entries to keep; `Infinity` means no cap.
   * @param {number} now
   * @param {string} [protectId] - A render that must never be evicted by this pass —
   *   the one currently being inserted. Empty when the cap is being applied on its own.
   * @returns {{ id: string, hadLiveShare: boolean }[]}
   */
  function evictBeyondCap(userId, cap, now, protectId = '') {
    if (!Number.isFinite(cap)) return [];
    const doomed = /** @type {any[]} */ (q.evictionCandidates.all(userId, protectId, cap));
    const evicted = [];
    for (const { id } of doomed) {
      const hadLiveShare = !!q.hadLiveShare.get(id);
      // Tombstone BEFORE dropping the rows that name the keys — after the DELETE there
      // is nothing left to read them from.
      q.tombstoneBlobs.run(now, id);
      q.dropBlobs.run(id);
      q.dropRefs.run(id);
      // A link to bytes that are about to vanish must not stay live.
      q.revokeShares.run(now, id);
      q.markEvicted.run(now, id);
      evicted.push({ id, hadLiveShare });
    }
    if (evicted.length) {
      // Reference objects are shared across renders, so they can only be swept once
      // every doomed render's render_refs rows are gone.
      q.tombstoneOrphanRefs.run(now, userId);
      q.dropOrphanRefs.run(userId);
    }
    return evicted;
  }

  const insertWithEviction = db.transaction((/** @type {any} */ arg) => {
    const { render, blobs, cap, now } = arg;
    q.insRender.run({
      id: render.id,
      userId: render.userId,
      createdAt: now,
      status: 'pending',
      width: render.width ?? null,
      height: render.height ?? null,
      roomType: render.roomType ?? null,
      furnitureStyle: render.furnitureStyle ?? null,
      additionalPrompt: render.additionalPrompt ?? null,
      removeFurniture: render.removeFurniture ? 1 : 0,
      model: render.model ?? null,
      variation: render.variation ?? 0,
      batchId: render.batchId ?? null,
      extraJson: render.extra ? JSON.stringify(render.extra) : null,
    });
    for (const b of blobs ?? []) q.insBlob.run(render.id, b.role, b.storageKey, b.bytes ?? 0, render.userId);
    return { id: render.id, evicted: evictBeyondCap(render.userId, cap, now, render.id) };
  });

  return {
    FREE_GALLERY_LIMIT,
    PRO_GALLERY_LIMIT,

    /**
     * Record one staged result and enforce the account's cap, atomically.
     *
     * The row lands at `status: 'pending'` with its object keys already planned, so the
     * async upload has somewhere to report to and a crash mid-upload leaves a row the
     * stale-pending sweep can find. It does NOT appear in the gallery until `markOk`.
     *
     * @param {{ render: { id?: string, userId: string, width?: number, height?: number,
     *   roomType?: string, furnitureStyle?: string, additionalPrompt?: string,
     *   removeFurniture?: boolean, model?: string, variation?: number, batchId?: string,
     *   extra?: import('./render-extra.js').RenderExtra | null },
     *   blobs?: { role: string, storageKey: string, bytes?: number }[],
     *   isPro?: boolean, now?: number }} arg - `extra` is serialized verbatim into
     *   `extra_json`; build it with `buildRenderExtra` rather than by hand, which is what
     *   lib/staging/render-persistence.js — the one door every writer goes through — does.
     * @returns {{ id: string, evicted: { id: string, hadLiveShare: boolean }[] }}
     */
    record({ render, blobs, isPro = false, now = Date.now() }) {
      const id = render.id ?? newRenderId();
      const cap = inGracePeriod(render.userId, now) ? Infinity : capFor(isPro);
      return insertWithEviction({ render: { ...render, id }, blobs, cap, now });
    },

    /**
     * Apply the cap to an account outside an insert — used when a grace window expires.
     *
     * @param {{ userId: string, isPro?: boolean, now?: number, cap?: number }} arg - `cap`
     *   overrides the tier ceiling. Tests only: the pro ceiling is Infinity by default, so
     *   there is no pro cap to exercise for real at all, and an operator-set one would mean
     *   hundreds of render rows and blob rows per assertion. The seam lets a spec drive the
     *   same code path at a workable size. Production never passes it, which is why the
     *   default comes from capFor rather than a literal.
     * @returns {{ id: string, hadLiveShare: boolean }[]}
     */
    enforceCap({ userId, isPro = false, now = Date.now(), cap }) {
      const limit = inGracePeriod(userId, now) ? Infinity : (cap ?? capFor(isPro));
      return db.transaction(() => evictBeyondCap(userId, limit, now))();
    },

    /**
     * Start the post-downgrade grace window.
     * @param {string} userId
     * @param {number} [now]
     */
    startGrace(userId, now = Date.now()) {
      q.setGrace?.run(now + DOWNGRADE_GRACE_MS, userId);
    },

    /** @param {string} userId @param {number} [now] @returns {boolean} */
    isInGrace(userId, now = Date.now()) {
      return inGracePeriod(userId, now);
    },

    /**
     * Record (or correct) one stored blob's key and true byte count.
     *
     * `record` plans the `after`/`thumb` keys up front with a zero byte count so a
     * crash mid-upload still leaves rows the stale sweep can tombstone. This is the
     * upload path writing back what actually landed — including `before`, which is only
     * known to exist once the source photo has successfully encoded. INSERT OR REPLACE,
     * so it is safe to call for a role that was pre-planned and for one that was not.
     *
     * @param {string} renderId
     * @param {string} role - One of the RENDER_ROLES.
     * @param {string} storageKey
     * @param {number} bytes
     * @param {string} userId - Denormalized so the GDPR drift guard can see this table.
     */
    recordBlob(renderId, role, storageKey, bytes, userId) {
      q.insBlob.run(renderId, role, storageKey, bytes ?? 0, userId);
    },

    /**
     * Give one render the owner's own name, or take it away again.
     *
     * The normalization is not the caller's job — every writer goes through here, so the
     * ceiling and the control-character strip cannot be skipped by a second route added
     * later. An empty or blank name stores NULL, which restores the derived
     * `<Style> <Room type>` rather than leaving a render called "".
     *
     * @param {{ id: string, userId: string, name?: unknown }} arg - `userId` is the
     *   validated session id and is part of the WHERE, never a request body.
     * @returns {{ ok: boolean, name: string }} `ok` is false when no row of the caller's
     *   matched; `name` is what was actually stored ('' meaning "back to the default").
     */
    rename({ id, userId, name }) {
      const stored = normalizeRenderName(name);
      const res = q.rename.run(stored, id, userId);
      return { ok: res.changes > 0, name: stored ?? '' };
    },

    /**
     * Promote a render to visible once its bytes are stored.
     * @param {string} id @param {{ width?: number, height?: number }} [dims]
     */
    markOk(id, dims = {}) {
      q.markOk.run('ok', dims.width ?? null, dims.height ?? null, id);
    },

    /** @param {string} id */
    markFailed(id) {
      q.markFailed.run(id);
    },

    /** @param {string} id @returns {any} */
    get(id) {
      return q.getRender.get(id);
    },

    /** @param {string} renderId @returns {{ role: string, storage_key: string, bytes: number }[]} */
    blobsFor(renderId) {
      return /** @type {any} */ (q.blobsFor.all(renderId));
    },

    /**
     * The blobs for a whole page of renders, grouped by render.
     *
     * The gallery listing used to call {@link blobsFor} once per row inside its map, making a
     * page LINEAR in its own size — sixty synchronous statements, sixty blocking hops through
     * the event loop, for one request. Nothing bounds an account's row count now that
     * PRO_GALLERY_LIMIT is Infinity, so nothing bounded how far that could grow either.
     *
     * A render with no blob rows is ABSENT rather than present with an empty array: callers
     * already handle "not in the page", and a second empty-ish state is one more to get wrong.
     *
     * @param {string[]} renderIds
     * @returns {Map<string, { role: string, storage_key: string, bytes: number }[]>}
     */
    blobsForRenders(renderIds) {
      const out = new Map();
      if (!renderIds?.length) return out;
      for (const row of /** @type {any[]} */ (q.blobsForRenders.all(JSON.stringify(renderIds)))) {
        const list = out.get(row.render_id);
        if (list) list.push(row);
        else out.set(row.render_id, [row]);
      }
      return out;
    },

    /**
     * One page of an account's gallery, newest first. Only `ok` rows: a render whose
     * upload failed is absent rather than a broken image.
     *
     * `q` narrows it to the rows matching every term (see {@link searchTerms}). It is the
     * SAME method rather than a `searchForUser` twin on purpose: the pager and the count
     * have to page and count the SAME set the grid is showing, and two entry points is how
     * a search ends up with the unfiltered total underneath it.
     *
     * @param {{ userId: string, limit?: number, offset?: number, q?: string }} arg
     * @returns {any[]}
     */
    listForUser({ userId, limit = 60, offset = 0, q: query = '' }) {
      const terms = searchTerms(query);
      if (!terms.length) return /** @type {any} */ (q.listForUser.all(userId, limit, offset));
      return /** @type {any} */ (
        searchStatement(terms.length, false).all(userId, ...terms.map(likePattern), limit, offset)
      );
    },

    /**
     * Every render an account has, newest first, WHATEVER its status — the
     * operator console's read, not the owner's.
     *
     * Deliberately not a flag on {@link listForUser}: that method's filter is a
     * product promise (no broken tiles in a customer's gallery) and making it
     * optional would put one keystroke between the console and shipping a failed
     * render into somebody's grid. A separate statement cannot be misused that way.
     *
     * Failed, `pending` and evicted rows all come back. An evicted row still exists
     * and still carries its parameters; only its bytes are gone, so the caller has
     * to render it as reaped rather than as a broken image.
     *
     * @param {{ userId: string, limit?: number, offset?: number }} arg
     * @returns {any[]}
     */
    listAllForUser({ userId, limit = 50, offset = 0 }) {
      return /** @type {any} */ (q.listAllForUser.all(userId, limit, offset));
    },

    /**
     * How many renders the account has in total, counting every status.
     * @param {string} userId @returns {number}
     */
    countAllForUser(userId) {
      return Number(/** @type {any} */ (q.countAllForUser.get(userId)).n) || 0;
    },

    /**
     * How many entries the account has, or how many match `q`.
     * @param {string} userId @param {{ q?: string }} [arg] @returns {number}
     */
    countForUser(userId, { q: query = '' } = {}) {
      const terms = searchTerms(query);
      if (!terms.length) return /** @type {any} */ (q.countForUser.get(userId)).n;
      return /** @type {any} */ (searchStatement(terms.length, true).get(userId, ...terms.map(likePattern))).n;
    },

    /**
     * Delete one entry outright — the user asking, rather than the cap.
     *
     * This is the HARD revoke: tombstoning the bytes means an outstanding presigned URL
     * starts 404ing as soon as the reaper runs, whereas revoking a share only stops NEW
     * URLs being minted and leaves live ones working until they expire.
     *
     * @param {{ id: string, userId: string, now?: number }} arg - `userId` is the
     *   validated session id and is part of the WHERE, never a request body.
     * @returns {boolean} True when a row belonging to that user was removed.
     */
    remove({ id, userId, now = Date.now() }) {
      return db.transaction(() => {
        const row = /** @type {any} */ (q.getRender.get(id));
        if (!row || row.user_id !== userId) return false;
        q.tombstoneBlobs.run(now, id);
        q.dropBlobs.run(id);
        q.dropRefs.run(id);
        q.revokeShares.run(now, id);
        q.markEvicted.run(now, id);
        q.tombstoneOrphanRefs.run(now, userId);
        q.dropOrphanRefs.run(userId);
        return true;
      })();
    },

    /**
     * Mark rows whose upload never finished as failed, and queue whatever bytes did land.
     *
     * An hour is three orders of magnitude past any real render, and it is measured
     * against the row's own `created_at` rather than process uptime, so a restart in the
     * middle of a sweep cannot mark a live render failed.
     *
     * @param {{ minAgeMs?: number, now?: number }} [arg]
     * @returns {number} How many rows were swept.
     */
    sweepStalePending({ minAgeMs = STALE_PENDING_MS, now = Date.now() } = {}) {
      const stale = /** @type {any[]} */ (q.stalePending.all(now - minAgeMs));
      if (!stale.length) return 0;
      db.transaction(() => {
        for (const { id } of stale) {
          q.tombstoneBlobs.run(now, id);
          q.dropBlobs.run(id);
          q.markFailed.run(id);
        }
      })();
      logger.warn(`[gallery] swept ${stale.length} render(s) stuck mid-upload`);
      return stale.length;
    },
  };
}
