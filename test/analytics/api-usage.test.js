// Tier: data aggregation (real SQLite on a temp dir) — lib/analytics/api-usage.js.
//
// WHY THIS EXISTS. This is the second module in the repo that runs analytical SQL
// against the production database on an operator's click, and it carries the same
// two risks lib/analytics/admin-metrics.js does — plus one of its own.
//
//   1. **It could be an N+1.** Every statement here is a GROUP BY or an aggregate,
//      and the statement count must be FIXED. The last test counts `prepare` calls
//      across two datasets of very different size, exactly as the metrics suite does.
//   2. **It reports numbers nothing else can corroborate.** Nothing else in the repo
//      sums prepaid credit balances or medians an API render, so a wrong aggregate is
//      wrong silently.
//   3. **Absence must not read as zero.** A median with no sample is `null`, never 0,
//      and an account that never called is missing rather than present with zeros. A
//      dashboard renders those two states identically, and they mean opposite things.
//
// The schema comes from the REAL store factories against a temp data dir, never from
// inline DDL: they share one connection per base dir (lib/data/db.js#getDb), so a
// schema change cannot leave this suite testing a shape production does not have.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getDb, closeDb } from '../../lib/data/db.js';
import { createAuthStore } from '../../lib/data/auth-store.js';
import { createApiKeys } from '../../lib/data/api-keys.js';
import { createApiBilling } from '../../lib/data/api-billing.js';
import { createApiUsageStats } from '../../lib/analytics/api-usage.js';

const DAY = 24 * 60 * 60 * 1000;

// A fixed instant, mid-UTC-day. Mid-day on purpose: a clock at exactly midnight
// would make an off-by-one in the bucket floor invisible.
const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);

/** A temp base dir carrying every table this module reads, plus its open handle. */
function makeDb() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-api-usage-'));
  createAuthStore(base);   // users
  createApiKeys(base);     // api_keys
  createApiBilling(base);  // api_requests, api_credit_balances, api_credit_ledger
  return {
    base,
    db: getDb(base),
    close: () => { try { closeDb(base); } catch { /* already closed */ } },
  };
}

let seq = 0;

/** One request row, written directly so the fixture can set states the API guards. */
function addRequest(db, row) {
  const id = row.id || `req${++seq}`;
  db.prepare(`
    INSERT INTO api_requests
      (id, key_id, user_id, idempotency_key, fingerprint, status, credits_charged, attempts, claimed_at, completed_at)
    VALUES (@id, @keyId, @userId, @idem, @fingerprint, @status, @credits, 1, @claimedAt, @completedAt)
  `).run({
    id,
    keyId: 'k1',
    idem: 'idem-' + id,
    fingerprint: 'fp-' + id,
    status: 'succeeded',
    credits: 1,
    completedAt: null,
    ...row,
  });
}

function addUser(db, id, email, plan = 'free') {
  db.prepare('INSERT INTO users (id, email, plan, created_at) VALUES (?, ?, ?, ?)')
    .run(id, email, plan, new Date(NOW).toISOString());
}

function addBalance(db, row) {
  db.prepare(`
    INSERT INTO api_credit_balances (user_id, balance, lifetime_purchased, lifetime_spent, suspended_at, updated_at)
    VALUES (@userId, @balance, @purchased, @spent, @suspendedAt, @now)
  `).run({ balance: 0, purchased: 0, spent: 0, suspendedAt: null, now: NOW, ...row });
}

function addLedger(db, row) {
  db.prepare(`
    INSERT INTO api_credit_ledger (id, user_id, delta, reason, external_id, balance_after, created_at)
    VALUES (@id, @userId, @delta, @reason, @externalId, @balanceAfter, @createdAt)
  `).run({ externalId: null, balanceAfter: 0, ...row });
}

// ── Traffic ─────────────────────────────────────────────────────────────────

test('daily buckets are UTC days, pre-seeded, and split delivered from refunded', async (t) => {
  const h = makeDb();
  t.after(h.close);
  addUser(h.db, 'u1', 'a@example.com', 'pro');

  addRequest(h.db, { userId: 'u1', claimedAt: NOW, status: 'succeeded' });
  addRequest(h.db, { userId: 'u1', claimedAt: NOW, status: 'succeeded' });
  addRequest(h.db, { userId: 'u1', claimedAt: NOW - 1 * DAY, status: 'refunded' });

  const out = createApiUsageStats({ db: h.db }).summary({ days: 7, now: NOW });

  // Seven buckets whatever the traffic: a quiet day must be a zero column, not a
  // gap the chart closes over.
  assert.equal(out.buckets.length, 7);
  assert.equal(out.days, 7);

  const today = out.buckets[out.buckets.length - 1];
  const yesterday = out.buckets[out.buckets.length - 2];
  assert.equal(today.delivered, 2);
  assert.equal(today.refunded, 0);
  assert.equal(yesterday.delivered, 0);
  assert.equal(yesterday.refunded, 1);

  // Every bucket start is a UTC midnight, and they ascend one day at a time.
  for (const b of out.buckets) assert.equal(b.day % DAY, 0);
  for (let i = 1; i < out.buckets.length; i++) {
    assert.equal(out.buckets[i].day - out.buckets[i - 1].day, DAY);
  }

  // A refund is not a delivery. This is the assertion that fails if the two
  // CASE arms are ever collapsed into a single COUNT(*).
  assert.equal(out.traffic.delivered, 2);
  assert.equal(out.traffic.refunded, 1);
});

test('a request older than the window is excluded from every figure', async (t) => {
  const h = makeDb();
  t.after(h.close);
  addUser(h.db, 'u1', 'a@example.com');

  addRequest(h.db, { userId: 'u1', claimedAt: NOW - 40 * DAY, status: 'succeeded' });
  const out = createApiUsageStats({ db: h.db }).summary({ days: 7, now: NOW });

  assert.equal(out.traffic.delivered, 0);
  // And the account it belonged to is ABSENT, not present with zeros — a row of
  // zeros would read as "this customer stopped working", not "out of window".
  assert.deepEqual(out.accounts, []);
  assert.equal(out.accountsTotal, 0);
});

test('a charged-but-unsettled request counts as in flight, not as delivered', async (t) => {
  const h = makeDb();
  t.after(h.close);
  addUser(h.db, 'u1', 'a@example.com');

  addRequest(h.db, { userId: 'u1', claimedAt: NOW, status: 'charged', completedAt: null });
  const out = createApiUsageStats({ db: h.db }).summary({ days: 7, now: NOW });

  assert.equal(out.traffic.delivered, 0);
  assert.equal(out.traffic.refunded, 0);
  assert.equal(out.traffic.inFlight, 1);
  // It has not settled, so it has burned nothing: credits_charged is a claim, and
  // only a succeeded row is spend.
  assert.equal(out.traffic.creditsBurned, 0);
});

// ── The honesty rule ────────────────────────────────────────────────────────

test('an empty window reports null, not zero, for the median', async (t) => {
  const h = makeDb();
  t.after(h.close);

  const out = createApiUsageStats({ db: h.db }).summary({ days: 30, now: NOW });

  // The whole point. `0` would claim every render completed instantly.
  assert.equal(out.traffic.medianMs, null);
  assert.equal(out.traffic.durationSample, 0);
  assert.equal(out.traffic.delivered, 0);
  assert.deepEqual(out.accounts, []);
  assert.equal(out.buckets.length, 30);
  assert.ok(out.buckets.every((b) => b.delivered === 0 && b.refunded === 0));
});

test('the median comes from completed renders only, and takes the lower middle', async (t) => {
  const h = makeDb();
  t.after(h.close);
  addUser(h.db, 'u1', 'a@example.com');

  addRequest(h.db, { userId: 'u1', claimedAt: NOW, completedAt: NOW + 4000 });
  addRequest(h.db, { userId: 'u1', claimedAt: NOW, completedAt: NOW + 6000 });
  addRequest(h.db, { userId: 'u1', claimedAt: NOW, completedAt: NOW + 9000 });
  // Never settled, and a refunded one that did: neither may enter the sample.
  addRequest(h.db, { userId: 'u1', claimedAt: NOW, status: 'charged', completedAt: null });
  addRequest(h.db, { userId: 'u1', claimedAt: NOW, status: 'refunded', completedAt: NOW + 90000 });

  const out = createApiUsageStats({ db: h.db }).summary({ days: 7, now: NOW });

  assert.equal(out.traffic.durationSample, 3);
  assert.equal(out.traffic.medianMs, 6000);
});

// ── Accounts ────────────────────────────────────────────────────────────────

test('accounts are grouped, joined to their email, and ranked by volume', async (t) => {
  const h = makeDb();
  t.after(h.close);
  addUser(h.db, 'quiet', 'quiet@example.com', 'free');
  addUser(h.db, 'busy', 'busy@example.com', 'pro');

  for (let i = 0; i < 5; i++) addRequest(h.db, { userId: 'busy', keyId: 'kb', claimedAt: NOW });
  addRequest(h.db, { userId: 'busy', keyId: 'kb2', claimedAt: NOW - 1 * DAY, status: 'refunded' });
  addRequest(h.db, { userId: 'quiet', keyId: 'kq', claimedAt: NOW });

  const out = createApiUsageStats({ db: h.db }).summary({ days: 30, now: NOW });

  assert.equal(out.accounts.length, 2);
  assert.equal(out.accountsTotal, 2);

  const [first, second] = out.accounts;
  assert.equal(first.userId, 'busy');
  assert.equal(first.email, 'busy@example.com');
  assert.equal(first.plan, 'pro');
  assert.equal(first.delivered, 5);
  assert.equal(first.refunded, 1);
  assert.equal(first.creditsSpent, 5);
  // Two distinct keys touched this account's traffic.
  assert.equal(first.keysUsed, 2);
  assert.equal(first.lastRequestAt, NOW);
  assert.equal(second.userId, 'quiet');
});

test('a request whose account is gone still counts, with an empty email', async (t) => {
  const h = makeDb();
  t.after(h.close);
  // No users row for 'ghost' — the LEFT JOIN must not drop the traffic.
  addRequest(h.db, { userId: 'ghost', claimedAt: NOW });

  const out = createApiUsageStats({ db: h.db }).summary({ days: 7, now: NOW });

  assert.equal(out.traffic.delivered, 1);
  assert.equal(out.accounts.length, 1);
  assert.equal(out.accounts[0].userId, 'ghost');
  // Empty, not invented: the panel is what decides to print "(deleted account)".
  assert.equal(out.accounts[0].email, '');
  assert.equal(out.accounts[0].plan, '');
});

test('7-day figures are a window inside the window', async (t) => {
  const h = makeDb();
  t.after(h.close);
  addUser(h.db, 'u1', 'a@example.com');

  addRequest(h.db, { userId: 'u1', claimedAt: NOW });
  addRequest(h.db, { userId: 'u1', claimedAt: NOW - 20 * DAY });

  const out = createApiUsageStats({ db: h.db }).summary({ days: 30, now: NOW });

  assert.equal(out.accounts[0].delivered, 2);
  assert.equal(out.accounts[0].delivered7d, 1);
});

test('totals come from the request table, not from summing the capped account list', async (t) => {
  const h = makeDb();
  t.after(h.close);
  // 60 accounts, one request each. The account list caps at 50; the platform
  // total must still say 60, or the headline under-reports the moment the API
  // has more than fifty customers.
  for (let i = 0; i < 60; i++) {
    addUser(h.db, `u${i}`, `u${i}@example.com`);
    addRequest(h.db, { userId: `u${i}`, claimedAt: NOW });
  }

  const out = createApiUsageStats({ db: h.db }).summary({ days: 7, now: NOW });

  assert.equal(out.traffic.delivered, 60);
  assert.equal(out.accounts.length, 50);
  assert.equal(out.accountsShown, 50);
  assert.equal(out.accountsTotal, 60);
});

// ── Economics ───────────────────────────────────────────────────────────────

test('credits sold are never conflated with credits granted', async (t) => {
  const h = makeDb();
  t.after(h.close);
  addUser(h.db, 'u1', 'a@example.com');

  addBalance(h.db, { userId: 'u1', balance: 40, purchased: 100, spent: 60 });
  addBalance(h.db, { userId: 'u2', balance: 0, purchased: 10, spent: 10, suspendedAt: NOW });

  addLedger(h.db, { id: 'l1', userId: 'u1', delta: 100, reason: 'purchase', externalId: 'cs_1', createdAt: NOW - 2 * DAY });
  addLedger(h.db, { id: 'l2', userId: 'u1', delta: 25, reason: 'grant', createdAt: NOW - 2 * DAY });
  addLedger(h.db, { id: 'l3', userId: 'u1', delta: -1, reason: 'debit', externalId: 'req_1', createdAt: NOW });
  // Outside the window: it must move the lifetime figures but not the in-window ones.
  addLedger(h.db, { id: 'l4', userId: 'u1', delta: 500, reason: 'purchase', externalId: 'cs_old', createdAt: NOW - 60 * DAY });

  const out = createApiUsageStats({ db: h.db }).summary({ days: 30, now: NOW });
  const e = out.economics;

  assert.equal(e.purchasedInWindow, 100);
  assert.equal(e.grantedInWindow, 25);
  assert.equal(e.outstanding, 40);
  assert.equal(e.lifetimePurchased, 110);
  assert.equal(e.lifetimeSpent, 70);
  assert.equal(e.fundedAccounts, 2);
  assert.equal(e.suspended, 1);
});

test('key counts separate live from revoked', async (t) => {
  const h = makeDb();
  t.after(h.close);
  const ins = h.db.prepare(`
    INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, created_at, revoked_at)
    VALUES (?, ?, '', ?, 'stg_live_x', ?, ?)
  `);
  ins.run('k1', 'u1', 'h1', NOW, null);
  ins.run('k2', 'u1', 'h2', NOW, NOW);
  ins.run('k3', 'u2', 'h3', NOW, null);

  const out = createApiUsageStats({ db: h.db }).summary({ days: 7, now: NOW });

  assert.equal(out.keys.total, 3);
  assert.equal(out.keys.active, 2);
  assert.equal(out.keys.accounts, 2);
});

// ── Window clamping ─────────────────────────────────────────────────────────

test('the window is clamped, never rejected', async (t) => {
  const h = makeDb();
  t.after(h.close);
  const stats = createApiUsageStats({ db: h.db });

  assert.equal(stats.summary({ days: 5000, now: NOW }).days, 90);
  assert.equal(stats.summary({ days: -3, now: NOW }).days, 1);
  assert.equal(stats.summary({ days: 0, now: NOW }).days, 1);
  // Absent or unparseable falls to the default rather than to NaN buckets.
  assert.equal(stats.summary({ now: NOW }).days, 30);
  assert.equal(stats.summary({ days: 'lots', now: NOW }).days, 30);
});

// ── The N+1 guard ───────────────────────────────────────────────────────────

test('the statement count is FIXED — it does not grow with the data', async (t) => {
  // The guard that makes this endpoint safe to point at production. Every
  // behavioural assertion above passes just as happily against a per-account
  // lookup, so this counts `prepare` calls directly, across two datasets three
  // orders of magnitude apart in size.
  //
  // Counted at FACTORY time (where they all belong) and at SUMMARY time (which
  // must be zero — a statement built inside summary() is one built per request,
  // and the next step from there is one per row).
  function countPrepares(rows) {
    const h = makeDb();
    t.after(h.close);
    const insert = h.db.prepare(`
      INSERT INTO api_requests
        (id, key_id, user_id, idempotency_key, fingerprint, status, credits_charged, attempts, claimed_at, completed_at)
      VALUES (?, 'k1', ?, ?, 'fp', 'succeeded', 1, 1, ?, ?)
    `);
    const many = h.db.transaction(() => {
      for (let i = 0; i < rows; i++) {
        insert.run(`r${i}`, `u${i % 50}`, `idem${i}`, NOW - (i % 5) * DAY, NOW - (i % 5) * DAY + 1000);
      }
    });
    many();

    let atFactory = 0;
    let atSummary = 0;
    let phase = 'factory';
    const spy = {
      prepare(sql) {
        if (phase === 'factory') atFactory += 1; else atSummary += 1;
        return h.db.prepare(sql);
      },
    };
    const stats = createApiUsageStats({ db: spy });
    phase = 'summary';
    const out = stats.summary({ days: 30, now: NOW });
    // Twice: a lazily-memoized statement would show on the first call and hide on
    // the second, which is still one prepare per process, not per row.
    stats.summary({ days: 30, now: NOW });
    return { atFactory, atSummary, delivered: out.traffic.delivered };
  }

  const small = countPrepares(10);
  const large = countPrepares(5000);

  assert.equal(small.delivered, 10);
  assert.equal(large.delivered, 5000);
  assert.equal(
    small.atFactory,
    large.atFactory,
    `prepare count moved with the data: ${small.atFactory} vs ${large.atFactory} — this is an N+1`,
  );
  assert.equal(small.atSummary, 0, 'summary() must not prepare anything; statements belong to the factory');
  assert.equal(large.atSummary, 0);
  assert.ok(small.atFactory > 0 && small.atFactory < 40, `expected a handful of statements, got ${small.atFactory}`);
});
