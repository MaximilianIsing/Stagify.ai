// Stripe webhook idempotency — the "have I already handled this event?" ledger.
//
// Stripe guarantees AT-LEAST-once delivery: it retries any event it did not get a
// 2xx for (for up to ~3 days), and it can also deliver the same event twice on its
// own. Today's handlers survive that only because each one happens to be a
// last-write-wins upsert and the lifecycle emails carry their own per-user "sent"
// flags. That is a property of the current handlers, not of the webhook, and the
// first handler that increments a counter, grants credits, or reports metered
// usage would silently double-apply. This table makes the guarantee structural.
//
// Protocol (see routes/billing.js): claim() BEFORE handling, then either
// markDone() on success or release() on failure — releasing so Stripe's retry of a
// genuinely-failed event still gets to run. A row is therefore one of:
//   status='processing' → claimed, outcome unknown (in flight, or the process died)
//   status='done'       → handled successfully; every later delivery is a duplicate
//
// A 'processing' row older than RECLAIM_MS is assumed abandoned (the process was
// killed mid-handler, so release() never ran) and is re-claimable. Without that,
// one unlucky restart would black-hole an event forever.
//
// Lives in the shared application database (lib/data/db.js) like every other
// store, so Litestream backs it up with the rest of the durable state.

import { getDb } from './db.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stripe_events (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'processing',
  claimed_at   INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_stripe_events_claimed_at ON stripe_events (claimed_at);
`;

// A claim this old is treated as abandoned and may be re-claimed. Comfortably
// longer than any handler (Stripe itself times the request out at ~30s) and much
// shorter than Stripe's retry window, so a crashed delivery is retried, not lost.
const RECLAIM_MS = 5 * 60 * 1000;

// How long handled events stay on file. Stripe retries for ~3 days, so 30 gives a
// wide margin while keeping the table to the handful of rows a month of billing
// traffic produces.
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Build the Stripe-event idempotency ledger over the shared app database.
 * @param {string} baseDir - Server base dir (resolves to /data on Render, ./data locally).
 * @param {{ now?: () => number }} [opts] - Injectable clock (tests).
 * @returns {{
 *   claim: (event: any) => { fresh: boolean, reason: string },
 *   markDone: (eventId: string) => void,
 *   release: (eventId: string) => void,
 *   get: (eventId: string) => { id: string, type: string, status: string, claimedAt: number, completedAt: number | null } | null,
 *   count: () => number,
 * }} The ledger API.
 */
export function createStripeEventLog(baseDir, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const db = getDb(baseDir);
  db.exec(SCHEMA);

  const q = {
    insert: db.prepare(
      "INSERT OR IGNORE INTO stripe_events (id, type, status, claimed_at) VALUES (?, ?, 'processing', ?)",
    ),
    byId: db.prepare('SELECT id, type, status, claimed_at, completed_at FROM stripe_events WHERE id = ?'),
    reclaim: db.prepare("UPDATE stripe_events SET status = 'processing', claimed_at = ?, completed_at = NULL WHERE id = ?"),
    complete: db.prepare("UPDATE stripe_events SET status = 'done', completed_at = ? WHERE id = ?"),
    del: db.prepare('DELETE FROM stripe_events WHERE id = ?'),
    prune: db.prepare('DELETE FROM stripe_events WHERE claimed_at < ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM stripe_events'),
  };

  /**
   * Insert-or-inspect, as one atomic step so two deliveries of the same event can
   * never both come back fresh.
   * @param {string} id - The Stripe event id.
   * @param {string} type - The Stripe event type (recorded for operators).
   * @param {number} nowMs - Current time.
   * @returns {{ fresh: boolean, reason: string }} Whether the caller owns this event.
   */
  const claimTxn = db.transaction((id, type, nowMs) => {
    if (q.insert.run(id, type, nowMs).changes === 1) {
      q.prune.run(nowMs - RETENTION_MS);
      return { fresh: true, reason: 'new' };
    }
    const row = q.byId.get(id);
    // Pruned out from under us between the INSERT and the SELECT: nothing on file
    // says it was handled, so handling it again is the safe read.
    if (!row) return { fresh: true, reason: 'new' };
    if (row.status === 'done') return { fresh: false, reason: 'duplicate' };
    if (nowMs - row.claimed_at >= RECLAIM_MS) {
      q.reclaim.run(nowMs, id);
      return { fresh: true, reason: 'reclaimed' };
    }
    return { fresh: false, reason: 'in_flight' };
  });

  /**
   * Take ownership of an event before handling it.
   * @param {any} event - The verified Stripe event.
   * @returns {{ fresh: boolean, reason: string }} `fresh:false` means: already
   *   handled (or being handled right now) — ack it and do nothing else.
   */
  function claim(event) {
    const id = event && typeof event.id === 'string' ? event.id : '';
    // No id to key on (a hand-made or very old payload). Untracked rather than
    // blocked — the dedup is a safety net, not an authentication step.
    if (!id) return { fresh: true, reason: 'unidentified' };
    return claimTxn(id, (event && event.type) || '', now());
  }

  /**
   * Record that an event was handled successfully — later deliveries are duplicates.
   * @param {string} eventId - The Stripe event id.
   * @returns {void}
   */
  function markDone(eventId) {
    if (!eventId) return;
    q.complete.run(now(), eventId);
  }

  /**
   * Give up a claim after a failed handler, so Stripe's retry re-runs the event
   * instead of being deduped against the attempt that never completed.
   * @param {string} eventId - The Stripe event id.
   * @returns {void}
   */
  function release(eventId) {
    if (!eventId) return;
    q.del.run(eventId);
  }

  /**
   * Read one ledger row (admin/debug + tests).
   * @param {string} eventId - The Stripe event id.
   * @returns {{ id: string, type: string, status: string, claimedAt: number, completedAt: number | null } | null} The row, or null.
   */
  function get(eventId) {
    const row = q.byId.get(eventId);
    if (!row) return null;
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      claimedAt: row.claimed_at,
      completedAt: row.completed_at ?? null,
    };
  }

  /** @returns {number} How many events are on file. */
  function count() {
    return q.count.get().n;
  }

  return { claim, markDone, release, get, count };
}

export const STRIPE_EVENT_RECLAIM_MS = RECLAIM_MS;
export const STRIPE_EVENT_RETENTION_MS = RETENTION_MS;
