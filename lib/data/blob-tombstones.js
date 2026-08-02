// The queue of object-store bytes that are owed a deletion.
//
// THE PROBLEM THIS SOLVES
// Deleting a user is a synchronous SQLite transaction (lib/data/user-deletion.js) — an
// account is either fully gone or still entirely present, never half-erased. Deleting
// the same user's render bytes is an ASYNC network call to R2 that can fail, and the
// process can be killed between two of them. Those two facts cannot be reconciled by
// making `deleteUser` async: an `await store.remove(key)` that rejects loses the work
// with nothing on disk recording that it was ever owed, and awaiting inside the
// transaction would hold the write lock across the network.
//
// So the transaction commits the OBLIGATION instead of performing it. Row-atomic, in
// the same transaction as the rows themselves, and — because it is a SQLite row —
// replicated to R2 by Litestream like everything else. R2 being down, the process being
// killed, a network partition: none of them lose the obligation. A reaper drains the
// queue afterwards and retries until it wins.
//
// This is also what free-tier eviction uses (lib/data/staged-renders.js), which is why
// it is a general queue rather than an erasure-only hack.
//
// WHY THERE IS NO user_id COLUMN, AND WHY THAT IS DELIBERATE
// Every other user-keyed table in this app carries one so the GDPR drift guard in
// test/data/user-deletion.test.js can SEE it. This table must not. It holds keys whose
// owning rows are ALREADY deleted; giving it a user id would make the guard demand that
// an erasure delete these rows too — and an erasure deleting its own work queue is
// precisely the bug. It is exempted in NOT_USER_KEYED with that reasoning spelled out.
// The exemption is only honest because lib/data/object-keys.js keeps user ids out of
// the keys themselves, so a tombstone is genuinely opaque.
import { getDb } from './db.js';
import { isSafeObjectKey } from './object-keys.js';
import { logger } from '../logger.js';

/**
 * The queue's schema.
 *
 * Exported because lib/data/user-deletion.js WRITES to this table and must not depend
 * on somebody having constructed the store factory first. Erasure is the one path that
 * absolutely cannot fail with "no such table", and making it order-dependent on a
 * factory it does not otherwise use would be a boot-order trap. One definition, two
 * places that `exec` it, `IF NOT EXISTS` so the second is free.
 */
export const BLOB_TOMBSTONE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS blob_tombstones (
    storage_key     TEXT PRIMARY KEY,
    created_at      INTEGER NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER,
    last_error      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tombstones_attempts ON blob_tombstones (attempts, created_at);
`;

/** How many keys one drain pass will attempt. */
export const DEFAULT_DRAIN_LIMIT = 200;

/**
 * Errors that mean "this key can never succeed", as opposed to "R2 is unhappy right
 * now". A malformed key cannot become well-formed by waiting, so retrying it forever
 * would keep a poison row at the head of the queue. Anything else — a 500, a timeout, a
 * DNS failure — is transient by assumption and retried.
 */
const TERMINAL_CODES = new Set(['EUNSAFEKEY']);

/**
 * Open the tombstone queue over the shared connection.
 * @param {string} baseDir - Handed to getDb, as every store in lib/data does.
 * @returns {{
 *   enqueue: (keys: string[], now?: number) => number,
 *   enqueueStatement: () => any,
 *   take: (limit?: number) => { storage_key: string, attempts: number }[],
 *   markDone: (key: string) => void,
 *   markFailed: (key: string, error: unknown, now?: number) => void,
 *   pending: () => number,
 *   clear: () => void,
 * }}
 */
export function createBlobTombstones(baseDir) {
  const db = getDb(baseDir);
  db.exec(BLOB_TOMBSTONE_SCHEMA);

  const q = {
    ins: db.prepare('INSERT OR IGNORE INTO blob_tombstones (storage_key, created_at) VALUES (?, ?)'),
    // Cheapest-first: a key that has never been tried goes before one that has failed
    // twice, so a persistent failure cannot starve fresh work behind it.
    take: db.prepare('SELECT storage_key, attempts FROM blob_tombstones ORDER BY attempts ASC, created_at ASC LIMIT ?'),
    del: db.prepare('DELETE FROM blob_tombstones WHERE storage_key = ?'),
    fail: db.prepare('UPDATE blob_tombstones SET attempts = attempts + 1, last_attempt_at = ?, last_error = ? WHERE storage_key = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM blob_tombstones'),
    clear: db.prepare('DELETE FROM blob_tombstones'),
  };

  return {
    /**
     * Record that these keys are owed a deletion. Idempotent via `INSERT OR IGNORE`,
     * which matters because two concurrent erasures (or an eviction racing an erasure)
     * can name the same reference blob.
     * @param {string[]} keys - Storage keys.
     * @param {number} [now] - Clock, injectable for tests.
     * @returns {number} How many rows were newly created.
     */
    enqueue(keys, now = Date.now()) {
      let added = 0;
      for (const key of keys ?? []) {
        if (!isSafeObjectKey(key)) {
          // Never enqueue something the store would refuse anyway — it would sit in the
          // queue being permanently terminal. Loud, because a malformed storage_key in
          // a row means something upstream built a key it should not have.
          logger.error(`[tombstones] refusing to enqueue an unsafe key: ${JSON.stringify(key)}`);
          continue;
        }
        added += q.ins.run(key, now).changes;
      }
      return added;
    },

    /**
     * The raw prepared INSERT, for callers that need to enqueue from INSIDE their own
     * transaction (erasure, eviction) rather than as a separate step. Using the same
     * statement is what keeps "the rows and the obligation commit together" true —
     * calling `enqueue` from inside another transaction would work, but this makes the
     * shared-statement intent explicit at the call site.
     * @returns {any} The `INSERT OR IGNORE` statement, taking (storage_key, created_at).
     */
    enqueueStatement() {
      return q.ins;
    },

    /** @param {number} [limit] @returns {{storage_key: string, attempts: number}[]} */
    take(limit = DEFAULT_DRAIN_LIMIT) {
      return /** @type {any} */ (q.take.all(limit));
    },

    /** @param {string} key */
    markDone(key) {
      q.del.run(key);
    },

    /**
     * Record a failed attempt, or give up when the failure can never resolve.
     * @param {string} key - Storage key.
     * @param {unknown} error - What `remove` threw.
     * @param {number} [now] - Clock, injectable for tests.
     */
    markFailed(key, error, now = Date.now()) {
      const code = /** @type {any} */ (error)?.code;
      if (TERMINAL_CODES.has(code)) {
        logger.error(`[tombstones] dropping ${key}: ${code} can never succeed`);
        q.del.run(key);
        return;
      }
      q.fail.run(now, String(/** @type {any} */ (error)?.message ?? error).slice(0, 500), key);
    },

    /** @returns {number} How many deletions are still owed. */
    pending() {
      return /** @type {any} */ (q.count.get()).n;
    },

    /** Tests only. */
    clear() {
      q.clear.run();
    },
  };
}

/**
 * Build the reaper that drains the queue against an object store.
 *
 * @param {{ tombstones: ReturnType<typeof createBlobTombstones>,
 *   objectStore: import('./object-store.js').ObjectStore }} deps
 * @returns {{ drain: (opts?: { limit?: number }) => Promise<{ attempted: number, deleted: number, failed: number }> }}
 */
export function createBlobReaper({ tombstones, objectStore }) {
  let running = false;

  return {
    /**
     * Attempt up to `limit` owed deletions.
     *
     * NEVER REJECTS. It is called as `void reaper.drain()` from a post-commit path and
     * from a setInterval, and an unhandled rejection in Node 22 exits the process — so
     * losing a queue drain would take the whole server with it. Every failure is
     * recorded on its row and retried on the next pass instead.
     *
     * Re-entrancy is guarded because the interval can fire while a long drain is still
     * in flight; two passes would `take()` the same rows and delete twice (harmless,
     * `remove` is idempotent) while doubling the load for nothing.
     *
     * @param {{ limit?: number }} [opts]
     * @returns {Promise<{ attempted: number, deleted: number, failed: number }>}
     */
    async drain({ limit = DEFAULT_DRAIN_LIMIT } = {}) {
      const result = { attempted: 0, deleted: 0, failed: 0 };
      if (running || !objectStore.configured) return result;
      running = true;
      try {
        const batch = tombstones.take(limit);
        for (const row of batch) {
          result.attempted += 1;
          try {
            await objectStore.remove(row.storage_key);
            // `remove` answers false for an object that was already gone. That is still
            // success: the obligation was "make sure this is not there".
            tombstones.markDone(row.storage_key);
            result.deleted += 1;
          } catch (error) {
            tombstones.markFailed(row.storage_key, error);
            result.failed += 1;
          }
        }
        if (result.failed) {
          logger.warn(`[tombstones] ${result.failed}/${result.attempted} deletions failed; they stay queued`);
        }
      } catch (error) {
        // A failure of take()/the connection itself. The queue is durable, so the next
        // pass simply tries again.
        logger.error('[tombstones] drain aborted:', error);
      } finally {
        running = false;
      }
      return result;
    },
  };
}
