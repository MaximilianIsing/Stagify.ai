// Prepaid credits for the public API — the balance, the append-only ledger behind
// it, and the per-request idempotency record that ties a charge to one render.
//
// WHY PREPAID. The API hands a machine caller an image generator. Postpaid metering
// (what `enterprise_domains.usage_count` does) makes a leaked key an unbounded
// liability: nothing stops a stolen credential spending until the invoice arrives.
// A prepaid balance bounds the worst case at exactly what was already paid, which is
// the single best property this design has and the one the docs should lead with.
//
// THE UNIT IS A WHOLE IMAGE. `balance` counts delivered images, never cents. Packs
// vary in $/credit; the unit never does. That keeps every guard below to integer
// arithmetic with no rounding, and makes the 402 copy trivially truthful.
//
// THE LEDGER IS THE SOURCE OF TRUTH; `balance` IS A CACHE OF IT. Every balance
// mutation writes a ledger row in the SAME transaction, so `balance` is always
// re-derivable as SUM(delta) — an invariant test/data/api-billing.test.js asserts
// over a randomized sequence. If the two ever disagree, the ledger is right.
//
// THE CLAIM BARRIER IS IN THE SQL, NOT IN JS. There is deliberately no
// `if (balance >= cost)` anywhere in this file. A read-then-write check has a window
// between the read and the decrement, and two concurrent renders on the same key both
// pass it — the balance goes negative and the account renders for free. The debit is
// therefore ONE statement whose WHERE clause IS the check, and `changes === 0` is the
// only "no" this module recognises. A limit that can be raced is not a limit.
//
// The three tables live together in one module rather than one file each because
// they are written inside a single transaction (claim + debit + ledger row). Split
// across factories, construction order would become load-bearing — the same reason
// lib/data/gallery-schema.js keeps its DDL in one place.

import crypto from 'crypto';
import { getDb } from './db.js';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS api_credit_balances (
  user_id            TEXT PRIMARY KEY,
  balance            INTEGER NOT NULL DEFAULT 0,
  lifetime_purchased INTEGER NOT NULL DEFAULT 0,
  lifetime_spent     INTEGER NOT NULL DEFAULT 0,
  suspended_at       INTEGER,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_credit_ledger (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  delta         INTEGER NOT NULL,
  reason        TEXT NOT NULL,
  external_id   TEXT,
  balance_after INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  extra_json    TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_ledger_user ON api_credit_ledger (user_id, created_at);
-- The structural anti-double-credit / anti-double-refund guard. Partial, because
-- only externally-keyed rows (a Stripe session, a request id) are unique by nature —
-- an operator 'grant' or 'adjustment' carries no external id and may repeat.
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_ledger_ext
  ON api_credit_ledger (reason, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS api_requests (
  id              TEXT PRIMARY KEY,
  key_id          TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  status          TEXT NOT NULL,
  credits_charged INTEGER NOT NULL DEFAULT 0,
  attempts        INTEGER NOT NULL DEFAULT 1,
  claimed_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  extra_json      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_requests_idem ON api_requests (key_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_api_requests_user ON api_requests (user_id, claimed_at);
`;

// A 'charged' row older than this is assumed abandoned — the process died mid-render,
// so neither settle path ran. Sized for a render (minutes) rather than a webhook
// (seconds), which is why it is not RECLAIM_MS from stripe-events.js.
export const REQUEST_RECLAIM_MS = 10 * 60 * 1000;

// How many times one idempotency key may be re-run after an abandoned claim. Without
// a ceiling, replaying a key that always dies mid-render is an unbounded free render.
export const MAX_REPLAY_ATTEMPTS = 3;

/** @param {string} prefix @returns {string} A short, collision-resistant public id. */
function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(8).toString('hex');
}

/**
 * Build the prepaid-credit store over the shared app database.
 * @param {string} baseDir - Server base dir (resolves to /data on Render, ./data locally).
 * @param {{ now?: () => number }} [opts] - Injectable clock (tests).
 * @returns {ReturnType<typeof build>} The billing API.
 */
export function createApiBilling(baseDir, opts = {}) {
  const db = getDb(baseDir);
  db.exec(SCHEMA);
  return build(db, typeof opts.now === 'function' ? opts.now : () => Date.now());
}

/**
 * The statements and the operations over them.
 * @param {any} db - The shared better-sqlite3 connection.
 * @param {() => number} now - Clock.
 */
function build(db, now) {
  const q = {
    balanceRow: db.prepare('SELECT * FROM api_credit_balances WHERE user_id = ?'),
    ensureBalance: db.prepare(
      'INSERT OR IGNORE INTO api_credit_balances (user_id, balance, lifetime_purchased, lifetime_spent, updated_at) VALUES (?, 0, 0, 0, ?)',
    ),
    // THE BARRIER. Not a read-then-write: the WHERE clause is the check, so there is
    // no window for a concurrent request to slip through. `changes === 0` means the
    // account could not afford it (or is suspended) — the only "no" this module has.
    debit: db.prepare(
      `UPDATE api_credit_balances
          SET balance = balance - @cost,
              lifetime_spent = lifetime_spent + @cost,
              updated_at = @now
        WHERE user_id = @userId
          AND suspended_at IS NULL
          AND balance >= @cost`,
    ),
    credit: db.prepare(
      `UPDATE api_credit_balances
          SET balance = balance + @amount,
              lifetime_purchased = lifetime_purchased + @purchased,
              updated_at = @now
        WHERE user_id = @userId`,
    ),
    // Clawback clamps at zero rather than going negative: a negative balance would
    // read as a debt this module has no way to collect, and `suspended_at` (set by
    // the caller on a shortfall) is the honest way to stop further spend.
    clawback: db.prepare(
      `UPDATE api_credit_balances
          SET balance = MAX(0, balance - @amount),
              suspended_at = @suspendedAt,
              updated_at = @now
        WHERE user_id = @userId`,
    ),
    ledgerInsert: db.prepare(
      `INSERT INTO api_credit_ledger (id, user_id, delta, reason, external_id, balance_after, created_at, extra_json)
       VALUES (@id, @userId, @delta, @reason, @externalId, @balanceAfter, @createdAt, @extraJson)`,
    ),
    ledgerByExternal: db.prepare(
      'SELECT id FROM api_credit_ledger WHERE reason = ? AND external_id = ?',
    ),
    ledgerForUser: db.prepare(
      'SELECT * FROM api_credit_ledger WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    ),
    ledgerSum: db.prepare('SELECT COALESCE(SUM(delta), 0) AS n FROM api_credit_ledger WHERE user_id = ?'),

    insertRequest: db.prepare(
      `INSERT OR IGNORE INTO api_requests
         (id, key_id, user_id, idempotency_key, fingerprint, status, credits_charged, attempts, claimed_at)
       VALUES (@id, @keyId, @userId, @idempotencyKey, @fingerprint, 'charged', @cost, 1, @now)`,
    ),
    requestById: db.prepare('SELECT * FROM api_requests WHERE id = ?'),
    requestByIdem: db.prepare('SELECT * FROM api_requests WHERE key_id = ? AND idempotency_key = ?'),
    deleteRequest: db.prepare('DELETE FROM api_requests WHERE id = ?'),
    reclaimRequest: db.prepare(
      "UPDATE api_requests SET status = 'charged', attempts = attempts + 1, claimed_at = @now, completed_at = NULL WHERE id = @id",
    ),
    // Both settle transitions are conditional on the row still being 'charged'. That
    // is what makes calling them twice — which the two settle paths in
    // api-render-billing.js can genuinely do — harmless.
    markRefunded: db.prepare(
      "UPDATE api_requests SET status = 'refunded', completed_at = @now WHERE id = @id AND status = 'charged'",
    ),
    markSucceededQ: db.prepare(
      "UPDATE api_requests SET status = 'succeeded', completed_at = @now WHERE id = @id AND status = 'charged'",
    ),
    setRequestExtra: db.prepare('UPDATE api_requests SET extra_json = @extraJson WHERE id = @id'),

    // ── The dashboard's three reads (usageSummary) ──────────────────────────
    // All three are served by idx_api_requests_user (user_id, claimed_at), which is
    // why every one of them is anchored on both columns.
    usageByDay: db.prepare(
      `SELECT CAST((claimed_at - @since) / @dayMs AS INTEGER) AS bucket,
              SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS delivered,
              SUM(CASE WHEN status = 'refunded'  THEN 1 ELSE 0 END) AS refunded
         FROM api_requests
        WHERE user_id = @userId AND claimed_at >= @since
        GROUP BY bucket`,
    ),
    usageByKey: db.prepare(
      `SELECT key_id,
              SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS delivered,
              SUM(CASE WHEN status = 'refunded'  THEN 1 ELSE 0 END) AS refunded,
              SUM(CASE WHEN status = 'charged'   THEN 1 ELSE 0 END) AS in_flight,
              SUM(CASE WHEN status = 'succeeded' THEN credits_charged ELSE 0 END) AS credits_spent,
              SUM(CASE WHEN status = 'succeeded' AND claimed_at >= @since7 THEN 1 ELSE 0 END) AS delivered7d,
              MAX(claimed_at) AS last_at
         FROM api_requests
        WHERE user_id = @userId AND claimed_at >= @since
        GROUP BY key_id`,
    ),
    // Newest first and LIMITed: the median is taken from a sample, not from the whole
    // window, and the caller reports how big that sample was.
    usageDurations: db.prepare(
      `SELECT key_id, (completed_at - claimed_at) AS ms
         FROM api_requests
        WHERE user_id = @userId AND claimed_at >= @since
          AND status = 'succeeded' AND completed_at IS NOT NULL AND completed_at >= claimed_at
        ORDER BY claimed_at DESC
        LIMIT @limit`,
    ),
  };

  /**
   * Read a balance row, creating the zero row on first sight.
   * @param {string} userId - Account id.
   * @returns {{ userId: string, balance: number, lifetimePurchased: number, lifetimeSpent: number, suspendedAt: number | null }} The balance.
   */
  function getBalance(userId) {
    q.ensureBalance.run(userId, now());
    const row = q.balanceRow.get(userId);
    return {
      userId,
      balance: row?.balance ?? 0,
      lifetimePurchased: row?.lifetime_purchased ?? 0,
      lifetimeSpent: row?.lifetime_spent ?? 0,
      suspendedAt: row?.suspended_at ?? null,
    };
  }

  /**
   * Write a ledger row for a balance that has ALREADY moved in this transaction.
   * Never call outside one — the row and the balance must commit together.
   * @param {{ userId: string, delta: number, reason: string, externalId?: string | null, extra?: any }} entry - The movement.
   * @returns {number} The balance after the movement.
   */
  function appendLedger(entry) {
    const after = q.balanceRow.get(entry.userId)?.balance ?? 0;
    q.ledgerInsert.run({
      id: newId('cl'),
      userId: entry.userId,
      delta: entry.delta,
      reason: entry.reason,
      externalId: entry.externalId ?? null,
      balanceAfter: after,
      createdAt: now(),
      extraJson: entry.extra ? JSON.stringify(entry.extra) : null,
    });
    return after;
  }

  /**
   * Classify an existing request row for a repeated idempotency key.
   * @param {any} row - The `api_requests` row.
   * @param {string} fingerprint - The incoming request's fingerprint.
   * @param {number} nowMs - Current time.
   * @returns {any} The claim outcome.
   */
  function inspectExisting(row, fingerprint, nowMs) {
    // Fingerprint first: a key reused for DIFFERENT parameters is a client bug, and
    // answering it with the old image would be worse than refusing.
    if (row.fingerprint !== fingerprint) {
      return { ok: false, reason: 'key_reused', requestId: row.id };
    }
    if (row.status === 'succeeded') {
      return { ok: true, replay: true, requestId: row.id, row };
    }
    if (row.status === 'charged') {
      if (nowMs - row.claimed_at < REQUEST_RECLAIM_MS) {
        return { ok: false, reason: 'in_flight', requestId: row.id };
      }
      if (row.attempts >= MAX_REPLAY_ATTEMPTS) {
        return { ok: false, reason: 'too_many_attempts', requestId: row.id };
      }
      // Abandoned mid-render. Re-run it WITHOUT a second debit — the caller already
      // paid for an image they never received.
      q.reclaimRequest.run({ id: row.id, now: nowMs });
      return { ok: true, reclaimed: true, requestId: row.id, charged: 0 };
    }
    // 'refunded' or 'failed': the money was returned, so this is genuinely new work.
    return { ok: false, reason: 'settled_retry', requestId: row.id };
  }

  /**
   * Claim an idempotency key and debit the credit for it, atomically.
   *
   * The claim and the debit share one transaction so a caller can never end up
   * holding a request row it did not pay for, or a debit with no row to refund.
   * @param {{ keyId: string, userId: string, idempotencyKey: string, fingerprint: string, cost?: number }} input - The request.
   * @returns {{ ok: boolean, requestId?: string, balance?: number, charged?: number, replay?: boolean, reclaimed?: boolean, reason?: string, row?: any }} The outcome.
   */
  const claimAndDebit = db.transaction((input) => {
    const nowMs = now();
    const cost = Number.isFinite(input.cost) ? Number(input.cost) : 1;
    q.ensureBalance.run(input.userId, nowMs);

    const requestId = newId('req');
    const claimed = q.insertRequest.run({
      id: requestId,
      keyId: input.keyId,
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
      fingerprint: input.fingerprint,
      cost,
      now: nowMs,
    });

    if (claimed.changes === 0) {
      const existing = q.requestByIdem.get(input.keyId, input.idempotencyKey);
      // Raced out from under us between INSERT and SELECT. Treat as in flight rather
      // than charging twice; the caller retries.
      if (!existing) return { ok: false, reason: 'in_flight' };
      return inspectExisting(existing, input.fingerprint, nowMs);
    }

    if (q.debit.run({ cost, now: nowMs, userId: input.userId }).changes === 0) {
      // Could not afford it. Drop the claim so a retry after topping up is not met
      // with "you already used that idempotency key".
      q.deleteRequest.run(requestId);
      const row = q.balanceRow.get(input.userId);
      return {
        ok: false,
        reason: row?.suspended_at ? 'suspended' : 'insufficient',
        balance: row?.balance ?? 0,
      };
    }

    // external_id = the request id, so the partial UNIQUE index makes a second debit
    // for one request structurally impossible even if this code were called twice.
    const after = appendLedger({
      userId: input.userId,
      delta: -cost,
      reason: 'debit',
      externalId: requestId,
    });
    return { ok: true, requestId, balance: after, charged: cost };
  });

  /**
   * Return the credit for a request that did not deliver an image.
   *
   * Idempotent twice over: the status transition only fires from 'charged', and the
   * ledger's partial UNIQUE index would reject a second refund row even if it did.
   * That is what lets api-render-billing.js call this from both its settle paths.
   * @param {string} requestId - The request to refund.
   * @param {string} [tag] - Why, recorded on the ledger row for operators.
   * @returns {{ ok: boolean, credited: number, balance?: number, reason?: string }} The outcome.
   */
  const refundRequest = db.transaction((requestId, tag = 'render_failed') => {
    if (q.markRefunded.run({ id: requestId, now: now() }).changes === 0) {
      // Already refunded, already succeeded, or never existed. All three mean
      // "nothing owed" — not an error.
      return { ok: false, credited: 0, reason: 'not_refundable' };
    }
    const row = q.requestById.get(requestId);
    if (!row || row.credits_charged <= 0) return { ok: true, credited: 0 };
    q.credit.run({ userId: row.user_id, amount: row.credits_charged, purchased: 0, now: now() });
    const after = appendLedger({
      userId: row.user_id,
      delta: row.credits_charged,
      reason: 'refund',
      externalId: requestId,
      extra: { tag },
    });
    return { ok: true, credited: row.credits_charged, balance: after };
  });

  /**
   * Mark a request delivered, which is what makes any later refund a no-op.
   * @param {string} requestId - The request.
   * @param {any} [extra] - Realized cost detail (generations spent, model) for
   *   answering "what did a credit actually cost us" a month from now.
   * @returns {boolean} True when this call was the one that settled it.
   */
  function markSucceeded(requestId, extra = null) {
    const changed = q.markSucceededQ.run({ id: requestId, now: now() }).changes === 1;
    if (extra) q.setRequestExtra.run({ id: requestId, extraJson: JSON.stringify(extra) });
    return changed;
  }

  /**
   * Credit a completed Stripe purchase, exactly once per checkout session.
   *
   * The duplicate check is INSIDE the transaction and returns BEFORE any write —
   * deliberately not write-then-catch-SQLITE_CONSTRAINT, which would have already
   * applied the balance UPDATE that the throw then unwinds.
   * @param {{ userId: string, credits: number, sessionId: string, packId?: string }} input - The purchase.
   * @returns {{ ok: boolean, duplicate?: boolean, credited: number, balance?: number }} The outcome.
   */
  const creditPurchase = db.transaction((input) => {
    const nowMs = now();
    if (q.ledgerByExternal.get('purchase', input.sessionId)) {
      return { ok: true, duplicate: true, credited: 0 };
    }
    q.ensureBalance.run(input.userId, nowMs);
    q.credit.run({
      userId: input.userId,
      amount: input.credits,
      purchased: input.credits,
      now: nowMs,
    });
    const after = appendLedger({
      userId: input.userId,
      delta: input.credits,
      reason: 'purchase',
      externalId: input.sessionId,
      extra: input.packId ? { packId: input.packId } : null,
    });
    return { ok: true, credited: input.credits, balance: after };
  });

  /**
   * Take back credits after a refund or a chargeback, and suspend on a shortfall.
   *
   * Without this, spend-then-chargeback is a free render. Clamped at zero because a
   * negative balance is a debt with no collection path; the suspension is what
   * actually stops further spend, and `requireApiKey` turns it into a 403.
   * @param {{ userId: string, credits: number, externalId: string }} input - The clawback.
   * @returns {{ ok: boolean, clawed: number, shortfall: number, suspended: boolean, duplicate?: boolean }} The outcome.
   */
  const clawbackCredits = db.transaction((input) => {
    const nowMs = now();
    if (q.ledgerByExternal.get('clawback', input.externalId)) {
      return { ok: true, duplicate: true, clawed: 0, shortfall: 0, suspended: false };
    }
    q.ensureBalance.run(input.userId, nowMs);
    const before = q.balanceRow.get(input.userId)?.balance ?? 0;
    const clawed = Math.min(before, input.credits);
    const shortfall = input.credits - clawed;
    // Suspend whenever they had already spent some of what is being taken back —
    // that is precisely the spend-then-chargeback shape.
    const suspended = shortfall > 0;
    q.clawback.run({
      userId: input.userId,
      amount: input.credits,
      suspendedAt: suspended ? nowMs : null,
      now: nowMs,
    });
    appendLedger({
      userId: input.userId,
      delta: -clawed,
      reason: 'clawback',
      externalId: input.externalId,
      extra: shortfall > 0 ? { shortfall } : null,
    });
    return { ok: true, clawed, shortfall, suspended };
  });

  /**
   * Operator grant / correction. Carries no external id, so it may repeat.
   * @param {{ userId: string, credits: number, reason?: string, note?: string }} input - The grant.
   * @returns {{ ok: boolean, balance: number }} The new balance.
   */
  const grantCredits = db.transaction((input) => {
    const nowMs = now();
    q.ensureBalance.run(input.userId, nowMs);
    q.credit.run({ userId: input.userId, amount: input.credits, purchased: 0, now: nowMs });
    const after = appendLedger({
      userId: input.userId,
      delta: input.credits,
      reason: input.reason || 'grant',
      externalId: null,
      extra: input.note ? { note: input.note } : null,
    });
    return { ok: true, balance: after };
  });

  /**
   * Recent ledger rows for the dashboard.
   * @param {string} userId - Account id.
   * @param {number} [limit] - Row ceiling.
   * @returns {any[]} Rows, newest first.
   */
  function listLedger(userId, limit = 50) {
    return q.ledgerForUser.all(userId, Math.max(1, Math.min(500, limit))).map((r) => ({
      id: r.id,
      delta: r.delta,
      reason: r.reason,
      externalId: r.external_id,
      balanceAfter: r.balance_after,
      createdAt: r.created_at,
    }));
  }

  /**
   * The ledger's own view of a balance — the invariant `balance === SUM(delta)`.
   * Exposed for the drift test rather than for request paths.
   * @param {string} userId - Account id.
   * @returns {number} Sum of every delta on file.
   */
  function ledgerSum(userId) {
    return q.ledgerSum.get(userId).n;
  }

  /**
   * One request row, for `GET /api/v1/renders/:id`.
   * @param {string} requestId - The request id.
   * @returns {any | null} The row, or null.
   */
  function getRequest(requestId) {
    return q.requestById.get(requestId) ?? null;
  }

  /**
   * What the account's API has actually been doing, for the dashboard.
   *
   * READS `api_requests`, NOT THE LEDGER, and the two answer different questions on
   * purpose. The ledger is money — it carries purchases and operator grants and knows
   * nothing about which key spent what. This is traffic: per key, per day, delivered
   * versus refunded. A dashboard that showed only the ledger could never answer "is my
   * staging key still running" or "did today's batch fail", which is the whole reason
   * the detail pane exists.
   *
   * Aggregated in SQL rather than by walking rows: a busy month is tens of thousands of
   * requests, and shipping them to Node to count would be the one query on this page
   * that scales with usage. The one thing SQLite will not do cheaply is a median, so
   * durations come back as a BOUNDED sample (`durationSample`) and are reduced here —
   * the cap is reported in the payload rather than silently truncating.
   *
   * Buckets are UTC days. Callers label them as such; a local-midnight bucketing would
   * need the browser's offset and would make this untestable against a fixed clock.
   * @param {string} userId - Account id.
   * @param {{ days?: number, sample?: number }} [opts] - Window length and duration-sample cap.
   * @returns {{ since: number, days: number, buckets: { day: number, delivered: number, refunded: number }[], keys: any[], totals: any, durationSample: number }} The summary.
   */
  function usageSummary(userId, opts = {}) {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const days = Math.max(1, Math.min(90, Number(opts.days) || 30));
    const sampleCap = Math.max(1, Math.min(5000, Number(opts.sample) || 2000));

    const nowMs = now();
    const since = Math.floor(nowMs / DAY_MS) * DAY_MS - (days - 1) * DAY_MS;
    const since7 = Math.floor(nowMs / DAY_MS) * DAY_MS - 6 * DAY_MS;

    const buckets = Array.from({ length: days }, (_, i) => ({
      day: since + i * DAY_MS,
      delivered: 0,
      refunded: 0,
    }));
    for (const row of q.usageByDay.all({ userId, since, dayMs: DAY_MS })) {
      const slot = buckets[row.bucket];
      if (!slot) continue;
      slot.delivered = row.delivered;
      slot.refunded = row.refunded;
    }

    // Durations, newest first and capped. Grouped here because the median is the
    // number a developer compares, and an average is the one a single 90-second
    // outlier moves.
    /** @type {Map<string, number[]>} */
    const byKey = new Map();
    const all = [];
    for (const row of q.usageDurations.all({ userId, since, limit: sampleCap })) {
      // Hold the array rather than has()/get() — Map.get is `T | undefined` to the
      // typechecker however sure the preceding has() made us, and this drops a second
      // lookup per row besides.
      let samples = byKey.get(row.key_id);
      if (!samples) {
        samples = [];
        byKey.set(row.key_id, samples);
      }
      samples.push(row.ms);
      all.push(row.ms);
    }

    const keys = q.usageByKey.all({ userId, since, since7 }).map((r) => ({
      keyId: r.key_id,
      delivered: r.delivered,
      refunded: r.refunded,
      inFlight: r.in_flight,
      creditsSpent: r.credits_spent,
      delivered7d: r.delivered7d,
      lastRequestAt: r.last_at,
      medianMs: median(byKey.get(r.key_id) || []),
    }));

    const totals = keys.reduce(
      (acc, k) => ({
        delivered: acc.delivered + k.delivered,
        refunded: acc.refunded + k.refunded,
        inFlight: acc.inFlight + k.inFlight,
        creditsSpent: acc.creditsSpent + k.creditsSpent,
        delivered7d: acc.delivered7d + k.delivered7d,
      }),
      { delivered: 0, refunded: 0, inFlight: 0, creditsSpent: 0, delivered7d: 0 },
    );

    return {
      since,
      days,
      buckets,
      keys,
      totals: { ...totals, medianMs: median(all) },
      durationSample: all.length,
    };
  }

  return {
    getBalance,
    claimAndDebit,
    refundRequest,
    markSucceeded,
    creditPurchase,
    clawbackCredits,
    grantCredits,
    listLedger,
    ledgerSum,
    getRequest,
    usageSummary,
  };
}

/**
 * Middle value of a sample, or null when there is nothing to take one of.
 *
 * Sorts a copy — the caller's array is the grouped sample and is read again for the
 * account-wide figure. Even-length samples take the lower of the two middles rather
 * than averaging them: these are milliseconds of real renders, and a value that
 * happened beats one that did not.
 * @param {number[]} values - The sample.
 * @returns {number | null} The median, or null.
 */
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}
