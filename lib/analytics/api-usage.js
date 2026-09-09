// Site-wide reads of the public render API — the operator's half of what every
// customer already sees on /api-keys.html.
//
// WHY THIS EXISTS. `apiBilling.usageSummary(userId)` answers "how is MY integration
// doing" and is anchored on a user id in every one of its queries. There was no way
// to ask the same question about the platform: how much traffic the API carries, who
// carries it, and whether the prepaid credits are being sold or given away. The rows
// have been on disk since the API shipped; nothing operator-facing read them.
//
// WHY IT IS NOT A FLAG ON usageSummary. That function's three statements are all
// served by idx_api_requests_user (user_id, claimed_at), and its whole shape — per
// KEY, one account — is the customer's mental model. Dropping the user predicate
// would change which index the planner picks and which grouping is meaningful, so
// this is a sibling with its own statements rather than a parameterised fork.
//
// THE STATEMENTS ARE PREPARED ONCE, at construction, exactly as lib/analytics/
// admin-metrics.js does — test/analytics/api-usage.test.js counts prepare() calls and
// fails on a statement built per request.
//
// SILENCE MUST BE HONEST. An account that never called does not appear; a median with
// no sample is null, not 0. See the same-named section of docs/guides/admin-dashboard.md:
// a zero and an absence read identically on a dashboard and mean opposite things.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Widest window the console may ask for. Matches api-billing.js#usageSummary. */
const MAX_DAYS = 90;
const DEFAULT_DAYS = 30;

/** Ceiling on the duration sample. Bounded for the reason usageSummary bounds its own. */
const SAMPLE_CAP = 2000;

/** Accounts returned in the ranked table. Beyond this the table stops being readable. */
const TOP_ACCOUNTS = 50;

/**
 * Middle value of a sample, or null when there is nothing to take one of.
 *
 * Deliberately a copy of the reducer in lib/data/api-billing.js rather than an import:
 * that one is a module-private helper of the billing store, and exporting it to share
 * eight lines would make a data-integrity module part of the analytics surface. Both
 * take the LOWER of two middles for the same reason — these are milliseconds of real
 * renders, and a value that happened beats one that did not.
 * @param {number[]} values - The sample.
 * @returns {number | null} The median, or null when the sample is empty.
 */
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/**
 * Build the site-wide API-usage reader over the shared app database.
 *
 * @param {{ db: any }} deps - The shared better-sqlite3 connection (lib/data/db.js#getDb).
 * @returns {{ summary: (opts?: { days?: number, now?: number }) => object }} The reader.
 */
export function createApiUsageStats({ db }) {
  // ── Traffic ───────────────────────────────────────────────────────────────
  //
  // Bucketed in SQL, not by walking rows: a busy month is tens of thousands of
  // requests and shipping them to Node to count would be the one query on this page
  // that scales with usage.
  const qByDay = db.prepare(`
    SELECT CAST((claimed_at - @since) / @dayMs AS INTEGER)          AS bucket,
           SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END)    AS delivered,
           SUM(CASE WHEN status = 'refunded'  THEN 1 ELSE 0 END)    AS refunded
      FROM api_requests
     WHERE claimed_at >= @since
     GROUP BY bucket
  `);

  // LEFT JOIN, not JOIN: a deleted account's request rows are removed by
  // lib/data/user-deletion.js, but a row that outlives its user for any other reason
  // must still be counted as traffic rather than silently vanishing from the totals.
  const qByAccount = db.prepare(`
    SELECT r.user_id                                                  AS userId,
           u.email                                                    AS email,
           u.plan                                                     AS plan,
           SUM(CASE WHEN r.status = 'succeeded' THEN 1 ELSE 0 END)     AS delivered,
           SUM(CASE WHEN r.status = 'refunded'  THEN 1 ELSE 0 END)     AS refunded,
           SUM(CASE WHEN r.status = 'charged'   THEN 1 ELSE 0 END)     AS inFlight,
           SUM(CASE WHEN r.status = 'succeeded'
                    THEN r.credits_charged ELSE 0 END)                 AS creditsSpent,
           SUM(CASE WHEN r.status = 'succeeded'
                     AND r.claimed_at >= @since7 THEN 1 ELSE 0 END)    AS delivered7d,
           COUNT(DISTINCT r.key_id)                                    AS keysUsed,
           MAX(r.claimed_at)                                           AS lastRequestAt
      FROM api_requests r
      LEFT JOIN users u ON u.id = r.user_id
     WHERE r.claimed_at >= @since
     GROUP BY r.user_id
     ORDER BY delivered DESC, creditsSpent DESC
     LIMIT @limit
  `);

  // How many accounts the table above may be hiding. Reported so a truncated list
  // says so rather than quietly presenting the top 50 as the whole population.
  const qAccountCount = db.prepare(`
    SELECT COUNT(DISTINCT user_id) AS total
      FROM api_requests
     WHERE claimed_at >= @since
  `);

  // Newest first and LIMITed. SQLite will not compute a median cheaply, so the sample
  // is bounded here and reduced in JS, and its size is reported in the payload rather
  // than the truncation being silent.
  const qDurations = db.prepare(`
    SELECT (completed_at - claimed_at) AS ms
      FROM api_requests
     WHERE claimed_at >= @since
       AND status = 'succeeded'
       AND completed_at IS NOT NULL
       AND completed_at >= claimed_at
     ORDER BY claimed_at DESC
     LIMIT @limit
  `);

  // ── Money ─────────────────────────────────────────────────────────────────
  //
  // `outstanding` is the sum of unspent balances: credits customers have paid for and
  // not yet burned. It is a LIABILITY, not revenue — the renders behind it still have
  // to be delivered — which is why it is reported apart from lifetime purchases.
  const qBalances = db.prepare(`
    SELECT COALESCE(SUM(balance), 0)             AS outstanding,
           COALESCE(SUM(lifetime_purchased), 0)  AS lifetimePurchased,
           COALESCE(SUM(lifetime_spent), 0)      AS lifetimeSpent,
           COUNT(*)                              AS accounts,
           SUM(CASE WHEN suspended_at IS NOT NULL THEN 1 ELSE 0 END) AS suspended
      FROM api_credit_balances
  `);

  // Split by reason so credits SOLD are never conflated with credits GRANTED. Both
  // add balance and both let someone render; only one of them was paid for.
  const qLedgerWindow = db.prepare(`
    SELECT reason, COALESCE(SUM(delta), 0) AS delta, COUNT(*) AS rows
      FROM api_credit_ledger
     WHERE created_at >= @since
     GROUP BY reason
  `);

  // ── Keys ──────────────────────────────────────────────────────────────────
  const qKeys = db.prepare(`
    SELECT COUNT(*)                                              AS total,
           SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END)    AS active,
           COUNT(DISTINCT user_id)                                AS accounts
      FROM api_keys
  `);

  /**
   * One read of everything above.
   *
   * Buckets are UTC days, like the customer-facing summary they sit beside — a
   * local-midnight bucketing would need the browser's offset and would make this
   * untestable against a fixed clock. Callers label them as UTC.
   *
   * @param {{ days?: number, now?: number }} [opts] - Window length; `now` is injectable for tests.
   * @returns {object} The pack served by GET /api/admin/api-usage.
   */
  function summary(opts = {}) {
    const now = typeof opts.now === 'number' ? opts.now : Date.now();
    const requested = Number(opts.days);
    const days = Math.max(1, Math.min(MAX_DAYS, Number.isFinite(requested) ? Math.round(requested) : DEFAULT_DAYS));

    const today = Math.floor(now / DAY_MS) * DAY_MS;
    const since = today - (days - 1) * DAY_MS;
    const since7 = today - 6 * DAY_MS;

    // Pre-seeded so a quiet day is a zero column rather than a gap the chart closes
    // over — a missing bucket would make two weeks of silence look like one busy day
    // next to another.
    const buckets = Array.from({ length: days }, (_, i) => ({
      day: since + i * DAY_MS,
      delivered: 0,
      refunded: 0,
    }));
    for (const row of qByDay.all({ since, dayMs: DAY_MS })) {
      const slot = buckets[row.bucket];
      if (!slot) continue;
      slot.delivered = Number(row.delivered) || 0;
      slot.refunded = Number(row.refunded) || 0;
    }

    const accounts = qByAccount.all({ since, since7, limit: TOP_ACCOUNTS }).map((r) => ({
      userId: String(r.userId || ''),
      // A row whose account is gone gets no invented placeholder: the panel renders
      // the empty string as "(deleted account)" and the id stays available beside it.
      email: r.email ?? '',
      plan: r.plan ?? '',
      delivered: Number(r.delivered) || 0,
      refunded: Number(r.refunded) || 0,
      inFlight: Number(r.inFlight) || 0,
      creditsSpent: Number(r.creditsSpent) || 0,
      delivered7d: Number(r.delivered7d) || 0,
      keysUsed: Number(r.keysUsed) || 0,
      lastRequestAt: r.lastRequestAt ?? null,
    }));

    const durations = qDurations.all({ since, limit: SAMPLE_CAP }).map((r) => Number(r.ms) || 0);

    // Totals come from the request table, NOT from summing `accounts` — that array is
    // capped at TOP_ACCOUNTS, so summing it would under-report the platform total the
    // moment there are 51 API customers.
    const totals = buckets.reduce(
      (acc, b) => ({ delivered: acc.delivered + b.delivered, refunded: acc.refunded + b.refunded }),
      { delivered: 0, refunded: 0 },
    );
    const inFlight = accounts.reduce((s, a) => s + a.inFlight, 0);
    const creditsBurned = accounts.reduce((s, a) => s + a.creditsSpent, 0);

    const ledger = { purchase: 0, grant: 0, debit: 0, refund: 0, clawback: 0 };
    for (const row of qLedgerWindow.all({ since })) {
      const reason = String(row.reason || '');
      if (reason in ledger) ledger[reason] = Number(row.delta) || 0;
    }

    const bal = qBalances.get() || {};
    const keys = qKeys.get() || {};

    return {
      generatedAt: now,
      since,
      days,
      buckets,
      traffic: {
        delivered: totals.delivered,
        refunded: totals.refunded,
        // Requests that were charged and have neither settled nor been reclaimed.
        // Scoped to the same window as everything else, so it is "started in this
        // window and still open", not a live gauge.
        inFlight,
        creditsBurned,
        medianMs: median(durations),
        durationSample: durations.length,
      },
      accounts,
      accountsTotal: Number((qAccountCount.get({ since }) || {}).total) || 0,
      accountsShown: accounts.length,
      economics: {
        outstanding: Number(bal.outstanding) || 0,
        lifetimePurchased: Number(bal.lifetimePurchased) || 0,
        lifetimeSpent: Number(bal.lifetimeSpent) || 0,
        fundedAccounts: Number(bal.accounts) || 0,
        suspended: Number(bal.suspended) || 0,
        // In-window movement. `purchase` and `grant` are positive deltas; `debit` and
        // `clawback` are negative, and are passed through with their sign intact so a
        // reader is never left guessing which direction a number points.
        purchasedInWindow: ledger.purchase,
        grantedInWindow: ledger.grant,
      },
      keys: {
        total: Number(keys.total) || 0,
        active: Number(keys.active) || 0,
        accounts: Number(keys.accounts) || 0,
      },
    };
  }

  return { summary };
}
